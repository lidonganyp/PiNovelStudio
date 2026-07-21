/**
 * Fact & Continuity Guard（Phase 2，计划 §Phase 2）
 *
 * 事实与连续性约束守卫。检测结果带 span，severity 区分硬阻断与只读诊断。
 *
 * FACTGUARD-DOWNGRADE-1（2026-07-14，对齐开发计划 §5.4"机械检查的最终定位"）：
 * 机械/推断/词典覆盖类检查降为 review（只读诊断 + trace 证据，不 hard block）：
 *   - format_hard_gate:2 未闭合引号（引号计数非事实错误，4K 误报）
 *   - scene_continuity 空间跳转（启发式叙事流，非事实硬伤）
 *   - skeleton_consistency 未解张力消解（字符串匹配启发式）
 *   - event_progression 状态变化动词密度（密度指标，§5.4 降为证据）
 *   - ontology_violation 未登记术语（词典覆盖缺口，非内容错误，Case 1 blocker）
 *   - ontology_transition 境界跃迁（推断性归因）
 *   - identity_contradiction 在历史/回忆语境下（描述过去状态，非当前矛盾）
 *
 * 保留 fatal/hard（事实硬伤，开发计划 §5.4 KEEP）：
 *   - format_hard_gate:0/1 空文/乱码（fatal）
 *   - duplicate_scan 大段重复
 *   - entity_checker 实体幻觉
 *   - constraint_manifest P0 不可破坏事实反向表述
 *   - chapter_identity 章号不匹配
 *   - deceased_character 已死亡角色作为在场行动者
 *   - identity_contradiction 同分句 + 明确关系词 + 无历史语境豁免（确认无疑的设定矛盾）
 *
 * 设计原则（Phase 2 要求）：
 * - 检测结果必须带 span（每条诊断都能定位到正文位置或说明全局）
 * - hard 阻断限于事实性硬伤；非事实类只读诊断不压制 LLM 创作（用户 2026-07-14 决策：
 *   "不能机械的约束大模型，这样对 LLM 不是放大，是压制"）
 * - 软风险（对白比例、段落节奏、风格偏移、AI 腔、群像层次）不在本 guard，
 *   归 LanguageRiskLibrary 或 diagnostic 层
 * - 不得用简化词表替代真实实现：entity_checker 继承 legacy 误报过滤经验
 *
 * 与 legacy-diagnostics-adapter.ts 的关系：
 * 本 guard 是 V2 原生实现（生产路径唯一事实检查），确保所有诊断带 span。
 * legacy-diagnostics-adapter 的 provider 保留为兼容层（lab/replay），不在生产路径。
 */

import type {
  Diagnostic,
  DiagnosticSeverity,
  TextSpan,
} from "./types.js";
import type { CompiledContext } from "./types.js";
import type { ConstraintManifest } from "./context-safety.js";
import { analyzeQuoteBalance } from "../../utils/quote-balance-evidence.js";

// ============================================================================
// 类型定义
// ============================================================================

export interface FactContinuityInput {
  text: string;
  context: CompiledContext;
  /** 已知角色名（含 aliases），用于实体幻觉检测 */
  knownCharacterNames?: string[];
  constraintManifest?: ConstraintManifest;
  expectedChapterNumber?: number;
  /** CANON-IDENTITY-1: 角色身份契约，用于身份矛盾检测 */
  identityContract?: import("./identity-contract-compiler.js").IdentityContract | null;
  /** WORLD-ONTOLOGY-1: 封闭世界本体契约，用于未登记术语检测 */
  ontologyContract?: import("./ontology-contract-compiler.js").OntologyContract | null;
}

export interface FactContinuityReport {
  /** 硬阻断诊断（severity fatal/hard） */
  hardBlocks: Diagnostic[];
  /** 所有诊断（含 hardBlocks） */
  allDiagnostics: Diagnostic[];
  /** 是否存在硬阻断 */
  hasHardBlock: boolean;
  constraintManifestHash?: string;
  ontologyContractId?: string;
  ontologyContractHash?: string;
  /**
   * FACT-GUARD-QUOTE-EXEMPTION-1: 规则公告/标牌/铭牌引文 + 角色有意重读复述的豁免审计记录。
   * 仅当 duplicate_scan 命中"引文块(source) + 引文块外重读(recall)"模式且 count==2 时输出；
   * 公告自身重复 / 正文拼接 / 伪公告无格式 / 三次以上 / 跨段复制仍按原规则 hard block。
   */
  quoteExemptions?: QuoteExemption[];
}

// ============================================================================
// FACT-GUARD-QUOTE-EXEMPTION-1: 引文+重读豁免类型
// ============================================================================

/**
 * 引文块类型。用于 QuoteExemption 审计字段 quoteBlockKind。
 * - announcement: 规则公告屏（含"公告"或"规则N："结构标记）
 * - signboard: 标牌（含"标牌"）
 * - nameplate: 铭牌（含"铭牌"）
 * - rule_text: 其他规则性引文块（含"规则"但无上述具体类型，或纯引文块）
 * - quoted_note: 引号包裹的注释/笔记/记录（FACT-GUARD-QUOTE-EXEMPTION-PROD-TRIGGER-1 新增）
 *   真相源：workspaces/fuben-clean-window-5-20260715/traces/3-blocked-candidate-evidence.json
 *   ch3 raw 中 "你看到了。这意味着你不是访客。--S" 在底稿元数据注释（发现）与
 *   车库回忆（recall）各出现 1 次，两处均在中文引号 "" 包裹内，无 markdown `>` 块。
 *   既有 QuoteExemption 只识别 `>` 块作为 source，导致合法引文回忆被误报 hard block。
 */
export type QuoteBlockKind = "announcement" | "signboard" | "nameplate" | "rule_text" | "quoted_note";

/**
 * 引文+重读豁免审计记录。每条记录对应一个被豁免的 duplicate_scan chunk。
 */
export interface QuoteExemption {
  /** 引文块中重复文本的 span（source，在 recallSpan 之前） */
  sourceSpan: TextSpan;
  /** 重读/复述位置的 span（recall，在引文块外） */
  recallSpan: TextSpan;
  /** 重复匹配率 (0,1]；sliding window 逐字匹配 = 1.0 */
  matchRatio: number;
  /** 豁免原因（描述引文块类型 + 重读语境） */
  reason: string;
  /** 引文块类型 */
  quoteBlockKind: QuoteBlockKind;
  /** 被豁免的 chunk 文本（审计） */
  exemptedChunk: string;
}

// ============================================================================
// 工具函数
// ============================================================================

function makeDiagnostic(
  guardId: string,
  idx: number,
  severity: DiagnosticSeverity,
  domain: Diagnostic["domain"],
  evidence: string,
  span?: TextSpan
): Diagnostic {
  return {
    id: `diag:${guardId}:${idx}`,
    source: guardId,
    severity,
    domain,
    evidence,
    span,
  };
}

// ============================================================================
// 1. format_hard_gate — 乱码/空文/格式损坏（全局，span 覆盖全文）
// ============================================================================

function checkFormat(text: string): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const fullSpan: TextSpan = { start: 0, end: text.length, excerpt: text.slice(0, 60) };

  if (text.trim().length === 0) {
    diags.push(makeDiagnostic("format_hard_gate", 0, "fatal", "format", "候选正文为空", fullSpan));
    return diags;
  }

  // 乱码：正常字符占比过低
  const normalChars = text.match(/[\u4e00-\u9fff\u3000-\u303fA-Za-z0-9\s.,;:!?，。；：！？、""''（）《》【】\-]/g) ?? [];
  const ratio = normalChars.length / text.length;
  if (ratio < 0.85) {
    // 找到第一个异常字符位置定位 span
    const abnormalMatch = text.search(/[^\u4e00-\u9fff\u3000-\u303fA-Za-z0-9\s.,;:!?，。；：！？、""''（）《》【】\-]/);
    const span: TextSpan = {
      start: Math.max(0, abnormalMatch),
      end: Math.min(text.length, abnormalMatch + 30),
      excerpt: text.slice(Math.max(0, abnormalMatch), abnormalMatch + 30),
    };
    diags.push(
      makeDiagnostic("format_hard_gate", 1, "fatal", "format", `乱码检测：正常字符占比 ${ratio.toFixed(2)} < 0.85`, span)
    );
  }

  // 未闭合引号
  const quoteEvidence = analyzeQuoteBalance(text);
  if (quoteEvidence.asciiSingle % 2 !== 0 || quoteEvidence.asciiDouble % 2 !== 0) {
    const lastQuote = quoteEvidence.unmatchedStart ?? Math.max(text.lastIndexOf("'"), text.lastIndexOf('"'));
    const span: TextSpan = {
      start: Math.max(0, lastQuote),
      end: Math.min(text.length, lastQuote + 10),
      excerpt: text.slice(Math.max(0, lastQuote), lastQuote + 10),
    };
    diags.push(
      makeDiagnostic("format_hard_gate", 2, "review", "format", `未闭合引号：单引号 ${quoteEvidence.asciiSingle} 个，双引号 ${quoteEvidence.asciiDouble} 个；${quoteEvidence.summary}`, span)
    );
  }

  return diags;
}

// ============================================================================
// 2. duplicate_scan — 大段重复污染（带 span）
//
// FACT-GUARD-QUOTE-EXEMPTION-1（2026-07-15）：
// 在 sliding window 逐字匹配基础上，新增"引文块(source) + 引文块外重读(recall)"豁免。
// 严格限定豁免边界：
//   - 仅豁免 count==2 且 1 个位置在 markdown `>` 引文块内 + 1 个位置在引文块外的重复
//   - recall 位置必须有引号包裹 或 重读动词附近（识别"有意重读/分析"语境）
//   - 公告自身重复（两位置都在引文块内）/ 正文拼接 / 伪公告无格式 / 三次以上 / 跨段复制仍 hard block
// 豁免不丢弃审计：每条豁免输出 QuoteExemption 记录（sourceSpan/recallSpan/matchRatio/reason/quoteBlockKind/exemptedChunk）
// ============================================================================

interface DupInfo {
  excerpt: string;
  start: number;
  count: number;
  allStarts: number[];
}

interface LineInfo {
  start: number;
  end: number;
  text: string;
}

interface QuoteBlockRange {
  startOffset: number;
  endOffset: number;
  kind: QuoteBlockKind;
}

/**
 * 重读/复述动词。recall 位置附近出现这些动词表示"有意重读/分析"语境。
 *
 * FACT-GUARD-QUOTE-EXEMPTION-PROD-TRIGGER-1（2026-07-16）扩展：
 * 新增 "想到" / "翻开" / "读到" / "展开" / "翻到"，覆盖 ch3 真实 raw 中的
 * 引文回忆语境（"想到...看到的那行注释" / "翻开...读到" / "展开纸条"）。
 */
const RECALL_VERBS = [
  "想起", "念", "说", "读", "记起", "回忆", "复述", "看了一眼", "看到",
  "默念", "背诵", "念叨", "嘀咕", "重复", "记得", "听到", "低声",
  // PROD-TRIGGER-1 新增（ch3 真实引文回忆语境）
  "想到", "翻开", "读到", "展开", "翻到",
  // 视觉回读：角色查看一组证据后再次聚焦既有屏幕/弹窗/标牌原文
  "看着", "看向", "扫了一眼", "扫视", "重新看", "低头看",
];

function splitLinesWithOffsets(text: string): LineInfo[] {
  const lines: LineInfo[] = [];
  let offset = 0;
  const parts = text.split(/\r?\n/);
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    lines.push({ start: offset, end: offset + line.length, text: line });
    offset += line.length + 1; // +1 for newline
  }
  return lines;
}

function classifyQuoteBlockKind(blockText: string): QuoteBlockKind {
  if (/公告|规则[一二三四五六七八九十0-9]+\s*[：:]/.test(blockText)) {
    return "announcement";
  }
  if (/标牌/.test(blockText)) {
    return "signboard";
  }
  if (/铭牌/.test(blockText)) {
    return "nameplate";
  }
  return "rule_text";
}

/** 找到所有 markdown 引文块（连续的 `>` 开头行），返回字符 offset 范围与类型 */
function findMarkdownQuoteBlockLineRanges(lines: LineInfo[]): QuoteBlockRange[] {
  const ranges: QuoteBlockRange[] = [];
  let i = 0;
  while (i < lines.length) {
    if (/^\s*>\s?/.test(lines[i].text)) {
      const startOffset = lines[i].start;
      let endLine = i;
      while (endLine < lines.length && /^\s*>\s?/.test(lines[endLine].text)) {
        endLine++;
      }
      const endOffset = lines[endLine - 1].end;
      const blockText = lines.slice(i, endLine)
        .map((l) => l.text.replace(/^\s*>\s?/, ""))
        .join("\n");
      ranges.push({
        startOffset,
        endOffset,
        kind: classifyQuoteBlockKind(blockText),
      });
      i = endLine;
    } else {
      i++;
    }
  }
  return ranges;
}

function isInsideMarkdownQuoteBlock(offset: number, ranges: QuoteBlockRange[]): QuoteBlockRange | null {
  for (const r of ranges) {
    if (offset >= r.startOffset && offset < r.endOffset) {
      return r;
    }
  }
  return null;
}

/** recall 位置附近是否有重读/复述动词（windowSize 字符窗口） */
function hasRecallVerbNearby(text: string, offset: number, windowSize = 40): boolean {
  const start = Math.max(0, offset - windowSize);
  const end = Math.min(text.length, offset + windowSize);
  const window = text.slice(start, end);
  return RECALL_VERBS.some((v) => window.includes(v));
}

function hasRecallContextForQuotedSpan(text: string, quoteStart: number): boolean {
  const beforeQuote = text.slice(0, quoteStart);
  const paragraphs = beforeQuote.split(/\n\s*\n/);
  const currentPrefix = paragraphs.at(-1)?.trim() ?? "";
  if (RECALL_VERBS.some((verb) => currentPrefix.includes(verb))) {
    return true;
  }
  if (currentPrefix.replace(/[\s*_—:：-]/g, "") !== "") {
    return false;
  }
  for (let index = paragraphs.length - 2; index >= 0; index -= 1) {
    const paragraph = paragraphs[index].trim();
    if (!paragraph) continue;
    return RECALL_VERBS.some((verb) => paragraph.includes(verb));
  }
  return false;
}

/** recall 位置是否在引号包裹内（中文引号 "" '' 或 ASCII " '） */
function isInsideQuotedSpan(text: string, offset: number): boolean {
  const start = Math.max(0, offset - 60);
  const end = Math.min(text.length, offset + 60);
  const window = text.slice(start, end);
  const relOffset = offset - start;
  // 向前找最近的开始引号
  let openIdx = -1;
  for (let i = relOffset - 1; i >= 0; i--) {
    if (/[""']/.test(window[i])) {
      openIdx = i;
      break;
    }
  }
  if (openIdx === -1) return false;
  // 向后找结束引号
  for (let i = relOffset; i < window.length; i++) {
    if (/[""']/.test(window[i])) {
      return true;
    }
  }
  return false;
}

// ============================================================================
// FACT-GUARD-QUOTE-EXEMPTION-PROD-TRIGGER-1（2026-07-16）新增：
// Strategy B — 中文引号配对的"引文笔记(source) + 引文外重读(recall)"豁免。
//
// 真相源：workspaces/fuben-clean-window-5-20260715/traces/3-blocked-candidate-evidence.json
// ch3 raw 在底稿元数据注释（位置 5535，"你看到了。这意味着你不是访客。--S"）中
// 引用了沈游的纸条注释；后续在车库场景（位置 6127）主角"想到...看到的那行注释"
// 重读同一行。这是合法的叙事回忆，不是正文拼接重复。
//
// 严格限定豁免边界（与 Strategy A 一致，仅 source 来源不同）：
//   - count==2
//   - 1 个位置在某个 `""` 引号对内（source = 引文笔记），另 1 个位置在另一个 `""` 引号对内（recall = 重读）
//   - 两个位置必须落在**不同的**引号对内（同一引号对内重复 = 公告自身缺陷，不豁免）
//   - recall 位置必须有重读动词附近 或 引号包裹（识别"有意重读/分析"语境）
//   - 普通重复（无引号）、三次复制、无来源复读、跨段拼接仍 hard block
// ============================================================================

interface QuotedSpanRange {
  /** 引号对的开始 offset（含开始引号字符本身） */
  startOffset: number;
  /** 引号对的结束 offset（不含结束引号字符；endOffset 为结束引号之后位置，与 startOffset 配对一致） */
  endOffset: number;
  /** 引号对在全文中的序号（从 0 开始），用于判断两个位置是否落在同一对内 */
  pairIndex: number;
}

/**
 * 找到所有引号对，支持中文引号（U+201C `"` 开 + U+201D `"` 闭）和 ASCII 双引号（U+0022 `"`）。
 *
 * 配对规则：
 * - 中文引号：Nth `"` 配 Nth `"`（明确的开闭区分）
 * - ASCII 双引号：按出现顺序奇偶配对（第 1 个是开，第 2 个是闭，第 3 个是开，...）
 * - 两种引号独立配对，互不干扰
 * - 合并后按 startOffset 排序，重新分配全局 pairIndex（用于判断两个位置是否落在同一对内）
 *
 * 真相源：ch3 raw 使用 ASCII 双引号 (U+0022) 包裹引文笔记
 * "你看到了。这意味着你不是访客。--S"（位置 5534 与 6126）。
 * 既有实现只识别中文引号，导致 ASCII 引号包裹的引文笔记无法被 Strategy B 识别。
 *
 * 注意：本函数不识别单引号 `''`。小说文本中单引号较少用于引文笔记，
 * 若未来出现可扩展。ASCII 单引号已由 isInsideQuotedSpan 处理。
 */
function findQuotedSpanRanges(text: string): QuotedSpanRange[] {
  const ranges: QuotedSpanRange[] = [];

  // 1. 中文引号对（U+201C 开 + U+201D 闭）
  const cnPendingOpens: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\u201C") {
      cnPendingOpens.push(i);
    } else if (ch === "\u201D" && cnPendingOpens.length > 0) {
      const startOffset = cnPendingOpens.pop()!;
      ranges.push({
        startOffset,
        endOffset: i + 1,
        pairIndex: 0, // 稍后统一重新分配
      });
    }
  }

  // 2. ASCII 双引号对（按奇偶配对）
  let asciiOpenOffset: number | null = null;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') {
      if (asciiOpenOffset === null) {
        asciiOpenOffset = i;
      } else {
        ranges.push({
          startOffset: asciiOpenOffset,
          endOffset: i + 1,
          pairIndex: 0, // 稍后统一重新分配
        });
        asciiOpenOffset = null;
      }
    }
  }
  // 孤立 ASCII 开引号被忽略（asciiOpenOffset 仍非 null 时）

  // 3. 按 startOffset 排序，重新分配全局 pairIndex
  ranges.sort((a, b) => a.startOffset - b.startOffset);
  for (let i = 0; i < ranges.length; i++) {
    ranges[i].pairIndex = i;
  }

  return ranges;
}

/**
 * 判断 offset 是否落在某个引号对内（strictly inside，不含引号字符本身）。
 * 返回所在引号对；若不在任何引号对内返回 null。
 */
function isInsideQuotedSpanRange(
  offset: number,
  ranges: QuotedSpanRange[],
): QuotedSpanRange | null {
  for (const r of ranges) {
    // strictly inside：offset 必须在 startOffset+1（开引号之后）到 endOffset-1（闭引号之前）之间
    if (offset > r.startOffset && offset < r.endOffset - 1) {
      return r;
    }
  }
  return null;
}

/**
 * 查找与 chunk 范围 [chunkStart, chunkEnd) 重叠的引号对。
 *
 * PROD-TRIGGER-1 关键设计：sliding window 的 minLen=24，而引文笔记可能不足 24 字符
 * （如 ch3 raw 的 "你看到了。这意味着你不是访客。--S" 仅 17 字符）。此时 chunk 必然
 * 包含引号外的前导/后导字符（如 `\n\n`），chunk start 不在引号对内。
 *
 * 因此 Strategy B 不要求 chunk start 在引号对内，而是要求 chunk 范围与引号对内容
 * 有重叠（chunk 覆盖了引号对内的部分文本）。这能正确识别"短引文笔记 + 重读"模式。
 *
 * 重叠判定：chunk 范围 [chunkStart, chunkEnd) 与引号对内容范围
 * (startOffset, endOffset-1) 有交集（不含引号字符本身）。
 */
function findOverlappingQuoteRange(
  chunkStart: number,
  chunkEnd: number,
  ranges: QuotedSpanRange[],
): QuotedSpanRange | null {
  for (const r of ranges) {
    // 引号对内容范围（不含引号字符本身）：(startOffset, endOffset-1)
    const quoteContentStart = r.startOffset + 1;
    const quoteContentEnd = r.endOffset - 1;
    // 区间重叠判定：chunkStart < quoteContentEnd && chunkEnd > quoteContentStart
    if (chunkStart < quoteContentEnd && chunkEnd > quoteContentStart) {
      return r;
    }
  }
  return null;
}

/** sliding window 逐字匹配，返回所有重复 chunk（含全部出现位置） */
function scanDuplicates(text: string, minLen: number): DupInfo[] {
  if (text.length < minLen * 2) return [];
  const seen = new Map<string, { starts: number[]; count: number }>();
  for (let i = 0; i + minLen <= text.length; i += 1) {
    const chunk = text.slice(i, i + minLen);
    if (chunk.trim().length < minLen * 0.5) continue;
    const existing = seen.get(chunk);
    if (existing) {
      existing.count += 1;
      existing.starts.push(i);
    } else {
      seen.set(chunk, { starts: [i], count: 1 });
    }
  }
  const dups: DupInfo[] = [];
  for (const [chunk, info] of seen) {
    if (info.count >= 2) {
      dups.push({
        excerpt: chunk.slice(0, 30),
        start: info.starts[0],
        count: info.count,
        allStarts: info.starts,
      });
    }
  }
  return dups;
}

/**
 * 判定单个重复 chunk 是否符合豁免条件。
 *
 * FACT-GUARD-QUOTE-EXEMPTION-PROD-TRIGGER-1（2026-07-16）重构：
 * 原单一策略（markdown `>` 引文块）扩展为两段式策略链。
 *
 * Strategy A（既有）：markdown `>` 引文块(source) + 引文块外重读(recall)
 *   - 适用于显式公告/标牌/铭牌/规则文本的"引文块 + 角色重读"模式
 *
 * Strategy B（新增）：中文引号对引文笔记(source) + 不同引号对内重读(recall)
 *   - 适用于无 markdown `>` 格式、但用中文引号包裹的"引文笔记 + 重读"模式
 *   - 真相源：ch3 raw 中"你看到了。这意味着你不是访客。--S"在底稿元数据注释
 *     与车库重读场景各出现一次，均落在中文引号对内，是合法叙事回忆
 *
 * 严格限定豁免边界（两策略一致）：
 *   - count<=2
 *   - source 与 recall 必须落在**不同**的引文容器（`>` 块或引号对）内
 *   - recall 必须有引号包裹 或 重读动词附近（识别"有意重读/分析"语境）
 *   - 普通重复（无引号）、三次复制、无来源复读、跨段拼接仍 hard block
 */
function decideExemption(
  text: string,
  dup: DupInfo,
  quoteRanges: QuoteBlockRange[],
  quotedSpanRanges: QuotedSpanRange[],
  minLen: number,
): { exempted: boolean; exemption?: QuoteExemption } {
  // 三次以上复制不豁免（即便源于公告，超出"引文+重读"叙事必要边界）
  if (dup.count > 2) return { exempted: false };

  // ===== Strategy A: markdown `>` 引文块(source) + 引文块外重读(recall) =====
  const strategyA = tryStrategyA(text, dup, quoteRanges, minLen);
  if (strategyA.exempted) return strategyA;

  // ===== Strategy B: 中文引号对引文笔记(source) + 不同引号对内重读(recall) =====
  const strategyB = tryStrategyB(text, dup, quotedSpanRanges, minLen);
  if (strategyB.exempted) return strategyB;

  return { exempted: false };
}

/**
 * Strategy A：markdown `>` 引文块(source) + 引文块外重读(recall) 豁免。
 * 既有逻辑，FACT-GUARD-QUOTE-EXEMPTION-1 引入。
 */
function tryStrategyA(
  text: string,
  dup: DupInfo,
  quoteRanges: QuoteBlockRange[],
  minLen: number,
): { exempted: boolean; exemption?: QuoteExemption } {
  let sourceStart: number | null = null;
  let sourceRange: QuoteBlockRange | null = null;
  let recallStart: number | null = null;

  for (const start of dup.allStarts) {
    const range = isInsideMarkdownQuoteBlock(start, quoteRanges);
    if (range) {
      // 引文块内位置 = source（取第一个）
      if (sourceStart === null) {
        sourceStart = start;
        sourceRange = range;
      }
      // 引文块内第 2+ 个位置 = 公告自身重复，不作为 recall
    } else {
      // 引文块外位置 = recall（取第一个；第 2+ 个已由 count>2 排除）
      if (recallStart === null) {
        recallStart = start;
      }
    }
  }

  // 必须有 1 个 source（在引文块内）+ 1 个 recall（在引文块外）
  if (sourceStart === null || recallStart === null || !sourceRange) {
    return { exempted: false };
  }

  // recall 必须有引号包裹 或 重读动词附近（识别"有意重读/分析"语境）
  const hasQuote = isInsideQuotedSpan(text, recallStart);
  const hasVerb = hasRecallVerbNearby(text, recallStart);
  if (!hasQuote && !hasVerb) {
    return { exempted: false };
  }

  const matchRatio = 1.0; // sliding window 逐字匹配，匹配率恒为 1.0

  const reason = hasQuote && hasVerb
    ? `引文块(${sourceRange.kind}) + 角色引号包裹重读(附近含重读动词)`
    : hasQuote
      ? `引文块(${sourceRange.kind}) + 角色引号包裹复述`
      : `引文块(${sourceRange.kind}) + 角色有意重读(附近含重读动词)`;

  return {
    exempted: true,
    exemption: {
      sourceSpan: {
        start: sourceStart,
        end: sourceStart + minLen,
        excerpt: text.slice(sourceStart, sourceStart + Math.min(minLen, 30)),
      },
      recallSpan: {
        start: recallStart,
        end: recallStart + minLen,
        excerpt: text.slice(recallStart, recallStart + Math.min(minLen, 30)),
      },
      matchRatio,
      reason,
      quoteBlockKind: sourceRange.kind,
      exemptedChunk: dup.excerpt,
    },
  };
}

/**
 * Strategy B：中文引号对引文笔记(source) + 不同引号对内重读(recall) 豁免。
 * FACT-GUARD-QUOTE-EXEMPTION-PROD-TRIGGER-1（2026-07-16）新增。
 *
 * 判定条件：
 *   1. count==2（已由调用方保证）
 *   2. 两个位置都落在中文引号对内（isInsideQuotedSpanRange 非 null）
 *   3. 两个位置落在**不同**的引号对内（pairIndex 不同）—— 同一对内重复 = 引文自身缺陷，不豁免
 *   4. 较早的位置作为 source，较晚的位置作为 recall
 *   5. recall 必须有重读动词附近（额外要求，确认是"有意重读"而非偶然重复）
 *
 * 注意：Strategy B 不要求 recall 在引号外（因为 Strategy B 的 source 本身就在引号对内），
 * 但要求 recall 必须有重读动词附近，以避免两段独立引文偶然重复被误豁免。
 * 这比 Strategy A 更严格（Strategy A 允许 recall 仅引号包裹而无动词），
 * 因为 Strategy B 的 source 没有显式的 `>` 格式标记，需要更强的 recall 语境证据。
 */
function tryStrategyB(
  text: string,
  dup: DupInfo,
  quotedSpanRanges: QuotedSpanRange[],
  minLen: number,
): { exempted: boolean; exemption?: QuoteExemption } {
  // 收集每个 chunk 位置关联的引号对（chunk 范围与引号对内容有重叠）
  // PROD-TRIGGER-1：用 findOverlappingQuoteRange 替代 isInsideQuotedSpanRange，
  // 因为引文笔记可能不足 minLen=24 字符，chunk 必然包含引号外前导/后导字符。
  const positionsWithRange: Array<{ start: number; range: QuotedSpanRange }> = [];
  for (const start of dup.allStarts) {
    const range = findOverlappingQuoteRange(start, start + minLen, quotedSpanRanges);
    if (range) {
      positionsWithRange.push({ start, range });
    }
  }

  // 必须恰好 2 个位置都关联引号对（count==2 已保证总数，这里筛掉无关联位置）
  // 若有位置不关联引号对，说明不是"引文笔记 + 引文重读"模式，交回给调用方（Strategy A 已失败 → hard block）
  if (positionsWithRange.length !== 2) {
    return { exempted: false };
  }

  const [first, second] = positionsWithRange;
  // 两个位置必须关联不同的引号对（pairIndex 不同）—— 同一对内重复 = 引文自身缺陷，不豁免
  if (first.range.pairIndex === second.range.pairIndex) {
    return { exempted: false };
  }

  // source 与 recall 引号对内容必须完全相同（防止"部分重复"误豁免）
  const sourceContent = text.slice(first.range.startOffset + 1, first.range.endOffset - 1);
  const recallContent = text.slice(second.range.startOffset + 1, second.range.endOffset - 1);
  if (sourceContent !== recallContent) {
    return { exempted: false };
  }

  // 全文中 source 内容出现的总次数必须恰好为 2（防止三次以上复制）
  // PROD-TRIGGER-1：sliding window 对三次复制可能生成部分 count==2 的 chunk
  // （前导字符不同导致），需通过全文内容计数兜底。
  // 注意：计数包括 `>` 块内、引号对内、引号外的所有出现，不仅限于引号对。
  let totalOccurrenceCount = 0;
  let searchStart = 0;
  while (searchStart <= text.length - sourceContent.length) {
    const idx = text.indexOf(sourceContent, searchStart);
    if (idx === -1) break;
    totalOccurrenceCount++;
    searchStart = idx + 1; // 允许重叠匹配，与 sliding window 一致
  }
  if (totalOccurrenceCount !== 2) {
    return { exempted: false };
  }

  // 较早位置 = source，较晚位置 = recall
  const sourceStart = first.start;
  const recallStart = second.start;

  // recall 必须有重读动词附近（Strategy B 的严格性要求）
  const hasVerb = hasRecallContextForQuotedSpan(text, second.range.startOffset);
  if (!hasVerb) {
    return { exempted: false };
  }

  const matchRatio = 1.0; // sliding window 逐字匹配，匹配率恒为 1.0

  const reason = `引文笔记(quoted_note) + 角色引号内重读(附近含重读动词)`;

  return {
    exempted: true,
    exemption: {
      sourceSpan: {
        start: sourceStart,
        end: sourceStart + minLen,
        excerpt: text.slice(sourceStart, sourceStart + Math.min(minLen, 30)),
      },
      recallSpan: {
        start: recallStart,
        end: recallStart + minLen,
        excerpt: text.slice(recallStart, recallStart + Math.min(minLen, 30)),
      },
      matchRatio,
      reason,
      quoteBlockKind: "quoted_note",
      exemptedChunk: dup.excerpt,
    },
  };
}

function checkDuplicates(text: string, minLen = 24): { diagnostics: Diagnostic[]; exemptions: QuoteExemption[] } {
  const dups = scanDuplicates(text, minLen);
  if (dups.length === 0) return { diagnostics: [], exemptions: [] };

  const lines = splitLinesWithOffsets(text);
  const quoteRanges = findMarkdownQuoteBlockLineRanges(lines);
  // PROD-TRIGGER-1 新增：识别中文引号对，供 Strategy B 判定"引文笔记 + 重读"豁免
  const quotedSpanRanges = findQuotedSpanRanges(text);

  const diagnostics: Diagnostic[] = [];
  const exemptions: QuoteExemption[] = [];

  for (const dup of dups) {
    if (diagnostics.length >= 5) break; // 限制 diagnostic 数量，与原实现一致
    const { exempted, exemption } = decideExemption(text, dup, quoteRanges, quotedSpanRanges, minLen);
    if (exempted && exemption) {
      exemptions.push(exemption);
    } else {
      diagnostics.push(
        makeDiagnostic(
          "duplicate_scan",
          diagnostics.length,
          "hard",
          "continuity",
          `大段重复："${dup.excerpt}..." 在位置 ${dup.start} 重复 ${dup.count} 次`,
          { start: dup.start, end: dup.start + minLen, excerpt: dup.excerpt }
        )
      );
    }
  }

  return { diagnostics, exemptions };
}

// ============================================================================
// 3. entity_checker — 实体幻觉（带 span，继承 legacy 误报过滤经验）
// ============================================================================

const ENTITY_COMMON_NOUN_ALLOWLIST = new Set([
  "主角", "对方", "众人", "自己", "他们", "我们", "她们", "大家",
  "旁人", "敌人", "那人", "此人", "某人", "别人", "人家",
  "大汉", "男子", "女子", "少年", "老人", "女孩", "男孩", "青年",
  "长者", "老者", "少女", "妇人", "汉子", "小子", "姑娘", "先生",
  "太太", "小姐", "师傅", "师弟", "师兄", "师姐", "师妹", "掌门",
  "队长", "赵队", "李队", "王队", "张队", "局长", "处长", "主任",
  "医生", "护士", "警员", "士兵", "卫兵", "守卫", "门卫", "路人",
  "刚要", "刚才", "此刻", "现在", "方才", "片刻", "马上", "立刻",
  "立即", "顿时", "瞬间", "顷刻", "旋即", "随即", "忽然", "突然",
  "终于", "后来", "随后", "然后", "接着", "之后", "之前", "于是",
  "所以", "但是", "不过", "而且", "并且", "还是", "或者", "也许",
  "可能", "似乎", "应该", "难道", "毕竟", "果然", "其实", "确实", "不知",
  "本来", "原来", "竟然", "居然",
  // FACTGUARD-SCANNER-FIX-1: 否定/系词/判断短语，跟在言说动词前不是角色名
  // （Case06 ch21 "不是笑" 把否定词"不是"误判为角色名触发 entity_checker 误报）
  "不是", "这是", "那是", "只是", "都是", "也是", "就是", "可是",
  "乃是", "若是", "或是", "是否", "凡是", "总是", "仍是", "倒是",
  // FACT-GUARD-ENTITY-CHECKER-RULE-TEXT-1: 否定词/无生命名词，跟在言说动词前不是角色名
  // 真相源：workspaces/fuben-clean-window-5-20260715/traces/2-blocked-candidate-evidence.json
  // RECOVERY-3 ch2 raw "没有说/回/应" 把否定词"没有"误判；"广播说/回/应" 把无生命主语"广播"误判。
  "没有", "广播", "电视", "电话", "电报", "信件", "纸条", "字幕", "屏幕",
  "喇叭", "话筒", "通知", "通告", "通报", "公告", "播报", "铃声", "警报",
]);

// ENTITY-CHECKER-1: "道"作非言说复合词的过滤
// 当"道"是名词性复合词的一部分（如"通道""道路""知道"），不应作为言说归因动词
// 触发实体幻觉。仅当"道"后紧跟冒号/引号等明确言说标点时，才视为真实归因动词。
// 真相源：reports/real-quality-4g-result-20260714.md ch18 "溶洞通道" 被 greedy 正则
// 回溯成 "溶洞通"+"道" 触发误报。
const NON_SPEECH_DAO_PREFIX_COMPOUND = new Set([
  // "X道" 形式：道作名词后缀，X+道 构成复合词
  "通道", "隧道", "楼道", "河道", "铁道", "轨道", "频道", "巷道", "渠道", "管道",
  "过道", "车道", "跑道", "泳道", "弯道", "岔道", "暗道", "栈道", "霸道", "报道",
  "味道", "街道", "航道", "林道", "山道", "坡道", "匝道", "井道", "步道", "赤道",
  "知道", "主道", "环道", "便道", "门道", "海道", "缆道", "索道", "茶道", "弓道",
  "白道", "黑道", "黄道", "星道", "人道", "神道", "佛道", "邪道", "外道", "左道",
  "家道", "世道", "公道", "腰道", "大道", "小道", "间道", "要道",
]);
const NON_SPEECH_DAO_SUFFIX_COMPOUND = new Set([
  // "道X" 形式：道作名词前缀，道+X 构成复合词
  "道路", "道口", "道面", "道旁", "道内", "道外", "道中", "道上", "道下", "道边",
  "道里", "道处", "道前", "道后", "道端", "道尾", "道段", "道侧", "道线",
  "道具", "道德", "道理", "道场", "道观", "道士", "道教", "道法", "道行", "道袍",
  "道谢", "道贺", "道歉", "道别", "道破", "道出", "道来", "道碑", "道闸", "道岔",
  "道符", "道童", "道祖", "道号", "道藏",
]);
const SPEECH_DAO_FOLLOW_CHAR = /[:：""''「『]/;

function isNonSpeechDaoCompound(
  text: string,
  matchStart: number,
  nameLength: number
): boolean {
  const daoPos = matchStart + nameLength;
  if (text[daoPos] !== "道") return false;
  const nextChar = daoPos + 1 < text.length ? text[daoPos + 1] : "";
  // "道"后紧跟冒号/引号 → 真实言说归因（如"魏无道："），不过滤
  if (nextChar && SPEECH_DAO_FOLLOW_CHAR.test(nextChar)) return false;
  const prevChar = daoPos > 0 ? text[daoPos - 1] : "";
  // "X道" 是名词性复合词后缀（如"通道""知道"）
  if (prevChar && NON_SPEECH_DAO_PREFIX_COMPOUND.has(prevChar + "道")) return true;
  // "道X" 是名词性复合词前缀（如"道路""道具"）
  if (nextChar && NON_SPEECH_DAO_SUFFIX_COMPOUND.has("道" + nextChar)) return true;
  return false;
}

// FACT-GUARD-ENTITY-CHECKER-RULE-TEXT-1: "回"作非言说运动复合词的过滤
// 当"回"是运动复合词的一部分（如"返回""回去""回来""回到"），不应作为言说归因动词
// 触发实体幻觉。仅当"回"后紧跟冒号/引号等明确言说标点时，才视为真实归因动词。
// 真相源：workspaces/fuben-clean-window-5-20260715/traces/2-blocked-candidate-evidence.json
// RECOVERY-3 ch2 raw "禁止返回入口" 被 greedy 正则回溯成 "禁止返"+"回" 触发误报
// （"返回"中的"回"是运动动词，非言说归因动词"回答"）。
const NON_SPEECH_HUI_PREFIX_COMPOUND = new Set([
  // "X回" 形式：回作运动动词后缀，X+回 构成运动复合词
  "返回", "退回", "撤回", "唤回", "调回", "折回", "找回", "来回", "轮回",
  "追回", "索回", "要回", "买回", "卖回", "送回", "拿回", "带回", "领回",
  "请回", "推回", "拉回", "挤回", "抢回", "救回", "接回", "还回", "流回",
  "倒回", "绕回", "走回", "跑回", "飞回", "跳回", "爬回", "游回", "驶回",
  "归回", "逼回", "赶回", "撵回", "遣回", "押回", "护回", "缩回", "舔回",
  "咽回", "吸回", "收回", "召回", "传回", "撤回", "反弹回", "退回", "撤回",
  // 排除言说动词复合词：回答/回应/回禀/回话 不在此列
]);
const NON_SPEECH_HUI_SUFFIX_COMPOUND = new Set([
  // "回X" 形式：回作运动动词前缀，回+X 构成运动复合词
  "回去", "回来", "回到", "回过", "回转", "回身", "回首", "回望", "回头",
  "回避", "回廊", "回声", "回音", "回信", "回执", "回路", "回程", "回顾",
  "回想", "回忆", "回响", "回旋", "回荡", "回潮", "回火", "回炉", "回绝",
  "回落", "回填", "回放", "回馈", "回扣", "回敬", "回击", "回流", "回民",
  "回乡", "回归", "回师", "回援", "回返", "回礼", "回拜", "回访", "回车",
  "回马", "回眸", "回神", "回目", "回页", "回弹", "回跃", "回跳", "回飞",
  // 排除言说动词复合词：回答/回应/回禀/回话/回唱/回诵 不在此列
]);
const SPEECH_HUI_FOLLOW_CHAR = /[:：""''「『]/;

function isNonSpeechHuiCompound(
  text: string,
  matchStart: number,
  nameLength: number
): boolean {
  const huiPos = matchStart + nameLength;
  if (text[huiPos] !== "回") return false;
  const nextChar = huiPos + 1 < text.length ? text[huiPos + 1] : "";
  // "回"后紧跟冒号/引号 → 真实言说归因（如"林觉回："），不过滤
  if (nextChar && SPEECH_HUI_FOLLOW_CHAR.test(nextChar)) return false;
  const prevChar = huiPos > 0 ? text[huiPos - 1] : "";
  // "X回" 是运动复合词后缀（如"返回""退回"）
  if (prevChar && NON_SPEECH_HUI_PREFIX_COMPOUND.has(prevChar + "回")) return true;
  // "回X" 是运动复合词前缀（如"回去""回来"）
  if (nextChar && NON_SPEECH_HUI_SUFFIX_COMPOUND.has("回" + nextChar)) return true;
  return false;
}

// FACT-GUARD-ENTITY-CHECKER-RULE-TEXT-1: 规则标签过滤
// 规则标签（如"规则一""规则二""第三条""第17条"）不是角色名，跟在言说动词前不应触发实体幻觉。
// 真相源：RECOVERY-3 ch2 raw "规则二说停电时保持不动" 被识别为 name="规则二" 触发误报。
// 注意：含数字的"第17条"由于正则 [\u4e00-\u9fff] 不匹配数字，不会进入 name，此处仅过滤纯汉字形式。
const RULE_LABEL_PATTERN = /^(?:规则|第)[一二三四五六七八九十百千万0-9]+[条章节]?$/;

function isRuleLabel(name: string): boolean {
  return RULE_LABEL_PATTERN.test(name);
}

const PRONOUN_NEGATION_ENTITY_PATTERN = /^(?:我|你|他|她|它|谁|我们|你们|他们|她们|它们)(?:没|不|未|别)$/;

function isPronounNegationPhrase(name: string): boolean {
  return PRONOUN_NEGATION_ENTITY_PATTERN.test(name);
}

function checkEntityHallucination(
  text: string,
  knownNames: string[]
): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const known = new Set<string>(knownNames);
  const namePattern = /([\u4e00-\u9fff]{2,4})(道|说|问|笑|怒|喊|叹|答|回|应)/g;
  const matches = text.matchAll(namePattern);

  // FACT-GUARD-ENTITY-CHECKER-RULE-TEXT-1: 排除 markdown > 引文块内的规则文本片段
  // 真相源：RECOVERY-3 ch2 raw 规则公告屏（> 引文块）内的"规则一：...""禁止返回入口"
  // 等被识别为角色名触发误报。引文块内的匹配整体跳过，不进入 nameInfo 统计。
  const quoteRanges = findMarkdownQuoteBlockLineRanges(splitLinesWithOffsets(text));

  // 统计每个候选名字的全文出现次数与首次位置
  const nameInfo = new Map<string, { count: number; firstPos: number }>();
  for (const m of matches) {
    const name = m[1];
    const attributionVerb = m[2];
    // FACT-GUARD-ENTITY-CHECKER-RULE-TEXT-1: 引文块内的匹配整体跳过
    if (isInsideMarkdownQuoteBlock(m.index ?? 0, quoteRanges)) continue;
    // “知道”通常是词汇动词；明确“苏知道：”式归因仍保留为角色候选。
    if (attributionVerb === "道" && name.endsWith("知")) {
      const subject = name.slice(0, -1);
      const nextCharacter = text[(m.index ?? 0) + m[0].length] ?? "";
      const explicitAttribution = nextCharacter === ":" || nextCharacter === "：";
      const pronounSubject = /^(?:我|你|他|她|它|我们|你们|他们|她们|它们|谁|大家|众人)$/.test(subject);
      if (pronounSubject || !explicitAttribution) continue;
    }
    // ENTITY-CHECKER-1: "道"作非言说复合词（如"溶洞通道""溶洞道路"）不触发实体幻觉。
    // 仅过滤"道"为名词性复合词成分的匹配；"道"后紧跟冒号/引号的真实归因保留。
    if (attributionVerb === "道" && isNonSpeechDaoCompound(text, m.index ?? 0, name.length)) continue;
    // FACT-GUARD-ENTITY-CHECKER-RULE-TEXT-1: "回"作非言说运动复合词（如"返回""回去""回来"）不触发实体幻觉。
    // 仅过滤"回"为运动复合词成分的匹配；"回"后紧跟冒号/引号的真实归因保留。
    if (attributionVerb === "回" && isNonSpeechHuiCompound(text, m.index ?? 0, name.length)) continue;
    const existing = nameInfo.get(name);
    if (existing) {
      existing.count += 1;
    } else {
      nameInfo.set(name, { count: 1, firstPos: m.index ?? 0 });
    }
  }

  const suspicious: Array<{ name: string; count: number; firstPos: number }> = [];
  for (const [name, info] of nameInfo) {
    if (ENTITY_COMMON_NOUN_ALLOWLIST.has(name)) continue;
    if (known.has(name)) continue;
    // "她没说/他不问"中的代词+否定词不是角色名。正则会把末尾的
    // 言说动词拆出后，将前缀误识别为 2-4 字实体，必须在计数前排除。
    if (isPronounNegationPhrase(name)) continue;
    // FACT-GUARD-ENTITY-CHECKER-RULE-TEXT-1: 规则标签（如"规则二""第三条"）不是角色名
    if (isRuleLabel(name)) continue;
    if (info.count < 3) continue;
    const isSubstringOfKnown = [...known].some(
      (k) => k.includes(name) || name.includes(k)
    );
    if (isSubstringOfKnown) continue;
    suspicious.push({ name, count: info.count, firstPos: info.firstPos });
  }

  let idx = 0;
  for (const s of suspicious) {
    // 定位首次出现位置构建 span
    const span: TextSpan = {
      start: s.firstPos,
      end: s.firstPos + s.name.length + 1,
      excerpt: text.slice(s.firstPos, s.firstPos + s.name.length + 1),
    };
    diags.push(
      makeDiagnostic(
        "entity_checker",
        idx++,
        "hard",
        "continuity",
        `疑似实体幻觉：角色 "${s.name}" 未在角色档案中（全文出现 ${s.count} 次）`,
        span
      )
    );
  }
  return diags;
}

// ============================================================================
// 4. scene_continuity — 线上角色实体化/空间跳转（带 span）
// ============================================================================

function checkSceneContinuity(
  text: string,
  context: CompiledContext
): Diagnostic[] {
  const diags: Diagnostic[] = [];

  // 空间跳转启发式
  const transitionPattern = /(忽然|突然|转眼|紧接着).{0,10}(到了|来到|回到|进入)/g;
  let m: RegExpExecArray | null;
  let transitionCount = 0;
  while ((m = transitionPattern.exec(text)) !== null) {
    transitionCount++;
    if (transitionCount <= 2) {
      diags.push(
        makeDiagnostic(
          "scene_continuity",
          diags.length,
          "review",
          "scene_continuity",
          `空间跳转无过门：${m[0]}`,
          { start: m.index, end: m.index + m[0].length, excerpt: m[0] }
        )
      );
    }
    if (m.index === transitionPattern.lastIndex) transitionPattern.lastIndex++;
  }

  // 匿名角色实体化
  const knownChars = new Set(context.characterStates.map((c) => c.name));
  const anonymousPattern = /(陌生人|路人甲|某人|黑衣人).{0,20}(说话|开口|道|说)/g;
  while ((m = anonymousPattern.exec(text)) !== null) {
    if (![...knownChars].some((c) => c.includes("陌生"))) {
      diags.push(
        makeDiagnostic(
          "scene_continuity",
          diags.length,
          "review",
          "scene_continuity",
          `匿名角色实体化：${m[0].slice(0, 30)}`,
          { start: m.index, end: m.index + m[0].length, excerpt: m[0] }
        )
      );
    }
    if (m.index === anonymousPattern.lastIndex) anonymousPattern.lastIndex++;
  }

  return diags;
}

// ============================================================================
// 5. skeleton_consistency — 严重连续性断裂（带 span）
// ============================================================================

function checkSkeletonConsistency(
  text: string,
  context: CompiledContext
): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const prevFact = context.facts.find((f) => f.id === "fact:prev_continuation");
  if (prevFact && prevFact.content.includes("未解张力")) {
    const tensionMatch = prevFact.content.match(/未解张力：([^；]+)/);
    if (tensionMatch) {
      const tension = tensionMatch[1].trim();
      if (tension && tension !== "无" && text.includes(tension) && text.includes("解决")) {
        const pos = text.indexOf(tension);
        diags.push(
          makeDiagnostic(
            "skeleton_consistency",
            0,
            "review",
            "continuity",
            `前章未解张力 "${tension}" 被无依据消解`,
            { start: pos, end: pos + tension.length, excerpt: tension }
          )
        );
      }
    }
  }
  return diags;
}

// ============================================================================
// 6. event_progression — 主干 progression 断裂（带 span）
// ============================================================================

function checkEventProgression(text: string): Diagnostic[] {
  const diags: Diagnostic[] = [];
  if (text.length <= 500) return diags;
  const changeVerbPattern = /[变改破建死伤灭裂断胜败逃离获]/g;
  const matches = text.match(changeVerbPattern) ?? [];
  if (matches.length < 3) {
    diags.push(
      makeDiagnostic(
        "event_progression",
        0,
        "review",
        "payoff",
        `主干 progression 疑似断裂：状态变化动词密度过低（${matches.length}/${text.length}）`,
        { start: 0, end: Math.min(text.length, 200), excerpt: text.slice(0, 60) }
      )
    );
  }
  return diags;
}

function checkConstraintManifest(text: string, manifest?: ConstraintManifest): Diagnostic[] {
  if (!manifest) return [];
  const diagnostics: Diagnostic[] = [];
  for (const item of manifest.items.filter((entry) => entry.priority === "P0")) {
    const contradictions: string[] = [];
    if (item.content.includes("仍然存在")) {
      contradictions.push(item.content.replace("仍然存在", "已经消失"));
      contradictions.push(item.content.replace("仍然存在", "不复存在"));
    } else if (item.content.includes("存在")) {
      contradictions.push(item.content.replace("存在", "不存在"));
    }
    const knowledgeMatch = item.content.match(/^(.+?)不知道(.+)$/);
    if (knowledgeMatch) {
      contradictions.push(`${knowledgeMatch[1]}知道${knowledgeMatch[2]}`);
      contradictions.push(`${knowledgeMatch[1]}早已知道${knowledgeMatch[2]}`);
    }
    for (const contradiction of contradictions) {
      const start = text.indexOf(contradiction);
      if (start < 0) continue;
      diagnostics.push(makeDiagnostic(
        "constraint_manifest",
        diagnostics.length,
        "hard",
        "continuity",
        `违反 ${item.id}：正文出现反向表述“${contradiction}”`,
        { start, end: start + contradiction.length, excerpt: contradiction },
      ));
    }
  }
  return diagnostics;
}

const CHINESE_DIGITS: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

function parseChineseNumber(value: string): number | null {
  if (/^\d+$/.test(value)) return Number(value);
  if (value === "十") return 10;
  if (value.includes("十")) {
    const [left, right] = value.split("十");
    const tens = left ? CHINESE_DIGITS[left] : 1;
    const ones = right ? CHINESE_DIGITS[right] : 0;
    return tens === undefined || ones === undefined ? null : tens * 10 + ones;
  }
  return CHINESE_DIGITS[value] ?? null;
}

function checkChapterIdentity(text: string, expectedChapterNumber?: number): Diagnostic[] {
  if (!expectedChapterNumber) return [];
  const heading = text.slice(0, 120).match(/第\s*([0-9零一二两三四五六七八九十百]+)\s*章/);
  if (!heading) return [];
  const actual = parseChineseNumber(heading[1]);
  if (actual === null || actual === expectedChapterNumber) return [];
  const start = heading.index ?? 0;
  return [makeDiagnostic(
    "chapter_identity",
    0,
    "hard",
    "continuity",
    `章节号不匹配：expected=${expectedChapterNumber}, actual=${actual}`,
    { start, end: start + heading[0].length, excerpt: heading[0] },
  )];
}

function checkDeceasedCharacters(text: string, context: CompiledContext): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const actionPattern = /(背|走|跑|说|喊|抬|拿|拽|挡|冲|看|递|抽|站|坐|问|答|笑|哭)/;
  const historicalReferencePattern = /(死的那天|去世|牺牲|生前|曾经|当年|过去|回忆|记忆|遗言|遗像|墓前|葬礼|说过|留下)/;
  const historicalLeadPattern = /(想起|记得|回忆起|回想起|怀念|梦见|梦到|说起|提起)(?:了)?[^。！？\n]{0,8}$/;
  for (const character of context.characterStates) {
    if (character.state?.role !== "deceased") continue;
    // Limit attribution to the same clause. Without comma/semicolon boundaries,
    // "某人死的那天，另一人没有哭" must not assign the later subject's action to the deceased character.
    const matcher = new RegExp(`${escapeRegExp(character.name)}[^。！？，,；;：:\\n]{0,16}${actionPattern.source}`, "g");
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(text)) !== null) {
      const prefix = text.slice(Math.max(0, match.index - 24), match.index);
      // FACTGUARD-SCANNER-FIX-1: 历史语境同时检测 match 和 prefix。
      // 原来只测 match[0]，"记忆中，铁山坐" 类回忆（"记忆"在前缀）会被漏判为在场行动。
      // 现在 prefix 含 记忆/曾经/当年/过去/回忆/生前 等回忆标记时也豁免。
      if (
        historicalReferencePattern.test(match[0]) ||
        historicalReferencePattern.test(prefix) ||
        historicalLeadPattern.test(prefix)
      ) continue;
      diagnostics.push(makeDiagnostic(
        "deceased_character",
        diagnostics.length,
        "hard",
        "continuity",
        `已死亡角色作为在场行动者：${match[0]}`,
        { start: match.index, end: match.index + match[0].length, excerpt: match[0] },
      ));
    }
  }
  return diagnostics;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ============================================================================
// CANON-IDENTITY-1: 身份矛盾检测
// ============================================================================

import type { IdentityContract, IdentityEntry } from "./identity-contract-compiler.js";

/** 角色 role -> 矛盾词映射（正文出现这些词时判定为身份矛盾） */
const IDENTITY_CONTRADICTIONS: Record<string, { pattern: RegExp; description: string }> = {
  "love-interest": { pattern: /宠物|宠物|尾巴|摇尾|喂了|肉干|乖巧|驯服|主人|项圈/, description: "恋慕对象被描述为宠物" },
  "monster": { pattern: /伙伴|同伴|友|盟|跟随|并肩|陪伴|驯服|收服|契约兽/, description: "敌对生物被描述为伙伴" },
  "antagonist-ally": { pattern: /伙伴|同伴|友|盟|跟随|并肩|陪伴|帮助|援助/, description: "敌方盟友被描述为友方伙伴" },
  "mentor": { pattern: /初见|陌生人|不认识|第一次见|素不相识/, description: "导师被描述为陌生人" },
};

/** family role 的关系矛盾检测（aliases 含父亲/爸时检查叔/伯等） */
const FAMILY_CONTRADICTIONS: { aliasPattern: RegExp; contradictionPattern: RegExp; description: string }[] = [
  { aliasPattern: /父亲|爸/, contradictionPattern: /叔|叔父|叔叔|伯|伯父/, description: "父亲被描述为叔伯" },
  { aliasPattern: /母亲|妈/, contradictionPattern: /婶|婶母|阿姨/, description: "母亲被描述为婶姨" },
];

/**
 * 历史/回忆语境标记。
 *
 * FACTGUARD-DOWNGRADE-1：身份矛盾检测保留 hard，但收紧触发条件——只有同分句、
 * 明确关系词、且无历史语境豁免时才 hard；处于历史/回忆语境的分句降为 review。
 * "梦魇曾经是主角的伙伴" 描述的是过去状态，不是当前设定矛盾，不应 hard block。
 * 与 checkDeceasedCharacters 的历史语境豁免同源（计划 §5.4：机械检查不压制 LLM）。
 */
const IDENTITY_HISTORICAL_CONTEXT = /曾经|当年|昔日|过去|从前|以前|回忆|想起|回想起|怀念|梦见|梦到|生前|传闻|据说|原本|本来|曾经是|原本是|一开始|最初|起初|原本只是/;

/**
 * 敌对实体的“伙伴/同伴”只有在正文直接建立身份关系时才构成硬矛盾。
 * “水怪在同伴被杀后逃跑”描述的是敌群内部关系，不能据此推断水怪成为主角伙伴。
 */
function hasDirectHostileCompanionRelation(clause: string, entry: IdentityEntry): boolean {
  const names = [entry.name, ...entry.aliases]
    .filter(Boolean)
    .map(escapeRegExp)
    .join("|");
  if (!names) return false;
  const entity = `(?:${names})`;
  const companion = "(?:伙伴|同伴|朋友|盟友|契约兽)";
  return new RegExp(`${entity}.{0,8}(?:是|成为|成了|作为|被视为|被当作).{0,10}${companion}`).test(clause)
    || new RegExp(`${companion}.{0,8}(?:是|包括|叫作|名为)?\\s*${entity}`).test(clause)
    || new RegExp(`${entity}.{0,8}(?:被)?(?:驯服|收服)|(?:驯服|收服).{0,8}${entity}`).test(clause);
}

function identityClauseBounds(text: string, position: number): { start: number; end: number } {
  const boundaryPattern = /[，。！？!?；;\n]/;
  let start = position;
  while (start > 0 && !boundaryPattern.test(text[start - 1])) start--;
  let end = position;
  while (end < text.length && !boundaryPattern.test(text[end])) end++;
  return { start, end };
}

function identityEvidenceSpan(
  text: string,
  occurrence: { position: number; length: number },
  relationPosition: number,
  relationLength: number,
): TextSpan {
  const start = Math.min(occurrence.position, relationPosition);
  const end = Math.max(
    occurrence.position + occurrence.length,
    relationPosition + relationLength,
  );
  return { start, end, excerpt: text.slice(start, end) };
}

function checkIdentityContradiction(
  text: string,
  contract: IdentityContract | null | undefined,
): Diagnostic[] {
  if (!contract) return [];
  const diags: Diagnostic[] = [];
  let idx = 0;

  for (const entry of contract.entries) {
    // 收集该角色的所有名称（name + aliases）
    const names = [entry.name, ...entry.aliases].filter(Boolean);
    if (names.length === 0) continue;

    // 在正文中查找角色名/别名出现的位置
    const occurrences: Array<{ position: number; length: number }> = [];
    for (const name of names) {
      const escaped = escapeRegExp(name);
      const regex = new RegExp(escaped, "g");
      let match;
      while ((match = regex.exec(text)) !== null) {
        occurrences.push({ position: match.index, length: match[0].length });
      }
    }
    if (occurrences.length === 0) continue;

    // 只在角色所在分句内归因矛盾关系，避免把邻近主体的关系词错绑到该角色。
    for (const occurrence of occurrences) {
      const clauseBounds = identityClauseBounds(text, occurrence.position);
      const clause = text.slice(clauseBounds.start, clauseBounds.end);

      // role 级矛盾
      const roleContradiction = IDENTITY_CONTRADICTIONS[entry.role];
      const roleMatch = roleContradiction?.pattern.exec(clause) ?? null;
      if (roleContradiction && roleMatch) {
        if ((entry.role === "monster" || entry.role === "antagonist-ally")
          && !hasDirectHostileCompanionRelation(clause, entry)) {
          continue;
        }
        const relationPosition = clauseBounds.start + roleMatch.index;
        // FACTGUARD-DOWNGRADE-1：历史/回忆语境降为 review（描述过去状态，非当前设定矛盾）
        const isHistorical = IDENTITY_HISTORICAL_CONTEXT.test(clause);
        diags.push(
          makeDiagnostic(
            "identity_contradiction",
            idx++,
            isHistorical ? "review" : "hard",
            "continuity",
            `身份矛盾：${entry.name}（role=${entry.role}, ${entry.stableIdentity}）正文出现矛盾描述：${roleContradiction.description}；命中关系词：“${roleMatch[0]}”`,
            identityEvidenceSpan(text, occurrence, relationPosition, roleMatch[0].length),
          ),
        );
        break; // 同一角色只报一次
      }

      // family 关系矛盾
      if (entry.role === "family") {
        const aliasStr = entry.aliases.join("/");
        for (const fc of FAMILY_CONTRADICTIONS) {
          const relationMatch = fc.contradictionPattern.exec(clause);
          if (fc.aliasPattern.test(aliasStr) && relationMatch) {
            const relationPosition = clauseBounds.start + relationMatch.index;
            // FACTGUARD-DOWNGRADE-1：历史/回忆语境降为 review
            const isHistorical = IDENTITY_HISTORICAL_CONTEXT.test(clause);
            diags.push(
              makeDiagnostic(
                "identity_contradiction",
                idx++,
                isHistorical ? "review" : "hard",
                "continuity",
                `身份矛盾：${entry.name}（${entry.stableIdentity}）正文出现矛盾描述：${fc.description}；命中关系词：“${relationMatch[0]}”`,
                identityEvidenceSpan(text, occurrence, relationPosition, relationMatch[0].length),
              ),
            );
            break;
          }
        }
      }
    }
  }

  return diags;
}

// ============================================================================
// WORLD-ONTOLOGY-1: 封闭世界本体违规检测
// ============================================================================

import type { OntologyContract } from "./ontology-contract-compiler.js";
import { collectAllRegisteredTerms } from "./ontology-contract-compiler.js";

/**
 * 检测正文中使用的境界术语是否在已注册的封闭世界本体内。
 * 只检测 境 后缀的 2-4 字术语（如"筑体境"、"锻骨境"）。
 * 未登记术语（如"筑体"、"铸骨"）产生 hard block。
 * 开放名词（如"心境"、"意境"）不会被检测（1 字前缀不匹配）。
 */
function checkOntologyViolation(
  text: string,
  contract: OntologyContract | null | undefined,
): Diagnostic[] {
  if (!contract) return [];
  const registeredTerms = collectAllRegisteredTerms(contract);
  if (registeredTerms.size === 0) return [];

  const diags: Diagnostic[] = [];
  let idx = 0;

  // Step 1: 标记所有已注册术语 + "境" 的位置（这些是合法的）
  const accountedJing = new Set<number>();
  for (const term of registeredTerms) {
    if (term.length < 2 || term.length > 4) continue;
    const searchStr = term + "境";
    let pos = text.indexOf(searchStr);
    while (pos >= 0) {
      accountedJing.add(pos + term.length);
      pos = text.indexOf(searchStr, pos + 1);
    }
  }

  // Category labels（如“炼魂境/炼体境”）属于已登记 taxonomy，
  // 但不加入 ordered terms，避免污染角色 level transition 推断。
  for (const entry of contract.entries) {
    const category = entry.category.trim();
    if (category.length < 2 || category.length > 4) continue;
    if (!/^[\u4e00-\u9fff]+$/.test(category)) continue;
    const searchStr = category + "境";
    let pos = text.indexOf(searchStr);
    while (pos >= 0) {
      accountedJing.add(pos + category.length);
      pos = text.indexOf(searchStr, pos + 1);
    }
  }

  // Step 2: 检查未标记的 "境"，如果前面 2 字不是已注册术语且不是常见非境界词，判定为未登记术语
  const PARTICLES = new Set("的了在是不有就都也还又才只已将会能可该应要想到从向被把让使给对为以与和或但而因所如这那其某每各种个些么样点入进出起下上回过到".split(""));
  const COMMON_JING_WORDS = new Set(["心境", "意境", "幻境", "化境", "处境", "环境", "边境", "情境", "绝境", "险境", "逆境", "顺境", "困境", "佳境", "老境", "晚境", "暮境", "生境", "越境", "出境", "入境", "过境", "交境", "接境", "临境", "近境", "远境", "胜境", "妙境", "空境", "无境", "忘境", "灵境", "梦境", "实境", "虚境", "真境", "假境"]);

  const seen = new Set<string>();
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "境") continue;
    if (accountedJing.has(i)) continue;

    // 取 "境" 前 2 字
    if (i < 2) continue;
    const term = text.slice(i - 2, i);

    // 先按真实词尾判断普通“X境”，避免把“九死险境”截成“死险境”。
    const commonJingWord = text.slice(i - 1, i + 1);
    if (COMMON_JING_WORDS.has(commonJingWord)) continue;
    // 跳过含常用虚词/助词的 2 字组合
    if (PARTICLES.has(term[0]) || PARTICLES.has(term[1])) continue;
    // 跳过含非中文字符的 2 字组合（标点、数字等）
    if (!/[\u4e00-\u9fff]/.test(term[0]) || !/[\u4e00-\u9fff]/.test(term[1])) continue;

    if (!seen.has(term)) {
      seen.add(term);
      diags.push(
        makeDiagnostic(
          "ontology_violation",
          idx++,
          "review",
          "continuity",
          `未登记术语：正文使用"${term}境"，但"${term}"不在已注册的封闭世界本体中（已注册：${[...registeredTerms].slice(0, 10).join("、")}等）`,
          { start: i - 2, end: i + 1, excerpt: text.slice(i - 2, i + 1) },
        ),
      );
    }
  }

  return diags;
}

interface CurrentOntologyState {
  characterName: string;
  category: string;
  term: string;
  sourceIds: string[];
}

function collectStateStrings(value: unknown, depth = 0): string[] {
  if (typeof value === "string") return [value];
  if (depth >= 3 || value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectStateStrings(item, depth + 1));
  }
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>)
      .flatMap((item) => collectStateStrings(item, depth + 1));
  }
  return [];
}

function collectCurrentOntologyStates(
  context: CompiledContext,
  contract: OntologyContract,
): CurrentOntologyState[] {
  const states: CurrentOntologyState[] = [];
  for (const character of context.characterStates) {
    const stateStrings = collectStateStrings(character.state);
    for (const entry of contract.entries) {
      const term = entry.terms.find((candidate) =>
        stateStrings.some((value) => value.includes(candidate))
      );
      if (!term) continue;
      states.push({
        characterName: character.name,
        category: entry.category,
        term,
        sourceIds: character.sourceIds,
      });
    }
  }
  return states;
}

function sentenceBounds(text: string, position: number): { start: number; end: number } {
  const boundaryPattern = /[。！？!?\n]/;
  let start = position;
  while (start > 0 && !boundaryPattern.test(text[start - 1])) start--;
  let end = position;
  while (end < text.length && !boundaryPattern.test(text[end])) end++;
  return { start, end };
}

/**
 * 已有角色境界由 state sourceRef 提供时，正文若把该角色声明为另一登记境界，
 * 必须在同一句中给出明确升级事件。历史回忆语境不视为当前状态变化。
 */
function checkOntologyTransitions(
  text: string,
  context: CompiledContext,
  contract: OntologyContract | null | undefined,
): Diagnostic[] {
  if (!contract?.available) return [];
  const currentStates = collectCurrentOntologyStates(context, contract);
  if (currentStates.length === 0) return [];

  const upgradePattern = /突破|晋升|踏入|迈入|冲破|破境|进阶|跨入|升至|升入|修至/;
  const historicalPattern = /曾经|当年|昔日|过去|回忆|想起|生前|传闻|据说/;
  const diagnostics: Diagnostic[] = [];
  const seen = new Set<string>();

  for (const state of currentStates) {
    const entry = contract.entries.find((candidate) => candidate.category === state.category);
    if (!entry) continue;
    for (const targetTerm of entry.terms) {
      if (targetTerm === state.term) continue;
      const targetText = `${targetTerm}境`;
      let position = text.indexOf(targetText);
      while (position >= 0) {
        const bounds = sentenceBounds(text, position);
        const sentence = text.slice(bounds.start, bounds.end);
        const relativeTarget = position - bounds.start;
        const precedingStates = currentStates
          .map((candidate) => ({
            candidate,
            position: sentence.lastIndexOf(candidate.characterName, relativeTarget),
          }))
          .filter((item) => item.position >= 0 && relativeTarget - item.position <= 40)
          .sort((a, b) => b.position - a.position);
        const attributedCharacter = precedingStates[0]?.candidate.characterName;
        const belongsToCharacter = attributedCharacter === state.characterName;
        const hasUpgradeEvidence = upgradePattern.test(sentence);
        const isHistorical = historicalPattern.test(sentence);

        if (belongsToCharacter && !hasUpgradeEvidence && !isHistorical) {
          const key = `${state.characterName}|${state.category}|${targetTerm}|${position}`;
          if (!seen.has(key)) {
            seen.add(key);
            diagnostics.push(
              makeDiagnostic(
                "ontology_transition",
                diagnostics.length,
                "review",
                "continuity",
                `${state.characterName} 的既有${state.category}境界为“${state.term}”（来源：${state.sourceIds.join("、") || "缺少 sourceRef"}），正文无同章升级事件却声明为“${targetTerm}境”`,
                { start: position, end: position + targetText.length, excerpt: targetText },
              ),
            );
          }
        }
        position = text.indexOf(targetText, position + targetText.length);
      }
    }
  }

  return diagnostics;
}

// ============================================================================
// FactContinuityGuard - 聚合
// ============================================================================

export class FactContinuityGuard {
  /**
   * 执行全部 6 类硬阻断检查，所有诊断带 span。
   *
   * @param input.text 候选正文
   * @param input.context 编译后的上下文
   * @param input.knownCharacterNames 已知角色名（含 aliases）
   */
  check(input: FactContinuityInput): FactContinuityReport {
    const { text, context, knownCharacterNames } = input;
    // CANON-IDENTITY-1: 从 identityContract 展开别名到 knownNames
    const contractNames = input.identityContract
      ? input.identityContract.entries.flatMap((e) => [e.name, ...e.aliases])
      : [];
    const knownNames = [...new Set([...(knownCharacterNames ?? []), ...contractNames, ...context.characterStates.map((c) => c.name)])];

    // FACT-GUARD-QUOTE-EXEMPTION-1: checkDuplicates 返回 { diagnostics, exemptions }
    const dupResult = checkDuplicates(text);

    const allDiagnostics: Diagnostic[] = [
      ...checkFormat(text),
      ...dupResult.diagnostics,
      ...checkSceneContinuity(text, context),
      ...checkEntityHallucination(text, knownNames),
      ...checkSkeletonConsistency(text, context),
      ...checkEventProgression(text),
      ...checkConstraintManifest(text, input.constraintManifest),
      ...checkChapterIdentity(text, input.expectedChapterNumber),
      ...checkDeceasedCharacters(text, context),
      ...checkIdentityContradiction(text, input.identityContract),
      ...checkOntologyViolation(text, input.ontologyContract),
      ...checkOntologyTransitions(text, context, input.ontologyContract),
    ];

    const hardBlocks = allDiagnostics.filter(
      (d) => d.severity === "fatal" || d.severity === "hard"
    );

    return {
      hardBlocks,
      allDiagnostics,
      hasHardBlock: hardBlocks.length > 0,
      constraintManifestHash: input.constraintManifest?.manifestHash,
      ontologyContractId: input.ontologyContract?.contractId,
      ontologyContractHash: input.ontologyContract?.contractHash,
      quoteExemptions: dupResult.exemptions,
    };
  }
}

export function createFactContinuityGuard(): FactContinuityGuard {
  return new FactContinuityGuard();
}
