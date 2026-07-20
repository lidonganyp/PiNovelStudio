/**
 * LLM 中文内容边界。
 *
 * 内部代码可以继续使用英文标识符；任何真正送入模型的文本必须先经过本模块，
 * 把已知术语翻译为中文，并把无法可靠翻译的外文标识替换为中文占位。
 */

const LATIN_TOKEN = /[A-Za-z][A-Za-z0-9]*(?:[._:/-][A-Za-z0-9]+)*/g;

// 每个拉丁字母映射为一个 BMP 中文字符，保证 UTF-16 坐标严格不变。
const LATIN_LETTER_ALIASES = "甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥天地玄黄";

const TERM_TRANSLATIONS: Readonly<Record<string, string>> = {
  a: "甲",
  b: "乙",
  "a/b": "甲乙",
  ai: "智能生成",
  llm: "语言模型",
  json: "结构化数据",
  raw: "原始稿",
  span: "正文片段",
  spans: "正文片段",
  advisory: "建议性诊断",
  gate: "门禁",
  verified: "已核实",
  unverified: "未核实",
  critical: "严重",
  warning: "警告",
  editorial: "编辑",
  opportunity: "机会",
  candidate: "候选稿",
  winner: "胜者",
  confidence: "置信程度",
  clear: "明确",
  slight: "轻微",
  uncertain: "不确定",
  tie: "平局",
  neither: "均不",
  start: "起点",
  end: "终点",
  excerpt: "原文",
  promiseledger: "承诺账本",
  selectedpromisestoadvance: "本章选中承诺",
  characterstate: "角色状态",
  evidenceplan: "证据计划",
  novelos: "叙事操作系统",
  agent: "代理",
  loop: "循环",
  canon: "既定事实",
  hypothesis: "编辑假设",
  prompt: "提示词",
  system: "系统",
  user: "用户",
  model: "模型",
  route: "路由",
  fallback: "回退",
  source: "来源",
  reference: "引用",
  id: "标识",
  null: "空值",
  true: "是",
  false: "否",
  "judge-calibration-1": "裁判校准规则一",
};

/** 判断文本是否仍含 ASCII 英文字母。 */
export function containsEnglishLetters(text: string): boolean {
  return /[A-Za-z]/.test(text);
}

/** 把模型可见文本转换为无英文字母的中文视图。 */
export function localizeLlmText(text: string): string {
  return text.replace(LATIN_TOKEN, (token) => {
    const translated = token === token.toLowerCase()
      ? TERM_TRANSLATIONS[token]
      : undefined;
    return translated
      ? fitToTokenLength(translated, token.length)
      : encodeLatinToken(token);
  });
}

/**
 * 校验模型返回的片段是否等于原文切片或其中文化视图；通过时恢复原文。
 */
export function restoreLlmExcerpt(
  sourceText: string,
  start: number,
  end: number,
  modelExcerpt: string,
): string | null {
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start < 0 || end > sourceText.length || start >= end) return null;
  const originalExcerpt = sourceText.slice(start, end);
  if (
    modelExcerpt === originalExcerpt ||
    modelExcerpt === localizeLlmText(originalExcerpt)
  ) {
    return originalExcerpt;
  }
  return null;
}

/**
 * 在原文或其等长中文化视图中唯一定位模型引用，并返回原始正文片段。
 */
export function locateLlmExcerpt(
  sourceText: string,
  modelExcerpt: string,
): { start: number; end: number; excerpt: string } | null {
  if (!modelExcerpt) return null;
  const candidates = [modelExcerpt];
  const trimmed = modelExcerpt.trim();
  if (trimmed && trimmed !== modelExcerpt) candidates.push(trimmed);

  for (const candidate of candidates) {
    const direct = findUniqueIndex(sourceText, candidate);
    if (direct >= 0) {
      return {
        start: direct,
        end: direct + candidate.length,
        excerpt: sourceText.slice(direct, direct + candidate.length),
      };
    }

    const localized = localizeLlmText(sourceText);
    const localizedIndex = findUniqueIndex(localized, candidate);
    if (localizedIndex >= 0) {
      return {
        start: localizedIndex,
        end: localizedIndex + candidate.length,
        excerpt: sourceText.slice(localizedIndex, localizedIndex + candidate.length),
      };
    }
  }
  return null;
}

/** 转换一组聊天消息的正文，不改变角色字段。 */
export function localizeLlmMessages<T extends { role: string; content: string }>(
  messages: T[],
): T[] {
  return messages.map((message) => ({
    ...message,
    content: localizeLlmText(message.content),
  }));
}

function encodeLatinToken(token: string): string {
  return token.replace(/[A-Za-z]/g, (letter) => {
    const index = letter.toUpperCase().charCodeAt(0) - 65;
    return LATIN_LETTER_ALIASES[index] ?? "文";
  });
}

function fitToTokenLength(replacement: string, targetLength: number): string {
  if (replacement.length >= targetLength) {
    return replacement.slice(0, targetLength);
  }
  return replacement + "文".repeat(targetLength - replacement.length);
}

function findUniqueIndex(text: string, search: string): number {
  const first = text.indexOf(search);
  if (first < 0) return -1;
  return text.indexOf(search, first + 1) < 0 ? first : -1;
}
