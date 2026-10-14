/**
 * REGISTRY-IDENTITY-PROMOTE-1 — Baseline 晋级命令证据与授权校验测试
 *
 * 审计 P1-2：晋级必须校验真实评测证据（报告 bundleId 与版本身份绑定）
 * 与显式人工授权；任一缺失 fail-closed 阻断，registry 不被修改。
 *
 * 通过 spawnSync 在隔离副本上运行 scripts/prompt-bundle-baseline-promote.mjs，
 * 不触碰真实 config/prompt-registry.json。
 *
 * eval-only。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const EXT_ROOT = join(dirname(__filename), "..");
const PROMOTE_SCRIPT = join(EXT_ROOT, "scripts", "prompt-bundle-baseline-promote.mjs");

const registryMod = await import("../dist-eval/novelos/eval/prompt-registry.js");
const manifestMod = await import("../dist-eval/novelos/eval/prompt-bundle-manifest.js");

let tmpDir;
let registryPath;
let draftVersionId;
let bundleId;
let reportPath;

/** 构建含一个 draft（带 bundleManifest）+ 一个旧 active 的隔离 registry */
function buildFixture() {
  let registry = registryMod.createEmptyRegistry();

  // 旧 active 版本（无证据，模拟现状）
  let oldActive = registryMod.createProductionSnapshot(
    "novelos_agentic", 1, "old-active", "v2_rawstage2_gemini31",
    registryMod.PRODUCTION_NOVELOS_PROMPT,
  );
  oldActive = registryMod.transitionStatus(oldActive, "eval", "fixture", "manual");
  oldActive = registryMod.transitionStatus(oldActive, "canary", "fixture", "manual");
  oldActive = registryMod.transitionStatus(oldActive, "active", "fixture", "manual");
  registry = registryMod.addVersion(registry, oldActive);
  registry = registryMod.setProductionPointer(registry, "novelos_agentic", oldActive.versionId);

  // 待晋级 draft：借用真实采集的 bundleManifest（保证 bundleId 可绑定）
  const manifest = manifestMod.computeBundleManifest({
    modelVersion: "gemini-3.8-flash",
    provider: "gemini",
    route: "v2_rawstage2_gemini31",
    profileId: "gemini_writer_v2",
    systemPrompt: "sys",
    userPromptRenderer: "r",
    chapterContractRenderer: "c",
    toolSchema: "t",
    toolProtocol: "p",
    contextCompiler: "x",
    outputParser: "o",
    terminationProtocol: "e",
    providerCapability: { nativeSystemInstruction: true },
    budget: "b",
    temperature: 0.72,
    maxTokens: 16384,
  }, "draft");
  bundleId = manifest.bundleId;

  const draft = registryMod.createProductionSnapshot(
    "novelos_agentic", 2, "draft-to-promote", "v2_rawstage2_gemini31",
    registryMod.PRODUCTION_NOVELOS_PROMPT, undefined, manifest,
  );
  registry = registryMod.addVersion(registry, draft);
  draftVersionId = draft.versionId;

  registryPath = join(tmpDir, "registry.json");
  registryMod.saveRegistry(registry, registryPath);
}

function runPromote(extraArgs) {
  const args = [
    PROMOTE_SCRIPT,
    "--slot", "novelos_agentic",
    "--version", draftVersionId,
    "--eval-report", reportPath,
    "--eval-manifest", "test-manifest-id",
    "--approved-by", "tester",
    "--approval-reason", "测试授权",
    "--registry", registryPath,
    ...extraArgs,
  ];
  return spawnSync(process.execPath, args, { encoding: "utf-8" });
}

function loadFixtureRegistry() {
  return JSON.parse(readFileSync(registryPath, "utf-8"));
}

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pinovel-promote-"));
  buildFixture();
  reportPath = join(tmpDir, "eval-report.json");
  writeFileSync(reportPath, JSON.stringify({ bundleId, metrics: { pass: true } }), "utf-8");
});

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("REGISTRY-IDENTITY-PROMOTE-1: fail-closed 校验", () => {

  it("缺 --approved-by → exit 1 且 registry 未被修改", () => {
    const before = readFileSync(registryPath, "utf-8");
    // 覆盖 approved-by 为空
    const res = spawnSync(process.execPath, [
      PROMOTE_SCRIPT,
      "--slot", "novelos_agentic",
      "--version", draftVersionId,
      "--eval-report", reportPath,
      "--eval-manifest", "m",
      "--approved-by", "",
      "--approval-reason", "r",
      "--registry", registryPath,
    ], { encoding: "utf-8" });
    assert.equal(res.status, 1);
    assert.ok(res.stderr.includes("approved-by"), res.stderr);
    assert.equal(readFileSync(registryPath, "utf-8"), before, "registry 必须未被修改");
  });

  it("评测报告不存在 → exit 1 且 registry 未被修改", () => {
    const before = readFileSync(registryPath, "utf-8");
    const resMissing = spawnSync(process.execPath, [
      PROMOTE_SCRIPT,
      "--slot", "novelos_agentic",
      "--version", draftVersionId,
      "--eval-report", join(tmpDir, "not-exist.json"),
      "--eval-manifest", "m",
      "--approved-by", "tester",
      "--approval-reason", "r",
      "--registry", registryPath,
    ], { encoding: "utf-8" });
    assert.equal(resMissing.status, 1);
    assert.ok(resMissing.stderr.includes("不存在"), resMissing.stderr);
    assert.equal(readFileSync(registryPath, "utf-8"), before);
  });

  it("报告不含 bundleId 字段 → exit 1（证据无法绑定身份）", () => {
    const noIdReport = join(tmpDir, "report-no-bundleid.json");
    writeFileSync(noIdReport, JSON.stringify({ metrics: { pass: true } }), "utf-8");
    const res = spawnSync(process.execPath, [
      PROMOTE_SCRIPT,
      "--slot", "novelos_agentic",
      "--version", draftVersionId,
      "--eval-report", noIdReport,
      "--eval-manifest", "m",
      "--approved-by", "tester",
      "--approval-reason", "r",
      "--registry", registryPath,
    ], { encoding: "utf-8" });
    assert.equal(res.status, 1);
    assert.ok(res.stderr.includes("bundleId"), res.stderr);
  });

  it("报告 bundleId 与版本不一致 → exit 1（证据不属于该版本）", () => {
    const wrongIdReport = join(tmpDir, "report-wrong-bundleid.json");
    writeFileSync(wrongIdReport, JSON.stringify({ bundleId: "f".repeat(64) }), "utf-8");
    const res = spawnSync(process.execPath, [
      PROMOTE_SCRIPT,
      "--slot", "novelos_agentic",
      "--version", draftVersionId,
      "--eval-report", wrongIdReport,
      "--eval-manifest", "m",
      "--approved-by", "tester",
      "--approval-reason", "r",
      "--registry", registryPath,
    ], { encoding: "utf-8" });
    assert.equal(res.status, 1);
    assert.ok(res.stderr.includes("不一致"), res.stderr);
  });

  it("版本状态非 draft（旧 active）→ exit 1", () => {
    const res = spawnSync(process.execPath, [
      PROMOTE_SCRIPT,
      "--slot", "novelos_agentic",
      "--version", "novelos_agentic-v1",
      "--eval-report", reportPath,
      "--eval-manifest", "m",
      "--approved-by", "tester",
      "--approval-reason", "r",
      "--registry", registryPath,
    ], { encoding: "utf-8" });
    assert.equal(res.status, 1);
    assert.ok(res.stderr.includes("draft"), res.stderr);
  });
});

describe("REGISTRY-IDENTITY-PROMOTE-1: 正向晋级", () => {

  it("完整证据 + 授权 → exit 0，draft→active、证据绑定、旧 active held、指针切换", () => {
    const res = runPromote([]);
    assert.equal(res.status, 0, `stdout: ${res.stdout}\nstderr: ${res.stderr}`);

    const registry = loadFixtureRegistry();
    const promoted = registry.versions.find((v) => v.versionId === draftVersionId);
    assert.equal(promoted.status, "active");
    assert.equal(promoted.evalReportPath, reportPath);
    assert.equal(promoted.evalManifestId, "test-manifest-id");
    // 状态链含授权信息
    const activeTransition = promoted.statusHistory.find((t) => t.to === "active");
    assert.ok(activeTransition.reason.includes("tester"), activeTransition.reason);
    assert.ok(activeTransition.reason.includes("测试授权"));

    // 旧 active → held
    const oldActive = registry.versions.find((v) => v.versionId === "novelos_agentic-v1");
    assert.equal(oldActive.status, "held");

    // 指针切换
    const pointer = registry.productionPointers.find((p) => p.slot === "novelos_agentic");
    assert.equal(pointer.activeVersionId, draftVersionId);
  });

  it("晋级后重复晋级同一版本 → exit 1（已非 draft，幂等保护）", () => {
    const res = runPromote([]);
    assert.equal(res.status, 1);
    assert.ok(res.stderr.includes("draft"), res.stderr);
  });
});
