/**
 * Replay case extraction utilities.
 *
 * Case files store only compact abstractions plus source path/hash. Full
 * original chapter text must remain outside generation input.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TextDecoder } from "node:util";

import type {
  ReplayCase,
  ReplayCaseExtractionOptions,
  ReplayCaseWriteResult,
} from "./replay-types.js";

export interface DecodedNovelSource {
  text: string;
  encoding: string;
  score: number;
}

interface ChapterSlice {
  chapterNumber: number;
  chapterTitle: string;
  heading: string;
  startOffset: number;
  bodyStartOffset: number;
  endOffset: number;
  body: string;
}

const CJK_NUMERAL_PATTERN = "[0-9零〇一二三四五六七八九十百千万两]+";
const VOLUME_PREFIX_PATTERN = `(?:第${CJK_NUMERAL_PATTERN}[卷集部](?:(?!第${CJK_NUMERAL_PATTERN}[章节]|Chapter\\s+\\d).){0,80})[ \\t　]*`;
const CHAPTER_HEADING_PATTERN = new RegExp(
  `^(?:${VOLUME_PREFIX_PATTERN})*(?:第(${CJK_NUMERAL_PATTERN})[章节]|Chapter\\s+([0-9]+))[ \\t　:：.、-]*(.*)$`,
  "gim"
);

const CHAPTER_HEADING_SCAN_PATTERN = new RegExp(
  `^(?:${VOLUME_PREFIX_PATTERN})*(?:第${CJK_NUMERAL_PATTERN}[章节]|Chapter\\s+[0-9]+)`,
  "gim"
);
const CHARACTER_NAME_CANDIDATE_PATTERN =
  /(?:^|[。！？!?，、：:；;\n\r\t\s“”"'（）()])([\u4e00-\u9fff]{2,3})(?=(?:看见|停住|选择|没有|把|递给|确认|收到|打开|收起|藏起))/gu;
const REPLAY_PROTAGONIST_FALLBACK = "主角";
const LOW_SIGNAL_PROTAGONIST_FRAGMENTS = [
  "怎么",
  "什么",
  "为何",
  "为什么",
  "的人",
  "已经",
  "不是",
  "如果",
  "因为",
  "但是",
  "没有",
  "立刻",
  "\u5f53\u65f6",
  "\u9690\u7ea6",
  "\u53ef\u4ee5",
  "当前",
  "状态",
  "核心",
  "场景",
  "异常",
  "线索",
  "选择",
  "压力",
  "忽然",
  "门声",
  "脚步",
  "\u978b\u5b50",
  "\u6389\u4e86",
  "\u62ff\u51fa",
  "\u624b\u673a",
  "\u73bb\u7483\u7a97",
  "\u5b66\u4f1a",
  "\u978b\u5b50\u6389\u4e86",
  "\u62ff\u51fa\u624b\u673a",
  "\u7684\u5b66\u4f1a\u90fd",
];
const PRONOUN_OR_FUNCTION_PREFIXES = ["我", "他", "她", "它", "这", "那", "被", "把", "在", "和", "对", "但", "而", "并", "\u7684"];
const REPLAY_ACTION_FRAGMENT_PATTERNS = [
  /\u978b\u5b50[\u4e00-\u9fff]{0,2}/u,
  /\u62ff\u51fa[\u4e00-\u9fff]{0,2}/u,
  /[\u4e00-\u9fff]{0,2}\u624b\u673a/u,
  /[\u4e00-\u9fff]{0,2}\u73bb\u7483\u7a97/u,
  /[\u4e00-\u9fff]{0,2}\u5b66\u4f1a[\u4e00-\u9fff]{0,1}/u,
  /[\u4e00-\u9fff]{0,3}\u6211$/u,
  /^\u8fc7[\u4e00-\u9fff]{1,3}$/u,
  /^\u7684[\u4e00-\u9fff]{1,3}$/u,
];

const CANDIDATE_ENCODINGS = [
  "utf-8",
  "gb18030",
  "gbk",
  "gb2312",
  "big5",
  "utf-16le",
  "utf-16be",
];

const CHINESE_NUMERAL_VALUES: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

export function decodeNovelSourceBuffer(buffer: Uint8Array): DecodedNovelSource {
  let best: DecodedNovelSource | null = null;

  for (const encoding of orderCandidateEncodings(buffer)) {
    try {
      const text = normalizeDecodedText(new TextDecoder(encoding).decode(buffer));
      const score = scoreDecodedText(text);
      if (!best || score > best.score) {
        best = { text, encoding, score };
      }
    } catch {
      // Unsupported labels are ignored; Node's ICU coverage varies by build.
    }
  }

  if (best) {
    return best;
  }

  const text = normalizeDecodedText(new TextDecoder("utf-8").decode(buffer));
  return { text, encoding: "utf-8", score: scoreDecodedText(text) };
}

export function extractReplayCasesFromText(
  sourceText: string,
  options: ReplayCaseExtractionOptions
): ReplayCase[] {
  const slices = splitChapterSlices(normalizeDecodedText(sourceText));
  const selected = typeof options.maxCases === "number" ? slices.slice(0, options.maxCases) : slices;

  return selected.map((slice) => buildReplayCase(slice, options));
}

/**
 * Reconstruct the reference body for a replay case from already-decoded source
 * text. Reuses the same chapter-split logic as extraction so the reconstructed
 * body cannot drift from the body that produced `originalHash`.
 *
 * Returns null when the source no longer contains a chapter slice whose offsets
 * match the recorded sourceSpan (e.g. the source file changed after extraction).
 */
export function resolveReplayReferenceBody(
  decodedText: string,
  replayCase: Pick<ReplayCase, "sourceSpan">
): string | null {
  const normalized = normalizeDecodedText(decodedText);
  const slices = splitChapterSlices(normalized);
  const match = slices.find(
    (slice) =>
      slice.startOffset === replayCase.sourceSpan.startOffset &&
      slice.endOffset === replayCase.sourceSpan.endOffset
  );
  return match ? match.body : null;
}

export function hashReplayBody(body: string): string {
  return sha256(body);
}

export function writeReplayCases(cases: ReplayCase[], outputDir: string): ReplayCaseWriteResult {
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const files: string[] = [];
  for (const replayCase of cases) {
    const filename = `${sanitizeFilePart(replayCase.bookId)}-ch${padChapter(replayCase.chapterNumber)}.json`;
    const filePath = join(outputDir, filename);
    writeFileSync(filePath, JSON.stringify(replayCase, null, 2) + "\n", "utf-8");
    files.push(filePath);
  }

  return { outputDir, files };
}

export function sanitizeReplayId(value: string): string {
  return (
    value
      .trim()
      .replace(/[\\/:*?"<>|]+/g, "-")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "replay"
  );
}

export function sanitizeReplayProtagonistName(value: string | null | undefined): string | null {
  const normalized = (value ?? "")
    .trim()
    .replace(/^[“"'\s]+|[”"'\s]+$/g, "")
    .replace(/[，。！？、：:；;].*$/u, "")
    .trim();
  if (!normalized || normalized === REPLAY_PROTAGONIST_FALLBACK || normalized === "Replay主角") {
    return null;
  }
  if (isCommonNonName(normalized)) {
    return null;
  }
  if (looksLikeReplayActionFragment(normalized)) {
    return null;
  }
  if (/^[\u4e00-\u9fff]{2,4}$/u.test(normalized)) {
    if (LOW_SIGNAL_PROTAGONIST_FRAGMENTS.some((fragment) => normalized.includes(fragment))) {
      return null;
    }
    if (PRONOUN_OR_FUNCTION_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
      return null;
    }
    return normalized;
  }
  if (/^[A-Z][A-Za-z0-9 _.'-]{1,40}$/.test(normalized) && !/\b(?:the|this|that|actionable|objective|protagonist)\b/i.test(normalized)) {
    return normalized;
  }
  return null;
}

function looksLikeReplayActionFragment(value: string): boolean {
  return REPLAY_ACTION_FRAGMENT_PATTERNS.some((pattern) => pattern.test(value));
}

export function padChapter(chapterNumber: number): string {
  return String(chapterNumber).padStart(3, "0");
}

function splitChapterSlices(sourceText: string): ChapterSlice[] {
  const matches = [...sourceText.matchAll(CHAPTER_HEADING_PATTERN)];
  if (matches.length === 0 && sourceText.trim().length > 0) {
    return [
      {
        chapterNumber: 1,
        chapterTitle: "Untitled",
        heading: "Chapter 1",
        startOffset: 0,
        bodyStartOffset: 0,
        endOffset: sourceText.length,
        body: sourceText.trim(),
      },
    ];
  }

  return matches.map((match, index) => {
    const startOffset = match.index ?? 0;
    const heading = match[0];
    const headingEnd = startOffset + heading.length;
    const nextStart = matches[index + 1]?.index ?? sourceText.length;
    const bodyStartOffset = skipLineBreak(sourceText, headingEnd);
    const body = sourceText.slice(bodyStartOffset, nextStart).trim();
    const replayChapterNumber = index + 1;
    const sourceChapterNumber = parseChapterNumber(match[1] ?? match[2] ?? "", replayChapterNumber);
    const chapterTitle = (match[3] ?? "").trim() || `第${sourceChapterNumber}章`;

    return {
      chapterNumber: replayChapterNumber,
      chapterTitle,
      heading,
      startOffset,
      bodyStartOffset,
      endOffset: nextStart,
      body,
    };
  });
}

function buildReplayCase(
  slice: ChapterSlice,
  options: ReplayCaseExtractionOptions
): ReplayCase {
  const signals = collectBodySignals(slice.body);
  // Replay abstractions need a stable actor label; source-name inference is too noisy on first-person webnovel prose.
  const subject = REPLAY_PROTAGONIST_FALLBACK;
  const place = inferPlace(slice.chapterTitle, signals);
  const conflict = inferConflict(signals);
  const hook = inferHook(slice.chapterTitle, signals);

  return {
    bookId: options.bookId,
    chapterNumber: slice.chapterNumber,
    chapterTitle: slice.chapterTitle,
    abstractOutline: [
      `第${slice.chapterNumber}章《${slice.chapterTitle}》应完成${signals.sentenceCount}个叙事推进点。`,
      `核心是${subject}在${place}遭遇异常线索、做出选择，并把压力推向下一章。`,
      "生成时只使用抽象节拍和事件目标，不复用原文正文句子。",
    ].join(""),
    characterState: `主角：${subject}；当前压力：谨慎调查；状态变化：从观察转向决断。`,
    worldState: `场景簇：${place}；类型信号：异常、线索、延迟揭示；连续性要求：空间转换必须有明确过门。`,
    keyEvents: buildKeyEvents(slice.chapterTitle, subject, signals),
    emotionalBeats: buildEmotionalBeats(signals),
    conflictTarget: conflict,
    endingHook: hook,
    originalChapterPath: options.sourcePath,
    originalHash: sha256(slice.body),
    sourceSpan: {
      startOffset: slice.startOffset,
      endOffset: slice.endOffset,
    },
  };
}

function buildKeyEvents(
  chapterTitle: string,
  subject: string,
  signals: ReturnType<typeof collectBodySignals>
): string[] {
  const clue = signals.clueWords[0] ?? "异常线索";
  const pressure = signals.pressureWords[0] ?? "现场动静";
  const choice = signals.choiceWords[0] ?? "关键选择";

  return [
    `开场异常：${chapterTitle}；${subject}卷入当前问题。`,
    `线索推进：${clue}；目标改变。`,
    `选择加压：${pressure}；${subject}${formatChoiceAction(choice)}；付出代价。`,
    `结尾钩子：${pressure}回返；悬念未解。`,
  ];
}

function formatChoiceAction(choice: string): string {
  if (/选择|确认|带走|锁回|没有立刻|递给|收起|藏起|打开|停住/.test(choice)) {
    return choice;
  }
  return `做出${choice}`;
}

function buildEmotionalBeats(signals: ReturnType<typeof collectBodySignals>): string[] {
  const beats = ["安静观察", "不安上升", "受控决断"];
  if (signals.hasHook) {
    beats.push("悬念钩子");
  }
  return beats;
}

function collectBodySignals(body: string): {
  sentenceCount: number;
  characters: string[];
  clueWords: string[];
  pressureWords: string[];
  choiceWords: string[];
  hasHook: boolean;
} {
  const sentences = body.split(/[。！？!?]\s*/).filter((part) => part.trim().length > 0);
  return {
    sentenceCount: Math.max(1, sentences.length),
    characters: extractCharacterNames(body),
    clueWords: collectMatchingSignals(body, [
      "账本",
      "收据",
      "信",
      "编号",
      "黑印",
      "旧楼",
      "柜台",
      "抽屉",
      "钥匙",
      "照片",
      "录音",
      "猫眼",
    ]),
    pressureWords: collectMatchingSignals(body, [
      "脚步声",
      "敲门声",
      "停住",
      "不要再问",
      "楼道灯",
      "雨",
      "潮湿",
      "黑印",
      "门外",
    ]),
    choiceWords: collectMatchingSignals(body, [
      "选择",
      "确认",
      "带走",
      "锁回",
      "没有立刻",
      "递给",
      "收起",
      "藏起",
      "打开",
      "停住",
    ]),
    hasHook: /脚步声|敲门声|忽然|停在|尽头|门外|黑印|来信|盯住/.test(body),
  };
}

function extractCharacterNames(body: string): string[] {
  const candidates = [...body.matchAll(CHARACTER_NAME_CANDIDATE_PATTERN)]
    .map((match) => match[1])
    .map((name) => sanitizeReplayProtagonistName(name))
    .filter((name): name is string => Boolean(name));
  return [...new Set(candidates)].slice(0, 4);
}

function isCommonNonName(value: string): boolean {
  const blocked = new Set([
    "雨水",
    "老板",
    "门外",
    "清晨",
    "信纸",
    "走廊",
    "楼道灯",
    "抽屉",
    "柜台",
    "老人",
    "男人",
    "女人",
    "少年",
    "女孩",
  ]);
  return blocked.has(value);
}

function collectMatchingSignals(body: string, candidates: string[]): string[] {
  return candidates.filter((candidate) => body.includes(candidate)).slice(0, 4);
}

function inferPlace(chapterTitle: string, signals: ReturnType<typeof collectBodySignals>): string {
  if (chapterTitle.includes("诊所")) return "诊所";
  if (chapterTitle.includes("旧楼")) return "旧楼";
  if (chapterTitle.includes("医院")) return "医院";
  if (chapterTitle.includes("住处")) return "住处";
  return signals.clueWords.includes("旧楼") ? "旧楼" : "核心场景";
}

function inferConflict(signals: ReturnType<typeof collectBodySignals>): string {
  const clue = signals.clueWords[0] ?? "关键线索";
  const pressure = signals.pressureWords[0] ?? "现场动静";
  return `围绕${clue}判断下一步；${pressure}逼近并压缩选择。`;
}

function inferHook(chapterTitle: string, signals: ReturnType<typeof collectBodySignals>): string {
  const clue = signals.clueWords[0] ?? "关键线索";
  const pressure = signals.pressureWords[0] ?? "现场动静";
  return `${chapterTitle}结尾以${pressure}回返收束，${clue}仍未解释。`;
}

function parseChapterNumber(raw: string, fallback: number): number {
  if (/^\d+$/.test(raw)) {
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  const parsed = parseChineseInteger(raw);
  return parsed > 0 ? parsed : fallback;
}

function parseChineseInteger(raw: string): number {
  let result = 0;
  let section = 0;
  let number = 0;

  for (const char of raw) {
    const digit = CHINESE_NUMERAL_VALUES[char];
    if (digit !== undefined) {
      number = digit;
      continue;
    }

    if (char === "十" || char === "百" || char === "千") {
      const unit = char === "十" ? 10 : char === "百" ? 100 : 1000;
      section += (number || 1) * unit;
      number = 0;
      continue;
    }

    if (char === "万") {
      section = (section + number) * 10000;
      result += section;
      section = 0;
      number = 0;
    }
  }

  return result + section + number;
}

function skipLineBreak(sourceText: string, offset: number): number {
  if (sourceText[offset] === "\r" && sourceText[offset + 1] === "\n") {
    return offset + 2;
  }
  if (sourceText[offset] === "\n") {
    return offset + 1;
  }
  return offset;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf-8").digest("hex");
}

function sanitizeFilePart(value: string): string {
  return sanitizeReplayId(value);
}

function orderCandidateEncodings(buffer: Uint8Array): string[] {
  const preferred: string[] = [];
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    preferred.push("utf-8");
  }
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    preferred.push("utf-16le");
  }
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    preferred.push("utf-16be");
  }

  return [...new Set([...preferred, ...CANDIDATE_ENCODINGS])];
}

function normalizeDecodedText(text: string): string {
  return text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function scoreDecodedText(text: string): number {
  const length = Math.max(1, text.length);
  const cjkRatio = countMatches(text, /[\u4e00-\u9fff]/g) / length;
  const headingCount = countMatches(text, CHAPTER_HEADING_SCAN_PATTERN);
  const punctuationCount = countMatches(text, /[，。！？：；、]/g);
  const replacementCount = countMatches(text, /\uFFFD/g);
  const controlCount = countMatches(text, /[\x00-\x08\x0e-\x1f]/g);
  const mojibakeCount = countMatches(text, /绗|鐨|鍦|锛|銆|涓€|闆|妗|绔/g);

  return (
    cjkRatio * 100 +
    headingCount * 25 +
    punctuationCount * 0.2 -
    replacementCount * 80 -
    controlCount * 20 -
    mojibakeCount * 5
  );
}

function countMatches(text: string, pattern: RegExp): number {
  // NB-0R: 使用 exec 循环计数，避免 match() 分配大数组。
  // 对于 9MB 中文文本，match(/[\u4e00-\u9fff]/g) 会创建百万级数组，导致
  // 内存峰值 2.4GB+ 且极慢。exec 循环 O(1) 内存，行为完全一致。
  if (!pattern.global) {
    return pattern.test(text) ? 1 : 0;
  }
  let count = 0;
  pattern.lastIndex = 0;
  while (pattern.exec(text) !== null) {
    count++;
  }
  pattern.lastIndex = 0;
  return count;
}
