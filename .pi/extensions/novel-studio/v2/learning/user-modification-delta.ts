/**
 * UserModificationDeltaCalculator — 用户修改差分计算器（Phase 4A，计划 §4A）
 *
 * 对比系统交付正文与用户最终修改稿，提取修改类型和修改量，作为 Phase 6 在线学习
 * 的高权重证据来源。
 *
 * 设计原则（计划 §4A & project_memory 约束）：
 * - 不再硬编码 userModificationDelta = null
 * - 计算结果包含：editDistance（0-1）、modificationSpans（句级）、modificationTypes
 * - 句级 diff 而非字级（中文文本字级 diff 噪声过大，且语义不可靠）
 * - 修改类型分类：deletion（删句）/ insertion（增句）/ rewording（改措辞）/ structural（调整结构）
 * - 不调用 LLM，纯规则驱动
 * - 不污染生产 prompt；只产出 evidence
 *
 * 与 user-feedback-ingestor.ts 的关系：
 * - ingestEdit 接收 editDistance（number）
 * - 本模块把 userFinalText → editDistance + 类型/spans，由 handler 调用后传给 ingestor
 *
 * 与 AuthorStyleHumanReviewPackage.userModificationDelta 的关系：
 * - 该字段从 null 占位回填为本模块的计算结果
 * - positiveBenefitClaim 仍保持 false（直到获得足够用户样本，由后续阶段决定）
 */

// ============================================================================
// 常量
// ============================================================================

/**
 * 修改判定阈值：editDistance >= 此值才视为"用户修改"。
 * 0.02 = 2% 字符差异（容忍标点、空格等微小变动）。
 */
export const MODIFICATION_THRESHOLD = 0.02;

/**
 * 重度修改阈值：editDistance >= 此值视为"重度修改"（额外加权）。
 * 与 user-feedback-ingestor.ts 的 HEAVY_EDIT_DISTANCE_THRESHOLD 一致。
 */
export const HEAVY_EDIT_DISTANCE_THRESHOLD = 0.3;

/**
 * 句子相似度阈值：超过此值视为"改措辞"（rewording），否则视为"删除+插入"。
 * 0.5 = 一半以上字符重合。
 */
export const REWORDING_SIMILARITY_THRESHOLD = 0.5;

/**
 * 结构性调整阈值：句子顺序变化比例 >= 此值视为 structural。
 * 0.5 = 一半以上的共同句子顺序发生变化。
 */
export const STRUCTURAL_RATIO_THRESHOLD = 0.5;

/** 句末标点（用于句子切分） */
const SENTENCE_END_PUNCT = /[。！？!?]/;

/** 子句边界标点（用于在比对失败时降级为更细粒度） */
const CLAUSE_PUNCT = /[，。！？；,!?;\n]/;

// ============================================================================
// 类型
// ============================================================================

/** 修改类型 */
export type ModificationType =
  | "deletion" // 删句：delivered 有但 userFinal 无
  | "insertion" // 增句：userFinal 有但 delivered 无
  | "rewording" // 改措辞：句子相似但非完全相同
  | "structural"; // 调整结构：句子顺序大幅调整

/** 单个修改 span */
export interface ModificationSpan {
  type: ModificationType;
  /** 在 delivered 文本中的位置（deletion/rewording/structural 时有值） */
  deliveredStart: number;
  deliveredEnd: number;
  /** delivered 中的原文片段 */
  deliveredExcerpt: string;
  /** 在 userFinal 文本中的位置（insertion/rewording/structural 时有值） */
  userStart: number;
  userEnd: number;
  /** userFinal 中的修改后片段 */
  userExcerpt: string;
  /** 该 span 的相似度（rewording 时为 0-1，其他类型为 0 或 1） */
  similarity: number;
}

/** 修改类型统计 */
export interface ModificationTypeStats {
  deletion: number;
  insertion: number;
  rewording: number;
  structural: number;
}

/** 用户修改差分结果 */
export interface UserModificationDelta {
  /** 是否发生修改（editDistance >= MODIFICATION_THRESHOLD） */
  modified: boolean;
  /** 修改幅度 0-1（Levenshtein 距离 / max length） */
  editDistance: number;
  /** 是否重度修改（editDistance >= HEAVY_EDIT_DISTANCE_THRESHOLD） */
  heavy: boolean;
  /** 修改 span 列表（句级粒度） */
  modificationSpans: ModificationSpan[];
  /** 修改类型统计 */
  modificationTypes: ModificationTypeStats;
  /** 结构性调整比例（0-1，顺序变化的共同句子比例） */
  structuralRatio: number;
  /** delivered 文本长度 */
  deliveredLength: number;
  /** userFinal 文本长度 */
  userFinalLength: number;
  /** 计算原因（用于 trace 审计） */
  reason: string;
}

// ============================================================================
// 句子切分
// ============================================================================

interface SentenceSpan {
  text: string;
  start: number;
  end: number;
}

/**
 * 按句末标点切分文本，保留每个句子的字符 span。
 * 不 trim 句子内部空白（中文小说一般无内部空格）；末尾标点计入句子。
 */
function splitSentencesWithSpan(text: string): SentenceSpan[] {
  const result: SentenceSpan[] = [];
  let pos = 0;
  while (pos < text.length) {
    // 找下一个句末标点
    let end = -1;
    for (let i = pos; i < text.length; i++) {
      if (SENTENCE_END_PUNCT.test(text[i]!)) {
        end = i + 1;
        break;
      }
    }
    if (end === -1) {
      // 剩余部分作为最后一句
      const remaining = text.slice(pos);
      if (remaining.length > 0) {
        result.push({ text: remaining, start: pos, end: text.length });
      }
      break;
    }
    const sentence = text.slice(pos, end);
    if (sentence.length > 0) {
      result.push({ text: sentence, start: pos, end });
    }
    pos = end;
  }
  return result;
}

// ============================================================================
// 字符级 Levenshtein 距离
// ============================================================================

/**
 * 计算两个字符串的 Levenshtein 距离。
 * 用于 editDistance 计算（全文级）和句子相似度（句级，用 Jaccard 替代以降低复杂度）。
 *
 * 全文级复杂度 O(n*m)，对中文长章节（~3000 字 * 3000 字）= 9M 操作，可接受。
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // 滚动数组优化空间到 O(min(n,m))
  const n = a.length;
  const m = b.length;
  let prev = new Array<number>(m + 1);
  let curr = new Array<number>(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;

  for (let i = 1; i <= n; i++) {
    curr[0] = i;
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j]! + 1, // 删除
        curr[j - 1]! + 1, // 插入
        prev[j - 1]! + cost, // 替换
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[m]!;
}

/**
 * 计算两个字符串的相似度（0-1，1=完全相同）。
 * 用 Jaccard on character bigrams 替代纯 Levenshtein 以降低复杂度，
 * 同时保持对局部修改的敏感性。
 */
function sentenceSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  // 用字符 bigram Jaccard：对中文句子局部修改敏感，复杂度 O(n+m)
  const bigramsA = new Set<string>();
  for (let i = 0; i < a.length - 1; i++) {
    bigramsA.add(a.slice(i, i + 2));
  }
  const bigramsB = new Set<string>();
  for (let i = 0; i < b.length - 1; i++) {
    bigramsB.add(b.slice(i, i + 2));
  }
  if (bigramsA.size === 0 && bigramsB.size === 0) return 1;
  if (bigramsA.size === 0 || bigramsB.size === 0) return 0;

  let intersection = 0;
  for (const bg of bigramsA) {
    if (bigramsB.has(bg)) intersection++;
  }
  const union = bigramsA.size + bigramsB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ============================================================================
// LCS（最长公共子序列）— 句级顺序对比
// ============================================================================

/**
 * 计算两个句子序列的 LCS 长度（用于结构性调整检测）。
 * 复杂度 O(n*m)，但句级 n/m 通常 < 200，可接受。
 */
function lcsLength<T>(a: T[], b: T[], equals: (x: T, y: T) => boolean): number {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return 0;

  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (equals(a[i - 1]!, b[j - 1]!)) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }
  }
  return dp[n]![m]!;
}

// ============================================================================
// 核心差分计算
// ============================================================================

/**
 * 计算用户修改差分。
 *
 * 算法：
 * 1. 全文 Levenshtein → editDistance（0-1，归一化）
 * 2. 切句 → 句级 LCS 找出共同句子和顺序变化（structural）
 * 3. 共同句子中找改措辞（相似但非完全相同）
 * 4. 非共同句子分类为删除（delivered 独有）或插入（userFinal 独有）
 *
 * @param deliveredText 系统交付的正文
 * @param userFinalText 用户最终修改稿
 */
export function computeUserModificationDelta(
  deliveredText: string,
  userFinalText: string,
): UserModificationDelta {
  // ── 边界：空文本 ──────────────────────────────────────────────────────
  if (deliveredText.length === 0 && userFinalText.length === 0) {
    return {
      modified: false,
      editDistance: 0,
      heavy: false,
      modificationSpans: [],
      modificationTypes: { deletion: 0, insertion: 0, rewording: 0, structural: 0 },
      structuralRatio: 0,
      deliveredLength: 0,
      userFinalLength: 0,
      reason: "双方文本均为空，无修改",
    };
  }

  if (deliveredText.length === 0 || userFinalText.length === 0) {
    // 一方为空：视为全文删除或全文插入
    const isDeletion = deliveredText.length > 0;
    return {
      modified: true,
      editDistance: 1,
      heavy: true,
      modificationSpans: [
        {
          type: isDeletion ? "deletion" : "insertion",
          deliveredStart: 0,
          deliveredEnd: deliveredText.length,
          deliveredExcerpt: deliveredText.slice(0, 50),
          userStart: 0,
          userEnd: userFinalText.length,
          userExcerpt: userFinalText.slice(0, 50),
          similarity: 0,
        },
      ],
      modificationTypes: {
        deletion: isDeletion ? 1 : 0,
        insertion: isDeletion ? 0 : 1,
        rewording: 0,
        structural: 0,
      },
      structuralRatio: 0,
      deliveredLength: deliveredText.length,
      userFinalLength: userFinalText.length,
      reason: isDeletion ? "用户清空了交付正文" : "用户在空交付上写了正文",
    };
  }

  // ── 1. 全文 Levenshtein → editDistance ──────────────────────────────
  const levDist = levenshtein(deliveredText, userFinalText);
  const maxLen = Math.max(deliveredText.length, userFinalText.length);
  const editDistance = maxLen === 0 ? 0 : levDist / maxLen;
  const modified = editDistance >= MODIFICATION_THRESHOLD;
  const heavy = editDistance >= HEAVY_EDIT_DISTANCE_THRESHOLD;

  // ── 2. 句级 diff ─────────────────────────────────────────────────────
  const deliveredSentences = splitSentencesWithSpan(deliveredText);
  const userSentences = splitSentencesWithSpan(userFinalText);

  // 句子完全相同判定（用于 LCS）
  const sentenceEquals = (a: SentenceSpan, b: SentenceSpan): boolean => a.text === b.text;

  // LCS 找出共同句子（保持顺序）
  const lcs = lcsLength(deliveredSentences, userSentences, sentenceEquals);

  // 结构性调整比例：顺序变化的共同句子比例
  // = (共同句子总数 - LCS) / 共同句子总数
  // 但我们不知道"共同句子总数"（去重计数），简化为：
  // structuralRatio = 1 - LCS / max(deliveredSentences.length, userSentences.length)
  // 当 LCS 接近 max 时，顺序保持；反之顺序调整。
  const sentenceMaxLen = Math.max(deliveredSentences.length, userSentences.length);
  const structuralRatio =
    sentenceMaxLen === 0 ? 0 : 1 - lcs / sentenceMaxLen;

  // ── 3. 分类句子 ─────────────────────────────────────────────────────
  const modificationSpans: ModificationSpan[] = [];
  const typeStats: ModificationTypeStats = {
    deletion: 0,
    insertion: 0,
    rewording: 0,
    structural: 0,
  };

  // 用动态规划回溯 LCS 找出每个句子是否在 LCS 中
  const deliveredInLcs = findLcsMask(deliveredSentences, userSentences, sentenceEquals);
  const userInLcs = findLcsMask(userSentences, deliveredSentences, (a, b) => sentenceEquals(b, a));

  // 遍历 delivered 句子：不在 LCS 中的可能是删除或改措辞
  let userScanPos = 0; // 在 userSentences 中扫描的位置（用于找改措辞的对应句）
  for (let i = 0; i < deliveredSentences.length; i++) {
    const dSent = deliveredSentences[i]!;
    if (deliveredInLcs[i]) {
      // 在 LCS 中：找到对应的 user 句子并推进 userScanPos
      while (userScanPos < userSentences.length && !userInLcs[userScanPos]) {
        userScanPos++;
      }
      if (userScanPos < userSentences.length) {
        userScanPos++;
      }
      continue;
    }

    // 不在 LCS 中：在 user 中找相似句（改措辞）或判定为删除
    let bestMatch = -1;
    let bestSim = 0;
    for (let j = userScanPos; j < Math.min(userScanPos + 3, userSentences.length); j++) {
      if (userInLcs[j]) continue; // 跳过 LCS 中的句子
      const uSent = userSentences[j]!;
      const sim = sentenceSimilarity(dSent.text, uSent.text);
      if (sim > bestSim) {
        bestSim = sim;
        bestMatch = j;
      }
    }

    if (bestMatch >= 0 && bestSim >= REWORDING_SIMILARITY_THRESHOLD) {
      // 改措辞
      const uSent = userSentences[bestMatch]!;
      modificationSpans.push({
        type: "rewording",
        deliveredStart: dSent.start,
        deliveredEnd: dSent.end,
        deliveredExcerpt: dSent.text.slice(0, 50),
        userStart: uSent.start,
        userEnd: uSent.end,
        userExcerpt: uSent.text.slice(0, 50),
        similarity: bestSim,
      });
      typeStats.rewording++;
      userInLcs[bestMatch] = true; // 标记已匹配
    } else {
      // 删除
      modificationSpans.push({
        type: "deletion",
        deliveredStart: dSent.start,
        deliveredEnd: dSent.end,
        deliveredExcerpt: dSent.text.slice(0, 50),
        userStart: 0,
        userEnd: 0,
        userExcerpt: "",
        similarity: 0,
      });
      typeStats.deletion++;
    }
  }

  // 遍历 user 句子：仍未标记的为插入
  for (let j = 0; j < userSentences.length; j++) {
    if (userInLcs[j]) continue;
    const uSent = userSentences[j]!;
    modificationSpans.push({
      type: "insertion",
      deliveredStart: 0,
      deliveredEnd: 0,
      deliveredExcerpt: "",
      userStart: uSent.start,
      userEnd: uSent.end,
      userExcerpt: uSent.text.slice(0, 50),
      similarity: 0,
    });
    typeStats.insertion++;
  }

  // ── 4. 结构性调整检测 ───────────────────────────────────────────────
  if (structuralRatio >= STRUCTURAL_RATIO_THRESHOLD && lcs > 0) {
    // 标记为 structural（不新增 span，只在统计中记录）
    typeStats.structural = Math.min(
      deliveredSentences.length,
      userSentences.length,
    ) - lcs;
    if (typeStats.structural < 0) typeStats.structural = 0;
  }

  // ── 5. 构造结果 ─────────────────────────────────────────────────────
  const reasonParts: string[] = [];
  if (!modified) {
    reasonParts.push("editDistance < MODIFICATION_THRESHOLD，无实质修改");
  } else {
    reasonParts.push(`editDistance=${editDistance.toFixed(3)}`);
    if (heavy) reasonParts.push("重度修改");
    if (typeStats.deletion > 0) reasonParts.push(`删除 ${typeStats.deletion} 句`);
    if (typeStats.insertion > 0) reasonParts.push(`插入 ${typeStats.insertion} 句`);
    if (typeStats.rewording > 0) reasonParts.push(`改措辞 ${typeStats.rewording} 句`);
    if (typeStats.structural > 0) {
      reasonParts.push(`结构性调整 ${typeStats.structural} 句`);
    }
  }

  return {
    modified,
    editDistance,
    heavy,
    modificationSpans,
    modificationTypes: typeStats,
    structuralRatio,
    deliveredLength: deliveredText.length,
    userFinalLength: userFinalText.length,
    reason: reasonParts.join("；"),
  };
}

/**
 * 回溯 LCS 找出 a 中每个元素是否在 LCS 中。
 * 返回 boolean[]，长度等于 a.length，true 表示在 LCS 中。
 */
function findLcsMask<T>(
  a: T[],
  b: T[],
  equals: (x: T, y: T) => boolean,
): boolean[] {
  const n = a.length;
  const m = b.length;
  const mask = new Array<boolean>(n).fill(false);
  if (n === 0 || m === 0) return mask;

  // DP 表
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (equals(a[i - 1]!, b[j - 1]!)) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }
  }

  // 回溯
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (equals(a[i - 1]!, b[j - 1]!)) {
      mask[i - 1] = true;
      i--;
      j--;
    } else if (dp[i - 1]![j]! >= dp[i]![j - 1]!) {
      i--;
    } else {
      j--;
    }
  }
  return mask;
}
