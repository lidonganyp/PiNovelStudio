/**
 * KnowledgeConsumptionCompiler — few-shot/contrastive 生产消费审计（KNOWLEDGE-CONSUMPTION-1，计划 §6.3）
 *
 * 目标：在 raw 生成前，把 FewshotSelector 的检索结果包装为带审计字段的 compact block，
 * 让 raw prompt 能看到少量参考示例（advisory 非强制模仿），并在 stageResults 中
 * 记录每个示例的 provenance/score/reason/token cost，证明示例被选中、被消费、未污染正文。
 *
 * 核心不变量（KNOWLEDGE-CONSUMPTION-1 任务书）：
 * - 每个示例有 provenance(source)/qualityScore/selectionReason/tokenCost。
 * - 无匹配时返回 empty selection（emptyReason），不伪造示例。
 * - P0/P1 不因示例被淘汰（advisoryOnly=true；不强制模仿模板）。
 * - trace 证明 prompt 实际消费（consumedByRawPrompt 字段）。
 * - 无 manifest 准入数据不得静默加载（manifestApproved=false 强制返回 empty）。
 * - 重复示例合并保留全部来源；截断/去重/预算淘汰写 lossReport。
 * - provenance 必须匹配 approved sources；非法或分数预算 fail-closed。
 * - 数据缺失返回 empty selection，不阻断生成。
 * - 不调用 LLM；不修改 finalText；不提交状态；不是 gate；不阻断正文生成。
 *
 * 确定性本地编译：零 LLM 调用，纯数据转换。
 *
 * 复用关系：本模块不重复 FewshotSelector 的检索逻辑（runtime/flat manifest 准入、
 * 场景类型/节拍/冲突/情绪评分、maxExamples 由 FewshotSelector 完成）。本模块负责
 * provenance 复核、单例/总预算与 loss audit，再包装为"审计字段 + prompt block"。
 */

// ============================================================================
// 数据契约
// ============================================================================

/**
 * 单条示例的审计条目。
 * 比 FewshotExample 多 selectionReason 和 tokenCost 字段。
 */
export interface KnowledgeExampleEntry {
  /** 示例 id（来自 FewshotSelector） */
  id: string;
  /** 来源标识（runtime/flat 或精确 approved source；provenance） */
  source: string;
  /** 质量分数（来自 FewshotSelector） */
  qualityScore: number;
  /** 选中原因（哪些维度匹配：sceneType/narrativeBeat/conflictLevel/emotionTarget） */
  selectionReason: string;
  /** token 成本估算（中文 chars / 4 保守估算） */
  tokenCost: number;
  /** 示例文本（截断到 maxCharsPerExample） */
  text: string;
  /** 同 id 合并后的全部 provenance（source 保留首条兼容字段） */
  sourceRefs?: string[];
}

export interface KnowledgeLossReport {
  truncations: Array<{
    id: string;
    originalChars: number;
    retainedChars: number;
    reason: string;
  }>;
  duplicateDrops: Array<{
    id: string;
    retainedSource: string;
    droppedSource: string;
    reason: string;
  }>;
  budgetDrops: Array<{
    id: string;
    tokenCost: number;
    remainingBudget: number;
    reason: string;
  }>;
  provenanceDrops: Array<{
    id: string;
    source: string;
    reason: string;
  }>;
  totalTokenBudget?: number;
}

/**
 * 知识消费审计上下文。
 * 写入 stageResults.knowledgeConsumption 供 trace 审计。
 */
export interface KnowledgeConsumptionContext {
  /** 选中的示例条目（带审计字段） */
  entries: KnowledgeExampleEntry[];
  /** 总 token 成本（各 entry tokenCost 之和） */
  totalTokenCost: number;
  /** 总字符数 */
  totalChars: number;
  /** 使用通道（runtime/flat/mixed/empty） */
  channel: "runtime" | "flat" | "mixed" | "empty";
  /** 来源汇总（去重） */
  sourceRefs: string[];
  /** manifest 准入状态（false 时强制 empty） */
  manifestApproved: boolean;
  /** raw prompt 是否实际消费了该 compact block */
  consumedByRawPrompt: boolean;
  /** advisoryOnly 恒为 true：示例是参考，非强制模仿模板 */
  advisoryOnly: true;
  /** 空状态原因（不得静默，必须写明） */
  emptyReason?: string;
  /** 截断、重复、预算与 provenance 丢弃审计 */
  lossReport?: KnowledgeLossReport;
  /** 切片范围声明（防止下游误用为完整知识库） */
  proxyNote?: string;
}

/**
 * 编译输入：从 FewshotSelector 的检索结果派生。
 *
 * 调用方负责：
 * 1. 实例化 FewshotSelector 并调用 select(context) 得到 FewshotSelectionResult
 * 2. 把 result.examples / result.channel / result.sources / manifest 状态传入本编译器
 *
 * 本编译器不直接调用 FewshotSelector（保持纯函数，便于测试）。
 */
export interface KnowledgeConsumptionCompileInput {
  /** FewshotSelector 选中的示例 */
  examples: ReadonlyArray<{
    id: string;
    sceneType?: string;
    text: string;
    qualityScore: number;
    source: string;
    narrativeBeat?: string;
    conflictLevel?: number;
    emotionTarget?: string;
  }>;
  /** 检索查询条件（用于推导 selectionReason） */
  query: {
    sceneType?: string;
    narrativeBeat?: string;
    conflictLevel?: number;
    emotionTarget?: string;
  };
  /** FewshotSelector 报告的通道 */
  channel: "runtime" | "flat" | "mixed" | "empty";
  /** FewshotSelector 报告的来源列表 */
  sources: ReadonlyArray<string>;
  /** manifest 准入状态（false 时强制 empty） */
  manifestApproved: boolean;
  /** 每个示例最大字符数（截断） */
  maxCharsPerExample: number;
  /** 全部示例的可选 token 总预算（省略时默认 390） */
  maxTotalTokenCost?: number;
}

/**
 * 编译输出。
 */
export interface KnowledgeConsumptionCompileResult {
  knowledgeConsumptionContext: KnowledgeConsumptionContext;
  /** 格式化后的"参考示例"prompt 区块；entries 为空时返回 null */
  promptBlock: string | null;
}

// ============================================================================
// 常量
// ============================================================================

/**
 * 中文 token 估算系数：1 token ≈ 4 字符（保守估算，与 OpenAI token 估算一致）。
 * 实际中文 token 比例通常 1 token ≈ 1.5-2 字符，但保守估算避免低估成本。
 */
const CHARS_PER_TOKEN = 4;
const DEFAULT_MAX_TOTAL_TOKEN_COST = 390;

/**
 * 切片范围声明（固定文案）。
 * 防止下游消费者误以为示例是强制模仿模板或完整知识库。
 */
const PROXY_NOTE =
  "本切片只编译 FewshotSelector 已检索的示例为审计条目（provenance/score/reason/tokenCost）；" +
  "示例是 advisory 参考非强制模仿模板；不全量加载场景/技法库；" +
  "无 manifest 准入数据不得静默加载；收益验证由 EDITORIAL-BENEFIT-2 或独立授权完成";

// ============================================================================
// 核心编译逻辑
// ============================================================================

/**
 * 编译知识消费审计上下文。
 *
 * 编译规则：
 * 1. manifestApproved=false → 强制 empty（emptyReason="manifest 未批准，不得静默加载"）。
 * 2. examples 为空 → empty（emptyReason="无匹配示例"）。
 * 3. 否则：
 *    a. 校验 source 能映射到 approved sources
 *    b. 对每个 example 计算 selectionReason 与 tokenCost
 *    c. 截断 text 到 maxCharsPerExample，并记录原/保留长度
 *    d. 同 id 去重，正文保留首条并聚合全部 provenance
 *    e. 按输入顺序执行 total token budget，淘汰项写 lossReport
 *
 * 不调用 LLM，不修改 finalText，不提交状态，不是 gate。
 */
export function compileKnowledgeConsumptionContext(
  input: KnowledgeConsumptionCompileInput
): KnowledgeConsumptionCompileResult {
  const {
    examples,
    query,
    channel,
    sources,
    manifestApproved,
    maxCharsPerExample,
    maxTotalTokenCost,
  } = input;

  const effectiveMaxTotalTokenCost = maxTotalTokenCost ?? DEFAULT_MAX_TOTAL_TOKEN_COST;
  const lossReport = createLossReport(effectiveMaxTotalTokenCost);

  // 1. manifest 未批准 → 强制 empty
  if (!manifestApproved) {
    return createEmptyKnowledgeResult(
      false,
      "manifest 未批准（approved=false），不得静默加载示例",
      sources,
      lossReport
    );
  }

  if (!Number.isSafeInteger(maxCharsPerExample) || maxCharsPerExample <= 0) {
    return createEmptyKnowledgeResult(
      true,
      "maxCharsPerExample 必须是有限正数，非法预算拒绝消费示例",
      sources,
      lossReport
    );
  }
  if (
    !Number.isSafeInteger(effectiveMaxTotalTokenCost) ||
    effectiveMaxTotalTokenCost <= 0
  ) {
    return createEmptyKnowledgeResult(
      true,
      "maxTotalTokenCost 必须是有限正数，非法预算拒绝消费示例",
      sources,
      lossReport
    );
  }

  // 2. examples 为空 → empty
  if (!examples || examples.length === 0) {
    return createEmptyKnowledgeResult(
      true,
      "FewshotSelector 无匹配示例（query 未命中任何示例）",
      sources,
      lossReport
    );
  }

  // 3. 校验 provenance、截断并按 id 合并，保留全部来源审计
  const approvedSources = dedupeStrings(
    [...sources].filter((source): source is string => typeof source === "string")
  );
  const candidates = new Map<string, KnowledgeExampleEntry>();
  const sourceRefSet = new Set<string>();

  for (const ex of examples) {
    const source = typeof ex.source === "string" ? ex.source.trim() : "";
    if (!source || !isApprovedSource(source, approvedSources)) {
      lossReport.provenanceDrops.push({
        id: ex.id,
        source,
        reason: !source ? "missing provenance source" : "source is outside approved manifest sources",
      });
      continue;
    }

    const existing = candidates.get(ex.id);
    if (existing) {
      const mergedSources = existing.sourceRefs ?? [existing.source];
      if (!mergedSources.includes(source)) {
        mergedSources.push(source);
        existing.sourceRefs = mergedSources;
      }
      lossReport.duplicateDrops.push({
        id: ex.id,
        retainedSource: existing.source,
        droppedSource: source,
        reason: "duplicate id merged; provenance retained in sourceRefs",
      });
      continue;
    }

    const selectionReason = deriveSelectionReason(ex, query);
    const truncatedText = ex.text.length > maxCharsPerExample
      ? ex.text.slice(0, maxCharsPerExample)
      : ex.text;
    const tokenCost = Math.ceil(truncatedText.length / CHARS_PER_TOKEN);

    if (truncatedText.length < ex.text.length) {
      lossReport.truncations.push({
        id: ex.id,
        originalChars: ex.text.length,
        retainedChars: truncatedText.length,
        reason: `maxCharsPerExample=${maxCharsPerExample} limit`,
      });
    }

    const entry: KnowledgeExampleEntry = {
      id: ex.id,
      source,
      qualityScore: ex.qualityScore,
      selectionReason,
      tokenCost,
      text: truncatedText,
      sourceRefs: [source],
    };
    candidates.set(ex.id, entry);
  }

  // 4. 按输入顺序执行总 token 预算，超限确定性淘汰并记录
  const entries: KnowledgeExampleEntry[] = [];
  let totalTokenCost = 0;
  let totalChars = 0;
  for (const entry of candidates.values()) {
    const remainingBudget = effectiveMaxTotalTokenCost - totalTokenCost;
    if (entry.tokenCost > remainingBudget) {
      lossReport.budgetDrops.push({
        id: entry.id,
        tokenCost: entry.tokenCost,
        remainingBudget,
        reason: "total token budget exceeded",
      });
      continue;
    }
    entries.push(entry);
    totalTokenCost += entry.tokenCost;
    totalChars += entry.text.length;
    for (const source of entry.sourceRefs ?? [entry.source]) {
      sourceRefSet.add(source);
    }
  }

  if (entries.length === 0) {
    const reason = lossReport.provenanceDrops.length > 0
      ? "无示例通过 manifest provenance 校验"
      : lossReport.budgetDrops.length > 0
        ? "所有示例均超出 total token budget"
        : "去重后无可用示例（全部 id 重复）";
    return createEmptyKnowledgeResult(true, reason, sources, lossReport);
  }

  const ctx: KnowledgeConsumptionContext = {
    entries,
    totalTokenCost,
    totalChars,
    channel,
    sourceRefs: Array.from(sourceRefSet),
    manifestApproved: true,
    consumedByRawPrompt: false, // 由 buildRawPrompt 在消费时修正
    advisoryOnly: true,
    lossReport,
    proxyNote: PROXY_NOTE,
  };

  const promptBlock = formatKnowledgeConsumptionPromptBlock(ctx);
  if (promptBlock === null) {
    ctx.consumedByRawPrompt = false;
  }
  return { knowledgeConsumptionContext: ctx, promptBlock };
}

function createLossReport(maxTotalTokenCost?: number): KnowledgeLossReport {
  return {
    truncations: [],
    duplicateDrops: [],
    budgetDrops: [],
    provenanceDrops: [],
    totalTokenBudget: maxTotalTokenCost,
  };
}

function createEmptyKnowledgeResult(
  manifestApproved: boolean,
  emptyReason: string,
  sources: ReadonlyArray<string>,
  lossReport: KnowledgeLossReport
): KnowledgeConsumptionCompileResult {
  return {
    knowledgeConsumptionContext: {
      entries: [],
      totalTokenCost: 0,
      totalChars: 0,
      channel: "empty",
      sourceRefs: dedupeStrings(
        [...sources].filter((source): source is string => typeof source === "string")
      ),
      manifestApproved,
      consumedByRawPrompt: false,
      advisoryOnly: true,
      emptyReason,
      lossReport,
      proxyNote: PROXY_NOTE,
    },
    promptBlock: null,
  };
}

function isApprovedSource(source: string, approvedSources: string[]): boolean {
  return approvedSources.some((approvedSource) => {
    const approved = approvedSource.trim();
    if (!approved) return false;
    if (source === approved) return true;
    return (source === "runtime" || source === "flat") &&
      approved.startsWith(`${source}:`);
  });
}

// ============================================================================
// 辅助：推导选中原因
// ============================================================================

/**
 * 推导示例的选中原因（哪些维度匹配 query）。
 *
 * 匹配维度：
 * - sceneType：场景类型相同
 * - narrativeBeat：叙事节拍相同
 * - conflictLevel：冲突等级相同
 * - emotionTarget：情绪目标相同
 *
 * 若无任何维度匹配（FewshotSelector 可能基于其他维度选中），返回 "score-based fallback"。
 */
function deriveSelectionReason(
  ex: {
    sceneType?: string;
    narrativeBeat?: string;
    conflictLevel?: number;
    emotionTarget?: string;
  },
  query: {
    sceneType?: string;
    narrativeBeat?: string;
    conflictLevel?: number;
    emotionTarget?: string;
  }
): string {
  const matched: string[] = [];

  if (query.sceneType && ex.sceneType && ex.sceneType === query.sceneType) {
    matched.push(`sceneType=${ex.sceneType}`);
  }
  if (query.narrativeBeat && ex.narrativeBeat && ex.narrativeBeat === query.narrativeBeat) {
    matched.push(`narrativeBeat=${ex.narrativeBeat}`);
  }
  if (query.conflictLevel !== undefined && ex.conflictLevel !== undefined && ex.conflictLevel === query.conflictLevel) {
    matched.push(`conflictLevel=${ex.conflictLevel}`);
  }
  if (query.emotionTarget && ex.emotionTarget && ex.emotionTarget === query.emotionTarget) {
    matched.push(`emotionTarget=${ex.emotionTarget}`);
  }

  if (matched.length === 0) {
    return "score-based fallback（无维度直接匹配，由 qualityScore 排序选中）";
  }
  return matched.join(", ");
}

// ============================================================================
// 辅助：工具函数
// ============================================================================

/** 字符串数组去重（保序） */
function dedupeStrings(arr: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const s of arr) {
    if (s && !seen.has(s)) {
      seen.add(s);
      result.push(s);
    }
  }
  return result;
}

// ============================================================================
// Prompt block 格式化
// ============================================================================

/**
 * 把 KnowledgeConsumptionContext 格式化为 raw prompt 的"参考示例"区块。
 *
 * 格式（确定性，无 LLM）：
 * ```
 * 参考示例（advisory 非强制模仿；来自 manifest-approved 索引；token 成本 N）：
 * [ex-001] 来源：runtime | 分数：0.85 | 匹配：sceneType=combat
 *   林川拔出长剑。
 * [ex-002] 来源：flat | 分数：0.78 | 匹配：score-based fallback
 *   苏婉退后一步。
 * ```
 *
 * entries 为空时返回 null。
 * 不含 forcedImitation/mandatoryTemplate/requiredExamples 等强制字段。
 */
export function formatKnowledgeConsumptionPromptBlock(
  context: KnowledgeConsumptionContext
): string | null {
  if (context.entries.length === 0) {
    return null;
  }

  const lines: string[] = [];
  lines.push(
    `参考示例（advisory 非强制模仿；来自 manifest-approved 索引；token 成本 ${context.totalTokenCost}）：`,
  );

  for (const entry of context.entries) {
    lines.push(
      `[${entry.id}] 来源：${entry.source} | 分数：${entry.qualityScore.toFixed(2)} | 匹配：${entry.selectionReason}`,
    );
    lines.push(`  ${entry.text}`);
  }

  return lines.join("\n");
}

// ============================================================================
// Skipped 构造（用于 hardBlock / 异常路径，保证 stageResults 不静默）
// ============================================================================

/**
 * 构造 skipped KnowledgeConsumptionContext（用于 hardBlock / raw 生成失败路径）。
 * 与其他 compiler skipped 构造同模式：失败路径写 reason，不静默。
 */
export function skippedKnowledgeConsumption(reason: string): KnowledgeConsumptionContext {
  return {
    entries: [],
    totalTokenCost: 0,
    totalChars: 0,
    channel: "empty",
    sourceRefs: [],
    manifestApproved: false,
    consumedByRawPrompt: false,
    advisoryOnly: true,
    emptyReason: `skipped: ${reason}`,
    proxyNote: PROXY_NOTE,
  };
}
