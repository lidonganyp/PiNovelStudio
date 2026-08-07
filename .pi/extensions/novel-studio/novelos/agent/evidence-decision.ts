/**
 * NovelOS Evidence Decision（缺口三：让模型参与 EvidencePlan）
 *
 * Phase 2D（2026-08-07）三缺口修复的第三项。
 *
 * 目标：从"系统生成 EvidencePlan → 系统过滤工具 → 模型在剩余工具中决定是否调用"
 * 升级为：
 *   系统提供安全事实和摘要（已知/必须验证）
 *   → 模型判断未知点、工具选择与检索深度（独立结构化回合）
 *   → 系统校验模型计划（selectedTools ∩ systemAllowedTools、mustVerify 不可删、事实真值不可改）
 *   → 创建受限工具集（用校验后的 plan.allowedTools 过滤）
 *
 * 本模块只负责：类型、决策 prompt、模型输出解析、系统校验、计划合并、以及
 * decision-round 编排（调用 modelGenerate + fail-safe 回退）。纯逻辑函数全部
 * 确定性、无副作用，可脱离模型单测；只有 runEvidenceDecisionRound 会发起一次
 * 模型调用。
 *
 * 安全边界（本模块强制）：
 * - selectedTools ∩ systemAllowedTools → 模型只能收窄工具集，不能扩展；
 * - 若存在 mustVerify 且模型把工具集缩到空，系统回退到 systemAllowedTools，
 *   确保 P0/P1 事实仍可被检索覆盖（"mustVerify 不得被模型删除"）；
 * - mustVerify / known 在合并计划中保持不可变（模型不能修改事实真值）；
 * - unknown 有上限（防无界遍历）；retrievalDepth 被 clamp 到 [0, 3]。
 */

import type { ModelGenerateFn } from "../../v2/adapters/legacy-model-route-adapter.js";
import type { EvidencePlan } from "./evidence-plan.js";
import { RETRIEVAL_TOOL_NAMES } from "../tools/narrative-tools.js";

// ============================================================================
// 常量（防无界遍历 / 预算边界）
// ============================================================================

/** 模型可声明的未知点上限 */
export const MAX_MODEL_UNKNOWN = 8;
/** 模型可建议的检索 query 上限 */
export const MAX_MODEL_QUERIES = 6;
/** retrievalDepth 允许的最大值（0=不检索，1=浅，2=中，3=深） */
export const MAX_RETRIEVAL_DEPTH = 3;
/**
 * 当系统强制 needRetrieval=true（mustVerify 非空时）但模型请求 depth=0 的最小深度。
 * 消除"needRetrieval=true 但 retrievalDepth=0"的自相矛盾：既然系统判定必须检索，
 * 深度至少为 1（retrievalBudget ≥ 2），否则检索工具会在 beforeToolCall 被预算=0 阻断，
 * 使 mustVerify 事实无法被检索覆盖。
 */
export const MIN_RETRIEVAL_DEPTH_WHEN_REQUIRED = 1;
/** 决策回合模型输出 token 上限（结构化短输出，无需大预算） */
export const EVIDENCE_DECISION_MAX_TOKENS = 512;
/** 决策回合 kind 标签（用于模型调用 trace 区分） */
export const EVIDENCE_DECISION_KIND = "novelos_evidence_decision";

/**
 * 检索深度 → 检索工具调用次数上限（Phase 2D 缺口三执行）。
 *
 * 让模型判定的 retrievalDepth 真正进入"工具调用次数"这一系统约束：
 * depth 0 → 0 次（不检索），1 → 2 次，2 → 4 次，3 → 6 次（深度检索）。
 * 该上限由 runtime 的 afterToolCall 停止逻辑强制，非仅 prompt 建议。
 */
export const RETRIEVAL_CALLS_BY_DEPTH: Readonly<number[]> = [0, 2, 4, 6];

/** 由检索深度推导检索工具调用次数上限（clamp 到 [0, MAX_RETRIEVAL_DEPTH]） */
export function retrievalCallBudgetForDepth(depth: number): number {
  const d = Math.max(0, Math.min(MAX_RETRIEVAL_DEPTH, Math.floor(depth)));
  return RETRIEVAL_CALLS_BY_DEPTH[d] ?? 0;
}

// ============================================================================
// 类型
// ============================================================================

/** 模型输出的原始结构化决策请求（来自独立决策回合） */
export interface EvidenceDecisionRequest {
  /** 是否需要对未知点做检索 */
  needRetrieval: boolean;
  /** 模型判定为未知、可能需要查证的事实点 */
  unknown: string[];
  /** 模型选择的工具名（将受 systemAllowedTools 约束） */
  selectedTools: string[];
  /** 模型建议的检索 query */
  queries: string[];
  /** 检索深度（0..3） */
  retrievalDepth: number;
}

/** 系统对模型请求的校验结果（安全边界） */
export interface EvidenceDecisionValidation {
  /** 最终允许的工具 = selectedTools ∩ systemAllowedTools（或 mustVerify 时的系统兜底） */
  allowedTools: string[];
  /** 模型请求但被系统拒绝的工具（不在 systemAllowedTools 内） */
  rejectedTools: string[];
  /** 系统接受的未知点（上限内） */
  acceptedUnknown: string[];
  /** 因超出上限被丢弃的未知点 */
  droppedUnknown: string[];
  /** 受保护的 mustVerify 项（系统强制保留，模型不得删除） */
  protectedMustVerify: string[];
  /** 模型判定的检索必要性（来自 request，随验证透传） */
  needRetrieval: boolean;
  /** 系统接受的检索 query（clamp 到 MAX_MODEL_QUERIES） */
  queries: string[];
  /** 系统接受的检索深度（clamp 到 [0, MAX_RETRIEVAL_DEPTH]） */
  retrievalDepth: number;
}

/** 一次完成的决策（模型请求 + 系统校验 + 来源标记） */
export interface EvidenceDecision {
  request: EvidenceDecisionRequest;
  validation: EvidenceDecisionValidation;
  /** model=模型输出被解析并应用；fallback=决策回合失败/不可解析，回退系统计划 */
  source: "model" | "fallback";
  /** 模型原始输出（用于 trace 审计） */
  rawText?: string;
  /** source=fallback 时的失败原因（审计用） */
  error?: string;
}

/** decision round 编排输入 */
export interface EvidenceDecisionRoundInput {
  /** 系统生成的 EvidencePlan（decision round 的输入安全事实） */
  evidencePlan: EvidencePlan;
  /** 本章意图摘要 */
  chapterIntent: string;
  /** 种子上下文 */
  seedContext: string;
  /** 项目模型调用函数（生产路径为编排器 wrapModelFn，调用会计入章节预算） */
  modelGenerate: ModelGenerateFn;
  /** 模型路由名（复用写手路由，与正文同模型族） */
  route: string;
  /** 超时 ms */
  timeoutMs?: number;
}

/** decision round 结果：决策 + 合并后的最终计划 */
export interface EvidenceDecisionRoundResult {
  decision: EvidenceDecision;
  plan: EvidencePlan;
}

/** 默认决策请求（fallback / 不可解析时使用；不检索、不选择额外工具） */
export const DEFAULT_DECISION_REQUEST: EvidenceDecisionRequest = {
  needRetrieval: false,
  unknown: [],
  selectedTools: [],
  queries: [],
  retrievalDepth: 0,
};

// ============================================================================
// 决策 prompt 构造
// ============================================================================

export interface EvidenceDecisionPromptInput {
  chapterIntent: string;
  seedContext: string;
  known: string[];
  mustVerify: string[];
  systemAllowedTools: string[];
}

/**
 * 构造决策回合的 user prompt。
 *
 * 只提供系统安全事实与摘要（不暴露思维链），要求模型输出结构化 JSON：
 * - 基于已给事实判断未知点、需要的工具、检索 query 与深度；
 * - 不要求模型生成正文、不要求模型修改已知事实；
 * - selectedTools 必须从 systemAllowedTools 中选择（系统后续会交集校验）。
 */
export function buildEvidenceDecisionPrompt(input: EvidenceDecisionPromptInput): string {
  const parts: string[] = [];
  parts.push(
    "你是本章的证据检索规划者。请基于给定的本章意图、种子上下文、已知事实与必须验证点，",
    "输出一份检索决策（JSON）。不要生成正文，不要修改已知事实真值。",
    "",
  );
  parts.push("【本章意图】", input.chapterIntent, "");
  parts.push("【种子上下文】", input.seedContext, "");
  if (input.known.length > 0) {
    parts.push(
      "【已知事实（已确认，不可修改，无需重复检索）】",
      ...input.known.map((item) => `- ${item}`),
      "",
    );
  }
  if (input.mustVerify.length > 0) {
    parts.push(
      "【必须验证点（系统强制保留，不得删除，若正文涉及请纳入检索）】",
      ...input.mustVerify.map((item) => `- ${item}`),
      "",
    );
  }
  parts.push(
    "【可选工具（只能从中选择，不能使用列表外的工具）】",
    input.systemAllowedTools.map((t) => `- ${t}`).join("\n"),
    "",
    "请输出严格 JSON：",
    JSON.stringify(
      {
        needRetrieval: "boolean：是否有需要检索的未知点",
        unknown: "string[]：你判定为未知、可能改变事实/人物状态/因果关系的点（最多8条）",
        selectedTools: "string[]：从可选工具中选择你计划使用的工具（可为空数组）",
        queries: "string[]：建议的检索 query（最多6条）",
        retrievalDepth: "number：0-3，0=不检索，3=深度检索",
      },
      null,
      2,
    ),
  );
  return parts.join("\n");
}

// ============================================================================
// 模型输出解析（fail-safe，永不抛错）
// ============================================================================

/**
 * 解析模型输出的结构化决策。
 *
 * 优先尝试提取 JSON 对象并逐字段强制类型；任何缺失/非法字段回退默认。
 * 不可解析（非 JSON）时返回 DEFAULT_DECISION_REQUEST（不抛错）。
 */
export function parseEvidenceDecision(text: string): EvidenceDecisionRequest {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return { ...DEFAULT_DECISION_REQUEST };

  let obj: Record<string, unknown>;
  try {
    // 提取最外层 JSON 对象（容忍模型输出前后附带说明文本）
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) throw new Error("no json object");
    obj = JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return { ...DEFAULT_DECISION_REQUEST };
  }

  const strArray = (value: unknown): string[] =>
    Array.isArray(value)
      ? value
          .filter((v): v is string => typeof v === "string")
          .map((v) => v.trim())
          .filter((v) => v.length > 0)
      : [];

  return {
    needRetrieval:
      typeof obj.needRetrieval === "boolean" ? obj.needRetrieval : false,
    unknown: strArray(obj.unknown).slice(0, MAX_MODEL_UNKNOWN),
    selectedTools: strArray(obj.selectedTools),
    queries: strArray(obj.queries).slice(0, MAX_MODEL_QUERIES),
    retrievalDepth: clampDepth(obj.retrievalDepth),
  };
}

function clampDepth(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(MAX_RETRIEVAL_DEPTH, Math.floor(value)));
}

// ============================================================================
// 系统校验（安全边界）
// ============================================================================

/**
 * 校验模型请求，应用系统安全边界。
 *
 * - allowedTools = selectedTools ∩ systemAllowedTools（唯一化）；
 * - 若 selectedTools 为空但存在 mustVerify，回退到 systemAllowedTools，
 *   保证 P0/P1 事实仍可被检索覆盖（mustVerify 不得被模型删除）；
 * - rejectedTools = selectedTools \ systemAllowedTools；
 * - acceptedUnknown = request.unknown 上限内；droppedUnknown = 超限部分；
 * - protectedMustVerify = systemAllowedTools 对应的 mustVerify 全量保留。
 */
export function validateEvidenceDecision(
  request: EvidenceDecisionRequest,
  systemAllowedTools: string[],
  mustVerify: string[],
): EvidenceDecisionValidation {
  const systemSet = new Set(systemAllowedTools);
  const selected = new Set(request.selectedTools);

  const rejectedTools = [...selected].filter((tool) => !systemSet.has(tool));
  const intersection = [...selected].filter((tool) => systemSet.has(tool));

  // 安全兜底：必须验证事实存在且模型未选择任何系统内工具 → 保留系统工具集
  let allowedTools =
    intersection.length === 0 && mustVerify.length > 0
      ? [...systemSet]
      : intersection;

  // 一致性修复（Phase 2D 缺口三执行）：needRetrieval=false → 系统层面移除全部检索工具。
  // 从"提示模型不要检索"升级为"系统禁止本轮检索"：模型无法调用未被允许/注入的工具。
  // 若 mustVerify 非空则强制 needRetrieval=true（P0/P1 事实必须可被检索覆盖），不会误删。
  const effectiveNeedRetrieval = request.needRetrieval || mustVerify.length > 0;
  if (!effectiveNeedRetrieval) {
    allowedTools = allowedTools.filter(
      (name) => !RETRIEVAL_TOOL_NAMES.has(name),
    );
  }

  const acceptedUnknown = request.unknown.slice(0, MAX_MODEL_UNKNOWN);
  const droppedUnknown =
    request.unknown.length > MAX_MODEL_UNKNOWN
      ? request.unknown.slice(MAX_MODEL_UNKNOWN)
      : [];

  // 一致性修复（缺口三执行闭环）：needRetrieval 被系统强制为 true 时，
  // 深度至少为 MIN_RETRIEVAL_DEPTH_WHEN_REQUIRED。避免"需要检索但 depth=0"自相矛盾
  // 导致 beforeToolCall 以预算=0 阻断全部检索，使 mustVerify 事实无法被覆盖。
  const clampedDepth = clampDepth(request.retrievalDepth);
  const effectiveDepth =
    effectiveNeedRetrieval
      ? Math.max(clampedDepth, MIN_RETRIEVAL_DEPTH_WHEN_REQUIRED)
      : clampedDepth;

  return {
    allowedTools,
    rejectedTools,
    acceptedUnknown,
    droppedUnknown,
    protectedMustVerify: [...mustVerify],
    // Phase 2D 缺口三：needRetrieval 采用系统强制后的有效值（mustVerify 存在时被强制为 true）；
    // query / 深度（已由 parse 裁剪 clamp）。
    needRetrieval: effectiveNeedRetrieval,
    queries: request.queries.slice(0, MAX_MODEL_QUERIES),
    retrievalDepth: effectiveDepth,
  };
}

// ============================================================================
// 计划合并
// ============================================================================

/**
 * 把校验后的决策合并进系统 EvidencePlan。
 *
 * 不可变字段（事实真值，模型不可改）：known / mustVerify / stopConditions。
 * 可变字段：unknown（模型判定的未知点）、allowedTools（系统校验后的工具集）、
 * needRetrieval / queries / retrievalDepth（模型判定的检索计划，Phase 2D 缺口三）。
 */
export function mergeDecisionIntoPlan(
  plan: EvidencePlan,
  validation: EvidenceDecisionValidation,
): EvidencePlan {
  return {
    known: [...plan.known],
    unknown: [...validation.acceptedUnknown],
    mustVerify: [...plan.mustVerify],
    allowedTools: [...validation.allowedTools],
    stopConditions: { ...plan.stopConditions },
    // Phase 2D 缺口三：把模型判定的检索必要性 / query / 深度并入计划，
    // 使下游 runAgentTurns 真正消费（注入 prompt 引导实际工具调用）。
    needRetrieval: validation.needRetrieval,
    queries: [...validation.queries],
    retrievalDepth: validation.retrievalDepth,
  };
}

// ============================================================================
// decision round 编排（唯一发起模型调用的函数）
// ============================================================================

const EVIDENCE_DECISION_SYSTEM_PROMPT = [
  "你是证据检索规划助手。你只输出一份结构化 JSON 检索决策，",
  "不生成正文、不修改已知事实、不执行工具。输出必须是一个合法 JSON 对象。",
].join("\n");

/**
 * 运行独立的结构化 EvidenceDecision 回合。
 *
 * - 构建决策 prompt → 调用 modelGenerate（复用写手路由）→ 解析 → 系统校验 → 合并；
 * - 任意失败（超时/网络/不可解析）fail-safe：回退到系统计划（source="fallback"），
 *   不阻断后续生成（计划是顾问性输入，事实安全由 coverage gate + FactGuard 保证）。
 */
export async function runEvidenceDecisionRound(
  input: EvidenceDecisionRoundInput,
): Promise<EvidenceDecisionRoundResult> {
  const systemPlan = input.evidencePlan;

  const prompt = buildEvidenceDecisionPrompt({
    chapterIntent: input.chapterIntent,
    seedContext: input.seedContext,
    known: systemPlan.known,
    mustVerify: systemPlan.mustVerify,
    systemAllowedTools: systemPlan.allowedTools,
  });

  let rawText: string | undefined;
  try {
    const out = await input.modelGenerate({
      route: input.route,
      systemPrompt: EVIDENCE_DECISION_SYSTEM_PROMPT,
      userPrompt: prompt,
      kind: EVIDENCE_DECISION_KIND,
      timeoutMs: input.timeoutMs,
      maxTokens: EVIDENCE_DECISION_MAX_TOKENS,
    });
    rawText = out.text;
    const request = parseEvidenceDecision(out.text);
    const validation = validateEvidenceDecision(
      request,
      systemPlan.allowedTools,
      systemPlan.mustVerify,
    );
    const plan = mergeDecisionIntoPlan(systemPlan, validation);
    return {
      decision: { request, validation, source: "model", rawText: out.text },
      plan,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const request = { ...DEFAULT_DECISION_REQUEST };
    const validation = validateEvidenceDecision(
      request,
      systemPlan.allowedTools,
      systemPlan.mustVerify,
    );
    const plan = mergeDecisionIntoPlan(systemPlan, validation);
    return {
      decision: { request, validation, source: "fallback", rawText, error: errMsg },
      plan,
    };
  }
}
