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
// ============================================================================
// 响应侧定点解码（2026-11-12 遗留项①：评审通道键名编码根因修复）
// 请求经 localizeLlmMessages 编码后，模型按编码 schema 应答，JSON 键名与枚举值
// 被逐字母映射为天干地支（如 summary→申戌寅寅甲未玄）。此前只编码请求、不解码
// 响应，导致标准键全部落空（空评审根因）。解码仅处理 JSON 结构内的纯别名键名与
// 白名单枚举值，中文散文值原样保留；JSON 解析失败时原样透传，行为与现状一致。
// ============================================================================
const ALIAS_CHAR_SET: ReadonlySet<string> = new Set(LATIN_LETTER_ALIASES.split(""));
const ALIAS_DECODE_MAP: ReadonlyMap<string, string> = new Map(
  LATIN_LETTER_ALIASES.split("").map((ch, index) => [ch, String.fromCharCode(65 + index)]),
);
const LOWERCASE_ENUM_VALUES: ReadonlySet<string> = new Set([
  "must_fix",
  "should_fix",
  "suggestion",
  "story_structure",
  "character",
  "prose_style",
  "consistency",
]);
const UPPERCASE_ENUM_VALUES: ReadonlySet<string> = new Set([
  "PROXY_APPROVED",
  "HOLD_FOR_REGENERATION",
]);
const CAMEL_KEY_NORMALIZATIONS: Readonly<Record<string, string>> = {
  recommendedlabel: "recommendedLabel",
  winningspans: "winningSpans",
  losingspans: "losingSpans",
  revisedtext: "revisedText",
  revisionnotes: "revisionNotes",
};
function isPureAliasToken(token: string): boolean {
  return token.length > 0 && [...token].every((ch) => ch === "_" || ALIAS_CHAR_SET.has(ch));
}
function decodeAliasToken(token: string): string {
  return [...token].map((ch) => ALIAS_DECODE_MAP.get(ch) ?? ch).join("");
}
function decodeAliasJsonKey(key: string): string {
  if (!isPureAliasToken(key)) return key;
  const lowered = decodeAliasToken(key).toLowerCase();
  return CAMEL_KEY_NORMALIZATIONS[lowered] ?? lowered;
}
function decodeAliasJsonStringValue(value: string): string {
  if (value.length > 40 || !isPureAliasToken(value)) return value;
  const decoded = decodeAliasToken(value);
  if (/^[A-Z]$/.test(decoded)) return decoded;
  if (UPPERCASE_ENUM_VALUES.has(decoded)) return decoded;
  const lowered = decoded.toLowerCase();
  if (LOWERCASE_ENUM_VALUES.has(lowered)) return lowered;
  return value;
}
function decodeAliasJsonNode(value: unknown): unknown {
  if (typeof value === "string") return decodeAliasJsonStringValue(value);
  if (Array.isArray(value)) return value.map(decodeAliasJsonNode);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[decodeAliasJsonKey(key)] = decodeAliasJsonNode(item);
    }
    return out;
  }
  return value;
}
/**
 * 对模型响应文本做定点解码：截取首个 { 至末个 } 的 JSON 片段尝试解析，成功则
 * 解码纯别名键名与白名单枚举值后以解码结果替换原片段；任何一步失败都原样返回。
 */
export function delocalizeLlmJsonText(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return text;
  const slice = text.slice(start, end + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(slice);
  } catch {
    return text;
  }
  if (parsed === null || typeof parsed !== "object") return text;
  const decoded = decodeAliasJsonNode(parsed);
  return text.slice(0, start) + JSON.stringify(decoded) + text.slice(end + 1);
}
/** Reject explicit writing-analysis protocol blocks; ordinary foreign language prose remains valid. */
export function assertChapterProseOutput(text: string): void {
  const markers = /(?:^|\n)\s*(?:<\/?(?:think|analysis)>|\[(?:analysis|thinking)\]|#{1,6}\s*(?:analysis|thinking(?: process)?|writing plan|润色计划|写作分析)\s*(?:[:：]|$)|(?:润色计划|写作分析|思考过程|写作思路)\s*[:：])/im;
  const selfPlanning = /^\s*(?:okay[,!.]?\s*)?(?:let['’]s\s+(?:plan|analy[sz]e|think through)\b|(?:i|we)\s+(?:need to|will|must)\s+(?:write|rewrite|polish|generate)\s+(?:this|the|a)\s+(?:chapter|story|prose|text)\b)/i;
  if (markers.test(text) || selfPlanning.test(text)) throw new Error('chapter_output_contract: 模型将写作分析混入正文，必须仅返回正文后重试；未删除或交付污染文本');

  // fail-closed：供应商账号策略拦截 / 拒答 / 编码拦截提示 / 过短输出一律不得作为正文交付
  const providerBlocked = /request\s+(?:is\s+)?blocked|prohibited\s+(?:use\s+)?policy|account\s+restrictions?|policy\s+violation|send\s+feedback|aistudio\.google\.com|账号(?:限制|受限|封禁)|策略拦截|内容安全拦截|生成请求被拦截|根据.*?政策.*?无法|违反.*?使用政策/i;
  const refusalNotice = /请重新粘贴|并非小说正文|并非.*?正文|没有实际.*?正文|无法(?:为你|为您)?(?:完成|进行)?(?:润色|优化|改写|续写)|不能凭空编造|提供(?:正确|完整)的?(?:初稿|正文|文本)|作为\s*(?:AI|人工智能)\s*助手我(?:不能|无法)/;
  if (providerBlocked.test(text) || refusalNotice.test(text)) {
    throw new Error('chapter_output_contract: 模型返回供应商拦截/拒答说明而非章节正文，必须阻断交付并重试；未删除或交付污染文本');
  }
  const aliasRun = new RegExp(`[${LATIN_LETTER_ALIASES}]{6,}`);
  if (aliasRun.test(text)) {
    throw new Error('chapter_output_contract: 检测到疑似供应商拦截文本的编码残留（天干地支连排），必须阻断交付并重试；未删除或交付污染文本');
  }
  if (text.trim().length < 200) {
    throw new Error(`chapter_output_contract: 输出不足 200 字（实际 ${text.trim().length} 字），不可能是完整章节正文，必须阻断交付并重试；未删除或交付污染文本`);
  }
}
