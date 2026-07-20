/**
 * V2 CandidateGenerator — 候选生成器（P4）
 *
 * 目标（规格 P4）：让强模型发挥，不再只生成一稿后被旧 gate 反复修坏。
 *
 * 设计原则：
 * - 同一输入至少生成 5 类候选：direct_baseline / context_enhanced / scene_contract / style_aware / model_variant
 * - 保存所有候选正文，不允许覆盖
 * - 每个候选记录 model、route、prompt profile、context hash
 * - 提示词改为"编辑型"，不是"控制型"：少约束生成，多约束选择
 *
 * promptProfile 审计（规格 P4 硬约束）：
 * - containsDialogueRatio === false（prompt 不得要求固定对白比例）
 * - containsParagraphLengthConstraint === false（prompt 不得要求固定段落长度）
 * - type === "editorial"（不得是 control 型）
 *
 * 实现：CandidateGenerator 接收 CompiledContext + SceneContract[] + ModelGenerateFn，
 * 为每类候选构建编辑型 prompt，审计后调用 ModelGenerateFn，返回 Candidate[]。
 */

import { createHash } from "crypto";
import type {
  Candidate,
  CandidateKind,
  CandidatePromptProfile,
  CompiledContext,
  EditorialPlan,
  EditorialVariantBrief,
  SceneContract,
  StyleReference,
} from "./types.js";
import type {
  ModelGenerateFn,
  ModelGenerateInput,
} from "../adapters/legacy-model-route-adapter.js";
import { sceneContractContainsMechanicalMetric } from "./scene-contract-planner.js";

// ============================================================================
// Fewshot 加载器类型（P11 接入）
// ============================================================================

/**
 * Fewshot 加载器回调：给定 sceneType，返回匹配的 few-shot StyleReference[]。
 *
 * 由调用方（V2 ReplayRunner / 编排器）注入实现：
 *   - 默认 no-op（返回 []），保持 CandidateGenerator 纯净可测
 *   - 真实实现见 adapters/legacy-fewshot-adapter.ts:loadFewshotExamples
 *
 * few-shot 在 prompt 中作为"参考示例"注入，不是控制清单（保持 editorial 型）。
 */
export type FewshotLoader = (sceneType: string) => StyleReference[];

function noopFewshotLoader(): FewshotLoader {
  return () => [];
}

// ============================================================================
// Prompt 审计正则
// ============================================================================

/** 对白比例控制指令 */
const DIALOGUE_RATIO_PATTERN = /对白比例|对话比例|dialogue\s*ratio|比例必须.*?\d+\s*%|\d+\s*%\s*对白/i;

/** 段落长度控制指令 */
const PARAGRAPH_LENGTH_PATTERN = /每段.*?\d+\s*字|段落长度必须|每段.*?字数|段落必须.*?\d+|每段不少于\d+|每段不超过\d+/i;

/** 控制型清单指令（必须按清单逐条写） */
const CONTROL_CHECKLIST_PATTERN = /必须按清单|逐条写|按以下清单逐条|必须依次完成以下事件|必须覆盖以下事件清单/i;

// ============================================================================
// Prompt 审计函数
// ============================================================================

export function auditPrompt(systemPrompt: string, userPrompt: string): CandidatePromptProfile {
  const fullPrompt = `${systemPrompt}\n${userPrompt}`;
  const containsDialogueRatio = DIALOGUE_RATIO_PATTERN.test(fullPrompt);
  const containsParagraphLengthConstraint = PARAGRAPH_LENGTH_PATTERN.test(fullPrompt);
  const containsControlChecklist = CONTROL_CHECKLIST_PATTERN.test(fullPrompt);

  // 机械指标污染（来自 SceneContract 字段）
  const containsMechanicalMetric = sceneContractContainsMechanicalMetric(fullPrompt);

  const isControl =
    containsDialogueRatio ||
    containsParagraphLengthConstraint ||
    containsControlChecklist ||
    containsMechanicalMetric;

  return {
    type: isControl ? "control" : "editorial",
    tokensIn: estimateTokens(fullPrompt),
    containsDialogueRatio,
    containsParagraphLengthConstraint,
    containsControlChecklist,
    containsMechanicalMetric,
    contractIds: extractContractIds(userPrompt),
  };
}

function estimateTokens(text: string): number {
  // 粗略估算：中文 1.5 字/token，英文 4 字符/token
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const otherChars = text.length - chineseChars;
  return Math.ceil(chineseChars / 1.5 + otherChars / 4);
}

function extractContractIds(userPrompt: string): string[] {
  // 从 prompt 中提取 scene:idx:type 形式的 contract id
  const matches = userPrompt.match(/scene:\d+:[a-z]+/g) ?? [];
  return Array.from(new Set(matches));
}

// ============================================================================
// Prompt 构建（编辑型）
// ============================================================================

function buildContextBlock(context: CompiledContext): string {
  const lines: string[] = [];

  // 世界规则
  if (context.worldRules.length > 0) {
    lines.push("【世界规则】");
    for (const w of context.worldRules.slice(0, 5)) {
      lines.push(`- ${w.description}`);
    }
  }

  // 角色状态
  if (context.characterStates.length > 0) {
    lines.push("【角色状态】");
    for (const c of context.characterStates.slice(0, 6)) {
      const state = c.state;
      const parts: string[] = [];
      if (state.role) parts.push(`定位=${state.role}`);
      if (state.mentality) parts.push(`心智=${state.mentality}`);
      if (state.pendingTension) parts.push(`张力=${state.pendingTension}`);
      lines.push(`- ${c.name}：${parts.join("，") || "状态正常"}`);
    }
  }

  // 前章承接 + 锚点（从 facts 提取）
  const factLines = context.facts
    .filter((f) => f.kind === "fact")
    .slice(0, 6)
    .map((f) => `- ${f.content}`);
  if (factLines.length > 0) {
    lines.push("【事实锚点】");
    lines.push(...factLines);
  }

  return lines.join("\n");
}

function buildOpenLoopsBlock(context: CompiledContext): string {
  if (context.openLoops.length === 0) return "";
  const lines = ["【未结回路（仅供参考，不必本章全收）】"];
  for (const l of context.openLoops.slice(0, 5)) {
    lines.push(`- ${l.description}`);
  }
  return lines.join("\n");
}

function buildSceneContractBlock(contracts: SceneContract[]): string {
  if (contracts.length === 0) return "";
  const lines = ["【场景契约】"];
  for (const c of contracts) {
    lines.push(`\n## ${c.sceneId}（${c.sceneType}）`);
    if (c.readerPayoff.length > 0) {
      lines.push(`读者体验：${c.readerPayoff.join("；")}`);
    }
    if (c.mustPreserve.length > 0) {
      // P44 重构：mustPreserve 全为事实边界（连续性重点 + anchor 事实），无行动词配额硬约束
      lines.push(`【场景契约·必须保留的事实】${c.mustPreserve.join("；")}`);
    }
    if (c.qualityLevers.length > 0) {
      lines.push(`质量杠杆：${c.qualityLevers.join("；")}`);
    }
    if (c.mustAvoid.length > 0) {
      lines.push(`避免：${c.mustAvoid.join("；")}`);
    }
  }
  return lines.join("\n");
}

function buildStyleBlock(context: CompiledContext): string {
  if (context.styleReferences.length === 0) return "";
  // few-shot kind 由独立 block 处理，这里只渲染 fingerprint / signature_pattern
  const nonFewshot = context.styleReferences.filter((s) => s.kind !== "fewshot");
  if (nonFewshot.length === 0) return "";
  const lines = ["【风格参考】"];
  for (const s of nonFewshot) {
    lines.push(`- ${s.kind}：${s.content.slice(0, 400)}`);
  }
  return lines.join("\n");
}

/**
 * 渲染 few-shot 参考块（P11 接入）。
 *
 * 措辞为"参考示例，不必逐句模仿"，避免 prompt 被审计为 control 型。
 * few-shot 是 library 资产，只读注入，不构成必须覆盖的清单。
 */
function buildFewshotBlock(references: StyleReference[]): string {
  if (references.length === 0) return "";
  const lines = ["【参考示例（仅供感受风格与节奏，不必逐句模仿）】"];
  for (let i = 0; i < references.length; i += 1) {
    const ref = references[i];
    lines.push(`### 示例 ${i + 1}`);
    lines.push(ref.content.slice(0, 520));
  }
  return lines.join("\n");
}

// ============================================================================
// CandidateGenerator 入参/出参
// ============================================================================

export interface CandidateGenerateInput {
  context: CompiledContext;
  contracts: SceneContract[];
  /** 上下文 hash（来自 ContextCompiler） */
  contextHash: string;
  chapterNumber: number;
  /** 模型调用函数（stub 或 legacy） */
  modelGenerate: ModelGenerateFn;
  /** 启用的候选 kind 列表（默认全 6 类） */
  kinds?: CandidateKind[];
  /** model_variant 的路由列表（默认 v2_direct_gpt） */
  modelVariantRoutes?: string[];
  /** 超时 ms */
  timeoutMs?: number;
  /**
   * EditorialPlan（editorial_amplified 候选用；其他 kind 忽略）。
   * 由 v2-orchestrator 2c 阶段产出。缺失时 editorial_amplified kind 跳过并记 auditFailure。
   */
  editorialPlan?: EditorialPlan;
  /**
   * Fewshot 加载器（P11 接入，可选）。
   * 给定 sceneType 返回匹配的 few-shot StyleReference[]。
   * 默认 no-op；由 V2 ReplayRunner / 编排器注入 legacy-fewshot-adapter 实现。
   * scene_contract / style_aware 候选会注入 few-shot 参考块。
   */
  fewshotLoader?: FewshotLoader;
}

export interface CandidateGenerateResult {
  candidates: Candidate[];
  /** 审计失败的候选（promptProfile 为 control 型 / 空文本重试耗尽 / 模型调用失败） */
  auditFailures: Array<{ kind: CandidateKind; reason: string }>;
}

// ============================================================================
// CandidateGenerator 类
// ============================================================================

const EDITORIAL_SYSTEM_PROMPT = `你是顶尖网文作者。请根据提供的上下文写出本章正文。

写作原则：
- 少约束生成，多约束选择；少强迫改文，多比较胜负；少管句子，多管目标。
- 写读者体验，不写指标。
- 让角色主动选择，让风险真实递增。
- 中文自然，不用翻译腔。`;

export class CandidateGenerator {
  async generate(input: CandidateGenerateInput): Promise<CandidateGenerateResult> {
    const kinds = input.kinds ?? [
      "direct_baseline",
      "context_enhanced",
      "scene_contract",
      "style_aware",
      "model_variant",
      "editorial_amplified",
    ];
    const candidates: Candidate[] = [];
    const auditFailures: CandidateGenerateResult["auditFailures"] = [];
    const fewshotLoader = input.fewshotLoader ?? noopFewshotLoader();

    for (const kind of kinds) {
      // editorial_amplified：按 EditorialPlan.variantStrategies 展开多变体候选
      // （编辑意图驱动的新候选，非单 route 重写；每个 variant 是独立 Candidate）
      if (kind === "editorial_amplified") {
        const plan = input.editorialPlan;
        if (!plan || plan.variantStrategies.length === 0) {
          // 无 plan → 跳过（orchestrator 保证传入；缺失只记 auditFailure）
          auditFailures.push({ kind, reason: "editorialPlan 缺失或 variantStrategies 为空" });
          continue;
        }
        for (const variant of plan.variantStrategies) {
          const route = "v2_amplified";
          const result = await this.generateOneCandidate(kind, route, input, fewshotLoader, variant);
          if (result.candidate) {
            candidates.push(result.candidate);
          } else if (result.failure) {
            auditFailures.push(result.failure);
          }
        }
        continue; // 跳过下方单候选 route 循环
      }

      const routes = kind === "model_variant"
        ? (input.modelVariantRoutes ?? ["v2_direct_gpt"])
        : [routeForKind(kind)];

      for (const route of routes) {
        const result = await this.generateOneCandidate(kind, route, input, fewshotLoader);
        if (result.candidate) {
          candidates.push(result.candidate);
        } else if (result.failure) {
          auditFailures.push(result.failure);
        }
      }
    }

    return { candidates, auditFailures };
  }

  /**
   * 单候选生成（审计 + 空文本有界重试 + 候选构造）。
   *
   * 抽取自 generate 循环，供单 route kind 与 editorial_amplified 多变体复用，
   * 避免审计/重试/候选构造逻辑重复。
   *
   * @param variant editorial_amplified 变体（其他 kind 传 undefined）
   * @returns 成功返回 { candidate }，失败返回 { failure: { kind, reason } }
   */
  private async generateOneCandidate(
    kind: CandidateKind,
    route: string,
    input: CandidateGenerateInput,
    fewshotLoader: FewshotLoader,
    variant?: EditorialVariantBrief,
  ): Promise<{ candidate?: Candidate; failure?: { kind: CandidateKind; reason: string } }> {
    const { systemPrompt, userPrompt } = this.buildPrompt(kind, input, route, fewshotLoader, variant);
    const promptProfile = auditPrompt(systemPrompt, userPrompt);

    // 审计：control 型 prompt 不发送（防止 gate 污染）
    if (promptProfile.type === "control") {
      return {
        failure: {
          kind,
          reason: `prompt 审计为 control 型：containsDialogueRatio=${promptProfile.containsDialogueRatio}, containsParagraphLengthConstraint=${promptProfile.containsParagraphLengthConstraint}, containsControlChecklist=${promptProfile.containsControlChecklist}, containsMechanicalMetric=${promptProfile.containsMechanicalMetric}`,
        },
      };
    }

    const genInput: ModelGenerateInput = {
      route,
      systemPrompt,
      userPrompt,
      kind,
      timeoutMs: input.timeoutMs,
    };

    // 空文本防护 — 模型偶发返回空 content(如 Doubao 流式截断),
    // 需有界重试避免空 baseline 进入比较(ch5s0 假阳性根因)
    const MAX_EMPTY_RETRIES = 2; // 最多重试 2 次 = 3 次总尝试
    let output;
    let lastEmptyReason = "";
    let modelError = ""; // 非空表示模型抛异常(与空文本区分,避免重复 auditFailure)
    for (let attempt = 0; attempt <= MAX_EMPTY_RETRIES; attempt++) {
      try {
        const tried = await input.modelGenerate(genInput);
        if (!tried.text || tried.text.trim().length === 0) {
          lastEmptyReason = `空文本(attempt ${attempt + 1}/${MAX_EMPTY_RETRIES + 1}, durationMs=${tried.durationMs})`;
          if (attempt < MAX_EMPTY_RETRIES) continue; // 重试
          output = tried; // 最后一次仍空,记录失败
          break;
        }
        output = tried;
        break;
      } catch (e: any) {
        modelError = e?.message ?? String(e);
        output = undefined;
        break;
      }
    }

    // 空文本重试耗尽 / 模型异常 → 标记单条 auditFailure,不进入候选列表(避免空 baseline 假阳性)
    if (!output || !output.text || output.text.trim().length === 0) {
      return {
        failure: {
          kind,
          reason: modelError
            ? `模型调用失败：${modelError}`
            : output
              ? `空文本重试耗尽：${lastEmptyReason}`
              : `模型调用失败(无输出)`,
        },
      };
    }

    // candidate id：editorial_amplified 带变体策略后缀避免同毫秒碰撞；其他 kind 保持原格式
    const idBase = variant ? `candidate:${kind}:${route}:${variant.strategy}` : `candidate:${kind}:${route}`;
    const candidate: Candidate = {
      id: `${idBase}:${Date.now()}`,
      kind,
      text: output.text,
      model: output.model,
      route: output.route,
      promptProfile,
      contextHash: input.contextHash,
      generatedAt: new Date().toISOString(),
      durationMs: output.durationMs,
      editorialStrategy: variant?.strategy,
    };

    return { candidate };
  }

  private buildPrompt(
    kind: CandidateKind,
    input: CandidateGenerateInput,
    route: string,
    fewshotLoader: FewshotLoader,
    variant?: EditorialVariantBrief,
  ): { systemPrompt: string; userPrompt: string } {
    const ctx = input.context;
    const chapterN = input.chapterNumber;

    const contextBlock = buildContextBlock(ctx);
    const openLoopsBlock = buildOpenLoopsBlock(ctx);
    const sceneBlock = buildSceneContractBlock(input.contracts);
    const styleBlock = buildStyleBlock(ctx);

    // P11: few-shot 在 scene_contract / style_aware / model_variant / editorial_amplified 候选中注入。
    // 取首个 contract 的 sceneType 作为检索 key；无 contract 则不注入。
    const primarySceneType = input.contracts[0]?.sceneType;
    const fewshotRefs = primarySceneType ? fewshotLoader(primarySceneType) : [];
    const fewshotBlock = buildFewshotBlock(fewshotRefs);

    const userParts: string[] = [];
    userParts.push(`请写出第 ${chapterN} 章正文。`);

    if (kind === "direct_baseline") {
      // 最小编辑型 prompt：仅上下文 + 事实锚点
      userParts.push(contextBlock);
    } else if (kind === "context_enhanced") {
      // 上下文 + 开放回路
      userParts.push(contextBlock);
      if (openLoopsBlock) userParts.push(openLoopsBlock);
    } else if (kind === "scene_contract") {
      // 上下文 + 场景契约 + few-shot 参考
      userParts.push(contextBlock);
      if (openLoopsBlock) userParts.push(openLoopsBlock);
      userParts.push(sceneBlock);
      if (fewshotBlock) userParts.push(fewshotBlock);
    } else if (kind === "style_aware") {
      // 上下文 + 风格参考 + few-shot 参考
      userParts.push(contextBlock);
      if (styleBlock) userParts.push(styleBlock);
      if (fewshotBlock) userParts.push(fewshotBlock);
    } else if (kind === "model_variant") {
      // 同 scene_contract，但走不同路由
      userParts.push(contextBlock);
      if (openLoopsBlock) userParts.push(openLoopsBlock);
      userParts.push(sceneBlock);
      if (fewshotBlock) userParts.push(fewshotBlock);
      userParts.push(`（本候选由路由 ${route} 生成，用于多模型对比）`);
    } else if (kind === "editorial_amplified" && variant) {
      // 编辑意图驱动的新候选（Layer 2 重做）：
      // 上下文 + EditorialPlan 6 字段 + 变体焦点 + few-shot 参考。
      // 不带机械指标 / 行动词配额 / 控制清单，保持 editorial 型，通过 auditPrompt。
      userParts.push(contextBlock);
      if (openLoopsBlock) userParts.push(openLoopsBlock);
      if (input.editorialPlan) {
        userParts.push(this.buildEditorialPlanBlock(input.editorialPlan));
      }
      userParts.push(`【本候选侧重】${variant.strategy}：${variant.focus}`);
      userParts.push(`切入角度：${variant.angle}`);
      if (fewshotBlock) userParts.push(fewshotBlock);
    }

    // 字数预算（编辑型，不是段落长度约束）
    userParts.push(`字数预算：按上下文暗示的章节体量自然展开。`);

    return {
      systemPrompt: EDITORIAL_SYSTEM_PROMPT,
      userPrompt: userParts.join("\n\n"),
    };
  }

  /**
   * 渲染 EditorialPlan 6 字段为编辑型 prompt 块（Layer 2）。
   *
   * 措辞为"本章编辑意图"（方向/焦点），不是"必须覆盖清单"，
   * 避免触发 auditPrompt 的 control 型门（无机械指标词）。
   */
  private buildEditorialPlanBlock(plan: EditorialPlan): string {
    const lines: string[] = ["【本章编辑意图（方向与焦点，不是必须逐条覆盖的清单）】"];
    lines.push(`读者体验：${plan.readerExperience}`);
    lines.push(`主角选择：${plan.protagonistChoice}`);
    lines.push(`期待/伏笔/信息推进：${plan.expectationAdvancement}`);
    lines.push(`章尾压力：${plan.chapterEndPressure}`);
    lines.push(`群像分工：${plan.ensembleRoles}`);
    if (plan.inviolableFacts.length > 0) {
      lines.push(`不可破坏的事实：${plan.inviolableFacts.join("；")}`);
    }
    return lines.join("\n");
  }
}

function routeForKind(kind: CandidateKind): string {
  switch (kind) {
    case "direct_baseline":
      return "v2_direct_gpt";
    case "context_enhanced":
      return "v2_rawstage2";
    case "scene_contract":
      return "v2_amplified";
    case "editorial_amplified":
      // editorial_amplified 复用 v2_amplified 路由（Doubao），
      // 通过 classifyCandidateSource 归入 amplified source，流经 clearWin。
      // （实际多变体展开在 generate 循环中处理，不经此单 route 函数。）
      return "v2_amplified";
    case "style_aware":
      return "v2_direct_claude";
    case "model_variant":
      return "v2_direct_gpt";
    default:
      return "v2_direct_gpt";
  }
}

export function createCandidateGenerator(): CandidateGenerator {
  return new CandidateGenerator();
}

// ============================================================================
// 工具：基于 contextHash + kind 生成稳定 candidate id（测试用）
// ============================================================================

export function stableCandidateId(contextHash: string, kind: CandidateKind, route: string): string {
  const hash = createHash("sha256")
    .update(`${contextHash}:${kind}:${route}`)
    .digest("hex")
    .slice(0, 12);
  return `candidate:${kind}:${route}:${hash}`;
}
