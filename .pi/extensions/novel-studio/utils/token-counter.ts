/**
 * PiNovelStudio — Token 计数工具
 *
 * 估算和计算文本的 token 数量，用于控制 API 调用成本
 */

export interface TokenEstimate {
  tokens: number;
  chars: number;
  words: number;
  lines: number;
}

export interface TokenBudget {
  used: number;
  remaining: number;
  total: number;
  percentUsed: number;
}

/**
 * 中文文本的 token 估算
 *
 * 基于经验法则：
 * - 中文：1个汉字 ≈ 1.2-1.5 tokens
 * - 英文：1个单词 ≈ 1.3-1.5 tokens
 * - 标点符号和空格也需要 token
 *
 * 使用 tiktoken 的精确计算需要模型编码，
 * 这里提供基于字符的估算方法。
 */
export class TokenCounter {
  private static readonly CHARS_PER_TOKEN_CN = 1.8;
  private static readonly CHARS_PER_TOKEN_EN = 4.0;
  private static readonly CHARS_PER_TOKEN_PUNCT = 0.3;

  /**
   * 估算文本的 token 数量
   *
   * @param text 输入文本
   * @returns 估算的 token 数量
   */
  static estimate(text: string): number {
    if (!text || text.length === 0) {
      return 0;
    }

    let tokens = 0;
    let i = 0;

    while (i < text.length) {
      const char = text[i];

      if (this.isChinese(char)) {
        tokens += 1 / this.CHARS_PER_TOKEN_CN;
        i++;
      } else if (this.isEnglish(char)) {
        let wordLen = 0;
        while (i < text.length && this.isEnglish(text[i])) {
          wordLen++;
          i++;
        }
        tokens += wordLen / this.CHARS_PER_TOKEN_EN;
      } else if (this.isPunctuation(char) || this.isWhitespace(char)) {
        tokens += this.CHARS_PER_TOKEN_PUNCT;
        i++;
      } else {
        tokens += 1;
        i++;
      }
    }

    return Math.ceil(tokens);
  }

  /**
   * 估算多个文本块的 token
   */
  static estimateMultiple(texts: string[]): number {
    return texts.reduce((sum, text) => sum + this.estimate(text), 0);
  }

  /**
   * 获取详细的 token 统计
   */
  static analyze(text: string): TokenEstimate {
    let chineseChars = 0;
    let englishChars = 0;
    let punctChars = 0;
    let i = 0;

    while (i < text.length) {
      const char = text[i];

      if (this.isChinese(char)) {
        chineseChars++;
        i++;
      } else if (this.isEnglish(char)) {
        let wordLen = 0;
        while (i < text.length && this.isEnglish(text[i])) {
          wordLen++;
          i++;
        }
        englishChars += wordLen;
      } else if (this.isPunctuation(char)) {
        punctChars++;
        i++;
      } else if (this.isWhitespace(char)) {
        i++;
      } else {
        i++;
      }
    }

    const words = englishChars > 0
      ? englishChars.toString().split(/\s+/).filter(Boolean).length
      : 0;
    const lines = text.split(/\r?\n/).length;

    const tokens = Math.ceil(
      chineseChars / this.CHARS_PER_TOKEN_CN +
      englishChars / this.CHARS_PER_TOKEN_EN +
      punctChars * this.CHARS_PER_TOKEN_PUNCT
    );

    return {
      tokens,
      chars: text.length,
      words,
      lines,
    };
  }

  /**
   * 计算 token 预算
   */
  static budget(used: number, total: number): TokenBudget {
    return {
      used,
      remaining: Math.max(0, total - used),
      total,
      percentUsed: total > 0 ? (used / total) * 100 : 0,
    };
  }

  /**
   * 检查是否超过 token 限制
   */
  static exceedsLimit(text: string, maxTokens: number): boolean {
    return this.estimate(text) > maxTokens;
  }

  /**
   * 截断文本以符合 token 限制
   * 保留开头和结尾，中间用省略号连接
   */
  static truncate(text: string, maxTokens: number): string {
    if (this.estimate(text) <= maxTokens) {
      return text;
    }

    const headRatio = 0.4;
    const tailRatio = 0.4;

    const headTokens = Math.floor(maxTokens * headRatio);
    const tailTokens = Math.floor(maxTokens * tailRatio);

    let headEnd = 0;
    let headCount = 0;
    let i = 0;

    while (i < text.length && headCount < headTokens) {
      const char = text[i];
      if (this.isChinese(char)) {
        headCount += 1 / this.CHARS_PER_TOKEN_CN;
      } else if (this.isEnglish(char)) {
        headCount += 1 / this.CHARS_PER_TOKEN_EN;
      } else if (this.isPunctuation(char) || this.isWhitespace(char)) {
        headCount += this.CHARS_PER_TOKEN_PUNCT;
      } else {
        headCount++;
      }
      headEnd = i + 1;
      i++;
    }

    let tailStart = text.length;
    let tailCount = 0;
    i = text.length - 1;

    while (i >= 0 && tailCount < tailTokens) {
      const char = text[i];
      if (this.isChinese(char)) {
        tailCount += 1 / this.CHARS_PER_TOKEN_CN;
      } else if (this.isEnglish(char)) {
        tailCount += 1 / this.CHARS_PER_TOKEN_EN;
      } else if (this.isPunctuation(char) || this.isWhitespace(char)) {
        tailCount += this.CHARS_PER_TOKEN_PUNCT;
      } else {
        tailCount++;
      }
      tailStart = i;
      i--;
    }

    const head = text.substring(0, headEnd);
    const tail = text.substring(tailStart);

    return `${head}\n\n[...] (内容截断) \n\n${tail}`;
  }

  /**
   * 计算系统提示的 token 数量
   */
  static systemPrompt(systemText: string): number {
    return this.estimate(systemText);
  }

  /**
   * 计算 Few-Shot 示例的 token 数量
   */
  static fewshotPrompt(examples: Array<{ input: string; output: string }>): number {
    let total = 0;
    for (const ex of examples) {
      total += this.estimate(ex.input);
      total += this.estimate(ex.output);
      total += 10;
    }
    return total;
  }

  private static isChinese(char: string): boolean {
    const code = char.charCodeAt(0);
    return (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x20000 && code <= 0x2a6df)
    );
  }

  private static isEnglish(char: string): boolean {
    const code = char.charCodeAt(0);
    return (code >= 0x0041 && code <= 0x007a) ||
           (code >= 0x0041 && code <= 0x007a);
  }

  private static isPunctuation(char: string): boolean {
    const code = char.charCodeAt(0);
    return (
      (code >= 0x0021 && code <= 0x002f) ||
      (code >= 0x003a && code <= 0x0040) ||
      (code >= 0x005b && code <= 0x0060) ||
      (code >= 0x007b && code <= 0x007e) ||
      (code >= 0xff00 && code <= 0xffef)
    );
  }

  private static isWhitespace(char: string): boolean {
    return /\s/.test(char);
  }
}

/**
 * 便捷函数
 */
export function countTokens(text: string): number {
  return TokenCounter.estimate(text);
}

export function analyzeTokens(text: string): TokenEstimate {
  return TokenCounter.analyze(text);
}

export function truncateToTokens(text: string, maxTokens: number): string {
  return TokenCounter.truncate(text, maxTokens);
}

/**
 * 句子完成守卫：裁掉段尾未完成的句子。
 *
 * Narrator/StyleShaper 等 LLM 在命中 max_tokens 或自行中断时，可能输出
 * 以非终止标点结尾的片段（如多个角色动作并列后戛然而止）。这类断句会
 * 触发 Anti-AI "废句或断裂风险" 硬门禁。本函数把文本回裁到最后一个完整
 * 句子的终止标点，避免断句进入下游。
 *
 * 终止标点：。！？…」』""''"')）】 及英文 .!?
 * 若文本已以终止标点结尾，原样返回；若全文无终止标点，原样返回（不裁光）。
 */
const TERMINAL_PUNCT_RE = /[。！？…」』“”‘’"')）\]】.!?]/;

export function trimIncompleteTrailingSentence(text: string): string {
  if (!text) return text;
  const trimmed = text.replace(/\s+$/, "");
  if (!trimmed) return text;
  const lastChar = trimmed[trimmed.length - 1];
  if (TERMINAL_PUNCT_RE.test(lastChar)) {
    return text;
  }
  let lastTerminal = -1;
  for (let i = trimmed.length - 1; i >= 0; i -= 1) {
    if (TERMINAL_PUNCT_RE.test(trimmed[i])) {
      lastTerminal = i;
      break;
    }
  }
  if (lastTerminal < 0) {
    return text;
  }
  return trimmed.slice(0, lastTerminal + 1);
}

function extractDialogueSegments(text: string): string[] {
  const matches: Array<{ index: number; text: string }> = [];
  const patterns = [
    /"([^"]+)"/gu,
    /“([^”]+)”/gu,
    /「([^」]+)」/gu,
    /『([^』]+)』/gu,
    /‘([^’]+)’/gu,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      matches.push({ index: match.index, text: match[1] });
    }
  }

  return matches
    .sort((a, b) => a.index - b.index)
    .map((match) => match.text.trim())
    .filter((segment) => segment.length > 0);
}

function splitSentenceLikeFragments(segment: string): string[] {
  const normalized = segment.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  const fragments: string[] = [];
  const chars = Array.from(normalized);
  let current = "";

  for (let i = 0; i < chars.length; i += 1) {
    current += chars[i];

    if (chars[i] === "—" && chars[i + 1] === "—") {
      current += chars[i + 1];
      i += 1;
      fragments.push(current.trim());
      current = "";
      continue;
    }

    if (/[。！？…]/u.test(chars[i])) {
      while (chars[i + 1] === "…") {
        current += chars[i + 1];
        i += 1;
      }
      fragments.push(current.trim());
      current = "";
    }
  }

  if (current.trim().length > 0) {
    fragments.push(current.trim());
  }

  return fragments.filter((fragment) => fragment.length > 0);
}

/**
 * 计算未完成句占比（设计文档 D1-074: 15-25%参考比例）
 * 未完成句定义：对话中以非终止标点结尾的句子片段，含被打断式破折号。
 *
 * P1修复: 按章节类型分桶阈值
 * - escalation/confrontation/combat 章：动作冲突章对话偏完整陈述，允许 5-15%
 * - general/breakthrough 章：保持原阈值 15-25%
 */
export function calculateIncompleteSentenceRatio(text: string, sceneType: string = 'general'): {
  totalSentences: number;
  incompleteCount: number;
  ratio: number;
  passed: boolean;
  warning: string | null;
} {
  if (!text) return { totalSentences: 0, incompleteCount: 0, ratio: 0, passed: true, warning: null };

  const dialogueSegments = extractDialogueSegments(text);
  const sourceSegments = dialogueSegments.length > 0 ? dialogueSegments : [text];
  const sentences = sourceSegments.flatMap(splitSentenceLikeFragments);
  const totalSentences = sentences.length;
  if (totalSentences === 0) return { totalSentences: 0, incompleteCount: 0, ratio: 0, passed: true, warning: null };

  // 未完成句：不以终止标点结尾；"——"中断保留为未完成。
  const TERMINAL_RE = /[。！？…]$/;
  const incompleteCount = sentences.filter((sentence) => {
    const normalized = sentence.trim().replace(/[”」』"'）)\]]+$/u, "").trim();
    return !TERMINAL_RE.test(normalized);
  }).length;
  const ratio = incompleteCount / totalSentences;

  // P1修复: 按章节类型分桶阈值
  // escalation/confrontation/combat 章对话偏完整陈述（对峙/反压/信息揭示），允许更低占比
  const isConflictChapter = sceneType === 'combat' || sceneType === 'confrontation';
  const MIN_RATIO = isConflictChapter ? 0.05 : 0.15;
  const MAX_RATIO = 0.25;
  const passed = ratio >= MIN_RATIO && ratio <= MAX_RATIO;
  const warning = ratio < MIN_RATIO
    ? `未完成句占比过低 (${(ratio * 100).toFixed(1)}% < ${(MIN_RATIO * 100).toFixed(0)}%)，对话可能缺乏留白 (场景类型: ${sceneType})`
    : ratio > MAX_RATIO
      ? `未完成句占比过高 (${(ratio * 100).toFixed(1)}% > 25%)，对话可能过于碎片化`
      : null;

  return { totalSentences, incompleteCount, ratio, passed, warning };
}
