/**
 * 上下文 token 预算：中文按字近似 1 token，ASCII 按 4 字符 1 token。
 */
import {
  DEFAULT_BLOCK_TOKEN_BUDGETS,
  DEFAULT_TOTAL_TOKEN_BUDGET,
  type ContextBudgetProfileName,
  type ContextBlockName,
} from './types';

export interface ContextBudgetProfile {
  name: ContextBudgetProfileName;
  modelWindowTokens: number;
  outputReserveTokens: number;
  totalTokenBudget: number;
  blockBudgets: Record<ContextBlockName, number>;
}

const PROFILE_TOTALS: Record<ContextBudgetProfileName, number> = {
  '16k': DEFAULT_TOTAL_TOKEN_BUDGET,
  '128k': 128_000,
  '256k': 256_000,
  '512k': 512_000,
};

const PROFILE_WINDOWS: Record<ContextBudgetProfileName, number> = {
  '16k': 16_000,
  '128k': 128_000,
  '256k': 256_000,
  '512k': 512_000,
};

const PROFILE_OUTPUT_RESERVES: Record<ContextBudgetProfileName, number> = {
  '16k': 0,
  '128k': 16_384,
  '256k': 16_384,
  '512k': 16_384,
};

const LARGE_PROFILE_BLOCK_BUDGETS: Record<ContextBlockName, number> = {
  creativeConstitution: 8_000,
  worldbuilding: 12_000,
  storyOutline: 16_000,
  chapterCatalog: 10_000,
  supportingMaterials: 8_000,
  currentChapterOutline: 4_000,
  chapterSeed: 3_000,
  characterStates: 12_000,
  canonState: 8_000,
  promiseLedger: 6_000,
  patternMemory: 3_000,
  previousChapterContinuation: 3_000,
  styleProfile: 6_000,
  recentChapterContent: 12_000,
  selectedEvidenceSpans: 12_000,
};

const PROFILE_CACHE = new Map<ContextBudgetProfileName, ContextBudgetProfile>();

export function normalizeContextProfile(value: unknown): ContextBudgetProfileName {
  const candidate = String(value ?? '').trim().toLowerCase().replace(/\s+/g, '');
  if (candidate === '128000' || candidate === '128k') return '128k';
  if (candidate === '256000' || candidate === '256k') return '256k';
  if (candidate === '512000' || candidate === '512k' || candidate === '1m') return '512k';
  return '16k';
}

export function getContextBudgetProfile(value?: unknown): ContextBudgetProfile {
  const name = normalizeContextProfile(value);
  const cached = PROFILE_CACHE.get(name);
  if (cached) return cached;
  const profile: ContextBudgetProfile = {
    name,
    modelWindowTokens: PROFILE_WINDOWS[name],
    outputReserveTokens: PROFILE_OUTPUT_RESERVES[name],
    totalTokenBudget: PROFILE_TOTALS[name],
    blockBudgets: name === '16k'
      ? { ...DEFAULT_BLOCK_TOKEN_BUDGETS }
      : { ...LARGE_PROFILE_BLOCK_BUDGETS },
  };
  PROFILE_CACHE.set(name, profile);
  return profile;
}

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

export function blockBudget(name: ContextBlockName, profile?: unknown): number {
  return getContextBudgetProfile(profile).blockBudgets[name];
}

export function totalBudget(profile?: unknown): number {
  return getContextBudgetProfile(profile).totalTokenBudget;
}
