/**
 * 公开价目解析：OpenRouter USD/token、硅基流动 CNY/百万 token、模型匹配。
 */
import { describe, expect, it } from 'vitest';
import {
  lookupModelPrice,
  openRouterUsdPerTokenToYuan,
  parseOpenRouterModels,
  parseSiliconFlowHtml,
  pickBestMatches,
  yuanPerMillionToFen,
} from './model-price-catalog';

const OPENROUTER_FIXTURE = JSON.stringify({
  data: [
    {
      id: 'google/gemini-3.8-flash',
      name: 'Google: Gemini 3.8 Flash',
      pricing: { prompt: '0.000000375', completion: '0.000001875' },
    },
    {
      id: 'qwen/qwen3.8-27b',
      name: 'Qwen3.8 27B',
      pricing: { prompt: '0.00000045', completion: '0.0000032' },
    },
  ],
});

const SILICONFLOW_FIXTURE = `
  <div>Qwen/Qwen2.5-7B-Instruct 输入 ¥ 5.00 输出 ¥ 20.00</div>
  <div>deepseek-ai/DeepSeek-V3 ¥ 2.00 ¥ 8.00</div>
`;

describe('model price catalog', () => {
  it('converts OpenRouter USD/token to CNY fen per million', () => {
    const yuan = openRouterUsdPerTokenToYuan(0.000000375, 7.2);
    expect(yuan).toBeCloseTo(2.7, 6);
    expect(yuanPerMillionToFen(yuan)).toBe(270n);
  });

  it('skips OpenRouter rows with negative sentinel prices instead of aborting the catalog', () => {
    const entries = parseOpenRouterModels(
      JSON.stringify({
        data: [
          { id: 'bad/model', pricing: { prompt: '-1', completion: '0.000001' } },
          {
            id: 'google/gemini-3.8-flash',
            pricing: { prompt: '0.000000375', completion: '0.000001875' },
          },
        ],
      }),
      7.2,
    );
    expect(entries.map((item) => item.id)).toEqual(['google/gemini-3.8-flash']);
  });

  it('parses OpenRouter JSON prompt/completion prices', () => {
    const entries = parseOpenRouterModels(OPENROUTER_FIXTURE, 7.2);
    const gemini = entries.find((item) => item.id === 'google/gemini-3.8-flash');
    expect(gemini?.source).toBe('openrouter');
    expect(gemini?.inputYuanPerMillion).toBeCloseTo(2.7, 6);
    expect(gemini?.outputYuanPerMillion).toBeCloseTo(13.5, 6);
  });

  it('does not steal the next model\'s SiliconFlow prices', () => {
    const entries = parseSiliconFlowHtml(`
      Foo/Model-A 输入 ¥ 1.00 输出 ¥ 2.00
      Bar/Model-B 输入 ¥ 9.00 输出 ¥ 8.00
    `);
    expect(entries.find((item) => item.id === 'Foo/Model-A')).toMatchObject({
      inputYuanPerMillion: 1,
      outputYuanPerMillion: 2,
    });
    expect(entries.find((item) => item.id === 'Bar/Model-B')).toMatchObject({
      inputYuanPerMillion: 9,
      outputYuanPerMillion: 8,
    });
  });

  it('parses SiliconFlow HTML CNY prices next to vendor/model ids', () => {
    const entries = parseSiliconFlowHtml(SILICONFLOW_FIXTURE);
    const qwen = entries.find((item) => item.id === 'Qwen/Qwen2.5-7B-Instruct');
    expect(qwen).toMatchObject({
      source: 'siliconflow',
      inputYuanPerMillion: 5,
      outputYuanPerMillion: 20,
      nativeCurrency: 'CNY',
    });
    expect(yuanPerMillionToFen(5)).toBe(500n);
    expect(yuanPerMillionToFen(20)).toBe(2000n);
  });

  it('prefers SiliconFlow when the same model exists in both catalogs', async () => {
    const result = await lookupModelPrice('Qwen2.5-7B-Instruct', {
      cache: new Map(),
      fetch: async (url) => {
        if (url.includes('openrouter')) {
          return {
            status: 200,
            text: JSON.stringify({
              data: [
                {
                  id: 'qwen/qwen2.5-7b-instruct',
                  pricing: { prompt: '0.0000001', completion: '0.0000002' },
                },
              ],
            }),
          };
        }
        return { status: 200, text: SILICONFLOW_FIXTURE };
      },
    });
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.source).toBe('siliconflow');
      expect(result.matchedId).toBe('Qwen/Qwen2.5-7B-Instruct');
      expect(result.inputPricePerMillionFen).toBe('500');
      expect(result.outputPricePerMillionFen).toBe('2000');
    }
  });

  it('matches gemini-3.8-flash to google/gemini-3.8-flash', async () => {
    const result = await lookupModelPrice('gemini-3.8-flash', {
      cache: new Map(),
      fetch: async (url) => {
        if (url.includes('openrouter')) {
          return { status: 200, text: OPENROUTER_FIXTURE };
        }
        return { status: 200, text: '<html></html>' };
      },
    });
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.matchedId).toBe('google/gemini-3.8-flash');
      expect(result.inputPricePerMillionFen).toBe('270');
      expect(result.outputPricePerMillionFen).toBe('1350');
    }
  });

  it('returns a manual-input reminder when the model is missing', async () => {
    const result = await lookupModelPrice('totally-unknown-model-xyz', {
      cache: new Map(),
      fetch: async () => ({ status: 200, text: OPENROUTER_FIXTURE }),
    });
    expect(result.found).toBe(false);
    if (!result.found) {
      expect(result.message).toMatch(/手动填写/);
    }
  });

  it('ranks exact tail matches above loose includes', () => {
    const matches = pickBestMatches('gemini-3.8-flash', [
      {
        id: 'google/gemini-3.8-flash-lite',
        source: 'openrouter',
        inputYuanPerMillion: 1,
        outputYuanPerMillion: 2,
        nativeCurrency: 'USD',
      },
      {
        id: 'google/gemini-3.8-flash',
        source: 'openrouter',
        inputYuanPerMillion: 2.7,
        outputYuanPerMillion: 13.5,
        nativeCurrency: 'USD',
      },
    ]);
    expect(matches[0]?.id).toBe('google/gemini-3.8-flash');
  });
});
