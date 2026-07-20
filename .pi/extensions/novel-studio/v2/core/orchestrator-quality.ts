/**
 * orchestrator-quality - 统一主链路"质量证据"(QUALITY-12/13/14/15/16)相位
 *
 * 从 unified-orchestrator.ts 抽出（行为保持重构 Step 4）。
 * 包含：editorial 证据响应 trace / 候选风险 advisory / 裁判证据附件 /
 * 质量证据运行报告 / 报告导出 / 报告路径。5 个纯函数 + exportQualityEvidenceReport
 * （需 orch.authorizeCapability 做能力校验）。
 */

import type { UnifiedOrchestrator } from "./unified-orchestrator.js";
import type { UnifiedOrchestratorInput, ControlPlaneTrace } from "./orchestrator-types.js";
import type { Candidate } from "./types.js";
import type { ArbitratorResult } from "./judge-arbitrator.js";
import type { EditorialOpportunityAdvisory } from "./editorial-opportunity-advisory.js";
import { atomicSave } from "./orchestrator-commit-save.js";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import {
  compileEditorialEvidenceResponseTrace,
  skippedEditorialEvidenceResponseTraceSet,
  type EditorialEvidenceResponseTrace,
  type CompileTraceInput,
} from "./editorial-evidence-response-trace.js";
import {
  compileEditorialCandidateRiskAdvisory,
  skippedEditorialCandidateRiskAdvisorySet,
  type CompileRiskAdvisoryInput,
} from "./editorial-candidate-risk-advisory.js";
import {
  compileJudgeEvidenceAdvisoryAttachment,
  skippedJudgeEvidenceAdvisoryAttachment,
  type CompileAttachmentInput,
} from "./judge-evidence-advisory-attachment.js";
import {
  compileQualityEvidenceRunReport,
  skippedQualityEvidenceRunReport,
  type CompileRunReportInput,
} from "./quality-evidence-run-report.js";

// ==========================================================================
// QUALITY-12：候选对诊断证据的响应 trace
// ==========================================================================

/**
 * 对每个 editorial candidate 编译 EditorialEvidenceResponseTrace。
 *
 * - editorial candidate 存在时，为每个 candidate 写入 response trace。
 * - no-op / 无 candidate 时不伪造 trace，写 skipped 标记。
 * - trace 异常 → skipped trace + warning，不阻断流程。
 * - trace 不改 finalText，不触发 StyleShaper，不改 judge/selection，不是 hard gate。
 *
 * 接入位置：Stage 4.5（editorial candidate 生成后、FactGuard 之前）。
 */
export function runEditorialEvidenceResponseTraces(
  editorialCandidates: Candidate[],
  rawText: string,
  rawCraftAdvisory: EditorialOpportunityAdvisory,
  stageResults: Record<string, unknown>,
  warnings: string[]
): void {
  // 无 editorial candidate → 不伪造 trace，写 skipped 标记
  if (editorialCandidates.length === 0) {
    stageResults.editorialEvidenceResponseTraces =
      skippedEditorialEvidenceResponseTraceSet(
        "无 editorial candidate 生成（no-op），未编译 response trace"
      );
    return;
  }

  try {
    const traces: EditorialEvidenceResponseTrace[] = editorialCandidates.map(
      (ec) => {
        const traceInput: CompileTraceInput = {
          rawCraftEvidenceEnvelope: stageResults.rawCraftEvidenceEnvelope as unknown as import("./craft-evidence-envelope.js").CraftEvidenceEnvelope,
          editorialOpportunityAdvisory: rawCraftAdvisory,
          rawText,
          editorialText: ec.text,
          candidateId: ec.id,
          hypothesisId: ec.hypothesisId,
        };
        return compileEditorialEvidenceResponseTrace(traceInput);
      }
    );
    stageResults.editorialEvidenceResponseTraces = traces;
  } catch (e: unknown) {
    // trace 编译异常 → skipped，不阻断流程
    const msg = e instanceof Error ? e.message : String(e);
    warnings.push(`editorial evidence response trace 编译异常（降级 skipped，不阻断）：${msg}`);
    stageResults.editorialEvidenceResponseTraces =
      skippedEditorialEvidenceResponseTraceSet(`trace 编译异常：${msg}`);
  }
}

// ==========================================================================
// QUALITY-13：候选是否未回应关键诊断证据的风险审计 advisory
// ==========================================================================

/**
 * 对每个 editorial candidate 编译风险审计 advisory。
 *
 * - 基于 QUALITY-12 的 EditorialEvidenceResponseTrace，聚合每条 item 的 responseType/status，
 *   按保守优先级判定 advisoryLevel（none/watch/risk/unverified）。
 * - editorial candidate 存在时，为每个 candidate 写入一条 risk advisory。
 * - no-op / 无 candidate / trace 为 skipped set 时不伪造 advisory，写 skipped 标记。
 * - advisory 异常 → skipped advisory + warning，不阻断流程。
 * - advisory 不改 finalText，不触发 StyleShaper，不改 judge/selection，不是 hard gate。
 * - advisory 不进入 SelectionPolicy winner 决策。
 *
 * 接入位置：Stage 4.6（QUALITY-12 trace 之后、FactGuard 之前）。
 */
export function runEditorialCandidateRiskAdvisory(
  editorialCandidates: Candidate[],
  stageResults: Record<string, unknown>,
  warnings: string[]
): void {
  // 无 editorial candidate → 不伪造 advisory，写 skipped 标记
  if (editorialCandidates.length === 0) {
    stageResults.editorialCandidateRiskAdvisory =
      skippedEditorialCandidateRiskAdvisorySet(
        "无 editorial candidate 生成（no-op），未编译 candidate risk advisory"
      );
    return;
  }

  // trace 为 skipped set（非数组）→ 无法编译 advisory，写 skipped 标记
  const traces = stageResults.editorialEvidenceResponseTraces;
  if (!Array.isArray(traces)) {
    stageResults.editorialCandidateRiskAdvisory =
      skippedEditorialCandidateRiskAdvisorySet(
        "editorial evidence response trace 为 skipped（无法判定候选是否回应诊断证据）"
      );
    return;
  }

  try {
    const advisoryInput: CompileRiskAdvisoryInput = {
      traces: traces as EditorialEvidenceResponseTrace[],
      editorialCandidates,
      // 可选只读上下文（当前 compiler 未直接消费，保留以备扩展并明确数据流向）
      rawCraftEvidenceEnvelope: stageResults.rawCraftEvidenceEnvelope,
      editorialOpportunityAdvisory: stageResults.editorialOpportunityAdvisory,
    };
    const advisory = compileEditorialCandidateRiskAdvisory(advisoryInput);
    stageResults.editorialCandidateRiskAdvisory = advisory;
  } catch (e: unknown) {
    // advisory 编译异常 → skipped，不阻断流程
    const msg = e instanceof Error ? e.message : String(e);
    warnings.push(`editorial candidate risk advisory 编译异常（降级 skipped，不阻断）：${msg}`);
    stageResults.editorialCandidateRiskAdvisory =
      skippedEditorialCandidateRiskAdvisorySet(`risk advisory 编译异常：${msg}`);
  }
}

// ==========================================================================
// QUALITY-14：裁判证据审计附件（post-judge 只读附件）
// ==========================================================================

/**
 * 编译 JudgeEvidenceAdvisoryAttachment。
 *
 * - 在 judge 返回后调用（stageResults.judgeArbitration 已写入）。
 * - 通过 result.firstRound.mapping 反查 raw/editorial 的匿名 side（A/B）。
 * - 关联 QUALITY-12 response trace 与 QUALITY-13 candidate risk advisory，
 *   生成只读审计附件写入 stageResults.judgeEvidenceAdvisoryAttachment。
 * - **附件不进入 judge prompt**（judge 已返回），**不改 finalText**，
 *   **不改 judge winner / SelectionPolicy**，**不是 hard gate**。
 * - 无仲裁结果（理论上不会进入此方法，调用方已守卫）→ skipped 附件。
 * - trace/advisory 为 skipped 或 undefined → editorial 侧仍建附件，
 *   但 responseTraceSummary/riskAdvisoryLevel 为 undefined（不伪造）。
 * - 编译异常 → skipped 附件 + warning，不阻断流程。
 *
 * 接入位置：Stage 5c（judgeArbitration 写入后、Stage 6.5 最终事实复检前）。
 */
export function runJudgeEvidenceAdvisoryAttachment(
  arbitrationResults: Array<{ candidate: Candidate; result: ArbitratorResult }>,
  rawCandidateId: string,
  stageResults: Record<string, unknown>,
  warnings: string[]
): void {
  // 无仲裁结果 → 不伪造附件，写 skipped 标记
  if (arbitrationResults.length === 0) {
    stageResults.judgeEvidenceAdvisoryAttachment =
      skippedJudgeEvidenceAdvisoryAttachment(
        "无仲裁结果（arbitrationResults 为空），未编译 judge evidence advisory attachment"
      );
    return;
  }

  try {
    const attachmentInput: CompileAttachmentInput = {
      arbitrationResults,
      rawCandidateId,
      // QUALITY-12 traces：可能为 skipped set（非数组）或 undefined（更早的 early-exit 不应到此）
      traces: stageResults.editorialEvidenceResponseTraces as
        | EditorialEvidenceResponseTrace[]
        | { skippedReason: string }
        | undefined,
      // QUALITY-13 advisory：可能为 skipped set 或 undefined
      advisory: stageResults.editorialCandidateRiskAdvisory as
        | import("./editorial-candidate-risk-advisory.js").EditorialCandidateRiskAdvisory
        | { advisories: []; skippedReason: string }
        | undefined,
    };
    const attachment = compileJudgeEvidenceAdvisoryAttachment(attachmentInput);
    stageResults.judgeEvidenceAdvisoryAttachment = attachment;
  } catch (e: unknown) {
    // 附件编译异常 → skipped，不阻断流程
    const msg = e instanceof Error ? e.message : String(e);
    warnings.push(`judge evidence advisory attachment 编译异常（降级 skipped，不阻断）：${msg}`);
    stageResults.judgeEvidenceAdvisoryAttachment =
      skippedJudgeEvidenceAdvisoryAttachment(`attachment 编译异常：${msg}`);
  }
}

/**
 * QUALITY-15：运行单次生成运行质量证据报告编译。
 *
 * 在 QUALITY-10 final craftEvidenceEnvelope 写入后，把 QUALITY-10~14 的所有证据字段
 * 汇总为 stageResults.qualityEvidenceRunReport，供人工复盘和后续 UI/CLI 展示。
 *
 * 权限边界（QUALITY-15 任务书）：
 * - 只读 stageResults 中已有的证据字段，不改 finalText，不触发任何改写/重写/状态提交。
 * - 不新增 hard gate；报告只是审计汇总，不阻断生成。
 * - 不引入文学总分/pass/fail/grade/weightedScore/rankedScore（由 validator 守护）。
 * - 不调用模型；报告编译是纯本地字段搬运 + 计数。
 * - humanReviewFocus 只含引用/摘要，不含改写建议，最多 10 条。
 * - 不进入 judge prompt（报告在 judge 返回 + QUALITY-10 envelope 后才编译）。
 * - 不改变 PairwiseJudge / SelectionPolicy 胜负规则。
 * - 编译异常 → skipped 报告 + warning，不阻断流程。
 */
export function runQualityEvidenceRunReport(
  selectedSource: "raw" | "editorial",
  selectedCandidateId: string,
  finalText: string,
  hasEditorialCandidate: boolean,
  stageResults: Record<string, unknown>,
  warnings: string[]
): void {
  try {
    const reportInput: CompileRunReportInput = {
      selectedSource,
      selectedCandidateId,
      finalTextLength: finalText.length,
      hasEditorialCandidate,
      // QUALITY-10 raw 阶段 envelope：可能为正式 CraftEvidenceEnvelope / skipped set / undefined
      rawCraftEvidenceEnvelope: stageResults.rawCraftEvidenceEnvelope as
        | import("./craft-evidence-envelope.js").CraftEvidenceEnvelope
        | { skippedReason: string }
        | undefined,
      // QUALITY-11 editorial opportunity advisory
      editorialOpportunityAdvisory: stageResults.editorialOpportunityAdvisory as
        | EditorialOpportunityAdvisory
        | { skippedReason: string }
        | undefined,
      // QUALITY-12 editorial evidence response traces
      editorialEvidenceResponseTraces: stageResults.editorialEvidenceResponseTraces as
        | EditorialEvidenceResponseTrace[]
        | { skippedReason: string }
        | undefined,
      // QUALITY-13 editorial candidate risk advisory
      editorialCandidateRiskAdvisory: stageResults.editorialCandidateRiskAdvisory as
        | import("./editorial-candidate-risk-advisory.js").EditorialCandidateRiskAdvisory
        | { advisories: []; skippedReason: string }
        | undefined,
      // QUALITY-14 judge evidence advisory attachment
      judgeEvidenceAdvisoryAttachment: stageResults.judgeEvidenceAdvisoryAttachment as
        | import("./judge-evidence-advisory-attachment.js").JudgeEvidenceAdvisoryAttachment
        | { entries: []; skippedReason: string }
        | undefined,
      // QUALITY-10 final craft evidence envelope（finalText 的诊断证据）
      craftEvidenceEnvelope: stageResults.craftEvidenceEnvelope as
        | import("./craft-evidence-envelope.js").CraftEvidenceEnvelope
        | { skippedReason: string }
        | undefined,
    };
    const report = compileQualityEvidenceRunReport(reportInput);
    stageResults.qualityEvidenceRunReport = report;
  } catch (e: unknown) {
    // 报告编译异常 → skipped report，不阻断流程
    const msg = e instanceof Error ? e.message : String(e);
    warnings.push(`quality evidence run report 编译异常（降级 skipped，不阻断）：${msg}`);
    stageResults.qualityEvidenceRunReport = skippedQualityEvidenceRunReport(
      `report 编译异常：${msg}`
    );
  }
}

// ==========================================================================
// QUALITY-16：QualityEvidenceReportExport
// ==========================================================================

/**
 * QUALITY-16：导出 qualityEvidenceRunReport 为可复盘产物。
 *
 * 把 stageResults.qualityEvidenceRunReport 持久化为 JSON 文件，供人工审阅和后续 UI/CLI 消费。
 *
 * 权限边界（QUALITY-16 任务书）：
 * - 只做导出，不做 UI，不做裁判，不做门禁，不改 prompt，不改 winner。
 * - 不新增 hard gate；导出失败只记 warning，不阻断生成。
 * - 不引入文学总分/pass/fail/grade/weightedScore/rankedScore（report 字段由 QUALITY-15 守护）。
 * - 不改 finalText；导出只读 stageResults.qualityEvidenceRunReport。
 * - 不强制生成 candidate；raw/no-op 路径同样导出（report 已由 QUALITY-15 编译）。
 * - hardBlock 路径导出 skipped report（不伪造成功报告）。
 * - 不把 report 写入任何模型输入（导出发生在 judge 返回 + QUALITY-15 编译之后）。
 * - 不改变 PairwiseJudge / SelectionPolicy 胜负规则。
 * - 不调用真实模型；导出是纯本地文件 I/O。
 * - 不恢复 Stage0-8 控制权。
 *
 * 复用资产：
 * - 复用现有 trace 目录布局：{projectRoot}/workspaces/{workspaceId}/traces/
 *   （与 {chapterId}-quality-trace.json 同目录，不新造存储系统）。
 * - 复用 atomicSave（write tmp → rename）原子写入模式。
 *
 * 导出路径：{projectRoot}/workspaces/{workspaceId}/traces/{chapterId}-quality-evidence-report.json
 * 导出格式：JSON.stringify(report, null, 2)，字段与 QUALITY-15 数据契约完全一致。
 *
 * evalMode：不写文件（与 chapterFilePath 一致），path=null + reason。
 * 写入失败：warning + path=null + error，不阻断生成（report 缺失可补，正文污染不可逆）。
 * 无 report：path=null + reason（可审计，不应发生——QUALITY-15 保证总是设置）。
 */
export function exportQualityEvidenceReport(orch: UnifiedOrchestrator, 
  input: UnifiedOrchestratorInput,
  stageResults: Record<string, unknown>,
  warnings: string[]
): void {
  const report = stageResults.qualityEvidenceRunReport;
  const controlPlane = input.controlPlane;
  const controlTrace = stageResults.controlPlane as ControlPlaneTrace | undefined;

  // 无 report（不应发生，QUALITY-15 保证总是设置）→ 不导出，可审计
  if (!report) {
    stageResults.qualityEvidenceReportPath = null;
    stageResults.qualityEvidenceReportExport = {
      exported: false,
      filePath: "",
      reason: "stageResults.qualityEvidenceRunReport 未设置（QUALITY-15 应保证总是设置）",
    };
    return;
  }

  // evalMode 不写文件（与 chapterFilePath 一致：evalMode 不持久化章节产物）
  if (input.evalMode) {
    stageResults.qualityEvidenceReportPath = null;
    stageResults.qualityEvidenceReportExport = {
      exported: false,
      filePath: "",
      reason: `evalMode=${input.evalMode}（与 chapterFilePath 一致，不写文件）`,
    };
    return;
  }

  // FULL-PIPELINE-PREVIEW-1：预览模式不写 quality-evidence-report 文件
  // （与 chapterFilePath 一致：预览不持久化任何工作区副作用）
  if (input.fullPipelinePreview) {
    stageResults.qualityEvidenceReportPath = null;
    stageResults.qualityEvidenceReportExport = {
      exported: false,
      filePath: "",
      reason: "fullPipelinePreview=true（预览模式不写文件）",
    };
    return;
  }

  if (controlPlane && controlTrace) {
    const permission = orch.authorizeCapability(
      controlPlane,
      controlTrace,
      "artifact.export",
      "quality evidence report export",
    );
    if (!permission.allowed) {
      stageResults.qualityEvidenceReportPath = null;
      stageResults.qualityEvidenceReportExport = {
        exported: false,
        filePath: "",
        reason: "capability denied: artifact.export",
      };
      return;
    }
  }

  const filePath = qualityEvidenceReportFilePath(input);
  try {
    const json = JSON.stringify(report, null, 2);
    atomicSave(filePath, json);
    stageResults.qualityEvidenceReportPath = filePath;
    stageResults.qualityEvidenceReportExport = {
      exported: true,
      filePath,
      bytes: json.length,
    };
  } catch (e: unknown) {
    // 导出失败不阻断生成（report 缺失可补，正文污染不可逆）
    const msg = e instanceof Error ? e.message : String(e);
    warnings.push(`quality evidence report 导出失败（不阻断生成）：${msg}`);
    stageResults.qualityEvidenceReportPath = null;
    stageResults.qualityEvidenceReportExport = {
      exported: false,
      filePath,
      error: msg,
    };
  }
}

/**
 * 质量证据报告导出路径：
 * {projectRoot}/workspaces/{workspaceId}/traces/{chapterId}-quality-evidence-report.json
 *
 * 与 {chapterId}-quality-trace.json 同目录，便于人工审阅与 UI/CLI 消费。
 * 文件名加 -quality-evidence-report 后缀，避免与 trace 文件冲突。
 */
export function qualityEvidenceReportFilePath(input: UnifiedOrchestratorInput): string {
  return join(
    input.projectRoot,
    "workspaces",
    input.workspaceId,
    "traces",
    `${input.chapterId}-quality-evidence-report.json`
  );
}

