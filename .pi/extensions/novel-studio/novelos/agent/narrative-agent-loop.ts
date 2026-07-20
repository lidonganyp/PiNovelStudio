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
 *   verifier 硬检查 → compileFeedback → patchService.proposePatches → generatePatchedText
 *   → evaluatePatch（退化则保留原稿）→ reverify → 清零则用 patchedText 替换 draft。
 *
 * 停止条件：
 * 1. 模型声明证据充分（stopReason="stop" 且有 text draft）
 * 2. 预算耗尽（budget.isExhausted() → afterToolCall terminate）
 * 3. 模型异常 → one_shot_raw fallback 信号
 * 4. verifier 清零（verify/patch 闭环完成）
 *
 * fallback 边界（Task B.2）：
 * - 只有 runAgentTurns 模型失败才 fallback（回退 one_shot_raw）；
 * - verify/patch 失败或退化只保留原 draft（fallback=false, verifierCleared=false）。
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
} from "../verification/narrative-verifier-suite.js";
import type { CandidatePatchService, PatchProposal } from "./candidate-patch-service.js";
import { compileFeedback } from "../verification/verification-feedback-compiler.js";
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

    if (this.verifier && this.patchService) {
      try {
        const vp = await this.verifyAndPatch(turns.draftText, input);
        finalText = vp.text;
        verifierReport = vp.verifierReport;
        patchProposals = vp.patchProposals;
        repairRounds = vp.repairRounds;
        verifierCleared = vp.verifierCleared;
        hardFindingCount = vp.hardFindingCount;
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
          retryPlan: "保留原 draft，verifierCleared=false",
        });
      }
    }

    this.trajectory.recordBudget(this.budget.getSnapshot());

    // ── 5. 记录 lineage + output ────────────────────────────────────────
    const stopReason: AgentLoopStopReason = verifierCleared
      ? "verifier_cleared"
      : turns.stopReason;

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
   * 3. compileFeedback → patchService.proposePatches → save patch-proposals.json
   * 4. 修复循环（maxRepairRounds，每轮前检查预算）：
   *    - generatePatchedText → evaluatePatch（退化则 rejected 跳过）
   *    - 有 accepted → reverify；清零则用 patchedText 返回
   *    - 仍有硬失败 → 更新 feedbacks/proposals 进入下轮
   * 5. 循环结束仍有硬失败 → 返回原 draft（verifierCleared=false）
   *
   * 失败/退化不触发 fallback，只保留原 draft。
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

    // 3. compileFeedback → proposePatches
    let feedbacks = compileFeedback(report);
    let proposals = patchService.proposePatches(draftText, feedbacks);
    this.candidateWorkspace.savePatchProposals(proposals);
    for (const p of proposals) this.trajectory.recordPatchProposal(p);

    let currentText = draftText;
    let repairRounds = 0;

    // 4. 修复循环
    while (repairRounds < this.maxRepairRounds) {
      if (this.budget.isExhausted()) break;
      if (proposals.filter((p) => !p.rejected).length === 0) break;

      repairRounds++;
      this.trajectory.recordRepairRound({
        round: repairRounds,
        hardFindings: report.hardFindings.length,
        proposals: proposals.length,
      });

      // 生成 patched text
      let patchedText: string;
      try {
        patchedText = await this.generatePatchedText(currentText, proposals, input);
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
        // 所有 patch 退化 → 保留原 draft
        break;
      }

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

      // 仍有硬失败 → 更新 feedbacks/proposals 进入下轮
      currentText = patchedText;
      feedbacks = compileFeedback(report);
      proposals = patchService.proposePatches(currentText, feedbacks);
      for (const p of proposals) this.trajectory.recordPatchProposal(p);
    }

    // 5. 循环结束仍有硬失败 → 保留原 draft
    return {
      text: draftText,
      verifierReport: report,
      patchProposals: proposals,
      repairRounds,
      verifierCleared: false,
      hardFindingCount: report.hardFindings.length,
    };
  }

  /**
   * 生成 patched text：构建 patch prompt → runtime.prompt() → 提取 patched text。
   *
   * 失败抛错由 verifyAndPatch catch（保留原 draft）。
   */
  private async generatePatchedText(
    originalDraft: string,
    proposals: PatchProposal[],
    input: AgentLoopInput,
  ): Promise<string> {
    const activeProposals = proposals.filter((p) => !p.rejected);
    const patchInstructions = activeProposals
      .map((p, i) => `[修复${i + 1}] 范围 [${p.targetSpan.start}, ${p.targetSpan.end}]\n方向：${p.repairDirection}\n建议：${p.suggestion}`)
      .join("\n");

    const userPrompt = [
      "以下正文存在若干硬伤，请在标记范围内修复，保持其余内容不变，输出完整正文。",
      "不要调用工具，直接输出修复后的完整正文。",
      "",
      "原始正文：",
      originalDraft,
      "",
      "修复范围与方向：",
      patchInstructions,
    ].join("\n");

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
    const patchedText = textBlocks.map((b) => b.text).join("");

    if (patchedText.trim().length === 0) {
      throw new Error("patch 模型未返回有效文本");
    }
    return patchedText;
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
