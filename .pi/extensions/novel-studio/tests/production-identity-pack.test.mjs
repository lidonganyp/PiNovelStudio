/**
 * 生产身份包：clean checkout 可通过 export/inject 或只读 pack 恢复治理状态。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createEvolutionReleaseRegistry } from "../dist-test/v2/governance/evolution-release-registry.js";
import { createReleasePointerStore } from "../dist-test/v2/governance/release-pointer-store.js";
import { createProxyApprovalRegistry } from "../dist-test/v2/governance/release-proxy-approval-registry.js";
import {
  EVOLUTION_RELEASE_SCHEMA_ID,
  EVOLUTION_RELEASE_SCHEMA_VERSION,
  EVOLUTION_POINTER_SCHEMA_ID,
  EVOLUTION_POINTER_SCHEMA_VERSION,
} from "../dist-test/v2/governance/evolution-release-types.js";
import { computeReleasePayloadHash } from "../dist-test/v2/governance/evolution-release-schema.js";
import { evaluateProductionReleaseGate } from "../dist-test/v2/governance/production-release-gate.js";
import {
  buildProductionIdentityPack,
  computeIdentityPackHash,
  parseProductionIdentityPack,
  injectProductionIdentityPack,
  exportProductionIdentityPack,
  resolveProductionIdentityPackPath,
} from "../dist-test/v2/governance/production-identity-pack.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const CLI_PATH = join(__dirname, "..", "scripts", "evolution-cli.mjs");
const EXT_ROOT = join(__dirname, "..");

function makeTempRoot() {
  return mkdtempSync(join(tmpdir(), "prod-identity-"));
}

function runCli(args, env = {}) {
  try {
    const output = execFileSync("node", [CLI_PATH, ...args], {
      cwd: EXT_ROOT,
      env: { ...process.env, ...env },
      encoding: "utf-8",
      timeout: 30000,
    });
    return { code: 0, stdout: output, stderr: "" };
  } catch (e) {
    return {
      code: e.status ?? 1,
      stdout: e.stdout?.toString() ?? "",
      stderr: e.stderr?.toString() ?? "",
    };
  }
}

function makeManifest(releaseId) {
  return {
    schemaId: EVOLUTION_RELEASE_SCHEMA_ID,
    schemaVersion: EVOLUTION_RELEASE_SCHEMA_VERSION,
    releaseId,
    status: "active_prod",
    parentReleaseId: "rel-000",
    rollbackReleaseId: "rel-000",
    supersedesRef: null,
    changeClass: "R1",
    claims: ["identity-pack"],
    environmentFingerprint: "fp-pack-hash",
    artifactRefs: [],
    approvalRef: "apr-pack",
    createdAt: "2026-08-18T00:00:00.000Z",
    activatedAt: "2026-08-18T00:01:00.000Z",
    bundleId: "bundle-pack",
    modelVersion: "gemini31",
    promptBundleHash: "1".repeat(64),
    modelRoutingHash: "2".repeat(64),
    toolSchemaHash: "3".repeat(64),
    contextCompilerHash: "4".repeat(64),
    qualityPolicyHash: "5".repeat(64),
    recoveryPolicyHash: "6".repeat(64),
    knowledgeSnapshotHash: "7".repeat(64),
    runtimeFingerprint: "8".repeat(64),
    evalProtocolVersion: "pinovel.eval-protocol/1",
  };
}

function makeApproval(manifest) {
  return {
    schemaId: "pinovel.release-proxy-approval",
    schemaVersion: 1,
    approvalId: "apr-pack",
    releaseId: manifest.releaseId,
    releaseManifestHash: computeReleasePayloadHash(manifest),
    reviewerType: "validated_human_proxy",
    reviewerModel: "gpt5.6-sol",
    reviewerModelVersion: "gpt5.6-sol-2026-07",
    reviewTransport: "network",
    promptHash: "stub-prompt-hash",
    inputArtifactHash: "stub-input-hash",
    forwardVerdict: "APPROVE_DEV",
    reverseVerdict: "APPROVE_DEV",
    finalVerdict: "APPROVE_DEV",
    winningSpans: [],
    losingSpans: [],
    risks: [],
    rationale: "identity pack test",
    decidedAt: "2026-08-18T00:00:00.000Z",
    budgetUsed: { calls: 2, timeoutMs: 300000 },
    changeClass: "R1",
    r3SelfApproval: false,
  };
}

function makePointer(releaseId) {
  return {
    schemaId: EVOLUTION_POINTER_SCHEMA_ID,
    schemaVersion: EVOLUTION_POINTER_SCHEMA_VERSION,
    kind: "production",
    releaseId,
    reason: "identity-pack",
    actor: "user",
    switchedAt: "2026-08-18T00:01:00.000Z",
  };
}

test("identity pack：hash 篡改 fail-closed；inject 后 G6 不再报 pointer 缺失", () => {
  const root = makeTempRoot();
  try {
    const manifest = makeManifest("rel-pack-001");
    const pack = buildProductionIdentityPack({
      pointer: makePointer("rel-pack-001"),
      manifest,
      approvalArtifact: makeApproval(manifest),
      environmentFingerprint: { codeCommit: "abc", fingerprintHash: "fp-pack-hash" },
    });
    const parsed = parseProductionIdentityPack(pack);
    assert.equal(parsed.ok, true, parsed.errors?.join("; "));

    const tampered = { ...pack, packHash: "a".repeat(64) };
    const bad = parseProductionIdentityPack(tampered);
    assert.equal(bad.ok, false);
    assert.match(bad.errors.join("; "), /packHash|hash/i);

    const dest = join(root, "empty-evo");
    mkdirSync(dest, { recursive: true });
    const prevDev = process.env.PINOVEL_DEV_MODE;
    delete process.env.PINOVEL_DEV_MODE;
    try {
    const missing = evaluateProductionReleaseGate({
      projectRoot: root,
      evolutionRoot: dest,
      currentFingerprintHash: "fp-pack-hash",
    });
    assert.equal(missing.ok, false);
    assert.match(missing.failureEnvelope.reason, /no active production release set/);

    injectProductionIdentityPack(dest, pack);
    assert.equal(createReleasePointerStore({ configDir: dest }).readActive("production").releaseId, "rel-pack-001");
    assert.equal(
      createEvolutionReleaseRegistry({ releasesDir: join(dest, "releases") }).loadManifest("rel-pack-001").status,
      "active_prod",
    );

    const afterInject = evaluateProductionReleaseGate({
      projectRoot: root,
      evolutionRoot: dest,
      currentFingerprintHash: "fp-pack-hash",
    });
    assert.equal(afterInject.ok, false);
    assert.doesNotMatch(afterInject.failureEnvelope.reason, /no active production release set/);

    writeFileSync(join(root, "pack.json"), JSON.stringify(pack, null, 2));
    const fromPack = evaluateProductionReleaseGate({
      projectRoot: root,
      evolutionRoot: join(root, "still-empty"),
      identityPackPath: join(root, "pack.json"),
      currentFingerprintHash: "fp-pack-hash",
    });
    assert.equal(fromPack.ok, false);
    assert.doesNotMatch(fromPack.failureEnvelope.reason, /no active production release set/);
    } finally {
      if (prevDev === undefined) delete process.env.PINOVEL_DEV_MODE;
      else process.env.PINOVEL_DEV_MODE = prevDev;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("identity pack rejects non-production and unsafe pointers even with a recomputed hash", () => {
  const manifest = makeManifest("rel-pack-safe");
  const pack = buildProductionIdentityPack({
    pointer: makePointer(manifest.releaseId),
    manifest,
    approvalArtifact: makeApproval(manifest),
  });

  const nonProductionPointerPayload = {
    ...pack,
    pointer: { ...pack.pointer, kind: "development" },
  };
  const nonProductionPointer = {
    ...nonProductionPointerPayload,
    packHash: computeIdentityPackHash(nonProductionPointerPayload),
  };
  const nonProductionResult = parseProductionIdentityPack(nonProductionPointer);
  assert.equal(nonProductionResult.ok, false);
  assert.match(nonProductionResult.errors.join("; "), /production/i);

  const unsafeReleasePayload = {
    ...pack,
    releaseId: "../outside",
    pointer: { ...pack.pointer, releaseId: "../outside" },
    manifest: { ...pack.manifest, releaseId: "../outside" },
  };
  const unsafeRelease = {
    ...unsafeReleasePayload,
    packHash: computeIdentityPackHash(unsafeReleasePayload),
  };
  const unsafeReleaseResult = parseProductionIdentityPack(unsafeRelease);
  assert.equal(unsafeReleaseResult.ok, false);
  assert.match(unsafeReleaseResult.errors.join("; "), /releaseId/i);
});

test("CLI export-identity / inject-identity 可在空治理根恢复 pointer", () => {
  const root = makeTempRoot();
  try {
    const source = join(root, "source");
    const dest = join(root, "dest");
    mkdirSync(source, { recursive: true });
    mkdirSync(dest, { recursive: true });
    const manifest = makeManifest("rel-pack-002");
    const registry = createEvolutionReleaseRegistry({ releasesDir: join(source, "releases") });
    registry.writeManifest(manifest);
    createProxyApprovalRegistry({
      approvalsDir: join(source, "releases", "rel-pack-002", "approvals"),
    }).writeArtifact(makeApproval(manifest));
    createReleasePointerStore({ configDir: source }).switchActive("production", "rel-pack-002", {
      actor: "user",
      reason: "export-source",
    });

    const packPath = join(root, "exported.pack.json");
    const exported = exportProductionIdentityPack(source);
    writeFileSync(packPath, JSON.stringify(exported, null, 2));
    assert.equal(exported.releaseId, "rel-pack-002");

    const cli = runCli(
      ["inject-identity", "--pack", packPath],
      { PINOVEL_EVOLUTION_ROOT: dest },
    );
    assert.equal(cli.code, 0, cli.stderr);
    assert.equal(
      createReleasePointerStore({ configDir: dest }).readActive("production").releaseId,
      "rel-pack-002",
    );
    assert.ok(existsSync(join(dest, "releases", "rel-pack-002", "manifest.json")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("组合 pack：export 内联回滚身份，inject 物化 active + rollback", () => {
  const root = makeTempRoot();
  try {
    const source = join(root, "source");
    const dest = join(root, "dest");
    mkdirSync(source, { recursive: true });
    mkdirSync(dest, { recursive: true });

    const active = { ...makeManifest("rel-active"), rollbackReleaseId: "rel-rollback" };
    const rollback = {
      ...makeManifest("rel-rollback"),
      status: "held",
      approvalRef: "apr-rollback",
      rollbackReleaseId: "rel-000",
    };
    const registry = createEvolutionReleaseRegistry({ releasesDir: join(source, "releases") });
    registry.writeManifest(active);
    registry.writeManifest(rollback);
    const activeApproval = makeApproval(active);
    const rollbackApproval = { ...makeApproval(rollback), approvalId: "apr-rollback" };
    createProxyApprovalRegistry({
      approvalsDir: join(source, "releases", "rel-active", "approvals"),
    }).writeArtifact(activeApproval);
    createProxyApprovalRegistry({
      approvalsDir: join(source, "releases", "rel-rollback", "approvals"),
    }).writeArtifact(rollbackApproval);
    createReleasePointerStore({ configDir: source }).switchActive("production", "rel-active", {
      actor: "user",
      reason: "export-source",
    });

    const exported = exportProductionIdentityPack(source);
    assert.equal(exported.releaseId, "rel-active");
    assert.ok(exported.rollbackIdentity, "应内联回滚身份");
    assert.equal(exported.rollbackIdentity.releaseId, "rel-rollback");
    assert.equal(exported.rollbackIdentity.manifest.status, "held");
    assert.equal(exported.rollbackIdentity.approvalArtifact.approvalId, "apr-rollback");
    assert.ok(
      parseProductionIdentityPack(exported).ok,
      `带 rollbackIdentity 的 pack 应通过 hash 校验：${parseProductionIdentityPack(exported).errors?.join("; ")}`,
    );

    injectProductionIdentityPack(dest, exported);
    const destRegistry = createEvolutionReleaseRegistry({ releasesDir: join(dest, "releases") });
    assert.equal(createReleasePointerStore({ configDir: dest }).readActive("production").releaseId, "rel-active");
    assert.equal(destRegistry.loadManifest("rel-active").status, "active_prod");
    assert.equal(destRegistry.loadManifest("rel-rollback").status, "held");
    assert.ok(existsSync(join(dest, "releases", "rel-rollback", "manifest.json")));
    assert.ok(existsSync(join(dest, "releases", "rel-rollback", "approvals", "apr-rollback.json")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveProductionIdentityPackPath：探测 repo-layout 与 ext-layout 两种默认路径", () => {
  const root = makeTempRoot();
  const prevPack = process.env.PINOVEL_PRODUCTION_IDENTITY_PACK;
  delete process.env.PINOVEL_PRODUCTION_IDENTITY_PACK;
  try {
    assert.equal(resolveProductionIdentityPackPath(root), null);

    // repo-layout 变体（扩展目录下）
    const repoLayoutDir = join(root, ".pi", "extensions", "novel-studio", "config", "production-identity");
    mkdirSync(repoLayoutDir, { recursive: true });
    const repoLayoutPack = join(repoLayoutDir, "active.pack.json");
    writeFileSync(repoLayoutPack, "{}\n");
    assert.equal(resolveProductionIdentityPackPath(root), repoLayoutPack);
    rmSync(repoLayoutPack);

    // ext-layout 变体（仓库根 config/ 下）
    const extLayoutDir = join(root, "config", "production-identity");
    mkdirSync(extLayoutDir, { recursive: true });
    const extLayoutPack = join(extLayoutDir, "active.pack.json");
    writeFileSync(extLayoutPack, "{}\n");
    assert.equal(resolveProductionIdentityPackPath(root), extLayoutPack);
  } finally {
    if (prevPack === undefined) delete process.env.PINOVEL_PRODUCTION_IDENTITY_PACK;
    else process.env.PINOVEL_PRODUCTION_IDENTITY_PACK = prevPack;
    rmSync(root, { recursive: true, force: true });
  }
});

test("clean-deploy：注入组合 pack 后空 history 可执行 production rollback", () => {
  const root = makeTempRoot();
  try {
    const source = join(root, "source");
    const dest = join(root, "dest");
    mkdirSync(source, { recursive: true });
    mkdirSync(dest, { recursive: true });

    const active = { ...makeManifest("rel-active"), rollbackReleaseId: "rel-rollback" };
    const rollback = {
      ...makeManifest("rel-rollback"),
      status: "held",
      approvalRef: "apr-rollback",
      rollbackReleaseId: "rel-000",
    };
    const registry = createEvolutionReleaseRegistry({ releasesDir: join(source, "releases") });
    registry.writeManifest(active);
    registry.writeManifest(rollback);
    const activeApproval = makeApproval(active);
    const rollbackApproval = { ...makeApproval(rollback), approvalId: "apr-rollback" };
    createProxyApprovalRegistry({
      approvalsDir: join(source, "releases", "rel-active", "approvals"),
    }).writeArtifact(activeApproval);
    createProxyApprovalRegistry({
      approvalsDir: join(source, "releases", "rel-rollback", "approvals"),
    }).writeArtifact(rollbackApproval);
    createReleasePointerStore({ configDir: source }).switchActive("production", "rel-active", {
      actor: "user",
      reason: "export",
    });

    const exported = exportProductionIdentityPack(source);
    const packPath = join(root, "pack.json");
    writeFileSync(packPath, JSON.stringify(exported, null, 2));

    // inject into clean dest
    const injectResult = runCli(
      ["inject-identity", "--pack", packPath],
      { PINOVEL_EVOLUTION_ROOT: dest },
    );
    assert.equal(injectResult.code, 0, injectResult.stderr);
    assert.equal(
      createReleasePointerStore({ configDir: dest }).readActive("production").releaseId,
      "rel-active",
    );

    // rollback: history 为空，应使用 designated rollbackReleaseId
    const rollbackResult = runCli(
      ["rollback", "--kind", "production", "--actor", "user", "--reason", "clean-deploy-rollback"],
      { PINOVEL_EVOLUTION_ROOT: dest },
    );
    assert.equal(rollbackResult.code, 0, rollbackResult.stderr);
    assert.equal(
      createReleasePointerStore({ configDir: dest }).readActive("production").releaseId,
      "rel-rollback",
    );
    // 回滚后原 active 应被 held
    assert.equal(
      createEvolutionReleaseRegistry({ releasesDir: join(dest, "releases") }).loadManifest("rel-active").status,
      "held",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
