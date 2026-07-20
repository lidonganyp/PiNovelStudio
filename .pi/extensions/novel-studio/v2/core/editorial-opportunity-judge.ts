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
 * - P1-9：LLM 结构化判断为主导（1 次低温调用），本地扫描器降为证据/span 提供者；
 *   LLM 失败/parse 失败/span 无效时降级到本地阈值判断（bounded recovery）
 * - hypothesis 的 damageRisks 必须评估修订可能造成的损伤
 *
 * 机会扫描器（每个产生 0+ hypothesis，带真实 span）：
 *   1. scanChapterEndPressure   — 章末钩子弱 → chapter_end_pressure
 *   2. scanAgencyDensity        — 主角行动词密度过低 → character_choice
 *   3. scanPerceptionErosion    — 感知侵蚀词过多 → voice_and_naturalness
 *   4. scanPromisePayoff        — 开放承诺被提及但落点过轻 → reader_payoff / promise_advancement
 *   5. scanInfoDump             — 大段信息倾泻 → information_dramatization
 *   6. scanEnsemble             — 次要角色功能扁平 → ensemble_function
 *
 * 阈值设计为"宽松触发 + span 强制 + confidence 门槛"三重过滤，
 * 避免日常链路无机会也强行生成候选。
 */

import type { TextSpan } from "./types.js";
import type { ChapterIntent } from "./chapter-intent-builder.js";
import type { LongTermStateSnapshot, ConstitutionSnapshot } from "./types.js";
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
} from "./regression-checks.js";
import { detectAgencyActions } from "./language-risk-library.js";
import type {
  ModelGenerateFn,
  ModelGenerateInput,
} from "../adapters/legacy-model-route-adapter.js";
// QUALITY-11：证据感知编辑机会 advisory context（可选注入 LLM prompt，不改变机会判定逻辑）
import type { EditorialOpportunityAdvisory } from "./editorial-opportunity-advisory.js";

// ============================================================================
// 输入/输出类型
// ============================================================================

export interface OpportunityJudgeInput {
  /** raw 正文（编辑机会的扫描对象） */
  rawText: string;
  /** 章节意图（ChapterIntentBuilder 输出） */
  intent: ChapterIntent;
  /** 长期状态快照（可空） */
  longTermState: LongTermStateSnapshot | null;
  /** 作品宪法快照（可空） */
  constitution: ConstitutionSnapshot | null;
  /** 本章已知角色名（用于 ensemble 扫描） */
  characterNames: string[];
  /**
   * P1-9：模型调用函数。传入时启用 LLM 结构化判断为主导（1 次低温调用），
   * 本地扫描器降为证据提供者；LLM 失败时降级本地阈值。
   * 不传入时纯本地启发式（测试/离线模式）。
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
   * 1. 始终运行 6 个本地扫描器，产出 scannedSignals + localCandidates（证据/span 提供者）
   * 2. 若传入 modelGenerate：LLM 结构化判断为主导（1 次低温调用）
   *    - LLM 返回 0-2 个机会，每个必须引用 raw 中真实存在的 evidenceExcerpt
   *    - span 强制：excerpt 在 raw 中定位失败的机会被丢弃
   *    - LLM 失败/parse 失败 → 降级本地阈值判断（bounded recovery）
   * 3. 未传入 modelGenerate：纯本地阈值判断（测试/离线模式）
   * 4. 准入控制：最多 2 个，opportunityType 互不冲突，校验 span
   */
  async judge(input: OpportunityJudgeInput): Promise<OpportunityJudgeResult> {
    const { rawText, intent } = input;
    // Step 4a：默认最多 1 个候选；评测时 PINOVEL_MAX_HYPOTHESES=2 恢复 2 候选。
    const maxHypotheses = Number(process.env.PINOVEL_MAX_HYPOTHESES ?? 1);
    const scannedSignals: ScannedSignal[] = [];
    const localCandidates: EditorialHypothesis[] = [];

    if (!rawText || rawText.trim().length === 0) {
      return {
        hypotheses: [],
        rejected: [],
        rejectReasons: [],
        noOpReason: "raw 正文为空，无可扫描的编辑机会",
        scannedSignals: [],
        llmJudged: false,
      };
    }

    // 1. 章末钩子
    const endSignal = this.scanChapterEndPressure(rawText);
    scannedSignals.push(endSignal.signal);
    if (endSignal.hypothesis) localCandidates.push(endSignal.hypothesis);

    // 2. 主角行动密度
    const agencySignal = this.scanAgencyDensity(rawText);
    scannedSignals.push(agencySignal.signal);
    if (agencySignal.hypothesis) localCandidates.push(agencySignal.hypothesis);

    // 3. 感知侵蚀
    const perceptionSignal = this.scanPerceptionErosion(rawText);
    scannedSignals.push(perceptionSignal.signal);
    if (perceptionSignal.hypothesis) localCandidates.push(perceptionSignal.hypothesis);

    // 4. 承诺兑现落点
    const promiseSignal = this.scanPromisePayoff(rawText, intent, input.longTermState);
    scannedSignals.push(promiseSignal.signal);
    if (promiseSignal.hypothesis) localCandidates.push(promiseSignal.hypothesis);

    // 5. 信息倾泻
    const infoDumpSignal = this.scanInfoDump(rawText);
    scannedSignals.push(infoDumpSignal.signal);
    if (infoDumpSignal.hypothesis) localCandidates.push(infoDumpSignal.hypothesis);

    // 6. 群像功能
    const ensembleSignal = this.scanEnsemble(rawText, intent, input.characterNames);
    scannedSignals.push(ensembleSignal.signal);
    if (ensembleSignal.hypothesis) localCandidates.push(ensembleSignal.hypothesis);

    // P1-9：LLM 主导判断（传入 modelGenerate 时）
    if (input.modelGenerate) {
      const llmResult = await this.judgeWithLLM(input, rawText, scannedSignals, localCandidates, maxHypotheses);
      if (llmResult !== null) {
        return llmResult; // LLM 成功，使用其判断
      }
      // LLM 失败 → 降级本地阈值判断（bounded recovery）
    }

    // 本地阈值判断（无 LLM 或 LLM 降级）
    const admission = selectHypothesesForCandidates(localCandidates, rawText, maxHypotheses);

    let noOpReason: string | undefined;
    if (admission.selected.length === 0) {
      const triggered = scannedSignals.filter((s) => s.triggered);
      if (triggered.length === 0) {
        noOpReason = "raw 无可引用 span 证明的编辑机会，返回 no-op";
      } else {
        noOpReason = `识别到 ${triggered.length} 个信号但均未通过 hypothesis 校验或被准入控制拒绝`;
      }
    }

    return {
      hypotheses: admission.selected,
      rejected: admission.rejected,
      rejectReasons: admission.reasons,
      noOpReason,
      scannedSignals,
      llmJudged: false,
      llmFallbackReason: input.modelGenerate ? "LLM 调用/解析失败，降级本地阈值" : undefined,
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
    localCandidates: EditorialHypothesis[],
    maxHypotheses: number
  ): Promise<OpportunityJudgeResult | null> {
    const { intent } = input;
    const route = OPPORTUNITY_LLM_ROUTE;
    const timeoutMs = input.timeoutMs ?? DEFAULT_OPPORTUNITY_TIMEOUT_MS;

    const { systemPrompt, userPrompt } = buildOpportunityPrompt({
      rawText,
      intent,
      scannedSignals,
      localCandidates,
      craftAdvisory: input.craftAdvisory,
    });

    let output;
    try {
      const genInput: ModelGenerateInput = {
        route,
        systemPrompt,
        userPrompt,
        kind: "opportunity_judge",
        timeoutMs,
      };
      output = await input.modelGenerate!(genInput);
    } catch {
      return null; // LLM 调用异常 → 降级
    }

    const parsed = parseOpportunityVerdict(output.text ?? "");
    if (!parsed) return null; // parse 失败 → 降级

    // LLM 机会 → hypothesis（span 强制：excerpt 必须在 raw 中真实存在）
    const llmHypotheses: EditorialHypothesis[] = [];
    for (const opp of parsed.opportunities) {
      const span = locateExcerptInRaw(rawText, opp.evidenceExcerpt);
      if (!span) continue; // excerpt 不在 raw 中 → 丢弃（span 强制）
      llmHypotheses.push({
        id: `hypothesis:llm:${opp.opportunityType}`,
        opportunityType: opp.opportunityType,
        diagnosis: opp.diagnosis,
        evidenceSpans: [span],
        expectedReaderGain: opp.expectedReaderGain,
        damageRisks: opp.damageRisks.length > 0 ? opp.damageRisks : ["LLM 未提供损伤评估"],
        rewriteScope: scopeForOpportunity(opp.opportunityType),
        confidence: opp.confidence,
      });
    }

    // 准入控制：最多 2 个，opportunityType 互不冲突，校验 span
    const admission = selectHypothesesForCandidates(llmHypotheses, rawText, maxHypotheses);

    let noOpReason: string | undefined;
    if (admission.selected.length === 0) {
      noOpReason = parsed.noOpReason ?? "LLM 判定无编辑机会";
    }

    return {
      hypotheses: admission.selected,
      rejected: admission.rejected,
      rejectReasons: admission.reasons,
      noOpReason,
      scannedSignals,
      llmJudged: true,
    };
  }

  // --------------------------------------------------------------------------
  // 扫描器 1：章末钩子
  // --------------------------------------------------------------------------

  private scanChapterEndPressure(rawText: string): {
    signal: ScannedSignal;
    hypothesis: EditorialHypothesis | null;
  } {
    const ending = extractEndingRegion(rawText);
    const hasHook = hasWebnovelHookSignal(ending);
    const span: TextSpan = {
      start: Math.max(0, rawText.length - ending.length),
      end: rawText.length,
      excerpt: ending.slice(0, 80),
    };

    if (hasHook) {
      return {
        signal: {
          opportunityType: "chapter_end_pressure",
          triggered: false,
          evidenceSpanCount: 0,
          reason: "章末区域已含钩子信号，无需编辑",
        },
        hypothesis: null,
      };
    }

    return {
      signal: {
        opportunityType: "chapter_end_pressure",
        triggered: true,
        evidenceSpanCount: 1,
        reason: `章末 ${ENDING_REGION_LEN} 字区域无钩子信号`,
      },
      hypothesis: {
        id: "hypothesis:chapter_end_pressure",
        opportunityType: "chapter_end_pressure",
        diagnosis: "章末区域缺少牵引力：末段无读者会追问的问题或新压力",
        evidenceSpans: [span],
        expectedReaderGain: "章末抛回新问题或施加新压力，提升翻页牵引力",
        damageRisks: [
          "强行加钩子可能与本章已建立的事实冲突",
          "新问题若指向未规划的下章事实会伪造悬念",
        ],
        rewriteScope: "span_candidate",
        confidence: 0.55,
      },
    };
  }

  // --------------------------------------------------------------------------
  // 扫描器 2：主角行动密度
  // --------------------------------------------------------------------------

  private scanAgencyDensity(rawText: string): {
    signal: ScannedSignal;
    hypothesis: EditorialHypothesis | null;
  } {
    const actions = detectAgencyActions(rawText);
    const per1k = (actions.length / Math.max(1, rawText.length)) * 1000;
    const span: TextSpan = actions.length > 0
      ? { start: actions[0].span.start, end: actions[0].span.end, excerpt: actions[0].word }
      : { start: 0, end: Math.min(rawText.length, 80), excerpt: rawText.slice(0, 80) };

    if (per1k >= AGENCY_DENSITY_PER_1K) {
      return {
        signal: {
          opportunityType: "character_choice",
          triggered: false,
          evidenceSpanCount: actions.length,
          reason: `主角行动词密度 ${per1k.toFixed(2)}/千字 ≥ ${AGENCY_DENSITY_PER_1K}，无需编辑`,
        },
        hypothesis: null,
      };
    }

    return {
      signal: {
        opportunityType: "character_choice",
        triggered: true,
        evidenceSpanCount: actions.length,
        reason: `主角行动词密度 ${per1k.toFixed(2)}/千字 < ${AGENCY_DENSITY_PER_1K}，行动稀疏`,
      },
      hypothesis: {
        id: "hypothesis:character_agency_focus",
        opportunityType: "character_choice",
        diagnosis: `主角主动行动词密度过低（${per1k.toFixed(2)}/千字），存在用感知/反应替代选择的段落`,
        evidenceSpans: [span],
        expectedReaderGain: "主角做出带不可逆后果的主动选择，提升角色能动性",
        damageRisks: [
          "强化行动可能偏离本章已确立的人物心智状态",
          "新增主动选择可能改变后续章节依赖的事件结果",
        ],
        rewriteScope: "event_candidate",
        confidence: 0.5,
      },
    };
  }

  // --------------------------------------------------------------------------
  // 扫描器 3：感知侵蚀
  // --------------------------------------------------------------------------

  private scanPerceptionErosion(rawText: string): {
    signal: ScannedSignal;
    hypothesis: EditorialHypothesis | null;
  } {
    const markers = extractPerceptionMarkers(rawText);
    if (markers.length < PERCEPTION_THRESHOLD) {
      return {
        signal: {
          opportunityType: "voice_and_naturalness",
          triggered: false,
          evidenceSpanCount: markers.length,
          reason: `感知侵蚀词 ${markers.length} < ${PERCEPTION_THRESHOLD}，无需编辑`,
        },
        hypothesis: null,
      };
    }

    // 取前 3 个命中位置构造 span 证据
    const regex = new RegExp(markers.join("|"), "g");
    const spans: TextSpan[] = [];
    let m: RegExpExecArray | null;
    while ((m = regex.exec(rawText)) !== null && spans.length < 3) {
      spans.push({ start: m.index, end: m.index + m[0].length, excerpt: m[0] });
      if (m.index === regex.lastIndex) regex.lastIndex++;
    }

    return {
      signal: {
        opportunityType: "voice_and_naturalness",
        triggered: true,
        evidenceSpanCount: markers.length,
        reason: `感知侵蚀词 ${markers.length} ≥ ${PERCEPTION_THRESHOLD}，用感知替代主角主动行动`,
      },
      hypothesis: {
        id: "hypothesis:voice_and_naturalness_focus",
        opportunityType: "voice_and_naturalness",
        diagnosis: `感知侵蚀词过多（${markers.length} 处：${markers.join("、")}），用感知替代主角主动行动`,
        evidenceSpans: spans,
        expectedReaderGain: "把感知替代词改写为具体动作与感官细节，回到母语自然",
        damageRisks: [
          "改写感知词可能削弱内省段落的情感重量",
          "过度去感知化可能让角色心理变得扁平",
        ],
        rewriteScope: "span_candidate",
        confidence: 0.5,
      },
    };
  }

  // --------------------------------------------------------------------------
  // 扫描器 4：承诺兑现落点
  // --------------------------------------------------------------------------

  private scanPromisePayoff(
    rawText: string,
    intent: ChapterIntent,
    state: LongTermStateSnapshot | null
  ): {
    signal: ScannedSignal;
    hypothesis: EditorialHypothesis | null;
  } {
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
        signal: {
          opportunityType: "reader_payoff",
          triggered: false,
          evidenceSpanCount: 0,
          reason: "无开放承诺可评估",
        },
        hypothesis: null,
      };
    }

    // 找一个"被提及但落点过轻"的承诺
    for (const p of openPromises) {
      // 用承诺描述的关键词（取前 4 字）在 raw 中计数
      const keyword = p.description.slice(0, 4);
      if (!keyword) continue;
      const mentionCount = countOccurrences(rawText, keyword);
      if (mentionCount > 0 && mentionCount < PROMISE_LIGHT_MENTION) {
        const idx = rawText.indexOf(keyword);
        const span: TextSpan = {
          start: idx,
          end: idx + keyword.length,
          excerpt: keyword,
        };
        const opportunityType: EditorialOpportunityType =
          p.heat >= 0.7 ? "reader_payoff" : "promise_advancement";
        return {
          signal: {
            opportunityType,
            triggered: true,
            evidenceSpanCount: 1,
            reason: `承诺 "${keyword}" 被提及 ${mentionCount} 次 < ${PROMISE_LIGHT_MENTION}，落点过轻`,
          },
          hypothesis: {
            id: `hypothesis:promise_payoff:${p.id}`,
            opportunityType,
            diagnosis: `开放承诺 "${keyword}" 在 raw 中被提及但落点过轻（${mentionCount} 次）`,
            evidenceSpans: [span],
            expectedReaderGain:
              opportunityType === "reader_payoff"
                ? "把承诺兑现做成有重量的情绪落点，让读者感到'等到了'"
                : "让停滞的伏笔产生可感知的进展，不必兑现",
            damageRisks: [
              "强化兑现可能提前关闭尚未到时点的伏笔",
              "新增进展可能与后续章节的兑现节奏冲突",
            ],
            rewriteScope: "event_candidate",
            confidence: 0.45,
          },
        };
      }
    }

    return {
      signal: {
        opportunityType: "reader_payoff",
        triggered: false,
        evidenceSpanCount: 0,
        reason: "开放承诺均未被轻描淡写地提及，无需编辑",
      },
      hypothesis: null,
    };
  }

  // --------------------------------------------------------------------------
  // 扫描器 5：信息倾泻
  // --------------------------------------------------------------------------

  private scanInfoDump(rawText: string): {
    signal: ScannedSignal;
    hypothesis: EditorialHypothesis | null;
  } {
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
        signal: {
          opportunityType: "information_dramatization",
          triggered: false,
          evidenceSpanCount: 0,
          reason: "未检测到大段信息倾泻段落",
        },
        hypothesis: null,
      };
    }

    const first = dumpParagraphs[0];
    const span: TextSpan = {
      start: first.start,
      end: first.start + Math.min(first.text.length, 120),
      excerpt: first.text.slice(0, 80),
    };

    return {
      signal: {
        opportunityType: "information_dramatization",
        triggered: true,
        evidenceSpanCount: dumpParagraphs.length,
        reason: `检测到 ${dumpParagraphs.length} 段信息倾泻（单段 > ${INFO_DUMP_PARAGRAPH_LEN} 字且无对白/动作）`,
      },
      hypothesis: {
        id: "hypothesis:information_dramatization_focus",
        opportunityType: "information_dramatization",
        diagnosis: `存在 ${dumpParagraphs.length} 段大段信息倾泻，说明性段落压住节奏`,
        evidenceSpans: [span],
        expectedReaderGain: "把信息倾泻拆进人物反应、提问与冲突中释放，恢复张力",
        damageRisks: [
          "戏剧化改写可能遗漏关键信息点",
          "拆分信息可能改变释放顺序影响悬念",
        ],
        rewriteScope: "span_candidate",
        confidence: 0.45,
      },
    };
  }

  // --------------------------------------------------------------------------
  // 扫描器 6：群像功能
  // --------------------------------------------------------------------------

  private scanEnsemble(
    rawText: string,
    intent: ChapterIntent,
    characterNames: string[]
  ): {
    signal: ScannedSignal;
    hypothesis: EditorialHypothesis | null;
  } {
    const relevant = characterNames.length > 0
      ? characterNames
      : intent.relevantCharacters;
    if (relevant.length < ENSEMBLE_MIN_RELEVANT) {
      return {
        signal: {
          opportunityType: "ensemble_function",
          triggered: false,
          evidenceSpanCount: 0,
          reason: `相关角色 ${relevant.length} < ${ENSEMBLE_MIN_RELEVANT}，群像机会不足`,
        },
        hypothesis: null,
      };
    }

    // 统计有对白互动的角色（名字后接道/说/问/笑/怒等）
    const withDialogue = relevant.filter((name) => {
      const pattern = new RegExp(`${escapeRegex(name)}[^，。；！？]{0,20}(?:道|说|问|笑|怒|喊|叹|答|回|应)`);
      return pattern.test(rawText);
    });

    if (withDialogue.length >= relevant.length - 1) {
      return {
        signal: {
          opportunityType: "ensemble_function",
          triggered: false,
          evidenceSpanCount: withDialogue.length,
          reason: `${withDialogue.length}/${relevant.length} 角色有对白互动，群像功能正常`,
        },
        hypothesis: null,
      };
    }

    // 找一个无对白互动的次要角色构造 span
    const silent = relevant.find((name) => !withDialogue.includes(name));
    if (!silent) {
      return {
        signal: {
          opportunityType: "ensemble_function",
          triggered: false,
          evidenceSpanCount: withDialogue.length,
          reason: "所有角色均有对白互动",
        },
        hypothesis: null,
      };
    }

    const idx = rawText.indexOf(silent);
    const span: TextSpan = idx >= 0
      ? { start: idx, end: idx + silent.length, excerpt: silent }
      : { start: 0, end: Math.min(rawText.length, 80), excerpt: rawText.slice(0, 80) };

    return {
      signal: {
        opportunityType: "ensemble_function",
        triggered: true,
        evidenceSpanCount: withDialogue.length,
        reason: `${withDialogue.length}/${relevant.length} 角色有对白互动，次要角色功能扁平`,
      },
      hypothesis: {
        id: "hypothesis:ensemble_function_focus",
        opportunityType: "ensemble_function",
        diagnosis: `次要角色 "${silent}" 出场但无功能性互动，群像扁平`,
        evidenceSpans: [span],
        expectedReaderGain: "让次要角色承担明确叙事功能（质疑/泄密/阻拦/见证），提升群像层次",
        damageRisks: [
          "赋予次要角色功能可能偏离其已建立的定位",
          "新增互动可能改变关系基线",
        ],
        rewriteScope: "event_candidate",
        confidence: 0.4,
      },
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
  if (!excerpt) return null;
  const idx = rawText.indexOf(excerpt);
  if (idx >= 0) {
    return {
      start: idx,
      end: idx + excerpt.length,
      excerpt: excerpt.slice(0, 80),
    };
  }
  // 容忍首尾空白差异
  const trimmed = excerpt.trim();
  if (trimmed && trimmed !== excerpt) {
    const idx2 = rawText.indexOf(trimmed);
    if (idx2 >= 0) {
      return {
        start: idx2,
        end: idx2 + trimmed.length,
        excerpt: trimmed.slice(0, 80),
      };
    }
  }
  return null;
}

/** 合法的 opportunityType 集合（用于解析校验） */
const VALID_OPPORTUNITY_TYPES: Set<string> = new Set([
  "reader_payoff",
  "character_choice",
  "relationship_progress",
  "information_dramatization",
  "promise_advancement",
  "ensemble_function",
  "chapter_end_pressure",
  "voice_and_naturalness",
]);

interface ParsedOpportunity {
  opportunityType: EditorialOpportunityType;
  diagnosis: string;
  evidenceExcerpt: string;
  expectedReaderGain: string;
  damageRisks: string[];
  confidence: number;
}

interface ParsedOpportunityVerdict {
  opportunities: ParsedOpportunity[];
  noOpReason: string | null;
}

/**
 * 解析 LLM 编辑机会判断输出。
 * 失败返回 null（触发降级）。容错：单条机会字段缺失时跳过该条，不整体失败。
 */
function parseOpportunityVerdict(text: string): ParsedOpportunityVerdict | null {
  if (!text || !text.trim()) return null;
  try {
    const json = extractJsonObject(text);
    if (!json) return null;
    const obj = JSON.parse(json) as Record<string, unknown>;

    const opportunities: ParsedOpportunity[] = [];
    const rawOpps = Array.isArray(obj.opportunities) ? obj.opportunities : [];
    for (const item of rawOpps) {
      if (typeof item !== "object" || item === null) continue;
      const o = item as Record<string, unknown>;
      const opportunityType = o.opportunityType;
      if (typeof opportunityType !== "string" || !VALID_OPPORTUNITY_TYPES.has(opportunityType)) {
        continue;
      }
      const diagnosis = typeof o.diagnosis === "string" ? o.diagnosis : "";
      const evidenceExcerpt = typeof o.evidenceExcerpt === "string" ? o.evidenceExcerpt : "";
      const expectedReaderGain = typeof o.expectedReaderGain === "string" ? o.expectedReaderGain : "";
      if (!diagnosis || !evidenceExcerpt || !expectedReaderGain) continue;
      const damageRisks = Array.isArray(o.damageRisks)
        ? o.damageRisks.filter((r): r is string => typeof r === "string")
        : [];
      let confidence = typeof o.confidence === "number" ? o.confidence : 0.5;
      if (confidence < 0) confidence = 0;
      if (confidence > 1) confidence = 1;
      opportunities.push({
        opportunityType: opportunityType as EditorialOpportunityType,
        diagnosis,
        evidenceExcerpt,
        expectedReaderGain,
        damageRisks,
        confidence,
      });
    }

    const noOpReason =
      typeof obj.noOpReason === "string" && obj.noOpReason.trim()
        ? obj.noOpReason
        : null;

    return { opportunities, noOpReason };
  } catch {
    return null;
  }
}

/** 从 LLM 输出中提取 JSON 对象字符串（容错：裸 JSON / 代码块 / 首尾花括号） */
function extractJsonObject(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence && fence[1]) {
    const inner = fence[1].trim();
    if (inner.startsWith("{")) return inner;
  }
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) return trimmed.slice(first, last + 1);
  return null;
}

/** LLM 编辑机会判断 prompt 输入 */
interface OpportunityPromptInput {
  rawText: string;
  intent: ChapterIntent;
  scannedSignals: ScannedSignal[];
  localCandidates: EditorialHypothesis[];
  /** QUALITY-11：raw 阶段 craft evidence advisory（可选，注入 prompt 作为诊断上下文） */
  craftAdvisory?: EditorialOpportunityAdvisory;
}

const OPPORTUNITY_SYSTEM_PROMPT = `你是顶尖网文编辑。判断 raw 正文中是否存在值得生成编辑候选的编辑机会。

判断原则：
- 只在存在明确、可引用正文片段证明的编辑机会时返回机会。若 raw 已充分满足章节意图，返回 0 个机会。
- 每个机会必须引用 raw 中真实存在的连续文字片段（evidenceExcerpt 必须与 raw 原文逐字一致，不可改写、缩写或转述）。
- 最多 2 个机会。机会类型互不冲突。
- 不要凭空捏造 raw 中不存在的片段；引用不存在的片段的机会会被丢弃。
- 本地扫描证据仅供参考，可能存在误报，请基于 raw 实际质量独立判断。
- 必须评估每个机会的修订损伤风险（damageRisks 至少 1 条）。

机会类型（opportunityType 取值）：
- chapter_end_pressure：章末钩子弱，缺少翻页牵引力
- character_choice：主角主动选择/行动稀疏，能动性不足
- voice_and_naturalness：感知侵蚀/AI 腔/翻译腔，中文不自然
- reader_payoff：读者期待的情绪落点过轻
- promise_advancement：开放承诺/伏笔停滞，无进展
- information_dramatization：大段信息倾泻，说明性段落压住节奏
- ensemble_function：次要角色功能扁平，群像层次不足
- relationship_progress：关系进展缺失或突兀

输出严格 JSON（不要输出 JSON 以外的内容）：
{
  "opportunities": [
    {
      "opportunityType": "上述取值之一",
      "diagnosis": "具体问题诊断",
      "evidenceExcerpt": "raw 中逐字一致的文字片段",
      "expectedReaderGain": "修订后读者能获得的收益",
      "damageRisks": ["修订可能造成的损伤1", "损伤2"],
      "confidence": 0.0到1.0的数值
    }
  ],
  "noOpReason": "无机会时的原因；有机会时为 null"
}`;

/** 构建 LLM 编辑机会判断 prompt */
function buildOpportunityPrompt(input: OpportunityPromptInput): {
  systemPrompt: string;
  userPrompt: string;
} {
  const { rawText, intent, scannedSignals, localCandidates, craftAdvisory } = input;
  const parts: string[] = [];

  // 章节意图
  parts.push("【本章意图】");
  if (intent.chapterFunction) parts.push(`功能：${intent.chapterFunction}`);
  if (intent.readerExperience.length > 0) parts.push(`读者体验目标：${intent.readerExperience.join("、")}`);
  if (intent.currentPressure.length > 0) parts.push(`当前压力：${intent.currentPressure.join("；")}`);
  if (intent.relevantCharacters.length > 0) parts.push(`相关角色：${intent.relevantCharacters.join("、")}`);
  if (intent.inviolableFacts.length > 0) parts.push(`不可破坏事实：${intent.inviolableFacts.join("；")}`);

  // 本地扫描证据（作为 hint，非决定性）
  const triggered = scannedSignals.filter((s) => s.triggered);
  if (triggered.length > 0 || localCandidates.length > 0) {
    parts.push("【本地扫描证据（仅供参考，可能误报）】");
    for (const s of triggered) {
      parts.push(`- ${s.opportunityType}：${s.reason}`);
    }
    for (const h of localCandidates) {
      parts.push(`- ${h.opportunityType}（本地 hypothesis）：${h.diagnosis}`);
    }
  } else {
    parts.push("【本地扫描证据】无信号触发");
  }

  // QUALITY-11：raw 阶段 craft evidence advisory（诊断上下文，非命令，非评分）
  // 注入位置：本地扫描证据之后、raw 正文之前，让 LLM judge 能看到 raw 的 craft risk 摘要。
  // 不改变机会判定逻辑：advisory 只是额外上下文，LLM 可参考也可忽略。
  if (craftAdvisory && craftAdvisory.promptBlock) {
    parts.push(craftAdvisory.promptBlock);
  }

  // raw 正文
  parts.push("【raw 正文】");
  parts.push("---");
  parts.push(rawText);
  parts.push("---");

  parts.push("请基于 raw 实际质量判断是否存在值得生成编辑候选的机会，输出严格 JSON。");

  return {
    systemPrompt: OPPORTUNITY_SYSTEM_PROMPT,
    userPrompt: parts.join("\n\n"),
  };
}

// ============================================================================
// 工厂函数
// ============================================================================

export function createEditorialOpportunityJudge(): EditorialOpportunityJudge {
  return new EditorialOpportunityJudge();
}
