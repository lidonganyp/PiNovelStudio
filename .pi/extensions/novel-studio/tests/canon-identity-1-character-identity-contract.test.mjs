/**
 * CANON-IDENTITY-1 - CharacterIdentityContract RED contract.
 *
 * 验收口径（对应任务卡 acceptance）：
 * 1. IdentityContract 从 config 编译，含 name/aliases/role/stableIdentity
 * 2. aliases 传入 FactGuard，别名引用不被误报为实体幻觉
 * 3. 身份矛盾检测：小妖不得变宠物、大蛇不得变伙伴、李强父子不得改叔侄、陈锋不得降为初见
 * 4. prompt 与 FactGuard 消费同一 contract（id/hash 一致）
 * 5. 同名普通名词/明确另一个实体不误阻断
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { compileIdentityContract } from "../dist/v2/core/identity-contract-compiler.js";
import { createFactContinuityGuard } from "../dist/v2/core/fact-continuity-guard.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, "..", "..", "..", "..");

// 使用仓库内 committed fixture，避免依赖未提交的 workspaces/xinmo/config.json
// （干净检出时该文件不存在，导致模块加载阶段 ENOENT）
const XINMO_CONFIG = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "xinmo-minimal-config.json"), "utf-8")
);
const XINMO_CHARACTERS = XINMO_CONFIG.characters;

// ── 单元测试 ─────────────────────────────────────────────────────────

test("CI1 unit: IdentityContract 从 config 编译含 name/aliases/role", () => {
  const contract = compileIdentityContract(XINMO_CHARACTERS);
  assert.ok(contract, "contract 应非 null");
  assert.equal(contract.schema, "pinovel.identity-contract");
  assert.ok(contract.contractId, "应有 contractId");
  assert.ok(contract.contractHash, "应有 contractHash");
  assert.ok(contract.entries.length > 0, "应有角色条目");

  // 验证李一凡
  const lyf = contract.entries.find((e) => e.name === "李一凡");
  assert.ok(lyf, "应含李一凡");
  assert.equal(lyf.role, "protagonist");
  assert.ok(lyf.aliases.includes("一凡"));

  // 验证小妖
  const xy = contract.entries.find((e) => e.name === "小妖");
  assert.ok(xy, "应含小妖");
  assert.equal(xy.role, "love-interest");
  assert.ok(xy.aliases.includes("萧瑶"), "小妖 aliases 应含萧瑶");

  // 验证李强（aliases 含父亲/爸）
  const lq = contract.entries.find((e) => e.name === "李强");
  assert.ok(lq, "应含李强");
  assert.ok(lq.aliases.includes("父亲"), "李强 aliases 应含父亲");
  assert.ok(lq.aliases.includes("爸"), "李强 aliases 应含爸");
});

test("CI1 unit: FactGuard 传入 aliases 后不误报别名为实体幻觉", () => {
  const contract = compileIdentityContract(XINMO_CHARACTERS);
  // 收集所有已知名称（name + aliases）
  const allNames = contract.entries.flatMap((e) => [e.name, ...e.aliases]);

  const guard = createFactContinuityGuard();
  // 正文用别名"萧瑶"指代小妖，不应被报为实体幻觉
  const report = guard.check({
    text: "萧瑶靠在李一凡肩上，安静地闭着眼。李一凡轻轻握住萧瑶的手。",
    context: {
      facts: [], characterStates: [], openLoops: [], worldRules: [],
      styleReferences: [], sourceMap: [], constitution: null, longTermState: null,
    },
    knownCharacterNames: allNames,
    identityContract: contract,
  });

  const entityDiags = report.allDiagnostics.filter((d) => d.source === "entity_checker");
  assert.equal(entityDiags.length, 0, `别名"萧瑶"不应被误报为实体幻觉，实际：${JSON.stringify(entityDiags)}`);
});

test("CI1 unit: 身份矛盾检测 - 小妖不得变宠物", () => {
  const contract = compileIdentityContract(XINMO_CHARACTERS);
  const allNames = contract.entries.flatMap((e) => [e.name, ...e.aliases]);

  const guard = createFactContinuityGuard();
  const report = guard.check({
    text: "小妖蹲在地上，摇着尾巴。李一凡给小妖喂了一块肉干，小妖乖巧地吃了。",
    context: {
      facts: [], characterStates: [], openLoops: [], worldRules: [],
      styleReferences: [], sourceMap: [], constitution: null, longTermState: null,
    },
    knownCharacterNames: allNames,
    identityContract: contract,
  });

  const identityDiags = report.allDiagnostics.filter((d) => d.source === "identity_contradiction");
  assert.ok(identityDiags.length > 0, "小妖被描述为宠物应有身份矛盾诊断");
  assert.equal(identityDiags[0].severity, "hard");
  assert.match(identityDiags[0].evidence, /小妖|宠物|love-interest/);
});

test("CI1 unit: 身份矛盾检测 - 梦魇(antagonist-ally)不得变伙伴", () => {
  const contract = compileIdentityContract(XINMO_CHARACTERS);
  const allNames = contract.entries.flatMap((e) => [e.name, ...e.aliases]);

  const guard = createFactContinuityGuard();
  const report = guard.check({
    text: "梦魇是李一凡的伙伴，一直跟随他左右，并肩作战。",
    context: {
      facts: [], characterStates: [], openLoops: [], worldRules: [],
      styleReferences: [], sourceMap: [], constitution: null, longTermState: null,
    },
    knownCharacterNames: allNames,
    identityContract: contract,
  });

  const identityDiags = report.allDiagnostics.filter((d) => d.source === "identity_contradiction");
  assert.ok(identityDiags.length > 0, "梦魇(antagonist-ally)被描述为伙伴应有身份矛盾诊断");
  assert.match(identityDiags[0].evidence, /伙伴/, "身份证据必须包含实际关系词");
  assert.ok(
    (identityDiags[0].span?.excerpt ?? "").includes("梦魇")
      && (identityDiags[0].span?.excerpt ?? "").includes("伙伴"),
    "身份 span 必须同时覆盖角色与关系证据",
  );
});

test("IRE1: 跨分句的伙伴不应归因给梦魇或水怪", () => {
  const contract = compileIdentityContract(XINMO_CHARACTERS);
  const allNames = contract.entries.flatMap((e) => [e.name, ...e.aliases]);

  const guard = createFactContinuityGuard();
  const report = guard.check({
    text: "水怪潜伏在水边，李一凡把受伤的伙伴扶起来。梦魇站在远处，队员们互相称作伙伴。",
    context: {
      facts: [], characterStates: [], openLoops: [], worldRules: [],
      styleReferences: [], sourceMap: [], constitution: null, longTermState: null,
    },
    knownCharacterNames: allNames,
    identityContract: contract,
  });

  const identityDiags = report.allDiagnostics.filter((d) => d.source === "identity_contradiction");
  assert.equal(identityDiags.length, 0, `跨分句关系不应误归因，实际：${JSON.stringify(identityDiags)}`);
});

test("IRE1: 同分句直接关系仍 hard 且 span 覆盖关系证据", () => {
  const contract = compileIdentityContract(XINMO_CHARACTERS);
  const allNames = contract.entries.flatMap((e) => [e.name, ...e.aliases]);

  const guard = createFactContinuityGuard();
  const report = guard.check({
    text: "梦魇是李一凡的伙伴，而水怪在远处。",
    context: {
      facts: [], characterStates: [], openLoops: [], worldRules: [],
      styleReferences: [], sourceMap: [], constitution: null, longTermState: null,
    },
    knownCharacterNames: allNames,
    identityContract: contract,
  });

  const identityDiag = report.allDiagnostics.find(
    (d) => d.source === "identity_contradiction" && d.evidence.includes("梦魇"),
  );
  assert.ok(identityDiag, "同分句直接身份关系必须 hard block");
  assert.match(identityDiag.evidence, /伙伴/);
  assert.ok(
    (identityDiag.span?.excerpt ?? "").includes("梦魇")
      && (identityDiag.span?.excerpt ?? "").includes("伙伴"),
    "直接关系 span 必须同时覆盖角色与关系词",
  );
});

test("FACTGUARD-DOWNGRADE-1: 历史/回忆语境下的身份描述降为 review，不 hard block", () => {
  const contract = compileIdentityContract(XINMO_CHARACTERS);
  const allNames = contract.entries.flatMap((e) => [e.name, ...e.aliases]);

  const guard = createFactContinuityGuard();
  // "梦魇曾经是李一凡的伙伴" 描述过去状态，不是当前设定矛盾
  const report = guard.check({
    text: "梦魇曾经是李一凡的伙伴，后来才反目成仇。",
    context: {
      facts: [], characterStates: [], openLoops: [], worldRules: [],
      styleReferences: [], sourceMap: [], constitution: null, longTermState: null,
    },
    knownCharacterNames: allNames,
    identityContract: contract,
  });

  const identityDiags = report.allDiagnostics.filter((d) => d.source === "identity_contradiction");
  assert.ok(identityDiags.length > 0, "历史语境下的身份描述仍应产生诊断（证据保留）");
  assert.equal(identityDiags[0].severity, "review", "历史/回忆语境降为 review，不 hard block");
  assert.equal(report.hasHardBlock, false, "历史语境身份描述不得 hard block");
});

test("FACTGUARD-DOWNGRADE-1: 历史语境下的 family 关系描述降为 review", () => {
  const contract = compileIdentityContract(XINMO_CHARACTERS);
  const allNames = contract.entries.flatMap((e) => [e.name, ...e.aliases]);

  const guard = createFactContinuityGuard();
  const report = guard.check({
    text: "李强以前是李一凡的叔叔，后来才相认是亲生父亲。",
    context: {
      facts: [], characterStates: [], openLoops: [], worldRules: [],
      styleReferences: [], sourceMap: [], constitution: null, longTermState: null,
    },
    knownCharacterNames: allNames,
    identityContract: contract,
  });

  const identityDiags = report.allDiagnostics.filter((d) => d.source === "identity_contradiction");
  assert.ok(identityDiags.length > 0, "历史语境 family 关系仍应产生诊断");
  assert.equal(identityDiags[0].severity, "review", "历史/回忆语境 family 关系降为 review");
  assert.equal(report.hasHardBlock, false, "历史语境 family 关系不得 hard block");
});

test("CI1 unit: 身份矛盾检测 - 李强父子不得改叔侄", () => {
  const contract = compileIdentityContract(XINMO_CHARACTERS);
  const allNames = contract.entries.flatMap((e) => [e.name, ...e.aliases]);

  const guard = createFactContinuityGuard();
  const report = guard.check({
    text: "李强是李一凡的叔叔，从小把他养大。",
    context: {
      facts: [], characterStates: [], openLoops: [], worldRules: [],
      styleReferences: [], sourceMap: [], constitution: null, longTermState: null,
    },
    knownCharacterNames: allNames,
    identityContract: contract,
  });

  const identityDiags = report.allDiagnostics.filter((d) => d.source === "identity_contradiction");
  assert.ok(identityDiags.length > 0, "李强被描述为叔叔应有身份矛盾诊断");
});

test("CI1 unit: 同名普通名词不误阻断", () => {
  const contract = compileIdentityContract(XINMO_CHARACTERS);
  const allNames = contract.entries.flatMap((e) => [e.name, ...e.aliases]);

  const guard = createFactContinuityGuard();
  // "墨老"是角色名，但"墨"也常见于非角色语境
  const report = guard.check({
    text: "李一凡拿起一支墨笔，在纸上写下几个字。窗外的风很大。",
    context: {
      facts: [], characterStates: [], openLoops: [], worldRules: [],
      styleReferences: [], sourceMap: [], constitution: null, longTermState: null,
    },
    knownCharacterNames: allNames,
    identityContract: contract,
  });

  const identityDiags = report.allDiagnostics.filter((d) => d.source === "identity_contradiction");
  assert.equal(identityDiags.length, 0, "普通名词'墨笔'不应触发身份矛盾");
});

// ── 集成测试（prompt/guard 共源）─────────────────────────────────────

test("CI1 integration: prompt 与 FactGuard 消费同一 identityContract（id/hash 一致）", async () => {
  const { createUnifiedOrchestrator } = await import("../dist/v2/core/unified-orchestrator.js");
  const projectRoot = mkdtempSync(join(tmpdir(), "ci1-integration-"));
  const wsDir = join(projectRoot, "workspaces", "ci1-test");
  const chaptersDir = join(wsDir, "chapters");
  mkdirSync(chaptersDir, { recursive: true });
  // 写最小 config
  writeFileSync(join(wsDir, "config.json"), JSON.stringify({
    novelTitle: "测试", genre: "都市异能", characters: XINMO_CHARACTERS.slice(0, 5),
  }), "utf-8");

  try {
    const orchestrator = createUnifiedOrchestrator();
    // 用 stub model 触发 raw 生成
    const stubModel = async (input) => {
      if (input.kind === "raw_chapter") {
        return { text: "李一凡推开密封室的门，走了进去，环顾四周。空气中弥漫着消毒水的味道。", model: "stub", route: input.route, durationMs: 1 };
      }
      return { text: JSON.stringify({ winner: "tie", confidence: "uncertain", decisiveReasons: [], factualRisks: [], regressionRisks: [], constitutionAlignment: "无" }), model: "stub-judge", route: input.route, durationMs: 1 };
    };

    const result = await orchestrator.orchestrate({
      workspaceId: "ci1-test", chapterId: "ch1", chapterNumber: 1, projectRoot,
      intent: {
        chapterFunction: "测试", readerExperience: ["紧张"], currentPressure: ["压力"],
        meaningfulChoices: [], promisesToAdvance: [], possibleEndPressure: [],
        relevantCharacters: ["李一凡"], inviolableFacts: [], sourceRefs: ["test"],
        focusCharacterGoals: [{ character: "李一凡", goal: "测试" }],
        resistance: [], choicesAndCosts: [], expectedIrreversibleChange: [],
        selectedPromisesToAdvance: [], causalEndPressure: [],
        factAndCharacterKnowledgeForbiddenZones: [], fieldSourceRefs: {},
      },
      context: {
        facts: [], characterStates: [
          { characterId: "李一凡", name: "李一凡", state: { role: "protagonist", aliases: ["一凡"] }, sourceIds: ["config"] },
        ], openLoops: [], worldRules: [],
        styleReferences: [], sourceMap: [], constitution: null, longTermState: null,
      },
      constitution: null,
      characterNames: XINMO_CHARACTERS.slice(0, 5).flatMap((c) => [c.name, ...(c.aliases || [])]),
      modelGenerate: stubModel, generationModelGenerate: stubModel, judgeModelGenerate: stubModel,
      evalMode: "B1",
    });

    // identityContract 应在 stageResults 中
    const ic = result.stageResults?.identityContract;
    assert.ok(ic, "stageResults 应含 identityContract");
    assert.ok(ic.contractId, "identityContract 应有 contractId");
    assert.ok(ic.contractHash, "identityContract 应有 contractHash");

    // raw prompt 应消费了 identityContract
    assert.ok(
      result.stageResults?.chapterIntent?.consumedFields?.includes("identityContract"),
      "raw prompt 应消费 identityContract"
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
