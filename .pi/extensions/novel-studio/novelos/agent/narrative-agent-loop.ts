/**
 * NovelOS Narrative Agent Loop（OPT-9.5，A.5 + B.2 重构）
 *
 * 基于 NovelOS Runtime 的领域 loop。不重写通用 loop/session/event。
 *
 * M1 架构（ReAct 式 prompt 工具调用 + verify/patch/reverify 闭环）：
 * - 工具 schema 注入 system prompt（tool-schema-injector.ts）；
 * - 模型在文本中输出 `<tool_call>` 指令，createProjectStreamFn 解析为 toolCall 内容块，
 *   pi-agent-core Agent 原生派发工具、追加 toolResult 消息、再调 streamFn（回灌证据），
 *   直到模型输出无指令的正文（stopReason="stop"）或预算耗尽（afterToolCall terminate）。
 * - draft 生成后进入 verify/patch/reverify 闭环（Task B.2）：
 *   verifier 硬检查 → 有限批次调度 → patchService.proposePatches → generatePatchedText
 *   → evaluatePatch（退化则保留上一候选）→ reverify → 清零则用 patchedText 替换 draft。
 *
 * 停止条件：
 * 1. 模型声明证据充分（stopReason="stop" 且有 text draft）
 * 2. 预算耗尽（budget.isExhausted() → afterToolCall terminate）
 * 3. 连续两轮 verifier finding 不减少（stagnant）
 * 4. 模型异常 → 结构化失败信号
 * 5. verifier 清零（verify/patch 闭环完成）
 *
 * fallback 边界（Task B.2）：
 * - 只有 runAgentTurns 模型失败才返回 fallback 标记；生产编排据此 hard block，不回退 one-shot raw；
 * - verify/patch 未清零时保留最后已接受候选供诊断（fallback=false, verifierCleared=false）。
 */

import type { NovelOSRuntime } from "../runtime/runtime.js";
import type { BudgetPolicy, BudgetSnapshot } from "../runtime/budget-policy.js";
import type { TrajectoryStore } from "../trajectory/trajectory-store.js";
import type { NarrativeToolRegistry } from "./narrative-tool-registry.js";
import type { NarrativeSearchService } from "./narrative-search-service.js";
import type { CandidateWorkspace } from "./candidate-workspace.js";
import type { PermissionPolicy } from "../security/permission-policy.js";
import type { CompiledContext } from "../../v2/core/types.js";
import type {
  NarrativeVerifierSuite,
  NarrativeVerifierReport,
  VerificationFinding,
} from "../verification/narrative-verifier-suite.js";
import type { CandidatePatchService, PatchProposal } from "./candidate-patch-service.js";
import { findingToFeedback } from "../verification/verification-feedback-compiler.js";
import {
  createEvidencePlan,
  type EvidencePlan,
} from "./evidence-plan.js";

// ============================================================================
// 类型
// ============================================================================

export interface AgentLoopInput {
  /** 本章意图摘要 */
  chapterIntent: string;
  /** 种子上下文（CompiledContext 摘要或 ChapterSeed 文本） */
  seedContext: string;
  /** 编译后的上下文（供 verifier 使用，Task B.2） */
  context: CompiledContext;
  /** 已知角色名（含 aliases，用于实体幻觉检测） */
  knownCharacterNames?: string[];
  /** M1.1：本章不可违反的必需事实（来自 ChapterIntent.inviolableFacts） */
  inviolableFacts?: string[];
  /**
   * R6 修复：前文（eval 模式续写用）。
   * eval 模式下由编排器传入 evalPrefix（reference chapter 的前文），
   * 注入 agent userPrompt 的【前文】段，确保 agentic 生成续写同一故事，
   * 而非从 scratch 生成不同故事。生产模式（非 eval）不传，行为不变。
   */
  evalPrefix?: string;
}

export type AgentLoopStopReason =
  | "model_declares_sufficient"
  | "budget_exhausted"
  | "stagnant"
  | "verifier_cleared"
  | "model_error"
  | "tool_error";

export interface AgentLoopLineage {
  evidencePlan: EvidencePlan;
  toolCalls: number;
  sourceRefs: string[];
  stopReason: AgentLoopStopReason;
  budgetSnapshot: BudgetSnapshot;
  /** 收集的证据事实文本 */
  evidenceFacts: string[];
  /** verifier 是否清零（无硬失败或 patch 后清零） */
  verifierCleared: boolean;
  /** 硬失败数量（最终） */
  hardFindingCount: number;
}

export interface AgentLoopResult {
  /** agentic_raw 正文（fallback 时为空字符串） */
  text: string;
  /** lineage（写入 candidate-workspace/lineage.json） */
  lineage: AgentLoopLineage;
  /** 是否需要回退 one_shot_raw */
  fallback: boolean;
  /** verifier 验证报告（Task B.2） */
  verifierReport?: NarrativeVerifierReport;
  /** patch proposals（Task B.2） */
  patchProposals?: PatchProposal[];
  /** 修复轮次（Task B.2） */
  repairRounds: number;
}

// ============================================================================
// NarrativeAgentLoop
// ============================================================================

export interface NarrativeAgentLoopOptions {
  runtime: NovelOSRuntime;
  registry: NarrativeToolRegistry;
  searchService: NarrativeSearchService;
  candidateWorkspace: CandidateWorkspace;
  permissionPolicy: PermissionPolicy;
  budget: BudgetPolicy;
  trajectory: TrajectoryStore;
  /** verifier（Task B.2）；不提供则跳过 verify/patch */
  verifier?: NarrativeVerifierSuite;
  /** patch service（Task B.2）；不提供则跳过 patch */
  patchService?: CandidatePatchService;
  /** 最大修复轮次（默认 env PINOVEL_NOVELOS_MAX_REPAIR_ROUNDS 或 2） */
  maxRepairRounds?: number;
}

/** runAgentTurns 返回 */
interface AgentTurnsResult {
  draftText: string;
  sourceRefs: string[];
  evidenceFacts: string[];
  toolCalls: number;
  stopReason: AgentLoopStopReason;
}

/** verifyAndPatch 返回 */
interface VerifyPatchResult {
  text: string;
  verifierReport: NarrativeVerifierReport;
  patchProposals: PatchProposal[];
  repairRounds: number;
  verifierCleared: boolean;
  hardFindingCount: number;
  stopReason?: AgentLoopStopReason;
}

const DEFAULT_REPAIR_BATCH_SIZE = 4;
const MAX_STAGNANT_REPAIR_ROUNDS = 2;
/** P0-3：语义类 finding（intent_omission）最多自动修复1轮 */
const MAX_SEMANTIC_REPAIR_ROUNDS = 1;
/** P0-3：确定性 finding（format/fact/canon 等）可按现有预算执行最多2轮 */
const MAX_DETERMINISTIC_REPAIR_ROUNDS = 2;

function isVerbatimIntentFinding(finding: VerificationFinding): boolean {
  return /(?:原句|原文|\[verbatim\])/iu.test(`${finding.conflictFact}\n${finding.sourceRef}`);
}

function isSemanticFinding(finding: VerificationFinding): boolean {
  // P0-3 修复：只有 heuristic intent_omission 才算语义遗漏（受1轮预算约束）。
  // - deterministic intent_omission（如 verbatim 原句缺失）→ 确定性遗漏，按现有预算2轮
  // - corroborated intent_omission → 多源印证遗漏，按现有预算2轮
  // - 无 certainty 字段的旧 finding（向后兼容）→ 不算语义，按现有预算2轮
  // 这样保证 verbatim 原句缺失等确定性问题仍可修复2轮，只有启发式误判受1轮约束。
  return finding.failureType === "intent_omission" && finding.certainty === "heuristic";
}

function repairPriority(finding: VerificationFinding): number {
  if (finding.failureType !== "intent_omission") return 0;
  if (isVerbatimIntentFinding(finding)) return 1;
  if (finding.source === "event_intent_checker") return 3;
  return 2;
}

/**
 * Select a bounded repair batch. Specific must-include findings suppress broad
 * event-summary findings until the concrete obligations have been addressed.
 *
 * P0-3 修复：
 * - 过滤掉空范围 finding（allowedRepairRange.start === end）→ 诊断 only，不进入修复批次
 * - 过滤掉已达 semantic 修复预算上限的 finding（由 semanticRepairTracker 追踪）
 */
export function selectRepairFindings(
  findings: VerificationFinding[],
  limit = DEFAULT_REPAIR_BATCH_SIZE,
  semanticRepairTracker?: Map<string, number>,
): VerificationFinding[] {
  const unique = [...new Map(findings.map((finding) => [finding.id, finding])).values()];
  // P0-3：过滤空范围 finding（诊断 only，不触发改写）
  const nonEmptyRange = unique.filter(
    (finding) => finding.allowedRepairRange.end > finding.allowedRepairRange.start,
  );
  // P0-3：过滤已达 semantic 修复预算的 finding
  const budgetEligible = semanticRepairTracker
    ? nonEmptyRange.filter((finding) => {
        if (!isSemanticFinding(finding)) return true;
        const repaired = semanticRepairTracker.get(finding.id) ?? 0;
        return repaired < MAX_SEMANTIC_REPAIR_ROUNDS;
      })
    : nonEmptyRange;

  const hasSpecificIntentFinding = budgetEligible.some(
    (finding) => finding.failureType === "intent_omission" && finding.source !== "event_intent_checker",
  );
  const eligible = hasSpecificIntentFinding
    ? budgetEligible.filter((finding) => finding.source !== "event_intent_checker")
    : budgetEligible;

  return eligible
    .map((finding, index) => ({ finding, index }))
    .sort((left, right) =>
      repairPriority(left.finding) - repairPriority(right.finding) || left.index - right.index)
    .slice(0, Math.max(1, limit))
    .map(({ finding }) => finding);
}

function findingIds(findings: VerificationFinding[]): Set<string> {
  return new Set(findings.map((finding) => finding.id));
}

export class NarrativeAgentLoop {
  private readonly runtime: NovelOSRuntime;
  private readonly registry: NarrativeToolRegistry;
  private readonly searchService: NarrativeSearchService;
  private readonly candidateWorkspace: CandidateWorkspace;
  private readonly permissionPolicy: PermissionPolicy;
  private readonly budget: BudgetPolicy;
  private readonly trajectory: TrajectoryStore;
  private readonly verifier?: NarrativeVerifierSuite;
  private readonly patchService?: CandidatePatchService;
  private readonly maxRepairRounds: number;
  /**
   * P0-3：per-finding semantic 修复次数追踪。
   * key=findingId, value=已修复轮数。
   * 语义类 finding（intent_omission）最多修复1轮，避免同一语义 finding 连续重写整章。
   */
  private readonly semanticRepairTracker: Map<string, number> = new Map();

  constructor(options: NarrativeAgentLoopOptions) {
    this.runtime = options.runtime;
    this.registry = options.registry;
    this.searchService = options.searchService;
    this.candidateWorkspace = options.candidateWorkspace;
    this.permissionPolicy = options.permissionPolicy;
    this.budget = options.budget;
    this.trajectory = options.trajectory;
    this.verifier = options.verifier;
    this.patchService = options.patchService;
    const envRounds = Number(process.env.PINOVEL_NOVELOS_MAX_REPAIR_ROUNDS);
    this.maxRepairRounds = options.maxRepairRounds ?? (Number.isFinite(envRounds) && envRounds >= 0 ? envRounds : 2);

    // 订阅 runtime 事件流 → 转发工具事件到 candidateWorkspace.tool-events.jsonl。
    // ReAct 架构下工具由 Agent 原生派发（非 loop 程序化调用），runtime 已把事件写入
    // trajectory；此处额外转发到 candidateWorkspace 以恢复 6 文件契约（OPT-9.4）。
    this.runtime.subscribe((event) => {
      this.candidateWorkspace.recordToolEvent(event);
    });
  }

  /**
   * 运行 agent loop。
   *
   * 流程：
   * 1. 创建 EvidencePlan → 写 evidence-plan.json + trajectory
   * 2. runAgentTurns：runtime.prompt() 触发 Agent 原生 ReAct loop → 提取 draft + sourceRefs
   * 3. verifyAndPatch（若 verifier+patchService 已提供）：verify → patch → reverify 闭环
   * 4. 记录 lineage → 写 lineage.json + output
   *
   * runAgentTurns 失败 → fallback=true（回退 one_shot_raw）。
   * verifyAndPatch 失败/退化 → 保留原 draft（fallback=false, verifierCleared=false）。
   */
  async run(input: AgentLoopInput): Promise<AgentLoopResult> {
    // ── 1. EvidencePlan ──────────────────────────────────────────────────
    const plan = createEvidencePlan({
      chapterIntent: input.chapterIntent,
      seedContext: input.seedContext,
    });
    this.candidateWorkspace.writeEvidencePlan(plan);
    this.trajectory.recordEvidencePlan(plan);

    // ── 2. runAgentTurns（Agent 原生 ReAct loop） ────────────────────────
    let turns: AgentTurnsResult;
    try {
      turns = await this.runAgentTurns(input);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.trajectory.recordFailure({
        stage: "novelos_draft_generation",
        severity: "soft",
        reason: `模型调用失败：${errMsg}`,
        recoverable: true,
        retryPlan: "fallback to one_shot_raw",
      });
      return this.makeFallback(plan, [], "model_error");
    }

    // ── 预算耗尽或无 draft → fallback ────────────────────────────────────
    if (turns.stopReason === "budget_exhausted") {
      return this.makeFallback(plan, turns.sourceRefs, "budget_exhausted", turns.evidenceFacts, turns.toolCalls);
    }
    if (turns.draftText.trim().length === 0) {
      this.trajectory.recordFailure({
        stage: "novelos_draft_generation",
        severity: "soft",
        reason: "模型未返回有效 draft 文本",
        recoverable: true,
        retryPlan: "fallback to one_shot_raw",
      });
      return this.makeFallback(plan, turns.sourceRefs, "model_error", turns.evidenceFacts, turns.toolCalls);
    }

    // ── 3. 写 draft.md ──────────────────────────────────────────────────
    this.candidateWorkspace.writeDraft(turns.draftText);

    // ── 4. verifyAndPatch（若 verifier+patchService 已提供） ─────────────
    let finalText = turns.draftText;
    let verifierReport: NarrativeVerifierReport | undefined;
    let patchProposals: PatchProposal[] | undefined;
    let repairRounds = 0;
    let verifierCleared = false;
    let hardFindingCount = 0;
    let repairStopReason: AgentLoopStopReason | undefined;

    if (this.verifier && this.patchService) {
      try {
        const vp = await this.verifyAndPatch(turns.draftText, input);
        finalText = vp.text;
        verifierReport = vp.verifierReport;
        patchProposals = vp.patchProposals;
        repairRounds = vp.repairRounds;
        verifierCleared = vp.verifierCleared;
        hardFindingCount = vp.hardFindingCount;
        repairStopReason = vp.stopReason;
        // 若 patch 修改了正文，更新 draft.md
        if (finalText !== turns.draftText) {
          this.candidateWorkspace.writeDraft(finalText);
        }
      } catch (err) {
        // verify/patch 失败 → 保留原 draft，不 fallback
        const errMsg = err instanceof Error ? err.message : String(err);
        this.trajectory.recordFailure({
          stage: "novelos_verify_patch",
          severity: "soft",
          reason: `verify/patch 失败，保留原 draft：${errMsg}`,
          recoverable: true,
          retryPlan: "保留最后已接受候选，verifierCleared=false",
        });
      }
    }

    this.trajectory.recordBudget(this.budget.getSnapshot());

    // ── 5. 记录 lineage + output ────────────────────────────────────────
    const stopReason: AgentLoopStopReason = verifierCleared
      ? "verifier_cleared"
      : repairStopReason ?? turns.stopReason;

    const lineage: AgentLoopLineage = {
      evidencePlan: plan,
      toolCalls: turns.toolCalls,
      sourceRefs: [...turns.sourceRefs],
      stopReason,
      budgetSnapshot: this.budget.getSnapshot(),
      evidenceFacts: turns.evidenceFacts,
      verifierCleared,
      hardFindingCount,
    };
    this.candidateWorkspace.saveLineage(lineage);
    this.trajectory.recordOutput({ draftLength: finalText.length, lineage });

    return {
      text: finalText,
      lineage,
      fallback: false,
      ...(verifierReport ? { verifierReport } : {}),
      ...(patchProposals ? { patchProposals } : {}),
      repairRounds,
    };
  }

  // ── 内部：Agent 原生 ReAct loop ───────────────────────────────────────

  /**
   * 触发 Agent 原生 loop：构建 userPrompt → runtime.prompt() → waitForIdle()
   * → 从 agent.state.messages 提取 draft + sourceRefs。
   *
   * Agent 原生 loop（pi-agent-core）：
   * - streamFn 解析模型输出的 `<tool_call>` 指令 → emit toolCall 块 + stopReason="toolUse"
   * - Agent dispatch 工具 → 追加 toolResult 消息 → 再调 streamFn（回灌证据到 userPrompt）
   * - 直到 stopReason="stop"（模型输出正文）或 afterToolCall terminate（预算耗尽）
   */
  private async runAgentTurns(input: AgentLoopInput): Promise<AgentTurnsResult> {
    // R6 修复：eval 模式下注入【前文】段，确保 agentic 生成续写同一故事。
    // 前文置于 prompt 最前，让 agent 在检索证据 + 生成正文时始终锚定正确的故事上下文。
    const promptParts: string[] = [];
    if (input.evalPrefix && input.evalPrefix.trim().length > 0) {
      promptParts.push("【前文】", input.evalPrefix, "");
    }
    promptParts.push(
      input.chapterIntent,
      "",
      "种子上下文：",
      input.seedContext,
      "",
      "请先使用跨源叙事证据检索工具查找结构化事实证据（世界事实、角色状态、原文片段），",
      "再按需使用章节原文片段检索工具查证具体原文。证据充分时直接输出正文，不再发出工具调用指令。",
    );
    const userPrompt = promptParts.join("\n");

    await this.runtime.prompt(userPrompt);
    await this.runtime.waitForIdle();

    // 从 agent transcript 提取结果
    const messages = this.runtime.agent.state.messages;

    // 找最后一条 assistant 消息
    let lastAssistant: { role?: string; content?: unknown } | undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      if ((messages[i] as { role?: string }).role === "assistant") {
        lastAssistant = messages[i] as { role?: string; content?: unknown };
        break;
      }
    }

    const content = lastAssistant?.content;
    const contentArr = Array.isArray(content) ? content : [];

    // 提取 text 块作为 draft
    const textBlocks = contentArr.filter(
      (c: { type?: string; text?: string }) =>
        c.type === "text" && typeof c.text === "string" && c.text.length > 0,
    ) as Array<{ type: "text"; text: string }>;
    const draftText = textBlocks.map((b) => b.text).join("");

    // 检查最后 assistant 是否仍含 toolCall 块（未生成正文）
    const hasToolCallBlock = contentArr.some(
      (c: { type?: string }) => c.type === "toolCall",
    );

    // 扫描所有 toolResult 消息提取 sourceRefs + evidenceFacts
    const sourceRefs: string[] = [];
    const evidenceFacts: string[] = [];
    for (const msg of messages) {
      const m = msg as { role?: string };
      if (m.role !== "toolResult") continue;
      const tr = msg as unknown as {
        content?: Array<{ type?: string; text?: string }>;
        details?: { sourceRef?: string; evidenceLevel?: string; [k: string]: unknown };
        isError?: boolean;
      };
      // 提取文本内容作为 evidenceFact
      if (Array.isArray(tr.content)) {
        const text = tr.content
          .filter((c) => c.type === "text" && typeof c.text === "string")
          .map((c) => c.text)
          .join("");
        if (text.length > 0) evidenceFacts.push(text);
      }
      // 提取 confirmed sourceRef
      if (tr.details?.sourceRef && tr.details?.evidenceLevel === "confirmed") {
        sourceRefs.push(tr.details.sourceRef);
      }
      // P0-1：记录 ranked evidence 到 trajectory（模型实际看到的排序证据）
      if (Array.isArray(tr.details?.rankedEvidences)) {
        this.trajectory.recordRankedEvidence({
          query: tr.details?.query,
          evidences: tr.details?.rankedEvidences,
        });
      }
    }

    const toolCalls = this.budget.getSnapshot().toolCalls;

    // stopReason 映射
    let stopReason: AgentLoopStopReason;
    if (this.budget.isExhausted() && draftText.trim().length === 0) {
      stopReason = "budget_exhausted";
    } else if (draftText.trim().length === 0 && hasToolCallBlock) {
      // 预算耗尽于工具阶段，无最终 draft
      stopReason = "budget_exhausted";
    } else {
      stopReason = "model_declares_sufficient";
    }

    return { draftText, sourceRefs, evidenceFacts, toolCalls, stopReason };
  }

  // ── 内部：verify/patch/reverify 闭环（Task B.2） ──────────────────────

  /**
   * verify draft → patch candidate → reverify 闭环。
   *
   * 流程：
   * 1. verifier.verify(draftText) → save verifier-report.json + trajectory
   * 2. 无硬失败 → 返回原 draft（verifierCleared=true, repairRounds=0）
   * 3. 选择有限且有优先级的 finding 批次 → patchService.proposePatches
   * 4. 修复循环（maxRepairRounds，每轮前检查预算）：
   *    - generatePatchedText → evaluatePatch（退化则 rejected 跳过）
   *    - 有 accepted → reverify；清零则用 patchedText 返回
   *    - 仍有硬失败 → 更新 feedbacks/proposals 进入下轮
   * 5. 连续两轮无收敛则停止；仍有硬失败时返回最后已接受候选
   *
   * 未清零不触发 fallback，也不会进入生产保存；候选只用于 trace 和诊断。
   */
  private async verifyAndPatch(
    draftText: string,
    input: AgentLoopInput,
  ): Promise<VerifyPatchResult> {
    const verifier = this.verifier!;
    const patchService = this.patchService!;

    // 1. 初次 verify
    let report = verifier.verify({
      text: draftText,
      context: input.context,
      chapterIntent: input.chapterIntent,
      knownCharacterNames: input.knownCharacterNames,
      inviolableFacts: input.inviolableFacts,
    });
    this.candidateWorkspace.saveVerifierReport(report);
    this.trajectory.recordVerifierReport(report);

    // 2. 无硬失败 → 直接清零
    if (!report.hasHardFailure) {
      return {
        text: draftText,
        verifierReport: report,
        patchProposals: [],
        repairRounds: 0,
        verifierCleared: true,
        hardFindingCount: 0,
      };
    }

    // 3. 每轮只修有限批次，避免把整章所有约束一次性压给模型。
    // P0-3：传入 semanticRepairTracker，过滤已达 semantic 修复预算的 finding。
    let selectedFindings = selectRepairFindings(report.hardFindings, DEFAULT_REPAIR_BATCH_SIZE, this.semanticRepairTracker);
    let feedbacks = selectedFindings.map(findingToFeedback);
    let proposals = patchService.proposePatches(draftText, feedbacks);
    this.candidateWorkspace.savePatchProposals(proposals);
    for (const p of proposals) this.trajectory.recordPatchProposal(p);

    let currentText = draftText;
    let repairRounds = 0;
    let stagnantRounds = 0;
    let stopReason: AgentLoopStopReason | undefined;

    // 4. 修复循环
    while (repairRounds < this.maxRepairRounds) {
      if (this.budget.isExhausted()) break;
      if (proposals.filter((p) => !p.rejected).length === 0) break;

      // P0-3：本轮修复前标记 semantic finding 已修复（避免下轮重复修同一 finding）
      for (const finding of selectedFindings) {
        if (isSemanticFinding(finding)) {
          this.semanticRepairTracker.set(
            finding.id,
            (this.semanticRepairTracker.get(finding.id) ?? 0) + 1,
          );
        }
      }

      repairRounds++;
      // 生成 patched text
      let patchedText: string;
      try {
        patchedText = await this.generatePatchedText(
          currentText,
          proposals,
          selectedFindings,
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.trajectory.recordFailure({
          stage: "novelos_patch_generation",
          severity: "soft",
          reason: `patch 生成失败：${errMsg}`,
          recoverable: true,
          retryPlan: "保留原 draft，verifierCleared=false",
        });
        break;
      }

      // 评估退化（对每个未 rejected proposal）
      const acceptedProposals = proposals.filter((p) => !p.rejected);
      let hasAccepted = false;
      for (const proposal of acceptedProposals) {
        const evalResult = patchService.evaluatePatch(currentText, patchedText, proposal);
        if (evalResult.accepted) {
          hasAccepted = true;
        } else {
          proposal.rejected = true;
          proposal.rejectionReason = evalResult.reason;
        }
      }
      this.candidateWorkspace.savePatchProposals(proposals);

      if (!hasAccepted) {
        // 所有 patch 退化 → 保留上一候选
        break;
      }

      const previousFindingIds = findingIds(report.hardFindings);

      // reverify patchedText
      report = verifier.verify({
        text: patchedText,
        context: input.context,
        chapterIntent: input.chapterIntent,
        knownCharacterNames: input.knownCharacterNames,
        inviolableFacts: input.inviolableFacts,
      });
      this.candidateWorkspace.saveVerifierReport(report);
      this.trajectory.recordVerifierReport(report);
      currentText = patchedText;

      const nextFindingIds = findingIds(report.hardFindings);
      const resolvedFindingIds = [...previousFindingIds].filter((id) => !nextFindingIds.has(id));
      const remainingFindingIds = [...nextFindingIds];
      const madeProgress = nextFindingIds.size < previousFindingIds.size;
      stagnantRounds = madeProgress ? 0 : stagnantRounds + 1;
      this.trajectory.recordRepairRound({
        round: repairRounds,
        hardFindingsBefore: previousFindingIds.size,
        hardFindingsAfter: nextFindingIds.size,
        selectedFindingIds: selectedFindings.map((finding) => finding.id),
        resolvedFindingIds,
        remainingFindingIds,
        stagnantRounds,
      });

      if (!report.hasHardFailure) {
        // 清零 → 用 patchedText 替换
        return {
          text: patchedText,
          verifierReport: report,
          patchProposals: proposals,
          repairRounds,
          verifierCleared: true,
          hardFindingCount: 0,
        };
      }

      if (stagnantRounds >= MAX_STAGNANT_REPAIR_ROUNDS) {
        stopReason = "stagnant";
        break;
      }

      // 仍有硬失败 → 选择下一有限批次进入下轮
      // P0-3：传入 semanticRepairTracker，过滤已达 semantic 修复预算的 finding
      selectedFindings = selectRepairFindings(report.hardFindings, DEFAULT_REPAIR_BATCH_SIZE, this.semanticRepairTracker);
      // 若所有 semantic finding 已达预算且无 deterministic finding 可修 → 停止
      if (selectedFindings.length === 0) {
        stopReason = "stagnant";
        break;
      }
      feedbacks = selectedFindings.map(findingToFeedback);
      proposals = patchService.proposePatches(currentText, feedbacks);
      for (const p of proposals) this.trajectory.recordPatchProposal(p);
    }

    // 5. 循环结束仍有硬失败 → 保留最后一个通过退化检查的候选供诊断。
    // 上层仍以 verifierCleared=false hard block，候选不会保存为正式章节。
    return {
      text: currentText,
      verifierReport: report,
      patchProposals: proposals,
      repairRounds,
      verifierCleared: false,
      hardFindingCount: report.hardFindings.length,
      ...(stopReason ? { stopReason } : {}),
    };
  }

  /**
   * 生成 patched text：构建 patch prompt → runtime.prompt() → 提取 patched text。
   *
   * P0-3 修复：
   * - 当所有 proposals 都是 localReplacement（精确 span 且非整章）时，
   *   只要求模型输出 span 内的替换文本，不重写整章。
   * - 否则回退到原有行为（输出完整正文）。
   *
   * 失败抛错由 verifyAndPatch catch（保留最后已接受候选）。
   */
  private async generatePatchedText(
    originalDraft: string,
    proposals: PatchProposal[],
    findings: VerificationFinding[],
  ): Promise<string> {
    const activeProposals = proposals.filter((p) => !p.rejected);
    const findingById = new Map(findings.map((finding) => [finding.id, finding]));

    // P0-3：判断是否使用局部 replacement 模式
    const allLocalReplacement = activeProposals.length > 0
      && activeProposals.every((p) => p.localReplacement === true);

    const patchInstructions = activeProposals
      .map((p, i) => {
        const finding = findingById.get(p.findingId);
        const spanStart = p.targetSpan.start;
        const spanEnd = p.targetSpan.end;
        const originalExcerpt = originalDraft.slice(spanStart, Math.min(spanEnd + 20, originalDraft.length));
        return [
          `[修复${i + 1}] findingId=${p.findingId}`,
          `确定性等级：${p.certainty ?? "unknown"}`,
          `语义类：${p.isSemantic ? "是（受1轮预算约束）" : "否"}`,
          `证据来源：${finding?.sourceRef ?? "unknown"}`,
          `必须解决：${finding?.conflictFact ?? p.suggestion}`,
          `具体要求：${finding?.description ?? p.suggestion}`,
          `允许范围：[${spanStart}, ${spanEnd}]`,
          `原片段：${originalExcerpt}`,
          `方向：${p.repairDirection}`,
          `建议：${p.suggestion}`,
        ].join("\n");
      })
      .join("\n");

    let userPrompt: string;
    if (allLocalReplacement) {
      // P0-3：局部 replacement 模式 — 只输出 span 内替换文本
      const replacementSpecs = activeProposals.map((p, i) => {
        const finding = findingById.get(p.findingId);
        const spanStart = p.targetSpan.start;
        const spanEnd = p.targetSpan.end;
        const originalExcerpt = originalDraft.slice(spanStart, spanEnd);
        return [
          `[替换${i + 1}]`,
          `范围：[${spanStart}, ${spanEnd}]`,
          `原片段：「${originalExcerpt}」`,
          `问题：${finding?.conflictFact ?? p.suggestion}`,
          `要求：${finding?.description ?? p.suggestion}`,
          `建议：${p.suggestion}`,
        ].join("\n");
      }).join("\n\n");

      userPrompt = [
        "以下正文存在若干局部硬伤，请只输出每个标记范围的替换文本，不要重写整章。",
        "不要调用工具，按以下格式输出：",
        "```",
        "[替换1]",
        "<只输出范围 [start, end] 内的替换文本>",
        "[替换2]",
        "<只输出范围 [start, end] 内的替换文本>",
        "```",
        "",
        "原始正文：",
        originalDraft,
        "",
        "需要替换的范围与要求：",
        replacementSpecs,
      ].join("\n");
    } else {
      // 完整正文模式（含整章范围或混合场景）
      userPrompt = [
        "以下正文存在若干硬伤，请在标记范围内修复，保持其余内容不变，输出完整正文。",
        "不要调用工具，直接输出修复后的完整正文。",
        "",
        "原始正文：",
        originalDraft,
        "",
        "修复范围与方向：",
        patchInstructions,
      ].join("\n");
    }

    await this.runtime.prompt(userPrompt);
    await this.runtime.waitForIdle();

    const messages = this.runtime.agent.state.messages;
    let lastAssistant: { role?: string; content?: unknown } | undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      if ((messages[i] as { role?: string }).role === "assistant") {
        lastAssistant = messages[i] as { role?: string; content?: unknown };
        break;
      }
    }

    const content = lastAssistant?.content;
    const contentArr = Array.isArray(content) ? content : [];
    const textBlocks = contentArr.filter(
      (c: { type?: string; text?: string }) =>
        c.type === "text" && typeof c.text === "string" && c.text.length > 0,
    ) as Array<{ type: "text"; text: string }>;
    const modelOutput = textBlocks.map((b) => b.text).join("");

    if (modelOutput.trim().length === 0) {
      throw new Error("patch 模型未返回有效文本");
    }

    // P0-3：局部 replacement 模式 → 解析替换文本并合并到原 draft
    if (allLocalReplacement) {
      const merged = this.applyLocalReplacements(originalDraft, activeProposals, modelOutput);
      if (merged === null) {
        // 解析失败 → 回退到模型原始输出（让退化检查兜底）
        return modelOutput;
      }
      return merged;
    }

    return modelOutput;
  }

  /**
   * P0-3：解析模型输出的局部替换文本，合并到原 draft。
   *
   * 期望格式：
   * ```
   * [替换1]
   * <替换文本>
   * [替换2]
   * <替换文本>
   * ```
   *
   * 合并规则：按 span 范围逆序替换（避免偏移），span 外文本逐字保留。
   * 解析失败返回 null（调用方回退到模型原始输出）。
   */
  private applyLocalReplacements(
    originalDraft: string,
    proposals: PatchProposal[],
    modelOutput: string,
  ): string | null {
    // 解析 [替换N] 块
    const replacements: Array<{ index: number; text: string }> = [];
    const blockPattern = /\[替换(\d+)\]\s*([\s\S]*?)(?=\[替换\d+\]|$)/gu;
    let match: RegExpExecArray | null;
    while ((match = blockPattern.exec(modelOutput)) !== null) {
      const index = parseInt(match[1], 10);
      const text = match[2].trim();
      replacements.push({ index, text });
    }

    if (replacements.length === 0) return null;
    replacements.sort((a, b) => a.index - b.index);

    // 按 span 范围逆序替换（避免偏移）
    let result = originalDraft;
    const sortedProposals = [...proposals].sort(
      (a, b) => b.targetSpan.start - a.targetSpan.start,
    );

    for (let i = 0; i < sortedProposals.length; i++) {
      const proposal = sortedProposals[i];
      const replacement = replacements.find((r) => {
        // 匹配 proposal 在原列表中的 1-based 索引
        const originalIndex = proposals.indexOf(proposal) + 1;
        return r.index === originalIndex;
      });
      if (!replacement) continue;

      const before = result.slice(0, proposal.targetSpan.start);
      const after = result.slice(proposal.targetSpan.end);
      result = before + replacement.text + after;
    }

    return result;
  }

  // ── 内部：构造 fallback 结果 ──────────────────────────────────────────

  private makeFallback(
    plan: EvidencePlan,
    sourceRefs: string[],
    stopReason: AgentLoopStopReason,
    evidenceFacts: string[] = [],
    toolCalls = 0,
  ): AgentLoopResult {
    const lineage: AgentLoopLineage = {
      evidencePlan: plan,
      toolCalls,
      sourceRefs: [...sourceRefs],
      stopReason,
      budgetSnapshot: this.budget.getSnapshot(),
      evidenceFacts,
      verifierCleared: false,
      hardFindingCount: 0,
    };
    this.candidateWorkspace.saveLineage(lineage);
    this.trajectory.recordFailure({
      stage: "novelos_agent_loop",
      severity: "soft",
      reason: `agent loop fallback: ${stopReason}`,
      recoverable: true,
      retryPlan: "fallback to one_shot_raw",
    });
    return {
      text: "",
      lineage,
      fallback: true,
      repairRounds: 0,
    };
  }
}

// ============================================================================
// 工厂
// ============================================================================

export function createNarrativeAgentLoop(
  options: NarrativeAgentLoopOptions,
): NarrativeAgentLoop {
  return new NarrativeAgentLoop(options);
}
