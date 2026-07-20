/**
 * NB-2：防泄漏扫描器
 *
 * 核心原则（任务要求）：
 * - 严格区分生成输入（generationInput）与隐藏 reference（referenceBody）
 * - 禁止目标章正文/标题/独特措辞/独特实体泄漏到 generationInput
 * - 合法前文复用（prior 已有的 n-gram / 短语 / 实体）不计为泄漏
 *
 * 审计维度：
 * - ngramOverlapRate：3-gram + 4-gram Jaccard(reference, input)，排除 prior 已有 n-gram
 * - phraseLeakCount：≥6 字连续串同时出现在 reference + input 但 prior 无
 * - entityLeakCount：reference 独特 2-4 字 CJK 实体出现在 input 但 prior 无
 * - sentenceOverlap：reference 句子完整出现在 input 的比例
 * - titleSpoilerLeak：目标章标题关键词出现在 input
 *
 * 本模块为 eval-only，由 tsconfig.eval.json 编译到 dist-eval/，不进 dist/。
 */

import type { LeakageAudit } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_NGRAM_MIN = 3;
const DEFAULT_NGRAM_MAX = 4;
const DEFAULT_PHRASE_MIN = 6;
const DEFAULT_NGRAM_OVERLAP_THRESHOLD = 0.02;

/** CJK 字符范围（用于实体提取） */
const CJK_PATTERN = /[\u4e00-\u9fff]{2,4}/g;

/** 实体停用词（常见非专有名词片段） */
const ENTITY_STOPWORDS = new Set([
  "他们", "她们", "它们", "这个", "那个", "这些", "那些", "这是", "那是",
  "一个", "两个", "三个", "什么", "怎么", "为何", "为什么", "已经", "不是",
  "如果", "因为", "但是", "没有", "立刻", "当时", "可以", "当前", "状态",
  "核心", "场景", "异常", "线索", "选择", "压力", "忽然", "门声", "脚步",
  "知道", "以为", "觉得", "看着", "说着", "想着", "起来", "下来", "过来",
  "出去", "进去", "回来", "出来", "起来", "下去", "过去", "通过", "根据",
  "于是", "然而", "虽然", "尽管", "无论", "只有", "只要", "还是", "或者",
  "什么", "怎样", "这样", "那样", "一切", "所有", "有些", "某些", "任何",
  "自己", "别人", "他人", "大家", "咱们", "你们", "我们", "她们",
]);

/** 标题关键词停用词 */
const TITLE_STOPWORDS = new Set([
  "的", "了", "是", "在", "和", "与", "或", "第", "章", "节", "卷", "部",
  "序", "终", "番", "外", "上", "下", "中", "里", "外", "前", "后",
]);

// ─────────────────────────────────────────────────────────────────────────────
// 公开 API
// ─────────────────────────────────────────────────────────────────────────────

export interface AuditLeakageOptions {
  /** 目标章标题（用于 titleSpoilerLeak 检测） */
  targetChapterTitle?: string;
  /** n-gram 最小长度（默认 3） */
  ngramMinLen?: number;
  /** n-gram 最大长度（默认 4） */
  ngramMaxLen?: number;
  /** 连续短语最小长度（默认 6） */
  phraseMinLen?: number;
  /** ngramOverlapRate 通过阈值（默认 0.02） */
  ngramOverlapThreshold?: number;
}

/**
 * 审计 generationInput 对 referenceBody 的泄漏，排除 priorChapterBodies 已有内容。
 *
 * @param generationInput 生成输入文本
 * @param referenceBody 隐藏的 reference 正文（目标章）
 * @param priorChapterRefs 前章正文数组（合法可复用内容）
 * @param options 选项
 * @returns LeakageAudit
 */
export function auditLeakage(
  generationInput: string,
  referenceBody: string,
  priorChapterBodies: string[],
  options?: AuditLeakageOptions,
): LeakageAudit {
  const ngramMinLen = options?.ngramMinLen ?? DEFAULT_NGRAM_MIN;
  const ngramMaxLen = options?.ngramMaxLen ?? DEFAULT_NGRAM_MAX;
  const phraseMinLen = options?.phraseMinLen ?? DEFAULT_PHRASE_MIN;
  const ngramOverlapThreshold =
    options?.ngramOverlapThreshold ?? DEFAULT_NGRAM_OVERLAP_THRESHOLD;

  const priorText = priorChapterBodies.join("\n");
  const details: string[] = [];

  // 1. ngramOverlapRate：排除 prior 已有 n-gram
  const ngramOverlapRate = computeNgramOverlapRate(
    referenceBody,
    generationInput,
    priorText,
    ngramMinLen,
    ngramMaxLen,
    details,
  );

  // 2. phraseLeakCount：≥6 字连续串在 reference + input 但不在 prior
  const phraseLeakCount = countPhraseLeaks(
    referenceBody,
    generationInput,
    priorText,
    phraseMinLen,
    details,
  );

  // 3. entityLeakCount：reference 独特实体在 input 但不在 prior
  const entityLeakCount = countEntityLeaks(
    referenceBody,
    generationInput,
    priorText,
    details,
  );

  // 4. sentenceOverlap：reference 句子出现在 input 的比例
  const sentenceOverlap = computeSentenceOverlap(
    referenceBody,
    generationInput,
    details,
  );

  // 5. titleSpoilerLeak：目标章标题关键词出现在 input
  const titleSpoilerLeak = checkTitleSpoilerLeak(
    options?.targetChapterTitle,
    generationInput,
    details,
  );

  const passed =
    ngramOverlapRate < ngramOverlapThreshold &&
    phraseLeakCount === 0 &&
    entityLeakCount === 0 &&
    !titleSpoilerLeak;

  return {
    ngramOverlapRate,
    phraseLeakCount,
    entityLeakCount,
    sentenceOverlap,
    titleSpoilerLeak,
    passed,
    details,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 内部实现
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 计算 n-gram 重叠率（Jaccard），排除 prior 已有 n-gram。
 *
 * R_novel = reference 的 n-gram 集合
 * P_novel = prior 合并文本的 n-gram 集合
 * I_novel = input 的 n-gram 集合
 *
 * overlapRate = |(R \ P) ∩ (I \ P)| / |(R \ P) ∪ (I \ P)|
 *
 * 排除 prior 已有 n-gram 避免合法前文复用被误判。
 */
function computeNgramOverlapRate(
  reference: string,
  input: string,
  prior: string,
  minLen: number,
  maxLen: number,
  details: string[],
): number {
  const refNgrams = collectNgrams(reference, minLen, maxLen);
  const inputNgrams = collectNgrams(input, minLen, maxLen);
  const priorNgrams = collectNgrams(prior, minLen, maxLen);

  // 排除 prior 已有 n-gram
  const refNovel = new Set([...refNgrams].filter((g) => !priorNgrams.has(g)));
  const inputNovel = new Set([...inputNgrams].filter((g) => !priorNgrams.has(g)));

  if (refNovel.size === 0 && inputNovel.size === 0) return 0;

  let intersection = 0;
  for (const g of refNovel) {
    if (inputNovel.has(g)) intersection++;
  }

  const union = refNovel.size + inputNovel.size - intersection;
  if (union === 0) return 0;

  const rate = intersection / union;

  if (intersection > 0 && rate >= 0.02) {
    details.push(
      `ngram_overlap: ${intersection} 个 novel n-gram 重叠，rate=${rate.toFixed(4)}`,
    );
  }

  return rate;
}

/** 收集文本的所有 n-gram（minLen..maxLen），返回 Set */
function collectNgrams(text: string, minLen: number, maxLen: number): Set<string> {
  const result = new Set<string>();
  const cleaned = text.replace(/\s+/g, "");
  for (let n = minLen; n <= maxLen; n++) {
    if (cleaned.length < n) continue;
    for (let i = 0; i <= cleaned.length - n; i++) {
      result.add(cleaned.slice(i, i + n));
    }
  }
  return result;
}

/**
 * 统计 ≥phraseMinLen 字连续串同时出现在 reference + input 但不在 prior 的数量。
 *
 * 为控制复杂度，按句切分 reference，对每个句子检查其所有 ≥phraseMinLen 子串。
 */
function countPhraseLeaks(
  reference: string,
  input: string,
  prior: string,
  phraseMinLen: number,
  details: string[],
): number {
  const refSentences = splitSentences(reference);
  let count = 0;
  const found = new Set<string>(); // 去重相同短语

  for (const sentence of refSentences) {
    if (sentence.length < phraseMinLen) continue;
    for (let i = 0; i <= sentence.length - phraseMinLen; i++) {
      // 取 phraseMinLen 到 min(sentence.length, phraseMinLen+10) 长度的子串
      const maxSubLen = Math.min(sentence.length - i, phraseMinLen + 10);
      for (let len = phraseMinLen; len <= maxSubLen; len++) {
        const phrase = sentence.slice(i, i + len);
        if (found.has(phrase)) continue;
        if (input.includes(phrase) && !prior.includes(phrase)) {
          count++;
          found.add(phrase);
          const offset = input.indexOf(phrase);
          details.push(
            `phrase_leak: '${phrase.slice(0, 20)}${phrase.length > 20 ? "…" : ""}' (${len}字) 出现在 input offset ${offset}`,
          );
          // 找到最长匹配即可，不再扩展该起点
          break;
        }
      }
    }
  }

  return count;
}

/**
 * 统计 reference 独特 2-4 字 CJK 实体出现在 input 但不在 prior 的数量。
 */
function countEntityLeaks(
  reference: string,
  input: string,
  prior: string,
  details: string[],
): number {
  const refEntities = extractEntities(reference);
  const priorEntities = new Set(extractEntities(prior));
  let count = 0;

  for (const entity of refEntities) {
    if (priorEntities.has(entity)) continue; // prior 已有，合法
    if (input.includes(entity)) {
      count++;
      details.push(`entity_leak: '${entity}' 出现在 input 但不在 prior`);
    }
  }

  return count;
}

/** 提取 2-4 字 CJK 实体，过滤停用词，去重 */
function extractEntities(text: string): Set<string> {
  const matches = text.match(CJK_PATTERN) ?? [];
  const result = new Set<string>();
  for (const m of matches) {
    if (ENTITY_STOPWORDS.has(m)) continue;
    result.add(m);
  }
  return result;
}

/**
 * 计算 reference 句子完整出现在 input 的比例。
 */
function computeSentenceOverlap(
  reference: string,
  input: string,
  details: string[],
): number {
  const sentences = splitSentences(reference).filter((s) => s.length >= 4);
  if (sentences.length === 0) return 0;

  let overlap = 0;
  for (const s of sentences) {
    if (input.includes(s)) {
      overlap++;
      details.push(`sentence_overlap: '${s.slice(0, 20)}${s.length > 20 ? "…" : ""}' 完整出现在 input`);
    }
  }

  return overlap / sentences.length;
}

/** 按句切分（。！？!?） */
function splitSentences(text: string): string[] {
  return text
    .split(/[。！？!?]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * 检查目标章标题关键词是否泄漏到 input。
 */
function checkTitleSpoilerLeak(
  title: string | undefined,
  input: string,
  details: string[],
): boolean {
  if (!title) return false;

  const keywords = extractTitleKeywords(title);
  if (keywords.length === 0) return false;

  for (const kw of keywords) {
    if (input.includes(kw)) {
      details.push(`title_spoiler_leak: 标题关键词 '${kw}' 出现在 input`);
      return true;
    }
  }

  return false;
}

/** 提取标题关键词（去停用词、数字、单字） */
function extractTitleKeywords(title: string): string[] {
  const cleaned = title
    .replace(/第[0-9零〇一二三四五六七八九十百千万两]+[章节卷集部]/g, "")
    .replace(/^[序楔终番外尾声章]+/, "")
    .trim();

  const keywords: string[] = [];
  // 提取 2-4 字 CJK 片段
  const matches = cleaned.match(CJK_PATTERN) ?? [];
  for (const m of matches) {
    if (TITLE_STOPWORDS.has(m)) continue;
    keywords.push(m);
  }

  return keywords;
}
