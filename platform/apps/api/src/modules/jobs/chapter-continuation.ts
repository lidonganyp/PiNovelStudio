/** Pure helpers for preserving an existing chapter during continuation generation. */

export type ContinuationMode = 'replace' | 'append';

/**
 * Merge a model result into an existing chapter without discarding the
 * user-authored prefix. Models may return either a complete chapter or only
 * the newly written suffix, so both forms are accepted.
 */
export function mergeChapterContinuation(existing: string, generated: string): string {
  const prefix = existing.replace(/^\uFEFF/u, '').trimEnd();
  const result = generated.replace(/^\uFEFF/u, '').trim();
  if (!prefix) return result;
  if (!result) return prefix;

  const normalizedPrefix = prefix.trim();
  if (result === normalizedPrefix || result.startsWith(`${normalizedPrefix}\n`)) {
    return result;
  }
  const embeddedPrefix = result.indexOf(normalizedPrefix);
  if (embeddedPrefix >= 0 && embeddedPrefix < 80) {
    return result.slice(embeddedPrefix).trim();
  }
  return `${prefix}\n\n${result}`;
}

/**
 * Infer an explicit append/replace intent from the user's natural-language
 * message. Returns undefined when the message carries no explicit signal, so
 * the caller can fall back to chapter state (a chapter that already has prose
 * defaults to append instead of being silently rewritten from scratch).
 * Append signals win over replace signals ("不要重写" must stay append).
 */
export function inferContinuationMode(content: string): ContinuationMode | undefined {
  const text = content.trim();
  if (!text) return undefined;
  const appendSignals = [
    '\u63a5\u7740',
    '\u7eed\u5199',
    '\u7ee7\u7eed\u5199',
    '\u8865\u5199',
    '\u8865\u6ee1',
    '\u4ece[^\u3002\uFF01\uFF1F\uFF1B]{0,30}\u5f00\u59cb',
    '\u4e0d\u8981\\s*[\u8986\u76d6\u91cd\u5199]',
    '\u4fdd\u7559[^\u3002\uFF01\uFF1F\uFF1B]{0,20}\u5df2\u6709',
  ];
  if (appendSignals.some((signal) => new RegExp(signal, 'u').test(text))) {
    return 'append';
  }
  const replaceSignals = [
    '\u91cd\u5199', // 重写
    '\u6539\u5199', // 改写
    '\u8986\u76d6', // 覆盖
    '\u63a8\u5012\u91cd\u6765', // 推倒重来
    '\u63a8\u7ffb\u91cd\u6765', // 推翻重来
    '\u91cd\u65b0\u751f\u6210', // 重新生成
    '\u91cd\u65b0\u5199', // 重新写
    '\u4ece\u5934\u5199', // 从头写
    '\u4ece\u5934\u5f00\u59cb', // 从头开始
  ];
  if (replaceSignals.some((signal) => text.includes(signal))) {
    return 'replace';
  }
  return undefined;
}
