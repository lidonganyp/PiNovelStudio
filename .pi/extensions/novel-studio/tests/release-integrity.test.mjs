/**
 * ReleaseIntegrity — releaseId 占用守护与四方一致性
 *
 * 覆盖：
 *  - capture 遇到已有 manifest / state-events / approvals 必须 fail-closed
 *  - 116 式 recapture：draft manifest + 旧 approved_dev state-event / 审批 hash 不一致
 *  - pointer binding 与 status 不一致
 *  - 合法 approved_dev 四方一致可通过
 *  - CLI pre-review / pre-promote 与 runner pre-production_like 均调用该检查
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  inspectReleaseOccupancy,
  assertReleaseIdAvailable,
  evaluateReleaseIntegrity,
  assertReleaseIntegrity,
} from "../dist-test/v2/governance/release-integrity.js";
import { createEvolutionReleaseRegistry } from "../dist-test/v2/governance/evolution-release-registry.js";
import { createReleasePointerStore } from "../dist-test/v2/governance/release-pointer-store.js";
import { createProxyApprovalRegistry } from "../dist-test/v2/governance/release-proxy-approval-registry.js";
import {
  EVOLUTION_RELEASE_SCHEMA_ID,
  EVOLUTION_RELEASE_SCHEMA_VERSION,
} from "../dist-test/v2/governance/evolution-release-types.js";
import {
  PROXY_APPROVAL_SCHEMA_ID,
  PROXY_APPROVAL_SCHEMA_VERSION,
  PROXY_APPROVAL_REVIEWER_MODEL,
} from "../dist-test/v2/governance/release-proxy-approval-types.js";
import { computeReleasePayloadHash } from "../dist-test/v2/governance/evolution-release-schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = resolve(__dirname, "..");

function makeTempRoot() {
  return mkdtempSync(join(tmpdir(), "release-integrity-"));
}

function makeManifest(releaseId, status, approvalRef = null, extras = {}) {
  return {
    schemaId: EVOLUTION_RELEASE_SCHEMA_ID,
    schemaVersion: EVOLUTION_RELEASE_SCHEMA_VERSION,
    releaseId,
    status,
    parentReleaseId: "rel-000",
    rollbackReleaseId: "rel-000",
    supersedesRef: null,
    changeClass: "R1",
    claims: ["integrity-test"],
    environmentFingerprint: "a".repeat(64),
    artifactRefs: [],
    approvalRef,
    createdAt: "2026-08-16T00:00:00.000Z",
    activatedAt: status === "active_prod" ? "2026-08-16T01:00:00.000Z" : null,
    ...extras,
  };
}

function writeEvent(root, releaseId, fromStatus, toStatus, extras = {}) {
  const registry = createEvolutionReleaseRegistry({
    releasesDir: join(root, "releases"),
  });
  registry.recordStateEvent({
    eventId: `evt-${releaseId}-${toStatus}-${fromStatus ?? "null"}`,
    releaseId,
    fromStatus,
    toStatus,
    reason: extras.reason ?? `to ${toStatus}`,
    actor: extras.actor ?? "system",
    timestamp: extras.timestamp ?? "2026-08-16T00:00:00.000Z",
  });
}

function writeApproval(root, manifest, overrides = {}) {
  const approvalsDir = join(root, "releases", manifest.releaseId, "approvals");
  mkdirSync(approvalsDir, { recursive: true });
  const approvalId = manifest.approvalRef ?? "approval-integrity-001";
  const artifact = {
    schemaId: PROXY_APPROVAL_SCHEMA_ID,
    schemaVersion: PROXY_APPROVAL_SCHEMA_VERSION,
    approvalId,
    releaseId: manifest.releaseId,
    releaseManifestHash: computeReleasePayloadHash(manifest),
    reviewerType: "validated_human_proxy",
    reviewerModel: PROXY_APPROVAL_REVIEWER_MODEL,
    reviewerModelVersion: "gpt5.6-sol-2026-07",
    reviewTransport: "network",
    promptHash: "sha256:prompt-integrity",
    inputArtifactHash: "sha256:input-integrity",
    forwardVerdict: "APPROVE_DEV",
    reverseVerdict: "APPROVE_DEV",
    finalVerdict: "APPROVE_DEV",
    winningSpans: [],
    losingSpans: [],
    risks: [],
    rationale: "integrity test",
    decidedAt: "2026-08-16T00:00:00.000Z",
    budgetUsed: { calls: 2, timeoutMs: 60000 },
    changeClass: manifest.changeClass,
    r3SelfApproval: false,
    ...overrides,
  };
  createProxyApprovalRegistry({ approvalsDir }).writeArtifact(artifact);
  return artifact;
}

function writeManifestFile(root, manifest) {
  const dir = join(root, "releases", manifest.releaseId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf-8");
}

test("capture occupancy: 已有 manifest 的 releaseId fail-closed", () => {
  const root = makeTempRoot();
  try {
    const releaseId = "rel-prod-116";
    writeManifestFile(root, makeManifest(releaseId, "draft"));
    const occupancy = inspectReleaseOccupancy(join(root, "releases"), releaseId);
    assert.equal(occupancy.occupied, true);
    assert.deepEqual(occupancy.existing, ["manifest"]);
    assert.throws(
      () => assertReleaseIdAvailable(join(root, "releases"), releaseId),
      /已被占用.*manifest/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("capture occupancy: 已有 state-events 或 approvals 也 fail-closed", () => {
  const root = makeTempRoot();
  try {
    const eventsOnly = "rel-events-only";
    mkdirSync(join(root, "releases", eventsOnly), { recursive: true });
    writeFileSync(join(root, "releases", eventsOnly, "state-events.jsonl"), "{}\n", "utf-8");
    assert.throws(
      () => assertReleaseIdAvailable(join(root, "releases"), eventsOnly),
      /state-events/,
    );

    const approvalsOnly = "rel-approvals-only";
    mkdirSync(join(root, "releases", approvalsOnly, "approvals"), { recursive: true });
    writeFileSync(
      join(root, "releases", approvalsOnly, "approvals", "leftover.json"),
      "{}\n",
      "utf-8",
    );
    assert.throws(
      () => assertReleaseIdAvailable(join(root, "releases"), approvalsOnly),
      /approvals/,
    );

    assert.doesNotThrow(() =>
      assertReleaseIdAvailable(join(root, "releases"), "rel-prod-117"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("四方一致性：116 式 recapture（draft 覆盖 approved_dev）fail-closed", () => {
  const root = makeTempRoot();
  try {
    const releaseId = "rel-prod-116";
    const leftover = makeManifest(releaseId, "approved_dev", "approval-rel-prod-116-old");
    writeManifestFile(root, leftover);
    writeEvent(root, releaseId, null, "draft");
    writeEvent(root, releaseId, "draft", "candidate");
    writeEvent(root, releaseId, "candidate", "frozen");
    writeEvent(root, releaseId, "frozen", "evaluated");
    writeEvent(root, releaseId, "evaluated", "approved_dev");
    writeApproval(root, leftover);
    writeManifestFile(root, makeManifest(releaseId, "draft", null, {
      createdAt: "2026-08-16T01:02:27.000Z",
      environmentFingerprint: "b".repeat(64),
    }));

    const result = evaluateReleaseIntegrity({ evolutionRoot: root, releaseId });
    assert.equal(result.ok, false);
    assert.ok(
      result.reasons.some((reason) => /manifest.status=draft/.test(reason) && /approved_dev/.test(reason)),
      result.reasons.join("；"),
    );
    assert.throws(
      () => assertReleaseIntegrity({ evolutionRoot: root, releaseId, stage: "pre-review" }),
      /pre-review 阻断/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("四方一致性：approval payload hash 与双向 APPROVE_DEV 必须匹配", () => {
  const root = makeTempRoot();
  try {
    const releaseId = "rel-hash-mismatch";
    const manifest = makeManifest(releaseId, "approved_dev", "approval-hash-1");
    writeManifestFile(root, manifest);
    writeEvent(root, releaseId, "evaluated", "approved_dev");
    writeApproval(root, manifest, {
      releaseManifestHash: "c".repeat(64),
      forwardVerdict: "HOLD",
      reverseVerdict: "APPROVE_DEV",
    });

    const result = evaluateReleaseIntegrity({ evolutionRoot: root, releaseId });
    assert.equal(result.ok, false);
    assert.ok(result.reasons.some((reason) => /payload hash/.test(reason)), result.reasons.join("；"));
    assert.ok(result.reasons.some((reason) => /双向审批/.test(reason)), result.reasons.join("；"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("四方一致性：active_prod pointer 指向非 active_prod status 失败", () => {
  const root = makeTempRoot();
  try {
    const releaseId = "rel-bind-mismatch";
    const manifest = makeManifest(releaseId, "evaluated", null);
    writeManifestFile(root, manifest);
    writeEvent(root, releaseId, "frozen", "evaluated");
    createReleasePointerStore({ configDir: root }).switchActive("production", releaseId, {
      actor: "user",
      reason: "integrity binding test",
    });

    const result = evaluateReleaseIntegrity({ evolutionRoot: root, releaseId });
    assert.equal(result.ok, false);
    assert.ok(result.reasons.some((reason) => /binding 不一致/.test(reason)), result.reasons.join("；"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("四方一致性：合法 approved_dev + 真实审批 artifact 通过", () => {
  const root = makeTempRoot();
  try {
    const releaseId = "rel-prod-117";
    const manifest = makeManifest(releaseId, "approved_dev", "approval-rel-prod-117-ok");
    writeManifestFile(root, manifest);
    writeEvent(root, releaseId, "evaluated", "approved_dev");
    writeApproval(root, manifest);

    const result = evaluateReleaseIntegrity({ evolutionRoot: root, releaseId });
    assert.equal(result.ok, true, result.reasons.join("；"));
    const loaded = assertReleaseIntegrity({
      evolutionRoot: root,
      releaseId,
      stage: "pre-production_like",
    });
    assert.equal(loaded.status, "approved_dev");
    assert.equal(loaded.approvalRef, "approval-rel-prod-117-ok");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI / runner 在 pre-review、pre-production_like、pre-promote 调用四方检查", () => {
  const cli = readFileSync(join(EXT_ROOT, "scripts", "evolution-cli.mjs"), "utf-8");
  assert.match(cli, /assertReleaseIdAvailable\(releasesDir\(\), releaseId\)/);
  assert.match(cli, /stage:\s*"pre-review"/);
  assert.match(cli, /stage:\s*"pre-promote"/);

  const runner = readFileSync(join(EXT_ROOT, "eval", "full-pipeline-replay-runner.ts"), "utf-8");
  assert.match(runner, /stage:\s*"pre-production_like"/);
  assert.match(
    runner,
    /requireActiveApproval:\s*fixture\.replayMode === "production_like"/,
  );
  assert.match(runner, /candidate_like/);
});
