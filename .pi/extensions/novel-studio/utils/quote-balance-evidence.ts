/**
 * Quote balance evidence shared by the V2 FactGuard and legacy diagnostics adapter.
 * The hard-gate decision remains limited to odd ASCII single/double quote counts;
 * other quote families are recorded for diagnosis but never silently ignored.
 */

import { createHash } from "node:crypto";

export interface QuoteBalanceEvidence {
  asciiSingle: number;
  asciiDouble: number;
  curlyOpen: number;
  curlyClose: number;
  cornerOpen: number;
  cornerClose: number;
  unmatchedFamily: string | null;
  unmatchedStart: number | null;
  unmatchedEnd: number | null;
  excerptHash: string | null;
  summary: string;
}

function lastUnmatchedAsciiQuote(text: string, quote: "'" | '"'): number | null {
  let open = false;
  let lastUnmatched: number | null = null;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== quote) continue;
    open = !open;
    lastUnmatched = open ? index : null;
  }
  return open ? lastUnmatched : null;
}

export function analyzeQuoteBalance(text: string): QuoteBalanceEvidence {
  const asciiSingle = [...text].filter((char) => char === "'").length;
  const asciiDouble = [...text].filter((char) => char === '"').length;
  const curlyOpen = [...text].filter((char) => char === "“").length;
  const curlyClose = [...text].filter((char) => char === "”").length;
  const cornerOpen = [...text].filter((char) => char === "「").length;
  const cornerClose = [...text].filter((char) => char === "」").length;

  const singleIndex = asciiSingle % 2 === 1 ? lastUnmatchedAsciiQuote(text, "'") : null;
  const doubleIndex = asciiDouble % 2 === 1 ? lastUnmatchedAsciiQuote(text, '"') : null;
  const unmatchedStart = Math.max(singleIndex ?? -1, doubleIndex ?? -1);
  const unmatchedFamily =
    singleIndex !== null && singleIndex === unmatchedStart && doubleIndex !== null
      ? "asciiSingle+asciiDouble"
      : singleIndex !== null && singleIndex === unmatchedStart
        ? "asciiSingle"
        : doubleIndex !== null
          ? "asciiDouble"
          : null;
  const hasUnmatched = unmatchedStart >= 0;
  const excerpt = hasUnmatched
    ? text.slice(Math.max(0, unmatchedStart - 20), Math.min(text.length, unmatchedStart + 21))
    : "";
  const excerptHash = hasUnmatched
    ? createHash("sha256").update(excerpt, "utf8").digest("hex")
    : null;
  const summary =
    `quoteFamilies: asciiSingle=${asciiSingle}, asciiDouble=${asciiDouble}, ` +
    `curlyOpen=${curlyOpen}, curlyClose=${curlyClose}, cornerOpen=${cornerOpen}, cornerClose=${cornerClose}` +
    (hasUnmatched
      ? `; unmatchedFamily=${unmatchedFamily}; unmatchedSpan=${unmatchedStart}-${unmatchedStart + 1}; excerptHash=${excerptHash}`
      : "; unmatchedFamily=null");

  return {
    asciiSingle,
    asciiDouble,
    curlyOpen,
    curlyClose,
    cornerOpen,
    cornerClose,
    unmatchedFamily,
    unmatchedStart: hasUnmatched ? unmatchedStart : null,
    unmatchedEnd: hasUnmatched ? unmatchedStart + 1 : null,
    excerptHash,
    summary,
  };
}
