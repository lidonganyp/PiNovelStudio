/**
 * HumanProxyProvenance — gpt5.6-sol 人审代理 verdict 规范化（P0-B）
 *
 * 派工计划 docs/remaining-development-dispatch-plan-20260715.md §3 P0-B：
 * 将既有 gpt5.6-sol 匿名 A/B verdict 规范化为可计数、可追溯且归属到具体
 * modelVersion + strategyId 的 human-equivalent evidence。
 *
 * 设计原则：
 * - 固定身份：reviewerType=validated_human_proxy、reviewerModel=gpt5.6-sol、humanEquivalent=true
 *   不得写成 natural_person；普通 judge/machine-review 不得 humanEquivalent
 * - 不改 winner：只读取既有 verdict 数据，规范化为统一 schema，不重跑审阅
 * - 不改生产：不写 finalText / 不提交 state / 不改策略信誉 / 不是 gate
 * - 标签隔离：rationale/summary 不得泄露 editorial/raw 标签（匿名 A/B 表单原则）
 * - 策略隔离：按 (modelVersion, strategyId) 分区计数，不得跨策略合并
 * - 模型版本隔离：不同 modelVersion 分区计数
 *
 * 边界（L0 工程闭环）：
 * - 纯函数：不调用网络模型、不读写文件（provenance 由调用方提供）
 * - 不是 gate；不阻断正文生成
 * - 不修改 StrategyPolicyStore / alpha / beta
 *
 * 与 strategy-evidence-dataset.ts 的关系：
 * - 本模块产出 NormalizedHumanProxyVerdict（含 reviewerType/humanEquivalent）
 * - strategy-evidence-dataset.ts 的 StrategyEvidenceRecord.hasHumanVerdict 是 boolean
 * - 调用方可将 normalized verdict 映射为 StrategyEvidenceRecord（hasHumanVerdict=true
 *   当且仅当 humanEquivalent=true && reviewerType=validated_human_proxy）
 */

// ============================================================================
// Schema 常量
// ============================================================================

export const HUMAN_PROXY_PROVENANCE_SCHEMA_ID = "pinovel.human-proxy-provenance" as const;

/**
 * 固定审阅者身份常量（派工计划 P0-B acceptance）。
 * gpt5.6-sol 经用户实测与真人审阅一致，定义为 validated_human_proxy。
 */
export const FIXED_REVIEWER_TYPE = "validated_human_proxy" as const;
export const FIXED_REVIEWER_MODEL = "gpt5.6-sol" as const;
export const FIXED_HUMAN_EQUIVALENT = true as const;

// ============================================================================
// 类型
// ============================================================================

/**
 * 规范化输入：从既有 artifact 提取的 raw verdict 数据。
 * 调用方负责读取 reports/*.json 或 docs/*.md 并填充此结构。
 */
export interface VerdictNormalizationInput {
  /** 既有 artifact 路径（用于 provenance 追溯） */
  sourceArtifactPath: string;
  /** 既有 artifact SHA-256（用于校验同源，防篡改） */
  sourceArtifactHash: string;
  /** 单次 orchestrator 运行 ID */
  orchestratorRunId: string;
  /** case 标识（如 "case-04-xinmo-ch19"） */
  caseId: string;
  /** workspace 标识 */
  workspaceId: string;
  /** 来源章节（如 "ch19"） */
  sourceChapter: string;
  /** 生成模型版本（如 "glm-5.2"）——策略证据按此版本隔离 */
  modelVersion: string;
  /** 策略 ID（如 "reader_payoff_strengthen"） */
  strategyId: string;
  /** 审阅模型（必须为 gpt5.6-sol） */
  reviewerModel: string;
  /** 匿名 A/B 映射：A/B -> "raw" 或 "editorial" */
  anonymousMapping: { A: string; B: string };
  /** 胜出方（匿名侧 A/B/tie/undecided） */
  winner: "A" | "B" | "tie" | "undecided";
  /** 置信度 */
  confidence: "clear" | "slight" | "uncertain";
  /** 是否值得替换 */
  worthReplacing?: boolean;
  /** 决定性理由（含文本 span 证据） */
  decisiveReasons: Array<{
    dimension: string;
    betterCandidate: "A" | "B";
    evidenceExcerpt: string;
    explanation: string;
  }>;
  /** 审阅总结（不得泄露 editorial/raw 标签） */
  summary: string;
  /** 生产 judge 选择（可选，用于异构一致性记录） */
  productionJudgeSelection?: "raw" | "editorial" | "tie";
  /** 时间戳 ISO */
  timestamp: string;
}

/**
 * 结构化 verdict span（解匿名后）。
 */
export interface VerdictSpan {
  /** 匿名侧（A/B） */
  side: "A" | "B";
  /** 候选正文片段 */
  excerpt: string;
  /** 评审维度 */
  dimension: string;
  /** 说明 */
  explanation: string;
}

/**
 * 规范化后的 human-proxy verdict。
 */
export interface NormalizedHumanProxyVerdict {
  schemaId: typeof HUMAN_PROXY_PROVENANCE_SCHEMA_ID;
  /** verdict 唯一 ID（由 caseId + strategyId 派生） */
  verdictId: string;
  /** 偏好（解匿名后：raw/editorial/tie/undecided） */
  preference: "raw" | "editorial" | "tie" | "undecided";
  /** 胜出 span（betterCandidate === winner） */
  winningSpans: VerdictSpan[];
  /** 落败 span（betterCandidate !== winner） */
  losingSpans: VerdictSpan[];
  /** 审阅总结 */
  rationale: string;
  /** 匿名 A/B 映射 */
  anonymousMapping: { A: string; B: string };
  /** 来源 provenance */
  provenance: {
    sourceArtifactPath: string;
    sourceArtifactHash: string;
    orchestratorRunId: string;
    caseId: string;
    workspaceId: string;
    sourceChapter: string;
  };
  /** 生成模型版本（策略证据按此版本隔离） */
  modelVersion: string;
  /** 策略 ID */
  strategyId: string;
  /** 来源章节（顶层镜像 provenance.sourceChapter，便于分区与 reporting 直接访问） */
  sourceChapter: string;
  /** 固定审阅者身份（validated_human_proxy） */
  reviewerType: "validated_human_proxy";
  /** 固定审阅模型（gpt5.6-sol） */
  reviewerModel: "gpt5.6-sol";
  /** 固定 human-equivalent 标记（true） */
  humanEquivalent: true;
  /** 置信度 */
  confidence: "clear" | "slight" | "uncertain";
  /** 是否值得替换 */
  worthReplacing?: boolean;
  /** 时间戳 */
  timestamp: string;
  /** 异构一致性：生产 judge 与 proxy 是否一致（无对比时 undefined） */
  productionJudgeAgreement?: boolean;
}

export type NormalizeResult =
  | { ok: true; verdict: NormalizedHumanProxyVerdict }
  | { ok: false; reasons: string[] };

export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: string[] };

/**
 * 单个 (modelVersion, strategyId) 分区的计数。
 */
export interface ProvenanceMatrixEntry {
  modelVersion: string;
  strategyId: string;
  /** natural_person 审阅数（本模块固定为 0，因 reviewerType 恒为 validated_human_proxy） */
  naturalHumanCount: number;
  /** validated_human_proxy 审阅数 */
  validatedProxyCount: number;
  /** humanEquivalent=true 的审阅数 */
  humanEquivalentCount: number;
  /** 有效 eligible 审阅数（preference != undecided） */
  eligibleCount: number;
}

/**
 * provenance 计数矩阵。
 */
export interface ProvenanceMatrix {
  entries: ProvenanceMatrixEntry[];
  /**
   * 全局 human 子门是否满足。
   * 派工计划 P0-B reporting：不得报告全局 human 子门已满足。
   * 分区级别 canPromote 由 strategy-evidence-dataset.compileAdmissionDecisions 单独评估。
   */
  globalHumanSubgateSatisfied: boolean;
}

// ============================================================================
// 辅助函数
// ============================================================================

const VALID_CANDIDATE_KINDS = new Set(["raw", "editorial"]);
const LABEL_LEAK_PATTERN = /\b(editorial|raw)\b/i;

/**
 * 检查字符串是否泄露 editorial/raw 标签。
 * 仅检查 reviewer 的总结性文字（summary/explanation），不检查候选正文片段（evidenceExcerpt）。
 */
function leaksLabel(text: string): boolean {
  return LABEL_LEAK_PATTERN.test(text);
}

/**
 * 解匿名：winner + anonymousMapping → preference。
 */
function resolvePreference(
  winner: VerdictNormalizationInput["winner"],
  mapping: { A: string; B: string },
): "raw" | "editorial" | "tie" | "undecided" {
  if (winner === "tie") return "tie";
  if (winner === "undecided") return "undecided";
  return mapping[winner] as "raw" | "editorial";
}

// ============================================================================
// normalizeVerdict：规范化既有 verdict
// ============================================================================

/**
 * 将既有 gpt5.6-sol verdict 规范化为 NormalizedHumanProxyVerdict。
 *
 * 步骤：
 * 1. 验证 reviewerModel === "gpt5.6-sol"（否则 invalid：普通 judge/machine-review 不得 humanEquivalent）
 * 2. 验证 anonymousMapping 完整（A/B 都存在，值为 raw/editorial，且 A !== B）
 * 3. 解匿名：winner + mapping → preference
 * 4. 构造 winningSpans（betterCandidate === winner）/ losingSpans（betterCandidate !== winner）
 * 5. 标签泄露检查：summary 与所有 explanation 不得含 editorial/raw 标签
 * 6. 验证 winningSpans 非空（除非 preference=tie/undecided 且有 decisiveReasons）
 * 7. 验证 modelVersion/strategyId/sourceArtifactHash 非空
 * 8. 固定 reviewerType=validated_human_proxy, reviewerModel=gpt5.6-sol, humanEquivalent=true
 * 9. 计算异构一致性（productionJudgeAgreement）
 *
 * 不变量：
 * - 不读写文件（provenance 由调用方提供）
 * - 不调用模型
 * - 不修改生产正文/状态/策略信誉
 */
export function normalizeVerdict(input: VerdictNormalizationInput): NormalizeResult {
  const reasons: string[] = [];

  // 1. reviewerModel 必须为 gpt5.6-sol
  if (input.reviewerModel !== FIXED_REVIEWER_MODEL) {
    reasons.push(
      `reviewerModel 必须为 ${FIXED_REVIEWER_MODEL}（当前：${input.reviewerModel}）；普通 judge/machine-review 不得 humanEquivalent`,
    );
  }

  // 2. anonymousMapping 完整性
  const mapping = input.anonymousMapping;
  if (!mapping || typeof mapping !== "object") {
    reasons.push("anonymousMapping 缺失");
  } else {
    if (typeof mapping.A !== "string" || typeof mapping.B !== "string") {
      reasons.push("anonymousMapping 必须含 A 和 B 两个字符串字段");
    } else if (!VALID_CANDIDATE_KINDS.has(mapping.A) || !VALID_CANDIDATE_KINDS.has(mapping.B)) {
      reasons.push(
        `anonymousMapping 的 A/B 值必须为 raw 或 editorial（当前：A=${mapping.A}, B=${mapping.B}）`,
      );
    } else if (mapping.A === mapping.B) {
      reasons.push(
        `anonymousMapping 的 A 和 B 不能映射到同一候选（A=${mapping.A}, B=${mapping.B}）`,
      );
    }
  }

  // 7. 必填字段非空
  if (typeof input.modelVersion !== "string" || input.modelVersion.trim().length === 0) {
    reasons.push("modelVersion 必须为非空字符串");
  }
  if (typeof input.strategyId !== "string" || input.strategyId.trim().length === 0) {
    reasons.push("strategyId 必须为非空字符串");
  }
  if (typeof input.sourceArtifactHash !== "string" || input.sourceArtifactHash.trim().length === 0) {
    reasons.push("sourceArtifactHash 必须为非空字符串（artifact 不同源校验失败）");
  }
  if (typeof input.sourceArtifactPath !== "string" || input.sourceArtifactPath.trim().length === 0) {
    reasons.push("sourceArtifactPath 必须为非空字符串");
  }
  if (typeof input.orchestratorRunId !== "string" || input.orchestratorRunId.trim().length === 0) {
    reasons.push("orchestratorRunId 必须为非空字符串");
  }
  if (typeof input.caseId !== "string" || input.caseId.trim().length === 0) {
    reasons.push("caseId 必须为非空字符串");
  }
  if (typeof input.workspaceId !== "string" || input.workspaceId.trim().length === 0) {
    reasons.push("workspaceId 必须为非空字符串");
  }
  if (typeof input.sourceChapter !== "string" || input.sourceChapter.trim().length === 0) {
    reasons.push("sourceChapter 必须为非空字符串");
  }

  // decisiveReasons 必须非空
  if (!Array.isArray(input.decisiveReasons) || input.decisiveReasons.length === 0) {
    reasons.push("decisiveReasons 必须非空（无 span 证据的 verdict 无效）");
  }

  // 5. 标签泄露检查：summary 不得含 editorial/raw 标签
  if (typeof input.summary === "string" && leaksLabel(input.summary)) {
    reasons.push(
      `summary 泄露 editorial/raw 标签（匿名 A/B 表单原则：reviewer 不应知哪个是 raw/editorial）`,
    );
  }

  // 标签泄露检查：explanation 不得含 editorial/raw 标签
  if (Array.isArray(input.decisiveReasons)) {
    for (let i = 0; i < input.decisiveReasons.length; i += 1) {
      const r = input.decisiveReasons[i];
      if (r && typeof r.explanation === "string" && leaksLabel(r.explanation)) {
        reasons.push(
          `decisiveReasons[${i}].explanation 泄露 editorial/raw 标签`,
        );
      }
    }
  }

  if (reasons.length > 0) {
    return { ok: false, reasons };
  }

  // 3. 解匿名
  const preference = resolvePreference(input.winner, input.anonymousMapping);

  // 4. 构造 winningSpans / losingSpans
  const winningSpans: VerdictSpan[] = [];
  const losingSpans: VerdictSpan[] = [];
  for (const r of input.decisiveReasons) {
    const span: VerdictSpan = {
      side: r.betterCandidate,
      excerpt: r.evidenceExcerpt,
      dimension: r.dimension,
      explanation: r.explanation,
    };
    if (input.winner === "tie" || input.winner === "undecided") {
      // tie/undecided：无明确胜出方，所有 span 归入 losingSpans（分析性证据）
      losingSpans.push(span);
    } else if (r.betterCandidate === input.winner) {
      winningSpans.push(span);
    } else {
      losingSpans.push(span);
    }
  }

  // 6. winningSpans 可为空：preference 由 winner + anonymousMapping 解匿名得出，
  //    独立于 decisiveReasons 的 betterCandidate 偏向。当 winner 与 reasons 偏向不一致时
  //    （如 winner=B 但 reasons 偏向 A），preference 仍以 winner 为准，winningSpans 为空、
  //    losingSpans 含全部 reasons。decisiveReasons 必须非空（无 span 证据）已在上方校验。

  // 9. 异构一致性
  let productionJudgeAgreement: boolean | undefined;
  if (input.productionJudgeSelection !== undefined) {
    productionJudgeAgreement = input.productionJudgeSelection === preference;
  }

  const verdict: NormalizedHumanProxyVerdict = {
    schemaId: HUMAN_PROXY_PROVENANCE_SCHEMA_ID,
    verdictId: `${input.caseId}::${input.strategyId}`,
    preference,
    winningSpans,
    losingSpans,
    rationale: input.summary,
    anonymousMapping: { A: input.anonymousMapping.A, B: input.anonymousMapping.B },
    provenance: {
      sourceArtifactPath: input.sourceArtifactPath,
      sourceArtifactHash: input.sourceArtifactHash,
      orchestratorRunId: input.orchestratorRunId,
      caseId: input.caseId,
      workspaceId: input.workspaceId,
      sourceChapter: input.sourceChapter,
    },
    modelVersion: input.modelVersion,
    strategyId: input.strategyId,
    sourceChapter: input.sourceChapter,
    reviewerType: FIXED_REVIEWER_TYPE,
    reviewerModel: FIXED_REVIEWER_MODEL,
    humanEquivalent: FIXED_HUMAN_EQUIVALENT,
    confidence: input.confidence,
    worthReplacing: input.worthReplacing,
    timestamp: input.timestamp,
    productionJudgeAgreement,
  };

  return { ok: true, verdict };
}

// ============================================================================
// validateNormalizedVerdict：验证已规范化的 verdict
// ============================================================================

/**
 * 验证 NormalizedHumanProxyVerdict 的完整性。
 *
 * 检查：
 * - reviewerType === "validated_human_proxy"（不得为 natural_person）
 * - humanEquivalent === true
 * - reviewerModel === "gpt5.6-sol"
 * - winningSpans 非空（preference != tie/undecided 时）
 * - anonymousMapping 一致
 * - preference 与 anonymousMapping 一致
 *
 * 用于检测 verdict 被篡改（如 reviewerType 被改为 natural_person）。
 */
export function validateNormalizedVerdict(
  verdict: unknown,
): ValidationResult {
  const errors: string[] = [];

  if (typeof verdict !== "object" || verdict === null || Array.isArray(verdict)) {
    return { ok: false, errors: ["verdict 必须是对象"] };
  }

  const v = verdict as Record<string, unknown>;

  if (v.reviewerType !== FIXED_REVIEWER_TYPE) {
    errors.push(
      `reviewerType 必须为 ${FIXED_REVIEWER_TYPE}（不得为 natural_person，当前：${v.reviewerType}）`,
    );
  }
  if (v.humanEquivalent !== true) {
    errors.push("humanEquivalent 必须为 true（普通 judge/machine-review 不得 humanEquivalent）");
  }
  if (v.reviewerModel !== FIXED_REVIEWER_MODEL) {
    errors.push(`reviewerModel 必须为 ${FIXED_REVIEWER_MODEL}（当前：${v.reviewerModel}）`);
  }

  if (typeof v.preference !== "string" || !["raw", "editorial", "tie", "undecided"].includes(v.preference)) {
    errors.push("preference 必须为 raw/editorial/tie/undecided");
  }

  if (!Array.isArray(v.winningSpans)) {
    errors.push("winningSpans 必须是数组");
  } else if (v.preference !== "tie" && v.preference !== "undecided" && v.winningSpans.length === 0) {
    errors.push("winningSpans 不得为空（preference != tie/undecided 时）");
  }

  if (!Array.isArray(v.losingSpans)) {
    errors.push("losingSpans 必须是数组");
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true };
}

// ============================================================================
// compileProvenanceMatrix：按 modelVersion + strategyId 计数
// ============================================================================

/**
 * 编译 provenance 计数矩阵。
 *
 * 步骤：
 * 1. 按 (modelVersion, strategyId) 分区
 * 2. 每分区累计：
 *    - naturalHumanCount（reviewerType=natural_person，本模块恒为 0）
 *    - validatedProxyCount（reviewerType=validated_human_proxy）
 *    - humanEquivalentCount（humanEquivalent=true）
 *    - eligibleCount（preference != undecided）
 * 3. globalHumanSubgateSatisfied：派工计划 P0-B reporting 不得报告全局已满足，恒为 false
 *
 * 不变量：
 * - 不得跨策略合并（不同 strategyId 分开计数）
 * - 模型版本隔离（不同 modelVersion 分开计数）
 * - 纯函数：不修改入参，不调用任何 store
 */
export function compileProvenanceMatrix(
  verdicts: NormalizedHumanProxyVerdict[],
): ProvenanceMatrix {
  interface Accumulator {
    modelVersion: string;
    strategyId: string;
    naturalHumanCount: number;
    validatedProxyCount: number;
    humanEquivalentCount: number;
    eligibleCount: number;
  }

  const partitions = new Map<string, Accumulator>();

  for (const v of verdicts) {
    const key = `${v.modelVersion}::${v.strategyId}`;
    let p = partitions.get(key);
    if (!p) {
      p = {
        modelVersion: v.modelVersion,
        strategyId: v.strategyId,
        naturalHumanCount: 0,
        validatedProxyCount: 0,
        humanEquivalentCount: 0,
        eligibleCount: 0,
      };
      partitions.set(key, p);
    }
    // 防御性计数：运行时类型可能被绕过（JS 调用方），按字符串比较保留 natural_person 检测。
    // 静态类型层面 reviewerType 恒为 validated_human_proxy，naturalHumanCount 恒为 0。
    const reviewerType = v.reviewerType as string;
    if (reviewerType === "natural_person") {
      p.naturalHumanCount += 1;
    } else if (reviewerType === "validated_human_proxy") {
      p.validatedProxyCount += 1;
    }
    const humanEquivalent = v.humanEquivalent as unknown;
    if (humanEquivalent === true) {
      p.humanEquivalentCount += 1;
    }
    const preference = v.preference as string;
    if (preference !== "undecided") {
      p.eligibleCount += 1;
    }
  }

  const entries: ProvenanceMatrixEntry[] = Array.from(partitions.values()).map((p) => ({
    modelVersion: p.modelVersion,
    strategyId: p.strategyId,
    naturalHumanCount: p.naturalHumanCount,
    validatedProxyCount: p.validatedProxyCount,
    humanEquivalentCount: p.humanEquivalentCount,
    eligibleCount: p.eligibleCount,
  }));

  // 字典序排序，保证输出确定性
  entries.sort((a, b) => {
    if (a.modelVersion !== b.modelVersion) {
      return a.modelVersion < b.modelVersion ? -1 : 1;
    }
    if (a.strategyId !== b.strategyId) {
      return a.strategyId < b.strategyId ? -1 : 1;
    }
    return 0;
  });

  return {
    entries,
    // 派工计划 P0-B reporting：不得报告全局 human 子门已满足。
    // 分区级别 canPromote 由 strategy-evidence-dataset.compileAdmissionDecisions 单独评估。
    globalHumanSubgateSatisfied: false,
  };
}
