/**
 * 确定性 Grader（离线回放与生产验收闭环 P5 确定性部分）
 *
 * 目标：先用确定性规则确认安全和编排正确，再进行能力分析与人工文学评价。
 * 本 grader 只做本地确定性检查（trace 完整性 / hash 一致性 / 状态不变量 /
 * 原子保存 / FailureEnvelope / recovery 次数 / release-bundle 绑定 /
 * 隔离约束），不调用模型，不做文学判断。
 *
 * 输入：ReplayRunManifestV1（含样本条目）+ 归档目录
 * （full-pipeline-replay-runner 产出的 runPath，含 manifest.json /
 * samples/{fixtureId}/fixture.json / traces / scratch）。
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import {
  computeEvalFixtureHash,
  parseEvalFixtureV1,
  type EvalFixtureV1,
  type ReplayRunManifestV1,
  type ReplayRunSampleEntry,
} from "./eval-fixture-contract.js";

// ============================================================================
// 类型定义
// ============================================================================

export type GraderCheckName =
  | "manifest_schema"
  | "trace_retention"
  | "fixture_hash_consistency"
  | "release_bundle_binding"
  | "isolation_constraints"
  | "state_invariants"
  | "atomic_save"
  | "failure_envelope_completeness"
  | "recovery_bounds"
  | "silent_degrade";

export interface GraderCheck {
  name: GraderCheckName;
  passed: boolean;
  /** 违规明细（每条对应一个样本或全局问题）。 */
  violations: Array<{ fixtureId?: string; detail: string }>;
}

export interface DeterministicGradeReport {
  schemaId: "pinovel.eval-deterministic-grade";
  schemaVersion: 1;
  runId: string;
  gradedAt: string;
  checks: GraderCheck[];
  passed: boolean;
  /** 未通过检查名列表（供 eval-gate / release evidence 消费）。 */
  failedChecks: GraderCheckName[];
}

// ============================================================================
// 内部工具
// ============================================================================

function readJsonFile(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function listJsonFiles(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir).filter((n) => n.endsWith(".json"));
}

interface SampleArchive {
  fixture: EvalFixtureV1 | null;
  tracesDir: string | null;
  traces: Array<Record<string, unknown>>;
  stateProjection: Record<string, unknown> | null;
}

function loadSampleArchive(
  runRoot: string,
  fixtureId: string,
): SampleArchive {
  const sampleDir = join(runRoot, "samples", fixtureId);
  const fixtureRaw = readJsonFile(join(sampleDir, "fixture.json"));
  const fixture = fixtureRaw && parseEvalFixtureV1(fixtureRaw).ok
    ? (fixtureRaw as unknown as EvalFixtureV1)
    : null;
  const tracesDir = join(sampleDir, "traces");
  const traces = listJsonFiles(tracesDir).map((name) =>
    readJsonFile(join(tracesDir, name)),
  ).filter((t): t is Record<string, unknown> => t !== null);
  const stateProjection = readJsonFile(join(sampleDir, "state-projection.json"));
  return { fixture, tracesDir, traces, stateProjection };
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

// ============================================================================
// 主入口
// ============================================================================

/**
 * 对一次完整公共入口回放 run 做确定性评分。
 *
 * @param manifest 回放 run manifest（runner 产出）
 * @param runRoot 归档根（manifest.runRoot；含 samples/ 与 manifest.json）
 */
export function gradeDeterministic(
  manifest: ReplayRunManifestV1,
  runRoot?: string,
): DeterministicGradeReport {
  const root = runRoot ?? manifest.runRoot;
  const checks: GraderCheck[] = [];

  // 1. manifest schema
  {
    const violations: Array<{ fixtureId?: string; detail: string }> = [];
    if (manifest.schemaId !== "pinovel.eval-replay-run-manifest" || manifest.schemaVersion !== 1) {
      violations.push({ detail: "manifest schemaId/schemaVersion 非法" });
    }
    if (manifest.releaseId.trim().length === 0 || manifest.bundleId.trim().length === 0) {
      violations.push({ detail: "manifest 缺少 releaseId/bundleId（无法追溯 provenance）" });
    }
    checks.push({ name: "manifest_schema", passed: violations.length === 0, violations });
  }

  // 统计口径：completed/failed 且无隔离违规的样本才进入检查
  const counted = manifest.samples.filter(
    (s) =>
      (s.status === "completed" || s.status === "failed") &&
      s.isolationViolations.length === 0,
  );

  // 2. trace 留存率 100%
  {
    const violations: Array<{ fixtureId?: string; detail: string }> = [];
    for (const entry of counted) {
      if (!entry.traceArchived || entry.traceArchivePath === null) {
        violations.push({
          fixtureId: entry.fixtureId,
          detail: "样本缺少 trace 归档（trace 留存率要求 100%）",
        });
      } else if (!existsSync(entry.traceArchivePath)) {
        violations.push({
          fixtureId: entry.fixtureId,
          detail: `trace 归档路径不存在：${entry.traceArchivePath}`,
        });
      }
    }
    checks.push({ name: "trace_retention", passed: violations.length === 0, violations });
  }

  // 3+4. fixture hash 一致性 + release/bundle 绑定（逐样本归档复核）
  {
    const hashViolations: Array<{ fixtureId?: string; detail: string }> = [];
    const bindingViolations: Array<{ fixtureId?: string; detail: string }> = [];
    for (const entry of counted) {
      const archive = loadSampleArchive(root, entry.fixtureId);
      if (archive.fixture === null) {
        hashViolations.push({
          fixtureId: entry.fixtureId,
          detail: "归档 fixture.json 缺失或未通过契约校验（fail-closed）",
        });
        continue;
      }
      const recomputed = computeEvalFixtureHash(archive.fixture);
      if (recomputed !== entry.fixtureHash) {
        hashViolations.push({
          fixtureId: entry.fixtureId,
          detail: `fixtureHash 不一致：manifest=${entry.fixtureHash} 归档重算=${recomputed}`,
        });
      }
      if (
        archive.fixture.provenance.releaseId !== manifest.releaseId ||
        archive.fixture.provenance.bundleId !== manifest.bundleId
      ) {
        bindingViolations.push({
          fixtureId: entry.fixtureId,
          detail:
            `release/bundle 绑定不一致：fixture=` +
            `${archive.fixture.provenance.releaseId}/${archive.fixture.provenance.bundleId} ` +
            `manifest=${manifest.releaseId}/${manifest.bundleId}`,
        });
      }
    }
    checks.push({
      name: "fixture_hash_consistency",
      passed: hashViolations.length === 0,
      violations: hashViolations,
    });
    checks.push({
      name: "release_bundle_binding",
      passed: bindingViolations.length === 0,
      violations: bindingViolations,
    });
  }

  // 5. 隔离约束（manifest 层：违规必须 0；scratch marker 归档可追溯）
  {
    const violations: Array<{ fixtureId?: string; detail: string }> = [];
    for (const entry of manifest.samples) {
      if (entry.isolationViolations.length > 0) {
        violations.push(...entry.isolationViolations.map((v) => ({
          fixtureId: entry.fixtureId,
          detail: `${v.kind}: ${v.detail}`,
        })));
      }
    }
    if (manifest.summary.isolationViolationCount > 0) {
      violations.push({
        detail: `summary.isolationViolationCount=${manifest.summary.isolationViolationCount}（要求 0）`,
      });
    }
    checks.push({ name: "isolation_constraints", passed: violations.length === 0, violations });
  }

  // 6. 状态不变量（evalOnly 身份 + 生产面零污染声明）
  {
    const violations: Array<{ fixtureId?: string; detail: string }> = [];
    for (const entry of counted) {
      const archive = loadSampleArchive(root, entry.fixtureId);
      if (archive.fixture === null) {
        continue;
      }
      if (archive.fixture.evalOnly !== true) {
        violations.push({ fixtureId: entry.fixtureId, detail: "fixture.evalOnly 非 true" });
      }
      if (archive.fixture.expectedInvariants.statePollutionForbidden !== true) {
        violations.push({
          fixtureId: entry.fixtureId,
          detail: "expectedInvariants.statePollutionForbidden 非 true",
        });
      }
      if (archive.fixture.expectedInvariants.productionPointerMutationForbidden !== true) {
        violations.push({
          fixtureId: entry.fixtureId,
          detail: "expectedInvariants.productionPointerMutationForbidden 非 true",
        });
      }
    }
    checks.push({ name: "state_invariants", passed: violations.length === 0, violations });
  }

  // 7. 原子保存（completed 样本必须有状态投影与 narrative-state hash）
  {
    const violations: Array<{ fixtureId?: string; detail: string }> = [];
    for (const entry of counted) {
      if (entry.status !== "completed") {
        continue;
      }
      const archive = loadSampleArchive(root, entry.fixtureId);
      if (archive.stateProjection === null) {
        violations.push({
          fixtureId: entry.fixtureId,
          detail: "completed 样本缺少 state-projection.json（原子保存证据缺失）",
        });
        continue;
      }
      const hash = archive.stateProjection.narrativeStateHash;
      if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) {
        violations.push({
          fixtureId: entry.fixtureId,
          detail: "state-projection 缺少合法 narrativeStateHash",
        });
      }
    }
    checks.push({ name: "atomic_save", passed: violations.length === 0, violations });
  }

  // 8+10. FailureEnvelope 完整性 + silent degrade
  {
    const envelopeViolations: Array<{ fixtureId?: string; detail: string }> = [];
    const silentViolations: Array<{ fixtureId?: string; detail: string }> = [];
    for (const entry of counted) {
      if (entry.status === "failed") {
        if (entry.failureEnvelopes.length === 0) {
          silentViolations.push({
            fixtureId: entry.fixtureId,
            detail: "failed 样本无任何 FailureEnvelope（silent degrade）",
          });
        }
        if (entry.failureAttribution === null) {
          envelopeViolations.push({
            fixtureId: entry.fixtureId,
            detail: "failed 样本缺少失败归因（未分类失败要求 0）",
          });
        }
        for (const env of entry.failureEnvelopes) {
          if (typeof env.reason !== "string" || env.reason.trim().length === 0) {
            envelopeViolations.push({
              fixtureId: entry.fixtureId,
              detail: `FailureEnvelope 缺少 reason（stage=${env.stage}）`,
            });
          }
        }
      }
    }
    checks.push({
      name: "failure_envelope_completeness",
      passed: envelopeViolations.length === 0,
      violations: envelopeViolations,
    });
    checks.push({ name: "silent_degrade", passed: silentViolations.length === 0, violations: silentViolations });
  }

  // 9. recovery 边界（trace 内 recoveryAttempts 不超预算上限）
  {
    const violations: Array<{ fixtureId?: string; detail: string }> = [];
    for (const entry of counted) {
      const archive = loadSampleArchive(root, entry.fixtureId);
      const maxRecovery = archive.fixture?.modelPolicy.maxRecoveryModelCalls;
      for (const trace of archive.traces) {
        const attempts = trace.recoveryAttempts;
        if (!Array.isArray(attempts)) {
          continue;
        }
        if (typeof maxRecovery === "number" && attempts.length > maxRecovery) {
          violations.push({
            fixtureId: entry.fixtureId,
            detail: `recoveryAttempts=${attempts.length} 超过预算上限 ${maxRecovery}`,
          });
        }
      }
    }
    checks.push({ name: "recovery_bounds", passed: violations.length === 0, violations });
  }

  const failedChecks = checks.filter((c) => !c.passed).map((c) => c.name);
  return {
    schemaId: "pinovel.eval-deterministic-grade",
    schemaVersion: 1,
    runId: manifest.runId,
    gradedAt: new Date().toISOString(),
    checks,
    passed: failedChecks.length === 0,
    failedChecks,
  };
}

/** 便捷入口：从归档根读取 manifest.json 并评分。 */
export function gradeDeterministicFromRunRoot(runRoot: string): DeterministicGradeReport {
  const manifestRaw = readJsonFile(join(runRoot, "manifest.json"));
  if (manifestRaw === null) {
    return {
      schemaId: "pinovel.eval-deterministic-grade",
      schemaVersion: 1,
      runId: "(missing-manifest)",
      gradedAt: new Date().toISOString(),
      checks: [
        {
          name: "manifest_schema",
          passed: false,
          violations: [{ detail: `manifest.json 缺失或无法解析：${runRoot}` }],
        },
      ],
      passed: false,
      failedChecks: ["manifest_schema"],
    };
  }
  const manifest = manifestRaw as unknown as ReplayRunManifestV1;
  return gradeDeterministic(manifest, runRoot);
}

void sha256;
void (undefined as unknown as ReplayRunSampleEntry | undefined);
