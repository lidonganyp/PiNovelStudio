/**
 * Phase 9 - Prompt Registry 端到端治理测试
 *
 * 验证：
 * 1. eval/test 不能修改 production pointer（只能指向 active 版本；eval-gate 不能触发 canary -> active）
 * 2. Hash 漂移阻断（修改 prompt 内容后 drift check 返回 passed=false）
 * 3. Registry 损坏 fail-closed（缺失/损坏/schema 不匹配 -> loadRegistry 抛错）
 * 4. Manifest 版本化（固定维度变更 -> manifestVersion 变化）
 * 5. Premature done 门禁（prematureDoneRate > tolerance -> passed=false）
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createEmptyRegistry,
  createProductionSnapshot,
  createEvalCandidate,
  transitionStatus,
  setProductionPointer,
  addVersion,
  loadRegistry,
  saveRegistry,
  computePromptHash,
  computeProductionToolSchemaHash,
  computeProductionContextHash,
  computeProductionBudgetHash,
  PRODUCTION_NOVELOS_PROMPT,
  PRODUCTION_STYLE_PROMPT,
  PRODUCTION_WRITER_PROMPT,
  EVAL_BASELINE_RETRIEVAL_PROMPT,
} from "../dist-eval/novelos/eval/prompt-registry.js";

import {
  computeManifestVersion,
  createDefaultScenarios,
  createDefaultSeeds,
  DEFAULT_GATE_CONFIG,
  DEFAULT_MODEL_ROUTE,
  DEFAULT_TEMPERATURE,
  DEFAULT_MAX_TOKENS,
} from "../dist-eval/novelos/eval/prompt-registry-manifest.js";

import {
  computePrematureDoneRate,
  evaluatePrematureDoneGate,
} from "../dist-eval/novelos/eval/premature-done-diagnostic.js";

import { runDriftCheck } from "../dist-eval/novelos/eval/prompt-registry-drift-check.js";

// ============================================================================
// 辅助：创建临时 registry 文件
// ============================================================================

function createTempRegistryPath() {
  const dir = mkdtempSync(join(tmpdir(), "phase9-test-"));
  return join(dir, "prompt-registry.json");
}

function createActiveRegistry() {
  let registry = createEmptyRegistry();

  const slotPrompts = [
    ["novelos_agentic", PRODUCTION_NOVELOS_PROMPT],
    ["style_optimizer", PRODUCTION_STYLE_PROMPT],
    ["writer_adapter", PRODUCTION_WRITER_PROMPT],
    ["retrieval_eval", EVAL_BASELINE_RETRIEVAL_PROMPT],
  ];

  for (const [slot, prompt] of slotPrompts) {
    const v1 = createProductionSnapshot(
      slot, 1, `test v1 ${slot}`, "narrator_primary", prompt,
    );
    let v = v1;
    v = transitionStatus(v, "eval", "test eval", "manual");
    v = transitionStatus(v, "canary", "test canary", "manual");
    v = transitionStatus(v, "active", "test active", "manual");
    registry = addVersion(registry, v);
    registry = setProductionPointer(registry, slot, v.versionId);
  }

  return { registry };
}

// ============================================================================
// 测试
// ============================================================================

describe("Phase 9 Registry Governance", () => {

  // ── 1. Production pointer 保护 ──

  describe("1. Production pointer 保护", () => {

    it("setProductionPointer 只能指向 active 版本", () => {
      let registry = createEmptyRegistry();
      const draft = createProductionSnapshot(
        "novelos_agentic", 1, "draft", "narrator_primary", "test prompt",
      );
      registry = addVersion(registry, draft);

      // draft 版本不能被指针指向
      assert.throws(
        () => setProductionPointer(registry, "novelos_agentic", draft.versionId),
        /只能指向 active 版本/,
      );
    });

    it("eval-gate 不能触发 canary -> active", () => {
      const v = createProductionSnapshot(
        "novelos_agentic", 1, "test", "narrator_primary", "test prompt",
      );
      let canary = transitionStatus(v, "eval", "eval", "manual");
      canary = transitionStatus(canary, "canary", "gate passed", "eval-gate");

      // eval-gate 尝试 active -> 必须抛错
      assert.throws(
        () => transitionStatus(canary, "active", "auto promote", "eval-gate"),
        /禁止自动晋级/,
      );
    });

    it("manual 可以触发 canary -> active", () => {
      const v = createProductionSnapshot(
        "novelos_agentic", 1, "test", "narrator_primary", "test prompt",
      );
      let canary = transitionStatus(v, "eval", "eval", "manual");
      canary = transitionStatus(canary, "canary", "gate passed", "eval-gate");
      const active = transitionStatus(canary, "active", "manual promote", "manual");
      assert.equal(active.status, "active");
    });

    it("rejected 是终态，不可转换", () => {
      const v = createProductionSnapshot(
        "novelos_agentic", 1, "test", "narrator_primary", "test prompt",
      );
      let evalVer = transitionStatus(v, "eval", "eval", "manual");
      const rejected = transitionStatus(evalVer, "rejected", "gate failed", "eval-gate");

      assert.throws(
        () => transitionStatus(rejected, "canary", "retry", "manual"),
        /非法状态转换/,
      );
      assert.throws(
        () => transitionStatus(rejected, "active", "retry", "manual"),
        /非法状态转换/,
      );
    });
  });

  // ── 2. Hash 漂移阻断 ──

  describe("2. Hash 漂移阻断", () => {

    it("生产 hash 一致时 drift check 通过", () => {
      const registryPath = createTempRegistryPath();
      try {
        const { registry } = createActiveRegistry();
        saveRegistry(registry, registryPath);

        const result = runDriftCheck(registryPath);
        assert.equal(result.passed, true, `Expected pass but: ${result.summary}`);
      } finally {
        rmSync(join(registryPath, ".."), { recursive: true, force: true });
      }
    });

    it("prompt 内容变更后 drift check 失败", () => {
      const registryPath = createTempRegistryPath();
      try {
        // 用正确 prompt 创建所有 4 个 slot 的 active 版本
        const { registry } = createActiveRegistry();
        saveRegistry(registry, registryPath);

        // 篡改 registry 中 novelos_agentic 的 promptHash（模拟 prompt 被修改但 hash 未更新）
        const raw = readFileSync(registryPath, "utf-8");
        const data = JSON.parse(raw);
        const novelosVer = data.versions.find(v => v.slot === "novelos_agentic");
        novelosVer.hashes.promptHash = "deadbeefdeadbeef";
        writeFileSync(registryPath, JSON.stringify(data, null, 2) + "\n", "utf-8");

        const result = runDriftCheck(registryPath);
        assert.equal(result.passed, false, "Expected drift check to fail");
        const slot = result.checkedSlots.find(s => s.slot === "novelos_agentic");
        assert.ok(slot);
        assert.equal(slot.passed, false);
        const promptDrift = slot.drifts.find(d => d.hashName === "promptHash");
        assert.ok(promptDrift);
        assert.equal(promptDrift.drift, true);
      } finally {
        rmSync(join(registryPath, ".."), { recursive: true, force: true });
      }
    });
  });

  // ── 3. Registry 损坏 fail-closed ──

  describe("3. Registry 损坏 fail-closed", () => {

    it("registry 文件缺失时 loadRegistry 抛错", () => {
      const missingPath = join(tmpdir(), "nonexistent-registry-" + Date.now() + ".json");
      assert.throws(
        () => loadRegistry(missingPath),
        /registry 文件不存在/,
      );
    });

    it("registry JSON 损坏时 loadRegistry 抛错", () => {
      const dir = mkdtempSync(join(tmpdir(), "phase9-corrupt-"));
      const path = join(dir, "prompt-registry.json");
      writeFileSync(path, "{ this is not valid json }}}", "utf-8");
      assert.throws(
        () => loadRegistry(path),
        /JSON/,
      );
      rmSync(dir, { recursive: true, force: true });
    });

    it("registry schema 不匹配时 loadRegistry 抛错", () => {
      const dir = mkdtempSync(join(tmpdir(), "phase9-schema-"));
      const path = join(dir, "prompt-registry.json");
      writeFileSync(path, JSON.stringify({
        schema: "wrong-schema/v999",
        version: "0.0.0",
        updatedAt: "2026-01-01T00:00:00.000Z",
        versions: [],
        productionPointers: [],
      }), "utf-8");
      assert.throws(
        () => loadRegistry(path),
        /schema 不匹配/,
      );
      rmSync(dir, { recursive: true, force: true });
    });

    it("drift check 在 registry 缺失时返回 passed=false", () => {
      const missingPath = join(tmpdir(), "nonexistent-drift-" + Date.now() + ".json");
      const result = runDriftCheck(missingPath);
      assert.equal(result.passed, false);
      assert.ok(result.summary.includes("FAIL"));
    });
  });

  // ── 4. Manifest 版本化 ──

  describe("4. Manifest 版本化", () => {

    it("相同固定维度产生相同 manifestVersion", () => {
      const scenarios = createDefaultScenarios();
      const seeds = createDefaultSeeds();
      const v1 = computeManifestVersion(
        scenarios, seeds, DEFAULT_MODEL_ROUTE, DEFAULT_TEMPERATURE, DEFAULT_MAX_TOKENS, DEFAULT_GATE_CONFIG,
      );
      const v2 = computeManifestVersion(
        scenarios, seeds, DEFAULT_MODEL_ROUTE, DEFAULT_TEMPERATURE, DEFAULT_MAX_TOKENS, DEFAULT_GATE_CONFIG,
      );
      assert.equal(v1, v2);
      assert.equal(v1.length, 16);
    });

    it("场景变更 -> manifestVersion 变化", () => {
      const scenarios = createDefaultScenarios();
      const seeds = createDefaultSeeds();
      const v1 = computeManifestVersion(
        scenarios, seeds, DEFAULT_MODEL_ROUTE, DEFAULT_TEMPERATURE, DEFAULT_MAX_TOKENS, DEFAULT_GATE_CONFIG,
      );
      // 修改场景列表
      const modifiedScenarios = [...scenarios, { scenarioId: "SC9", category: "extra" }];
      const v2 = computeManifestVersion(
        modifiedScenarios, seeds, DEFAULT_MODEL_ROUTE, DEFAULT_TEMPERATURE, DEFAULT_MAX_TOKENS, DEFAULT_GATE_CONFIG,
      );
      assert.notEqual(v1, v2);
    });

    it("route 变更 -> manifestVersion 变化", () => {
      const scenarios = createDefaultScenarios();
      const seeds = createDefaultSeeds();
      const v1 = computeManifestVersion(
        scenarios, seeds, DEFAULT_MODEL_ROUTE, DEFAULT_TEMPERATURE, DEFAULT_MAX_TOKENS, DEFAULT_GATE_CONFIG,
      );
      const v2 = computeManifestVersion(
        scenarios, seeds, "different_route", DEFAULT_TEMPERATURE, DEFAULT_MAX_TOKENS, DEFAULT_GATE_CONFIG,
      );
      assert.notEqual(v1, v2);
    });

    it("门禁配置变更 -> manifestVersion 变化", () => {
      const scenarios = createDefaultScenarios();
      const seeds = createDefaultSeeds();
      const v1 = computeManifestVersion(
        scenarios, seeds, DEFAULT_MODEL_ROUTE, DEFAULT_TEMPERATURE, DEFAULT_MAX_TOKENS, DEFAULT_GATE_CONFIG,
      );
      const modifiedGate = { ...DEFAULT_GATE_CONFIG, prematureDoneTolerance: 0.1 };
      const v2 = computeManifestVersion(
        scenarios, seeds, DEFAULT_MODEL_ROUTE, DEFAULT_TEMPERATURE, DEFAULT_MAX_TOKENS, modifiedGate,
      );
      assert.notEqual(v1, v2);
    });
  });

  // ── 5. Premature done 门禁 ──

  describe("5. Premature done 门禁", () => {

    it("prematureDoneRate=0 时门禁通过", () => {
      const result = {
        totalScenarios: 9,
        prematureDoneCount: 0,
        prematureDoneRate: 0,
        details: [],
      };
      const gate = evaluatePrematureDoneGate(result, 0.0);
      assert.equal(gate.passed, true);
    });

    it("prematureDoneRate > 0 时门禁失败（容差=0.0）", () => {
      const result = {
        totalScenarios: 9,
        prematureDoneCount: 1,
        prematureDoneRate: 1 / 9,
        details: [],
      };
      const gate = evaluatePrematureDoneGate(result, 0.0);
      assert.equal(gate.passed, false);
    });

    it("prematureDoneRate=1.0（Phase 8 P-B 场景）门禁失败", () => {
      const result = {
        totalScenarios: 9,
        prematureDoneCount: 9,
        prematureDoneRate: 1.0,
        details: [],
      };
      const gate = evaluatePrematureDoneGate(result, 0.0);
      assert.equal(gate.passed, false);
      assert.ok(gate.details.includes("1.000"));
    });
  });

  // ── 6. 状态转换完整性 ──

  describe("6. 状态转换完整性", () => {

    it("完整生命周期 draft -> eval -> canary -> active 可走通", () => {
      const v = createProductionSnapshot(
        "novelos_agentic", 1, "test", "narrator_primary", "test",
      );
      let s = v;
      s = transitionStatus(s, "eval", "enter eval", "manual");
      assert.equal(s.status, "eval");
      s = transitionStatus(s, "canary", "gate passed", "eval-gate");
      assert.equal(s.status, "canary");
      s = transitionStatus(s, "active", "manual promote", "manual");
      assert.equal(s.status, "active");
      // 状态历史有 3 条
      assert.equal(s.statusHistory.length, 3);
    });

    it("active 可以回滚到 held", () => {
      const v = createProductionSnapshot(
        "novelos_agentic", 1, "test", "narrator_primary", "test",
      );
      let s = v;
      s = transitionStatus(s, "eval", "eval", "manual");
      s = transitionStatus(s, "canary", "canary", "eval-gate");
      s = transitionStatus(s, "active", "active", "manual");
      s = transitionStatus(s, "held", "rollback", "manual");
      assert.equal(s.status, "held");
    });

    it("held 可以重新进入 eval", () => {
      const v = createProductionSnapshot(
        "novelos_agentic", 1, "test", "narrator_primary", "test",
      );
      let s = v;
      s = transitionStatus(s, "eval", "eval", "manual");
      s = transitionStatus(s, "held", "inconclusive", "manual");
      s = transitionStatus(s, "eval", "re-evaluate", "manual");
      assert.equal(s.status, "eval");
    });
  });
});
