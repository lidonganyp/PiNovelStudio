/**
 * PRODUCTION-ROLLOUT-AUDIT-1 · 运行时隔离测试（P0-1d / Next Minimal Slice item 3）
 *
 * 证明：orchestrator 在 productionFlow 未设置（遗留 raw/judge 分支）时，
 * 不能提交章节 / 状态 / 生产 trace。这不是字符串扫描——真实调用 orchestrator，
 * 断言"路径照常运行并返回 raw，但磁盘零提交副作用"。
 *
 * 背景：tests/setup-test-env.mjs 默认设置 PINOVEL_TEST_LEGACY_PRODUCTION_FLOW=1，
 * 使 unified-entry 的 productionFlow 判定返回 undefined，命中遗留 raw/judge 路径。
 * 本测试直接调用 UnifiedOrchestrator.orchestrate() 且不传 productionFlow /
 * evalMode / fullPipelinePreview / qualityExperiment，是审计报告 P0-1d 描述的
 * "orchestrator-direct 调用未设置 productionFlow" 的精确复现。
 *
 * 关键断言：遗留 raw/judge 分支仍可运行并返回 raw（供评测/观测），但绝不能
 * commit——chapterFilePath/stateCommit 必须为 null，磁盘上不得产生章节文件或
 * narrative-state-store.json。commit 仅限 agentic 生产路径（不会到达 deliverRaw）
 * 或显式授权（qualityExperiment）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { UnifiedOrchestrator } from "../dist/v2/core/unified-orchestrator.js";
import { TEST_STYLE_REFERENCES } from "./test-style-fingerprint.mjs";

test("productionFlow 未设置时遗留 raw/judge 分支不能 commit（章节/状态零写盘）", async () => {
  process.env.V2_FORCE_STUB = "1";

  const projectRoot = mkdtempSync(join(tmpdir(), "pf-unset-"));
  const workspaceId = "pf-unset-ws";
  const chapterId = "ch1";

  try {
    const orch = new UnifiedOrchestrator();
    const result = await orch.orchestrate({
      workspaceId,
      chapterId,
      chapterNumber: 1,
      projectRoot,
      // 关键：不传 productionFlow（遗留 raw/judge 分支）、不传 evalMode /
      // fullPipelinePreview / qualityExperiment。这是审计 P0-1d 的精确复现。
      intent: {
        chapterFunction: "推进：遭遇异象",
        readerExperience: ["紧张"],
        currentPressure: ["不明势力潜伏"],
        meaningfulChoices: [],
        promisesToAdvance: [],
        possibleEndPressure: [],
        relevantCharacters: ["林轩"],
        inviolableFacts: ["林轩是记者"],
        sourceRefs: ["chapter-seed"],
        concreteDelivery: ["推进本章功能：遭遇异象"],
        focusCharacterGoals: ["查清真相"],
        resistance: ["不明势力潜伏"],
        choicesAndCosts: [{ choice: "深入调查", cost: "暴露身份" }],
        expectedIrreversibleChange: ["身份暴露不可逆"],
        selectedPromisesToAdvance: [],
        causalEndPressure: ["追踪者逼近"],
        factAndCharacterKnowledgeForbiddenZones: ["林轩是记者"],
        fieldSourceRefs: {},
        underSpecifiedFields: [],
      },
      context: {
        facts: [],
        characterStates: [],
        openLoops: [],
        worldRules: [],
        styleReferences: TEST_STYLE_REFERENCES,
        sourceMap: [],
      },
      constitution: null,
      characterNames: ["林轩"],
      allowAutomaticLiterarySelection: false,
      modelGenerate: async (request) => {
        if (request.kind === "raw_chapter") {
          return { text: "完整 raw 正文（不应被提交）。", model: "stub", route: request.route, durationMs: 1 };
        }
        return { text: JSON.stringify({ hypotheses: [], noOpReason: "无 span 机会" }), model: "stub", route: request.route, durationMs: 1 };
      },
    });

    // 1. 遗留 raw/judge 分支照常运行并返回 raw（隔离在 commit 边界，而非整段硬阻断）。
    assert.equal(result.status, "ok", `路径应运行，实际 status=${result.status}`);
    assert.equal(result.selectedSource, "raw", "遗留分支仍返回 raw 基线供观测");

    // 2. 但绝不能 commit：不返回章节路径、不提交状态。
    assert.equal(result.chapterFilePath, null, "不得返回章节文件路径");
    assert.equal(result.stateCommit, null, "不得提交叙事状态");

    // 3. 磁盘零提交副作用：不得写章节文件、不得写 narrative-state-store.json。
    const wsDir = join(projectRoot, "workspaces", workspaceId);
    assert.equal(
      existsSync(join(wsDir, "chapters", `${chapterId}.md`)),
      false,
      "不得写章节文件（raw 不可作为章节提交）",
    );
    assert.equal(
      existsSync(join(wsDir, "narrative-state-store.json")),
      false,
      "不得写 narrative-state-store.json（状态不可提交）",
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
    delete process.env.V2_FORCE_STUB;
  }
});
