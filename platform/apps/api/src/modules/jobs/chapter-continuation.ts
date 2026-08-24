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

/** Infer an explicit append request from the user's natural-language message. */
export function inferContinuationMode(content: string): ContinuationMode {
  const text = content.trim();
  if (!text) return 'replace';
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
  return appendSignals.some((signal) => new RegExp(signal, 'u').test(text)) ? 'append' : 'replace';
}
