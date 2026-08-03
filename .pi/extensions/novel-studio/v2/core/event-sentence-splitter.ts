/**
 * EventSentenceSplitter — 句子与子句切分（从 event-extractor.ts 抽取，simplicity-gate 拆分）
 *
 * 纯函数模块：按句末标点切分文本为句子，再按子句标点/连接词把句子拆为子句。
 * 每个子句带相对原文的字符 span，供下游事件抽取与因果链匹配使用。
 *
 * 依赖：仅依赖 event-extractor-vocabulary.ts 的标点与连接词常量。
 * 不含状态，所有函数纯确定性。
 *
 * 来源：event-extractor.ts P0-1（支持一句多事件）的逻辑。
 */

import {
  CLAUSE_PUNCT,
  SUBCLAUSE_CONJUNCTIONS,
} from "./event-extractor-vocabulary.js";

// ============================================================================
// 类型定义
// ============================================================================

/** 句子 span（含相对原文的起止偏移） */
export interface SentenceSpan {
  sentence: string;
  start: number;
  end: number;
}

/**
 * 子句 span（P0-1：支持一句多事件抽取）。
 * start/end 为相对原文的偏移（已加上 sentenceStart）。
 */
export interface SubClauseSpan {
  clause: string;
  start: number;
  end: number;
}

// ============================================================================
// 句子切分
// ============================================================================

/**
 * 按句末标点切分文本，保留每个句子的 span。
 */
export function splitSentences(text: string): SentenceSpan[] {
  const result: SentenceSpan[] = [];
  const regex = /[^。！？!?]+[。！？!?]?/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    const raw = m[0];
    const sentence = raw.trim();
    if (sentence.length > 0) {
      result.push({
        sentence,
        start: m.index,
        end: m.index + raw.length,
      });
    }
  }
  return result;
}

// ============================================================================
// 子句切分
// ============================================================================

/**
 * 将一个句子拆分为多个子句（P0-1：支持一句多事件抽取）。
 *
 * 拆分规则：
 * 1. 按子句标点（，；）拆分
 * 2. 按子句连接词（并/且/然后/于是...）拆分，连接词归到后一子句
 * 3. 长度 < 2 的子句丢弃
 *
 * 例如："他交出玉玺并放行" → ["他交出玉玺", "并放行"] → 去连接词 → ["他交出玉玺", "放行"]
 *
 * @param sentence 句子文本
 * @param sentenceStart 句子在原文中的起始偏移
 */
export function splitSubClauses(
  sentence: string,
  sentenceStart: number,
): SubClauseSpan[] {
  // 先按标点切分
  const punctSplit: SubClauseSpan[] = [];
  let cursor = 0;
  for (let i = 0; i < sentence.length; i++) {
    const ch = sentence[i]!;
    if (CLAUSE_PUNCT.includes(ch)) {
      const clause = sentence.slice(cursor, i);
      if (clause.trim().length >= 2) {
        punctSplit.push({
          clause: clause.trim(),
          start: sentenceStart + cursor,
          end: sentenceStart + i,
        });
      }
      cursor = i + 1;
    }
  }
  // 末尾子句
  const tail = sentence.slice(cursor);
  if (tail.trim().length >= 2) {
    punctSplit.push({
      clause: tail.trim(),
      start: sentenceStart + cursor,
      end: sentenceStart + sentence.length,
    });
  }

  // 若标点切分只产生 1 个子句，尝试按连接词切分
  if (punctSplit.length <= 1) {
    const conjSplit: SubClauseSpan[] = [];
    for (const sub of punctSplit.length === 1 ? punctSplit : [{
      clause: sentence.trim(),
      start: sentenceStart,
      end: sentenceStart + sentence.length,
    }]) {
      // 找句中第一个子句连接词（不在句首的）
      let splitIdx = -1;
      let conjLen = 0;
      for (const conj of SUBCLAUSE_CONJUNCTIONS) {
        // 从第 2 个字符开始查找，避免句首连接词
        const idx = sub.clause.indexOf(conj, 1);
        if (idx > 0 && (splitIdx === -1 || idx < splitIdx)) {
          splitIdx = idx;
          conjLen = conj.length;
        }
      }
      if (splitIdx > 0) {
        const beforeClause = sub.clause.slice(0, splitIdx).trim();
        // 连接词归到后一子句，但去掉连接词本身
        const afterClause = sub.clause.slice(splitIdx + conjLen).trim();
        if (beforeClause.length >= 2) {
          conjSplit.push({
            clause: beforeClause,
            start: sub.start,
            end: sub.start + splitIdx,
          });
        }
        if (afterClause.length >= 2) {
          conjSplit.push({
            clause: afterClause,
            start: sub.start + splitIdx + conjLen,
            end: sub.end,
          });
        }
        // 若 afterClause 还含连接词，递归切分（最多再切一次，避免过度拆分）
        if (afterClause.length >= 2) {
          let innerSplitIdx = -1;
          let innerConjLen = 0;
          for (const conj of SUBCLAUSE_CONJUNCTIONS) {
            const idx = afterClause.indexOf(conj, 1);
            if (idx > 0 && (innerSplitIdx === -1 || idx < innerSplitIdx)) {
              innerSplitIdx = idx;
              innerConjLen = conj.length;
            }
          }
          // 已经切出的子句不再二次切分，避免过度拆分
          void innerSplitIdx;
          void innerConjLen;
        }
      } else {
        conjSplit.push(sub);
      }
    }
    return conjSplit.length > 0 ? conjSplit : punctSplit;
  }

  return punctSplit;
}
