/**
 * completion-trace-adapter — Phase 5.1 bounded-canary completion-trace adapter
 *
 * 把 chapter-canary-runner 的真实运行结果（CanaryChapterResult[] + CanaryMetrics）
 * 适配为可被 `evolution-cli canary --complete` 消费的完成态 CanaryRunTrace。
 *
 * 职责（对应 Phase 5.1 三项证据补齐）：
 *   1. toolMode 证据：把本次 canary 实际暴露的叙事工具模式写入 evidence.toolMode
 *   2. 模型指纹证据：从 run 结果聚合 evidence.modelFingerprint（detectedModel + providers + modelCalls）
 *   3. 失败指标证据：从 run 结果分桶 evidence.failureMetrics（empty/truncated/error/timeout）
 *
 * 同时完成 shadow→real 绑定：sourceRunId / toolMode / releaseId / workspaceId / authorizationId，
 * 以及结果 artifact 冻结（resultArtifactRefs + SHA-256），供 promotion gate 消费。
 *
 * 本模块为纯函数 + 单文件 IO（hashArtifact 读文件），无模型调用、无正文写入。
 * 与 canary-metrics.mjs 共享 CanaryChapterResult 约定。
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { relative, resolve, isAbsolute } from "node:path";

// ============================================================================
// 失败证据分类
// ============================================================================

/**
 * 把单章结果归入失败证据桶（empty/truncated/error/timeout）。
 *
 * 语义（证据用途，非文学判定）：
 *   - 正常成功（status=ok 且文本非空且长度正常）→ null（不计入失败证据）
 *   - empty    — 交付文本为空（textLength === 0）
 *   - truncated— 交付文本过短（textLength > 0 但 < 200 字，疑似截断）
 *   - timeout  — outcomeType === "model_timeout"
 *   - error    — 其余非成功（blocked/error、fatal severity）
 *
 * 关键：失败证据被显式捕获并冻结，证明 canary 不是"只记录成功"。
 *
 * @param {object} result — CanaryChapterResult
 * @returns {"empty"|"truncated"|"timeout"|"error"|null}
 */
export function classifyFailureBucket(result) {
  if (result.status === "ok") {
    if (result.textLength === 0) return "empty";
    if (result.textLength > 0 && result.textLength < 200) return "truncated";
    return null;
  }
  if (result.outcomeType === "model_timeout") return "timeout";
  return "error";
}

/**
 * 从结果数组聚合 Phase 5.1 失败指标证据。
 *
 * @param {Array<object>} results — CanaryChapterResult[]
 * @returns {object} failureMetrics（见 canary-trace-store.ts evidence.failureMetrics）
 */
export function buildFailureMetrics(results) {
  const total = results.length;
  const counts = { empty: 0, truncated: 0, error: 0, timeout: 0 };
  const unknown = { count: 0 };
  for (const r of results) {
    const bucket = classifyFailureBucket(r);
    if (bucket === null) continue;
    counts[bucket] = (counts[bucket] ?? 0) + 1;
    if (r.status !== "ok" && r.outcomeType === "unknown") unknown.count++;
  }

  const nonOk = results.filter((r) => r.status !== "ok").length;
  const blockRate = total > 0 ? nonOk / total : 0;
  const firstPassOk = results.filter((r) => r.status === "ok" && !r.recoveryAttempted).length;
  const firstPassSuccessRate = total > 0 ? firstPassOk / total : 0;

  const recoveryAttempted = results.filter((r) => r.recoveryAttempted).length;
  const recoverySucceeded = results.filter((r) => r.recoverySucceeded).length;
  const recoverySuccessRate = recoveryAttempted > 0 ? recoverySucceeded / recoveryAttempted : null;

  return {
    total,
    empty: counts.empty,
    truncated: counts.truncated,
    error: counts.error,
    timeout: counts.timeout,
    blockRate: round4(blockRate),
    firstPassSuccessRate: round4(firstPassSuccessRate),
    recoverySuccessRate: recoverySuccessRate === null ? null : round4(recoverySuccessRate),
    // 未知失败数（outcomeType=unknown 且非成功）单独携带，供评审端判断是否可分类
    unknown: unknown.count,
  };
}

/**
 * 从结果数组聚合 Phase 5.1 模型指纹证据。
 *
 * @param {Array<object>} results — CanaryChapterResult[]
 * @returns {object} modelFingerprint（见 canary-trace-store.ts evidence.modelFingerprint）
 */
export function buildModelFingerprint(results) {
  /** @type {Record<string, number>} */
  const providers = {};
  let modelCalls = 0;
  for (const r of results) {
    for (const c of r.modelCalls || []) {
      modelCalls++;
      const provider = c.actualProvider ?? c.actualModel ?? "unknown";
      providers[provider] = (providers[provider] ?? 0) + 1;
    }
  }
  // detectedModel：优先取首个非 stub provider（与 canary-metrics detectModelVersion 同构）
  let detectedModel = "unknown";
  for (const r of results) {
    if (r.modelVersion && r.modelVersion !== "unknown" && r.modelVersion !== "stub") {
      detectedModel = r.modelVersion;
      break;
    }
  }
  if (detectedModel === "unknown") {
    for (const r of results) {
      if (r.modelVersion) { detectedModel = r.modelVersion; break; }
    }
  }
  return { detectedModel, providers, modelCalls };
}

// ============================================================================
// 结果 artifact 冻结
// ============================================================================

/**
 * 收集结果 artifact 引用（chapter quality-trace 相对 workspace 路径）+ SHA-256。
 *
 * 只收录位于 workspacePath 内的 trace 文件；越界路径跳过（防路径逃逸）。
 *
 * @param {Array<object>} results — CanaryChapterResult[]
 * @param {string} workspacePath — workspace 绝对路径
 * @returns {{ refs: string[], hashes: Record<string,string>, observedChapters: number, observedCalls: number }}
 */
export function freezeResultArtifacts(results, workspacePath) {
  const refs = [];
  const hashes = {};
  const observedChapterIds = new Set();
  let observedCalls = 0;

  const wsRoot = resolve(workspacePath);
  for (const r of results) {
    observedCalls += (r.modelCalls || []).length;
    if (!r.tracePath) continue;
    const abs = resolve(r.tracePath);
    const rel = relative(wsRoot, abs);
    if (rel.startsWith("..") || isAbsolute(rel)) continue; // 越界 trace 不作为 artifact
    const key = rel.split("\\").join("/");
    if (refs.includes(key)) continue;
    try {
      const buf = readFileSync(abs);
      hashes[key] = createHash("sha256").update(buf).digest("hex");
      refs.push(key);
      const m = key.match(/^traces[\\/](.+)-quality-trace\.json$/);
      if (m) observedChapterIds.add(m[1]);
    } catch {
      // 文件读不到 → 不收录（调用方校验会显式失败）
    }
  }

  return {
    refs,
    hashes,
    observedChapters: observedChapterIds.size,
    observedCalls,
  };
}

// ============================================================================
// 完成态 trace 构造
// ============================================================================

/**
 * 构造完成态 CanaryRunTrace（绑定 sourceRunId + Phase 5.1 证据）。
 *
 * @param {object} params
 * @param {string} params.runId — 完成态 trace 的 runId（与 sourceRunId 不同）
 * @param {string} params.sourceRunId — 先前 --apply 写入的 shadow/canary_started trace runId
 * @param {string} params.releaseId
 * @param {string|null} params.previousReleaseId
 * @param {string} params.workspaceId — workspace 目录名
 * @param {string} params.workspacePath — workspace 绝对路径
 * @param {("standard"|"facade")} params.toolMode — 本次 canary 实际暴露模式
 * @param {string} params.authorizationId
 * @param {string} params.environmentFingerprint
 * @param {string} params.approvalRef
 * @param {string} params.startedAt — 与 source trace.startedAt 一致
 * @param {string} params.completedAt
 * @param {string} params.changeClass — R1/R2/R3
 * @param {string} params.currentStatus — evaluated / candidate_prod
 * @param {string} params.strategy — bounded_canary / shadow_required
 * @param {Array<object>} params.results — CanaryChapterResult[]
 * @param {object} [params.healthSnapshot] — 决策时健康快照（缺省置空）
 * @returns {object} 完成态 CanaryRunTrace
 */
export function buildCompletionTrace(params) {
  const {
    runId,
    sourceRunId,
    releaseId,
    previousReleaseId,
    workspaceId,
    workspacePath,
    toolMode,
    authorizationId,
    environmentFingerprint,
    approvalRef,
    startedAt,
    completedAt,
    changeClass,
    currentStatus,
    strategy,
    results,
    healthSnapshot,
  } = params;

  const modelFingerprint = buildModelFingerprint(results);
  const failureMetrics = buildFailureMetrics(results);
  const artifacts = freezeResultArtifacts(results, workspacePath);

  // verdict：与 runner 验收门槛对齐（阻断率 ≤ 50%、无未知失败、恢复率 ≥ 85%）
  let verdict = "pass";
  if (failureMetrics.total === 0) verdict = "fail";
  else if (failureMetrics.blockRate > 0.5) verdict = "fail";
  else if ((failureMetrics.unknown ?? 0) > 0) verdict = "fail";
  else if (
    failureMetrics.recoverySuccessRate !== null &&
    failureMetrics.recoverySuccessRate < 0.85
  ) verdict = "fail";

  const trace = {
    schemaId: "pinovel.canary-run-trace",
    schemaVersion: 1,
    runId,
    releaseId,
    previousReleaseId,
    workspaceId,
    startedAt,
    completedAt,
    strategy,
    status: "completed",
    healthSnapshot: healthSnapshot ?? {
      status: "unknown",
      alignmentRate: 0,
      sampleCount: 0,
      rollbackRate: 0,
      consecutiveNegative: 0,
    },
    evidence: {
      changeClass,
      currentStatus,
      authorizationId,
      sourceRunId,
      environmentFingerprint,
      approvalRef,
      verdict,
      observedChapters: artifacts.observedChapters,
      observedCalls: artifacts.observedCalls,
      resultArtifactRefs: artifacts.refs,
      resultArtifactHashes: artifacts.hashes,
      toolMode,
      modelFingerprint,
      failureMetrics,
    },
    outcome: { promoted: false, heldByAutoHold: false },
    shadowPendingRealRun: false,
  };
  return trace;
}

// ============================================================================
// 辅助
// ============================================================================

function round4(n) { return Math.round(n * 10000) / 10000; }

// ============================================================================
// 导出（供测试）
// ============================================================================

export const __test__ = { round4 };