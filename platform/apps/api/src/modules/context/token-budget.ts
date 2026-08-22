/**
 * 上下文 token 预算：中文按字近似 1 token，ASCII 按 4 字符 1 token。
 */
import {
  DEFAULT_BLOCK_TOKEN_BUDGETS,
  DEFAULT_TOTAL_TOKEN_BUDGET,
  type ContextBlockName,
} from './types';

export function estimateTokens(text: string): number {
  if (!text) return 0;
  let tokens = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    tokens += code > 0x2e80 ? 1 : 0.25;
  }
  return Math.ceil(tokens);
}

export function clipToTokenBudget(text: string, budget: number): {
  text: string;
  tokens: number;
  truncated: boolean;
} {
  if (budget <= 0) return { text: '', tokens: 0, truncated: Boolean(text) };
  const tokens = estimateTokens(text);
  if (tokens <= budget) return { text, tokens, truncated: false };
  let used = 0;
  let end = 0;
  for (const char of text) {
    const next = used + ((char.codePointAt(0) ?? 0) > 0x2e80 ? 1 : 0.25);
    if (next > budget) break;
    used = next;
    end += char.length;
  }
  return { text: `${text.slice(0, Math.max(0, end - 1))}…`, tokens: budget, truncated: true };
}

export function blockBudget(name: ContextBlockName): number {
  return DEFAULT_BLOCK_TOKEN_BUDGETS[name];
}

export function totalBudget(): number {
  return DEFAULT_TOTAL_TOKEN_BUDGET;
}
