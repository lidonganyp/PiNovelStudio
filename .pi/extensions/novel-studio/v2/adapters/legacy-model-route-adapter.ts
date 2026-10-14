/**
 * V2 Legacy Model Route Adapter（P4）
 *
 * 包装 legacy novel-studio 的模型调用链路（api/fallback-manager.callWithFallback），
 * 暴露给 V2 CandidateGenerator。提供 4 类候选生成入口：
 *   - generateDirectBaseline：最小编辑型 prompt，无契约无风格
 *   - generateRawStage2：复用 legacy stopAfterStage:"stage2" 路径
 *   - generateSceneContractCandidate：SceneContract 驱动的编辑型 prompt
 *   - generateStyleAwareCandidate：风格指纹驱动的编辑型 prompt
 *
 * 设计原则（规格 P4）：
 * - 提示词改为"编辑型"，不是"控制型"
 * - 禁止要求固定对白比例、固定段落长度、必须按清单逐条写
 * - 每个候选记录 model、route、prompt profile、context hash
 * - 保存所有候选正文，不允许覆盖
 *
 * 为支持 P4 单元测试（无真实 API key），提供 createStubModelGenerateFn；
 * 真实链路 createLegacyModelGenerateFn 动态 import legacy fallback-manager，
 * 在 P10/P12 端到端验收时启用。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "fs";
import { createHash } from "node:crypto";
import { join } from "path";
import type { Candidate } from "../core/types.js";
import { loadModelRoutingSync } from "../../utils/config.js";
import { localizeLlmMessages } from "../../utils/llm-language-guard.js";
import { getModelRequestTimeoutMs } from "../../api/request-timeout.js";

// ============================================================================
// ModelGenerateFn — 模型调用统一接口
// ============================================================================

export interface ModelGenerateInput {
  /** 路由名（如 v2_direct_gpt / narrator_primary / v2_amplified） */
  route: string;
  /** 系统提示词 */
  systemPrompt: string;
  /** 用户提示词 */
  userPrompt: string;
  /** 候选 kind，用于 stub 区分返回内容 */
  kind: string;
  /** Optional bounded output budget for structured auxiliary calls. */
  maxTokens?: number;
  /** 超时 ms */
  timeoutMs?: number;
  /**
   * REAL-QUALITY-1-PREFLIGHT：实际请求的路由（route lock wrap 设置）。
   *
   * 与 `route` 区分：`route` 是候选语义路由（v2_rawstage2/v2_amplified），
   * `requestedRoute` 是底层调用真实走的路由（锁定 GLM 时为 nb4_*_glm）。
   *
   * 用途：当底层调用失败时，wrapModelFn 的 catch 路径无法拿到 output，
   * 但仍需记录"锁定目标 provider/route"证据（计划 §trace + 总控要求
   * "失败 modelCalls 也记录 requestedRoute/provider，至少记录锁定目标 provider=glm"）。
   * wrapModelGenerateLockedToRoute 设置此字段，wrapModelFn catch 读它推导 provider。
   *
   * 未锁定时省略（undefined）；wrapModelFn catch 回退用 genInput.route。
   */
  requestedRoute?: string;
  /** MODEL-PROMPT-ADAPTER-1：本次调用使用的提示词表达层，供 trace/消融切片。 */
  promptProfile?: string;
  /**
   * UNCERTAINTY-ABLATION-STATISTICS-1（Step 3）：采样温度。
   *
   * 仅 eval 路径使用（CLI modelGenerate 读取此字段构造请求 body）。
   * 生产 legacy fallback-manager 不读此字段（由路由配置决定）。
   * 未设置时由调用方默认（CLI 默认 0.72）。
   */
  temperature?: number;
  /**
   * UNCERTAINTY-ABLATION-STATISTICS-1（Step 3）：随机种子（可复现性）。
   *
   * 仅 eval 路径使用。多 seed 实验中每 seed 注入不同值分离生成随机性。
   * 未设置时不传 seed 字段（模型自行随机）。
   */
  seed?: number;
}

export interface ModelGenerateOutput {
  text: string;
  model: string;
  route: string;
  durationMs: number;
  finishReason?: string;
  maxTokens?: number;
  /**
   * REAL-QUALITY-1-PREFLIGHT：实际使用的 provider（如 "glm" / "doubao" / "openai" / "anthropic"）。
   * 由 legacy fallback-manager 的 FallbackResult.usedProvider 透传，或 stub 按 route 推导。
   * 用于 modelCalls 真实 usedProvider 证据（计划 §trace requestedRoute/actualProvider/actualModel）。
   */
  provider?: string;
  /**
   * REAL-QUALITY-1-PREFLIGHT：实际请求的路由名（如 "nb4_generate_glm"）。
   * 与 `route` 区分：`route` 是候选语义路由（v2_rawstage2/v2_amplified，保持选择/trace 契约），
   * `requestedRoute` 是底层调用真实走的路由（锁定 GLM 时为 nb4_*_glm）。
   * 仅在 wrap 锁定时由 wrap 层设置；未锁定时与 route 一致或省略。
   */
  requestedRoute?: string;
  /**
   * P0-2（第二轮 P0 修复）：真实 token 用量。
   *
   * 由 extractTokenUsageFromFallbackResult 从 provider 响应的 response.usage
   * （prompt_tokens / completion_tokens）抽取。orchestrator 据此填充
   * ModelCallEntry.tokenUsage，下游 metering-binder 据此计算实际计费；
   * 不再硬编码 "unknown" 导致 actualCharge=0。
   *
   * - {in, out}：成功抽取的真实 token 用量
   * - "unknown"：provider 响应未携带 usage 字段（直连旧路径或异常响应）
   * - undefined：stub 路径未设置，orchestrator 兜底为 "unknown"
   */
  tokenUsage?: { in: number; out: number } | "unknown";
  /**
   * PHASE4-2-1-1 provenance：实际生效的采样温度（透传给 fallback 请求体的值）。
   * 与 input.temperature 区分：仅记录「确实写入了请求」的 temperature。
   */
  actuallyAppliedTemperature?: number;
  /** PHASE4-2-1-1 provenance：seed 是否被透传（写入请求体）。 */
  seedApplied?: boolean;
  /** PHASE4-2-1-1 provenance：seed 是否被 provider 协议支持（支持才可能生效）。 */
  seedSupported?: boolean;
  /** PHASE4-2-1-1 provenance：fallback 是否被关闭（DISABLE_FALLBACK=1 或 package_screening）。 */
  fallbackDisabled?: boolean;
  /** Explicit, chapter-scoped Gemini channel recovery evidence. */
  fallbackTrace?: {
    authorized: true;
    fromRoute: string;
    attemptedRoutes: string[];
    failures: string[];
  };
}

export type ModelGenerateFn = (input: ModelGenerateInput) => Promise<ModelGenerateOutput>;

/**
 * A writer has one configured transport. Recovery retries that same route;
 * it never changes channels or writer families.
 */
export function authorizedWriterFallbackRoutes(route: string): string[] {
  return [];
}

const MAX_GENERATION_TOKENS = 32768;
const DEFAULT_JUDGE_MAX_RETRIES = 1;
const MAX_CONFIGURABLE_JUDGE_RETRIES = 3;
const STREAMING_JUDGE_ROUTES = new Set([
  "v2_opportunity_judge",
  "v2_literary_judge",
]);

function parseRetryLimit(value: string | undefined, maximum: number): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= maximum
    ? parsed
    : undefined;
}

function resolveJudgeMaxRetries(route: string): number | undefined {
  if (!STREAMING_JUDGE_ROUTES.has(route)) return undefined;
  const judgeLimit = parseRetryLimit(
    process.env.PINOVEL_JUDGE_MAX_RETRIES,
    MAX_CONFIGURABLE_JUDGE_RETRIES,
  ) ?? DEFAULT_JUDGE_MAX_RETRIES;
  const globalLimit = parseRetryLimit(
    process.env.PINOVEL_MODEL_MAX_RETRIES,
    MAX_CONFIGURABLE_JUDGE_RETRIES,
  );
  return globalLimit === undefined ? judgeLimit : Math.min(judgeLimit, globalLimit);
}

export function resolveGenerationMaxTokens(): number | undefined {
  const raw = process.env.PINOVEL_GENERATION_MAX_TOKENS?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_GENERATION_TOKENS) {
    return undefined;
  }
  return parsed;
}

// ============================================================================
// Stub 实现（用于 P4 单元测试）
// ============================================================================

export function createStubModelGenerateFn(): ModelGenerateFn {
  return async (input: ModelGenerateInput): Promise<ModelGenerateOutput> => {
    const start = Date.now();
    const model = stubRouteToModel(input.route);
    const provider = deriveProviderFromRoute(input.route);
    // REAL-QUALITY-1-PREFLIGHT：按 kind 返回结构化内容，让统一主链路完整跑通
    // （opportunity 产生 hypothesis → editorial 候选生成 → pairwise 非降级 verdict）。
    // 只有 raw_chapter / opportunity_judge / editorial_amplified / literary_judge
    // 四类 v2 主链路 kind 走结构化分支；其他 kind（direct_baseline/scene_contract 等
    // legacy CandidateGenerator 测试用例）保持 buildStubText 占位行为，向后兼容。
    const text = injectAdmissionStubText(
      buildStubTextByKind(input.kind, input.route, input.userPrompt),
      input.kind,
    );
    return {
      text,
      model,
      route: input.route,
      provider,
      // P0-2：stub 路径返回测试用 token 用量，避免下游测试回退 "unknown" 导致 actualCharge=0
      tokenUsage: { in: 100, out: 200 },
      durationMs: Date.now() - start,
    };
  };
}

// ============================================================================
// Eval 回放传输（recorded / synthetic）- F4 离线回放与生产验收闭环
// ============================================================================

/**
 * recorded 回放的单条预录模型结果（镜像 EvalFixtureV1.recordedToolResults 元素形状）。
 *
 * 字段以 unknown 声明以保持 prod 编译闭包不依赖 eval 契约模块
 * （eval-fixture-contract.ts 属 dist-eval/dist-test 编译目标）；结构一致性
 * 由 fixture 契约校验 + 传输运行时形状校验双重把关。
 */
export interface RecordedModelTransportEntry {
  /** response 载荷的规范化 SHA-256（64 hex）；非 string 时跳过一致性校验。 */
  responseHash?: unknown;
  /** 预录 ModelGenerateOutput 载荷；必须是含 text: string 的对象。 */
  response?: unknown;
}

/** synthetic 故障注入步骤（镜像 EvalFixtureV1.syntheticFaultPlan 元素形状）。 */
export interface SyntheticFaultStepInput {
  /** 故障种类：schema_error / empty_output / timeout / provider_error。 */
  fault?: unknown;
  /** 注入到第几次模型调用（1-based，缺省 1）。 */
  atCall?: unknown;
  /** 附加消息（进入失败证据）。 */
  message?: unknown;
}

const SYNTHETIC_FAULT_KINDS = new Set([
  "schema_error",
  "empty_output",
  "timeout",
  "provider_error",
]);

/** schema_error 注入文本：截断的 JSON（下游 JSON.parse 必然失败，触发 retry_gate 恢复路径）。 */
const SYNTHETIC_SCHEMA_ERROR_TEXT =
  '{"craftPhenomena": [{"domain": "ending_and_closure", "status": "observed", "evid';

/**
 * 规范化 JSON 序列化（对象键排序），与 eval-fixture-contract.ts 的 canonicalize
 * 规则逐字一致（undefined 标量序列化为 null；数组保序；对象键排序不去重）。
 * 两侧规则必须同步变更，否则 recorded responseHash 校验会 fail-closed 误报。
 */
function canonicalizeTransportJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeTransportJson(item)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalizeTransportJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function isPlainTokenUsage(value: unknown): value is { in: number; out: number } {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.in === "number" && typeof record.out === "number";
}

/**
 * F4-3：recorded 回放传输。按调用序消费预录结果，逐条校验 responseHash 一致性；
 * 序列耗尽 / 载荷形状非法 / hash 不一致均 fail-closed 抛错（不静默降级到真实模型）。
 *
 * durationMs 使用预录值（缺省 0），不读墙钟--保证回放行为确定性。
 */
export function createRecordedModelGenerateFn(
  entries: readonly RecordedModelTransportEntry[],
): ModelGenerateFn {
  let callIndex = 0;
  return async (input: ModelGenerateInput): Promise<ModelGenerateOutput> => {
    callIndex += 1;
    const entry = entries[callIndex - 1];
    if (typeof entry !== "object" || entry === null) {
      throw new Error(
        `[recorded-fail-closed] 预录序列耗尽：第 ${callIndex} 次模型调用（route=${input.route}，kind=${input.kind}）无 recordedToolResults 条目（共预录 ${entries.length} 条）`,
      );
    }
    const response = entry.response;
    if (typeof response !== "object" || response === null || Array.isArray(response)) {
      throw new Error(
        `[recorded-fail-closed] recordedToolResults[${callIndex - 1}].response 必须为对象载荷（hash-only 条目无法回放）`,
      );
    }
    if (typeof entry.responseHash === "string" && entry.responseHash.length > 0) {
      const actualHash = createHash("sha256")
        .update(canonicalizeTransportJson(response), "utf-8")
        .digest("hex");
      if (actualHash !== entry.responseHash) {
        throw new Error(
          `[recorded-fail-closed] recordedToolResults[${callIndex - 1}].responseHash 不一致：期望 ${entry.responseHash}，实际 ${actualHash}`,
        );
      }
    }
    const payload = response as Record<string, unknown>;
    if (typeof payload.text !== "string") {
      throw new Error(
        `[recorded-fail-closed] recordedToolResults[${callIndex - 1}].response.text 必须为 string`,
      );
    }
    return {
      text: payload.text,
      model: typeof payload.model === "string" ? payload.model : stubRouteToModel(input.route),
      route: typeof payload.route === "string" ? payload.route : input.route,
      provider:
        typeof payload.provider === "string"
          ? payload.provider
          : deriveProviderFromRoute(input.route),
      tokenUsage:
        payload.tokenUsage === "unknown" || isPlainTokenUsage(payload.tokenUsage)
          ? (payload.tokenUsage as ModelGenerateOutput["tokenUsage"])
          : undefined,
      durationMs:
        typeof payload.durationMs === "number" && Number.isFinite(payload.durationMs)
          ? payload.durationMs
          : 0,
      finishReason: typeof payload.finishReason === "string" ? payload.finishReason : undefined,
    };
  };
}

/** 从 JSON 文件加载 recorded 条目（fail-closed：读失败/解析失败/形状非法抛错）。 */
export function loadRecordedEntriesFromPath(resultsPath: string): RecordedModelTransportEntry[] {
  let raw: string;
  try {
    raw = readFileSync(resultsPath, "utf-8");
  } catch (error) {
    throw new Error(
      `[recorded-fail-closed] 无法读取 PINOVEL_EVAL_RECORDED_RESULTS_PATH=${resultsPath}：${String(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `[recorded-fail-closed] recorded 结果文件不是合法 JSON：${resultsPath}：${String(error)}`,
    );
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(
      `[recorded-fail-closed] recorded 结果文件必须是非空数组（recorded 模式至少预录 1 条模型结果）：${resultsPath}`,
    );
  }
  for (let i = 0; i < parsed.length; i += 1) {
    if (typeof parsed[i] !== "object" || parsed[i] === null) {
      throw new Error(`[recorded-fail-closed] recorded 结果文件第 ${i} 项不是对象：${resultsPath}`);
    }
  }
  return parsed as RecordedModelTransportEntry[];
}

/**
 * F4-3：synthetic 故障注入传输。命中 atCall 的调用注入确定性故障
 * （schema_error 返回截断 JSON / empty_output 返回空文本 / timeout 与
 * provider_error 立即 reject），未命中的调用回落 stub 文本。
 *
 * - 同一 atCall 出现多个步骤时首条生效（计划有序，行为确定）；
 * - 故障 reject 不等待真实超时--回放确定性优先，故障事实由错误消息承载，
 *   下游按消息语义进入 timeout/provider_error 分类与 bounded recovery。
 */
export function createSyntheticModelGenerateFn(
  plan: readonly SyntheticFaultStepInput[],
): ModelGenerateFn {
  const faultByCall = new Map<number, { fault: string; message: string }>();
  for (const step of plan) {
    if (typeof step !== "object" || step === null) {
      throw new Error("[synthetic-fail-closed] syntheticFaultPlan 元素必须是对象");
    }
    if (typeof step.fault !== "string" || !SYNTHETIC_FAULT_KINDS.has(step.fault)) {
      throw new Error(
        `[synthetic-fail-closed] 未知 fault 种类：${String(step.fault)}（合法值：schema_error/empty_output/timeout/provider_error）`,
      );
    }
    const atCall =
      typeof step.atCall === "number" && Number.isInteger(step.atCall) && step.atCall >= 1
        ? step.atCall
        : 1;
    if (!faultByCall.has(atCall)) {
      faultByCall.set(atCall, {
        fault: step.fault,
        message: typeof step.message === "string" ? step.message : "",
      });
    }
  }
  const stubFn = createStubModelGenerateFn();
  let callIndex = 0;
  return async (input: ModelGenerateInput): Promise<ModelGenerateOutput> => {
    callIndex += 1;
    const step = faultByCall.get(callIndex);
    if (step === undefined) {
      return stubFn(input);
    }
    const note = step.message ? `；${step.message}` : "";
    if (step.fault === "schema_error") {
      return {
        text: SYNTHETIC_SCHEMA_ERROR_TEXT,
        model: stubRouteToModel(input.route),
        route: input.route,
        provider: deriveProviderFromRoute(input.route),
        tokenUsage: { in: 100, out: 200 },
        durationMs: 0,
        finishReason: "stop",
      };
    }
    if (step.fault === "empty_output") {
      return {
        text: "",
        model: stubRouteToModel(input.route),
        route: input.route,
        provider: deriveProviderFromRoute(input.route),
        tokenUsage: { in: 100, out: 0 },
        durationMs: 0,
        finishReason: "stop",
      };
    }
    if (step.fault === "timeout") {
      throw new Error(
        `[synthetic-fault] 模型请求超时：route=${input.route}，kind=${input.kind}，超过 ${String(input.timeoutMs ?? "default")}ms 后中止${note}`,
      );
    }
    throw new Error(
      `[synthetic-fault] provider 请求失败（429 Too Many Requests）：route=${input.route}，kind=${input.kind}${note}`,
    );
  };
}

/** 解析 synthetic 故障计划 JSON（必须是数组，fail-closed）。 */
export function parseSyntheticFaultPlanJson(raw: string): SyntheticFaultStepInput[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `[synthetic-fail-closed] synthetic 故障计划不是合法 JSON：${String(error)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error("[synthetic-fail-closed] synthetic 故障计划必须是数组");
  }
  return parsed as SyntheticFaultStepInput[];
}

/**
 * F4-4 入口解析：按 env 构造 eval 回放传输（recorded > synthetic）。
 * 未配置任何 eval 回放 env 时返回 null（调用方继续走 V2_FORCE_STUB / legacy 解析链）。
 *
 *   - PINOVEL_EVAL_RECORDED_RESULTS_PATH：recorded 预录结果 JSON 文件路径；
 *   - PINOVEL_EVAL_SYNTHETIC_FAULTS：synthetic 故障计划内联 JSON；
 *   - PINOVEL_EVAL_SYNTHETIC_FAULTS_PATH：synthetic 故障计划 JSON 文件路径（内联优先）。
 *
 * 模式声明与传输 env 的完整性校验（防静默回退）由 unified-entry 的
 * PINOVEL_EVAL_REPLAY_TRANSPORT fail-closed 检查承担，本函数只做纯传输解析。
 */
export function createEvalReplayModelGenerateFnFromEnv(): ModelGenerateFn | null {
  const recordedPath = process.env.PINOVEL_EVAL_RECORDED_RESULTS_PATH?.trim();
  if (recordedPath) {
    return createRecordedModelGenerateFn(loadRecordedEntriesFromPath(recordedPath));
  }
  const faultsInline = process.env.PINOVEL_EVAL_SYNTHETIC_FAULTS?.trim();
  if (faultsInline) {
    return createSyntheticModelGenerateFn(parseSyntheticFaultPlanJson(faultsInline));
  }
  const faultsPath = process.env.PINOVEL_EVAL_SYNTHETIC_FAULTS_PATH?.trim();
  if (faultsPath) {
    let raw: string;
    try {
      raw = readFileSync(faultsPath, "utf-8");
    } catch (error) {
      throw new Error(
        `[synthetic-fail-closed] 无法读取 PINOVEL_EVAL_SYNTHETIC_FAULTS_PATH=${faultsPath}：${String(error)}`,
      );
    }
    return createSyntheticModelGenerateFn(parseSyntheticFaultPlanJson(raw));
  }
  return null;
}

function stubRouteToModel(route: string): string {
  // MODEL-ROUTING-CLAUDE46-1A: 先查 v2 生产路由的 config 显式声明
  const configModel = lookupV2RouteModel(route);
  if (configModel) return configModel;
  if (route.includes("gpt")) return "gpt-5.5";
  if (route.includes("claude")) return "claude-opus-4.8";
  if (route.includes("doubao")) return "doubao-seed-2.1-pro";
  if (route.includes("ernie")) return "ernie-5.1";
  // REAL-QUALITY-1-PREFLIGHT：对齐 model-routing.json 中所有 GLM 路由的 model=glm-5.2
  // （narrator_testing_glm / nb4_generate_glm / nb4_judge_glm 均为 glm-5.2）。
  if (route.includes("glm")) return "glm-5.2";
  return "stub-model";
}

/**
 * MODEL-ROUTING-CLAUDE46-1A: v2 生产路由 model 缓存（与 provider 缓存对称）。
 *
 * 复用 lookupV2RouteProvider 的 lazy load 模式：失败时返回 null，
 * 关键字匹配 fallback 仍可用。
 */
let v2RouteModelCache: Map<string, string> | null = null;

function lookupV2RouteModel(route: string): string | null {
  if (!v2RouteModelCache) {
    try {
      const config = loadModelRoutingSync();
      const agentRouting = config.agent_routing ?? {};
      const cache = new Map<string, string>();
      for (const [name, entry] of Object.entries(agentRouting)) {
        if (!name.startsWith("v2_")) continue;
        if (entry && typeof entry === "object" && typeof entry.model === "string") {
          cache.set(name, entry.model);
        }
      }
      v2RouteModelCache = cache;
    } catch {
      v2RouteModelCache = null;
      return null;
    }
  }
  return v2RouteModelCache.get(route) ?? null;
}

/**
 * REAL-QUALITY-1-PREFLIGHT：按 route 推导 provider，对齐 model-routing.json。
 *
 * 导出供 orchestrator 的 wrapModelFn catch 路径使用：失败 modelCalls 也需记录
 * "锁定目标 provider"证据（总控要求"至少记录锁定目标 provider=glm"）。
 * 成功路径直接读 output.provider（由 stub/legacy 透传），不用此函数。
 *
 * 语义：route 含 provider 关键字即推导对应 provider；未匹配返回 "stub"。
 * 与 stubRouteToModel 配合，使 stub 调用也能产出 provider 证据。
 *
 * MODEL-ROUTING-CLAUDE46-1A: 对 v2 生产路由（v2_rawstage2 / v2_amplified /
 * v2_chinese_calibration / v2_opportunity_judge / v2_literary_judge），
 * 从 model-routing.json 显式读取 provider（派工卡 §3 Required Change #7：
 * trace modelCalls 必须能证明生成与裁判异源）。
 * 这些路由名不含 provider 关键字，旧版关键字匹配会全部返回 "stub"，
 * 导致异源分轨断言无法验证。本版本从 config 显式读取，使 stub 调用
 * 也能产出 claude / doubao / openai 证据。
 *
 * 关键字匹配保留用于其他路由（narrator_testing_gpt / nb4_generate_glm /
 * v2_direct_claude 等含关键字的路由），向后兼容。
 */
export function deriveProviderFromRoute(route: string): string {
  // MODEL-ROUTING-CLAUDE46-1A: 先查 v2 生产路由的 config 显式声明
  const configProvider = lookupV2RouteProvider(route);
  if (configProvider) {
    // 对齐关键字匹配的 provider 命名（claude→anthropic, gpt→openai）
    if (configProvider === "claude") return "anthropic";
    if (configProvider === "gpt") return "openai";
    return configProvider; // doubao / ernie / glm 等已对齐
  }
  if (route.includes("gpt")) return "openai";
  if (route.includes("claude")) return "anthropic";
  if (route.includes("doubao")) return "doubao";
  if (route.includes("ernie")) return "ernie";
  if (route.includes("glm")) return "glm";
  return "stub";
}

/**
 * MODEL-ROUTING-CLAUDE46-1A: v2 生产路由 provider 缓存。
 *
 * model-routing.json 在进程内不变化，缓存避免每次 stub 调用都读文件。
 * 失败时（文件缺失/解析错误）返回 null，关键字匹配 fallback 仍可用，
 * 不阻断 stub 调用。
 */
let v2RouteProviderCache: Map<string, string> | null = null;

function lookupV2RouteProvider(route: string): string | null {
  if (!v2RouteProviderCache) {
    try {
      const config = loadModelRoutingSync();
      const agentRouting = config.agent_routing ?? {};
      const cache = new Map<string, string>();
      // 缓存所有 v2_* 路由的 provider（也覆盖 v2_direct_* / v2_editorial_planner 等）
      for (const [name, entry] of Object.entries(agentRouting)) {
        if (!name.startsWith("v2_")) continue;
        if (typeof entry === "string") {
          cache.set(name, entry);
        } else if (entry && typeof entry.provider === "string") {
          cache.set(name, entry.provider);
        }
      }
      v2RouteProviderCache = cache;
    } catch {
      // 文件缺失或解析错误：返回 null，关键字匹配 fallback
      v2RouteProviderCache = null;
      return null;
    }
  }
  return v2RouteProviderCache.get(route) ?? null;
}

/**
 * REAL-QUALITY-1-PREFLIGHT：按 kind 返回结构化 stub 内容。
 *
 * 四类 v2 主链路 kind 返回合法结构化内容，让完整链路可跑通：
 * - raw_chapter：固定 raw 正文（含可被 opportunity 引用的章末片段）
 * - opportunity_judge：合法 opportunity verdict JSON（evidenceExcerpt 必须在 raw 中存在）
 * - editorial_amplified：editorial 候选正文（章末增加新悬念，与 raw 可区分）
 * - literary_judge：合法 pairwise verdict JSON（winner=tie，不依赖匿名映射，非降级）
 *
 * 其他 kind（direct_baseline/scene_contract 等 legacy CandidateGenerator 测试用例）
 * 保持原 buildStubText 占位行为，向后兼容（candidate-generator.test.mjs 依赖
 * 不同 kind 返回可区分正文）。
 */
function injectAdmissionStubText(text: string, kind: string): string {
  const injected = process.env.PINOVEL_ADMISSION_STUB_INJECT?.trim();
  if (!injected) {
    return text;
  }
  if (
    kind === "raw_chapter"
    || kind === "agentic_raw"
    || kind === "editorial_amplified"
    || kind === "author_style_optimization"
  ) {
    return `${text}\n${injected}`;
  }
  return text;
}

function buildStubTextByKind(kind: string, route: string, userPrompt: string): string {
  switch (kind) {
    case "raw_chapter":
      return STUB_RAW_TEXT;
    case "agentic_raw":
      // Phase 3C：agentic_raw 是初稿，与 raw_chapter 共用 stub 文本（含角色名），
      // 使事件抽取器能从 stub 文本中提取已知实体事件。
      return STUB_RAW_TEXT;
    case "opportunity_judge":
      return STUB_OPPORTUNITY_VERDICT;
    case "editorial_amplified":
      return STUB_EDITORIAL_TEXT;
    case "author_style_optimization":
      return STUB_EDITORIAL_TEXT;
    case "literary_judge":
      return STUB_PAIRWISE_VERDICT;
    default:
      return buildStubText(kind, route, userPrompt);
  }
}

/**
 * stub 正文共享填充段（FINAL-STUB-LENGTH-1）。
 *
 * 统一主链路 6.6 完整性门禁按 targetWordCount.min（默认 2000，多数测试 workspace
 * 配置 2500）做最低字数硬检查；stub 正文必须达到真实章节量级，否则所有
 * 期望 status=ok 的 V2_FORCE_STUB 测试会稳定被 final_text_completeness 阻断。
 * 修复原则是让 stub 满足门禁（不降低门禁本身）：
 * - 保留原 5 句不动（evidenceExcerpt / 实体抽取 / pairwise span 依赖原句原位）；
 * - raw 与 editorial 共享同一填充块（故事保持门禁只增不减，行为与现状一致）；
 * - 不引入新专有实体、不使用抓握族/替换语义动词、无闭合标记、句末标点完整。
 */
const STUB_BODY_FILLER = [
  "水温比岸边更冷，寒意顺着皮肤一层层压进骨缝。",
  "他数着自己的心跳，让每一次呼吸都慢下来。",
  "耳膜里全是水流摩擦的声音，像有人在远处拖动锁链。",
  "上方透下来的天光被泥沙滤成灰绿色，越往深处越是昏暗。",
  "岸上的人只当他是个来捞鱼的少年，没人知道他真正要找什么。",
  "出发前他把传承的来历在心里又过了一遍，确保没有记错任何一个细节。",
  "传闻里说，青鱼嘴水底沉着一道门，门后有能改变命格的东西。",
  "他原本不信传闻，直到那枚旧玉在他掌心发烫。",
  "玉里的声音只说过一句：去水底，找环形之门。",
  "从那以后，他每晚都会梦见这片浑浊的水。",
  "冷水灌进袖口，贴着皮肤游走，像无数细小的钩子。",
  "他按传承里教的法子收拢气息，让身体的热量不再外散。",
  "四周的能见度越来越低，他开始靠水流的方向判断位置。",
  "暗流的走向在传承的知觉里呈现为淡青色的线。",
  "那些线在水底织成一张缓缓收拢的网。",
  "其中一条暗流的尾端，正指向他此刻下潜的方向。",
  "更深处的水几乎不流动，悬浮的泥沙像一场永不落地的雪。",
  "偶尔有气泡从缝里钻出来，摇摇晃晃地升向水面。",
  "他数着气泡判断缝隙的位置，传承的知觉与之隐隐吻合。",
  "水底的东西大多沉默，沉默得让人心里发空。",
  "短剑在腰间随着动作轻晃，剑柄上缠的布条被水泡得发胀。",
  "他伸手按住剑柄，指腹传来粗糙的触感，心绪略微安定。",
  "一群银色小鱼从眼前掠过，鳞片反着微光，转眼又散进浑浊里。",
  "鱼群散去的方向，那道黑影再一次出现。",
  "它的轮廓比人更长，边缘却在水中微微发散，像一团化不开的墨。",
  "这次它没有掠走，而是悬在半明半暗的水层里，像一段沉在水中的枯木。",
  "他放慢划水的动作，尽量不惊动它。",
  "他不动，它也不动，两者之间隔着十几丈深的水。",
  "这样的对峙持续了十几次呼吸，黑影忽然沉了下去。",
  "沉下去的方向，正是石壁所在的位置。",
  "水底的泥沙被搅起，又缓缓沉降，视野重新变得浑浊。",
  "一只苍白的手从泥沙里露出来，指骨上还挂着腐朽的绳结。",
  "他认出那是溺亡者的残骸，胃里一阵翻涌，却强迫自己继续下潜。",
  "死者生前也许和他一样，为了某个传闻潜入这片水域。",
  "想到这里，他握剑的手紧了紧。",
  "他想过转身离开，这个念头在水下格外清晰。",
  "离开就意味着这半个月的水性训练、这口憋到极限的气全部作废。",
  "更要命的是，传承深处的记忆告诉他，门的开启只在今夜。",
  "错过今夜，环形纹路会重新被淤泥封死，下一次开启不知要等多少年。",
  "他把这几个念头依次按下去，像把浮标一个个压进水底。",
  "传承里的记忆碎片在此刻浮现，是某个更古老的下潜者的视角。",
  "那段记忆里，水下曾有过一座完整的石门。",
  "石门两侧刻着环形的纹路，纹路的中心嵌着一枚会发光的圆环。",
  "记忆到这里就断了，像被水浸泡过的书页。",
  "传承的原主人生前是个守陵人，一生只做一件事：看住水底那道门。",
  "守陵人的记忆残缺不全，大多数画面都泡得发白。",
  "只有石门和圆环的画面异常清晰，像是被人刻意留下的路标。",
  "记忆里还有一段画面：守陵人老去的那夜，把圆环从门上取了下来。",
  "取环的手法他看得分明，此刻便照着比划了一遍。",
  "先抵住环身的下沿，再借水流的方向一带，环就会顺着势松脱。",
  "原来今夜要用的每一分技巧，传承的主人都提前教过了。",
  "水下的时间感是错乱的，一次呼吸可以被拉得很长。",
  "他分不清自己下潜了一炷香还是半宿，只能靠氧气的灼烧感估算。",
  "越接近石壁，灼烧感越轻，仿佛水在这里愿意多借他一口气。",
  "这种错觉危险，他提醒自己，别信水的善意。",
  "他睁开眼，前方的轮廓渐渐清晰，竟真的立着一面石壁。",
  "石壁比记忆中的更高，顶端没入头顶的昏暗，看不到尽头。",
  "纹路沿着壁面盘旋而下，像某种巨大螺壳的剖面。",
  "他贴着壁面缓缓下移，剑尖始终朝前，防备暗处的东西。",
  "藻类被拂开的地方，石面露出久远以前的凿痕。",
  "每一道凿痕都很浅，显然当年刻纹的人并不想让人一眼看穿。",
  "他抬手拂去藻类，指尖触到纹路的瞬间，水底传来一阵低沉的震动。",
  "震动不剧烈，却持续不断，像某种巨大生物的鼾声。",
  "氧气已经消耗过半，胸腔开始隐隐发闷。",
  "他在心里默数，给自己留下返程所需的最后一口气。",
  "双臂开始酸胀，每一次划水都像在推动一堵软墙。",
  "他调整姿势，让身体省力地滑行，把力气留给最后的冲刺。",
  "小腿忽然抽了一下，他咬着牙把脚尖绷直，疼痛慢慢退去。",
  "这种时候慌乱就是最大的敌人，传承里的教训他记得很牢。",
  "纹路深处，那枚圆环的位置有一个凹槽，凹槽里积满了黑色的淤泥。",
  "他用短剑的剑尖一点点挑出淤泥，动作慢得近乎凝滞。",
  "淤泥散开后，凹槽底部露出一点极淡的微光。",
  "微光映在他的眼睛里，像一颗沉在水底的心脏。",
  "圆环嵌得很稳，第一次尝试时它纹丝不动。",
  "他改变角度，让剑尖抵住凹槽边缘，一点点撬动。",
  "水里的阻力让每个动作都要付出双倍的力气。",
  "第无数次尝试后，圆环终于松了半寸。",
  "泥沙腾起又落下，圆环彻底脱出凹槽的瞬间，震动骤然停止。",
  "那一刻的安静反而让他头皮发麻。",
  "圆环脱出的刹那，石壁上所有纹路同时亮了一下。",
  "那不是反光，而是从石头内部渗出来的光，淡得几乎看不见。",
  "光亮沿着纹路游走一圈，然后从中心向外熄灭，像涟漪倒着扩散。",
  "他看见纹路的尽头连向水底更深处的一团黑暗。",
  "黑暗里有什么东西翻了个身，整个水域随之晃了晃。",
  "水压从四面八方挤过来，耳膜一阵刺痛。",
  "他张开嘴，让气压缓缓平衡，喉咙里泛起铁锈的味道。",
  "黑影在头顶盘旋了一圈，搅起的水流推着他向石壁贴近。",
  "他索性借着这股力，伸手探进凹槽。",
  "指尖先触到冰冷的环身，然后是一层滑腻的苔衣。",
  "圆环比想象中轻，仿佛只是一枚空心的铜圈。",
  "他把圆环扣进掌心，用尽剩下的力气蹬离水底。",
  "上升的过程比下潜漫长得多，灰绿色的天光一点一点重新变亮。",
  "上升时他不敢太快，传承里提过急速上浮会撕裂血脉。",
  "他每上升一段就停一停，等耳膜里的刺痛退去再继续。",
  "黑影没有追来，或者追来了却被什么东西拦在水底。",
  "头顶的亮斑越来越大，像一枚被水波揉碎的月亮。",
  "肺里最后一口气烧得胸口发疼，眼前的景物开始发白。",
  "就在意识将散未散的时候，水面在他头顶碎成一片晃动的亮斑。",
  "他冲出水面，大口吞进带着腥味的空气，四肢一阵阵发软。",
  "岸边的芦苇在风里摇晃，远处传来水鸟的叫声。",
  "他仰面漂在水上，让心跳慢慢平复，掌心的圆环硌着皮肤。",
  "那圈金属此刻温热，像刚从炉膛里取出来。",
  "他把圆环举到眼前，借着月光细看。",
  "环身内侧刻着极小的字，字迹被苔衣填满，一时认不出来。",
  "等回到岸上烘干再辨，他对自己说。",
  "今夜的事，他一个字都不会对别人讲。",
  "传承的原主人守了一辈子秘密，如今这份秘密轮到他来背。",
  "少年收紧手指，游向岸边，水声在他身后轻轻合拢。",
  "他知道，从握住它的这一刻起，有些事情再也回不去了。",
];

/**
 * 固定 raw 正文：末段"他咬牙继续下潜，肺中的氧气即将耗尽。"无钩子信号，
 * 可被 opportunity verdict 的 evidenceExcerpt 引用（span 强制：excerpt 必须在 raw 中存在）。
 */
const STUB_RAW_TEXT = [
  "青鱼嘴的水下，浑浊的水面下暗流涌动。",
  "叶尘屏息潜入，水草缠住脚踝，他用力挣脱。",
  "黑影从深处掠过，他猛地转身，手中短剑刺出。",
  "水流变急，前方出现一道模糊的轮廓。",
  "他咬牙继续下潜，肺中的氧气即将耗尽。",
  ...STUB_BODY_FILLER,
].join("\n");

/**
 * 合法 opportunity verdict JSON：evidenceExcerpt 是 STUB_RAW_TEXT 末段（真实存在）。
 * opportunityType=chapter_end_pressure 是合法值，diagnosis/expectedReaderGain/damageRisks 齐全。
 * 让 EditorialOpportunityJudge.judgeWithLLM 解析成功 → llmJudged=true + 1 个 hypothesis。
 */
const STUB_OPPORTUNITY_VERDICT = JSON.stringify({
  craftPhenomena: [
    {
      domain: "ending_and_closure",
      status: "observed",
      phenomenon: "章末压力存在，但尚未形成新的因果问题",
      evidenceExcerpt: "他咬牙继续下潜，肺中的氧气即将耗尽。",
      contextEvidenceRefs: [],
      readerImpact: "读者能感到即时危险，但后续牵引仍可加强",
      confidence: 0.7,
    },
  ],
  opportunities: [
    {
      opportunityType: "chapter_end_pressure",
      craftDomain: "ending_and_closure",
      diagnosis: "章末缺少翻页牵引力，末段无新问题或压力",
      evidenceExcerpt: "他咬牙继续下潜，肺中的氧气即将耗尽。",
      expectedReaderGain: "章末抛出新悬念或压力，提升翻页牵引力",
      damageRisks: ["强行加钩子可能与本章已建立的事实冲突"],
      contextEvidenceRefs: [],
      confidence: 0.7,
    },
  ],
  noOpReason: null,
});

/**
 * editorial 候选正文：与 raw 可区分，章末增加新悬念（"某种古老的呼吸正在苏醒"）。
 * 让 EditorialCandidateGenerator 生成 editorial_amplified 候选。
 */
const STUB_EDITORIAL_TEXT = [
  "青鱼嘴的水下，浑浊的水面下暗流涌动。",
  "叶尘屏息潜入，水草缠住脚踝，他用力挣脱。",
  "黑影从深处掠过，他猛地转身，手中短剑刺出——剑锋划过黑影，竟是一具沉没的浮尸。",
  "水流变急，前方出现一道模糊的轮廓，那轮廓似乎在向他招手。",
  "他咬牙继续下潜，肺中的氧气即将耗尽，而更深的黑暗里，某种古老的呼吸正在苏醒。",
  ...STUB_BODY_FILLER,
].join("\n");

/**
 * 合法 pairwise verdict JSON：winner=tie，不依赖匿名映射（A/B 随机化不影响）。
 * decisiveReasons 含 1 条合法结构（betterCandidate=neither，evidenceA/B 各 1 条 span）。
 * 让 PairwiseLiteraryJudge 解析成功 → non-degraded（degraded=false）。
 *
 * tie 选择理由：让 JudgeArbitrator 触发反向复判（needsReverseReview=true），
 * 两轮一致 tie → 保留 raw（finalSelectedSource=rawStage2，projectGain=neutral）。
 * arbitrate 仍返回非 null ArbitratorResult（满足断言 judgeArbitration 非 null）。
 */
const STUB_PAIRWISE_VERDICT = JSON.stringify({
  winner: "tie",
  confidence: "slight",
  decisiveReasons: [
    {
      dimension: "章末钩子",
      betterCandidate: "neither",
      evidenceA: [{ start: 0, end: 10, excerpt: "青鱼嘴的水下，浑浊" }],
      evidenceB: [{ start: 0, end: 10, excerpt: "青鱼嘴的水下，浑浊" }],
      explanation: "两候选章末均有钩子空间，质量接近，判 tie",
    },
  ],
  factualRisks: [],
  regressionRisks: [],
  constitutionAlignment: "两候选均对齐作品宪法",
});

/**
 * 占位 stub 正文（非主链路 kind 用，向后兼容 legacy CandidateGenerator 测试）。
 * 按 kind+route 生成可区分正文（candidate-generator.test.mjs 依赖不同 kind 返回不同文本）。
 */
function buildStubText(kind: string, route: string, userPrompt: string): string {
  const promptPreview = userPrompt.slice(0, 40).replace(/\n/g, " ");
  return [
    `【stub 候选】kind=${kind} route=${route}`,
    `【prompt 预览】${promptPreview}...`,
    `【正文】这是一段由 stub 模型生成的占位正文，用于 P4 单元测试。`,
    `它包含水下救援场景的基本元素：青鱼嘴、浑浊水面、暗流拉扯、水怪黑影。`,
    `主角面临选择，风险递增，动作连续。`,
  ].join("\n");
}

// ============================================================================
// Legacy 真实实现（动态 import，P10/P12 启用）
// ============================================================================

export function createLegacyModelGenerateFn(): ModelGenerateFn {
  return async (input: ModelGenerateInput): Promise<ModelGenerateOutput> => {
    const start = Date.now();
    // 动态 import legacy fallback-manager，避免 V2 typecheck 依赖 legacy 内部类型
    const fallbackMod: any = await import("../../api/fallback-manager.js");
    const candidateTimeoutMs = input.timeoutMs ?? getModelRequestTimeoutMs();
    const judgeMaxRetries = resolveJudgeMaxRetries(input.route);
    const messages = localizeLlmMessages([
      { role: "system", content: input.systemPrompt },
      { role: "user", content: input.userPrompt },
    ]);
    // Use the same candidate budget for the chain and the in-flight HTTP request.
    // fetchWithTimeout aborts the request, so timeout does not leave a background retry alive.
    const maxTokens = input.maxTokens ?? (
      input.kind === "raw_chapter" || input.kind === "editorial_amplified"
        ? resolveGenerationMaxTokens()
        : undefined
    );
    const fallbackDisabledByEnv = process.env.PINOVEL_DISABLE_FALLBACK === "1"
      || process.env.PINOVEL_BENCHMARK_COST_PROFILE === "package_screening";
    const attemptedRoutes = fallbackDisabledByEnv
      ? [input.route]
      : [input.route, ...authorizedWriterFallbackRoutes(input.route)];
    const failures: string[] = [];
    let result: any;
    let usedRoute = input.route;
    for (const route of attemptedRoutes) {
      const manager = fallbackMod.createAPIFallbackManager({
        totalTimeoutMs: candidateTimeoutMs,
        ...(judgeMaxRetries === undefined ? {} : { maxRetries: judgeMaxRetries }),
      });
      try {
        result = await manager.callWithFallback(
          route,
          messages,
          {
            ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
            ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
            ...(input.seed === undefined ? {} : { seed: input.seed }),
            timeoutMs: candidateTimeoutMs,
            ...(STREAMING_JUDGE_ROUTES.has(route) ? { stream: true } : {}),
          },
        );
        usedRoute = route;
        break;
      } catch (error: unknown) {
        failures.push(error instanceof Error ? error.message : String(error));
        if (route === attemptedRoutes[attemptedRoutes.length - 1]) throw error;
      }
    }
    if (!result) {
      throw new Error(`No model result for ${input.route}`);
    }
    const text = extractTextFromFallbackResult(result);
    const finishReason = extractFinishReasonFromFallbackResult(result);
    // P0-2：从 provider 响应抽取真实 token 用量，替代 orchestrator 硬编码 "unknown"
    const tokenUsage = extractTokenUsageFromFallbackResult(result);
    // F3：seed 是否被透传并实际支持——provider 协议不支持 seed 时显式标记，
    // 而非静默忽略。fallback 关闭 = PINOVEL_DISABLE_FALLBACK=1 或 package_screening 配置。
    const fallbackDisabled =
      process.env.PINOVEL_DISABLE_FALLBACK === "1" ||
      process.env.PINOVEL_BENCHMARK_COST_PROFILE === "package_screening";
    return {
      text,
      model: result.usedModel ?? "unknown",
      route: input.route,
      // REAL-QUALITY-1-PREFLIGHT：透传 fallback-manager 的 usedProvider 作为真实 provider 证据。
      provider: result.usedProvider ?? undefined,
      ...(finishReason !== undefined ? { finishReason } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      tokenUsage,
      durationMs: Date.now() - start,
      // PHASE4-2-1-1 provenance：真实采样与路由证据，供报告记录 effective sampling。
      actuallyAppliedTemperature: input.temperature,
      seedApplied: input.seed !== undefined,
      seedSupported: input.seed !== undefined && supportsSeedOnProvider(result.usedProvider),
      fallbackDisabled,
      requestedRoute: input.route,
      ...(usedRoute !== input.route
        ? {
            fallbackTrace: {
              authorized: true as const,
              fromRoute: input.route,
              attemptedRoutes,
              failures,
            },
          }
        : {}),
    };
  };
}

/**
 * 判断 provider 协议是否支持 seed 采样种子（用于 provenance 记录）。
 *
 * Claude 协议不支持 seed；OpenAI 兼容 provider（glm/doubao/gpt 等）支持。
 * 与 fallback-manager 的请求体透传保持口径一致：provider 不支持时显式标记
 * seedSupported=false，弃用"3 seed"受控复现、改用非确定性配对实验，不静默忽略。
 */
function supportsSeedOnProvider(provider?: string): boolean {
  if (!provider) return false;
  return !/^claude(?:[-_]|$)/i.test(provider);
}

function extractTextFromFallbackResult(result: any): string {
  // GLMResponse: choices[0].message.content
  if (result?.response?.choices?.[0]?.message?.content) {
    return String(result.response.choices[0].message.content);
  }
  // Claude: response.content[0].text
  if (result?.response?.content?.[0]?.text) {
    return String(result.response.content[0].text);
  }
  // GPT: response.content
  if (typeof result?.response?.content === "string") {
    return result.response.content;
  }
  return "";
}

function extractFinishReasonFromFallbackResult(result: any): string | undefined {
  const choiceReason = result?.response?.choices?.[0]?.finish_reason;
  if (typeof choiceReason === "string" && choiceReason.trim()) return choiceReason;
  const stopReason = result?.response?.stop_reason;
  if (typeof stopReason === "string" && stopReason.trim()) return stopReason;
  const responseReason = result?.response?.finish_reason;
  return typeof responseReason === "string" && responseReason.trim()
    ? responseReason
    : undefined;
}

/**
 * P0-2（第二轮 P0 修复）：从 provider 响应抽取真实 token 用量。
 *
 * 三类 provider 响应形状都包含 usage 字段：
 *   - GLMResponse (api/glm.ts): response.usage.{prompt_tokens, completion_tokens, total_tokens}
 *   - GPTResponse (api/gpt.ts):  response.usage.{prompt_tokens, completion_tokens, total_tokens}
 *   - ClaudeResponse (api/claude.ts): response.usage.{input_tokens, output_tokens}
 *
 * 抽取失败（响应不含 usage 或字段非数字）返回 "unknown"，让下游
 * metering-binder 按 0 token 估算并继续上报 settle（保持计费账本完整）。
 *
 * 设计原则：失败不抛错——计费抽取失败不应阻断章节交付。
 */
function extractTokenUsageFromFallbackResult(result: any): { in: number; out: number } | "unknown" {
  if (!result || typeof result !== "object") return "unknown";
  const usage = result?.response?.usage;
  if (!usage || typeof usage !== "object") return "unknown";

  // OpenAI/GLM 协议：prompt_tokens / completion_tokens
  const promptTokens =
    typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : undefined;
  const completionTokens =
    typeof usage.completion_tokens === "number" ? usage.completion_tokens : undefined;

  if (promptTokens !== undefined && completionTokens !== undefined) {
    return { in: promptTokens, out: completionTokens };
  }

  // Anthropic 协议：input_tokens / output_tokens
  const inputTokens =
    typeof usage.input_tokens === "number" ? usage.input_tokens : undefined;
  const outputTokens =
    typeof usage.output_tokens === "number" ? usage.output_tokens : undefined;

  if (inputTokens !== undefined && outputTokens !== undefined) {
    return { in: inputTokens, out: outputTokens };
  }

  // 部分字段缺失：用已知字段补 0，仍返回真实结构而非 "unknown"
  const inT = promptTokens ?? inputTokens ?? 0;
  const outT = completionTokens ?? outputTokens ?? 0;
  if (promptTokens !== undefined || completionTokens !== undefined ||
      inputTokens !== undefined || outputTokens !== undefined) {
    return { in: inT, out: outT };
  }

  return "unknown";
}

// ============================================================================
// 候选保存（不覆盖）
// ============================================================================

export interface CandidateSaveResult {
  candidateId: string;
  filePath: string;
  bytes: number;
  /** 是否因同名文件已存在而追加序号 */
  deduplicated: boolean;
}

/**
 * 保存候选正文到 workspace，文件名 {chapterId}-{kind}-{n}.md，不覆盖已存在文件。
 * 若同名文件已存在，追加 -{dedupeN} 后缀直到不冲突。
 */
export function saveCandidate(
  candidate: Candidate,
  workspacePath: string,
  chapterId: string
): CandidateSaveResult {
  const dir = join(workspacePath, "v2-candidates");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const baseName = `${chapterId}-${candidate.kind}`;
  let fileName = `${baseName}.md`;
  let deduplicated = false;
  let n = 1;
  while (existsSync(join(dir, fileName))) {
    deduplicated = true;
    fileName = `${baseName}-${n}.md`;
    n += 1;
  }

  const filePath = join(dir, fileName);
  const content = [
    `<!-- candidate-id: ${candidate.id} -->`,
    `<!-- kind: ${candidate.kind} -->`,
    `<!-- model: ${candidate.model} -->`,
    `<!-- route: ${candidate.route} -->`,
    `<!-- context-hash: ${candidate.contextHash} -->`,
    `<!-- generated-at: ${candidate.generatedAt} -->`,
    `<!-- prompt-profile: type=${candidate.promptProfile.type} containsDialogueRatio=${candidate.promptProfile.containsDialogueRatio} containsParagraphLengthConstraint=${candidate.promptProfile.containsParagraphLengthConstraint} -->`,
    ``,
    candidate.text,
  ].join("\n");

  writeFileSync(filePath, content, "utf-8");
  const bytes = statSync(filePath).size;

  return {
    candidateId: candidate.id,
    filePath,
    bytes,
    deduplicated,
  };
}

// ============================================================================
// 路由名常量（与 config/model-routing.json 对齐，Task 16 配置）
// ============================================================================

export const V2_ROUTES = {
  DIRECT_GPT: "v2_direct_gpt",
  DIRECT_CLAUDE: "v2_direct_claude",
  DIRECT_DOUBAO: "v2_direct_doubao",
  RAWSTAGE2: "v2_rawstage2",
  AMPLIFIED: "v2_amplified",
} as const;

export type V2RouteName = (typeof V2_ROUTES)[keyof typeof V2_ROUTES];
