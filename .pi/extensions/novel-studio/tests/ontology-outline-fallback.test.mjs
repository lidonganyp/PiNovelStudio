/**
 * Regression coverage for outline-backed ontology authorization.
 *
 * Platform projects may materialize worldKeyTerms as a flat array, leaving
 * config.worldKeyTerms.levels empty even when the outline declares a realm
 * progression. The fallback must recover only explicit realm chains.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadOntologyLevels,
  parseOntologyLevelsFromOutline,
} from "../dist/v2/core/unified-entry.js";
import {
  checkUnauthorizedHighImpactSettings,
  compileImmutableFacts,
} from "../dist-test/v2/core/immutable-facts-compiler.js";

const REALM_OUTLINE = [
  "# 心魔界大纲",
  "### 16.4 境界体系总览",
  "**炼魂境界**：魂感境 → 魂凝境 → 魂御境 → 魂象境 → 魂域境 → 魂主境 → 魂王境",
  "**炼体境界**：筑体境 -> 铸骨境 -> 凝筋境 / 洗髓境 / 金身境 / 法相境 / 归一境",
  "### 16.5 其他设定",
  "这里描述角色的境界感受，但没有列出等级链。",
].join("\n");

function makeWorkspace(config, files) {
  const projectRoot = mkdtempSync(join(tmpdir(), "ontology-outline-fallback-"));
  const workspacePath = join(projectRoot, "workspaces", "p252");
  mkdirSync(join(workspacePath, "series"), { recursive: true });
  writeFileSync(join(workspacePath, "config.json"), JSON.stringify(config), "utf8");
  for (const [relativePath, content] of Object.entries(files)) {
    writeFileSync(join(workspacePath, relativePath), content, "utf8");
  }
  return { projectRoot, workspaceId: "p252" };
}

function compileWithLevels(ontologyLevels) {
  return compileImmutableFacts({
    worldRules: [],
    constitution: {},
    characterStates: [],
    bridgeContext: { available: false },
    chapterAnchors: [],
    ontologyLevels,
    openPromises: [],
    openLoops: [],
  });
}

test("outline parser extracts explicit realm chains and normalizes suffixes", () => {
  assert.deepEqual(parseOntologyLevelsFromOutline(REALM_OUTLINE), [
    "炼魂（魂感/魂凝/魂御/魂象/魂域/魂主/魂王）",
    "炼体（筑体/铸骨/凝筋/洗髓/金身/法相/归一）",
  ]);
});

test("generic 境界 prose without a chain does not authorize ontology terms", () => {
  assert.deepEqual(
    parseOntologyLevelsFromOutline([
      "- 必须满足：境界体系清晰（筑体→铸骨→金身→法相）；装备获取有逻辑。",
      "### 境界体系",
      "这里讨论境界的感受，没有等级顺序。",
    ].join("\n")),
    [],
  );
});

test("structured config levels take precedence over outline fallback", () => {
  const { projectRoot, workspaceId } = makeWorkspace(
    { worldKeyTerms: { levels: ["配置体系（甲/乙）"] } },
    { "series/outline-full.md": REALM_OUTLINE },
  );
  assert.deepEqual(loadOntologyLevels(workspaceId, projectRoot), ["配置体系（甲/乙）"]);
});

test("flat platform config falls back to outline-full then clipped outline", () => {
  const full = makeWorkspace(
    { worldKeyTerms: [] },
    { "series/outline-full.md": REALM_OUTLINE, "series/outline.md": "### 境界体系\n**错误体系**：甲境→乙境" },
  );
  assert.deepEqual(loadOntologyLevels(full.workspaceId, full.projectRoot), [
    "炼魂（魂感/魂凝/魂御/魂象/魂域/魂主/魂王）",
    "炼体（筑体/铸骨/凝筋/洗髓/金身/法相/归一）",
  ]);

  const clipped = makeWorkspace(
    { worldKeyTerms: [] },
    { "series/outline.md": REALM_OUTLINE },
  );
  assert.deepEqual(loadOntologyLevels(clipped.workspaceId, clipped.projectRoot), [
    "炼魂（魂感/魂凝/魂御/魂象/魂域/魂主/魂王）",
    "炼体（筑体/铸骨/凝筋/洗髓/金身/法相/归一）",
  ]);
});

test("outline-authorized realm passes while an unknown realm remains blocked", () => {
  const compiled = compileWithLevels(parseOntologyLevelsFromOutline(REALM_OUTLINE));
  const authorized = checkUnauthorizedHighImpactSettings("他突破到魂凝境，气息稳定下来。", compiled);
  assert.equal(authorized.some((diagnostic) => diagnostic.category === "upgrade_result"), false);

  const unknown = checkUnauthorizedHighImpactSettings("他突破到天外境，气息骤然暴涨。", compiled);
  assert.ok(unknown.some((diagnostic) => diagnostic.category === "upgrade_result"));
});
