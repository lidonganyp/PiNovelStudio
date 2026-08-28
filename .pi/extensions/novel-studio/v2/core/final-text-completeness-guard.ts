/**
 * FinalTextCompletenessGuard (TEXT-INTEGRITY-1)
 *
 * 只阻断确定性的模型/传输截断；开放式钩子和普通缺标点仅进入 review。
 *
 * 阻断条件（hard / status=blocked）：
 * - 显式截断标记：[内容截断], [截断], [truncated] 等
 * - 悬空尾句：最后一句以连词开头且过短（如"和他自己", "因为"）
 * - 短词干残片：已有完整句边界后又残留 1-4 个纯汉字且无终止标点
 *
 * 审阅条件（review / passed=true）：
 * - 缺少句末标点但语义完整（如"看见远处的灯火一盏接一盏亮起来"）
 *
 * 通过条件（pass / passed=true / findings=[]）：
 * - 以 。！？…"' 等句末标点结尾
 */

export interface CompletenessFinding {
  code: string;
  severity: "hard" | "review";
  span?: { start: number; end: number };
  reason: string;
}

export interface CompletenessReport {
  status: "pass" | "review" | "blocked";
  passed: boolean;
  findings: CompletenessFinding[];
}

export interface CompletenessOptions {
  finishReason?: string | null;
  chapterNumber?: number;
  /** Production chapter floor; omitted for legacy/evaluation callers. */
  minWordCount?: number;
}

/** 句末标点（含中文省略号、引号闭合） */
const TERMINAL_PUNCT = /[。！？…\u2026"'」』）】]/;

/** 显式截断标记 */
const TRUNCATION_MARKERS = [
  "[内容截断]",
  "[截断]",
  "[truncated]",
  "[TRUNCATED]",
  "[内容被截断]",
  "...[截断]",
];

const EXPLICIT_CLOSURE_MARKER = /(?:\*\*)?第\s*(\d+)\s*章\s*完(?:\*\*)?/gu;

/** 连词/连接词（出现在句首且句过短时判定为悬空尾句） */
const DANGLING_CONJUNCTIONS = [
  "和他自己", "和她自己", "和它自己",  // RQ4F 实际案例
  "因为", "但是", "然后", "所以", "而且", "并且", "虽然", "如果", "于是",
  "而", "但", "且", "和", "与", "或", "及", "乃",
];

/**
 * 扫描最终正文的完整性。
 * 纯本地检测，不调用 LLM。
 */
export function scanFinalTextCompleteness(
  text: string,
  options?: CompletenessOptions,
): CompletenessReport {
  const trimmed = text.trimEnd();
  if (trimmed.length === 0) {
    return {
      status: "blocked",
      passed: false,
      findings: [{ code: "empty_text", severity: "hard", reason: "最终正文为空" }],
    };
  }

  const minWordCount = options?.minWordCount;

  const finishReason = options?.finishReason?.trim().toLowerCase();
  if (
    finishReason === "length" ||
    finishReason === "max_tokens" ||
    finishReason === "max_tokens_reached"
  ) {
    return {
      status: "blocked",
      passed: false,
      findings: [{
        code: "model_length_completion",
        severity: "hard",
        reason: `模型以完成原因 ${options?.finishReason} 结束，正文可能在输出预算处被截断`,
      }],
    };
  }

  // 1. 显式截断标记
  for (const marker of TRUNCATION_MARKERS) {
    const idx = trimmed.lastIndexOf(marker);
    if (idx >= 0) {
      return {
        status: "blocked",
        passed: false,
        findings: [{
          code: "truncation_marker",
          severity: "hard",
          span: { start: idx, end: idx + marker.length },
          reason: `显式截断标记：${marker}`,
        }],
      };
    }
  }

  const closureMatches = [...trimmed.matchAll(EXPLICIT_CLOSURE_MARKER)];
  if (closureMatches.length > 0) {
    const marker = closureMatches[closureMatches.length - 1];
    const markerText = marker[0];
    const markerStart = marker.index ?? -1;
    const isStandaloneLine = markerStart === 0 || /[\r\n]/.test(trimmed[markerStart - 1]);
    const isTerminalMarker = markerStart >= 0 && trimmed.slice(markerStart).trim() === markerText;
    if (closureMatches.length !== 1 || !isStandaloneLine || !isTerminalMarker) {
      // COMPLETENESS-GUARD-LOOSEN-1：finishReason=stop（模型确认完整输出）时降为 review。
      // 标记后残留正文是格式问题，非截断（截断已由 model_length_completion / truncation_marker
      // 在上游拦截）。fuben ch1 曾因 finishReason=stop 时此检查 hard-block 完整章节。
      // finishReason 未知时保守 hard（无法确认完整）。
      const stopConfirmed = finishReason === "stop";
      return {
        status: stopConfirmed ? "review" : "blocked",
        passed: stopConfirmed,
        findings: [{
          code: "malformed_closure_marker",
          severity: stopConfirmed ? "review" : "hard",
          span: markerStart >= 0
            ? { start: markerStart, end: markerStart + markerText.length }
            : undefined,
          reason: stopConfirmed
            ? "显式章节闭合标记后仍有正文（finishReason=stop，降为 review，建议人工复核标记位置）"
            : "显式章节闭合标记必须独占正文末尾，标记后不得残留正文",
        }],
      };
    }

    const markerChapter = Number(marker[1]);
    if (options?.chapterNumber !== undefined && markerChapter !== options.chapterNumber) {
      return {
        status: "blocked",
        passed: false,
        findings: [{
          code: "closure_marker_chapter_mismatch",
          severity: "hard",
          span: { start: markerStart, end: markerStart + markerText.length },
          reason: `闭合标记章号 ${markerChapter} 与当前章节 ${options.chapterNumber} 不一致`,
        }],
      };
    }

    const contentBeforeMarker = trimmed
      .slice(0, markerStart)
      .replace(/\s*---\s*$/u, "")
      .trimEnd();
    const contentReport = scanFinalTextCompleteness(contentBeforeMarker);
    if (contentReport.status !== "pass") {
      return {
        status: "blocked",
        passed: false,
        findings: [{
          code: "closure_marker_preceded_by_incomplete_text",
          severity: "hard",
          reason: contentReport.findings[0]?.reason ?? "闭合标记前正文不完整",
        }],
      };
    }

    return { status: "pass", passed: true, findings: [] };
  }

  // 2. 悬空尾句：取最后一个句末标点后的文本
  let lastBoundary = -1;
  for (let i = trimmed.length - 1; i >= 0; i--) {
    if (/[。！？\n\r]/.test(trimmed[i])) {
      lastBoundary = i;
      break;
    }
  }
  const tail = trimmed.slice(lastBoundary + 1).trim();

  if (tail.length > 0 && tail.length <= 15) {
    for (const conj of DANGLING_CONJUNCTIONS) {
      // 检查 tail 以连词开头（如"和他自己"）或以连词结尾（如"因为"）
      if (tail.startsWith(conj) || tail.endsWith(conj)) {
        const start = lastBoundary + 1 + trimmed.slice(lastBoundary + 1).indexOf(conj);
        return {
          status: "blocked",
          passed: false,
          findings: [{
            code: "dangling_tail",
            severity: "hard",
            span: { start, end: start + tail.length },
            reason: `悬空尾句：正文以连词"${conj}"开头的碎片"${tail}"结尾，疑似模型/传输截断`,
          }],
        };
      }
    }
  }

  // 3. 短词干残片：正文已有完整句边界，末尾又残留 1-4 个纯汉字。
  // 这类片段通常来自模型/传输在复合词中间截断；长句缺标点仍保留 review。
  if (
    lastBoundary >= 0 &&
    tail.length >= 1 &&
    tail.length <= 4 &&
    /^[\u4e00-\u9fff]+$/u.test(tail)
  ) {
    const start = trimmed.length - tail.length;
    return {
      status: "blocked",
      passed: false,
      findings: [{
        code: "incomplete_tail_fragment",
        severity: "hard",
        span: { start, end: trimmed.length },
        reason: `正文在完整句后残留短中文词干"${tail}"且无终止标点，疑似模型/传输截断`,
      }],
    };
  }

  // 4. 缺少句末标点（review，不阻断）
  if (Number.isSafeInteger(minWordCount) && (minWordCount as number) > 0) {
    const wordCount = trimmed.replace(/\s+/gu, '').length;
    if (wordCount < (minWordCount as number)) {
      return {
        status: 'blocked',
        passed: false,
        findings: [{
          code: 'minimum_word_count',
          severity: 'hard',
          reason: `chapter text has ${wordCount} characters; minimum is ${minWordCount}`,
        }],
      };
    }
  }

  const lastChar = trimmed[trimmed.length - 1];
  if (!TERMINAL_PUNCT.test(lastChar)) {
    return {
      status: "review",
      passed: true,
      findings: [{
        code: "missing_terminal_punctuation",
        severity: "review",
        reason: "正文末尾缺少句末标点（。！？…），语义完整性不确定，建议人工审阅",
      }],
    };
  }

  // 5. 通过
  return { status: "pass", passed: true, findings: [] };
}
