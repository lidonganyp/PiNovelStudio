/**
 * Legacy SceneContractPlanner production-boundary tests.
 *
 * Keyword-derived scene templates are retained only for historical test
 * compatibility. The unified production path must not compile or consume them.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  sceneContractContainsMechanicalMetric,
} from "../dist-test/v2/core/scene-contract-planner.js";

test("legacy SceneContractPlanner is absent from the production build", () => {
  assert.equal(
    existsSync(join(process.cwd(), "dist", "v2", "core", "scene-contract-planner.js")),
    false,
  );
  assert.equal(
    existsSync(join(process.cwd(), "dist", "v2", "core", "candidate-generator.js")),
    false,
  );
});

test("prompt audit recognizes explicit mechanical prose constraints", () => {
  assert.equal(sceneContractContainsMechanicalMetric("对白比例必须 34%"), true);
  assert.equal(sceneContractContainsMechanicalMetric("对话比例 30%"), true);
  assert.equal(sceneContractContainsMechanicalMetric("每段 200 字"), true);
  assert.equal(sceneContractContainsMechanicalMetric("段落长度必须 300 字"), true);
  assert.equal(sceneContractContainsMechanicalMetric("字数必须 3000"), true);
});

test("prompt audit does not treat narrative facts as mechanical metrics", () => {
  assert.equal(sceneContractContainsMechanicalMetric("门锁只能从室内打开"), false);
  assert.equal(sceneContractContainsMechanicalMetric("前章末人物仍在医院"), false);
  assert.equal(sceneContractContainsMechanicalMetric("本章末确认追踪者已经抵达"), false);
});
