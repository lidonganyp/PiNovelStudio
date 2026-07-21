/**
 * EditorialOpportunityJudge — 编辑机会判断器（Phase 3，计划 §Phase 3）
 *
 * 读取 raw 正文、章节意图（ChapterIntent）和相关长期状态，识别 raw 上
 * "可引用 span 证明"的编辑机会，输出 0-2 个 EditorialHypothesis。
 *
 * 设计原则（计划 §Phase 3 + §4.4 + §5 + §P1-9）：
 * - 没有 span 的机会只能当备注，不能触发候选（validateHypothesis 强制）
 * - 无机会返回 no-op（hypotheses 为空 + noOpReason），日常链路不会无条件生成多候选
 * - 最多 2 个 hypothesis（selectHypothesesForCandidates 强制，且 opportunityType 互不冲突）
 * - 所有 span 必须真实存在于 rawText（validateHypothesis 越界校验）
 * - P1-9：LLM 结构化判断为主导（1 次判断 + 最多 1 次 schema-only 修复），本地扫描器只提供诊断证据；
 *   LLM 失败/parse 失败/span 无效时保留 raw，不得由机械阈值授权候选
 * - hypothesis 的 damageRisks 必须评估修订可能造成的损伤
 *
 * 本地扫描器（只产生 trace signal，不产生 hypothesis）：
 *   1. scanChapterEndPressure   — 章末钩子弱 → chapter_end_pressure
 *   2. scanAgencyDensity        — 主角行动词密度过低 → character_choice
 *   3. scanPerceptionErosion    — 感知侵蚀词过多 → voice_and_naturalness
 *   4. scanPromisePayoff        — 开放承诺被提及但落点过轻 → reader_payoff / promise_advancement
 *   5. scanInfoDump             — 大段信息倾泻 → information_dramatization
 *   6. scanEnsemble             — 次要角色功能扁平 → ensemble_function
 *
 * 这些阈值只帮助定位可能值得复核的区域，不能决定是否改文。
 */

import type { TextSpan } from "./types.js";
import type { ChapterIntent } from "./chapter-intent-builder.js";
import type { CompiledContext, LongTermStateSnapshot, ConstitutionSnapshot } from "./types.js";
import {
  type EditorialHypothesis,
  type EditorialOpportunityType,
  type RewriteScope,
  selectHypothesesForCandidates,
} from "./editorial-hypothesis.js";
import {
  extractEndingRegion,
  hasWebnovelHookSignal,
  extractPerceptionMarkers,
} from "./narrative-signal-extractor.js";
import { detectAgencyActions } from "./language-risk-library.js";
import type {
  ModelGenerateFn,
  ModelGenerateInput,
} from "../adapters/legacy-model-route-adapter.js";
// QUALITY-11：证据感知编辑机会 advisory context（可选注入 LLM prompt，不改变机会判定逻辑）
import type { EditorialOpportunityAdvisory } from "./editorial-opportunity-advisory.js";
import { localizeLlmText, locateLlmExcerpt } from "../../utils/llm-language-guard.js";
import {
  buildCraftPhenomenonReport,
  skippedCraftPhenomenonReport,
  type CraftPhenomenonReport,
} from "./craft-phenomenon-report.js";
import type { VoiceFingerprintInput } from "./dialogue-craft-compiler.js";
import {
  buildOpportunityPrompt,
  buildOpportunitySchemaRepairPrompt,
  parseOpportunityVerdict,
  type ParsedOpportunityVerdict,
} from "./editorial-opportunity-contract.js";
import {
  collectMethodologyDiagnosticSourceRefs,
  type MethodologyDiagnosticState,
} from "./methodology-diagnostic-state.js";

// ============================================================================
// 输入/输出类型
// ============================================================================

export interface OpportunityJudgeInput {
  /** raw 正文（编辑机会的扫描对象） */
  rawText: string;
  /** raw candidate id used to anchor the post-raw methodology report. */
  rawCandidateId?: string;
  /** 章节意图（ChapterIntentBuilder 输出） */
  intent: ChapterIntent;
  /** 长期状态快照（可空） */
  longTermState: LongTermStateSnapshot | null;
  /** 作品宪法快照（可空） */
  constitution: ConstitutionSnapshot | null;
  /** Compiled story state used only for post-raw diagnosis. */
  context?: CompiledContext;
  /** Accepted-text voice evidence for post-raw drift diagnosis only. */
  voiceFingerprints?: VoiceFingerprintInput[];
  /** Previous accepted ending emotion for post-raw transition diagnosis only. */
  previousEmotionState?: string | null;
  /** Compact accepted-state evidence, visible only to the post-raw judge. */
  methodologyDiagnosticState?: MethodologyDiagnosticState;
  /** 本章已知角色名（用于 ensemble 扫描） */
  characterNames: string[];
  /**
   * P1-9：模型调用函数。传入时启用 LLM 结构化判断为主导（判断 + 最多一次 schema 修复），
   * 本地扫描器降为证据提供者；LLM 失败时保留 raw。
   * 不传入时只运行本地诊断，不产生编辑候选。
   */
  modelGenerate?: ModelGenerateFn;
  /** 随机种子（可复现，透传给 LLM 调用） */
  seed?: number;
  /** 单次 LLM 调用超时 ms */
  timeoutMs?: number;
  /**
   * QUALITY-11：raw 阶段 craft evidence advisory context（可选）。
   *
   * 传入时注入 LLM prompt 作为诊断上下文，让 LLM judge 能看到 raw 的 craft risk 摘要。
   * **不改变机会判定逻辑**：本地扫描器仍照常运行，准入控制仍照常过滤；
   * advisory 只是额外上下文，LLM 可参考也可忽略。
   * 不传入时行为零变化（向后兼容）。
   */
  craftAdvisory?: EditorialOpportunityAdvisory;
}

export interface ScannedSignal {
  opportunityType: EditorialOpportunityType;
  triggered: boolean;
  evidenceSpanCount: number;
  reason: string;
}

export interface OpportunityJudgeResult {
  /** 经 selectHypothesesForCandidates 准入后的 hypothesis（0-2 个） */
  hypotheses: EditorialHypothesis[];
  /** 被准入控制拒绝的 hypothesis（超上限或类型冲突） */
  rejected: EditorialHypothesis[];
  /** 拒绝原因 */
  rejectReasons: string[];
  /** 无机会时的 no-op 原因（hypotheses 为空时设置） */
  noOpReason?: string;
  /** 各扫描器的命中情况（供 trace 审计） */
  scannedSignals: ScannedSignal[];
  /** P1-9：是否由 LLM 主导判断（true=LLM 成功；false=本地模式或 LLM 降级） */
  llmJudged: boolean;
  /** P1-9：LLM 降级原因（LLM 失败时记录，供 trace 审计） */
  llmFallbackReason?: string;
  /** Post-raw methodology observations; advisory only. */
  craftPhenomenonReport: CraftPhenomenonReport;
  /** Number of schema-only repair calls; never rewrites chapter prose. */
  schemaRepairAttempts: number;
}

interface OpportunityLlmAttemptResult {
  result: OpportunityJudgeResult | null;
  schemaRepairAttempts: number;
}

// ============================================================================
// 阈值常量
// ============================================================================

/** 章末区域长度（与 extractEndingRegion 一致） */
const ENDING_REGION_LEN = 600;

/** 主角行动词密度门槛：每千字低于此值视为行动稀疏（character_choice 触发） */
const AGENCY_DENSITY_PER_1K = 1.5;

/** 感知侵蚀词绝对门槛：全文命中数 ≥ 此值视为感知侵蚀过重 */
const PERCEPTION_THRESHOLD = 3;

/** 信息倾泻段落门槛：单段 > 此字符数且无对白/动作视为倾泻 */
const INFO_DUMP_PARAGRAPH_LEN = 200;

/** 承诺被提及但落点过轻：raw 中提及次数 < 此值视为落点过轻 */
const PROMISE_LIGHT_MENTION = 2;

/** ensemble 触发：relevantCharacters ≥ 此值但 raw 中有对白互动的角色 < 此值-1 */
const ENSEMBLE_MIN_RELEVANT = 3;

/** P1-9：编辑机会 LLM 裁判路由（model-routing.json v2_opportunity_judge） */
const OPPORTUNITY_LLM_ROUTE = "v2_opportunity_judge";

/** P1-9：编辑机会 LLM 调用 bounded 超时（ms） */
const DEFAULT_OPPORTUNITY_TIMEOUT_MS = 120000;

// ============================================================================
// EditorialOpportunityJudge 主类
// ============================================================================

export class EditorialOpportunityJudge {
  /**
   * 判断 raw 正文上的编辑机会（P1-9：LLM 主导，本地降级）。
   *
   * 流程：
   * 1. 始终运行 6 个本地扫描器，只产出 scannedSignals（诊断证据）
   * 2. 若传入 modelGenerate：LLM 结构化判断为主导（判断 + 最多一次 schema-only 修复）
   *    - LLM 返回 0-2 个机会，每个必须引用 raw 中真实存在的 evidenceExcerpt
   *    - span 强制：excerpt 在 raw 中定位失败的机会被丢弃
   *    - LLM 失败/parse 失败 → 保留 raw，本地阈值不得授权候选
   * 3. 未传入 modelGenerate：只返回本地诊断信号，不生成候选
   * 4. 准入控制：最多 2 个，opportunityType 互不冲突，校验 span
   */
  async judge(input: OpportunityJudgeInput): Promise<OpportunityJudgeResult> {
    const { rawText, intent } = input;
    // Step 4a：默认最多 1 个候选；评测时 PINOVEL_MAX_HYPOTHESES=2 恢复 2 候选。
    const maxHypotheses = Number(process.env.PINOVEL_MAX_HYPOTHESES ?? 1);
    const scannedSignals: ScannedSignal[] = [];

    if (!rawText || rawText.trim().length === 0) {
      return {
        hypotheses: [],
        rejected: [],
        rejectReasons: [],
        noOpReason: "raw 正文为空，无可扫描的编辑机会",
        scannedSignals: [],
        llmJudged: false,
        craftPhenomenonReport: skippedCraftPhenomenonReport(
          "raw 正文为空",
          input.rawCandidateId ?? "candidate:raw:unknown",
        ),
        schemaRepairAttempts: 0,
      };
    }

    // 1. 章末钩子
    scannedSignals.push(this.scanChapterEndPressure(rawText));

    // 2. 主角行动密度
    scannedSignals.push(this.scanAgencyDensity(rawText));

    // 3. 感知侵蚀
    scannedSignals.push(this.scanPerceptionErosion(rawText));

    // 4. 承诺兑现落点
    scannedSignals.push(this.scanPromisePayoff(rawText, intent, input.longTermState));

    // 5. 信息倾泻
    scannedSignals.push(this.scanInfoDump(rawText));

    // 6. 群像功能
    scannedSignals.push(this.scanEnsemble(rawText, intent, input.characterNames));

    // P1-9：LLM 主导判断（传入 modelGenerate 时）
    let failedSchemaRepairAttempts = 0;
    if (input.modelGenerate) {
      const llmAttempt = await this.judgeWithLLM(input, rawText, scannedSignals, maxHypotheses);
      failedSchemaRepairAttempts = llmAttempt.schemaRepairAttempts;
      if (llmAttempt.result !== null) {
        return llmAttempt.result; // LLM 成功，使用其判断
      }
      // LLM 失败时保留 raw；机械扫描只提供诊断，不能升级为编辑授权。
    }

    const triggered = scannedSignals.filter((signal) => signal.triggered);
    const noOpReason = triggered.length > 0
      ? `识别到 ${triggered.length} 个本地诊断信号，但诊断信号不能独立授权候选，保留 raw`
      : "raw 无可引用 span 证明的编辑机会，返回 no-op";

    return {
      hypotheses: [],
      rejected: [],
      rejectReasons: [],
      noOpReason,
      scannedSignals,
      llmJudged: false,
      llmFallbackReason: input.modelGenerate ? "LLM 调用/解析失败；本地信号仅作诊断，保留 raw" : undefined,
      craftPhenomenonReport: skippedCraftPhenomenonReport(
        input.modelGenerate ? "opportunity judge schema repair exhausted" : "未提供 opportunity judge 模型",
        input.rawCandidateId ?? "candidate:raw:unknown",
      ),
      schemaRepairAttempts: failedSchemaRepairAttempts,
    };
  }

  // --------------------------------------------------------------------------
  // P1-9：LLM 结构化判断（主导）
  // --------------------------------------------------------------------------

  /**
   * 用 LLM 结构化调用判断编辑机会。成功返回 OpportunityJudgeResult；失败返回 null（降级）。
   *
   * span 强制：LLM 返回的 evidenceExcerpt 必须在 rawText 中真实存在（indexOf 定位），
   * 定位失败的机会被丢弃（不触发候选），与 pairwise judge 的 span 强制一致。
   */
  private async judgeWithLLM(
    input: OpportunityJudgeInput,
    rawText: string,
    scannedSignals: ScannedSignal[],
    maxHypotheses: number
  ): Promise<OpportunityLlmAttemptResult> {
    const { intent } = input;
    const route = OPPORTUNITY_LLM_ROUTE;
    const timeoutMs = input.timeoutMs ?? DEFAULT_OPPORTUNITY_TIMEOUT_MS;

    const { systemPrompt, userPrompt } = buildOpportunityPrompt({
      rawText,
      intent,
      scannedSignals,
      craftAdvisory: input.craftAdvisory,
      longTermState: input.longTermState,
      constitution: input.constitution,
      context: input.context,
      voiceFingerprints: input.voiceFingerprints,
      previousEmotionState: input.previousEmotionState,
      methodologyDiagnosticState: input.methodologyDiagnosticState,
    });

    let parsed: ParsedOpportunityVerdict | null = null;
    let invalidOutput = "";
    let schemaRepairAttempts = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (attempt === 1) schemaRepairAttempts = 1;
        const repairPrompt = attempt === 0
          ? { systemPrompt, userPrompt }
          : buildOpportunitySchemaRepairPrompt(invalidOutput);
        const genInput: ModelGenerateInput = {
          route,
          systemPrompt: repairPrompt.systemPrompt,
          userPrompt: repairPrompt.userPrompt,
          kind: "opportunity_judge",
          timeoutMs,
        };
        const output = await input.modelGenerate!(genInput);
        invalidOutput = output.text ?? "";
        parsed = parseOpportunityVerdict(invalidOutput);
        if (parsed) break;
      } catch {
        return { result: null, schemaRepairAttempts };
      }
    }
    if (!parsed) return { result: null, schemaRepairAttempts };

    // LLM 机会 → hypothesis（span 强制：excerpt 必须在 raw 中真实存在）
    const llmHypotheses: EditorialHypothesis[] = [];
    const allowedContextRefs = new Map<string, string>();
    for (const ref of input.methodologyDiagnosticState
      ? collectMethodologyDiagnosticSourceRefs(input.methodologyDiagnosticState)
      : []) {
      allowedContextRefs.set(ref, ref);
      allowedContextRefs.set(localizeLlmText(ref), ref);
    }
    for (const opp of parsed.opportunities) {
      const span = locateExcerptInRaw(rawText, opp.evidenceExcerpt);
      if (!span) continue; // excerpt 不在 raw 中 → 丢弃（span 强制）
      const contextEvidenceRefs = opp.contextEvidenceRefs
        .map((ref) => allowedContextRefs.get(ref))
        .filter((ref): ref is string => Boolean(ref));
      if (contextEvidenceRefs.length !== opp.contextEvidenceRefs.length) continue;
      llmHypotheses.push({
        id: `hypothesis:llm:${opp.opportunityType}`,
        opportunityType: opp.opportunityType,
        diagnosis: opp.diagnosis,
        evidenceSpans: [span],
        expectedReaderGain: opp.expectedReaderGain,
        damageRisks: opp.damageRisks.length > 0 ? opp.damageRisks : ["LLM 未提供损伤评估"],
        rewriteScope: scopeForOpportunity(opp.opportunityType),
        confidence: opp.confidence,
        craftDomain: opp.craftDomain,
        ...(opp.candidateStrategyId ? { candidateStrategyId: opp.candidateStrategyId } : {}),
        ...(contextEvidenceRefs.length > 0 ? { contextEvidenceRefs } : {}),
      });
    }

    // 准入控制：最多 2 个，opportunityType 互不冲突，校验 span
    const admission = selectHypothesesForCandidates(llmHypotheses, rawText, maxHypotheses);

    let noOpReason: string | undefined;
    if (admission.selected.length === 0) {
      noOpReason = parsed.noOpReason ?? "LLM 判定无编辑机会";
    }

    const craftPhenomenonReport = buildCraftPhenomenonReport({
      rawText,
      rawCandidateId: input.rawCandidateId ?? "candidate:raw:unknown",
      observations: parsed.craftObservations,
      allowedContextEvidenceRefs: input.methodologyDiagnosticState
        ? collectMethodologyDiagnosticSourceRefs(input.methodologyDiagnosticState)
        : [],
    });

    return { result: {
      hypotheses: admission.selected,
      rejected: admission.rejected,
      rejectReasons: admission.reasons,
      noOpReason,
      scannedSignals,
      llmJudged: true,
      craftPhenomenonReport,
      schemaRepairAttempts,
    }, schemaRepairAttempts };
  }

  // --------------------------------------------------------------------------
  // 扫描器 1：章末钩子
  // --------------------------------------------------------------------------

  private scanChapterEndPressure(rawText: string): ScannedSignal {
    const ending = extractEndingRegion(rawText);
    const hasHook = hasWebnovelHookSignal(ending);

    if (hasHook) {
      return {
        opportunityType: "chapter_end_pressure",
        triggered: false,
        evidenceSpanCount: 0,
        reason: "章末区域已含钩子信号",
      };
    }

    return {
      opportunityType: "chapter_end_pressure",
      triggered: true,
      evidenceSpanCount: 1,
      reason: `章末 ${ENDING_REGION_LEN} 字区域无钩子词项信号`,
    };
  }

  // --------------------------------------------------------------------------
  // 扫描器 2：主角行动密度
  // --------------------------------------------------------------------------

  private scanAgencyDensity(rawText: string): ScannedSignal {
    const actions = detectAgencyActions(rawText);
    const per1k = (actions.length / Math.max(1, rawText.length)) * 1000;

    if (per1k >= AGENCY_DENSITY_PER_1K) {
      return {
        opportunityType: "character_choice",
        triggered: false,
        evidenceSpanCount: actions.length,
        reason: `主角行动词密度 ${per1k.toFixed(2)}/千字 ≥ ${AGENCY_DENSITY_PER_1K}`,
      };
    }

    return {
      opportunityType: "character_choice",
      triggered: true,
      evidenceSpanCount: actions.length,
      reason: `主角行动词密度 ${per1k.toFixed(2)}/千字 < ${AGENCY_DENSITY_PER_1K}`,
    };
  }

  // --------------------------------------------------------------------------
  // 扫描器 3：感知侵蚀
  // --------------------------------------------------------------------------

  private scanPerceptionErosion(rawText: string): ScannedSignal {
    const markers = extractPerceptionMarkers(rawText);
    if (markers.length < PERCEPTION_THRESHOLD) {
      return {
        opportunityType: "voice_and_naturalness",
        triggered: false,
        evidenceSpanCount: markers.length,
        reason: `感知词项 ${markers.length} < ${PERCEPTION_THRESHOLD}`,
      };
    }

    return {
      opportunityType: "voice_and_naturalness",
      triggered: true,
      evidenceSpanCount: markers.length,
      reason: `感知词项 ${markers.length} ≥ ${PERCEPTION_THRESHOLD}`,
    };
  }

  // --------------------------------------------------------------------------
  // 扫描器 4：承诺兑现落点
  // --------------------------------------------------------------------------

  private scanPromisePayoff(
    rawText: string,
    intent: ChapterIntent,
    state: LongTermStateSnapshot | null
  ): ScannedSignal {
    // 从 intent.promisesToAdvance 与 state.promise 取开放承诺
    const openPromises: Array<{ id: string; description: string; heat: number }> = [];
    for (const p of intent.promisesToAdvance) {
      openPromises.push({ id: p, description: p, heat: 0.5 });
    }
    if (state?.promise?.length) {
      for (const p of state.promise) {
        if (p.status === "open" || p.status === "advancing") {
          openPromises.push({
            id: p.promiseId,
            description: p.description,
            heat: p.currentHeat ?? 0.5,
          });
        }
      }
    }

    if (openPromises.length === 0) {
      return {
        opportunityType: "reader_payoff",
        triggered: false,
        evidenceSpanCount: 0,
        reason: "无开放承诺可评估",
      };
    }

    // 找一个"被提及但落点过轻"的承诺
    for (const p of openPromises) {
      // 用承诺描述的关键词（取前 4 字）在 raw 中计数
      const keyword = p.description.slice(0, 4);
      if (!keyword) continue;
      const mentionCount = countOccurrences(rawText, keyword);
      if (mentionCount > 0 && mentionCount < PROMISE_LIGHT_MENTION) {
        const opportunityType: EditorialOpportunityType =
          p.heat >= 0.7 ? "reader_payoff" : "promise_advancement";
        return {
          opportunityType,
          triggered: true,
          evidenceSpanCount: 1,
          reason: `承诺关键词 "${keyword}" 被提及 ${mentionCount} 次 < ${PROMISE_LIGHT_MENTION}`,
        };
      }
    }

    return {
      opportunityType: "reader_payoff",
      triggered: false,
      evidenceSpanCount: 0,
      reason: "未命中承诺关键词频次信号",
    };
  }

  // --------------------------------------------------------------------------
  // 扫描器 5：信息倾泻
  // --------------------------------------------------------------------------

  private scanInfoDump(rawText: string): ScannedSignal {
    const paragraphs = rawText.split(/\n+/).filter((p) => p.trim().length > 0);
    const dumpParagraphs: Array<{ text: string; start: number }> = [];

    let cursor = 0;
    for (const p of paragraphs) {
      const start = rawText.indexOf(p, cursor);
      cursor = start + p.length;
      // 倾泻判定：段落长 > 阈值 且 不含对白引号与行动词
      const hasDialogue = /[“"」』]/.test(p);
      const hasAction = /[，。；！？]/.test(p) && /走|说|看|拿|推|抓|跳|冲|转身|决定/.test(p);
      if (p.length > INFO_DUMP_PARAGRAPH_LEN && !hasDialogue && !hasAction) {
        dumpParagraphs.push({ text: p, start });
      }
    }

    if (dumpParagraphs.length === 0) {
      return {
        opportunityType: "information_dramatization",
        triggered: false,
        evidenceSpanCount: 0,
        reason: "未命中长说明段词项信号",
      };
    }

    return {
      opportunityType: "information_dramatization",
      triggered: true,
      evidenceSpanCount: dumpParagraphs.length,
      reason: `命中 ${dumpParagraphs.length} 段长说明段词项信号（单段 > ${INFO_DUMP_PARAGRAPH_LEN} 字且无对白/动作词项）`,
    };
  }

  // --------------------------------------------------------------------------
  // 扫描器 6：群像功能
  // --------------------------------------------------------------------------

  private scanEnsemble(
    rawText: string,
    intent: ChapterIntent,
    characterNames: string[]
  ): ScannedSignal {
    const relevant = characterNames.length > 0
      ? characterNames
      : intent.relevantCharacters;
    if (relevant.length < ENSEMBLE_MIN_RELEVANT) {
      return {
        opportunityType: "ensemble_function",
        triggered: false,
        evidenceSpanCount: 0,
        reason: `相关角色 ${relevant.length} < ${ENSEMBLE_MIN_RELEVANT}`,
      };
    }

    // 统计有对白互动的角色（名字后接道/说/问/笑/怒等）
    const withDialogue = relevant.filter((name) => {
      const pattern = new RegExp(`${escapeRegex(name)}[^，。；！？]{0,20}(?:道|说|问|笑|怒|喊|叹|答|回|应)`);
      return pattern.test(rawText);
    });

    if (withDialogue.length >= relevant.length - 1) {
      return {
        opportunityType: "ensemble_function",
        triggered: false,
        evidenceSpanCount: withDialogue.length,
        reason: `${withDialogue.length}/${relevant.length} 角色命中对白互动词项`,
      };
    }

    // 找一个无对白互动的次要角色构造 span
    const silent = relevant.find((name) => !withDialogue.includes(name));
    if (!silent) {
      return {
        opportunityType: "ensemble_function",
        triggered: false,
        evidenceSpanCount: withDialogue.length,
        reason: "所有角色均命中对白互动词项",
      };
    }

    return {
      opportunityType: "ensemble_function",
      triggered: true,
      evidenceSpanCount: withDialogue.length,
      reason: `${withDialogue.length}/${relevant.length} 角色命中对白互动词项；未命中角色：${silent}`,
    };
  }
}

// ============================================================================
// 工具函数
// ============================================================================

function countOccurrences(text: string, keyword: string): number {
  if (!keyword) return 0;
  let count = 0;
  let idx = text.indexOf(keyword);
  while (idx >= 0) {
    count++;
    idx = text.indexOf(keyword, idx + keyword.length);
  }
  return count;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ============================================================================
// P1-9：LLM 结构化判断辅助（prompt 构建 / 解析 / span 定位 / scope 映射）
// ============================================================================

/** LLM 机会类型 → 默认 rewriteScope（与本地扫描器赋值一致） */
function scopeForOpportunity(opp: EditorialOpportunityType): RewriteScope {
  switch (opp) {
    case "chapter_end_pressure":
    case "voice_and_naturalness":
    case "information_dramatization":
      return "span_candidate";
    case "character_choice":
    case "reader_payoff":
    case "promise_advancement":
    case "ensemble_function":
    case "relationship_progress":
      return "event_candidate";
    default:
      return "span_candidate";
  }
}

/**
 * 在 rawText 中定位 LLM 给出的 evidenceExcerpt，返回 TextSpan。
 * 定位失败返回 null（span 强制：丢弃该机会）。
 * 优先精确匹配；找不到时尝试 trim 后匹配（容忍 LLM 首尾空白）。
 */
function locateExcerptInRaw(rawText: string, excerpt: string): TextSpan | null {
  const located = locateLlmExcerpt(rawText, excerpt);
  if (!located) return null;
  return {
    start: located.start,
    end: located.end,
    excerpt: located.excerpt.slice(0, 80),
  };
}

// ============================================================================
// 工厂函数
// ============================================================================

export function createEditorialOpportunityJudge(): EditorialOpportunityJudge {
  return new EditorialOpportunityJudge();
}
