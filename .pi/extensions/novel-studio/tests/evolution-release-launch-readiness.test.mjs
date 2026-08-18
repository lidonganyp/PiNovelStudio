/**
 * Production launch regressions for release lifecycle and real proxy review.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  runRealProxyReview,
  runStubProxyReview,
} from "../dist-test/v2/governance/proxy-review-runner.js";
import { createProxyApprovalRegistry } from "../dist-test/v2/governance/release-proxy-approval-registry.js";
import { createEvolutionReleaseRegistry } from "../dist-test/v2/governance/evolution-release-registry.js";
import { evaluateCanaryPromotionGate } from "../dist-test/v2/governance/canary-promotion-gate.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const CLI_PATH = join(__dirname, "..", "scripts", "evolution-cli.mjs");
const EXT_ROOT = join(__dirname, "..");

function makeTempRoot() {
  return mkdtempSync(join(tmpdir(), "evolution-launch-"));
}

function makeCleanGitProject() {
  const dir = mkdtempSync(join(tmpdir(), "evolution-clean-git-"));
  execFileSync("git", ["init"], { cwd: dir, encoding: "utf-8" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, encoding: "utf-8" });
  execFileSync("git", ["config", "user.name", "launch-test"], { cwd: dir, encoding: "utf-8" });
  writeFileSync(join(dir, "README.md"), "clean capture root\n", "utf-8");
  // capture 现执行 DG-2 行为快照，resolveCapabilityPackageSetHash 对缺失的能力包集合文件
  // fail-close（capability_package_set_missing）。提供一个合法空集合，使 capture 在最小
  // 干净根上成功；其余组件（model-routing/prompt/tool-schema 等）缺失时哈希为空，不抛异常。
  mkdirSync(join(dir, "data", "runtime"), { recursive: true });
  writeFileSync(
    join(dir, "data", "runtime", "capability-package-set.json"),
    JSON.stringify({ schemaVersion: "capability-package-set-v1", packages: [], payloads: [] }),
    "utf-8",
  );
  execFileSync("git", ["add", "README.md", "data/runtime/capability-package-set.json"], {
    cwd: dir,
    encoding: "utf-8",
  });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "init"], {
    cwd: dir,
    encoding: "utf-8",
  });
  return dir;
}

function writeMatchingStateEvent(registry, releaseId, status) {
  if (status === "draft") return;
  const fromByTo = {
    candidate: "draft",
    frozen: "candidate",
    evaluated: "frozen",
    approved_dev: "evaluated",
    active_dev: "approved_dev",
    candidate_prod: "active_dev",
    active_prod: "candidate_prod",
    held: "active_dev",
    rejected: "evaluated",
    quarantined: "evaluated",
  };
  const fromStatus = fromByTo[status];
  if (!fromStatus) return;
  registry.recordStateEvent({
    eventId: `evt-${releaseId}-${status}`,
    releaseId,
    fromStatus,
    toStatus: status,
    reason: `test fixture arrived at ${status}`,
    actor: "system",
    timestamp: "2026-07-17T00:00:00.000Z",
  });
}

function runCli(args, env = {}) {
  const merged = { ...process.env, ...env };
  delete merged.PINOVEL_EVAL_REPLAY_TRANSPORT;
  delete merged.PINOVEL_EVAL_RECORDED_RESULTS_PATH;
  delete merged.PINOVEL_EVAL_SYNTHETIC_FAULTS;
  delete merged.PINOVEL_EVAL_SYNTHETIC_FAULTS_PATH;
  if (!merged.PINOVEL_PROJECT_ROOT) {
    merged.PINOVEL_PROJECT_ROOT = cleanGitProject;
  }
  try {
    const stdout = execFileSync("node", [CLI_PATH, ...args], {
      cwd: EXT_ROOT,
      env: merged,
      encoding: "utf-8",
      timeout: 30_000,
    });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    return {
      code: error.status ?? 1,
      stdout: error.stdout?.toString() ?? "",
      stderr: error.stderr?.toString() ?? "",
    };
  }
}

function makeManifest(releaseId, status, overrides = {}) {
  return {
    schemaId: "pinovel.evolution-release",
    schemaVersion: 1,
    releaseId,
    status,
    parentReleaseId: null,
    rollbackReleaseId: releaseId,
    supersedesRef: null,
    changeClass: "R1",
    claims: [],
    environmentFingerprint: "sha256:test-fingerprint",
    artifactRefs: [],
    approvalRef: null,
    createdAt: "2026-07-17T00:00:00.000Z",
    activatedAt: null,
    ...overrides,
  };
}

function writeMetadata(root, body) {
  const path = join(root, "release-metadata.json");
  writeFileSync(path, JSON.stringify(body), "utf-8");
  return path;
}

const cleanGitProject = makeCleanGitProject();

test("candidate and freeze commands bind metadata before an immutable freeze", () => {
  const root = makeTempRoot();
  try {
    const registry = createEvolutionReleaseRegistry({ releasesDir: join(root, "releases") });
    registry.writeManifest(makeManifest("rel-base", "active_prod", {
      approvalRef: "approval-base",
    }));
    writeMatchingStateEvent(registry, "rel-base", "active_prod");
    const env = { PINOVEL_EVOLUTION_ROOT: root };
    assert.equal(runCli([
      "capture", "--release-id", "rel-next", "--parent", "rel-base", "--rollback", "rel-base",
    ], env).code, 0);

    const metadataPath = writeMetadata(root, {
      changeClass: "R2",
      claims: ["production-route canary is green"],
      artifactRefs: ["artifacts/canary-preregistration.json"],
      supersedesRef: "rel-base",
    });
    assert.equal(runCli([
      "candidate", "--release-id", "rel-next", "--metadata-file", metadataPath,
    ], env).code, 0);
    assert.equal(runCli(["freeze", "--release-id", "rel-next"], env).code, 0);

    const manifest = registry.loadManifest("rel-next");
    assert.equal(manifest.status, "frozen");
    assert.equal(manifest.changeClass, "R2");
    assert.deepEqual(manifest.claims, ["production-route canary is green"]);
    assert.deepEqual(manifest.artifactRefs, ["artifacts/canary-preregistration.json"]);
    assert.equal(manifest.supersedesRef, "rel-base");
    assert.deepEqual(
      registry.loadStateEvents("rel-next").map((event) => event.toStatus),
      ["draft", "candidate", "frozen"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("freeze allows held rollback when production pointer is none", () => {
  const root = makeTempRoot();
  try {
    const registry = createEvolutionReleaseRegistry({ releasesDir: join(root, "releases") });
    registry.writeManifest(makeManifest("rel-held", "held"));
    writeMatchingStateEvent(registry, "rel-held", "held");
    registry.writeManifest(makeManifest("rel-next", "candidate", {
      parentReleaseId: "rel-held",
      rollbackReleaseId: "rel-held",
    }));
    writeMatchingStateEvent(registry, "rel-next", "candidate");
    const result = runCli(["freeze", "--release-id", "rel-next"], {
      PINOVEL_EVOLUTION_ROOT: root,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(registry.loadManifest("rel-next").status, "frozen");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("freeze rejects a rollback target that is not active_prod", () => {
  const root = makeTempRoot();
  try {
    const registry = createEvolutionReleaseRegistry({ releasesDir: join(root, "releases") });
    registry.writeManifest(makeManifest("rel-draft", "draft"));
    writeMatchingStateEvent(registry, "rel-draft", "draft");
    registry.writeManifest(makeManifest("rel-next", "candidate", {
      parentReleaseId: "rel-draft",
      rollbackReleaseId: "rel-draft",
    }));
    writeMatchingStateEvent(registry, "rel-next", "candidate");
    const result = runCli(["freeze", "--release-id", "rel-next"], {
      PINOVEL_EVOLUTION_ROOT: root,
    });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /rollback.*active_prod|held\/retired|approved_dev/i);
    assert.equal(registry.loadManifest("rel-next").status, "candidate");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bootstrap freeze is explicit, self-referential, and only allowed in an empty registry", () => {
  const root = makeTempRoot();
  try {
    const env = { PINOVEL_EVOLUTION_ROOT: root };
    assert.equal(runCli([
      "capture", "--release-id", "rel-000", "--rollback", "rel-000",
    ], env).code, 0);
    const metadataPath = writeMetadata(root, {
      changeClass: "R1",
      claims: ["bootstrap current production baseline"],
      artifactRefs: [],
    });
    assert.equal(runCli([
      "candidate", "--release-id", "rel-000", "--metadata-file", metadataPath,
    ], env).code, 0);

    const withoutFlag = runCli(["freeze", "--release-id", "rel-000"], env);
    assert.notEqual(withoutFlag.code, 0);
    assert.match(withoutFlag.stderr, /bootstrap/i);
    assert.equal(runCli([
      "freeze", "--release-id", "rel-000", "--bootstrap",
    ], env).code, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("proxy-review --real fails closed when no authorization card is supplied", () => {
  const root = makeTempRoot();
  try {
    const registry = createEvolutionReleaseRegistry({ releasesDir: join(root, "releases") });
    registry.writeManifest(makeManifest("rel-real", "evaluated", {
      rollbackReleaseId: "rel-base",
      changeClass: "R2",
    }));
    writeMatchingStateEvent(registry, "rel-real", "evaluated");
    const evalInput = join(root, "eval-input.json");
    writeFileSync(evalInput, JSON.stringify(makePacketInputBody()), "utf-8");
    const result = runCli([
      "proxy-review", "--release-id", "rel-real", "--real", "--eval-input", evalInput,
    ], { PINOVEL_EVOLUTION_ROOT: root });
    assert.equal(result.code, 6);
    assert.match(result.stderr, /REQUIRES_AUTH/i);
    assert.equal(registry.loadManifest("rel-real").status, "evaluated");
    assert.equal(registry.loadManifest("rel-real").approvalRef, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stub approval can activate development but cannot enter production candidacy", () => {
  const root = makeTempRoot();
  try {
    const releaseId = "rel-stub";
    const registry = createEvolutionReleaseRegistry({ releasesDir: join(root, "releases") });
    registry.writeManifest(makeManifest(releaseId, "evaluated", {
      rollbackReleaseId: "rel-base",
      changeClass: "R2",
    }));
    writeMatchingStateEvent(registry, releaseId, "evaluated");
    const evalInput = join(root, "eval-input.json");
    writeFileSync(evalInput, JSON.stringify(makePacketInputBody()), "utf-8");
    const env = { PINOVEL_EVOLUTION_ROOT: root };
    assert.equal(runCli([
      "proxy-review", "--release-id", releaseId, "--stub-verdict", "APPROVE_DEV",
      "--eval-input", evalInput,
    ], env).code, 0);
    assert.equal(runCli([
      "promote", "--release-id", releaseId, "--target", "active_dev",
    ], env).code, 0);

    const result = runCli([
      "promote", "--release-id", releaseId, "--target", "candidate_prod", "--confirm-prod",
    ], env);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /reviewTransport.*network/i);
    assert.equal(registry.loadManifest(releaseId).status, "active_dev");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an authorized evaluated R2 release can start a pre-approval shadow canary", () => {
  const root = makeTempRoot();
  try {
    const releaseId = "rel-preapproval-canary";
    const registry = createEvolutionReleaseRegistry({ releasesDir: join(root, "releases") });
    registry.writeManifest(makeManifest(releaseId, "evaluated", {
      rollbackReleaseId: "rel-base",
      changeClass: "R2",
    }));
    writeMatchingStateEvent(registry, releaseId, "evaluated");
    const workspace = join(root, "canary-control");
    mkdirSync(workspace, { recursive: true });
    const authPath = join(root, "canary-auth.json");
    writeFileSync(authPath, JSON.stringify({
      schemaId: "pinovel.canary-authorization",
      schemaVersion: 1,
      authorizationId: "canary-auth-preapproval",
      workspaceId: "canary-control",
      allowedReleaseIds: [releaseId],
      budget: { maxChapters: 5, maxCalls: 50 },
      issuedAt: "2026-07-17T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      issuer: "authorized-user",
    }), "utf-8");
    const env = { PINOVEL_EVOLUTION_ROOT: root };
    assert.equal(runCli([
      "canary", "--release-id", releaseId, "--workspace", workspace,
      "--authorize", "--auth-file", authPath,
    ], env).code, 0);
    const apply = runCli([
      "canary", "--release-id", releaseId, "--workspace", workspace, "--apply",
    ], env);
    assert.equal(apply.code, 0, apply.stderr);

    const traceFiles = readdirSync(join(workspace, "canary-runs"));
    assert.equal(traceFiles.length, 1);
    const trace = JSON.parse(readFileSync(join(workspace, "canary-runs", traceFiles[0]), "utf-8"));
    assert.equal(trace.status, "shadow_started");
    assert.equal(trace.strategy, "shadow_required");
    assert.equal(trace.evidence.currentStatus, "evaluated");
    assert.equal(trace.evidence.authorizationId, "canary-auth-preapproval");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("promotion gate accepts completed pre-approval canary evidence bound to final approval", () => {
  const trace = {
    schemaId: "pinovel.canary-run-trace",
    schemaVersion: 1,
    runId: "canary-preapproval-completed",
    releaseId: "rel-preapproval-canary",
    previousReleaseId: "rel-base",
    workspaceId: "canary-control",
    startedAt: "2026-07-17T00:00:00.000Z",
    completedAt: "2026-07-17T00:10:00.000Z",
    strategy: "shadow_required",
    status: "completed",
    healthSnapshot: {
      status: "insufficient_data",
      alignmentRate: 0,
      sampleCount: 0,
      rollbackRate: 0,
      consecutiveNegative: 0,
    },
    evidence: {
      changeClass: "R2",
      currentStatus: "evaluated",
      authorizationId: "canary-auth-preapproval",
      sourceRunId: "canary-preapproval-started",
      environmentFingerprint: "sha256:fingerprint",
      approvalRef: "approval-network",
      verdict: "pass",
      observedChapters: 5,
      observedCalls: 25,
      resultArtifactRefs: ["reports/result.json"],
      resultArtifactHashes: { "reports/result.json": "a".repeat(64) },
    },
    outcome: { promoted: false, heldByAutoHold: false },
    shadowPendingRealRun: false,
  };
  const result = evaluateCanaryPromotionGate({
    releaseId: trace.releaseId,
    changeClass: "R2",
    environmentFingerprint: trace.evidence.environmentFingerprint,
    approvalRef: trace.evidence.approvalRef,
    workspaceId: trace.workspaceId,
    trace,
  });
  assert.equal(result.ok, true, result.reason);
});

function makePacketInputBody() {
  return {
    changeClass: "R2",
    uniqueVariable: "production-release",
    fixedCase: "five-case-canary",
    fixedModel: "production-routing-v4.19.0",
    fixedSeed: 0,
    budgetMaxCalls: 2,
    timeoutMs: 60_000,
    candidateText: "candidate evidence: all production gates passed",
    currentApprovedText: "current baseline evidence",
    rawBaselineText: "raw baseline evidence",
    factGuardReport: { candidatePass: true, currentPass: true, violations: [] },
    stateConsistency: { candidateConsistent: true, currentConsistent: true },
    costProfile: { candidateTokens: 100, currentTokens: 100 },
    candidateSpans: [{ id: "candidate-green", text: "all production gates passed", side: "candidate" }],
    currentSpans: [{ id: "baseline", text: "current baseline evidence", side: "current" }],
  };
}

test("proxy runner rejects a packet changeClass that differs from the manifest", async () => {
  const root = makeTempRoot();
  try {
    const releaseId = "rel-r3";
    const evolutionRegistry = createEvolutionReleaseRegistry({ releasesDir: join(root, "releases") });
    evolutionRegistry.writeManifest(makeManifest(releaseId, "evaluated", {
      rollbackReleaseId: "rel-base",
      changeClass: "R3",
    }));
    writeMatchingStateEvent(evolutionRegistry, releaseId, "evaluated");
    const proxyRegistry = createProxyApprovalRegistry({ approvalsDir: join(root, "approvals") });
    await assert.rejects(() => runStubProxyReview({
      proxyRegistry,
      evolutionRegistry,
      releaseId,
      packetInput: makePacketInputBody(),
      forwardVerdict: "APPROVE_DEV",
      reverseVerdict: "APPROVE_DEV",
      modelVersion: "gpt-5.6-sol-test",
      promptHash: "sha256:test",
      budget: { maxCalls: 2, timeoutMs: 60_000 },
    }), /changeClass.*manifest/i);
    assert.equal(proxyRegistry.listByReleaseId(releaseId).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runRealProxyReview consumes a real card and performs bounded forward/reverse calls", async () => {
  const root = makeTempRoot();
  const previousFetch = globalThis.fetch;
  const previousEnv = {
    key: process.env.NOVELOS_JUDGE_API_KEY,
    base: process.env.NOVELOS_JUDGE_BASE_URL,
    model: process.env.NOVELOS_JUDGE_MODEL,
  };
  try {
    const releaseId = "rel-real";
    const evolutionRegistry = createEvolutionReleaseRegistry({ releasesDir: join(root, "releases") });
    evolutionRegistry.writeManifest(makeManifest(releaseId, "evaluated", {
      rollbackReleaseId: "rel-base",
      changeClass: "R2",
    }));
    writeMatchingStateEvent(evolutionRegistry, releaseId, "evaluated");
    const proxyRegistry = createProxyApprovalRegistry({ approvalsDir: join(root, "approvals") });
    const cardPath = join(root, "authorization-card.json");
    writeFileSync(cardPath, JSON.stringify({
      schemaId: "pinovel.evolution-authorization-card",
      schemaVersion: 1,
      cardId: "card-real-release",
      cardType: "real_gpt56sol",
      model: "gpt5.6-sol",
      allowedReleaseIds: [releaseId],
      budget: { maxCalls: 2, timeoutMs: 60_000 },
      modelVersion: "gpt-5.6-sol-test",
      issuedAt: "2026-07-17T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      issuer: "authorized-user",
      authorizationProof: "explicit user authorization",
    }), "utf-8");

    process.env.NOVELOS_JUDGE_API_KEY = "test-secret";
    process.env.NOVELOS_JUDGE_BASE_URL = "https://judge.example.test/v1";
    process.env.NOVELOS_JUDGE_MODEL = "gpt-5.6-sol-test";
    const requests = [];
    globalThis.fetch = async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return new Response(JSON.stringify({
        model: "gpt-5.6-sol-test",
        choices: [{ message: { content: JSON.stringify({
          verdict: "APPROVE_DEV",
          rationale: "candidate evidence is clearly stronger",
          winningSpans: ["candidate-green"],
          losingSpans: ["baseline"],
          risks: [],
        }) } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const result = await runRealProxyReview({
      proxyRegistry,
      evolutionRegistry,
      releaseId,
      packetInput: makePacketInputBody(),
      authorizationCardPath: cardPath,
    });

    assert.equal(result.canPromote, true);
    assert.equal(result.finalVerdict, "APPROVE_DEV");
    assert.equal(result.artifact.budgetUsed.calls, 2);
    assert.equal(result.artifact.reviewTransport, "network");
    assert.equal(result.artifact.reviewerModelVersion, "gpt-5.6-sol-test");
    assert.equal(requests.length, 2);
    assert.match(requests[0].messages[0].content, /匿名/);
    assert.notEqual(requests[0].messages[1].content, requests[1].messages[1].content);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousEnv.key === undefined) delete process.env.NOVELOS_JUDGE_API_KEY;
    else process.env.NOVELOS_JUDGE_API_KEY = previousEnv.key;
    if (previousEnv.base === undefined) delete process.env.NOVELOS_JUDGE_BASE_URL;
    else process.env.NOVELOS_JUDGE_BASE_URL = previousEnv.base;
    if (previousEnv.model === undefined) delete process.env.NOVELOS_JUDGE_MODEL;
    else process.env.NOVELOS_JUDGE_MODEL = previousEnv.model;
    rmSync(root, { recursive: true, force: true });
  }
});

test("runRealProxyReview fails closed when the reviewer returns unknown or wrong-side spans", async () => {
  const root = makeTempRoot();
  const previousFetch = globalThis.fetch;
  const previousEnv = {
    key: process.env.NOVELOS_JUDGE_API_KEY,
    base: process.env.NOVELOS_JUDGE_BASE_URL,
    model: process.env.NOVELOS_JUDGE_MODEL,
  };
  try {
    const releaseId = "rel-real-invalid-spans";
    const evolutionRegistry = createEvolutionReleaseRegistry({ releasesDir: join(root, "releases") });
    evolutionRegistry.writeManifest(makeManifest(releaseId, "evaluated", {
      rollbackReleaseId: "rel-base",
      changeClass: "R2",
    }));
    writeMatchingStateEvent(evolutionRegistry, releaseId, "evaluated");
    const proxyRegistry = createProxyApprovalRegistry({ approvalsDir: join(root, "approvals") });
    const cardPath = join(root, "authorization-card.json");
    writeFileSync(cardPath, JSON.stringify({
      schemaId: "pinovel.evolution-authorization-card",
      schemaVersion: 1,
      cardId: "card-invalid-spans",
      cardType: "real_gpt56sol",
      model: "gpt5.6-sol",
      allowedReleaseIds: [releaseId],
      budget: { maxCalls: 2, timeoutMs: 60_000 },
      modelVersion: "gpt-5.6-sol-test",
      issuedAt: "2026-07-17T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      issuer: "authorized-user",
      authorizationProof: "explicit user authorization",
    }), "utf-8");

    process.env.NOVELOS_JUDGE_API_KEY = "test-secret";
    process.env.NOVELOS_JUDGE_BASE_URL = "https://judge.example.test/v1";
    process.env.NOVELOS_JUDGE_MODEL = "gpt-5.6-sol-test";
    globalThis.fetch = async () => new Response(JSON.stringify({
      model: "gpt-5.6-sol-test",
      choices: [{ message: { content: JSON.stringify({
        verdict: "APPROVE_DEV",
        rationale: "apparently stronger",
        winningSpans: ["unknown-span"],
        losingSpans: ["candidate-green"],
        risks: [],
      }) } }],
    }), { status: 200, headers: { "content-type": "application/json" } });

    const result = await runRealProxyReview({
      proxyRegistry,
      evolutionRegistry,
      releaseId,
      packetInput: makePacketInputBody(),
      authorizationCardPath: cardPath,
    });

    assert.equal(result.finalVerdict, "HOLD");
    assert.equal(result.canPromote, false);
    assert.match(result.blockReason || "", /HOLD|APPROVE_DEV/i);
    assert.ok(result.artifact.risks.some((risk) => /span/i.test(risk)));
    assert.deepEqual(result.artifact.winningSpans, []);
    assert.deepEqual(result.artifact.losingSpans, []);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousEnv.key === undefined) delete process.env.NOVELOS_JUDGE_API_KEY;
    else process.env.NOVELOS_JUDGE_API_KEY = previousEnv.key;
    if (previousEnv.base === undefined) delete process.env.NOVELOS_JUDGE_BASE_URL;
    else process.env.NOVELOS_JUDGE_BASE_URL = previousEnv.base;
    if (previousEnv.model === undefined) delete process.env.NOVELOS_JUDGE_MODEL;
    else process.env.NOVELOS_JUDGE_MODEL = previousEnv.model;
    rmSync(root, { recursive: true, force: true });
  }
});
