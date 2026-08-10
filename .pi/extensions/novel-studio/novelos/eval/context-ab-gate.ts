/**
 * Phase 6.1.1 收口：门禁与聚合逻辑提取为独立模块。
 *
 * 将 replay 脚本中的 evaluateGate / aggregate 函数提取为可导出模块，
 * 消除测试中复制门禁逻辑导致的同步漂移风险。
 *
 * Phase 6.2 扩展：支持逐类单因素消融变体的门禁评估。
 */

// ── 聚合输入条目类型 ──────────────────────────────────────────────────────

export interface ContextAbEntry {
  coverage: number;
  stopped: number;
  sourceRefCompleteness: number;
  totalResultChars: number;
  totalCalls: number;
  totalDuplicateQueries: number;
  schemaTokenCost: number;
  emptyResults: number;
  truncatedResults: number;
  errors: number;
  timeouts: number;
  parseErrors: number;
  invalidToolSelections: number;
  invalidIntents: number;
  contextBlockTokens: number;
  contextBlockChars: number;
  contextItemCount: number;
  contextCanonTokens: number;
  contextCharacterTokens: number;
  contextPromiseTokens: number;
  contextPatternTokens: number;
  contextExpectationTokens: number;
  contextPlannedTokens: number;
  firstValidEvidenceCall: number;
  provenance: unknown;
}

export interface ContextAbAggregate {
  avgCoverage: number;
  stopRate: number;
  avgSourceRef: number;
  totalChars: number;
  totalCalls: number;
  totalEmpty: number;
  totalErrors: number;
  totalTimeouts: number;
  totalParseErrors: number;
  totalInvalidTool: number;
  totalInvalidIntents: number;
  totalTruncated: number;
  totalDuplicateQueries: number;
  schemaTokenCost: number;
  totalContextBlockTokens: number;
  avgContextBlockTokens: number;
  totalContextBlockChars: number;
  avgContextItemCount: number;
  totalCanonTokens: number;
  totalCharacterTokens: number;
  totalPromiseTokens: number;
  totalPatternTokens: number;
  totalExpectationTokens: number;
  totalPlannedTokens: number;
  avgFirstValidEvidenceCall: number;
  avgFirstValidEvidenceCallValid: number;
  noEvidenceCount: number;
  count: number;
}

// ── 聚合函数 ──────────────────────────────────────────────────────────────

export function aggregate(entries: ContextAbEntry[]): ContextAbAggregate {
  const n = entries.length || 1;
  const s = (k: keyof ContextAbEntry): number =>
    entries.reduce((sum, r) => sum + (r[k] as number ?? 0), 0);
  const validEntries = entries.filter((e) => e.firstValidEvidenceCall >= 0);
  const validFirst = validEntries.length > 0
    ? validEntries.reduce((sum, e) => sum + e.firstValidEvidenceCall, 0) / validEntries.length
    : -1;

  return {
    avgCoverage: s("coverage") / n,
    stopRate: s("stopped") / n,
    avgSourceRef: s("sourceRefCompleteness") / n,
    totalChars: s("totalResultChars"),
    totalCalls: s("totalCalls"),
    totalEmpty: s("emptyResults"),
    totalErrors: s("errors"),
    totalTimeouts: s("timeouts"),
    totalParseErrors: s("parseErrors"),
    totalInvalidTool: s("invalidToolSelections"),
    totalInvalidIntents: s("invalidIntents"),
    totalTruncated: s("truncatedResults"),
    totalDuplicateQueries: s("totalDuplicateQueries"),
    schemaTokenCost: s("schemaTokenCost"),
    totalContextBlockTokens: s("contextBlockTokens"),
    avgContextBlockTokens: s("contextBlockTokens") / n,
    totalContextBlockChars: s("contextBlockChars"),
    avgContextItemCount: s("contextItemCount") / n,
    totalCanonTokens: s("contextCanonTokens"),
    totalCharacterTokens: s("contextCharacterTokens"),
    totalPromiseTokens: s("contextPromiseTokens"),
    totalPatternTokens: s("contextPatternTokens"),
    totalExpectationTokens: s("contextExpectationTokens"),
    totalPlannedTokens: s("contextPlannedTokens"),
    avgFirstValidEvidenceCall: s("firstValidEvidenceCall") / n,
    avgFirstValidEvidenceCallValid: validFirst,
    noEvidenceCount: entries.filter((e) => e.firstValidEvidenceCall < 0).length,
    count: entries.length,
  };
}

// ── 消融门禁（Phase 6.2） ─────────────────────────────────────────────────

export interface AblationGateResult {
  arm: string;
  coverageGteA: boolean;
  sourceRefGteA: boolean;
  failuresNotWorseThanA: boolean;
  stopRateNotDegraded: boolean;
  allPassed: boolean;
  coverageDelta: number;
  sourceRefDelta: number;
  tokenDelta: number;
  hasSignificantContribution: boolean;
}

/**
 * 消融门禁：每个消融 arm vs A 不降级。
 * delta（A - 消融 arm）：正值表示该类状态有正贡献。
 */
export function evaluateAblationGate(
  ablationAgg: ContextAbAggregate,
  aAgg: ContextAbAggregate,
  armLabel: string,
): AblationGateResult {
  const coverageGteA = ablationAgg.avgCoverage >= aAgg.avgCoverage - 1e-9;
  const sourceRefGteA = ablationAgg.avgSourceRef >= aAgg.avgSourceRef - 1e-9;
  const failuresNotWorseThanA =
    ablationAgg.totalErrors <= aAgg.totalErrors &&
    ablationAgg.totalTimeouts <= aAgg.totalTimeouts &&
    ablationAgg.totalParseErrors <= aAgg.totalParseErrors &&
    ablationAgg.totalEmpty <= aAgg.totalEmpty &&
    ablationAgg.totalInvalidTool <= aAgg.totalInvalidTool &&
    ablationAgg.totalTruncated <= aAgg.totalTruncated &&
    ablationAgg.totalInvalidIntents <= aAgg.totalInvalidIntents;
  const stopRateNotDegraded = ablationAgg.stopRate >= aAgg.stopRate - 0.05;
  const coverageDelta = aAgg.avgCoverage - ablationAgg.avgCoverage;
  const sourceRefDelta = aAgg.avgSourceRef - ablationAgg.avgSourceRef;
  const tokenDelta = aAgg.totalContextBlockTokens - ablationAgg.totalContextBlockTokens;
  const allPassed = coverageGteA && sourceRefGteA && failuresNotWorseThanA && stopRateNotDegraded;

  return {
    arm: armLabel,
    coverageGteA,
    sourceRefGteA,
    failuresNotWorseThanA,
    stopRateNotDegraded,
    allPassed,
    coverageDelta,
    sourceRefDelta,
    tokenDelta,
    hasSignificantContribution: coverageDelta > 0.05,
  };
}

// ── 门禁评估 ──────────────────────────────────────────────────────────────

export interface BGateResult {
  coverageGteA: boolean;
  sourceRefGteA: boolean;
  failuresNotWorseThanA: boolean;
  stopRateNotDegraded: boolean;
  tokenReduced: boolean;
  tokenReductionPct: string;
  firstEvidenceNotDelayed: boolean;
  allPassed: boolean;
}

export interface CDeltaResult {
  coverageDelta: number;
  sourceRefDelta: number;
  tokenDelta: number;
  marginalValueInsufficient: boolean;
}

export interface GateResult {
  bGate: BGateResult;
  cDelta: CDeltaResult;
}

/**
 * B 组门禁（压缩不降级）+ C 组 delta（无状态基线）。
 *
 * 失败门禁检查 7 项指标：errors / timeouts / parseErrors / empty / invTool / truncated / invIntents。
 */
export function evaluateGate(
  bAgg: ContextAbAggregate,
  cAgg: ContextAbAggregate,
  aAgg: ContextAbAggregate,
): GateResult {
  // B 组门禁
  const coverageGteA = bAgg.avgCoverage >= aAgg.avgCoverage - 1e-9;
  const sourceRefGteA = bAgg.avgSourceRef >= aAgg.avgSourceRef - 1e-9;
  const failuresNotWorseThanA =
    bAgg.totalErrors <= aAgg.totalErrors &&
    bAgg.totalTimeouts <= aAgg.totalTimeouts &&
    bAgg.totalParseErrors <= aAgg.totalParseErrors &&
    bAgg.totalEmpty <= aAgg.totalEmpty &&
    bAgg.totalInvalidTool <= aAgg.totalInvalidTool &&
    bAgg.totalTruncated <= aAgg.totalTruncated &&
    bAgg.totalInvalidIntents <= aAgg.totalInvalidIntents;
  const stopRateNotDegraded = bAgg.stopRate >= aAgg.stopRate - 0.05;
  const tokenReduction = aAgg.totalContextBlockTokens > 0
    ? 1 - (bAgg.totalContextBlockTokens / aAgg.totalContextBlockTokens)
    : 0;
  const tokenReduced = tokenReduction > 0.10;
  const aFirstValid = aAgg.avgFirstValidEvidenceCallValid ?? -1;
  const bFirstValid = bAgg.avgFirstValidEvidenceCallValid ?? -1;
  const firstEvidenceNotDelayed = aFirstValid < 0 || bFirstValid < 0
    ? true
    : bFirstValid <= aFirstValid + 1;

  const allPassed = coverageGteA && sourceRefGteA && failuresNotWorseThanA &&
    stopRateNotDegraded && tokenReduced && firstEvidenceNotDelayed;

  // C 组 delta
  const cCoverageDelta = aAgg.avgCoverage - cAgg.avgCoverage;
  const cSourceRefDelta = aAgg.avgSourceRef - cAgg.avgSourceRef;
  const cTokenDelta = aAgg.totalContextBlockTokens - cAgg.totalContextBlockTokens;
  const cMarginalValueInsufficient = cCoverageDelta < 0.05;

  return {
    bGate: {
      coverageGteA,
      sourceRefGteA,
      failuresNotWorseThanA,
      stopRateNotDegraded,
      tokenReduced,
      tokenReductionPct: (tokenReduction * 100).toFixed(1) + "%",
      firstEvidenceNotDelayed,
      allPassed,
    },
    cDelta: {
      coverageDelta: cCoverageDelta,
      sourceRefDelta: cSourceRefDelta,
      tokenDelta: cTokenDelta,
      marginalValueInsufficient: cMarginalValueInsufficient,
    },
  };
}
