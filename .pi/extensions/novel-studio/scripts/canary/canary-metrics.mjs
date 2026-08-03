/**
 * canary-metrics — Phase 5 Canary 指标计算 / 匿名化 / 报告生成（纯函数）
 *
 * 本模块只包含纯函数：输入 → 输出，不调用模型、不读写文件系统（除显式传入的常量）。
 * 设计目的：
 *   1. 让 tests/phase5-canary-metrics.test.mjs 能在 V2_FORCE_STUB=1 下完整覆盖
 *   2. 让 chapter-canary-runner.mjs 与 blind-eval-export.mjs 共享同一套指标/匿名化逻辑
 *
 * 关键概念：
 *   - CanaryChapterResult：单章 canary 运行结果（由 runner 收集）
 *   - CanaryMetrics：聚合指标（阻断率/首次成功率/恢复成功率/调用分布/成本）
 *   - BlindEvalPair：raw vs final 匿名对照对（供人工评分）
 *
 * 计划 §Phase 5A：不使用单一文学总分；指标聚焦可机器度量的事实性证据。
 */

import { createHash } from "node:crypto";

// ============================================================================
// 常量
// ============================================================================

/** Phase 1 整改后的失败严重性枚举（与 failure-envelope.ts 对齐） */
export const FAILURE_SEVERITIES = ["preflight", "recoverable", "hard", "fatal"];

/** 单章状态枚举（与 runUnifiedPipeline 返回的 status 字段对齐） */
export const CHAPTER_STATUSES = ["ok", "blocked", "error"];

/** 5 维度盲评评分项（不使用单一总分） */
export const BLIND_EVAL_DIMENSIONS = [
  { id: "factual_accuracy", label: "事实准确", description: "无事实/实体/时间线/世界观硬冲突" },
  { id: "story_coherence", label: "故事连贯", description: "事件因果链清晰，无断裂" },
  { id: "character_consistency", label: "人物一致", description: "角色动机/语气/行为符合既有设定" },
  { id: "prose_naturalness", label: "文笔自然", description: "中文自然度，无 AI 腔/翻译腔" },
  { id: "ending_hook", label: "章末钩子", description: "章末留悬念或情绪张力" },
];

/** 单章模型调用预算软上限（与 project_memory 单章 6 次软限一致） */
export const SINGLE_CHAPTER_SOFT_BUDGET = 6;

/** 单章模型调用预算硬上限（与 project_memory 单章 10 次硬帽一致） */
export const SINGLE_CHAPTER_HARD_BUDGET = 10;

// ============================================================================
// 类型（JSDoc typedef，便于 IDE 与文档）
// ============================================================================

/**
 * @typedef {Object} CanaryChapterModelCall
 * @property {string} kind        — "raw" / "editorial" / "judge" / "agentic" 等
 * @property {string} route       — 语义路由（v2_rawstage2 / v2_amplified）
 * @property {string} [requestedRoute] — 真实底层路由（nb4_generate_glm 等）
 * @property {string} [actualProvider] — "gemini31" / "claude" / "stub" / "glm" ...
 * @property {string} [actualModel]
 * @property {number} durationMs
 * @property {string} [finishReason]
 * @property {boolean} [failed]
 */

/**
 * @typedef {Object} CanaryFailureEnvelope
 * @property {string} stage
 * @property {string} [gate]
 * @property {("preflight"|"recoverable"|"hard"|"fatal")} severity
 * @property {string} reason
 * @property {boolean} recoverable
 * @property {unknown} [evidence]
 */

/**
 * @typedef {Object} CanaryChapterResult
 * @property {string} workspaceId
 * @property {string} chapterId          — 字符串形式的章节号
 * @property {number} chapterNumber
 * @property {number} seed               — Thompson / judge 复现种子
 * @property {("ok"|"blocked"|"error")} status
 * @property {("raw"|"editorial"|"agentic_style"|null)} selectedSource
 * @property {string} [selectedCandidateId]
 * @property {("ok"|"blocked"|"error"|"no_editorial"|"factguard_block"|"story_preservation_block"|"model_timeout"|"preflight_block"|"unknown")} outcomeType
 * @property {string|null} chapterFilePath — 原子保存路径（blocked 时为 null）
 * @property {string|null} textHash        — finalText SHA-256（前 16 位）
 * @property {number} textLength           — finalText 字符数
 * @property {number} durationMs
 * @property {CanaryFailureEnvelope|null} failureEnvelope
 * @property {CanaryChapterModelCall[]} modelCalls
 * @property {string|null} tracePath       — workspaces/{id}/traces/{chapterId}-quality-trace.json
 * @property {boolean} [recoveryAttempted] — 是否触发过 gate 级恢复
 * @property {boolean} [recoverySucceeded] — 恢复是否成功（同阶段重试后 status=ok）
 * @property {string[]} [warnings]
 * @property {string} [rawTextPreview]     — 完整 raw 候选文本（P1-6: 不再截断到 200 字，盲评需与完整 final 等长对照）
 * @property {string} [finalTextPreview]   — 前 200 字
 * @property {{min?: number, max?: number}} [targetWordCount]
 * @property {string} [modelVersion]       — 检测到的模型版本（用于按版本隔离指标）
 */

// ============================================================================
// 1. 单章结果归一化
// ============================================================================

/**
 * 将 runUnifiedPipeline 返回的 V2Output + 运行元信息归一化为 CanaryChapterResult。
 *
 * 这是 runner 的核心辅助函数：从异构的 V2Output 中抽出可机器度量的字段，
 * 丢弃 PII / workspace 路径细节（只保留 chapterFilePath 用于后续 trace 复制）。
 *
 * @param {Object} params
 * @param {string} params.workspaceId
 * @param {string} params.chapterId
 * @param {number} params.chapterNumber
 * @param {number} params.seed
 * @param {number} params.durationMs
 * @param {boolean} [params.recoveryAttempted]
 * @param {{ readFileSync?: (path: string, encoding: string) => string }} [params.fs] — 测试注入
 * @param {{ output: any, chapterFilePath: string|null, tracePath: string|null, recoverySucceeded?: boolean }} params.run
 * @returns {CanaryChapterResult}
 */
export function normalizeChapterResult(params) {
  const { workspaceId, chapterId, chapterNumber, seed, durationMs, recoveryAttempted = false } = params;
  const { output, chapterFilePath, tracePath, recoverySucceeded = false } = params.run;
  const fs = params.fs?.readFileSync ?? null;

  const status = (output?.status ?? "error");
  const safeStatus = CHAPTER_STATUSES.includes(status) ? status : "error";

  const selectedSource = output?.selectedSource ?? null;
  const failureEnvelope = output?.failureEnvelope ?? null;
  const modelCalls = (output?.stageResults?.modelCalls ?? []).map((c) => ({
    kind: c.kind ?? "unknown",
    route: c.route ?? "unknown",
    requestedRoute: c.requestedRoute,
    actualProvider: c.actualProvider ?? c.provider,
    actualModel: c.actualModel ?? c.model,
    durationMs: c.durationMs ?? 0,
    finishReason: c.finishReason,
    failed: c.failed === true,
  }));

  // 计算 outcomeType（与 project_memory 4 类输出类型对齐）
  const outcomeType = classifyOutcome({
    status: safeStatus,
    selectedSource,
    failureEnvelope,
    modelCalls,
    recoveryAttempted,
    recoverySucceeded,
  });

  // 读取 finalText（仅哈希 + 长度 + preview，不保存全文）
  let textHash = null;
  let textLength = 0;
  let finalTextPreview = undefined;
  let rawTextPreview = undefined;
  if (chapterFilePath && fs) {
    try {
      const text = fs(chapterFilePath, "utf8");
      textLength = text.length;
      textHash = createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
      finalTextPreview = text.slice(0, 200);
    } catch {
      // 文件读取失败 → 视为无 finalText
    }
  }

  // 从 candidates 抽 raw preview（盲评对照用）
  // P1-6 修复：raw 筛选必须包含生产 agentic_raw kind，否则与完整 final 盲评会拿不到 raw。
  const candidates = Array.isArray(output?.candidates) ? output.candidates : [];
  const rawCandidate = candidates.find(
    (c) => c?.kind === "agentic_raw" || c?.kind === "context_enhanced" || c?.kind === "raw",
  );
  if (rawCandidate && typeof rawCandidate.text === "string") {
    // P1-6: 不截断到 200 字，保留完整 raw 文本（盲评需与完整 final 等长对照）
    rawTextPreview = rawCandidate.text;
  }

  return {
    workspaceId,
    chapterId,
    chapterNumber,
    seed,
    status: safeStatus,
    selectedSource,
    selectedCandidateId: output?.selectedCandidateId ?? undefined,
    outcomeType,
    chapterFilePath,
    textHash,
    textLength,
    durationMs,
    failureEnvelope,
    modelCalls,
    tracePath,
    recoveryAttempted,
    recoverySucceeded,
    warnings: Array.isArray(output?.stageResults?.warnings) ? output.stageResults.warnings : [],
    rawTextPreview,
    finalTextPreview,
    targetWordCount: undefined,
    modelVersion: detectModelVersion(modelCalls),
  };
}

// ============================================================================
// 2. outcomeType 分类
// ============================================================================

/**
 * 把单章运行结果分类为 4 类输出类型（与 project_memory 一致）：
 *   - "ok"                       — 正常交付
 *   - "no_editorial"             — 0 假设 / Thompson 不准入 / 无候选生成（selectedSource=raw 且无 editorial 候选）
 *   - "factguard_block"          — 候选生成但被 FactGuard 全部拒绝
 *   - "story_preservation_block" — 候选生成但被故事保持门全部拒绝
 *   - "model_timeout"            — 模型超时/空结果（recoverable 但恢复失败）
 *   - "preflight_block"          — Preflight 阻断
 *   - "unknown"                  — 其他
 *
 * 注意：本函数只看可机器度量的字段；不做语义判断。
 *
 * @param {Object} input
 * @returns {CanaryChapterResult["outcomeType"]}
 */
export function classifyOutcome(input) {
  const { status, selectedSource, failureEnvelope, modelCalls, recoveryAttempted, recoverySucceeded } = input;

  if (status === "ok") {
    return recoveryAttempted && recoverySucceeded ? "ok" : "ok";
  }

  if (status !== "blocked" && status !== "error") {
    return "unknown";
  }

  // blocked/error 路径：根据 failureEnvelope.stage / gate 分类
  const stage = failureEnvelope?.stage ?? "";
  const gate = failureEnvelope?.gate ?? "";
  const severity = failureEnvelope?.severity ?? "";

  if (stage === "preflight" || severity === "preflight") {
    return "preflight_block";
  }
  if (gate === "model_timeout" || stage === "model_timeout") {
    return "model_timeout";
  }
  if (
    stage.includes("factguard")
    || stage.includes("fact_guard")
    || gate.includes("factguard")
    || stage.includes("novelos_agentic_verification")   // Agentic 内部 verifier 事实硬冲突
    || stage.includes("agentic_factguard")
    || stage.includes("final_fact_recheck")              // 最终事实复检失败
  ) {
    return "factguard_block";
  }
  if (stage.includes("story_preservation") || stage.includes("story-preservation") || gate.includes("story_preservation")) {
    return "story_preservation_block";
  }
  if (stage.includes("style") || gate.includes("style_optimization")) {
    // 风格优化失败 → 严格说是 hard block，但归到 model_timeout 不准确
    // 用 unknown 让人工审视
    return "unknown";
  }

  // 候选生成但无 selectedSource → 推断为 factguard_block 或 story_preservation_block
  if (selectedSource === null && modelCalls.some((c) => c.kind === "editorial")) {
    // 有 editorial 候选调用但未选定 → 多半是 FactGuard 或故事保持门拒绝
    // 无法区分时优先标 factguard_block（更常见）
    return "factguard_block";
  }

  return "unknown";
}

// ============================================================================
// 3. 聚合指标计算
// ============================================================================

/**
 * 计算一批 canary 章节的聚合指标。
 *
 * 指标维度（与计划 §Phase 5A 一致）：
 *   - 总章数 / 成功数 / 阻断数 / 错误数
 *   - 首次成功率（无恢复即成功）
 *   - 自动恢复后成功率
 *   - 阻断率（按 severity / stage / outcomeType 分桶）
 *   - 模型调用总次数 / 平均每章 / 超软上限章数 / 超硬上限章数
 *   - 总耗时 / 平均每章 / 最慢章
 *   - 按 modelVersion 分桶的子指标
 *
 * @param {CanaryChapterResult[]} results
 * @returns {CanaryMetrics}
 */
export function computeCanaryMetrics(results) {
  const total = results.length;
  if (total === 0) {
    return emptyMetrics();
  }

  let okCount = 0;
  let blockedCount = 0;
  let errorCount = 0;
  let firstPassOkCount = 0;       // status=ok 且未触发恢复
  let recoveryAttemptedCount = 0;
  let recoverySucceededCount = 0;
  let totalModelCalls = 0;
  let totalDurationMs = 0;
  let maxDurationMs = 0;
  let overSoftBudgetCount = 0;
  let overHardBudgetCount = 0;
  let totalTextLength = 0;

  /** @type {Record<string, number>} */
  const outcomeTypeCounts = {};
  /** @type {Record<string, number>} */
  const severityCounts = {};
  /** @type {Record<string, number>} */
  const stageFailureCounts = {};
  /** @type {Record<string, number>} */
  const selectedSourceCounts = {};
  /** @type {Record<string, { total: number, ok: number, blocked: number, error: number, modelCalls: number, durationMs: number }>} */
  const byModelVersion = {};
  /** @type {Record<string, number>} */
  const failureReasonCounts = {};

  for (const r of results) {
    totalModelCalls += r.modelCalls.length;
    totalDurationMs += r.durationMs;
    if (r.durationMs > maxDurationMs) maxDurationMs = r.durationMs;
    if (r.modelCalls.length > SINGLE_CHAPTER_SOFT_BUDGET) overSoftBudgetCount++;
    if (r.modelCalls.length > SINGLE_CHAPTER_HARD_BUDGET) overHardBudgetCount++;
    if (r.textLength > 0) totalTextLength += r.textLength;

    if (r.status === "ok") okCount++;
    else if (r.status === "blocked") blockedCount++;
    else errorCount++;

    if (r.status === "ok" && !r.recoveryAttempted) firstPassOkCount++;
    if (r.recoveryAttempted) {
      recoveryAttemptedCount++;
      if (r.recoverySucceeded) recoverySucceededCount++;
    }

    outcomeTypeCounts[r.outcomeType] = (outcomeTypeCounts[r.outcomeType] ?? 0) + 1;
    selectedSourceCounts[r.selectedSource ?? "null"] = (selectedSourceCounts[r.selectedSource ?? "null"] ?? 0) + 1;

    const sev = r.failureEnvelope?.severity ?? "none";
    severityCounts[sev] = (severityCounts[sev] ?? 0) + 1;

    const stage = r.failureEnvelope?.stage ?? "none";
    stageFailureCounts[stage] = (stageFailureCounts[stage] ?? 0) + 1;

    if (r.failureEnvelope?.reason) {
      // 截断 reason 到 80 字避免分桶过细
      const shortReason = r.failureEnvelope.reason.slice(0, 80);
      failureReasonCounts[shortReason] = (failureReasonCounts[shortReason] ?? 0) + 1;
    }

    const mv = r.modelVersion ?? "unknown";
    if (!byModelVersion[mv]) {
      byModelVersion[mv] = { total: 0, ok: 0, blocked: 0, error: 0, modelCalls: 0, durationMs: 0 };
    }
    byModelVersion[mv].total++;
    byModelVersion[mv].modelCalls += r.modelCalls.length;
    byModelVersion[mv].durationMs += r.durationMs;
    if (r.status === "ok") byModelVersion[mv].ok++;
    else if (r.status === "blocked") byModelVersion[mv].blocked++;
    else byModelVersion[mv].error++;
  }

  const blockRate = (blockedCount + errorCount) / total;
  const firstPassSuccessRate = firstPassOkCount / total;
  const recoverySuccessRate = recoveryAttemptedCount > 0 ? recoverySucceededCount / recoveryAttemptedCount : null;
  const autoRecoveredOkRate = (okCount - firstPassOkCount) / total; // 恢复后转为 ok 的比例

  return {
    total,
    ok: okCount,
    blocked: blockedCount,
    error: errorCount,
    blockRate: round4(blockRate),
    firstPassSuccessRate: round4(firstPassSuccessRate),
    autoRecoveredOkRate: round4(autoRecoveredOkRate),
    recoveryAttemptedCount,
    recoverySucceededCount,
    recoverySuccessRate: recoverySuccessRate === null ? null : round4(recoverySuccessRate),
    outcomeTypeCounts,
    severityCounts,
    stageFailureCounts,
    selectedSourceCounts,
    failureReasonCounts,
    modelCalls: {
      total: totalModelCalls,
      averagePerChapter: round2(totalModelCalls / total),
      overSoftBudgetCount,
      overHardBudgetCount,
    },
    duration: {
      totalMs: totalDurationMs,
      averagePerChapterMs: round2(totalDurationMs / total),
      maxMs: maxDurationMs,
    },
    textLength: {
      total: totalTextLength,
      averagePerChapter: round2(totalTextLength / total),
    },
    byModelVersion,
  };
}

/**
 * @typedef {Object} CanaryMetrics
 * @property {number} total
 * @property {number} ok
 * @property {number} blocked
 * @property {number} error
 * @property {number} blockRate
 * @property {number} firstPassSuccessRate
 * @property {number} autoRecoveredOkRate
 * @property {number} recoveryAttemptedCount
 * @property {number} recoverySucceededCount
 * @property {number|null} recoverySuccessRate
 * @property {Record<string, number>} outcomeTypeCounts
 * @property {Record<string, number>} severityCounts
 * @property {Record<string, number>} stageFailureCounts
 * @property {Record<string, number>} selectedSourceCounts
 * @property {Record<string, number>} failureReasonCounts
 * @property {{ total: number, averagePerChapter: number, overSoftBudgetCount: number, overHardBudgetCount: number }} modelCalls
 * @property {{ totalMs: number, averagePerChapterMs: number, maxMs: number }} duration
 * @property {{ total: number, averagePerChapter: number }} textLength
 * @property {Record<string, { total: number, ok: number, blocked: number, error: number, modelCalls: number, durationMs: number }>} byModelVersion
 */

function emptyMetrics() {
  return {
    total: 0,
    ok: 0,
    blocked: 0,
    error: 0,
    blockRate: 0,
    firstPassSuccessRate: 0,
    autoRecoveredOkRate: 0,
    recoveryAttemptedCount: 0,
    recoverySucceededCount: 0,
    recoverySuccessRate: null,
    outcomeTypeCounts: {},
    severityCounts: {},
    stageFailureCounts: {},
    selectedSourceCounts: {},
    failureReasonCounts: {},
    modelCalls: { total: 0, averagePerChapter: 0, overSoftBudgetCount: 0, overHardBudgetCount: 0 },
    duration: { totalMs: 0, averagePerChapterMs: 0, maxMs: 0 },
    textLength: { total: 0, averagePerChapter: 0 },
    byModelVersion: {},
  };
}

// ============================================================================
// 4. 模型版本检测
// ============================================================================

/**
 * 从 modelCalls 推断本章实际使用的模型版本。
 *
 * 优先取首个非 stub 调用的 actualProvider；若全部是 stub，返回 "stub"。
 * 用于按模型版本分桶指标（Phase 4C 隔离要求）。
 *
 * @param {CanaryChapterModelCall[]} modelCalls
 * @returns {string}
 */
export function detectModelVersion(modelCalls) {
  if (!Array.isArray(modelCalls) || modelCalls.length === 0) return "unknown";
  for (const c of modelCalls) {
    const provider = c.actualProvider ?? c.actualModel;
    if (provider && provider !== "stub") {
      return provider;
    }
  }
  // 全部 stub 或缺失
  const first = modelCalls[0];
  return first?.actualProvider ?? first?.actualModel ?? "unknown";
}

// ============================================================================
// 5. 匿名化
// ============================================================================

/**
 * 把 CanaryChapterResult 去标识化：workspaceId → ws-a/b/c，chapterId → ch-001/002。
 *
 * 保留可机器度量的字段（status / outcomeType / modelCalls / duration / 文本哈希），
 * 但剥离 chapterFilePath、tracePath 中的绝对路径，只保留 basename。
 *
 * 同一 workspaceId/chapterId 在多次调用中映射到同一匿名 ID（保证可关联性）。
 *
 * @param {CanaryChapterResult} result
 * @param {Map<string, string>} [anonIdMap] — 可选复用映射（多次调用共享）
 * @returns {AnonymizedChapterResult}
 */
export function anonymizeChapterResult(result, anonIdMap = new Map()) {
  const wsAnon = getOrCreateAnonId(anonIdMap, "ws", result.workspaceId);
  const chAnon = getOrCreateAnonId(anonIdMap, "ch", `${result.workspaceId}:${result.chapterId}`);

  /** @type {AnonymizedChapterResult} */
  const anon = {
    workspaceId: wsAnon,
    chapterId: chAnon,
    chapterNumber: result.chapterNumber,
    seed: result.seed,
    status: result.status,
    selectedSource: result.selectedSource,
    outcomeType: result.outcomeType,
    textHash: result.textHash,
    textLength: result.textLength,
    durationMs: result.durationMs,
    modelCalls: result.modelCalls.map((c) => ({
      kind: c.kind,
      route: c.route,
      actualProvider: c.actualProvider,
      actualModel: c.actualModel,
      durationMs: c.durationMs,
      finishReason: c.finishReason,
      failed: c.failed,
    })),
    recoveryAttempted: result.recoveryAttempted,
    recoverySucceeded: result.recoverySucceeded,
    modelVersion: result.modelVersion,
    // 故意不复制 chapterFilePath / tracePath / warnings / preview
    // preview 单独走 buildBlindEvalPairs 导出
  };
  return anon;
}

/**
 * @typedef {Object} AnonymizedChapterResult
 * @property {string} workspaceId
 * @property {string} chapterId
 * @property {number} chapterNumber
 * @property {number} seed
 * @property {("ok"|"blocked"|"error")} status
 * @property {("raw"|"editorial"|"agentic_style"|null)} selectedSource
 * @property {string} outcomeType
 * @property {string|null} textHash
 * @property {number} textLength
 * @property {number} durationMs
 * @property {CanaryChapterModelCall[]} modelCalls
 * @property {boolean} recoveryAttempted
 * @property {boolean} recoverySucceeded
 * @property {string} modelVersion
 */

function getOrCreateAnonId(map, prefix, key) {
  if (!map.has(key)) {
    const next = map.size + 1;
    const suffix = String.fromCharCode("a".charCodeAt(0) + ((next - 1) % 26));
    const id = prefix === "ws" ? `${prefix}-${suffix}` : `${prefix}-${String(next).padStart(3, "0")}`;
    map.set(key, id);
  }
  return map.get(key);
}

// ============================================================================
// 6. 盲评对照对构造
// ============================================================================

/**
 * 从 canary 结果构造盲评对照对（raw vs final），匿名化后供人工评分。
 *
 * 设计原则（与计划 §Phase 5B 一致）：
 *   - 不使用单一文学总分；5 维度（事实/连贯/人物/文笔/钩子）独立评分
 *   - raw 与 final 匿名化为 "样本 A" / "样本 B"（随机打乱顺序避免位置偏置）
 *   - 每对独立产出 winningSpans / losingSpans（不强制决出 winner）
 *   - 不导出 workspace 路径 / chapterId / 章节号
 *
 * P1-6 修复：
 *   - 双方必须非空才导出（旧逻辑允许 raw 空而 final 非空，盲评退化为单边评估）
 *   - 长度口径不再混合 preview 与 full text（rawTextPreview 现已保存完整 raw 文本）
 *
 * @param {CanaryChapterResult[]} results
 * @param {{ readFileSync?: (path: string, encoding: string) => string }} [fs]
 * @returns {BlindEvalPair[]}
 */
export function buildBlindEvalPairs(results, fs) {
  const readFile = fs?.readFileSync ?? null;
  /** @type {BlindEvalPair[]} */
  const pairs = [];
  let pairCounter = 0;
  /** P1-6: 记录被跳过的章节及原因，便于 runner 报告盲评覆盖率 */
  const skipped = [];

  for (const r of results) {
    if (r.status !== "ok") continue; // 只对成功交付的章节做盲评

    // final 文本：从 chapterFilePath 读取完整正文
    let finalText = "";
    if (r.chapterFilePath && readFile) {
      try {
        finalText = readFile(r.chapterFilePath, "utf8");
      } catch {
        skipped.push({ chapterId: r.chapterId, reason: "final_file_unreadable" });
        continue; // 文件读不到 → 跳过
      }
    } else if (r.finalTextPreview) {
      finalText = r.finalTextPreview; // 兜底：只有 preview 也接受（短文本场景）
    } else {
      skipped.push({ chapterId: r.chapterId, reason: "final_text_missing" });
      continue;
    }

    // P1-6: raw 文本必须非空，否则盲评退化为单边评估
    // normalizeChapterResult 现已保留完整 raw 文本（不再截断到 200 字）
    const rawText = r.rawTextPreview ?? "";
    if (!rawText) {
      skipped.push({ chapterId: r.chapterId, reason: "raw_text_missing" });
      continue;
    }
    if (!finalText) {
      skipped.push({ chapterId: r.chapterId, reason: "final_text_empty" });
      continue;
    }

    pairCounter++;
    // 随机打乱 A/B 顺序（用 hash 决定，避免 Math.random 不可复现）
    const seedByte = createHash("sha256").update(r.textHash ?? `${r.workspaceId}:${r.chapterId}`, "utf8").digest()[0];
    const aIsRaw = seedByte % 2 === 0;

    /** @type {BlindEvalPair} */
    const pair = {
      pairId: `pair-${String(pairCounter).padStart(3, "0")}`,
      anonymousLabel: `样本对 #${pairCounter}`,
      sampleA: {
        label: "样本 A",
        text: aIsRaw ? rawText : finalText,
        textLength: (aIsRaw ? rawText : finalText).length,
      },
      sampleB: {
        label: "样本 B",
        text: aIsRaw ? finalText : rawText,
        textLength: (aIsRaw ? finalText : rawText).length,
      },
      dimensions: BLIND_EVAL_DIMENSIONS.map((d) => ({
        id: d.id,
        label: d.label,
        description: d.description,
        sampleAScore: null,  // 1-5 分，由评分者填写
        sampleBScore: null,
        sampleAWinningSpans: [],  // A 中胜出的片段
        sampleALosingSpans: [],   // A 中失败的片段
        sampleBWinningSpans: [],
        sampleBLosingSpans: [],
      })),
      notes: "",
    };
    pairs.push(pair);
  }

  // P1-6: 把 skipped 原因挂到 pairs 上（非数组元素，避免破坏数组迭代）
  // runner 可通过 pairs.skipped 读取被跳过的章节及原因
  Object.defineProperty(pairs, "skipped", {
    value: skipped,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return pairs;
}

/**
 * @typedef {Object} BlindEvalPair
 * @property {string} pairId
 * @property {string} anonymousLabel
 * @property {{ label: string, text: string, textLength: number }} sampleA
 * @property {{ label: string, text: string, textLength: number }} sampleB
 * @property {Array<{ id: string, label: string, description: string, sampleAScore: number|null, sampleBScore: number|null, sampleAWinningSpans: string[], sampleALosingSpans: string[], sampleBWinningSpans: string[], sampleBLosingSpans: string[] }>} dimensions
 * @property {string} notes
 */

// ============================================================================
// 7. Markdown 报告生成
// ============================================================================

/**
 * 生成 canary 运行的 Markdown 仪表盘报告。
 *
 * 报告章节：
 *   1. Run Metadata（运行元信息：时间戳 / git HEAD / 模型版本 / 章节范围）
 *   2. Summary（总章数 / 成功率 / 阻断率 / 恢复率）
 *   3. Outcome Distribution（4 类输出类型分布表）
 *   4. Failure Stages（按 stage 分桶的失败表 + Top 10 reason）
 *   5. Model Calls（总次数 / 平均 / 超预算章数）
 *   6. Duration（总耗时 / 平均 / 最慢章）
 *   7. By Model Version（按模型版本分桶）
 *   8. Per-Chapter Detail（每章一行：status / outcome / calls / duration / hash）
 *   9. 验收门槛对照（与 project_memory 的稳定性门槛对照）
 *
 * @param {Object} params
 * @param {CanaryMetrics} params.metrics
 * @param {CanaryChapterResult[]} [params.results]
 * @param {{ runId: string, startedAt: string, finishedAt: string, gitHead?: string, workspaces: string[], chapterRange: string, modelVersion?: string, seedList?: number[], realModel: boolean }} params.metadata
 * @returns {string}
 */
export function generateCanaryReport(params) {
  const { metrics, metadata } = params;
  const lines = [];

  lines.push(`# Phase 5 Canary 验证报告`);
  lines.push("");
  lines.push(`> Run ID: \`${metadata.runId}\``);
  lines.push(`> 时间: ${metadata.startedAt} → ${metadata.finishedAt}`);
  if (metadata.gitHead) {
    lines.push(`> Git HEAD: \`${metadata.gitHead}\``);
  }
  lines.push(`> Workspaces: ${metadata.workspaces.join(", ")}`);
  lines.push(`> 章节范围: ${metadata.chapterRange}`);
  lines.push(`> 模型版本: ${metadata.modelVersion ?? "unknown"}`);
  lines.push(`> 真实模型: ${metadata.realModel ? "✅ 是" : "❌ 否（stub）"}`);
  if (metadata.seedList?.length) {
    lines.push(`> Seeds: ${metadata.seedList.join(", ")}`);
  }
  lines.push("");

  // ----- Summary -----
  lines.push(`## 1. Summary`);
  lines.push("");
  lines.push(`| 指标 | 值 |`);
  lines.push(`|------|-----|`);
  lines.push(`| 总章数 | ${metrics.total} |`);
  lines.push(`| 成功（status=ok） | ${metrics.ok} |`);
  lines.push(`| 阻断（status=blocked） | ${metrics.blocked} |`);
  lines.push(`| 错误（status=error） | ${metrics.error} |`);
  lines.push(`| 阻断率 | ${(metrics.blockRate * 100).toFixed(2)}% |`);
  lines.push(`| 首次成功率 | ${(metrics.firstPassSuccessRate * 100).toFixed(2)}% |`);
  lines.push(`| 自动恢复后转为 ok 比例 | ${(metrics.autoRecoveredOkRate * 100).toFixed(2)}% |`);
  lines.push(`| 恢复尝试章数 | ${metrics.recoveryAttemptedCount} |`);
  lines.push(`| 恢复成功率 | ${metrics.recoverySuccessRate === null ? "N/A" : `${(metrics.recoverySuccessRate * 100).toFixed(2)}%`} |`);
  lines.push("");

  // ----- Outcome Distribution -----
  lines.push(`## 2. Outcome 分布`);
  lines.push("");
  lines.push(`| outcomeType | 章数 | 占比 |`);
  lines.push(`|-------------|------|------|`);
  const outcomeRows = Object.entries(metrics.outcomeTypeCounts).sort((a, b) => b[1] - a[1]);
  for (const [k, v] of outcomeRows) {
    const pct = metrics.total > 0 ? (v / metrics.total * 100).toFixed(2) : "0.00";
    lines.push(`| ${k} | ${v} | ${pct}% |`);
  }
  lines.push("");

  // ----- Failure Stages -----
  lines.push(`## 3. 失败 Stage 分布`);
  lines.push("");
  lines.push(`| stage | 章数 |`);
  lines.push(`|-------|------|`);
  const stageRows = Object.entries(metrics.stageFailureCounts).sort((a, b) => b[1] - a[1]);
  for (const [k, v] of stageRows) {
    lines.push(`| ${k} | ${v} |`);
  }
  lines.push("");
  lines.push(`### severity 分布`);
  lines.push("");
  lines.push(`| severity | 章数 |`);
  lines.push(`|----------|------|`);
  const sevRows = Object.entries(metrics.severityCounts).sort((a, b) => b[1] - a[1]);
  for (const [k, v] of sevRows) {
    lines.push(`| ${k} | ${v} |`);
  }
  lines.push("");
  lines.push(`### Top 10 failure reasons`);
  lines.push("");
  const reasonRows = Object.entries(metrics.failureReasonCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (reasonRows.length === 0) {
    lines.push(`_(无失败)_`);
  } else {
    lines.push(`| reason (前 80 字) | 章数 |`);
    lines.push(`|------------------|------|`);
    for (const [k, v] of reasonRows) {
      const safe = k.replace(/\|/g, "\\|");
      lines.push(`| ${safe} | ${v} |`);
    }
  }
  lines.push("");

  // ----- Model Calls -----
  lines.push(`## 4. 模型调用`);
  lines.push("");
  lines.push(`| 指标 | 值 |`);
  lines.push(`|------|-----|`);
  lines.push(`| 总调用次数 | ${metrics.modelCalls.total} |`);
  lines.push(`| 平均每章 | ${metrics.modelCalls.averagePerChapter} |`);
  lines.push(`| 超软上限（>${SINGLE_CHAPTER_SOFT_BUDGET}）章数 | ${metrics.modelCalls.overSoftBudgetCount} |`);
  lines.push(`| 超硬上限（>${SINGLE_CHAPTER_HARD_BUDGET}）章数 | ${metrics.modelCalls.overHardBudgetCount} |`);
  lines.push("");

  // ----- Duration -----
  lines.push(`## 5. 耗时`);
  lines.push("");
  lines.push(`| 指标 | 值 |`);
  lines.push(`|------|-----|`);
  lines.push(`| 总耗时 | ${formatMs(metrics.duration.totalMs)} |`);
  lines.push(`| 平均每章 | ${formatMs(metrics.duration.averagePerChapterMs)} |`);
  lines.push(`| 最慢章 | ${formatMs(metrics.duration.maxMs)} |`);
  lines.push("");

  // ----- Text Length -----
  lines.push(`## 6. 文本长度`);
  lines.push("");
  lines.push(`| 指标 | 值 |`);
  lines.push(`|------|-----|`);
  lines.push(`| 总字数 | ${metrics.textLength.total} |`);
  lines.push(`| 平均每章 | ${metrics.textLength.averagePerChapter} |`);
  lines.push("");

  // ----- By Model Version -----
  lines.push(`## 7. 按模型版本分桶`);
  lines.push("");
  const mvEntries = Object.entries(metrics.byModelVersion);
  if (mvEntries.length === 0) {
    lines.push(`_(无数据)_`);
  } else {
    lines.push(`| modelVersion | total | ok | blocked | error | 平均调用 | 平均耗时 |`);
    lines.push(`|--------------|-------|----|---------|-------|----------|----------|`);
    for (const [mv, m] of mvEntries.sort((a, b) => b[1].total - a[1].total)) {
      const avgCalls = m.total > 0 ? (m.modelCalls / m.total).toFixed(2) : "0";
      const avgMs = m.total > 0 ? formatMs(m.durationMs / m.total) : "0ms";
      lines.push(`| ${mv} | ${m.total} | ${m.ok} | ${m.blocked} | ${m.error} | ${avgCalls} | ${avgMs} |`);
    }
  }
  lines.push("");

  // ----- Per-Chapter Detail -----
  if (params.results && params.results.length > 0) {
    lines.push(`## 8. 每章详情`);
    lines.push("");
    lines.push(`| chapter | status | outcome | selectedSource | calls | duration | textLen | hash |`);
    lines.push(`|---------|--------|---------|----------------|-------|----------|---------|------|`);
    for (const r of params.results) {
      const wsShort = r.workspaceId.length > 12 ? r.workspaceId.slice(0, 10) + ".." : r.workspaceId;
      const hash = r.textHash ?? "-";
      lines.push(
        `| ${wsShort}/ch${r.chapterNumber} | ${r.status} | ${r.outcomeType} | ${r.selectedSource ?? "-"} | ${r.modelCalls.length} | ${formatMs(r.durationMs)} | ${r.textLength} | ${hash} |`,
      );
    }
    lines.push("");
  }

  // ----- 验收门槛对照 -----
  lines.push(`## 9. 验收门槛对照（与稳定性门槛对齐）`);
  lines.push("");
  lines.push(`| 门槛 | 目标 | 实际 | 状态 |`);
  lines.push(`|------|------|------|------|`);
  const gate1 = metrics.recoverySuccessRate === null ? null : metrics.recoverySuccessRate;
  lines.push(`| 自动恢复后成功率 | ≥ 85% | ${gate1 === null ? "N/A" : `${(gate1 * 100).toFixed(2)}%`} | ${gateOK(gate1, 0.85)} |`);
  const blockRateGate = metrics.blockRate;
  lines.push(`| 阻断率 | 越低越好（参考 < 30%） | ${(blockRateGate * 100).toFixed(2)}% | ${blockRateGate < 0.30 ? "✅" : "⚠️"} |`);
  const avgCalls = metrics.modelCalls.averagePerChapter;
  lines.push(`| 平均模型调用 | ≤ ${SINGLE_CHAPTER_SOFT_BUDGET}（软限） | ${avgCalls} | ${avgCalls <= SINGLE_CHAPTER_SOFT_BUDGET ? "✅" : "⚠️"} |`);
  lines.push(`| 超硬上限章数 | 0 | ${metrics.modelCalls.overHardBudgetCount} | ${metrics.modelCalls.overHardBudgetCount === 0 ? "✅" : "❌"} |`);
  lines.push("");

  lines.push(`---`);
  lines.push(`_报告由 scripts/canary/canary-metrics.mjs:generateCanaryReport 生成_`);

  return lines.join("\n");
}

// ============================================================================
// 8. 辅助
// ============================================================================

function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }

function formatMs(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m${s}s`;
}

function gateOK(actual, target) {
  if (actual === null) return "—";
  return actual >= target ? "✅" : "❌";
}

// ============================================================================
// 导出
// ============================================================================

export const __test__ = {
  round2, round4, formatMs, gateOK, classifyOutcome, detectModelVersion,
};
