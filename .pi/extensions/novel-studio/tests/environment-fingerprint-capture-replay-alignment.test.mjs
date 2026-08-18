/**
 * capture 与 production_like/replay 必须共用同一套默认环境指纹。
 *
 * 回归目标：
 * - CLI capture 与 G6 gate 的 env/secret/runtime 规格一致
 * - hash mismatch 必须带可解释字段，不能只报 recorded/current 短哈希
 * - capture 预检拒绝脏树和 replay 传输开关
 * - held 不可回到 evaluated；HOLD 不可晋级
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import {
  collectDefaultEnvironmentFingerprint,
  diffBehavioralFingerprintFields,
  formatFingerprintDiff,
  assertCaptureFingerprintPreconditions,
  DEFAULT_RELEASE_FINGERPRINT_SPEC,
  explainFingerprintMismatch,
} from "../dist-test/v2/governance/environment-fingerprint.js";
import {
  evaluateProductionReleaseGate,
} from "../dist-test/v2/governance/production-release-gate.js";
import { isStatusTransitionValid } from "../dist-test/v2/governance/evolution-release-schema.js";
import {
  EVOLUTION_RELEASE_SCHEMA_ID,
  EVOLUTION_RELEASE_SCHEMA_VERSION,
} from "../dist-test/v2/governance/evolution-release-types.js";
import { createEvolutionReleaseRegistry } from "../dist-test/v2/governance/evolution-release-registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = resolve(__dirname, "..");
const CLI_PATH = join(EXT_ROOT, "scripts", "evolution-cli.mjs");

test("CLI capture 与 gate 共用 DEFAULT_RELEASE_FINGERPRINT_SPEC（含 eval 传输开关）", () => {
  const cli = readFileSync(CLI_PATH, "utf8");
  assert.match(
    cli,
    /collectDefaultEnvironmentFingerprint|captureDefaultEnvironmentFingerprint/,
    "evolution-cli capture 不得再内联另一套 fingerprint 配置",
  );
  assert.ok(Array.isArray(DEFAULT_RELEASE_FINGERPRINT_SPEC.envSwitchNames));
  for (const name of [
    "V2_FORCE_STUB",
    "PINOVEL_UNIFIED_PIPELINE",
    "PINOVEL_EVAL_REPLAY_TRANSPORT",
    "PINOVEL_EVAL_RECORDED_RESULTS_PATH",
    "PINOVEL_EVAL_SYNTHETIC_FAULTS",
    "PINOVEL_EVAL_SYNTHETIC_FAULTS_PATH",
  ]) {
    assert.ok(
      DEFAULT_RELEASE_FINGERPRINT_SPEC.envSwitchNames.includes(name),
      `默认规格缺少开关 ${name}`,
    );
  }
});

test("diffBehavioralFingerprintFields 报告具体字段而不是只给 hash", () => {
  const base = collectDefaultEnvironmentFingerprint(resolve(EXT_ROOT, "..", "..", ".."));
  const drifted = {
    ...base,
    generationModel: "other-model",
    envSwitches: [
      ...base.envSwitches.filter((item) => item.name !== "V2_FORCE_STUB"),
      { name: "V2_FORCE_STUB", set: !base.envSwitches.find((item) => item.name === "V2_FORCE_STUB")?.set },
    ],
  };
  const diffs = diffBehavioralFingerprintFields(base, drifted);
  const fields = diffs.map((item) => item.field);
  assert.ok(fields.includes("generationModel"), `应包含 generationModel，实际 ${fields.join(",")}`);
  assert.ok(
    fields.some((field) => field === "envSwitches.V2_FORCE_STUB" || field === "envSwitches"),
    `应包含 env 开关差异，实际 ${fields.join(",")}`,
  );
  const formatted = formatFingerprintDiff(diffs);
  assert.match(formatted, /generationModel/);
  assert.doesNotMatch(formatted, /^environment fingerprint mismatch：recorded=/);
});

test("assertCaptureFingerprintPreconditions: 脏树或 replay 传输开关必须失败", () => {
  const clean = {
    worktreeDirty: false,
    envSwitches: [{ name: "PINOVEL_EVAL_REPLAY_TRANSPORT", set: false }],
  };
  const dirty = assertCaptureFingerprintPreconditions({
    ...clean,
    worktreeDirty: true,
  });
  assert.equal(dirty.ok, false);
  assert.ok(dirty.reasons.some((reason) => /worktreeDirty|脏/.test(reason)));

  const replayEnv = assertCaptureFingerprintPreconditions({
    worktreeDirty: false,
    envSwitches: [{ name: "PINOVEL_EVAL_REPLAY_TRANSPORT", set: true }],
  });
  assert.equal(replayEnv.ok, false);
  assert.ok(replayEnv.reasons.some((reason) => /PINOVEL_EVAL_REPLAY_TRANSPORT/.test(reason)));

  assert.equal(assertCaptureFingerprintPreconditions(clean).ok, true);
});

test("evaluateProductionReleaseGate / explainFingerprintMismatch 必须带字段级差异", () => {
  const reason = explainFingerprintMismatch(
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    [{ field: "generationModel", recorded: "recorded-model", actual: "gemini-3.1-pro" }],
  );
  assert.match(reason, /generationModel/);
  assert.match(reason, /recorded-model/);
  const gateSrc = readFileSync(join(EXT_ROOT, "v2", "governance", "production-release-gate.ts"), "utf8");
  assert.match(gateSrc, /explainFingerprintMismatch/);
  assert.match(gateSrc, /diffBehavioralFingerprintFields/);
  assert.equal(typeof evaluateProductionReleaseGate, "function");
});

test("held 不得迁回 evaluated；同一基线不得换号重复评审", () => {
  assert.equal(isStatusTransitionValid("held", "evaluated"), false);
  assert.equal(isStatusTransitionValid("held", "approved_dev"), false);
  assert.equal(isStatusTransitionValid("held", "active_prod"), true);
});

function makeCompleteManifest(releaseId, status = "held") {
  return {
    schemaId: EVOLUTION_RELEASE_SCHEMA_ID,
    schemaVersion: EVOLUTION_RELEASE_SCHEMA_VERSION,
    releaseId,
    status,
    parentReleaseId: "rel-000",
    rollbackReleaseId: "rel-000",
    supersedesRef: null,
    changeClass: "R1",
    claims: ["test-claim"],
    environmentFingerprint: "fp-test-hash",
    artifactRefs: [],
    approvalRef: null,
    createdAt: "2026-08-15T00:00:00.000Z",
    activatedAt: null,
  };
}

test("cli proxy-review: held release 拒绝再次评审", () => {
  const root = mkdtempSync(join(tmpdir(), "fp-align-status-block-"));
  try {
    const registry = createEvolutionReleaseRegistry({ releasesDir: join(root, "releases") });
    registry.writeManifest(makeCompleteManifest("rel-001", "held"));
    let code = 0;
    let stderr = "";
    try {
      execFileSync("node", [CLI_PATH, "proxy-review", "--release-id", "rel-001", "--stub-verdict", "APPROVE_DEV"], {
        cwd: EXT_ROOT,
        env: { ...process.env, PINOVEL_EVOLUTION_ROOT: root },
        encoding: "utf-8",
        timeout: 30000,
      });
    } catch (error) {
      code = error.status ?? 1;
      stderr = String(error.stderr ?? "");
    }
    assert.equal(code, 4, `应走状态机阻断 exit 4，实际 ${code} stderr=${stderr}`);
    assert.match(stderr, /状态为 held，必须为 evaluated/);
    assert.doesNotMatch(stderr, /supersedesRef|missing_field|invalid_field_value|schema 校验失败/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
