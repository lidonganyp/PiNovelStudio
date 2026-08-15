/**
 * EVAL replay / production gate：仓库根 vs 扩展根路径解析。
 *
 * 复现：CLI 把 EXT_ROOT 传给 runner.projectRoot，gate 却按仓库根拼
 * `{projectRoot}/.pi/extensions/novel-studio/config/evolution-release`，
 * 实际 pointer 在 `{EXT_ROOT}/config/evolution-release`，production_like
 * 误报 no active production release set。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = resolve(__dirname, "..");
const REPO_ROOT = resolve(EXT_ROOT, "..", "..", "..");

const gateMod = await import("../dist-eval/v2/governance/production-release-gate.js");
const isolationMod = await import("../dist-eval/v2/core/eval-replay-isolation.js");
const runnerMod = await import("../dist-eval/eval/full-pipeline-replay-runner.js");

function writePointer(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "active-production.json"),
    JSON.stringify({
      schemaId: "pinovel.evolution-release-pointer",
      schemaVersion: 1,
      kind: "production",
      releaseId: "rel-prod-111",
      reason: "test pointer",
      actor: "user",
      switchedAt: "2026-08-15T00:00:00.000Z",
    }),
    "utf8",
  );
}

test("resolveProductionEvolutionRoot: 扩展根 layout 不得再套一层 .pi/extensions/novel-studio", () => {
  const root = mkdtempSync(join(tmpdir(), "ceg-ext-root-"));
  const prevDev = process.env.PINOVEL_DEV_MODE;
  const prevEvo = process.env.PINOVEL_EVOLUTION_ROOT;
  try {
    delete process.env.PINOVEL_DEV_MODE;
    delete process.env.PINOVEL_EVOLUTION_ROOT;
    const extLayout = join(root, "config", "evolution-release");
    writePointer(extLayout);

    assert.equal(typeof gateMod.resolveProductionEvolutionRoot, "function");
    const resolved = gateMod.resolveProductionEvolutionRoot(root);
    assert.equal(resolved, extLayout);
    assert.equal(
      resolved.includes(join(".pi", "extensions", "novel-studio", "config")),
      false,
      "扩展根作为 projectRoot 时不得再拼接仓库相对路径",
    );
  } finally {
    if (prevDev === undefined) delete process.env.PINOVEL_DEV_MODE;
    else process.env.PINOVEL_DEV_MODE = prevDev;
    if (prevEvo === undefined) delete process.env.PINOVEL_EVOLUTION_ROOT;
    else process.env.PINOVEL_EVOLUTION_ROOT = prevEvo;
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveProductionEvolutionRoot: 仓库根 layout 仍指向 .pi/extensions/novel-studio/config/evolution-release", () => {
  const root = mkdtempSync(join(tmpdir(), "ceg-repo-root-"));
  const prevEvo = process.env.PINOVEL_EVOLUTION_ROOT;
  try {
    delete process.env.PINOVEL_EVOLUTION_ROOT;
    const repoLayout = join(
      root,
      ".pi",
      "extensions",
      "novel-studio",
      "config",
      "evolution-release",
    );
    writePointer(repoLayout);
    const resolved = gateMod.resolveProductionEvolutionRoot(root);
    assert.equal(resolved, repoLayout);
  } finally {
    if (prevEvo === undefined) delete process.env.PINOVEL_EVOLUTION_ROOT;
    else process.env.PINOVEL_EVOLUTION_ROOT = prevEvo;
    rmSync(root, { recursive: true, force: true });
  }
});

test("evaluateProductionReleaseGate: 扩展根 projectRoot 能读到 active production pointer", () => {
  const root = mkdtempSync(join(tmpdir(), "ceg-gate-ext-"));
  const prevDev = process.env.PINOVEL_DEV_MODE;
  const prevEvo = process.env.PINOVEL_EVOLUTION_ROOT;
  try {
    delete process.env.PINOVEL_DEV_MODE;
    delete process.env.PINOVEL_EVOLUTION_ROOT;
    writePointer(join(root, "config", "evolution-release"));

    const result = gateMod.evaluateProductionReleaseGate({
      projectRoot: root,
      currentFingerprintHash: "test-fp",
    });
    assert.equal(result.ok, false);
    assert.match(
      result.failureEnvelope.reason,
      /manifest 不存在|status=|approvalRef|fingerprint/i,
      `找到 pointer 后应进入后续校验，不得再报 no active production release set；实际: ${result.failureEnvelope?.reason}`,
    );
    assert.doesNotMatch(result.failureEnvelope.reason, /no active production release set/i);
  } finally {
    if (prevDev === undefined) delete process.env.PINOVEL_DEV_MODE;
    else process.env.PINOVEL_DEV_MODE = prevDev;
    if (prevEvo === undefined) delete process.env.PINOVEL_EVOLUTION_ROOT;
    else process.env.PINOVEL_EVOLUTION_ROOT = prevEvo;
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveDefaultProductionSurfacePaths: 扩展根与仓库根都能定位真实 evolutionRoot", () => {
  const extRoot = mkdtempSync(join(tmpdir(), "ceg-surf-ext-"));
  const repoRoot = mkdtempSync(join(tmpdir(), "ceg-surf-repo-"));
  const prevEvo = process.env.PINOVEL_EVOLUTION_ROOT;
  try {
    delete process.env.PINOVEL_EVOLUTION_ROOT;
    const extLayout = join(extRoot, "config", "evolution-release");
    writePointer(extLayout);
    const repoLayout = join(
      repoRoot,
      ".pi",
      "extensions",
      "novel-studio",
      "config",
      "evolution-release",
    );
    writePointer(repoLayout);

    assert.equal(isolationMod.resolveDefaultProductionSurfacePaths(extRoot).evolutionRoot, extLayout);
    assert.equal(isolationMod.resolveDefaultProductionSurfacePaths(repoRoot).evolutionRoot, repoLayout);
  } finally {
    if (prevEvo === undefined) delete process.env.PINOVEL_EVOLUTION_ROOT;
    else process.env.PINOVEL_EVOLUTION_ROOT = prevEvo;
    rmSync(extRoot, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("CLI 必须把仓库根传给 runner.projectRoot，不得把 EXT_ROOT 当成仓库根", () => {
  const cli = readFileSync(join(EXT_ROOT, "scripts", "eval-full-pipeline-replay.mjs"), "utf8");
  assert.match(cli, /REPO_ROOT|resolveReplayRepoRoot|resolveRepoRoot/);
  assert.doesNotMatch(
    cli,
    /projectRoot:\s*EXT_ROOT/,
    "eval-full-pipeline-replay.mjs 不得再把 EXT_ROOT 直接传给 runner.projectRoot",
  );
  assert.ok(typeof runnerMod.resolveReplayRepoRoot === "function" || /REPO_ROOT/.test(cli));
  const resolved = typeof runnerMod.resolveReplayRepoRoot === "function"
    ? runnerMod.resolveReplayRepoRoot(EXT_ROOT)
    : REPO_ROOT;
  assert.equal(resolved, REPO_ROOT);
});
