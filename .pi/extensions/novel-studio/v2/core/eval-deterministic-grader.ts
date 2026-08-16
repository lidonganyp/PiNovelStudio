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
  REAL_MODEL_REPLAY_MODES,
  computeEvalFixtureHash,
  parseEvalFixtureV1,
  type EvalFixtureV1,
  type ReplayRunManifestV1,
  type ReplayRunSampleEntry,
} from "./eval-fixture-contract.js";
import { extractReplayModelCalls } from "./eval-replay-trace-stats.js";

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
  | "silent_degrade"
  | "model_call_evidence"
  | "real_model_binding";

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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

/** F3 fail-closed：损坏 manifest 的 runId 安全提取（不得因取值抛错）。 */
function safeRunIdOf(manifest: unknown): string {
  if (typeof manifest === "object" && manifest !== null && !Array.isArray(manifest)) {
    const runId = (manifest as Record<string, unknown>).runId;
    if (typeof runId === "string" && runId.trim().length > 0) {
      return runId;
    }
  }
  return "(invalid-manifest)";
}

/**
 * F3 fail-closed：致命 manifest 形状检测。
 *
 * 损坏 manifest（如 samples: null / summary 缺失 / 样本条目非对象）必须
 * 返回结构化失败报告，不得在后续检查中抛 TypeError。
 * 返回 null 表示形状可安全枚举（语义问题仍由各 check 报告）。
 */
function fatalManifestShapeReason(
  manifest: unknown,
  options: { requireRunRootField?: boolean } = {},
): string | null {
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    return "manifest 不是 JSON 对象";
  }
  const m = manifest as Record<string, unknown>;
  if (!Array.isArray(m.samples)) {
    return "/samples 必须为数组（当前无法枚举样本）";
  }
  for (const field of ["runId", "releaseId", "bundleId"] as const) {
    if (typeof m[field] !== "string" || (m[field] as string).trim().length === 0) {
      return `manifest 缺少必要字段 ${field}`;
    }
  }
  if (options.requireRunRootField === true && typeof m.runRoot !== "string") {
    return "manifest 缺少 runRoot 字符串字段（未显式传入 runRoot 时必须存在）";
  }
  if (
    typeof m.summary !== "object" ||
    m.summary === null ||
    Array.isArray(m.summary) ||
    typeof (m.summary as Record<string, unknown>).isolationViolationCount !== "number"
  ) {
    return "manifest.summary 缺失或 isolationViolationCount 非数字";
  }
  for (const entry of m.samples) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return "manifest.samples 包含非对象条目";
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.fixtureId !== "string" || e.fixtureId.trim().length === 0) {
      return "manifest.samples 条目缺少 fixtureId";
    }
    if (!Array.isArray(e.isolationViolations) || !Array.isArray(e.failureEnvelopes)) {
      return `样本 ${e.fixtureId} 缺少 isolationViolations/failureEnvelopes 数组`;
    }
  }
  return null;
}

/** F3 fail-closed：致命形状 → 仅含 manifest_schema 的结构化失败报告。 */
function buildFatalShapeReport(runId: string, reason: string): DeterministicGradeReport {
  return {
    schemaId: "pinovel.eval-deterministic-grade",
    schemaVersion: 1,
    runId,
    gradedAt: new Date().toISOString(),
    checks: [
      {
        name: "manifest_schema",
        passed: false,
        violations: [{ detail: `manifest 形状损坏（fail-closed）：${reason}` }],
      },
    ],
    passed: false,
    failedChecks: ["manifest_schema"],
  };
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
  // F3 fail-closed：损坏 manifest（形状不可枚举）→ 结构化失败，不抛 TypeError。
  const fatalReason = fatalManifestShapeReason(
    manifest,
    { requireRunRootField: runRoot === undefined },
  );
  if (fatalReason !== null) {
    return buildFatalShapeReport(safeRunIdOf(manifest), fatalReason);
  }
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

  // 11. 模型调用必须与归档 quality-trace 的 gates[].evidence.modelCalls 一致
  {
    const violations: Array<{ fixtureId?: string; detail: string }> = [];
    for (const entry of counted) {
      const archive = loadSampleArchive(root, entry.fixtureId);
      const collected = archive.traces.flatMap((trace) => extractReplayModelCalls(trace));
      if (collected.length !== entry.modelCalls) {
        violations.push({
          fixtureId: entry.fixtureId,
          detail:
            `modelCalls 失真：manifest=${entry.modelCalls} trace=${collected.length}` +
            "（必须统计 gates[].evidence.modelCalls，不得只读顶层 trace.modelCalls）",
        });
      }
      const realModelReplay = REAL_MODEL_REPLAY_MODES.includes(entry.replayMode);
      if (realModelReplay && entry.status === "completed" && collected.length === 0) {
        violations.push({
          fixtureId: entry.fixtureId,
          detail: `${entry.replayMode} completed 样本 modelCalls=0（真实模型回放不得用 0 次调用冒充完成）`,
        });
      }
    }
    checks.push({ name: "model_call_evidence", passed: violations.length === 0, violations });
  }

  // 12. 真实模型臂：传输不得是 stub/mock；每次调用必须有 provider/model/token 计量
  {
    const violations: Array<{ fixtureId?: string; detail: string }> = [];
    for (const entry of counted) {
      if (!REAL_MODEL_REPLAY_MODES.includes(entry.replayMode) || entry.status !== "completed") {
        continue;
      }
      const archive = loadSampleArchive(root, entry.fixtureId);
      const collected = archive.traces.flatMap((trace) => extractReplayModelCalls(trace));
      const invocation = readJsonFile(join(root, "samples", entry.fixtureId, "invocation.json"));
      if (invocation) {
        const command = invocation.command;
        const args = isPlainObject(command) && Array.isArray(command.args) ? command.args : [];
        if (args.some((item) => item === "mock")) {
          violations.push({
            fixtureId: entry.fixtureId,
            detail: `${entry.replayMode} invocation 含 mock（真实模型臂不得走 stub 传输）`,
          });
        }
        const env = isPlainObject(command) ? command.env : null;
        if (isPlainObject(env)) {
          if (env.V2_FORCE_STUB === "1" || env.PINOVEL_EVAL_REPLAY_TRANSPORT === "stub") {
            violations.push({
              fixtureId: entry.fixtureId,
              detail: `${entry.replayMode} 传输是 stub（V2_FORCE_STUB / PINOVEL_EVAL_REPLAY_TRANSPORT）`,
            });
          }
        }
      }
      for (const [index, call] of collected.entries()) {
        const route = call.requestedRoute ?? call.route;
        const provider = call.actualProvider ?? call.provider;
        const model = call.actualModel ?? call.model;
        if (!route) {
          violations.push({
            fixtureId: entry.fixtureId,
            detail: `调用 ${index + 1} 缺少 requestedRoute/route`,
          });
        }
        if (!provider) {
          violations.push({
            fixtureId: entry.fixtureId,
            detail: `调用 ${index + 1} 缺少 actualProvider/provider`,
          });
        }
        if (!model) {
          violations.push({
            fixtureId: entry.fixtureId,
            detail: `调用 ${index + 1} 缺少 actualModel/model`,
          });
        }
        if (!(typeof call.tokenIn === "number" && call.tokenIn > 0) ||
            !(typeof call.tokenOut === "number" && call.tokenOut > 0)) {
          violations.push({
            fixtureId: entry.fixtureId,
            detail:
              `调用 ${index + 1} 缺少 token 计量（tokenIn=${String(call.tokenIn)} tokenOut=${String(call.tokenOut)}）`,
          });
        }
      }
    }
    checks.push({ name: "real_model_binding", passed: violations.length === 0, violations });
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

/** 便捷入口：从归档根读取 manifest.json 并评分（F3：损坏内容 fail-closed）。 */
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
  // F3：先做致命形状检测，损坏 manifest 直接结构化失败（不抛 TypeError）。
  const fatalReason = fatalManifestShapeReason(manifestRaw);
  if (fatalReason !== null) {
    return buildFatalShapeReport(safeRunIdOf(manifestRaw), fatalReason);
  }
  const manifest = manifestRaw as unknown as ReplayRunManifestV1;
  return gradeDeterministic(manifest, runRoot);
}

void sha256;
void (undefined as unknown as ReplayRunSampleEntry | undefined);
