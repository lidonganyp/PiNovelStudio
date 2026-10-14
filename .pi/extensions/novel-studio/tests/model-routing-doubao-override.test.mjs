/**
 * PiNovelStudio — P28 Doubao override 测试
 *
 * GEMINI-DEFAULT-WRITER-1 后：生产 narrator_primary / stage2_narrator 已切到 Gemini 3.1 Pro，
 * Doubao 降为受限中文校准器（1C v2_chinese_calibration span 驱动）与中文测试/自然化路由。
 * env override 仍可显式控制 rhythm adapter：
 *   - 生产 model-routing.json 中 narrator_primary / stage2_narrator 使用 Gemini 3.1 Pro，
 *     style_shaper 也使用 Claude Opus 4.6
 *   - 无 env override + Claude 主路由 → resolveRhythmAdapter() 返回 "default"
 *   - PINOVEL_RHYTHM_ADAPTER=doubao 时仍可强制切到 "doubao"（env override 优先于 config）
 *   - PINOVEL_RHYTHM_ADAPTER=default 时显式回到 default
 *   - Doubao provider / narrator_testing / chinese_naturalizer 凭据与配置始终保留
 *
 * 背景：P39 曾根据 Doubao/ERNIE 离线评测把 Stage 2 主写切到 Doubao；MODEL-ROUTING-CLAUDE46-1B
 * 起 raw 正文与普通 editorial candidate 主写统一切回 Claude Opus 4.6。
 */

import assert from "node:assert/strict";
import { describe, test, before, after, beforeEach, afterEach } from "node:test";
import { resolveRhythmAdapter, loadModelRoutingSync, getGeminiWriterModel } from "../dist/utils/config.js";

describe("GEMINI-DEFAULT-WRITER-1 Gemini primary routing and rhythm adapter override", () => {
  const savedAdapter = process.env.PINOVEL_RHYTHM_ADAPTER;

  before(() => {
    // 默认不依赖外部 env override；每个用例自己设置需要的值
    delete process.env.PINOVEL_RHYTHM_ADAPTER;
  });

  after(() => {
    // 恢复原始 env，避免污染其他测试
    if (savedAdapter === undefined) {
      delete process.env.PINOVEL_RHYTHM_ADAPTER;
    } else {
      process.env.PINOVEL_RHYTHM_ADAPTER = savedAdapter;
    }
  });

  beforeEach(() => {
    delete process.env.PINOVEL_RHYTHM_ADAPTER;
  });

  afterEach(() => {
    delete process.env.PINOVEL_RHYTHM_ADAPTER;
  });

  test("生产 config 使用 .env GEMINI_MODEL 解析的主路由（无 env override 时）", () => {
    const routing = loadModelRoutingSync();
    // WRITER-ENV-UNIFY-1：正文身份由 .env GEMINI_MODEL 决定，Claude 4.6 继续负责 style_shaper。
    assert.equal(routing.model_strategy.narrator_primary, getGeminiWriterModel());
    assert.equal(routing.model_strategy.narrator_backup, null);
    assert.equal(routing.model_strategy.style_shaper, "claude-opus-4-6");
    assert.equal(routing.stage_routing.stage2_narrator.provider, "gemini31");
    assert.equal(routing.stage_routing.stage2_narrator.model, getGeminiWriterModel());
    assert.equal(routing.stage_routing.stage5_style_shaper.provider, "claude");
    assert.equal(routing.stage_routing.stage5_style_shaper.model, "claude-opus-4-6");
    assert.equal(routing.agent_routing.narrator_primary.provider, "gemini31");
    assert.equal(routing.agent_routing.narrator_primary.model, getGeminiWriterModel());
    assert.deepEqual(routing.agent_routing.narrator_primary.fallback, []);
    assert.equal(routing.agent_routing.narrator_backup, undefined);
    assert.equal(routing.agent_routing.narrator_testing_claude.provider, "claude");
    assert.equal(routing.agent_routing.style_shaper.provider, "claude");
    assert.equal(routing.agent_routing.style_shaper.model, "claude-opus-4-6");
    // loadModelRoutingSync() 会触发 loadProjectDotEnv() 读取真实 .env，
    // 可能重新设置 PINOVEL_RHYTHM_ADAPTER。
    // 这里要验证"无 env override"场景，必须重新 delete 隔离副作用。
    delete process.env.PINOVEL_RHYTHM_ADAPTER;
    // 无 env override + Gemini 主路由 → rhythm adapter 自动为 default
    // （resolveRhythmAdapter 只在 narrator_primary.provider === "doubao" 时返回 "doubao"）
    assert.equal(resolveRhythmAdapter(), "default");
  });

  test("PINOVEL_RHYTHM_ADAPTER=doubao 仍可强制切换 rhythm adapter 到 doubao", () => {
    process.env.PINOVEL_RHYTHM_ADAPTER = "doubao";
    // env override 优先于 config；即使生产主路由是 Gemini，env override 仍可强制 doubao
    assert.equal(resolveRhythmAdapter(), "doubao");
  });

  test("PINOVEL_RHYTHM_ADAPTER=default 显式回到 default", () => {
    process.env.PINOVEL_RHYTHM_ADAPTER = "default";
    assert.equal(resolveRhythmAdapter(), "default");
  });

  test("Doubao 仍在 providers / narrator_testing / chinese_naturalizer 保留（受限中文校准器）", () => {
    const routing = loadModelRoutingSync();
    // provider catalog 凭据不动
    assert.equal(routing.providers.doubao.model, "doubao-seed-2-1-pro-260628");
    assert.equal(routing.providers.doubao.api_key_env, "ARK_API_KEY");
    assert.equal(routing.providers.doubao.base_url, "https://ark.cn-beijing.volces.com/api/v3");
    // MODEL-ROUTING-CLAUDE46-1B: Doubao 不再担任正文主写/备援；narrator_backup=null。
    // narrator_testing / chinese_naturalizer 仍保留 Doubao（受限中文校准器与测试路由，1C）。
    assert.equal(routing.model_strategy.narrator_backup, null);
    assert.equal(routing.model_strategy.narrator_testing, "doubao-seed-2-1-pro-260628");
    assert.equal(routing.model_strategy.chinese_naturalizer, "doubao-seed-2-1-pro-260628");
    // agent_routing 保留 testing / naturalizer
    assert.equal(routing.agent_routing.narrator_testing.provider, "doubao");
    assert.equal(routing.agent_routing.narrator_testing.model, "doubao-seed-2-1-pro-260628");
    assert.equal(routing.agent_routing.chinese_naturalizer.provider, "doubao");
    assert.equal(routing.agent_routing.chinese_naturalizer.model, "doubao-seed-2-1-pro-260628");
    // best_of_n_config.models 是休眠候选目录（历史口径）；
    // Doubao 仍不在正文模型集合中，只保留为受限中文校准器。
    assert.deepEqual(routing.best_of_n_config.models, [
      getGeminiWriterModel(),
      "claude-opus-4-6",
    ]);
  });
});
