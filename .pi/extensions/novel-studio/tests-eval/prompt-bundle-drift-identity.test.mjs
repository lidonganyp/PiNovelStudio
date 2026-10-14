/**
 * REGISTRY-DRIFT-IDENTITY-1 — Bundle 漂移检查完整身份 负向验证测试
 *
 * 验证漂移检查不只比较组件 hash，还比较模型/路由/采样身份：
 * - modelVersion / provider / route / profileId / temperature / maxTokens /
 *   bundleId 任一漂移 → FAIL
 * - 未知生产路由（model-routing 缺条目）→ FAIL（fail-closed）
 * - 缺 bundle baseline → FAIL（fail-closed，不降级为成功）
 * - 采集器按 slot 采集：不同 slot 的 systemPromptHash 不同
 *
 * 测试用合成 model-routing.json + 合成 registry（从当前生产源码封存），
 * 不依赖真实 config/prompt-registry.json 的当前状态。
 *
 * eval-only。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const EXT_ROOT = join(dirname(__filename), "..");

const driftMod = await import("../dist-eval/novelos/eval/prompt-registry-drift-check.js");
const registryMod = await import("../dist-eval/novelos/eval/prompt-registry.js");

const {
  runBundleDriftCheck,
  computeCurrentBundle,
  SLOT_PRODUCTION_ROUTES,
} = driftMod;
const {
  createEmptyRegistry,
  createProductionSnapshot,
  addVersion,
  transitionStatus,
  setProductionPointer,
  saveRegistry,
  PRODUCTION_NOVELOS_PROMPT,
  PRODUCTION_STYLE_PROMPT,
  PRODUCTION_WRITER_PROMPT,
  EVAL_BASELINE_RETRIEVAL_PROMPT,
} = registryMod;

const SLOTS = ["novelos_agentic", "style_optimizer", "writer_adapter", "retrieval_eval"];

const SLOT_PROMPTS = {
  novelos_agentic: PRODUCTION_NOVELOS_PROMPT,
  style_optimizer: PRODUCTION_STYLE_PROMPT,
  writer_adapter: PRODUCTION_WRITER_PROMPT,
  retrieval_eval: EVAL_BASELINE_RETRIEVAL_PROMPT,
};

// ============================================================================
// 辅助：合成 model-routing + 封存 registry
// ============================================================================

/** 合成 model-routing（结构与 config/model-routing.json 一致：provider 级 per-route 采样） */
function makeBaseRouting() {
  return {
    providers: {
      gemini31: {
        model: "gemini-3.8-flash",
        temperature: {
          v2_rawstage2_gemini31: 0.72,
          v2_amplified_gemini31: 0.6,
          narrator_primary: 0.72,
        },
        max_tokens: {
          v2_rawstage2_gemini31: 16384,
          v2_amplified_gemini31: 16384,
          narrator_primary: 16384,
        },
      },
    },
    agent_routing: {
      v2_rawstage2_gemini31: { provider: "gemini31", model: "gemini-3.8-flash", fallback: [] },
      v2_amplified_gemini31: { provider: "gemini31", model: "gemini-3.8-flash", fallback: [] },
      narrator_primary: { provider: "gemini31", model: "gemini-3.8-flash", fallback: [] },
    },
  };
}

let tmpDir;

function writeRouting(routing) {
  const path = join(tmpDir, `routing-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(routing, null, 2), "utf-8");
  return path;
}

/**
 * 从当前生产源码 + 给定 routing 封存 registry：
 * 对每个 slot 采集 current bundle，经 draft→eval→canary→active 封存为 active 版本。
 */
function sealRegistry(routingPath) {
  let registry = createEmptyRegistry();
  for (const slot of SLOTS) {
    const current = computeCurrentBundle({ workspaceRoot: EXT_ROOT, routingPath, slot });
    assert.ok(current, `封存失败：${slot} 身份无法从合成 routing 解析`);
    let version = createProductionSnapshot(
      slot, 1, `test-${slot}`, current.identity.route, SLOT_PROMPTS[slot],
      undefined, current.manifest,
    );
    version = transitionStatus(version, "eval", "test: 进入评测", "manual");
    version = transitionStatus(version, "canary", "test: 金丝雀", "manual");
    version = transitionStatus(version, "active", "test: 人工晋级", "manual");
    registry = addVersion(registry, version);
    registry = setProductionPointer(registry, slot, version.versionId);
  }
  const registryPath = join(tmpDir, `registry-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  saveRegistry(registry, registryPath);
  return { registry, registryPath };
}

/** 封存后对 registry 做受控变异，重写文件 */
function mutateAndSave(registry, mutation) {
  let mutated = structuredClone(registry);
  mutated = mutation(mutated);
  const path = join(tmpDir, `registry-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  saveRegistry(mutated, path);
  return path;
}

/** 找到 slot 的 active 版本对象（供变异） */
function activeVersionOf(registry, slot) {
  const pointer = registry.productionPointers.find((p) => p.slot === slot);
  return registry.versions.find((v) => v.versionId === pointer.activeVersionId);
}

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pinovel-drift-identity-"));
});

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================================
// 正向基线：合成 routing 与封存 registry 一致 → 全部 PASS
// ============================================================================

describe("REGISTRY-DRIFT-IDENTITY-1: 正向基线", () => {

  it("身份一致的封存 registry 全部 4 slot PASS（含身份字段核对）", () => {
    const routingPath = writeRouting(makeBaseRouting());
    const { registryPath } = sealRegistry(routingPath);
    const result = runBundleDriftCheck(registryPath, {
      workspaceRoot: EXT_ROOT,
      routingPath,
    });

    assert.equal(result.passed, true, `summary: ${result.summary}`);
    assert.equal(result.checkedSlots.length, 4);
    for (const s of result.checkedSlots) {
      assert.equal(s.passed, true, `${s.slot} 应 PASS`);
      assert.equal(s.unknownRoute, false);
      assert.equal(s.hasBaseline, true);
    }

    // 身份按 slot 从 routing 解析（novelos_agentic 与 style_optimizer 采样不同）
    const agentic = result.checkedSlots.find((s) => s.slot === "novelos_agentic");
    const style = result.checkedSlots.find((s) => s.slot === "style_optimizer");
    const agenticTemp = agentic.identityDrifts.find((d) => d.field === "temperature");
    const styleTemp = style.identityDrifts.find((d) => d.field === "temperature");
    assert.equal(agenticTemp.expected, "0.72");
    assert.equal(styleTemp.expected, "0.6");
  });

  it("SLOT_PRODUCTION_ROUTES 声明 4 个 slot 的生产路由", () => {
    assert.equal(SLOT_PRODUCTION_ROUTES.novelos_agentic, "v2_rawstage2_gemini31");
    assert.equal(SLOT_PRODUCTION_ROUTES.style_optimizer, "v2_amplified_gemini31");
    assert.equal(SLOT_PRODUCTION_ROUTES.writer_adapter, "v2_rawstage2_gemini31");
    assert.equal(SLOT_PRODUCTION_ROUTES.retrieval_eval, "narrator_primary");
  });
});

// ============================================================================
// 负向：模型/路由/采样身份漂移必须 FAIL
// ============================================================================

describe("REGISTRY-DRIFT-IDENTITY-1: 身份漂移负向用例", () => {

  it("modelVersion 变化 → FAIL 且 identityDrifts 命中 modelVersion", () => {
    const routing = makeBaseRouting();
    routing.agent_routing.v2_rawstage2_gemini31.model = "gemini-4.0-flash";
    const routingPath = writeRouting(routing);
    const { registryPath } = sealRegistry(writeRouting(makeBaseRouting()));

    const result = runBundleDriftCheck(registryPath, { workspaceRoot: EXT_ROOT, routingPath });
    assert.equal(result.passed, false);

    const agentic = result.checkedSlots.find((s) => s.slot === "novelos_agentic");
    assert.equal(agentic.passed, false);
    const driftFields = agentic.identityDrifts.filter((d) => d.drift).map((d) => d.field);
    assert.ok(driftFields.includes("modelVersion"), `实际: ${driftFields.join(",")}`);
    // writer_adapter 共用同一路由，也必须失败
    const writer = result.checkedSlots.find((s) => s.slot === "writer_adapter");
    assert.equal(writer.passed, false);
  });

  it("temperature 变化 → FAIL 且 identityDrifts 命中 temperature", () => {
    const routing = makeBaseRouting();
    routing.providers.gemini31.temperature.v2_amplified_gemini31 = 0.9;
    const routingPath = writeRouting(routing);
    const { registryPath } = sealRegistry(writeRouting(makeBaseRouting()));

    const result = runBundleDriftCheck(registryPath, { workspaceRoot: EXT_ROOT, routingPath });
    assert.equal(result.passed, false);

    const style = result.checkedSlots.find((s) => s.slot === "style_optimizer");
    assert.equal(style.passed, false);
    const driftFields = style.identityDrifts.filter((d) => d.drift).map((d) => d.field);
    assert.ok(driftFields.includes("temperature"), `实际: ${driftFields.join(",")}`);
    // 其他 slot 的 route 不受影响
    const agentic = result.checkedSlots.find((s) => s.slot === "novelos_agentic");
    assert.equal(agentic.passed, true);
  });

  it("maxTokens 变化 → FAIL 且 identityDrifts 命中 maxTokens", () => {
    const routing = makeBaseRouting();
    routing.providers.gemini31.max_tokens.narrator_primary = 4096;
    const routingPath = writeRouting(routing);
    const { registryPath } = sealRegistry(writeRouting(makeBaseRouting()));

    const result = runBundleDriftCheck(registryPath, { workspaceRoot: EXT_ROOT, routingPath });
    assert.equal(result.passed, false);

    const retrieval = result.checkedSlots.find((s) => s.slot === "retrieval_eval");
    assert.equal(retrieval.passed, false);
    const driftFields = retrieval.identityDrifts.filter((d) => d.drift).map((d) => d.field);
    assert.ok(driftFields.includes("maxTokens"), `实际: ${driftFields.join(",")}`);
  });

  it("provider 变化 → FAIL 且 identityDrifts 命中 provider", () => {
    const routing = makeBaseRouting();
    // 第二个 provider，同模型不同 provider 键（隔离 provider 字段本身）
    routing.providers["gemini-pro"] = {
      model: "gemini-3.8-flash",
      temperature: { narrator_primary: 0.72 },
      max_tokens: { narrator_primary: 16384 },
    };
    routing.agent_routing.narrator_primary.provider = "gemini-pro";
    const routingPath = writeRouting(routing);
    const { registryPath } = sealRegistry(writeRouting(makeBaseRouting()));

    const result = runBundleDriftCheck(registryPath, { workspaceRoot: EXT_ROOT, routingPath });
    assert.equal(result.passed, false);

    const retrieval = result.checkedSlots.find((s) => s.slot === "retrieval_eval");
    assert.equal(retrieval.passed, false);
    const driftFields = retrieval.identityDrifts.filter((d) => d.drift).map((d) => d.field);
    assert.ok(driftFields.includes("provider"), `实际: ${driftFields.join(",")}`);
  });

  it("未知生产路由（routing 缺条目）→ FAIL 且 unknownRoute=true（fail-closed）", () => {
    const routing = makeBaseRouting();
    delete routing.agent_routing.v2_rawstage2_gemini31;
    const routingPath = writeRouting(routing);
    const { registryPath } = sealRegistry(writeRouting(makeBaseRouting()));

    const result = runBundleDriftCheck(registryPath, { workspaceRoot: EXT_ROOT, routingPath });
    assert.equal(result.passed, false);

    const agentic = result.checkedSlots.find((s) => s.slot === "novelos_agentic");
    assert.equal(agentic.unknownRoute, true);
    assert.equal(agentic.passed, false);
    assert.ok(result.summary.includes("未知生产路由"), result.summary);
  });
});

// ============================================================================
// 负向：baseline 侧身份/组件漂移必须 FAIL
// ============================================================================

describe("REGISTRY-DRIFT-IDENTITY-1: baseline 漂移负向用例", () => {

  it("baseline route 与 SLOT_PRODUCTION_ROUTES 不符 → FAIL 且命中 route", () => {
    const routingPath = writeRouting(makeBaseRouting());
    const { registry } = sealRegistry(routingPath);
    const mutatedPath = mutateAndSave(registry, (reg) => {
      const v = activeVersionOf(reg, "novelos_agentic");
      v.bundleManifest.route = "made_up_route";
      return reg;
    });

    const result = runBundleDriftCheck(mutatedPath, { workspaceRoot: EXT_ROOT, routingPath });
    assert.equal(result.passed, false);
    const agentic = result.checkedSlots.find((s) => s.slot === "novelos_agentic");
    const driftFields = agentic.identityDrifts.filter((d) => d.drift).map((d) => d.field);
    assert.ok(driftFields.includes("route"), `实际: ${driftFields.join(",")}`);
  });

  it("baseline profileId 变化 → FAIL 且命中 profileId", () => {
    const routingPath = writeRouting(makeBaseRouting());
    const { registry } = sealRegistry(routingPath);
    const mutatedPath = mutateAndSave(registry, (reg) => {
      const v = activeVersionOf(reg, "style_optimizer");
      v.bundleManifest.profileId = "gemini_writer_v1";
      return reg;
    });

    const result = runBundleDriftCheck(mutatedPath, { workspaceRoot: EXT_ROOT, routingPath });
    assert.equal(result.passed, false);
    const style = result.checkedSlots.find((s) => s.slot === "style_optimizer");
    const driftFields = style.identityDrifts.filter((d) => d.drift).map((d) => d.field);
    assert.ok(driftFields.includes("profileId"), `实际: ${driftFields.join(",")}`);
  });

  it("baseline systemPromptHash 变化 → FAIL 且命中 system_prompt 组件", () => {
    const routingPath = writeRouting(makeBaseRouting());
    const { registry } = sealRegistry(routingPath);
    const mutatedPath = mutateAndSave(registry, (reg) => {
      const v = activeVersionOf(reg, "novelos_agentic");
      v.bundleManifest.systemPromptHash = "0".repeat(64);
      return reg;
    });

    const result = runBundleDriftCheck(mutatedPath, { workspaceRoot: EXT_ROOT, routingPath });
    assert.equal(result.passed, false);
    const agentic = result.checkedSlots.find((s) => s.slot === "novelos_agentic");
    const drifted = agentic.drifts.filter((d) => d.drift).map((d) => d.component);
    assert.ok(drifted.includes("systemPromptHash"), `实际: ${drifted.join(",")}`);
  });

  it("baseline userPromptRendererHash 变化 → FAIL 且命中 user_prompt_renderer 组件", () => {
    const routingPath = writeRouting(makeBaseRouting());
    const { registry } = sealRegistry(routingPath);
    const mutatedPath = mutateAndSave(registry, (reg) => {
      const v = activeVersionOf(reg, "writer_adapter");
      v.bundleManifest.userPromptRendererHash = "f".repeat(64);
      return reg;
    });

    const result = runBundleDriftCheck(mutatedPath, { workspaceRoot: EXT_ROOT, routingPath });
    assert.equal(result.passed, false);
    const writer = result.checkedSlots.find((s) => s.slot === "writer_adapter");
    const drifted = writer.drifts.filter((d) => d.drift).map((d) => d.component);
    assert.ok(drifted.includes("userPromptRendererHash"), `实际: ${drifted.join(",")}`);
  });

  it("缺 bundle baseline（active 版本未存 manifest）→ FAIL 且 hasBaseline=false（fail-closed）", () => {
    const routingPath = writeRouting(makeBaseRouting());
    const { registry } = sealRegistry(routingPath);
    const mutatedPath = mutateAndSave(registry, (reg) => {
      const v = activeVersionOf(reg, "retrieval_eval");
      delete v.bundleManifest;
      return reg;
    });

    const result = runBundleDriftCheck(mutatedPath, { workspaceRoot: EXT_ROOT, routingPath });
    assert.equal(result.passed, false);
    const retrieval = result.checkedSlots.find((s) => s.slot === "retrieval_eval");
    assert.equal(retrieval.hasBaseline, false);
    assert.equal(retrieval.passed, false);
    assert.ok(result.summary.includes("无 bundle baseline"), result.summary);
  });

  it("缺生产指针（slot 无 active 版本）→ FAIL（fail-closed）", () => {
    const routingPath = writeRouting(makeBaseRouting());
    const { registry } = sealRegistry(routingPath);
    const mutatedPath = mutateAndSave(registry, (reg) => {
      reg.productionPointers = reg.productionPointers.filter((p) => p.slot !== "style_optimizer");
      return reg;
    });

    const result = runBundleDriftCheck(mutatedPath, { workspaceRoot: EXT_ROOT, routingPath });
    assert.equal(result.passed, false);
    const style = result.checkedSlots.find((s) => s.slot === "style_optimizer");
    assert.equal(style.versionId, "(none)");
    assert.equal(style.passed, false);
  });
});

// ============================================================================
// 采集器按 slot 采集（不同 slot 的 systemPrompt / 实现文件不同）
// ============================================================================

describe("REGISTRY-DRIFT-IDENTITY-1: 按 slot 采集隔离", () => {

  it("novelos_agentic 与 style_optimizer 的 systemPromptHash 不同（per-slot 系统提示）", () => {
    const routingPath = writeRouting(makeBaseRouting());
    const agentic = computeCurrentBundle({ workspaceRoot: EXT_ROOT, routingPath, slot: "novelos_agentic" });
    const style = computeCurrentBundle({ workspaceRoot: EXT_ROOT, routingPath, slot: "style_optimizer" });
    assert.ok(agentic && style);
    assert.notEqual(
      agentic.manifest.systemPromptHash,
      style.manifest.systemPromptHash,
      "不同 slot 的系统提示指纹必须不同（旧缺陷：全部 slot 统一用 NovelOS 提示）",
    );
  });

  it("writer_adapter 与 retrieval_eval 的 userPromptRendererHash 不同（per-slot 实现文件）", () => {
    const routingPath = writeRouting(makeBaseRouting());
    const writer = computeCurrentBundle({ workspaceRoot: EXT_ROOT, routingPath, slot: "writer_adapter" });
    const retrieval = computeCurrentBundle({ workspaceRoot: EXT_ROOT, routingPath, slot: "retrieval_eval" });
    assert.ok(writer && retrieval);
    assert.notEqual(
      writer.manifest.userPromptRendererHash,
      retrieval.manifest.userPromptRendererHash,
      "不同 slot 的 renderer 指纹必须不同",
    );
  });

  it("同一 slot 重复采集确定性一致（bundleId 可复现）", () => {
    const routingPath = writeRouting(makeBaseRouting());
    const a = computeCurrentBundle({ workspaceRoot: EXT_ROOT, routingPath, slot: "novelos_agentic" });
    const b = computeCurrentBundle({ workspaceRoot: EXT_ROOT, routingPath, slot: "novelos_agentic" });
    assert.equal(a.manifest.bundleId, b.manifest.bundleId);
  });
});
