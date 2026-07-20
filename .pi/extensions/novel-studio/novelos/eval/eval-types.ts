/**
 * NovelOS M1 评测 — Fixture 类型定义（Step 6.1）
 *
 * 定义评测 fixture 的数据结构。每个 fixture 构造一个独立的 workspace 场景，
 * 用于测量 NovelOS 检索/验证/修复能力的增益。
 *
 * 3 条 baseline 对比：
 * - B1 CompiledContext：只用 ContextCompiler 的静态上下文（当前 one_shot_raw）
 * - B2 AgenticRetrieval：NovelOS agent loop 检索 + 生成（agentic_raw 无 verifier）
 * - B3 VerifiedAgenticRaw：agentic_raw + NarrativeVerifier + 局部修复
 *
 * 设计原则：
 * - fixture 是自包含的：包含 workspace 设置 + 预期结果
 * - 不依赖真实模型调用：stub model 模拟检索对生成的影响
 * - 可测量：每个 fixture 有明确的 expected 结果，可计算 precision/recall
 */

// ============================================================================
// Fixture 类别
// ============================================================================

export type FixtureCategory =
  | "fact_retrieval" // 历史章节存在关键事实，初始 prompt 未提供
  | "knowledge_boundary" // 人物知识边界易错
  | "continuity_conflict" // 时间/空间连续性冲突
  | "negative_control" // 无需检索的简单章节（负控）
  | "adversarial_retrieval" // 检索结果含相似但错误事实（对抗）
  | "voice_damage"; // verifier 修复可能损伤声音（对抗）

// ============================================================================
// Workspace 设置
// ============================================================================

/** 历史章节 */
export interface FixtureChapter {
  number: number;
  title: string;
  text: string;
}

/** NarrativeState 片段（可选字段，缺省为空数组） */
export interface FixtureNarrativeState {
  canon?: Array<{
    id: string;
    fact: string;
    category: string;
    sourceChapter: string;
    sourceRef: string;
    confidence: number;
  }>;
  character?: Array<{
    id: string;
    characterId: string;
    field: string;
    value: string;
    sourceChapter: string;
    sourceRef: string;
    confidence: number;
  }>;
  promise?: Array<{
    id: string;
    promiseId: string;
    description: string;
    currentHeat: number;
    status: string;
    sourceChapter: string;
    sourceRef: string;
    confidence: number;
  }>;
  pattern?: Array<{
    id: string;
    patternType: string;
    description: string;
    sourceChapter: string;
    sourceRef: string;
    confidence: number;
  }>;
}

/** Workspace 配置 */
export interface FixtureWorkspace {
  workspaceId: string;
  config: {
    novelType: string;
    characters: Array<{ name: string; role: string }>;
  };
  historicalChapters: FixtureChapter[];
  narrativeState: FixtureNarrativeState;
}

// ============================================================================
// 章节意图与检索查询
// ============================================================================

export interface FixtureChapterIntent {
  chapterNumber: number;
  chapterId: string;
  relevantCharacters: string[];
  inviolableFacts: string[];
  /** 检索查询关键词（agent loop 应搜索这些关键词） */
  retrievalQueries: string[];
}

// ============================================================================
// 预期结果
// ============================================================================

export interface FixtureExpected {
  /**
   * 可检索事实：通过 NarrativeSearchService 应能找到的事实片段。
   * B2 优势来源：B1（CompiledContext）不含这些，B2（检索）能找到。
   */
  factsRetrievable: string[];
  /**
   * 已在 CompiledContext 中的事实：B1 就有，不需要检索。
   * 用于验证 B1 基线不是完全无知。
   */
  factsInCompiledContext: string[];
  /** 是否需要检索才能正确生成 */
  requiresRetrieval: boolean;
  /**
   * 禁止事实：角色不应知道的信息（知识边界）。
   * 如果生成正文包含这些 → verifier 应标记为 hard finding。
   */
  forbiddenFacts?: string[];
  /**
   * 带错误的候选正文（用于 verifier precision/recall 测试）。
   * 包含已知的连续性/事实/知识边界错误。
   */
  candidateWithErrors?: string;
  /**
   * 预期 verifier 发现的问题类型（与 candidateWithErrors 配对）。
   * 用于计算 verifier recall。
   */
  expectedVerifierFindings?: string[];
  /**
   * 健康候选正文（无错误）。
   * 用于计算 verifier precision（不应误报）。
   */
  healthyCandidate?: string;
}

// ============================================================================
// 完整 Fixture
// ============================================================================

export interface EvalFixture {
  id: string;
  name: string;
  description: string;
  category: FixtureCategory;
  workspace: FixtureWorkspace;
  chapterIntent: FixtureChapterIntent;
  expected: FixtureExpected;
}

// ============================================================================
// 评测结果
// ============================================================================

/** 单个 fixture 的检索评测结果 */
export interface RetrievalEvalResult {
  fixtureId: string;
  /** B1：CompiledContext 中包含的可检索事实数 */
  b1FactsFound: number;
  /** B2：NarrativeSearchService 检索到的可检索事实数 */
  b2FactsFound: number;
  /** B2-B1 检索增益 */
  retrievalGain: number;
  /** 总可检索事实数 */
  totalFactsRetrievable: number;
  /** B1 事实覆盖率 */
  b1Coverage: number;
  /** B2 事实覆盖率 */
  b2Coverage: number;
  /** 检索查询次数（= totalQueries，向后兼容别名） */
  retrievalQueries: number;
  /**
   * 错误检索数（= wrongEvidence 别名，向后兼容）。
   * M1-R1 起同单位指标为 wrongEvidence / returnedEvidence，
   * 不再用 wrongEvidence / queryCount（单位错误）。
   */
  wrongRetrievals: number;
  /** B2 证据是否通过工具协议获取（true=trajectory 中有 ranked_evidence 条目，P0-1） */
  viaToolProtocol: boolean;
  // ── M1-R1：同单位检索指标（分母统一为 returnedEvidence / totalQueries）──
  /** 全查询 ranked evidence 总数（工具实际返回的证据条数） */
  returnedEvidence: number;
  /** 含 ≥1 预期事实的 evidence 数（跨所有 origin，不再只过滤 chapter_span） */
  relevantEvidence: number;
  /** wrongEvidence = returnedEvidence - relevantEvidence */
  wrongEvidence: number;
  /** evidencePrecision = relevantEvidence / returnedEvidence */
  evidencePrecision: number;
  /** evidenceImprecisionRate = wrongEvidence / returnedEvidence */
  evidenceImprecisionRate: number;
  /** 返回 0 evidence 的查询组数 */
  failedQueries: number;
  /** 轨迹中 distinct 查询组数 */
  totalQueries: number;
  /** queryFailureRate = failedQueries / totalQueries */
  queryFailureRate: number;
}

/** P0-2：expected finding 与 actual finding 的一对一匹配明细 */
export interface FindingMatch {
  expectedFindingId: string;
  actualFindingId: string;
  matchEvidence: string;
}

/** 单个 fixture 的验证器评测结果 */
export interface VerifierEvalResult {
  fixtureId: string;
  /** 预期发现的问题数 */
  expectedFindings: number;
  /** 实际发现的 hard findings 数 */
  actualHardFindings: number;
  /** 命中的预期问题数 */
  truePositives: number;
  /** 误报数（健康候选被标记为问题） */
  falsePositives: number;
  /** precision = truePositives / (truePositives + falsePositives) */
  precision: number;
  /** recall = truePositives / expectedFindings */
  recall: number;
  /** P0-2：一对一匹配明细（一个 actual finding 最多贡献一个 TP） */
  findingMatches: FindingMatch[];
  /** P0-2：未匹配的 expected finding 内容 */
  unmatchedExpected: string[];
  /** P0-2：未匹配的 actual finding（计入 FP） */
  unmatchedActual: string[];
  /** P0-2：负控 fixture 标记（expectedFindings=0） */
  isNegativeControl: boolean;
}

/** 单个 fixture 的端到端评测结果 */
export interface EndToEndEvalResult {
  fixtureId: string;
  /** B1 候选正文长度 */
  b1TextLength: number;
  /** B2 候选正文长度 */
  b2TextLength: number;
  /** B3 候选正文长度（patch 后） */
  b3TextLength: number;
  /** B1 是否包含必需事实 */
  b1HasRequiredFacts: boolean;
  /** B2 是否包含必需事实 */
  b2HasRequiredFacts: boolean;
  /** B3 是否包含必需事实 */
  b3HasRequiredFacts: boolean;
  /** B3 是否修复了 B2 的问题 */
  b3FixedB2Issues: boolean;
  /** trajectory 是否完整 */
  trajectoryComplete: boolean;
  /** 模型调用次数 */
  modelCalls: number;
  /** 工具调用次数 */
  toolCalls: number;
  /** B1 是否触发 fallback */
  b1Fallback: boolean;
  /** B2 是否触发 fallback */
  b2Fallback: boolean;
  /** B3 是否触发 fallback */
  b3Fallback: boolean;
  /** B3 verifier 是否清零 */
  b3VerifierCleared: boolean;
  /** B3 修复轮次 */
  b3RepairRounds: number;
  /** B2 文本的 hard finding 数（独立 verifier 检查，不依赖 B2 loop） */
  b2HardFindingCount: number;
  /** B3 文本的 hard finding 数（独立 verifier 检查） */
  b3HardFindingCount: number;
  /** B2 的 hard findings 中被 B3 消除的数量 */
  b2IssuesFixedInB3: number;
  /** B2 agent loop 的 trajectory 文件路径（供 evalRetrieval 提取 ranked evidence，P0-1） */
  b2TrajectoryPath?: string;
  /** M1-R1：B3 注入的证据数（verifier 暴露 injected-evidence 追踪后计算，否则 undefined + TODO） */
  injectedEvidence?: number;
  /** M1-R1：B3 实际使用的正确证据数（否则 undefined + TODO） */
  usedCorrectEvidence?: number;
  /** M1-R1：evidenceUtilityRate = usedCorrectEvidence/injectedEvidence（B3 层，否则 undefined） */
  evidenceUtilityRate?: number;
}

// ============================================================================
// P0-4：GO 条件逐项检查
// ============================================================================

/** GO 条件单项检查结果 */
export interface GoCondition {
  name: string;
  passed: boolean;
  detail: string; // pass/fail 的具体数值
}

/** GO 预登记阈值（可由 env 覆盖） */
export interface GoThresholds {
  /** B2 覆盖率必须比 B1 高多少（默认 0.1） */
  b2OverB1FactCoverage: number;
  /** B3 覆盖率不得低于 B2 的容差（默认 0.0，即 B3 >= B2） */
  b3OverB2FactCoverage: number;
  /** B3 修复 B2 错误的 fixture 数下限（默认 1） */
  minB3FixedB2Fixtures: number;
  /** verifier precision 下限（默认 0.6） */
  minVerifierPrecision: number;
  /** verifier recall 下限（默认 0.3） */
  minVerifierRecall: number;
  /**
   * wrong-retrieval rate 上限（默认 0.3，向后兼容，读同一 env）。
   * M1-R1 起由 maxEvidenceImprecisionRate 主导（同单位），本字段保留为别名。
   */
  maxWrongRetrievalRate: number;
  /** trajectory 完整率下限（默认 0.9） */
  minTrajectoryCompleteRate: number;
  /** fallback 掩盖失败率上限（默认 0.0） */
  maxFallbackMaskingRate: number;
  // ── M1-R1：同单位检索指标阈值（不降阈值换 GO）──
  /** evidence imprecision rate 上限（wrongEvidence/returnedEvidence，默认 0.3） */
  maxEvidenceImprecisionRate: number;
  /** evidence precision 下限（relevantEvidence/returnedEvidence，默认 0.7） */
  minEvidencePrecision: number;
  /** query failure rate 上限（failedQueries/totalQueries，默认 0.3） */
  maxQueryFailureRate: number;
  /** evidence utility rate 下限（usedCorrectEvidence/injectedEvidence，默认 0.5，B3 层） */
  minEvidenceUtilityRate: number;
}

/** 完整评测报告 */
export interface EvalReport {
  timestamp: string;
  totalFixtures: number;
  retrievalResults: RetrievalEvalResult[];
  verifierResults: VerifierEvalResult[];
  endToEndResults: EndToEndEvalResult[];
  /** 聚合指标 */
  summary: {
    avgRetrievalGain: number;
    avgB1Coverage: number;
    avgB2Coverage: number;
    avgVerifierPrecision: number;
    avgVerifierRecall: number;
    trajectoryCompleteRate: number;
    fallbackTriggeredCount: number;
  };
  /** 验收决策建议（P0-4：go_candidate 取代 go，正式 GO 需人工抽样复核） */
  recommendation: "go_candidate" | "hold" | "no_go";
  recommendationReason: string;
  /** P0-4：GO 条件逐项检查结果（每项 pass/fail + 详情） */
  goConditions: GoCondition[];
  /** P0-4：负控 fixture 是否从聚合 precision 中排除 */
  negativeControlExcluded: boolean;
  /** 盲测包目录（go_candidate 时生成，Hold/No-Go 时为 undefined） */
  blindTestDir?: string;
}

// ============================================================================
// P1-1：质量评测报告（真实模型 B1/B2/B3 消融）
// ============================================================================

/** 单个 fixture 的质量评测结果 */
export interface QualityEvalFixtureResult {
  fixtureId: string;
  /** B1 候选正文 */
  b1Text: string;
  /** B2 候选正文 */
  b2Text: string;
  /** B3 候选正文 */
  b3Text: string;
  /** B1 是否包含必需事实 */
  b1HasRequiredFacts: boolean;
  /** B2 是否包含必需事实 */
  b2HasRequiredFacts: boolean;
  /** B3 是否包含必需事实 */
  b3HasRequiredFacts: boolean;
  /** B3 是否修复了 B2 的问题（独立 verifier 检查） */
  b3FixedB2Issues: boolean;
  /** B2 hard finding 数（独立 verifier） */
  b2HardFindingCount: number;
  /** B3 hard finding 数（独立 verifier） */
  b3HardFindingCount: number;
  /** B2 trajectory 文件路径 */
  b2TrajectoryPath?: string;
  /** B1/B2/B3 模型调用次数 */
  modelCalls: { b1: number; b2: number; b3: number };
  /** B1/B2/B3 fallback 标记 */
  fallbacks: { b1: boolean; b2: boolean; b3: boolean };
  /** M1-R1：per-fixture 检索指标块（从 b2TrajectoryPath 计算，供 CLI wrongRetrievalPassed 修复） */
  retrieval?: {
    returnedEvidence: number;
    relevantEvidence: number;
    wrongEvidence: number;
    evidencePrecision: number;
    evidenceImprecisionRate: number;
    failedQueries: number;
    totalQueries: number;
    queryFailureRate: number;
    viaToolProtocol: boolean;
  };
  /** M1-R1：B3 证据利用率（verifier 暴露 injected-evidence 追踪后计算，否则 undefined + TODO） */
  injectedEvidence?: number;
  usedCorrectEvidence?: number;
  evidenceUtilityRate?: number;
}

/** 质量评测 provenance（审计用，不进盲测包） */
export interface QualityEvalProvenance {
  /** 模型标识（来自首次调用的返回） */
  model: string;
  /** 路由名 */
  route: string;
  /** 采样参数（温度等，从 env 或 route 配置推断） */
  samplingParams: {
    temperature?: number;
    maxTokens?: number;
  };
  /** 预算快照 */
  budgetSnapshot?: unknown;
}

/** 质量评测完整报告 */
export interface QualityEvalReport {
  timestamp: string;
  totalFixtures: number;
  /** 每个 fixture 的结果 */
  perFixture: QualityEvalFixtureResult[];
  /** 聚合指标 */
  summary: {
    avgB1Coverage: number;
    avgB2Coverage: number;
    avgB3Coverage: number;
    avgB2OverB1FactCoverage: number;
    avgB3OverB2FactCoverage: number;
    b3FixedB2Rate: number;
  };
  /** provenance（审计用，不进盲测包） */
  provenance: QualityEvalProvenance;
  /** 匿名盲测包目录（不含 baseline 名称） */
  blindTestDir: string;
}
