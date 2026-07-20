/**
 * MODEL-ROUTING-CLAUDE46-1B RED 测试
 *
 * 派工卡: docs/model-routing-claude-opus-4-6-dispatch-card-20260717.md §4 (1B)
 *
 * 验证 Claude Opus 4.6 全项目切换：
 * - 所有实际 Claude route 的 model 统一为 claude-opus-4-6（不再是 4-8）
 * - Claude 专用 route 保持 Claude Opus 4.6；当前默认 narrator_primary 可由后续路由决策切换
 * - best_of_n_config 不得继续把 Doubao 声明为唯一正式正文模型
 * - .env.example 增加 CLAUDE_MODEL=claude-opus-4-6
 * - AGENTS.md / model-routing.recommendation.json 不得把 claude-opus-4-8 或 Doubao 主写
 *   作为"当前正式"陈述（历史 migration note 可保留但必须明确为历史）
 * - 策略信誉按 modelVersion 隔离：claude-opus-4-6 不继承 claude-opus-4-8 的旧信誉
 *
 * RED 状态：当前 config 仍是 claude-opus-4-8 / Doubao 主写，以下断言全部失败。
 * GREEN 状态：1B 实现完成后全部通过。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { StrategyPolicyStore } from "../dist-test/v2/learning/strategy-policy-store.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(testDir, "..");
const repoRoot = resolve(extensionRoot, "../../..");

function readRepoFile(path) {
  return readFileSync(join(repoRoot, path), "utf-8");
}

function loadRoutingConfig() {
  return JSON.parse(readRepoFile("config/model-routing.json"));
}

function loadRecommendation() {
  return JSON.parse(readRepoFile("config/model-routing.recommendation.json"));
}

const EXPECTED_CLAUDE_MODEL = "claude-opus-4-6";
const LEGACY_CLAUDE_MODEL = "claude-opus-4-8";

describe("MODEL-ROUTING-CLAUDE46-1B: Claude 4.6 全项目切换", () => {
  describe("Claude route model 显式声明为 claude-opus-4-6", () => {
    test("agent_routing 中所有 Claude route 使用 claude-opus-4-6", () => {
      const config = loadRoutingConfig();
      const claudeRoutes = [
        "narrator_testing_claude",
        "style_shaper",
        "stage8_final_gate",
        "character_agent",
        "v2_direct_claude",
        "v2_rawstage2",
        "v2_amplified",
      ];
      for (const routeName of claudeRoutes) {
        const route = config.agent_routing[routeName];
        assert.ok(route, `agent_routing.${routeName} must exist`);
        assert.equal(
          route.provider,
          "claude",
          `agent_routing.${routeName}.provider must be claude`,
        );
        assert.equal(
          route.model,
          EXPECTED_CLAUDE_MODEL,
          `agent_routing.${routeName}.model must be ${EXPECTED_CLAUDE_MODEL} (got ${route.model})`,
        );
      }
    });

    test("stage_routing 中所有 Claude route 使用 claude-opus-4-6", () => {
      const config = loadRoutingConfig();
      const claudeStageRoutes = [
        "stage5_style_shaper",
        "stage8_final_gate",
      ];
      for (const routeName of claudeStageRoutes) {
        const route = config.stage_routing[routeName];
        assert.ok(route, `stage_routing.${routeName} must exist`);
        assert.equal(route.provider, "claude");
        assert.equal(
          route.model,
          EXPECTED_CLAUDE_MODEL,
          `stage_routing.${routeName}.model must be ${EXPECTED_CLAUDE_MODEL}`,
        );
      }
    });

    test("stage2_narrator 当前默认切换为 Gemini，Claude 专用 route 仍保持 4.6", () => {
      const config = loadRoutingConfig();
      const route = config.stage_routing.stage2_narrator;
      assert.ok(route);
      assert.equal(route.provider, "gemini31");
      assert.equal(route.model, "gemini-3.1-pro-preview");
      assert.equal(config.agent_routing.v2_rawstage2.provider, "claude");
      assert.equal(config.agent_routing.v2_rawstage2.model, EXPECTED_CLAUDE_MODEL);
    });

    test("providers.claude 与 providers.claude_backup 默认 model 为 claude-opus-4-6", () => {
      const config = loadRoutingConfig();
      assert.equal(config.providers.claude.model, EXPECTED_CLAUDE_MODEL);
      assert.equal(config.providers.claude_backup.model, EXPECTED_CLAUDE_MODEL);
    });

    test("model_analysis.claude 与 claude_backup model 为 claude-opus-4-6", () => {
      const config = loadRoutingConfig();
      assert.equal(config.model_analysis.claude.model, EXPECTED_CLAUDE_MODEL);
      assert.equal(config.model_analysis.claude_backup.model, EXPECTED_CLAUDE_MODEL);
    });
  });

  describe("Gemini 默认主写与 Claude 风格职责分离", () => {
    test("model_strategy.narrator_primary 为 Gemini 3.1 Pro", () => {
      const config = loadRoutingConfig();
      assert.equal(config.model_strategy.narrator_primary, "gemini-3.1-pro-preview");
    });

    test("model_strategy.style_shaper 为 claude-opus-4-6", () => {
      const config = loadRoutingConfig();
      assert.equal(config.model_strategy.style_shaper, EXPECTED_CLAUDE_MODEL);
    });

    test("agent_routing.narrator_primary.provider 为 gemini31", () => {
      const config = loadRoutingConfig();
      assert.equal(config.agent_routing.narrator_primary.provider, "gemini31");
      assert.equal(config.agent_routing.narrator_primary.model, "gemini-3.1-pro-preview");
    });
  });

  describe("best_of_n_config 不再把 Doubao 声明为唯一正式正文模型", () => {
    test("best_of_n_config.models 包含 claude-opus-4-6", () => {
      const config = loadRoutingConfig();
      assert.ok(
        config.best_of_n_config.models.includes(EXPECTED_CLAUDE_MODEL),
        `best_of_n_config.models must include ${EXPECTED_CLAUDE_MODEL}`,
      );
    });

    test("best_of_n_config 不再把 Doubao 作为唯一正式正文模型", () => {
      const config = loadRoutingConfig();
      // 如果只有 Doubao，则违反 1B #3
      const onlyDoubao =
        config.best_of_n_config.models.length === 1 &&
        config.best_of_n_config.models[0].startsWith("doubao");
      assert.equal(
        onlyDoubao,
        false,
        "best_of_n_config.models 不得仅含 Doubao（必须包含 Claude 4.6）",
      );
    });
  });

  describe(".env.example 增加 CLAUDE_MODEL=claude-opus-4-6", () => {
    test(".env.example 包含 CLAUDE_MODEL=claude-opus-4-6", () => {
      const envExample = readRepoFile(".env.example");
      assert.match(
        envExample,
        /^CLAUDE_MODEL=claude-opus-4-6\s*$/m,
        ".env.example 必须包含 CLAUDE_MODEL=claude-opus-4-6",
      );
    });
  });

  describe("model-routing.recommendation.json 当前态不声明 claude-opus-4-8 / Doubao 主写", () => {
    test("productionCurrent.narrator_primary 为 Gemini 3.1 Pro", () => {
      const rec = loadRecommendation();
      assert.equal(rec.productionCurrent?.narrator_primary, "gemini-3.1-pro-preview");
    });

    test("productionCurrent.style_shaper 不为 claude-opus-4-8", () => {
      const rec = loadRecommendation();
      assert.notEqual(rec.productionCurrent?.style_shaper, LEGACY_CLAUDE_MODEL);
    });
  });

  describe("AGENTS.md 路由表不声明 Claude 4.8 为当前模型", () => {
    test("AGENTS.md 不含 'Claude Opus 4.8' 作为当前推荐模型", () => {
      const agents = readRepoFile("AGENTS.md");
      // 提取路由表行（| ... | Claude Opus 4.8 | ...）
      // 允许在历史/migration note 中出现，但路由表行不允许
      const tableRowRegex = /\|\s*[^|]+\|\s*Claude Opus 4\.8\s*\|/;
      assert.equal(
        tableRowRegex.test(agents),
        false,
        "AGENTS.md 路由表不得再声明 Claude Opus 4.8 为当前推荐模型",
      );
    });

    test("AGENTS.md 不声明 Doubao 为 Stage 2 主力（当前态）", () => {
      const agents = readRepoFile("AGENTS.md");
      // 路由表行 | 文学创作(Stage 2 主力) | Doubao ... |
      const stage2DoubaoRow = /\|\s*文学创作\(Stage 2 主力\)\s*\|\s*Doubao[^\n]*\n/;
      assert.equal(
        stage2DoubaoRow.test(agents),
        false,
        "AGENTS.md 路由表不得再声明 Doubao 为 Stage 2 主力（当前态）",
      );
    });
  });

  describe("策略信誉按 modelVersion 隔离：claude-opus-4-6 不继承 claude-opus-4-8", () => {
    test("在 claude-opus-4-8 分区积累信誉后，claude-opus-4-6 分区仍为弱先验", () => {
      const store = new StrategyPolicyStore("test-workspace");
      const strategyId = "editorial_amplified_v1";

      // 在 claude-opus-4-8 分区积累 5 次 win
      for (let i = 0; i < 5; i++) {
        store.recordOutcome(strategyId, LEGACY_CLAUDE_MODEL, {
          sourceChapter: `ch${i + 1}`,
          outcome: "win",
          source: "judge",
          weight: 1,
          timestamp: new Date().toISOString(),
        });
      }

      // claude-opus-4-8 分区应有 5 个样本
      const rep48 = store.getReputation(strategyId, LEGACY_CLAUDE_MODEL);
      assert.equal(rep48.sampleCount, 5);
      assert.equal(rep48.alpha, 6); // 1 prior + 5 wins

      // claude-opus-4-6 分区必须是弱先验，不继承
      const rep46 = store.getReputation(strategyId, EXPECTED_CLAUDE_MODEL);
      assert.equal(rep46.sampleCount, 0);
      assert.equal(rep46.alpha, 1); // WEAK_PRIOR_ALPHA
      assert.equal(rep46.beta, 1); // WEAK_PRIOR_BETA
      assert.equal(rep46.status, "candidate");
    });

    test("Doubao 分区积累的信誉不被 claude-opus-4-6 继承", () => {
      const store = new StrategyPolicyStore("test-workspace");
      const strategyId = "editorial_amplified_v1";
      const doubaoModel = "doubao-seed-2-1-pro-260628";

      store.recordOutcome(strategyId, doubaoModel, {
        sourceChapter: "ch1",
        outcome: "win",
        source: "judge",
        weight: 1,
        timestamp: new Date().toISOString(),
      });

      const repDoubao = store.getReputation(strategyId, doubaoModel);
      assert.equal(repDoubao.sampleCount, 1);

      const rep46 = store.getReputation(strategyId, EXPECTED_CLAUDE_MODEL);
      assert.equal(rep46.sampleCount, 0);
      assert.equal(rep46.alpha, 1);
      assert.equal(rep46.beta, 1);
    });
  });
});
