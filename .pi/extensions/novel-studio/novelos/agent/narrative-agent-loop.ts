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
 *
 * 文件拆分历史（simplicity-gate 800 行限制）：
 * - 2026-07-26：将类型定义、修复选择器、patch 合并/prompt 构造拆分到独立模块，
 *   主文件只保留 NarrativeAgentLoop 类核心编排逻辑。
 */

import type { NovelOSRuntime } from "../runtime/runtime.js";
import type { BudgetPolicy } from "../runtime/budget-policy.js";
import type { TrajectoryStore } from "../trajectory/trajectory-store.js";
import type { NarrativeToolRegistry } from "./narrative-tool-registry.js";
import type { NarrativeSearchService } from "./narrative-search-service.js";
import type { CandidateWorkspace } from "./candidate-workspace.js";
import type { PermissionPolicy } from "../security/permission-policy.js";
import type {
  NarrativeVerifierSuite,
  NarrativeVerifierReport,
  VerificationFinding,
} from "../verification/narrative-verifier-suite.js";
import type { CandidatePatchService, PatchProposal, PatchType } from "./candidate-patch-service.js";
import { findingToFeedback } from "../verification/verification-feedback-compiler.js";
import {
  createEvidencePlan,
  type EvidencePlan,
} from "./evidence-plan.js";

// REASONING-REPAIR-BOUNDARY-1 Wave 3：修订授权 + 候选谱系 + 计量接线
import { evaluateRepairAuthorization } from "../../v2/core/repair-authorization-policy.js";
import { createRepairAuthorizationLedger } from "../../v2/core/repair-authorization-ledger.js";
import { hashText } from "../../v2/core/candidate-revision-store.js";
import { createModelCallMeter } from "../../v2/core/model-call-meter.js";
import { createValidatorRunMeter, type ValidatorRunMeter } from "../../v2/core/validator-run-meter.js";
import type {
  CandidateDerivationType,
  CandidateRevisionManifest,
  RepairAuthorization,
  RepairReasonCode,
  RepairStopReason,
} from "../../v2/core/repair-authorization-contracts.js";
import type { EvidenceRecord } from "../../v2/core/evidence-governance-contracts.js";
import type { TextSpan } from "../../v2/core/types.js";
import {
  type RepairBudgetConfig,
  type RepairBudgetCounts,
  type RepairBudgetSnapshot,
  buildRepairBudgetSnapshot,
  checkRepairBudget,
  deriveRepairBudgetConfig,
} from "./repair-budget.js";

// 公共 API：从拆分模块 re-export 类型，保持下游 import 路径稳定
export type {
  AgentLoopInput,
  AgentLoopStopReason,
  AgentLoopLineage,
  AgentLoopResult,
  NarrativeAgentLoopOptions,
} from "./narrative-agent-loop-types.js";

// 内部辅助模块
import type {
  AgentLoopInput,
  AgentLoopStopReason,
  AgentLoopLineage,
  AgentLoopResult,
  NarrativeAgentLoopOptions,
  AgentTurnsResult,
  VerifyPatchResult,
  ModelCallsByKind,
} from "./narrative-agent-loop-types.js";
import type {
  CoverageGate,
  CoverageGateResult,
} from "./must-verify-coverage-gate.js";
import { RETRIEVAL_TOOL_NAMES } from "../tools/narrative-tools.js";
import {
  DEFAULT_REPAIR_BATCH_SIZE,
  isSemanticFinding,
  selectRepairFindings,
} from "./narrative-repair-selector.js";
import {
  applyLocalReplacements,
  buildLocalReplacementPrompt,
  buildNewCandidatePrompt,
} from "./narrative-patch-merger.js";

// ============================================================================
// 检索决策规则 prompt
// ============================================================================

/**
 * Phase 2D（2026-08-06）三缺口修复 — 缺口二：不确定性驱动的检索决策。
 *
 * 取代旧的"请先使用跨源叙事证据检索工具查找..."强制检索 prompt。
 * 设计原则（对齐用户边界）：
 * - 上下文已足以保证事实/人物状态/因果关系正确 → 直接输出正文，不调工具
 * - 缺少的信息可能改变上述三项之一 → 调最相关的证据工具查证
 * - 不为"完成流程"做无必要检索
 *
 * 生产路径默认使用此 prompt（不传 retrievalPromptOverride 时）。
 * eval A/B 对照实验中，A 组通过 retrievalPromptOverride 传入 FORCED_RETRIEVAL_PROMPT
 * 保持旧强制检索行为，B 组传入 UNCERTAINTY_DRIVEN_RETRIEVAL_PROMPT（与此默认一致）。
 */
const DEFAULT_UNCERTAINTY_DRIVEN_PROMPT = [
  "检索决策规则：",
  "- 如果现有上下文已经足以保证事实、人物状态和因果关系正确，可以直接输出正文，不调用任何工具。",
  "- 如果缺少的信息可能改变上述三项之一（事实/人物状态/因果关系），先调用最相关的证据工具查证。",
  '- 不要为了"完成流程"而进行无必要检索。',
].join("\n");

// ============================================================================
// NarrativeAgentLoop
// ============================================================================

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
  private readonly coverageGate?: CoverageGate;
  private readonly maxCoverageRetries: number;
  private readonly maxRepairRounds: number;
  /** RRB-4.6：多维修订预算天花板（模型调用/授权/候选/validator runs）。 */
  private readonly repairBudgetConfig: RepairBudgetConfig;
  /**
   * P0-3：per-finding semantic 修复次数追踪。
   * key=findingId, value=已修复轮数。
   * 语义类 finding（intent_omission）最多修复1轮，避免同一语义 finding 连续重写整章。
   */
  private readonly semanticRepairTracker: Map<string, number> = new Map();
  private readonly authorizationLedger = createRepairAuthorizationLedger();

  constructor(options: NarrativeAgentLoopOptions) {
    this.runtime = options.runtime as NovelOSRuntime;
    this.registry = options.registry as NarrativeToolRegistry;
    this.searchService = options.searchService as NarrativeSearchService;
    this.candidateWorkspace = options.candidateWorkspace as CandidateWorkspace;
    this.permissionPolicy = options.permissionPolicy as PermissionPolicy;
    this.budget = options.budget;
    this.trajectory = options.trajectory as TrajectoryStore;
    this.verifier = options.verifier as NarrativeVerifierSuite | undefined;
    this.patchService = options.patchService as CandidatePatchService | undefined;
    this.coverageGate = options.coverageGate;
    const configuredCoverageRetries = options.maxCoverageRetries;
    this.maxCoverageRetries =
      configuredCoverageRetries !== undefined &&
      Number.isFinite(configuredCoverageRetries) &&
      configuredCoverageRetries >= 0
        ? Math.floor(configuredCoverageRetries)
        : 1;
    const envRounds = Number(process.env.PINOVEL_NOVELOS_MAX_REPAIR_ROUNDS);
    this.maxRepairRounds = options.maxRepairRounds ?? (Number.isFinite(envRounds) && envRounds >= 0 ? envRounds : 2);
    // RRB-4.6：多维修订预算天花板默认由 maxRepairRounds 派生，调用方可覆盖单维度。
    this.repairBudgetConfig = {
      ...deriveRepairBudgetConfig(this.maxRepairRounds, DEFAULT_REPAIR_BATCH_SIZE),
      ...(options.repairBudget ?? {}),
    };

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
    // Phase 2C：优先消费调用方预创建的 plan（allowedTools 已在 runtime 创建前过滤）。
    // 未提供时回退到内部 createEvidencePlan（向后兼容）。
    const plan = input.evidencePlan ?? createEvidencePlan({
      chapterIntent: input.chapterIntent,
      seedContext: input.seedContext,
    });
    this.candidateWorkspace.writeEvidencePlan(plan);
    this.trajectory.recordEvidencePlan(plan);

    // ── 2. runAgentTurns（Agent 原生 ReAct loop） ────────────────────────
    let turns: AgentTurnsResult;
    let coverageGateResult: CoverageGateResult | undefined;
    let coverageGateRetries = 0;
    let coverageRetryPrompt: string | undefined;
    try {
      while (true) {
        turns = await this.runAgentTurns(input, plan, coverageRetryPrompt);
        if (!this.coverageGate) break;

        // The gate consumes the persisted trajectory so confirmed tool evidence
        // is auditable. In-memory test trajectories remain fail-closed unless
        // compiled context already covers the required facts.
        await this.trajectory.flush();
        coverageGateResult = this.coverageGate.checkAndBlock({
          evidencePlan: plan,
          // P7 Stage D：coverage gate 读完整轨迹明细（projection 下在内容库），
          // 旧 trajectory.jsonl 已收敛为摘要投影缓存，不再承载 ranked_evidence 明细。
          trajectoryPath: this.trajectory.getDetailOutputPath(),
          inviolableFacts: input.inviolableFacts ?? [],
          contextCoveredFacts: this.collectContextCoveredFacts(input),
          snapshotId: input.snapshotId,
          confirmedCoverage: input.confirmedCoverage,
        });
        if (coverageGateResult.passed) break;

        this.trajectory.recordFailure({
          stage: "must_verify_coverage_gate",
          severity: "hard",
          failureClass: "blocked",
          reason: "P0/P1 mustVerify facts remain uncovered after Agentic retrieval",
          evidence:
            coverageGateResult.failureEnvelope?.evidence ??
            coverageGateResult.unverifiedHighRisk,
          recoverable: true,
          retryPlan:
            coverageGateResult.failureEnvelope?.retryPlan ??
            "agent_loop_retry_with_explicit_must_verify_prompt",
        });

        if (coverageGateRetries >= this.maxCoverageRetries) {
          return this.makeFallback(
            plan,
            turns.sourceRefs,
            "must_verify_coverage_failed",
            turns.evidenceFacts,
            turns.toolCalls,
            coverageGateResult,
            coverageGateRetries,
            {
              firstAction: turns.firstAction,
              actualRetrievalCalls: turns.actualRetrievalCalls,
              draftModelCalls: turns.draftModelCalls,
            },
          );
        }

        coverageGateRetries += 1;
        coverageRetryPrompt = this.buildCoverageRetryPrompt(coverageGateResult);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.trajectory.recordFailure({
        stage: "novelos_draft_generation",
        severity: "recoverable",
        failureClass: "recoverable",
        recoveryAction: "retry_stage",
        reason: `模型调用失败：${errMsg}`,
        recoverable: true,
        retryPlan: "retry_stage_or_checkpoint",
      });
      // AGENTIC-EVIDENCE-MERGE-1 修复：把底层错误消息传入 lineage.failureReason，
      // 让 agentic-raw-candidate-source.ts 的 classifyFailureKind 能识别超时模式
      // （"timed out" / "超时" / "aborted" 等），从而触发 model_timeout 重试条件。
      // 之前只传 stopReason="model_error"，导致所有模型异常都被归为 model_error，
      // 工具层 chapter_level_retry 永远不可达。
      return this.makeFallback(plan, [], "model_error", [], 0, coverageGateResult, coverageGateRetries, undefined, errMsg);
    }

    // ── 预算耗尽或无 draft → fallback ────────────────────────────────────
    if (turns.stopReason === "budget_exhausted") {
      return this.makeFallback(
        plan,
        turns.sourceRefs,
        "budget_exhausted",
        turns.evidenceFacts,
        turns.toolCalls,
        undefined,
        0,
        {
          firstAction: turns.firstAction,
          actualRetrievalCalls: turns.actualRetrievalCalls,
          draftModelCalls: turns.draftModelCalls,
        },
      );
    }
    if (turns.draftText.trim().length === 0) {
      this.trajectory.recordFailure({
        stage: "novelos_draft_generation",
        severity: "recoverable",
        failureClass: "recoverable",
        recoveryAction: "retry_stage",
        reason: "模型未返回有效 draft 文本",
        recoverable: true,
        retryPlan: "retry_stage_or_checkpoint",
      });
      return this.makeFallback(
        plan,
        turns.sourceRefs,
        "model_error",
        turns.evidenceFacts,
        turns.toolCalls,
        undefined,
        0,
        {
          firstAction: turns.firstAction,
          actualRetrievalCalls: turns.actualRetrievalCalls,
          draftModelCalls: turns.draftModelCalls,
        },
        // AGENTIC-EVIDENCE-MERGE-1 修复：传递底层模型错误消息（如超时），
        // 让 classifyFailureKind 能识别 "timed out" 等超时模式 → model_timeout。
        turns.modelErrorMessage,
      );
    }

    // ── 3. 写初稿候选（不可变，append-only）。初验通过前不得推进 current。 ──
    const draftManifest = this.candidateWorkspace.createCandidate({
      text: turns.draftText,
    });

    // ── 4. verifyAndPatch（若 verifier+patchService 已提供） ─────────────
    let finalText = turns.draftText;
    let verifierReport: NarrativeVerifierReport | undefined;
    let patchProposals: PatchProposal[] | undefined;
    let repairRounds = 0;
    let verifierCleared = false;
    let hardFindingCount = 0;
    let repairStopReason: AgentLoopStopReason | undefined;
    // RRB-4.1：模型调用按阶段分账（draft 来自 ReAct 阶段，patch/newCandidate/authorStyle 来自 verifyAndPatch）
    let modelCallsByKind: ModelCallsByKind = {
      draft: turns.draftModelCalls,
      patch: 0,
      newCandidate: 0,
      authorStyle: 0,
    };
    // RRB-4.2：本地验证器运行分账（narrative_verifier / patch_comparator / span_immutability / ...）
    let validatorRuns: Record<string, number> = {};
    // RRB-4.6：多维修订预算快照（verifyAndPatch 返回，无修订时 undefined）。
    let repairBudget: RepairBudgetSnapshot | undefined;

    if (this.verifier && this.patchService) {
      try {
        const vp = await this.verifyAndPatch(turns.draftText, input, plan, draftManifest);
        finalText = vp.text;
        verifierReport = vp.verifierReport;
        patchProposals = vp.patchProposals;
        repairRounds = vp.repairRounds;
        verifierCleared = vp.verifierCleared;
        hardFindingCount = vp.hardFindingCount;
        repairStopReason = vp.stopReason;
        modelCallsByKind = {
          draft: turns.draftModelCalls,
          patch: vp.modelCallsByKind.patch,
          newCandidate: vp.modelCallsByKind.newCandidate,
          authorStyle: vp.modelCallsByKind.authorStyle,
        };
        validatorRuns = vp.validatorRuns;
        repairBudget = vp.repairBudget;
      } catch (err) {
        // verify/patch 失败 → 保留原 draft，不 fallback
        const errMsg = err instanceof Error ? err.message : String(err);
        this.trajectory.recordFailure({
          stage: "novelos_verify_patch",
          severity: "recoverable",
          failureClass: "recoverable",
          recoveryAction: "retry_gate",
          reason: `verify/patch 失败，保留原 draft：${errMsg}`,
          recoverable: true,
          retryPlan: "保留最后已接受候选，verifierCleared=false",
        });
      }
    }

    this.trajectory.recordBudget(this.budget.getSnapshot());

    // ── 5. 记录 lineage + output ────────────────────────────────────────
    const stopReason: AgentLoopStopReason = verifierCleared
      ? "cleared"
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
      firstAction: turns.firstAction,
      actualRetrievalCalls: turns.actualRetrievalCalls,
      modelCallsByKind,
      validatorRuns,
      ...(repairBudget ? { repairBudget } : {}),
      ...(coverageGateResult ? { coverageGate: coverageGateResult } : {}),
      ...(coverageGateRetries > 0 ? { coverageGateRetries } : {}),
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
   * Phase 2C：接收 EvidencePlan 参数，把 plan.mustVerify 注入 prompt 作为
   * "本章必须验证的事实点" block，引导 Agentic 优先检索这些事实。
   */
  private async runAgentTurns(
    input: AgentLoopInput,
    plan: EvidencePlan,
    coverageRetryPrompt?: string,
  ): Promise<AgentTurnsResult> {
    // R6 修复：eval 模式下注入【前文】段，确保 agentic 生成续写同一故事。
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
    );
    // Phase 2C：注入 mustVerify 事实点，引导 Agentic 优先检索这些事实。
    if (plan.mustVerify.length > 0) {
      promptParts.push(
        "本章必须验证的事实点（优先检索这些事实，确保正文不违反已确立设定）：",
        ...plan.mustVerify.map((item) => `  - ${item}`),
        "",
      );
    }
    // Phase 2D（缺口三）：注入已知事实摘要行（从 CompiledContext 提取，≤80字/条，≤12条）。
    // 让模型知道哪些事实已确认无需再检索，减少无效工具调用。
    if (plan.known.length > 0) {
      promptParts.push(
        "已知事实摘要（以下事实已确认，无需重复检索，可直接用于正文）：",
        ...plan.known.map((item) => `  - ${item}`),
        "",
      );
    }
    // AGENTIC-EVIDENCE-MERGE-1：不再注入模型决策字段（unknown/queries/needRetrieval/retrievalDepth 已移除）。
    // Agentic 在同一 ReAct 循环内自主决定是否检索。
    // 系统通过 mustVerify 注入 + retrievalCallLimit（runtime beforeToolCall 强制）保证安全。
    if (plan.mustVerify.length === 0) {
      promptParts.push(
        "当前上下文已充分，如无必要可直接基于本章意图与种子上下文生成正文。",
        "",
      );
    }
    // AGENTIC-EVIDENCE-MERGE-1：默认使用不确定性驱动的检索决策规则。
    // eval-only：retrievalPromptOverride 覆盖默认 prompt（A/B 对照实验用）。
    // - 生产路径不传此字段 → 使用 DEFAULT_UNCERTAINTY_DRIVEN_PROMPT（不确定性驱动）
    // - eval A 组 → 传入 FORCED_RETRIEVAL_PROMPT（保持旧强制检索行为）
    // - eval B 组 → 传入 UNCERTAINTY_DRIVEN_RETRIEVAL_PROMPT（与默认一致）
    if (input.retrievalPromptOverride) {
      promptParts.push(input.retrievalPromptOverride);
    } else {
      promptParts.push(DEFAULT_UNCERTAINTY_DRIVEN_PROMPT);
    }
    if (coverageRetryPrompt) {
      promptParts.push("", coverageRetryPrompt);
    }
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

    // AGENTIC-EVIDENCE-MERGE-1 可观测性：统计首回合动作 / 实际检索调用数 / ReAct 阶段模型调用数
    // （不记录原始思维链，只根据实际消息与工具调用断言动作）
    const assistantMessages = messages.filter(
      (m) => (m as { role?: string }).role === "assistant",
    );
    const draftModelCalls = assistantMessages.length;
    const firstAssistant = assistantMessages[0];
    const firstAssistantContent = Array.isArray(
      (firstAssistant as { content?: unknown })?.content,
    )
      ? (firstAssistant as { content: Array<{ type?: string }> }).content
      : [];
    const firstAction: "draft" | "tool_call" = firstAssistantContent.some(
      (c) => c.type === "toolCall",
    )
      ? "tool_call"
      : "draft";
    // 实际检索调用 = toolResult 消息中工具名属于检索集的数量
    const actualRetrievalCalls = messages.filter((m) => {
      const role = (m as { role?: string }).role;
      if (role !== "toolResult") return false;
      const toolName = (m as { toolName?: string }).toolName ?? "";
      return RETRIEVAL_TOOL_NAMES.has(toolName);
    }).length;

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

    // AGENTIC-EVIDENCE-MERGE-1 修复：从 assistant 消息提取模型错误消息。
    // streamFn 把 modelGenerate 异常转为 stream error 事件，pi-agent-core
    // 把 error.errorMessage 存入 assistant 消息。此处提取供 makeFallback
    // 传入 lineage.failureReason，让 classifyFailureKind 能识别超时模式。
    let modelErrorMessage: string | undefined;
    for (const msg of messages) {
      const m = msg as { role?: string; errorMessage?: string; stopReason?: string };
      if (m.role === "assistant" && typeof m.errorMessage === "string" && m.errorMessage.length > 0) {
        modelErrorMessage = m.errorMessage;
        // 若检测到模型错误，且 draft 为空，覆盖 stopReason 为 model_error
        if (draftText.trim().length === 0 && stopReason !== "budget_exhausted") {
          stopReason = "model_error";
        }
        break;
      }
    }

    return {
      draftText,
      sourceRefs,
      evidenceFacts,
      toolCalls,
      stopReason,
      firstAction,
      actualRetrievalCalls,
      draftModelCalls,
      ...(modelErrorMessage ? { modelErrorMessage } : {}),
    };
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
   * Phase 2C：接收 EvidencePlan，用 plan.stopConditions.maxStagnantRounds
   * 驱动停滞退出（替代硬编码 MAX_STAGNANT_REPAIR_ROUNDS）。
   */
  private async verifyAndPatch(
    draftText: string,
    input: AgentLoopInput,
    plan: EvidencePlan,
    draftManifest: CandidateRevisionManifest,
  ): Promise<VerifyPatchResult> {
    const patchService = this.patchService!;
    // Phase 2C：从 plan 读取停滞阈值（默认与 MAX_STAGNANT_REPAIR_ROUNDS 一致）
    const maxStagnant = plan.stopConditions.maxStagnantRounds;

    // RRB-4.1 / RRB-4.2：模型调用与本地验证器运行分账。本地 verifier.verify()
    // 不计入 modelCalls，走 ValidatorRunMeter；模型 wrapper 是 model call 唯一计数点。
    const modelMeter = createModelCallMeter();
    const validatorMeter = createValidatorRunMeter();

    // RRB-3.7：权威证据记录由 orchestrator 注入；缺省为空 → 自动修订 fail-closed。
    const evidenceRecords: ReadonlyArray<EvidenceRecord> = input.evidenceRecords ?? [];

    // 当前已接受候选身份来自初稿 manifest；current pointer 仅在验证通过后推进。
    let acceptedText = draftText;
    let acceptedManifest: CandidateRevisionManifest | null = draftManifest;

    // 1. 初次 verify
    let report = this.verifyText(draftText, input, validatorMeter, acceptedManifest?.candidateId);
    this.candidateWorkspace.saveVerifierReport(report);
    this.trajectory.recordVerifierReport(report);

    // 2. 无硬失败 → 初稿被接受，此时才推进 current
    if (!report.hasHardFailure) {
      this.candidateWorkspace.advanceCurrentCandidate(draftManifest);
      return {
        text: draftText,
        verifierReport: report,
        patchProposals: [],
        repairRounds: 0,
        verifierCleared: true,
        hardFindingCount: 0,
        modelCallsByKind: modelMeter.getModelCallsByKind(),
        validatorRuns: validatorMeter.getValidatorRunsByKind(),
        // RRB-4.6：无修订发生时的预算快照（modelCalls/authorizations/candidates 均为 0）。
        repairBudget: buildRepairBudgetSnapshot(
          {
            modelCalls: modelMeter.getTotalModelCalls(),
            authorizations: 0,
            candidates: 0,
            validatorRuns: validatorMeter.getTotalValidatorRuns(),
          },
          this.repairBudgetConfig,
        ),
      };
    }

    // 3. 每轮只修有限批次，避免把整章所有约束一次性压给模型。
    // P0-3：传入 semanticRepairTracker，过滤已达 semantic 修复预算的 finding。
    let selectedFindings = selectRepairFindings(report.hardFindings, DEFAULT_REPAIR_BATCH_SIZE, this.semanticRepairTracker);
    let repairRounds = 0;
    let stagnantRounds = 0;
    // RRB-4.4：修订循环退出原因收敛为 RepairStopReason（不再把所有失败折叠成 stagnant）。
    let stopReason: RepairStopReason | undefined;
    let proposals: PatchProposal[] = [];
    // RRB-4.6：多维修订预算累计计数。modelCalls/validatorRuns 从 meter 读（RRB-4.3 唯一计数点），
    // authorizations/candidates 无独立 meter，由 loop 在签发授权 / 创建子候选的计数点本地累加。
    let authorizationCount = 0;
    let candidateCount = 0;
    const repairCounts = (): RepairBudgetCounts => ({
      modelCalls: modelMeter.getTotalModelCalls(),
      authorizations: authorizationCount,
      candidates: candidateCount,
      validatorRuns: validatorMeter.getTotalValidatorRuns(),
    });

    // 4. 修复循环
    while (repairRounds < this.maxRepairRounds) {
      if (this.budget.isExhausted()) {
        stopReason = "budget_exhausted";
        break;
      }
      // RRB-4.6：多维修订预算——任一维度触顶即 budget_exhausted 退出（防止只限轮次）。
      const budgetCheck = checkRepairBudget(repairCounts(), this.repairBudgetConfig);
      if (budgetCheck.exhausted) {
        stopReason = "budget_exhausted";
        this.trajectory.recordFailure({
          stage: "novelos_repair_budget",
          severity: "blocked",
          failureClass: "blocked",
          reason: `修订预算耗尽（${budgetCheck.exhaustedDimension}），保留最后已接受候选`,
          evidence: { ...repairCounts(), exhaustedDimension: budgetCheck.exhaustedDimension },
          recoverable: false,
        });
        break;
      }
      if (selectedFindings.length === 0) {
        stopReason = "stagnant";
        break;
      }

      // RRB-3.7：逐 finding 授权，仅放行通过全部准入条件的 finding。
      const { authorizations, denyReasonCodes } = this.authorizeRepairFindings(
        selectedFindings,
        acceptedText,
        evidenceRecords,
        input.snapshotId,
        acceptedManifest,
        repairRounds,
      );
      const authorizedFindings = selectedFindings.filter((f) => authorizations.has(f.id));

      if (authorizedFindings.length === 0) {
        // 无授权动作 → fail-closed 停止，正文保持不变（RRB-3.7）。
        // RRB-4.4：按拒绝理由码给出可解释的单一退出原因，不再一律 stagnant。
        stopReason = classifyNoAuthorizationStopReason(denyReasonCodes);
        this.trajectory.recordFailure({
          stage: "novelos_repair_authorization",
          severity: "blocked",
          failureClass: "blocked",
          reason: `全部候选 finding 未通过修订授权（${stopReason}），自动修订被拒绝`,
          evidence: { deniedFindingIds: selectedFindings.map((f) => f.id), denyReasonCodes },
          recoverable: false,
        });
        break;
      }

      // RRB-4.6：累计本轮签发的修订授权（按 finding 计），供多维修订预算约束。
      authorizationCount += authorizedFindings.length;

      // P0-3：本轮修复前标记 semantic finding 已修复（避免下轮重复修同一 finding）
      for (const finding of authorizedFindings) {
        if (isSemanticFinding(finding)) {
          this.semanticRepairTracker.set(
            finding.id,
            (this.semanticRepairTracker.get(finding.id) ?? 0) + 1,
          );
        }
      }

      repairRounds++;

      // RRB-3.4：本轮全部授权 span（联合校验用，来自签发授权 authorizedRanges）
      const authorizedRanges = this.collectAuthorizedRanges(authorizedFindings, authorizations);

      // 仅为授权 finding 产生 patch proposals
      const feedbacks = authorizedFindings.map(findingToFeedback);
      proposals = patchService.proposePatches(acceptedText, feedbacks);
      this.candidateWorkspace.savePatchProposals(proposals);
      for (const p of proposals) this.trajectory.recordPatchProposal(p);

      const consumeResult = this.consumeAuthorizedReservations(
        authorizations,
        authorizedFindings,
        acceptedText,
        input.snapshotId,
      );
      if (!consumeResult.ok) {
        stopReason = "stale_authorization";
        this.trajectory.recordFailure({
          stage: "novelos_repair_authorization",
          severity: "blocked",
          failureClass: "blocked",
          reason: `授权 reservation 执行校验失败（${consumeResult.reasonCode}）：${consumeResult.reason}`,
          evidence: { reasonCode: consumeResult.reasonCode },
          recoverable: false,
        });
        break;
      }

      const wantsNewCandidate = this.shouldGenerateNewCandidate(
        authorizedFindings,
        authorizations,
        proposals,
        acceptedText,
      );

      // 生成修订文本：局部 patch 或显式 new_candidate，禁止整章 rewrite fallback
      let patchedText: string;
      const generateKind = wantsNewCandidate ? "newCandidate" : "patch";
      try {
        patchedText = wantsNewCandidate
          ? await this.generateNewCandidate(acceptedText, authorizedFindings)
          : await this.generatePatchedText(
            acceptedText,
            proposals,
            authorizedFindings,
          );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        modelMeter.recordModelCall({ kind: generateKind, success: false });
        for (const proposal of proposals) {
          proposal.rejected = true;
          proposal.rejectionReason = errMsg;
        }
        this.candidateWorkspace.savePatchProposals(proposals);
        this.trajectory.recordFailure({
          stage: wantsNewCandidate ? "novelos_new_candidate_generation" : "novelos_patch_generation",
          severity: "recoverable",
          failureClass: "recoverable",
          recoveryAction: "retry_gate",
          reason: `${generateKind} 生成失败：${errMsg}`,
          recoverable: true,
          retryPlan: "保留原 draft，verifierCleared=false",
        });
        break;
      }
      modelMeter.recordModelCall({ kind: generateKind, success: true });

      // RRB-3.4：局部 patch 做联合 span 校验。纯 new_candidate 只做退化长度检查。
      const onlyNewCandidate = authorizedFindings.every(
        (finding) => authorizations.get(finding.id)?.action === "new_candidate",
      );
      if (!onlyNewCandidate) {
        const evalResult = patchService.evaluatePatch(acceptedText, patchedText, authorizedRanges, proposals);
        validatorMeter.recordValidatorRun({
          kind: "patch_comparator",
          candidateId: acceptedManifest?.candidateId,
          outcome: evalResult.accepted ? "passed" : "failed",
        });
        this.candidateWorkspace.savePatchProposals(proposals);

        if (!evalResult.accepted) {
          // 退化 → 保留上一候选，不移动 current pointer（RRB-3.6）
          stopReason = "comparator_rejected";
          break;
        }
      } else {
        const lengthRatio = acceptedText.length > 0 ? patchedText.length / acceptedText.length : 1;
        if (lengthRatio < 0.7) {
          const reason = `new_candidate 正文大幅缩短（ratio=${lengthRatio.toFixed(2)}），视为退化`;
          for (const proposal of proposals) {
            proposal.rejected = true;
            proposal.rejectionReason = reason;
          }
          this.candidateWorkspace.savePatchProposals(proposals);
          stopReason = "comparator_rejected";
          break;
        }
        this.candidateWorkspace.savePatchProposals(proposals);
      }

      // reverify（本地 validator，不计入模型调用）
      const nextReport = this.verifyText(patchedText, input, validatorMeter, undefined);
      this.candidateWorkspace.saveVerifierReport(nextReport);
      this.trajectory.recordVerifierReport(nextReport);

      // RRB-4.5：身份级进展判断（比较 finding identity，非数量）。
      const identityCheck = this.compareFindingIdentity(report.hardFindings, nextReport.hardFindings);

      // RRB-3.6：新增 hard finding（identity 换新）→ 整轮拒绝，current pointer 保持不变
      if (identityCheck.newFindingIds.length > 0) {
        this.trajectory.recordFailure({
          stage: "novelos_post_verification_gate",
          severity: "blocked",
          failureClass: "blocked",
          reason: `修订引入了新的 hard finding（identity 换新）：${identityCheck.newFindingIds.join(",")}，整轮拒绝`,
          evidence: {
            newFindingIds: identityCheck.newFindingIds,
            previousFindingIds: report.hardFindings.map((f) => f.id),
          },
          recoverable: false,
        });
        // RRB-4.4：修订引入新 hard finding 是独立退出原因。
        stopReason = "new_hard_finding";
        break;
      }

      // 生成不可变 child candidate（RRB-2.3）：gate 通过才创建并推进 pointer
      const derivationType = wantsNewCandidate
        ? "new_candidate"
        : this.deriveTypeForAuthorizedFindings(proposals);
      const authorizationId = this.pickAuthorizationId(authorizedFindings, authorizations);
      const childManifest = this.candidateWorkspace.deriveChildCandidate({
        parentManifest: acceptedManifest,
        childText: patchedText,
        derivationType,
        authorizationId,
      });

      // 已通过 post-verification gate 的候选成为新的当前候选
      acceptedText = patchedText;
      acceptedManifest = childManifest;
      this.candidateWorkspace.advanceCurrentCandidate(childManifest);
      // RRB-4.6：累计创建的子候选数，供多维修订预算约束。
      candidateCount++;
      report = nextReport;

      this.trajectory.recordRepairRound({
        round: repairRounds,
        hardFindingsBefore: identityCheck.previousCount,
        hardFindingsAfter: identityCheck.nextCount,
        selectedFindingIds: authorizedFindings.map((finding) => finding.id),
        resolvedFindingIds: identityCheck.resolvedIds,
        remainingFindingIds: identityCheck.remainingIds,
        stagnantRounds,
        derivationType,
        authorizationId,
      });

      if (!nextReport.hasHardFailure) {
        // 清零 → 用 patchedText 返回
        return {
          text: patchedText,
          verifierReport: nextReport,
          patchProposals: proposals,
          repairRounds,
          verifierCleared: true,
          hardFindingCount: 0,
          modelCallsByKind: modelMeter.getModelCallsByKind(),
          validatorRuns: validatorMeter.getValidatorRunsByKind(),
          repairBudget: buildRepairBudgetSnapshot(repairCounts(), this.repairBudgetConfig),
        };
      }

      // 仍有硬失败 → 身份级进展决定停滞计数（RRB-4.5）
      stagnantRounds = identityCheck.madeProgress ? 0 : stagnantRounds + 1;

      if (stagnantRounds >= maxStagnant) {
        stopReason = "stagnant";
        break;
      }

      // 仍有硬失败 → 选择下一有限批次进入下轮
      // P0-3：传入 semanticRepairTracker，过滤已达 semantic 修复预算的 finding
      selectedFindings = selectRepairFindings(report.hardFindings, DEFAULT_REPAIR_BATCH_SIZE, this.semanticRepairTracker);
    }

    // 5. 循环结束仍有硬失败 → 保留最后一个通过 gate 的候选供诊断。
    // 上层仍以 verifierCleared=false hard block，候选不会保存为正式章节。
    return {
      text: acceptedText,
      verifierReport: report,
      patchProposals: proposals,
      repairRounds,
      verifierCleared: false,
      hardFindingCount: report.hardFindings.length,
      modelCallsByKind: modelMeter.getModelCallsByKind(),
      validatorRuns: validatorMeter.getValidatorRunsByKind(),
      repairBudget: buildRepairBudgetSnapshot(repairCounts(), this.repairBudgetConfig),
      ...(stopReason ? { stopReason } : {}),
    };
  }

  // ── 内部：Wave 3 授权 / 候选谱系 / 计量辅助方法 ──────────────────────

  /**
   * 本地 verifier 运行（RRB-4.2）：不计入模型调用，走 ValidatorRunMeter。
   * 只有 verifier 运行计数点；禁止调用方手工 `+= 1`（RRB-4.3）。
   */
  private verifyText(
    text: string,
    input: AgentLoopInput,
    validatorMeter: ValidatorRunMeter,
    candidateId?: string,
  ): NarrativeVerifierReport {
    const report = this.verifier!.verify({
      text,
      context: input.context,
      chapterIntent: input.chapterIntent,
      knownCharacterNames: input.knownCharacterNames,
      inviolableFacts: input.inviolableFacts,
    });
    validatorMeter.recordValidatorRun({
      kind: "narrative_verifier",
      candidateId,
      outcome: report.hasHardFailure ? "failed" : "passed",
    });
    return report;
  }

  /** 读取当前候选 manifest（无则 null）。 */
  private readCurrentManifest(): CandidateRevisionManifest | null {
    const currentId = this.candidateWorkspace.getCurrentCandidateId();
    if (currentId === null) return null;
    return this.candidateWorkspace.readCandidateManifest(currentId);
  }

  /**
   * 逐 finding 授权（RRB-3.7）：调用 evaluateRepairAuthorization 做 §3.2 全部
   * 准入条件 fail-closed 评估，返回 findingId → RepairAuthorization 的 Map。
   *
   * fail-closed 前置：无 current candidate（缺候选身份）或 snapshotId 缺失时，
   * 无法把授权绑定到候选/snapshot，直接拒绝全部（返回空 Map）。
   */
  private authorizeRepairFindings(
    findings: VerificationFinding[],
    acceptedText: string,
    evidenceRecords: ReadonlyArray<EvidenceRecord>,
    snapshotId: string | undefined,
    acceptedManifest: CandidateRevisionManifest | null,
    roundIndex: number,
  ): { authorizations: Map<string, RepairAuthorization>; denyReasonCodes: RepairReasonCode[] } {
    const authorizations = new Map<string, RepairAuthorization>();
    const denyReasonCodes: RepairReasonCode[] = [];
    if (!acceptedManifest || !snapshotId) {
      return { authorizations, denyReasonCodes };
    }
    const candidateId = acceptedManifest.candidateId;
    const candidateTextHash = hashText(acceptedText);
    for (const finding of findings) {
      const decision = evaluateRepairAuthorization({
        finding,
        evidenceRecords,
        candidateId,
        candidateTextHash,
        candidateTextLength: acceptedText.length,
        snapshotId,
        budgetAvailable: !this.budget.isExhausted(),
        orchestratorDecisionId: `decision-${candidateId}-r${roundIndex}`,
      });
      if (decision.decision === "authorized" && decision.authorization) {
        authorizations.set(
          finding.id,
          this.authorizationLedger.register(decision.authorization),
        );
      } else {
        // RRB-4.4：保留拒绝理由码，供上层把「无授权动作」细分为
        // stale_authorization / blocked / request_new_candidate / no_authorized_action。
        denyReasonCodes.push(decision.reasonCode);
      }
    }
    return { authorizations, denyReasonCodes };
  }

  /**
   * RRB-4.5：身份级进展判断。比较 finding identity（failureType + span），
   * 而非数量。madeProgress = 有 resolved 且无新增（identity 换新）。
   */
  private compareFindingIdentity(
    previous: VerificationFinding[],
    next: VerificationFinding[],
  ): {
    previousCount: number;
    nextCount: number;
    resolvedIds: string[];
    remainingIds: string[];
    newFindingIds: string[];
    madeProgress: boolean;
  } {
    const prevKeys = new Set(previous.map((f) => this.findingIdentityKey(f)));
    const nextKeys = new Set(next.map((f) => this.findingIdentityKey(f)));
    const resolvedIds: string[] = [];
    const remainingIds: string[] = [];
    for (const f of previous) {
      if (nextKeys.has(this.findingIdentityKey(f))) remainingIds.push(f.id);
      else resolvedIds.push(f.id);
    }
    const newFindingIds = next
      .filter((f) => !prevKeys.has(this.findingIdentityKey(f)))
      .map((f) => f.id);
    const madeProgress = resolvedIds.length > 0 && newFindingIds.length === 0;
    return {
      previousCount: previous.length,
      nextCount: next.length,
      resolvedIds,
      remainingIds,
      newFindingIds,
      madeProgress,
    };
  }

  /** finding identity key（RRB-4.5）：failureType + span。 */
  private findingIdentityKey(finding: VerificationFinding): string {
    return `${finding.failureType}:${finding.span.start}:${finding.span.end}`;
  }

  /** RRB-3.4：收集本轮全部授权范围（来自签发授权 authorizedRanges）。 */
  private collectAuthorizedRanges(
    findings: VerificationFinding[],
    authorizations: Map<string, RepairAuthorization>,
  ): TextSpan[] {
    const ranges: TextSpan[] = [];
    for (const finding of findings) {
      const auth = authorizations.get(finding.id);
      if (!auth) continue;
      ranges.push(...auth.authorizedRanges);
    }
    return ranges;
  }

  /** 由 patch proposals 推导子候选派生类型（RRB-2.3），取最高干预级。 */
  private deriveTypeForAuthorizedFindings(
    proposals: PatchProposal[],
  ): CandidateDerivationType {
    const priorities: Record<CandidateDerivationType, number> = {
      agentic_generation: 0,
      span_patch: 1,
      paragraph_patch: 2,
      bridge_patch: 3,
      new_candidate: 4,
      author_style_transform: 0,
      user_edit: 0,
    };
    let best: CandidateDerivationType = "span_patch";
    for (const p of proposals) {
      const t = patchTypeToDerivationType(p.type);
      if (priorities[t] > priorities[best]) best = t;
    }
    return best;
  }

  private shouldGenerateNewCandidate(
    findings: VerificationFinding[],
    authorizations: Map<string, RepairAuthorization>,
    proposals: PatchProposal[],
    draftText: string,
  ): boolean {
    if (findings.some((finding) => authorizations.get(finding.id)?.action === "new_candidate")) {
      return true;
    }
    return proposals.some((proposal) => !isLocalReplacementProposal(proposal, draftText.length));
  }

  private consumeAuthorizedReservations(
    authorizations: Map<string, RepairAuthorization>,
    findings: VerificationFinding[],
    acceptedText: string,
    snapshotId: string | undefined,
  ): { ok: boolean; reasonCode?: string; reason?: string } {
    if (!snapshotId) {
      return { ok: false, reasonCode: "stale_authorization", reason: "执行时 snapshotId 缺失" };
    }
    const currentHash = hashText(acceptedText);
    for (const finding of findings) {
      const authorization = authorizations.get(finding.id);
      if (!authorization) continue;
      const consumed = this.authorizationLedger.consume(authorization, currentHash, snapshotId);
      if (!consumed.ok) {
        return consumed;
      }
    }
    return { ok: true };
  }

  private async generateNewCandidate(
    originalDraft: string,
    findings: VerificationFinding[],
  ): Promise<string> {
    const userPrompt = buildNewCandidatePrompt(originalDraft, findings);
    await this.runtime.prompt(userPrompt);
    await this.runtime.waitForIdle();
    const modelOutput = extractLastAssistantText(this.runtime);
    if (modelOutput.trim().length === 0) {
      throw new Error("new_candidate 模型未返回有效文本");
    }
    return modelOutput;
  }

  /** 从授权 findings 中取一个 authorizationId（子候选关联授权，RRB-2.3）。 */
  private pickAuthorizationId(
    findings: VerificationFinding[],
    authorizations: Map<string, RepairAuthorization>,
  ): string | null {
    for (const finding of findings) {
      const auth = authorizations.get(finding.id);
      if (auth) return auth.authorizationId;
    }
    return null;
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

    // P0-3：判断是否使用局部 replacement 模式
    const allLocalReplacement = activeProposals.length > 0
      && activeProposals.every((p) => isLocalReplacementProposal(p, originalDraft.length));

    if (!allLocalReplacement) {
      throw new Error(
        "整章 rewrite fallback 已禁用；非整章局部修复必须走显式 new_candidate",
      );
    }

    const userPrompt = buildLocalReplacementPrompt(originalDraft, activeProposals, findings);

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

    // P1-4 修复：局部 replacement 模式 → 解析替换文本并合并到原 draft
    // **解析失败时不返回模型原始输出**：模型被要求只输出 span 内替换文本，
    // 若解析失败说明输出格式不符，直接返回会把局部片段当完整正文保存，污染章节。
    // 改为抛错，由上层 verifyAndPatch 的 catch 兜底（保留上一候选，verifierCleared=false）。
    if (allLocalReplacement) {
      const merged = applyLocalReplacements(originalDraft, activeProposals, modelOutput);
      if (merged === null) {
        throw new Error(
          `局部替换解析失败：模型输出未包含 [替换N] 块或格式不符，丢弃本次输出保留原 draft`,
        );
      }
      return merged;
    }

    return modelOutput;
  }

  /** Flatten authoritative compiled-context text for deterministic coverage matching. */
  private collectContextCoveredFacts(input: AgentLoopInput): string[] {
    const ctx = input.context;
    return [
      ...(ctx?.facts ?? []).map((fact) => fact.content),
      ...(input.inviolableFacts ?? []),
      ...(ctx?.characterStates ?? []).map((state) =>
        `${state.name} ${JSON.stringify(state.state)}`,
      ),
      ...(ctx?.openLoops ?? []).map((loop) => loop.description),
      ...(ctx?.worldRules ?? []).map((rule) => rule.description),
    ].filter((fact) => fact.trim().length > 0);
  }

  /** Build a bounded retry instruction from the gate's concrete evidence. */
  private buildCoverageRetryPrompt(result: CoverageGateResult): string {
    const items = result.unverifiedHighRisk.map(
      (item) => `  - [${item.riskLevel}] ${item.item}: ${item.reason}`,
    );
    return [
      "事实覆盖门重试要求：以下高风险事实尚未获得 confirmed 证据。",
      ...items,
      "请先使用允许的叙事检索工具逐项查证，并让工具返回可追溯 sourceRef；",
      "在证据覆盖前不要声称事实已确认，也不要用猜测替代检索。",
    ].join("\n");
  }

  // ── 内部：构造 fallback 结果 ──────────────────────────────────────────

  private makeFallback(
    plan: EvidencePlan,
    sourceRefs: string[],
    stopReason: AgentLoopStopReason,
    evidenceFacts: string[] = [],
    toolCalls = 0,
    coverageGate?: CoverageGateResult,
    coverageGateRetries = 0,
    /**
     * AGENTIC-EVIDENCE-MERGE-1：fallback 仍应保留已发生的首动作 / 检索次数，
     * 避免 coverage 负例与 model_error 路径把可观测字段清零成 not_run/0。
     * 未提供时（如 runtime 异常未进入 turns）才回退到 draft/0。
     */
    observed?: {
      firstAction?: "draft" | "tool_call";
      actualRetrievalCalls?: number;
      draftModelCalls?: number;
    },
    /**
     * AGENTIC-EVIDENCE-MERGE-1 修复：底层错误消息（来自 catch 块的 errMsg）。
     * 传入 lineage.failureReason，让 source 的 classifyFailureKind 能识别超时模式。
     */
    failureReason?: string,
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
      firstAction: observed?.firstAction ?? "draft",
      actualRetrievalCalls: observed?.actualRetrievalCalls ?? 0,
      modelCallsByKind: {
        draft: observed?.draftModelCalls ?? 0,
        patch: 0,
        newCandidate: 0,
        authorStyle: 0,
      },
      ...(coverageGate ? { coverageGate } : {}),
      ...(coverageGateRetries > 0 ? { coverageGateRetries } : {}),
      ...(failureReason ? { failureReason } : {}),
    };
    this.candidateWorkspace.saveLineage(lineage);
    this.trajectory.recordFailure({
      stage: "novelos_agent_loop",
      severity: "recoverable",
      failureClass: "recoverable",
      recoveryAction: "retry_stage",
      reason: `agent loop fallback: ${stopReason}`,
      recoverable: true,
      retryPlan: "retry_stage_or_checkpoint",
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
// PatchType → CandidateDerivationType（RRB-2.3）
// ============================================================================

/**
 * 把 patch 类型映射为候选派生类型：
 * - bridge_patch → bridge_patch
 * - paragraph_patch / event_patch → paragraph_patch
 * - sentence_patch → span_patch
 */
function patchTypeToDerivationType(type: PatchType): CandidateDerivationType {
  switch (type) {
    case "bridge_patch":
      return "bridge_patch";
    case "paragraph_patch":
    case "event_patch":
      return "paragraph_patch";
    case "sentence_patch":
      return "span_patch";
    default:
      return "span_patch";
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

// ============================================================================
// 无授权动作 → RepairStopReason 细分（RRB-4.4）
// ============================================================================

/**
 * RRB-4.4：当所有候选 finding 都未通过修订授权时，按拒绝理由码把退出原因
 * 细分为单一可解释枚举，而不是一律 stagnant：
 *
 * - stale_authorization  命中 snapshot 过期 / 父候选 hash 变化 / evidence hash 不匹配
 * - blocked              命中 require_block / require_input_revision（如作者输入自相矛盾）
 * - request_new_candidate 命中 require_new_candidate（灾难级契约失败需重生成）
 * - no_authorized_action  其余（缺权威证据 / 确定性不足 / span 非法 / 非编排器签发等）
 */
export function classifyNoAuthorizationStopReason(
  denyReasonCodes: readonly RepairReasonCode[],
): RepairStopReason {
  if (
    denyReasonCodes.some(
      (c) =>
        c === "deny_stale_snapshot" ||
        c === "deny_stale_candidate_hash" ||
        c === "deny_evidence_hash_mismatch",
    )
  ) {
    return "stale_authorization";
  }
  if (denyReasonCodes.some((c) => c === "require_block" || c === "require_input_revision")) {
    return "blocked";
  }
  if (denyReasonCodes.some((c) => c === "require_new_candidate")) {
    return "request_new_candidate";
  }
  return "no_authorized_action";
}

function isLocalReplacementProposal(proposal: PatchProposal, draftLength: number): boolean {
  if (proposal.localReplacement === true) return true;
  if (proposal.localReplacement === false) return false;
  const span = proposal.targetSpan;
  if (!span) return false;
  return !(span.start === 0 && span.end === draftLength);
}

function extractLastAssistantText(runtime: NovelOSRuntime): string {
  const messages = runtime.agent.state.messages;
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
  return textBlocks.map((b) => b.text).join("");
}
