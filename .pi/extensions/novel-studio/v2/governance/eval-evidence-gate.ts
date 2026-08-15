/**
 * Eval Evidence Gate（离线回放与生产验收闭环 P6）
 *
 * 让离线回放成为 release 晋级前的必经证据：在 promote（尤其 active_prod）
 * 之前强制检查 Eval Report 完整性与结论。
 *
 * 铁律（与 canary-promotion-gate 一致的治理边界）：
 *  - 本模块绝不修改 production pointer、绝不直接晋级 release；
 *  - 只能产出三种结论之一：
 *      approved  — 证据完整且全部通过（允许进入人工审批环节）；
 *      rejected  — 证据存在但检查未通过（建议 reject candidate / hold）；
 *      insufficient — 证据缺失或无法解析（fail-closed，按策略阻断或警告）；
 *  - 人工审批缺失时结论最多到 approved（evidence-level），
 *    真正的 APPROVAL_REQUIRED 由既有 promote 流程强制。
 *
 * 检查链（全部确定性，零 LLM 调用）：
 *  1. eval run manifest 存在且通过 validateReplayRunManifestV1；
 *  2. release/bundle 绑定与目标 release 一致（防串证据）；
 *  3. Deterministic Grader（P5）通过全部 10 项检查；
 *  4. 隔离违规 = 0（P1 生产面零污染）；
 *  5. R2/R3 额外要求 matrix-report：必须带 schema/四臂/hash/release-bundle 绑定，
 *     P6 重新计算 verdict 与 pass^3，不信任落盘的两个字段。
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  validateReplayRunManifestV1,
  type ReplayRunManifestV1,
} from "../core/eval-fixture-contract.js";
import {
  gradeDeterministicFromRunRoot,
  type DeterministicGradeReport,
} from "../core/eval-deterministic-grader.js";
import {
  parseBoundMatrixReport,
  recomputeBoundMatrixReport,
} from "../core/eval-replay-matrix.js";
import type { ChangeClass } from "./evolution-release-types.js";

// ============================================================================
// 类型
// ============================================================================

export type EvalEvidenceVerdict =
  | "approved"
  | "rejected"
  | "insufficient";

export interface EvalEvidenceGateInput {
  /** 目标 release ID。 */
  releaseId: string;
  /** 目标 bundle ID（release manifest 的行为身份；未知可传 null 跳过 bundle 比对）。 */
  bundleId: string | null;
  /** 变更级别（决定 matrix 证据要求）。 */
  changeClass: ChangeClass;
  /**
   * eval run 归档根目录（含 manifest.json 与 samples/）。
   * null/不存在 → insufficient（按 policy 阻断或警告）。
   */
  evalRunRoot: string | null;
}

export interface EvalEvidenceGateResult {
  verdict: EvalEvidenceVerdict;
  /** 汇总原因码（EVAL_EVIDENCE_*）。 */
  code: string;
  reason: string;
  /** 证据明细（供 release evidence 与审计）。 */
  evidence: {
    evalRunRoot: string | null;
    runManifestFound: boolean;
    runManifestValid: boolean;
    deterministicGradePassed: boolean;
    failedChecks: string[];
    matrixReportFound: boolean;
    matrixVerdict: string | null;
    candidatePassPow3: number | null;
    matrixRecomputed: boolean;
    isolationViolationCount: number;
    traceRetentionRate: number | null;
  };
  /** deterministic grade 全量报告（manifest 缺失时为 null）。 */
  gradeReport: DeterministicGradeReport | null;
}

/** R2/R3 要求 matrix 证据；R0/R1 deterministic-only。 */
export function matrixEvidenceRequired(changeClass: ChangeClass): boolean {
  return changeClass === "R2" || changeClass === "R3";
}

// ============================================================================
// 内部工具
// ============================================================================

function readMatrixReportRaw(evalRunRoot: string): unknown | null {
  const path = join(evalRunRoot, "matrix-report.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return { __parseError: true };
  }
}

function isPlainParseError(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { __parseError?: boolean }).__parseError === true
  );
}

function loadRunManifest(evalRunRoot: string): {
  manifest: ReplayRunManifestV1 | null;
  valid: boolean;
  parseErrors: string[];
} {
  const path = join(evalRunRoot, "manifest.json");
  if (!existsSync(path)) {
    return { manifest: null, valid: false, parseErrors: ["manifest.json 不存在"] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    return {
      manifest: null,
      valid: false,
      parseErrors: [`manifest.json 解析失败：${(e as Error).message}`],
    };
  }
  const validation = validateReplayRunManifestV1(raw);
  if (!validation.valid) {
    return {
      manifest: null,
      valid: false,
      parseErrors: validation.errors.map(
        (e) => `${e.field}: ${e.rule} — ${e.message}`,
      ),
    };
  }
  return { manifest: raw as ReplayRunManifestV1, valid: true, parseErrors: [] };
}

// ============================================================================
// 主入口：Eval Evidence Gate
// ============================================================================

/**
 * 评估 release 的离线回放证据。
 *
 * fail-closed：证据缺失 / 无法解析 / 检查失败 均 → 不足或拒绝，
 * 绝不降级为 pass。本函数只读不写，绝不修改 pointer。
 */
export function evaluateEvalEvidenceGate(
  input: EvalEvidenceGateInput,
): EvalEvidenceGateResult {
  const evidence: EvalEvidenceGateResult["evidence"] = {
    evalRunRoot: input.evalRunRoot,
    runManifestFound: false,
    runManifestValid: false,
    deterministicGradePassed: false,
    failedChecks: [],
    matrixReportFound: false,
    matrixVerdict: null,
    candidatePassPow3: null,
    matrixRecomputed: false,
    isolationViolationCount: 0,
    traceRetentionRate: null,
  };

  // -- 1. eval run root 存在 ------------------------------------------------
  if (!input.evalRunRoot || !existsSync(input.evalRunRoot)) {
    return {
      verdict: "insufficient",
      code: "EVAL_EVIDENCE_MISSING",
      reason: `未提供 eval run 归档根或目录不存在：${input.evalRunRoot ?? "(null)"}`,
      evidence,
      gradeReport: null,
    };
  }

  // -- 2. run manifest 存在且合法 -------------------------------------------
  const loaded = loadRunManifest(input.evalRunRoot);
  evidence.runManifestFound = loaded.manifest !== null || loaded.parseErrors[0] !== "manifest.json 不存在";
  evidence.runManifestValid = loaded.valid;
  if (!loaded.valid) {
    return {
      verdict: "insufficient",
      code: "EVAL_EVIDENCE_MANIFEST_INVALID",
      reason: `eval run manifest 校验失败：${loaded.parseErrors.join("; ")}`,
      evidence,
      gradeReport: null,
    };
  }
  const manifest = loaded.manifest as ReplayRunManifestV1;
  evidence.isolationViolationCount = manifest.summary.isolationViolationCount;
  evidence.traceRetentionRate = manifest.summary.traceRetentionRate;

  // -- 3. release/bundle 绑定（防串证据） -----------------------------------
  if (manifest.releaseId !== input.releaseId) {
    return {
      verdict: "rejected",
      code: "EVAL_EVIDENCE_RELEASE_MISMATCH",
      reason: `eval run 绑定 release ${manifest.releaseId} 与目标 release ${input.releaseId} 不一致（证据不可复用）`,
      evidence,
      gradeReport: null,
    };
  }
  if (input.bundleId && manifest.bundleId !== input.bundleId) {
    return {
      verdict: "rejected",
      code: "EVAL_EVIDENCE_BUNDLE_MISMATCH",
      reason: `eval run 绑定 bundle ${manifest.bundleId} 与目标 bundle ${input.bundleId} 不一致`,
      evidence,
      gradeReport: null,
    };
  }

  // -- 4. 确定性 Grader（P5 全量检查） ---------------------------------------
  const grade = gradeDeterministicFromRunRoot(input.evalRunRoot);
  evidence.deterministicGradePassed = grade.passed;
  evidence.failedChecks = grade.failedChecks;
  if (!grade.passed) {
    return {
      verdict: "rejected",
      code: "EVAL_EVIDENCE_DETERMINISTIC_FAILED",
      reason: `确定性 Grader 未通过：${grade.failedChecks.join(", ")}`,
      evidence,
      gradeReport: grade,
    };
  }

  // -- 5. R2/R3 matrix 证据：schema + 四臂 + hash + 重新计算 -----------------
  if (matrixEvidenceRequired(input.changeClass)) {
    const rawMatrix = readMatrixReportRaw(input.evalRunRoot);
    evidence.matrixReportFound = rawMatrix !== null && !(isPlainParseError(rawMatrix));
    if (rawMatrix === null) {
      return {
        verdict: "insufficient",
        code: "EVAL_EVIDENCE_MATRIX_MISSING",
        reason: `changeClass=${input.changeClass} 要求 A/B 回放矩阵证据（matrix-report.json 缺失）`,
        evidence,
        gradeReport: grade,
      };
    }
    const parsed = parseBoundMatrixReport(
      isPlainParseError(rawMatrix) ? null : rawMatrix,
    );
    if (!parsed.ok || !parsed.report) {
      return {
        verdict: "rejected",
        code: "EVAL_EVIDENCE_MATRIX_INVALID",
        reason: `matrix-report schema/hash 校验失败：${parsed.errors.join("; ")}`,
        evidence,
        gradeReport: grade,
      };
    }
    if (parsed.report.candidateReleaseId !== input.releaseId) {
      return {
        verdict: "rejected",
        code: "EVAL_EVIDENCE_MATRIX_RELEASE_MISMATCH",
        reason: `矩阵绑定 release ${parsed.report.candidateReleaseId} 与目标 ${input.releaseId} 不一致`,
        evidence,
        gradeReport: grade,
      };
    }
    if (input.bundleId && parsed.report.candidateBundleId !== input.bundleId) {
      return {
        verdict: "rejected",
        code: "EVAL_EVIDENCE_MATRIX_BUNDLE_MISMATCH",
        reason: `矩阵绑定 bundle ${parsed.report.candidateBundleId} 与目标 ${input.bundleId} 不一致`,
        evidence,
        gradeReport: grade,
      };
    }
    const recomputed = recomputeBoundMatrixReport(parsed.report);
    evidence.matrixRecomputed = true;
    evidence.matrixVerdict = recomputed.verdict;
    evidence.candidatePassPow3 = recomputed.candidatePassPow3;
    if (recomputed.verdict !== "pass") {
      return {
        verdict: "rejected",
        code: "EVAL_EVIDENCE_MATRIX_REJECTED",
        reason: `A/B 矩阵重新计算 verdict=${recomputed.verdict}：${recomputed.verdictReasons.join("；")}`,
        evidence,
        gradeReport: grade,
      };
    }
    if (recomputed.candidatePassPow3 === null || recomputed.candidatePassPow3 < 1) {
      return {
        verdict: "rejected",
        code: "EVAL_EVIDENCE_PASS_POW3_UNSATISFIED",
        reason: `发布关键路径重新计算 pass^3=${String(recomputed.candidatePassPow3)}（要求 =1）`,
        evidence,
        gradeReport: grade,
      };
    }
  }

  // -- 全部通过 -------------------------------------------------------------
  return {
    verdict: "approved",
    code: "EVAL_EVIDENCE_APPROVED",
    reason: matrixEvidenceRequired(input.changeClass)
      ? "确定性 Grader 通过 + A/B 矩阵 pass + pass^3=1（证据完整，可进入人工审批）"
      : "确定性 Grader 通过（R0/R1 deterministic-only 证据完整，可进入人工审批）",
    evidence,
    gradeReport: grade,
  };
}

// ============================================================================
// 待审批报告（人工审批入口）
// ============================================================================

export interface PendingReviewReport {
  schemaId: "pinovel.eval-pending-review";
  schemaVersion: 1;
  releaseId: string;
  changeClass: ChangeClass;
  verdict: EvalEvidenceVerdict;
  code: string;
  reason: string;
  evidence: EvalEvidenceGateResult["evidence"];
  generatedAt: string;
  /** 人工审批指引。 */
  nextAction:
    | "human_review_required"
    | "fix_and_rerun_replay"
    | "capture_eval_evidence_first";
}

/**
 * 生成待审批报告并写入 release 目录（eval-pending-review.json）。
 * 报告只描述证据状态与下一步动作，不执行任何状态迁移。
 */
export function writeEvalPendingReviewReport(options: {
  releasesDir: string;
  releaseId: string;
  gate: EvalEvidenceGateResult;
  changeClass: ChangeClass;
}): string {
  const report: PendingReviewReport = {
    schemaId: "pinovel.eval-pending-review",
    schemaVersion: 1,
    releaseId: options.releaseId,
    changeClass: options.changeClass,
    verdict: options.gate.verdict,
    code: options.gate.code,
    reason: options.gate.reason,
    evidence: options.gate.evidence,
    generatedAt: new Date().toISOString(),
    nextAction:
      options.gate.verdict === "approved"
        ? "human_review_required"
        : options.gate.verdict === "rejected"
          ? "fix_and_rerun_replay"
          : "capture_eval_evidence_first",
  };
  const releaseDir = join(options.releasesDir, options.releaseId);
  mkdirSync(releaseDir, { recursive: true });
  const reportPath = join(releaseDir, "eval-pending-review.json");
  writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf-8");
  return reportPath;
}

// ============================================================================
// Promote 集成策略（渐进强制）
// ============================================================================

export type EvalEvidenceEnforcement = "mandatory" | "advisory";

/**
 * eval evidence 强制级别：
 *  生产晋级（active_prod）对 R0-R3 全部 mandatory。
 *  Eval → Replay → Review → Release 不可绕过；未提供 evalRunRoot 即阻断。
 *  R0/R1 仍为 deterministic-only（不强制四臂矩阵）；R2/R3 额外强制矩阵。
 */
export function resolveEvalEvidenceEnforcement(
  _changeClass: ChangeClass,
): EvalEvidenceEnforcement {
  return "mandatory";
}

// ============================================================================
// 回放 CLI 强制后置判定（不能只看 completed + 零隔离）
// ============================================================================

export interface ReplayCliSuccessInput {
  allCompleted: boolean;
  isolationViolationCount: number;
  traceRetentionRate: number | null;
  unclassifiedCount: number;
  gradePassed: boolean;
  evalGateVerdict: EvalEvidenceVerdict | null;
}

export interface ReplayCliSuccessResult {
  ok: boolean;
  reasons: string[];
}

/**
 * 回放 CLI 的强制成功条件。P6 eval-gate 是必经后置步骤，
 * 不得以“全部 completed 且零隔离违规”单独宣告 PASS。
 */
export function evaluateReplayCliSuccess(
  input: ReplayCliSuccessInput,
): ReplayCliSuccessResult {
  const reasons: string[] = [];
  if (!input.allCompleted) {
    reasons.push("存在未 completed 样本");
  }
  if (input.isolationViolationCount !== 0) {
    reasons.push(`隔离违规 ${input.isolationViolationCount} 条（要求 0）`);
  }
  if (input.traceRetentionRate !== 1) {
    reasons.push(`trace 留存率 ${String(input.traceRetentionRate)}（要求 1）`);
  }
  if (input.unclassifiedCount !== 0) {
    reasons.push(`未分类失败 ${input.unclassifiedCount}（要求 0）`);
  }
  if (!input.gradePassed) {
    reasons.push("确定性 grader 未通过");
  }
  if (input.evalGateVerdict !== "approved") {
    reasons.push(
      `P6 eval-gate 未通过（verdict=${String(input.evalGateVerdict)}）`,
    );
  }
  return { ok: reasons.length === 0, reasons };
}
