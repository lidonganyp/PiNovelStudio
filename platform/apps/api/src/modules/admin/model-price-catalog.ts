/**
 * 公开模型价目：硅基流动（CNY / 百万 token）优先，OpenRouter（USD / token）兜底。
 * 查不到时由调用方提示管理员手动填写。
 */
export const SILICONFLOW_PRICING_URL = 'https://www.siliconflow.cn/pricing';
export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
export const DEFAULT_USD_CNY_RATE = 7.2;
const FETCH_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 30 * 60 * 1000;

export type PriceCatalogSource = 'siliconflow' | 'openrouter';

export interface CatalogPriceEntry {
  id: string;
  name?: string;
  source: PriceCatalogSource;
  /** 公开输入价，元 / 百万 token（已换算为人民币）。 */
  inputYuanPerMillion: number;
  /** 公开输出价，元 / 百万 token（已换算为人民币）。 */
  outputYuanPerMillion: number;
  nativeCurrency: 'CNY' | 'USD';
}

export interface PriceLookupMatch {
  found: true;
  query: string;
  matchedId: string;
  displayName: string;
  source: PriceCatalogSource;
  nativeCurrency: 'CNY' | 'USD';
  usdCnyRate: number;
  inputYuanPerMillion: number;
  outputYuanPerMillion: number;
  inputPricePerMillionFen: string;
  outputPricePerMillionFen: string;
  candidates: Array<{
    id: string;
    source: PriceCatalogSource;
    inputYuanPerMillion: number;
    outputYuanPerMillion: number;
  }>;
}

export interface PriceLookupMiss {
  found: false;
  query: string;
  message: string;
  candidates: PriceLookupMatch['candidates'];
}

export type PriceLookupResult = PriceLookupMatch | PriceLookupMiss;

export type CatalogFetcher = (url: string) => Promise<{ status: number; text: string }>;

export interface LookupModelPriceOptions {
  fetch?: CatalogFetcher;
  usdCnyRate?: number;
  now?: number;
  cache?: Map<string, { fetchedAt: number; entries: CatalogPriceEntry[] }>;
}

const defaultCache = new Map<string, { fetchedAt: number; entries: CatalogPriceEntry[] }>();

/** 归一化模型 id：小写、去厂商前缀、去掉 :variant。 */
export function normalizeModelId(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^\/+|\/+$/g, '')
    .replace(/:[\w.-]+$/, '')
    .replace(/_/g, '-');
}

/** 取路径最后一段，便于 gemini-3.8-flash 对齐 google/gemini-3.8-flash。 */
export function modelIdTail(raw: string): string {
  const normalized = normalizeModelId(raw);
  const slash = normalized.lastIndexOf('/');
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

/** 元 / 百万 token → 分（四舍五入）。 */
export function yuanPerMillionToFen(yuan: number): bigint {
  if (!Number.isFinite(yuan) || yuan < 0) {
    throw new Error('公开价必须为非负数');
  }
  return BigInt(Math.round(yuan * 100));
}

/** OpenRouter USD/token → 人民币元 / 百万 token。 */
export function openRouterUsdPerTokenToYuan(
  usdPerToken: number,
  usdCnyRate: number,
): number {
  if (!Number.isFinite(usdPerToken) || usdPerToken < 0) {
    throw new Error('OpenRouter 单价无效');
  }
  if (!Number.isFinite(usdCnyRate) || usdCnyRate <= 0) {
    throw new Error('USD/CNY 汇率必须为正数');
  }
  return usdPerToken * 1_000_000 * usdCnyRate;
}

export function parseOpenRouterModels(
  body: string,
  usdCnyRate: number = DEFAULT_USD_CNY_RATE,
): CatalogPriceEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return [];
  }
  const data = extractOpenRouterData(parsed);
  const entries: CatalogPriceEntry[] = [];
  for (const item of data) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    if (!id) continue;
    const pricing = row.pricing;
    if (!pricing || typeof pricing !== 'object') continue;
    const prompt = Number((pricing as Record<string, unknown>).prompt);
    const completion = Number((pricing as Record<string, unknown>).completion);
    if (!Number.isFinite(prompt) || !Number.isFinite(completion) || prompt < 0 || completion < 0) {
      continue;
    }
    entries.push({
      id,
      name: typeof row.name === 'string' ? row.name : undefined,
      source: 'openrouter',
      inputYuanPerMillion: openRouterUsdPerTokenToYuan(prompt, usdCnyRate),
      outputYuanPerMillion: openRouterUsdPerTokenToYuan(completion, usdCnyRate),
      nativeCurrency: 'USD',
    });
  }
  return entries;
}

function extractOpenRouterData(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { data?: unknown }).data)) {
    return (parsed as { data: unknown[] }).data;
  }
  return [];
}

/** 从硅基流动定价页抽取模型公开价（CNY / 百万 token）。 */
export function parseSiliconFlowHtml(html: string): CatalogPriceEntry[] {
  const fromJson = extractSiliconFlowJson(html);
  if (fromJson.length > 0) return fromJson;
  return extractSiliconFlowRegex(html);
}

function extractSiliconFlowJson(html: string): CatalogPriceEntry[] {
  const entries: CatalogPriceEntry[] = [];
  const seen = new Set<string>();
  const jsonBlocks = html.match(/\{[\s\S]{20,4000}?\}/g) ?? [];
  for (const block of jsonBlocks) {
    if (!/"?(?:model(?:Id|Name)?|id)"?\s*:/i.test(block)) continue;
    if (!/input|prompt|inputPrice|price/i.test(block)) continue;
    try {
      const obj = JSON.parse(block) as Record<string, unknown>;
      const id = pickString(obj, ['modelId', 'model_id', 'model', 'id', 'modelName']);
      if (!id || !id.includes('/')) continue;
      const input = pickNumber(obj, [
        'input',
        'inputPrice',
        'input_price',
        'prompt',
        'priceInput',
      ]);
      const output = pickNumber(obj, [
        'output',
        'outputPrice',
        'output_price',
        'completion',
        'priceOutput',
      ]);
      if (input == null || output == null) continue;
      const key = id.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({
        id,
        source: 'siliconflow',
        inputYuanPerMillion: input,
        outputYuanPerMillion: output,
        nativeCurrency: 'CNY',
      });
    } catch {
      /* 非完整 JSON 块忽略 */
    }
  }
  return entries;
}

function extractSiliconFlowRegex(html: string): CatalogPriceEntry[] {
  const entries: CatalogPriceEntry[] = [];
  const seen = new Set<string>();
  const modelRe = /([A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+)/g;
  let match: RegExpExecArray | null;
  while ((match = modelRe.exec(html))) {
    const id = match[1];
    if (id.includes('http') || id.includes('www.') || id.includes('siliconflow')) {
      continue;
    }
    const windowText = html.slice(match.index, match.index + 400);
    const rest = windowText.slice(id.length);
    const nextModel = rest.search(/[A-Za-z0-9._-]{2,}\/[A-Za-z0-9._/-]+/);
    const scoped = nextModel >= 0 ? windowText.slice(0, id.length + nextModel) : windowText;
    const cny = [...scoped.matchAll(/¥\s*([\d.]+)/g)].map((item) => Number(item[1]));
    if (cny.length < 2 || !Number.isFinite(cny[0]) || !Number.isFinite(cny[1])) continue;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      id,
      source: 'siliconflow',
      inputYuanPerMillion: cny[0],
      outputYuanPerMillion: cny[1],
      nativeCurrency: 'CNY',
    });
  }
  return entries;
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function pickNumber(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return null;
}

export function scoreModelMatch(query: string, entryId: string): number {
  const q = normalizeModelId(query);
  const id = normalizeModelId(entryId);
  const qTail = modelIdTail(query);
  const idTail = modelIdTail(entryId);
  if (!q) return 0;
  if (id === q) return 100;
  if (idTail === q || id === qTail || idTail === qTail) return 90;
  if (id.endsWith(`/${q}`) || q.endsWith(`/${idTail}`)) return 80;
  if (id.includes(q) || q.includes(idTail)) return 50;
  return 0;
}

export function pickBestMatches(
  query: string,
  entries: CatalogPriceEntry[],
  limit = 8,
): CatalogPriceEntry[] {
  const ranked = entries
    .map((entry) => ({ entry, score: scoreModelMatch(query, entry.id) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.entry.source !== b.entry.source) {
        return a.entry.source === 'siliconflow' ? -1 : 1;
      }
      return a.entry.id.length - b.entry.id.length;
    });
  const unique: CatalogPriceEntry[] = [];
  const seen = new Set<string>();
  for (const item of ranked) {
    const key = `${item.entry.source}:${normalizeModelId(item.entry.id)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item.entry);
    if (unique.length >= limit) break;
  }
  return unique;
}

export async function lookupModelPrice(
  query: string,
  options: LookupModelPriceOptions = {},
): Promise<PriceLookupResult> {
  const trimmed = query.trim();
  if (!trimmed) {
    return {
      found: false,
      query,
      message: '请先填写模型名称',
      candidates: [],
    };
  }
  const usdCnyRate = options.usdCnyRate ?? DEFAULT_USD_CNY_RATE;
  const entries = await loadCatalogs(options, usdCnyRate);
  const matches = pickBestMatches(trimmed, entries);
  if (matches.length === 0) {
    return {
      found: false,
      query: trimmed,
      message: `未在硅基流动与 OpenRouter 公开价目中找到「${trimmed}」，请手动填写输入/输出价。`,
      candidates: [],
    };
  }
  const best = matches[0];
  return {
    found: true,
    query: trimmed,
    matchedId: best.id,
    displayName: best.name ?? best.id,
    source: best.source,
    nativeCurrency: best.nativeCurrency,
    usdCnyRate,
    inputYuanPerMillion: roundYuan(best.inputYuanPerMillion),
    outputYuanPerMillion: roundYuan(best.outputYuanPerMillion),
    inputPricePerMillionFen: yuanPerMillionToFen(best.inputYuanPerMillion).toString(),
    outputPricePerMillionFen: yuanPerMillionToFen(best.outputYuanPerMillion).toString(),
    candidates: matches.map((item) => ({
      id: item.id,
      source: item.source,
      inputYuanPerMillion: roundYuan(item.inputYuanPerMillion),
      outputYuanPerMillion: roundYuan(item.outputYuanPerMillion),
    })),
  };
}

function roundYuan(value: number): number {
  return Math.round(value * 10000) / 10000;
}

async function loadCatalogs(
  options: LookupModelPriceOptions,
  usdCnyRate: number,
): Promise<CatalogPriceEntry[]> {
  const cache = options.cache ?? defaultCache;
  const now = options.now ?? Date.now();
  const fetchImpl = options.fetch ?? defaultCatalogFetch;
  const [silicon, openrouter] = await Promise.all([
    loadOneCatalog(
      cache,
      'siliconflow',
      now,
      async () => parseSiliconFlowHtml((await fetchImpl(SILICONFLOW_PRICING_URL)).text),
    ),
    loadOneCatalog(
      cache,
      `openrouter:${usdCnyRate}`,
      now,
      async () => parseOpenRouterModels((await fetchImpl(OPENROUTER_MODELS_URL)).text, usdCnyRate),
    ),
  ]);
  return [...silicon, ...openrouter];
}

async function loadOneCatalog(
  cache: Map<string, { fetchedAt: number; entries: CatalogPriceEntry[] }>,
  key: string,
  now: number,
  loader: () => Promise<CatalogPriceEntry[]>,
): Promise<CatalogPriceEntry[]> {
  const hit = cache.get(key);
  if (hit && now - hit.fetchedAt < CACHE_TTL_MS) return hit.entries;
  try {
    const entries = await loader();
    cache.set(key, { fetchedAt: now, entries });
    return entries;
  } catch {
    if (hit) return hit.entries;
    return [];
  }
}

async function defaultCatalogFetch(url: string): Promise<{ status: number; text: string }> {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json, text/html;q=0.9',
      'User-Agent': 'PiNovelStudio-price-lookup/1.0',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  return { status: response.status, text: await response.text() };
}
