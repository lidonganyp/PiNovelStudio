/**
 * 发布门禁正式回归：环境指纹对齐、held 状态机、CLI 结构化阻断。
 *
 * 本文件是可复现提交的正式回归入口。不得用临时路径文本冒充状态机断言。
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
  DEFAULT_RELEASE_FINGERPRINT_SPEC,
  explainFingerprintMismatch,
} from "../dist-test/v2/governance/environment-fingerprint.js";
import { isStatusTransitionValid } from "../dist-test/v2/governance/evolution-release-schema.js";
import {
  EVOLUTION_RELEASE_SCHEMA_ID,
  EVOLUTION_RELEASE_SCHEMA_VERSION,
} from "../dist-test/v2/governance/evolution-release-types.js";
import { createEvolutionReleaseRegistry } from "../dist-test/v2/governance/evolution-release-registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = resolve(__dirname, "..");
const CLI_PATH = join(EXT_ROOT, "scripts", "evolution-cli.mjs");

function makeCompleteManifest(releaseId, status, overrides = {}) {
  return {
    schemaId: EVOLUTION_RELEASE_SCHEMA_ID,
    schemaVersion: EVOLUTION_RELEASE_SCHEMA_VERSION,
    releaseId,
    status,
    parentReleaseId: "rel-000",
    rollbackReleaseId: "rel-000",
    supersedesRef: null,
    changeClass: "R1",
    claims: ["gate-regression"],
    environmentFingerprint: "fp-test-hash",
    artifactRefs: [],
    approvalRef: null,
    createdAt: "2026-08-15T00:00:00.000Z",
    activatedAt: null,
    ...overrides,
  };
}

function runCli(args, env = {}) {
  try {
    const stdout = execFileSync("node", [CLI_PATH, ...args], {
      cwd: EXT_ROOT,
      env: { ...process.env, ...env },
      encoding: "utf-8",
      timeout: 30000,
    });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    return {
      code: error.status ?? 1,
      stdout: String(error.stdout ?? ""),
      stderr: String(error.stderr ?? ""),
    };
  }
}

test("正式回归：capture 与 gate 共用 DEFAULT_RELEASE_FINGERPRINT_SPEC", () => {
  const cli = readFileSync(CLI_PATH, "utf8");
  assert.match(cli, /collectDefaultEnvironmentFingerprint/);
  assert.match(cli, /assertCaptureFingerprintPreconditions/);
  const gateSrc = readFileSync(join(EXT_ROOT, "v2", "governance", "production-release-gate.ts"), "utf8");
  assert.match(gateSrc, /explainFingerprintMismatch/);
  assert.match(gateSrc, /diffBehavioralFingerprintFields/);
  for (const name of [
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
  assert.equal(typeof collectDefaultEnvironmentFingerprint, "function");
});

test("正式回归：fingerprint mismatch 必须带字段级差异", () => {
  const reason = explainFingerprintMismatch(
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    [{ field: "generationModel", recorded: "recorded-model", actual: "gemini-3.1-pro" }],
  );
  assert.match(reason, /generationModel/);
  assert.match(reason, /recorded-model/);
  assert.match(reason, /gemini-3.1-pro/);
});

test("正式回归：held 不得迁回 evaluated / approved_dev / active_prod", () => {
  assert.equal(isStatusTransitionValid("held", "evaluated"), false);
  assert.equal(isStatusTransitionValid("held", "approved_dev"), false);
  assert.equal(isStatusTransitionValid("held", "active_prod"), false);
});

test("正式回归：完整 held manifest 的 proxy-review 以 exit 4 结构化阻断", () => {
  const root = mkdtempSync(join(tmpdir(), "rel-gate-status-block-"));
  try {
    const registry = createEvolutionReleaseRegistry({ releasesDir: join(root, "releases") });
    registry.writeManifest(makeCompleteManifest("rel-001", "held"));
    const result = runCli(
      ["proxy-review", "--release-id", "rel-001", "--stub-verdict", "APPROVE_DEV"],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 4, `stderr=${result.stderr}`);
    assert.match(result.stderr, /状态为 held，必须为 evaluated/);
    assert.doesNotMatch(result.stderr, /supersedesRef|missing_field|invalid_field_value|schema 校验失败/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("正式回归：held 不得 promote 到 active_prod", () => {
  const root = mkdtempSync(join(tmpdir(), "rel-gate-promote-block-"));
  try {
    const registry = createEvolutionReleaseRegistry({ releasesDir: join(root, "releases") });
    registry.writeManifest(makeCompleteManifest("rel-001", "held", {
      approvalRef: "apr-001",
    }));
    const result = runCli(
      ["promote", "--release-id", "rel-001", "--target", "active_prod", "--confirm-prod", "--actor", "user"],
      { PINOVEL_EVOLUTION_ROOT: root },
    );
    assert.equal(result.code, 4, `stderr=${result.stderr}`);
    assert.match(result.stderr, /当前状态 held 不允许晋级到 active_prod/);
    assert.doesNotMatch(result.stderr, /supersedesRef|missing_field|invalid_field_value/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
