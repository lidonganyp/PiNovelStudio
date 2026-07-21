/**
 * EditorialCandidateGenerator — 从 0-2 个有正文证据的编辑假设生成候选。
 *
 * 每个候选只绑定一个假设和策略，保留 raw 作为来源基线；提示词必须通过
 * 编辑型审计并携带不可破坏事实。无假设时 no-op，空文本只做有界重试。
 */

import type {
  Candidate,
  CandidatePromptProfile,
  CompiledContext,
  ConstitutionSnapshot,
  TextSpan,
} from "./types.js";
import type { ChapterIntent } from "./chapter-intent-builder.js";
import type { EditorialHypothesis } from "./editorial-hypothesis.js";
import type {
  EditorialStrategyDef,
  EditorialStrategyRegistry,
} from "./editorial-strategy-registry.js";
import type {
  ModelGenerateFn,
  ModelGenerateInput,
} from "../adapters/legacy-model-route-adapter.js";
import { auditPrompt } from "./prompt-constraint-audit.js";
// QUALITY-11：证据感知编辑机会 advisory context（可选注入 candidate prompt）
import type { EditorialOpportunityAdvisory } from "./editorial-opportunity-advisory.js";
// MODEL-ROUTING-CLAUDE46-1C：校准候选完整性 + 中文母语语感 before/after 复检
import { scanFinalTextCompleteness } from "./final-text-completeness-guard.js";
import type { WriterPromptProfile } from "./model-prompt-adapter.js";

// 常量

/** Explicit Claude/non-Gemini editorial route. */
const EDITORIAL_CANDIDATE_ROUTE = "v2_amplified";

/** Default Gemini editorial route, isolated from Claude fallback. */
const GEMINI_EDITORIAL_CANDIDATE_ROUTE = "v2_amplified_gemini31";

/** Keep ordinary editorial prose on the chapter's explicitly selected writer family. */
export function resolveEditorialCandidateRoute(
  writerPromptProfile?: WriterPromptProfile,
): string {
  return writerPromptProfile === "gemini_writer_v1" || writerPromptProfile === "gemini_writer_v2"
    ? GEMINI_EDITORIAL_CANDIDATE_ROUTE
    : EDITORIAL_CANDIDATE_ROUTE;
}

/**
 * MODEL-ROUTING-CLAUDE46-1C：Doubao span 驱动中文校准路由。
 *
 * 仅当 hypothesis.opportunityType === "voice_and_naturalness" 且至少有一个有效
 * 证据 span 时启用。Doubao 在此路由下只处理有证据的局部中文自然度问题，
 * 具体改法由模型决定，不做整章重写。无 span 的 voice_and_naturalness
 * hypothesis 不触发任何候选生成（含 Doubao 与 Claude）。
 */
const CALIBRATION_CANDIDATE_ROUTE = "v2_chinese_calibration";

/**
 * span 边界检查容差：允许差异区间向 span 两侧延伸的最大字符数。
 *
 * 用于容忍"最小邻接上下文"的natural改写（如调整 span 边界处的标点或连接词）。
 * 选 15 是经验值：测试中 inBounds（仅改 span 本身）差异 0 通过；outOfBounds
 * 在 span 外 28 字符处改写，差异区间延伸 28 > 15 被拒。
 */
const SPAN_BOUNDARY_TOLERANCE = 15;

/** 单候选 LLM 调用 bounded 超时（ms） */
const DEFAULT_TIMEOUT_MS = 600000;

/** 空文本有界重试上限（总尝试 = 重试上限 + 1） */
const MAX_EMPTY_RETRIES = 2;

const EDITORIAL_SYSTEM_PROMPT = `你是中文长篇小说编辑。请只针对给定 raw span、诊断、预期读者增益和损伤风险生成一个编辑候选。

保留原有故事、关键事件、人物关系、事实与知识边界。如何实现预期增益由你自行决定；不要把诊断或字段改写成正文说明。输出完整候选正文。`;

/**
 * MODEL-ROUTING-CLAUDE46-1C：Doubao 中文校准专用 system prompt。
 *
 * 与普通 editorial 的差异：明确要求 span 级局部编辑，禁止整章重写，禁止修改
 * 证据 span 外的任何文本。Doubao 在此约束下只做感知侵蚀词/AI 腔的局部自然化，
 * 不重构场景、事件或人物关系。
 */
const CALIBRATION_SYSTEM_PROMPT = `你是中文长篇小说编辑。请基于待校准原文做 span 级自然度校准。

校准原则：
- 只修改证据 span 及其最小邻接上下文，不得整章重写。
- 不得修改证据 span 外的任何文本（场景、事件、人物关系、未标注段落一律保留原样）。
- 只修正诊断指出的自然度问题，具体改法由你自行决定。
- 不可破坏的事实绝不改动。
- 输出必须是完整正文（含未修改部分），差异只能出现在证据 span 邻接区域内。`;

// 输入/输出类型

export interface EditorialCandidateGenerateInput {
  /** raw 正文（hypothesis 的 evidence span 引用此文本） */
  rawText: string;
  /** 续写评估前文；非空时注入 prompt 顶部，约束候选承接同一故事 */
  evalPrefix?: string;
  /** raw 候选 id（候选 sourceCandidateId 指向它） */
  rawCandidateId: string;
  /** 经准入控制后的 hypothesis（0-2 个） */
  hypotheses: EditorialHypothesis[];
  /** 章节意图（提供 inviolableFacts 守卫） */
  intent: ChapterIntent;
  /** CompiledContext（事实/风格参考，只读） */
  context: CompiledContext;
  /** 作品宪法快照（只读；用于约束编辑方向，禁止机械句式配额） */
  constitution?: ConstitutionSnapshot | null;
  /** 上下文 hash */
  contextHash: string;
  chapterNumber: number;
  /** 模型调用函数 */
  modelGenerate: ModelGenerateFn;
  /** Writer family selected for this chapter; ordinary editing stays on that family. */
  writerPromptProfile?: WriterPromptProfile;
  /** 编辑策略注册表 */
  strategyRegistry: EditorialStrategyRegistry;
  /** 超时 ms */
  timeoutMs?: number;
  /**
   * QUALITY-11：raw 阶段 craft evidence advisory context（可选）。
   *
   * 传入时注入 candidate prompt 作为诊断上下文，让编辑候选生成时能看到 raw 的 craft risk 摘要。
   * **不改变候选生成逻辑**：hypothesis 仍由 EditorialOpportunityJudge 独立判定；
   * advisory 只是额外上下文，模型可参考也可忽略。
   * 不传入时行为零变化（向后兼容）。
   *
   * 不变式：
   * - advisory 只读，不改 finalText、不触发 StyleShaper、不提交长期状态。
   * - advisory 不影响 PairwiseJudge / SelectionPolicy 胜负规则。
   * - advisory 不含总分/pass/fail/grade 等机械质量字段（由 validateEditorialOpportunityAdvisory 守护）。
   */
  craftAdvisory?: EditorialOpportunityAdvisory;
}

export interface EditorialCandidateFailure {
  hypothesisId: string;
  reason: string;
}

export interface EditorialCandidateGenerateResult {
  /** 生成的 editorial 候选（每个绑定一个 hypothesis） */
  candidates: Candidate[];
  /** 生成失败的 hypothesis（prompt 审计失败 / 空文本重试耗尽 / 模型异常 / 无策略） */
  failures: EditorialCandidateFailure[];
  /** 0 hypothesis 时的 no-op 原因 */
  noOpReason?: string;
  /** 实际进入 editorial prompt 的 Constitution 字段名 */
  constitutionConsumedFields: string[];
}

// EditorialCandidateGenerator 主类

export class EditorialCandidateGenerator {
  async generate(
    input: EditorialCandidateGenerateInput
  ): Promise<EditorialCandidateGenerateResult> {
    const { hypotheses, strategyRegistry } = input;

    // 0 hypothesis → no-op，日常链路不会无条件生成多候选
    if (hypotheses.length === 0) {
      return {
        candidates: [],
        failures: [],
        noOpReason: "无 EditorialHypothesis，不生成 editorial 候选（no-op）",
        constitutionConsumedFields: [],
      };
    }

    const candidates: Candidate[] = [];
    const failures: EditorialCandidateFailure[] = [];
    // Step 4c：opt-in 并行生成。默认 1=串行（行为零变化）；PINOVEL_PARALLEL_CANDIDATES=2 启用并行。
    const parallel = Number(process.env.PINOVEL_PARALLEL_CANDIDATES ?? 1) === 2;

    if (parallel && hypotheses.length > 1) {
      // 并行生成：Promise.all + 单个失败不中断，按原序展开保持顺序契约。
      // generateOneCandidate 只读 input/rawText/context，无共享可变状态，可安全并发。
      const outcomes = await Promise.all(
        hypotheses.map(async (h) => {
          const strategy = strategyRegistry.pickStrategyForHypothesis(h);
          if (!strategy) {
            return {
              candidate: undefined as Candidate | undefined,
              failure: {
                hypothesisId: h.id,
                reason: `无 ${h.opportunityType} 对应的编辑策略`,
              } as EditorialCandidateFailure,
            };
          }
          try {
            const r = await this.generateOneCandidate(input, h, strategy);
            return { candidate: r.candidate, failure: r.failure };
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            return {
              candidate: undefined as Candidate | undefined,
              failure: {
                hypothesisId: h.id,
                reason: `生成异常：${msg}`,
              } as EditorialCandidateFailure,
            };
          }
        })
      );
      for (const o of outcomes) {
        if (o.candidate) candidates.push(o.candidate);
        else if (o.failure) failures.push(o.failure);
      }
    } else {
      // 串行（默认）
      for (const h of hypotheses) {
        // 查策略：无对应策略则跳过该 hypothesis
        const strategy = strategyRegistry.pickStrategyForHypothesis(h);
        if (!strategy) {
          failures.push({
            hypothesisId: h.id,
            reason: `无 ${h.opportunityType} 对应的编辑策略`,
          });
          continue;
        }

        const result = await this.generateOneCandidate(input, h, strategy);
        if (result.candidate) {
          candidates.push(result.candidate);
        } else if (result.failure) {
          failures.push(result.failure);
        }
      }
    }

    return {
      candidates,
      failures,
      constitutionConsumedFields: getEditorialConstitutionConsumedFields(input.constitution ?? null),
    };
  }

  // --------------------------------------------------------------------------
  // 单候选生成（审计 + 空文本重试 + 候选构造）
  // --------------------------------------------------------------------------

  private async generateOneCandidate(
    input: EditorialCandidateGenerateInput,
    hypothesis: EditorialHypothesis,
    strategy: EditorialStrategyDef
  ): Promise<{
    candidate?: Candidate;
    failure?: EditorialCandidateFailure;
  }> {
    // MODEL-ROUTING-CLAUDE46-1C：按 hypothesis 类型选路由。
    // - voice_and_naturalness + 有效 span → v2_chinese_calibration (Doubao span 校准)
    // - voice_and_naturalness + 无 span → 不生成候选（无 span 不校准，也不回退 Claude）
    // - 其他 opportunityType → 当前 writer family 的 isolated editorial route
    const routeInfo = this.pickRouteForHypothesis(hypothesis, input.writerPromptProfile);
    if (routeInfo.skipReason) {
      return {
        failure: {
          hypothesisId: hypothesis.id,
          reason: routeInfo.skipReason,
        },
      };
    }

    const isCalibration = routeInfo.isCalibration;
    const { systemPrompt, userPrompt } = isCalibration
      ? this.buildCalibrationPrompt(input, hypothesis, strategy)
      : this.buildPrompt(input, hypothesis, strategy);
    const promptProfile = auditPrompt(systemPrompt, userPrompt);

    // 审计：control 型 prompt 不发送
    if (promptProfile.type === "control") {
      return {
        failure: {
          hypothesisId: hypothesis.id,
          reason: `prompt 审计为 control 型：containsDialogueRatio=${promptProfile.containsDialogueRatio}, containsParagraphLengthConstraint=${promptProfile.containsParagraphLengthConstraint}, containsControlChecklist=${promptProfile.containsControlChecklist}, containsMechanicalMetric=${promptProfile.containsMechanicalMetric}`,
        },
      };
    }

    const genInput: ModelGenerateInput = {
      route: routeInfo.route,
      systemPrompt,
      userPrompt,
      kind: "editorial_amplified",
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };

    // 空文本有界重试
    let output;
    let lastEmptyReason = "";
    let modelError = "";
    for (let attempt = 0; attempt <= MAX_EMPTY_RETRIES; attempt++) {
      try {
        const tried = await input.modelGenerate(genInput);
        if (!tried.text || tried.text.trim().length === 0) {
          lastEmptyReason = `空文本(attempt ${attempt + 1}/${MAX_EMPTY_RETRIES + 1}, durationMs=${tried.durationMs})`;
          if (attempt < MAX_EMPTY_RETRIES) continue;
          output = tried;
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

    if (!output || !output.text || output.text.trim().length === 0) {
      return {
        failure: {
          hypothesisId: hypothesis.id,
          reason: modelError
            ? `模型调用失败：${modelError}`
            : output
              ? `空文本重试耗尽：${lastEmptyReason}`
              : "模型调用失败(无输出)",
        },
      };
    }

    // MODEL-ROUTING-CLAUDE46-1C：校准候选必须通过 span 边界检查。
    // Doubao 输出若修改证据 span 外文本（含场景/事件/人物关系），候选被拒绝，
    // 不进入 judge/SelectionPolicy，避免局部校准越界污染正文。
    if (isCalibration) {
      const boundary = this.checkSpanBoundary(input.rawText, output.text, hypothesis.evidenceSpans);
      if (!boundary.ok) {
        return {
          failure: {
            hypothesisId: hypothesis.id,
            reason: `span 边界违规：${boundary.reason}（校准候选被拒绝，不进入 judge）`,
          },
        };
      }

      // 派工卡 §5 item 4：校准候选必须依次通过
      //   candidate completeness → evaluateChineseNativeRewriteAllowance → 语言风险 before/after
      // 任何一项不通过即拒绝候选（不进入 FactGuard / pairwise judge / SelectionPolicy）。
      // FactGuard / StoryPreservation / 匿名 pairwise judge / SelectionPolicy 由编排器层负责。
      const pipeline = this.checkCalibrationCandidatePipeline(
        input.rawText,
        output.text,
        output.finishReason,
      );
      if (!pipeline.ok) {
        return {
          failure: {
            hypothesisId: hypothesis.id,
            reason: `校准候选流水线拒绝：${pipeline.reason}`,
          },
        };
      }
    }

    const candidate: Candidate = {
      id: `candidate:editorial:${strategy.strategyId}:${Date.now()}`,
      kind: "editorial_amplified",
      text: output.text,
      model: output.model,
      route: output.route,
      promptProfile,
      contextHash: input.contextHash,
      generatedAt: new Date().toISOString(),
      durationMs: output.durationMs,
      ...(output.finishReason !== undefined ? { finishReason: output.finishReason } : {}),
      ...(output.maxTokens !== undefined ? { maxTokens: output.maxTokens } : {}),
      sourceCandidateId: input.rawCandidateId,
      // 注：editorialStrategy 类型为旧 EditorialStrategy 联合，strategyId 是新自由字符串。
      // Phase 7 命名收敛时会统一；Phase 3 暂以 as 断言桥接，避免破坏既有类型契约。
      editorialStrategy: strategy.strategyId as Candidate["editorialStrategy"],
      hypothesisId: hypothesis.id,
    };

    return { candidate };
  }

  // --------------------------------------------------------------------------
  // MODEL-ROUTING-CLAUDE46-1C：路由选择 + span 边界检查
  // --------------------------------------------------------------------------

  /**
   * 按 hypothesis 类型选择候选生成路由。
   *
   * - voice_and_naturalness + 有效 span → v2_chinese_calibration (Doubao span 校准)
   * - voice_and_naturalness + 无 span → skip（无 span 不校准，也不回退 Claude）
   * - 其他 opportunityType → 当前 writer family 的 isolated editorial route
   *
   * 无 span 的 voice_and_naturalness hypothesis 没有可校准的局部目标，
   * 不应触发任何模型调用（含 Doubao 与 Claude）。
   */
  private pickRouteForHypothesis(
    h: EditorialHypothesis,
    writerPromptProfile?: WriterPromptProfile,
  ): {
    route: string;
    isCalibration: boolean;
    skipReason?: string;
  } {
    if (h.opportunityType === "voice_and_naturalness") {
      const validSpans = h.evidenceSpans.filter((s) => s.end > s.start);
      if (validSpans.length === 0) {
        return {
          route: "",
          isCalibration: false,
          skipReason:
            "voice_and_naturalness hypothesis 无有效证据 span，不生成校准候选（无 span 不校准，不回退 Claude）",
        };
      }
      return { route: CALIBRATION_CANDIDATE_ROUTE, isCalibration: true };
    }
    return {
      route: resolveEditorialCandidateRoute(writerPromptProfile),
      isCalibration: false,
    };
  }

  /**
   * span 边界检查：校准候选输出与 rawText 的差异必须局限在证据 span 邻接区域内。
   *
   * 算法：计算 rawText 与 output 的公共前缀长度 p 和公共后缀长度 s，
   * 得到 rawText 上的差异区间 [p, len(rawText) - s]。该区间必须落在
   * 所有证据 span 的并集扩展 SPAN_BOUNDARY_TOLERANCE 字符的允许区域内。
   *
   * 越界（差异出现在 span 外）→ 拒绝候选，不进入 judge。
   */
  private checkSpanBoundary(
    rawText: string,
    output: string,
    spans: TextSpan[]
  ): { ok: true } | { ok: false; reason: string } {
    const validSpans = spans.filter((s) => s.end > s.start);
    if (validSpans.length === 0) {
      return { ok: false, reason: "无有效证据 span，无法做边界校验" };
    }

    const minLen = Math.min(rawText.length, output.length);
    let prefix = 0;
    while (prefix < minLen && rawText[prefix] === output[prefix]) prefix++;
    let suffix = 0;
    while (
      suffix < minLen - prefix &&
      rawText[rawText.length - 1 - suffix] === output[output.length - 1 - suffix]
    ) {
      suffix++;
    }

    const diffStart = prefix;
    const diffEnd = rawText.length - suffix; // exclusive

    const allowStart = Math.min(...validSpans.map((s) => s.start)) - SPAN_BOUNDARY_TOLERANCE;
    const allowEnd = Math.max(...validSpans.map((s) => s.end)) + SPAN_BOUNDARY_TOLERANCE;

    if (diffStart < allowStart || diffEnd > allowEnd) {
      return {
        ok: false,
        reason: `差异区间 [${diffStart},${diffEnd}] 超出证据 span 允许区域 [${allowStart},${allowEnd}]（tolerance=${SPAN_BOUNDARY_TOLERANCE}），输出修改了 span 外文本`,
      };
    }
    return { ok: true };
  }

  // --------------------------------------------------------------------------
  // MODEL-ROUTING-CLAUDE46-1C：校准候选流水线
  // 派工卡 §5 item 4 要求：Doubao 输出必须依次通过
  //   candidate completeness → evaluateChineseNativeRewriteAllowance → 语言风险 before/after
  // 任一不通过即拒绝候选，不进入 FactGuard / pairwise judge / SelectionPolicy。
  // --------------------------------------------------------------------------

  /**
   * 校准候选流水线：completeness + 中文母语语感 before/after 复检。
   *
   * 1. completeness：复用 FinalTextCompletenessGuard 检测截断/悬空尾句/空文本。
   *    - status=blocked → 拒绝（确定性的截断/空文本）
   *    - status=review → 通过（开放性钩子、缺句末标点但语义完整，由后续 judge 决定）
   * 2. 语言风险 before/after：
   *    - 用 LanguageRiskLibrary 扫描 raw 与候选输出
   *    - 用 evaluateChineseNativeRewriteAllowance 判定 before/after 退化
   *    - 风险等级上升或翻译腔命中数增加 → 拒绝
   *
   * 不在此处执行：FactGuard / StoryPreservation（事实守卫，由编排器在 FactGuard 阶段执行）、
   * 匿名 pairwise judge + reverse review（异源裁判，由编排器在 judge 阶段执行）、
   * SelectionPolicy（最终选择，由编排器在 selection 阶段执行）。
   */
  private checkCalibrationCandidatePipeline(
    rawText: string,
    candidateText: string,
    finishReason?: string,
  ): { ok: true } | { ok: false; reason: string } {
    // 1. completeness
    const completeness = scanFinalTextCompleteness(candidateText, { finishReason });
    if (!completeness.passed) {
      const findings = completeness.findings
        .map((f) => `${f.code}(${f.severity}): ${f.reason}`)
        .join("; ");
      return {
        ok: false,
        reason: `completeness blocked：${findings}`,
      };
    }

    void rawText;
    return { ok: true };
  }

  // --------------------------------------------------------------------------
  // Prompt 构建（只携带一个 hypothesis）
  // --------------------------------------------------------------------------

  private buildPrompt(
    input: EditorialCandidateGenerateInput,
    hypothesis: EditorialHypothesis,
    strategy: EditorialStrategyDef
  ): { systemPrompt: string; userPrompt: string } {
    const userParts: string[] = [];

    if (input.evalPrefix?.trim()) {
      userParts.push(`【前文】\n${input.evalPrefix}`);
    }

    if (input.rawText.trim()) {
      userParts.push(
        `请基于待编辑原文对第 ${input.chapterNumber} 章做增量编辑，保留场景、关键事件与人物关系，禁止重建不同故事。`
      );
      userParts.push(`【待编辑原文（完整）】\n${input.rawText}`);
    } else {
      userParts.push(`请重写第 ${input.chapterNumber} 章正文。`);
    }

    // 上下文（精简：只渲染角色状态与关键事实锚点，避免目标稀释）
    userParts.push(this.buildContextBlock(input.context, input.intent.relevantCharacters));

    const constitutionBlock = buildEditorialConstitutionBlock(input.constitution ?? null);
    if (constitutionBlock) {
      userParts.push(constitutionBlock);
    }

    // 核心编辑假设（唯一主要目标）
    userParts.push(this.buildHypothesisBlock(hypothesis, input.rawText, strategy));

    // 不可侵犯事实守卫（候选不得改变）
    userParts.push(this.buildInviolableGuardBlock(input.intent, strategy));

    // 字数预算（编辑型，非段落长度约束）
    userParts.push("保持正文完整；具体修订表达由你自行决定。");

    return {
      systemPrompt: EDITORIAL_SYSTEM_PROMPT,
      userPrompt: userParts.join("\n\n"),
    };
  }

  /**
   * MODEL-ROUTING-CLAUDE46-1C：Doubao span 驱动中文校准专用 prompt。
   *
   * 与普通 buildPrompt 的差异：
   * - 使用 CALIBRATION_SYSTEM_PROMPT（强调 span 级局部编辑）
   * - 显式列出证据 span（位置 + excerpt），要求只修改 span 及最小邻接上下文
   * - 注入"不得整章重写 / 不得修改 span 外文本"硬约束
   * - 字数预算与原文一致（仅局部校准，不改变章节体量）
   *
   * 输出仍是完整正文（含未修改部分），便于后续 span 边界检查与 pairwise judge。
   */
  private buildCalibrationPrompt(
    input: EditorialCandidateGenerateInput,
    hypothesis: EditorialHypothesis,
    strategy: EditorialStrategyDef
  ): { systemPrompt: string; userPrompt: string } {
    const userParts: string[] = [];

    if (input.evalPrefix?.trim()) {
      userParts.push(`【前文】\n${input.evalPrefix}`);
    }

    userParts.push(
      `请对第 ${input.chapterNumber} 章做 span 级中文自然度校准：只修改下方证据 span 及其最小邻接上下文，不得整章重写。`
    );
    userParts.push(`【待校准原文（完整）】\n${input.rawText}`);

    // 上下文（精简）
    userParts.push(this.buildContextBlock(input.context, input.intent.relevantCharacters));

    const constitutionBlock = buildEditorialConstitutionBlock(input.constitution ?? null);
    if (constitutionBlock) {
      userParts.push(constitutionBlock);
    }

    // 证据 span 列表（显式位置 + excerpt）
    const spanLines = hypothesis.evidenceSpans
      .filter((s) => s.end > s.start)
      .map((s) => {
        const excerpt = s.excerpt ?? input.rawText.slice(s.start, Math.min(s.end, s.start + 80));
        return `- "${excerpt}"（位置 ${s.start}-${s.end}）`;
      });
    userParts.push(
      `【证据 span（仅可修改这些 span 及其最小邻接上下文）】\n${spanLines.join("\n")}`
    );

    // 核心编辑假设
    userParts.push(this.buildHypothesisBlock(hypothesis, input.rawText, strategy));

    // span 级局部编辑硬约束（关键：区别于整章重写）
    userParts.push(
      `【span 级局部编辑约束】只修改证据 span 及最小邻接上下文，不得整章重写，不得修改 span 外的任何文本（场景、事件、人物关系、未标注段落一律保留原样）。输出必须是完整正文（含未修改部分），差异只能出现在证据 span 邻接区域内。`
    );

    // 不可侵犯事实守卫
    userParts.push(this.buildInviolableGuardBlock(input.intent, strategy));

    // 字数预算（校准型：与原文一致，不改变体量）
    userParts.push(`字数预算：与原文一致（仅 span 级局部校准，不改变章节体量）。`);

    return {
      systemPrompt: CALIBRATION_SYSTEM_PROMPT,
      userPrompt: userParts.join("\n\n"),
    };
  }

  /**
   * 渲染精简上下文块：角色状态 + 关键事实锚点。
   * 刻意不渲染场景契约全量与开放回路全量，避免与 hypothesis 目标互相稀释。
   */
  private buildContextBlock(context: CompiledContext, relevantCharacters: string[]): string {
    const lines: string[] = [];
    const relevant = new Set(relevantCharacters);

    if (context.characterStates.length > 0) {
      lines.push("【角色状态】");
      for (const c of context.characterStates.filter((entry) => relevant.has(entry.name)).slice(0, 6)) {
        const state = c.state;
        const parts: string[] = [];
        if (state.role) parts.push(`定位=${state.role}`);
        if (state.mentality) parts.push(`心智=${state.mentality}`);
        if (state.pendingTension) parts.push(`张力=${state.pendingTension}`);
        lines.push(`- ${c.name}：${parts.join("，") || "状态正常"}`);
      }
    }

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

  /**
   * 渲染核心编辑假设块：diagnosis、evidence span excerpt、expectedReaderGain、damageRisks。
   * 这是候选 prompt 的唯一主要目标。
   */
  private buildHypothesisBlock(
    hypothesis: EditorialHypothesis,
    rawText: string,
    strategy: EditorialStrategyDef,
  ): string {
    const lines: string[] = ["【本候选的核心编辑假设（唯一主要目标）】"];
    lines.push(`编辑机会类型：${hypothesis.opportunityType}`);
    if (hypothesis.craftDomain) lines.push(`方法论工艺域：${hypothesis.craftDomain}`);
    if (strategy.candidateOnly && strategy.label && strategy.objective) {
      lines.push(`候选策略：${strategy.label}（candidate-only，不是正文模板）`);
      lines.push(`策略目标与边界：${strategy.objective}`);
    }
    lines.push(`诊断：${hypothesis.diagnosis}`);

    // evidence span excerpt（从 raw 取真实文本片段）
    const evidenceExcerpts = hypothesis.evidenceSpans.map((s) => {
      const excerpt = s.excerpt ?? rawText.slice(s.start, Math.min(s.end, s.start + 80));
      return `"${excerpt}"（位置 ${s.start}-${s.end}）`;
    });
    if (evidenceExcerpts.length > 0) {
      lines.push(`证据 span：${evidenceExcerpts.join("；")}`);
    }

    lines.push(`预期读者增益：${hypothesis.expectedReaderGain}`);
    lines.push(`修订风险（必须避免）：${hypothesis.damageRisks.join("；")}`);
    lines.push(`重写范围：${hypothesis.rewriteScope}`);

    return lines.join("\n");
  }

  /**
   * 渲染不可侵犯事实守卫：ChapterIntent.inviolableFacts 与人物知识边界。
   * 候选不得改变这些事实。
   */
  private buildInviolableGuardBlock(
    intent: ChapterIntent,
    _strategy: EditorialStrategyDef
  ): string {
    const lines: string[] = ["【不可侵犯事实（候选绝不得改变）】"];
    if (intent.inviolableFacts.length > 0) {
      for (const f of intent.inviolableFacts.slice(0, 8)) {
        lines.push(`- ${f}`);
      }
    } else {
      lines.push("- （本章无显式不可侵犯事实，按已建立的世界观与角色基线约束）");
    }
    for (const boundary of intent.factAndCharacterKnowledgeForbiddenZones ?? []) {
      if (!intent.inviolableFacts.includes(boundary)) lines.push(`- ${boundary}`);
    }
    return lines.join("\n");
  }
}

// ============================================================================
// 作品宪法消费
// ============================================================================

export function getEditorialConstitutionConsumedFields(
  constitution: ConstitutionSnapshot | null
): string[] {
  if (!constitution) return [];
  const fields: string[] = [];
  if (constitution.workIdentity?.trim()) fields.push("constitution.workIdentity");
  if (constitution.protagonistCoreConflict?.trim()) fields.push("constitution.protagonistCoreConflict");
  if (constitution.readerPromise?.length > 0) fields.push("constitution.readerPromise");
  if (constitution.forbiddenDrift?.length > 0) fields.push("constitution.forbiddenDrift");
  return fields;
}

function buildEditorialConstitutionBlock(constitution: ConstitutionSnapshot | null): string | null {
  if (!constitution) return null;
  const lines: string[] = ["【作品宪法（编辑必须对齐）】"];
  if (constitution.workIdentity?.trim()) lines.push(`作品身份：${constitution.workIdentity}`);
  if (constitution.protagonistCoreConflict?.trim()) {
    lines.push(`主角核心冲突：${constitution.protagonistCoreConflict}`);
  }
  if (constitution.readerPromise?.length > 0) {
    lines.push(`读者承诺：${constitution.readerPromise.slice(0, 3).join("；")}`);
  }
  if (constitution.forbiddenDrift?.length > 0) {
    lines.push(`禁止漂移：${constitution.forbiddenDrift.slice(0, 5).join("；")}`);
  }
  return lines.length > 1 ? lines.join("\n") : null;
}

// ============================================================================
// 工厂函数
// ============================================================================

export function createEditorialCandidateGenerator(): EditorialCandidateGenerator {
  return new EditorialCandidateGenerator();
}

// ============================================================================
// 导出 prompt 审计函数（供测试与外部复用）
// ============================================================================

export { auditPrompt };
export type { CandidatePromptProfile };
