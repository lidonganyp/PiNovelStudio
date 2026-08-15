/**
 * 离线回放与生产验收闭环（P0/P1/P3/P4/P5）契约测试
 *
 * 覆盖：
 *  - P0 eval-fixture-contract：fixture/manifest 校验 fail-closed、hash 规范化；
 *  - P1 eval-replay-isolation：隔离字段 fail-closed、scratch 生命周期、生产面污染检测；
 *  - P4 eval-failure-attribution：确定性归因、未分类检测、稳定性；
 *  - P3 eval-replay-matrix：pass@k / pass^k、四臂完整性、verdict 规则；
 *  - P5 eval-deterministic-grader：合成 runRoot 评分（全过 / 违规检出）；
 *  - F4 recorded/synthetic 传输适配器 + 冻结 ChapterSeed 注入 + 隔离 env 传输标记。
 *
 * 运行方式：
 *   node --import ./tests/setup-test-env.mjs --test tests/eval-replay-acceptance-loop.test.mjs
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// 测试从仓库根运行（process.cwd() = .pi/extensions/novel-studio），dist-eval 同级
const evalDist = join(process.cwd(), "dist-eval");

const fixtureContract = await import(
  `file://${join(evalDist, "v2", "core", "eval-fixture-contract.js")}`
);
const isolation = await import(
  `file://${join(evalDist, "v2", "core", "eval-replay-isolation.js")}`
);
const attribution = await import(
  `file://${join(evalDist, "v2", "core", "eval-failure-attribution.js")}`
);
const matrix = await import(
  `file://${join(evalDist, "v2", "core", "eval-replay-matrix.js")}`
);
const grader = await import(
  `file://${join(evalDist, "v2", "core", "eval-deterministic-grader.js")}`
);
const modelAdapter = await import(
  `file://${join(evalDist, "v2", "adapters", "legacy-model-route-adapter.js")}`
);
const workspaceAdapter = await import(
  `file://${join(evalDist, "v2", "adapters", "legacy-workspace-adapter.js")}`
);
const replayRunner = await import(
  `file://${join(evalDist, "eval", "full-pipeline-replay-runner.js")}`
);
const traceStats = await import(
  `file://${join(evalDist, "v2", "core", "eval-replay-trace-stats.js")}`
);

// ============================================================================
// 测试夹具构造
// ============================================================================

const HEX64 = (seed) => {
  let out = "";
  let h = 0;
  for (let i = 0; i < 64; i += 1) {
    h = (h * 31 + seed.charCodeAt(i % seed.length) + i) % 16;
    out += h.toString(16);
  }
  return out;
};

function buildValidFixture(overrides = {}) {
  return {
    schemaId: "pinovel.eval-fixture",
    schemaVersion: 1,
    fixtureId: "fixture.smoke-001",
    evalProtocolVersion: "pinovel.eval-protocol/1",
    evalOnly: true,
    replayMode: "stub",
    createdAt: "2026-08-15T00:00:00.000Z",
    provenance: {
      releaseId: "rel-prod-110",
      bundleId: "bundle-20260815",
      promptBundleHash: HEX64("prompt"),
      toolSchemaHash: HEX64("tool"),
      contextCompilerHash: HEX64("ctx"),
      budgetHash: HEX64("budget"),
      modelVersion: "gemini-3.1-pro-preview",
      modelRoute: "v2_rawstage2_gemini31",
      provider: "gemini",
      graderVersion: "deterministic-v1",
    },
    workspace: {
      sourceWorkspaceId: "ws-verify-01",
      config: { novelName: "测试小说", genre: "xianxia" },
      outline: "# 大纲",
      characterProfiles: { ch1: "主角档案" },
      historicalChapters: [
        {
          chapterNumber: 1,
          chapterId: "chapter-001",
          contentHash: HEX64("ch1"),
        },
      ],
    },
    chapterSeed: {
      chapterNumber: 2,
      chapterId: "chapter-002",
      chapterTitle: "第二章",
      intent: { chapterFunction: "escalation" },
      seedSource: "series/outline",
    },
    priorNarrativeState: { canon: [] },
    modelPolicy: {
      requestTimeoutMs: 60_000,
      totalTimeoutMs: 600_000,
      maxModelCalls: 40,
      maxRecoveryModelCalls: 4,
    },
    expectedInvariants: {
      statePollutionForbidden: true,
      productionPointerMutationForbidden: true,
      formalChapterSaveForbidden: true,
      traceArchiveRequired: true,
      scratchNarrativeStateCommitAllowed: true,
    },
    traceArchivePath: "runs/run-001/traces/chapter-002-quality-trace.json",
    ...overrides,
  };
}

// ============================================================================
// P0：EvalFixture 契约
// ============================================================================

describe("P0 eval-fixture-contract：fixture fail-closed 校验", () => {
  it("合法 fixture 通过校验", () => {
    const result = fixtureContract.validateEvalFixtureV1(buildValidFixture());
    assert.equal(result.valid, true, `errors: ${JSON.stringify(result.errors)}`);
  });

  it("evalOnly 非 true → invalid（回放不得进入统计）", () => {
    const result = fixtureContract.validateEvalFixtureV1(
      buildValidFixture({ evalOnly: false }),
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.field === "/evalOnly"));
  });

  it("evalProtocolVersion 不匹配 → invalid", () => {
    const result = fixtureContract.validateEvalFixtureV1(
      buildValidFixture({ evalProtocolVersion: "pinovel.eval-protocol/0" }),
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.field === "/evalProtocolVersion"));
  });

  it("schemaVersion 前向不识别 → invalid", () => {
    const result = fixtureContract.validateEvalFixtureV1(
      buildValidFixture({ schemaVersion: 2 }),
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.rule === "schema_version_mismatch"));
  });

  it("provenance hash 非法（短 hash 截断 15 位）→ invalid", () => {
    const broken = buildValidFixture();
    broken.provenance.promptBundleHash = "0123456789abcde"; // 15 位，非法
    const result = fixtureContract.validateEvalFixtureV1(broken);
    assert.equal(result.valid, false);
    assert.ok(
      result.errors.some(
        (e) =>
          e.field === "/provenance/promptBundleHash" &&
          e.rule === "invalid_hash_format",
      ),
    );
  });

  it("16 位短 hash 合法（PromptHashes 约定兼容）", () => {
    const fixture = buildValidFixture();
    fixture.provenance.promptBundleHash = "0123456789abcdef";
    const result = fixtureContract.validateEvalFixtureV1(fixture);
    assert.equal(result.valid, true);
  });

  it("安全不变量关闭（statePollutionForbidden=false）→ invalid", () => {
    const fixture = buildValidFixture();
    fixture.expectedInvariants.statePollutionForbidden = false;
    const result = fixtureContract.validateEvalFixtureV1(fixture);
    assert.equal(result.valid, false);
    assert.ok(
      result.errors.some((e) => e.rule === "must_be_literal_true"),
    );
  });

  it("hash 规范化：字段顺序不同 → 内容 hash 一致", () => {
    const a = buildValidFixture();
    const b = buildValidFixture();
    // 反转顶层键序 + provenance 键序
    const reverseKeys = (obj) =>
      Object.fromEntries(Object.entries(obj).reverse());
    const reordered = {
      ...reverseKeys(b),
      provenance: reverseKeys(b.provenance),
    };
    const hashA = fixtureContract.computeEvalFixtureHash(a);
    const hashB = fixtureContract.computeEvalFixtureHash(reordered);
    assert.equal(hashA, hashB);
    assert.match(hashA, /^[0-9a-f]{64}$/);
  });

  it("内容差异（1 字符）→ hash 不同", () => {
    const a = buildValidFixture();
    const b = buildValidFixture();
    b.chapterSeed.chapterTitle = "第二章改";
    assert.notEqual(
      fixtureContract.computeEvalFixtureHash(a),
      fixtureContract.computeEvalFixtureHash(b),
    );
  });
});

describe("P0 eval-fixture-contract：ReplayRunManifest 校验", () => {
  const buildEntry = (overrides = {}) => ({
    fixtureId: "fixture.smoke-001",
    fixtureHash: HEX64("f"),
    replayMode: "stub",
    scratchWorkspaceId: "eval-stub-fixture-smoke-001-run-x",
    status: "completed",
    failureAttribution: null,
    failureEnvelopes: [],
    traceArchived: true,
    traceArchivePath: "runs/run-001/samples/fixture.smoke-001/traces",
    isolationViolations: [],
    modelCalls: 0,
    durationMs: 1200,
    ...overrides,
  });

  const buildManifest = (overrides = {}) => ({
    schemaId: "pinovel.eval-replay-run-manifest",
    schemaVersion: 1,
    runId: "run-001",
    evalProtocolVersion: "pinovel.eval-protocol/1",
    replayMode: "stub",
    releaseId: "rel-prod-110",
    bundleId: "bundle-20260815",
    runRoot: "runs/run-001",
    startedAt: "2026-08-15T00:00:00.000Z",
    finishedAt: "2026-08-15T00:01:00.000Z",
    samples: [buildEntry()],
    summary: {
      totalSamples: 1,
      countedSamples: 1,
      completed: 1,
      failed: 0,
      skipped: 0,
      traceRetentionRate: 1,
      isolationViolationCount: 0,
    },
    ...overrides,
  });

  it("合法 manifest 通过校验", () => {
    const result = fixtureContract.validateReplayRunManifestV1(buildManifest());
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  it("样本存在隔离违规 → manifest invalid（不得进入结果统计）", () => {
    const result = fixtureContract.validateReplayRunManifestV1(
      buildManifest({
        samples: [
          buildEntry({
            isolationViolations: [
              { kind: "production_pointer_mutation", detail: "pointer 被改" },
            ],
          }),
        ],
      }),
    );
    assert.equal(result.valid, false);
    assert.ok(
      result.errors.some((e) => e.rule === "isolation_violation_present"),
    );
  });

  it("样本 fixtureHash 非 64 hex → invalid", () => {
    const result = fixtureContract.validateReplayRunManifestV1(
      buildManifest({
        samples: [buildEntry({ fixtureHash: "deadbeef" })],
      }),
    );
    assert.equal(result.valid, false);
  });

  it("evalProtocolVersion 不匹配 → invalid", () => {
    const result = fixtureContract.validateReplayRunManifestV1(
      buildManifest({ evalProtocolVersion: "wrong" }),
    );
    assert.equal(result.valid, false);
  });
});

// ============================================================================
// P1：回放隔离层
// ============================================================================

describe("P0.2 真实 trace 模型调用统计", () => {
  it("从 v2_final_selected.evidence.modelCalls 统计 3 次 Gemini 生产路由", () => {
    const trace = {
      gates: [
        { stage: "v2_novelos_agentic", evidence: {} },
        {
          stage: "v2_final_selected",
          evidence: {
            modelCalls: [
              {
                route: "v2_rawstage2",
                requestedRoute: "v2_rawstage2_gemini31",
                provider: "gemini31",
                actualProvider: "gemini31",
                expectedProvider: "gemini31",
                actualModel: "gemini-3.1-pro-preview",
                expectedModel: "gemini-3.1-pro-preview",
              },
              {
                route: "v2_amplified_gemini31",
                requestedRoute: "v2_amplified_gemini31",
                provider: "gemini31",
                actualProvider: "gemini31",
                expectedProvider: "gemini31",
                actualModel: "gemini-3.1-pro-preview",
                expectedModel: "gemini-3.1-pro-preview",
              },
              {
                route: "v2_amplified_gemini31",
                requestedRoute: "v2_amplified_gemini31",
                provider: "gemini31",
                actualProvider: "gemini31",
                expectedProvider: "gemini31",
                actualModel: "gemini-3.1-pro-preview",
                expectedModel: "gemini-3.1-pro-preview",
              },
            ],
            releaseGovernance: {
              devMode: false,
              releaseId: "rel-prod-116",
              environmentFingerprint: "fp-116",
              approvalRef: "apr-116",
              behaviorIdentity: {
                bundleId: "bundle-116",
                modelVersion: "gemini-3.1-pro-preview",
              },
            },
          },
        },
      ],
    };
    const calls = traceStats.extractReplayModelCalls(trace);
    const stats = traceStats.summarizeReplayModelCalls(calls);
    assert.equal(stats.modelCalls, 3);
    assert.equal(stats.byProvider.gemini31, 3);
    assert.equal(stats.byRequestedRoute.v2_rawstage2_gemini31, 1);
    assert.equal(stats.byRequestedRoute.v2_amplified_gemini31, 2);
    assert.equal(stats.unauthorizedCrossModelCount, 0);
    const identity = traceStats.extractReplayReleaseIdentity(trace);
    assert.equal(identity.devMode, false);
    assert.equal(identity.releaseId, "rel-prod-116");
    assert.equal(identity.bundleId, "bundle-116");
  });

  it("顶层 modelCalls 为空时不得把真实调用统计成 0", () => {
    const trace = {
      modelCalls: [],
      gates: [
        {
          stage: "v2_final_selected",
          evidence: {
            modelCalls: [
              {
                requestedRoute: "v2_rawstage2_gemini31",
                actualProvider: "gemini31",
                expectedProvider: "gemini31",
              },
            ],
          },
        },
      ],
    };
    const stats = traceStats.summarizeReplayModelCalls(traceStats.extractReplayModelCalls(trace));
    assert.equal(stats.modelCalls, 1);
  });

  it("汇总 tokenCost 与 recoveryAttempts，不把缺失写成虚构 0 成本以外的已测值", () => {
    const trace = {
      recoveryAttempts: [{ reason: "timeout" }],
      gates: [
        {
          stage: "v2_final_selected",
          evidence: {
            modelCalls: [
              {
                requestedRoute: "v2_rawstage2_gemini31",
                actualProvider: "gemini31",
                tokenUsage: { in: 1602, out: 3746 },
              },
              {
                requestedRoute: "v2_amplified_gemini31",
                actualProvider: "gemini31",
                tokenUsage: { in: 1719, out: 4705 },
              },
            ],
          },
        },
      ],
    };
    const calls = traceStats.extractReplayModelCalls(trace);
    const stats = traceStats.summarizeReplayModelCalls(
      calls,
      traceStats.extractReplayRecoveryAttempts(trace),
    );
    assert.equal(stats.modelCalls, 2);
    assert.equal(stats.tokenIn, 3321);
    assert.equal(stats.tokenOut, 8451);
    assert.equal(stats.tokenCost, 11772);
    assert.equal(stats.recoveryAttempts, 1);
  });
});

describe("P1 eval-replay-isolation：fail-closed 与 scratch 生命周期", () => {
  it("production_like 指向 rel-dev-* release → 隔离违规", () => {
    const fixture = buildValidFixture({
      replayMode: "production_like",
    });
    fixture.provenance.releaseId = "rel-dev-999";
    const { ok, violations } =
      isolation.validateReplayIsolationPrerequisites(fixture);
    assert.equal(ok, false);
    assert.ok(
      violations.some((v) => v.kind === "missing_isolation_fields"),
    );
  });

  it("production_like 指向 rel-prod-* release → 通过", () => {
    const fixture = buildValidFixture({ replayMode: "production_like" });
    const { ok, violations } =
      isolation.validateReplayIsolationPrerequisites(fixture);
    assert.equal(ok, true, JSON.stringify(violations));
  });

  it("buildReplayIsolationEnv：真实模型模式字段缺失 → 抛错 fail-closed", () => {
    const broken = buildValidFixture({ replayMode: "dev_real_model" });
    broken.provenance.bundleId = "";
    assert.throws(
      () => isolation.buildReplayIsolationEnv(broken),
      /fail-closed/,
    );
  });

  it("buildReplayIsolationEnv：完整字段 → 携带全部隔离变量", () => {
    const fixture = buildValidFixture({ replayMode: "dev_real_model" });
    const env = isolation.buildReplayIsolationEnv(fixture);
    assert.equal(env.PINOVEL_EVAL_ONLY, "1");
    assert.equal(env.PINOVEL_EVAL_RELEASE_ID, "rel-prod-110");
    assert.equal(env.PINOVEL_EVAL_BUNDLE_ID, "bundle-20260815");
    assert.equal(env.PINOVEL_EVAL_TRACE_ARCHIVE_PATH, fixture.traceArchivePath);
    assert.equal(env.PINOVEL_DEV_MODE, "1");
    assert.equal(
      isolation.assertReplayIsolationEnv(env, { requireRealModelFields: true })
        .ok,
      true,
    );
  });

  it("production_like 不得设置 PINOVEL_DEV_MODE，必须传播真实治理根", () => {
    const fixture = buildValidFixture({ replayMode: "production_like" });
    const sourceRoot = join(__dirname, ".tmp-eval-prod-like-env");
    mkdirSync(join(sourceRoot, "config", "evolution-release"), { recursive: true });
    writeFileSync(
      join(sourceRoot, "config", "evolution-release", "active-production.json"),
      JSON.stringify({ releaseId: "rel-prod-110" }),
      "utf-8",
    );
    try {
      const env = isolation.buildReplayIsolationEnv(fixture, process.env, undefined, {
        sourceProjectRoot: sourceRoot,
      });
      assert.notEqual(env.PINOVEL_DEV_MODE, "1");
      assert.equal(env.PINOVEL_DEV_MODE, undefined);
      assert.ok(String(env.PINOVEL_EVOLUTION_ROOT).includes("evolution-release"));
      assert.equal(env.PINOVEL_FINGERPRINT_ROOT, sourceRoot);
    } finally {
      rmSync(sourceRoot, { recursive: true, force: true });
    }
  });

  it("production_like 缺少 sourceProjectRoot → fail-closed", () => {
    const fixture = buildValidFixture({ replayMode: "production_like" });
    assert.throws(
      () => isolation.buildReplayIsolationEnv(fixture),
      /sourceProjectRoot/,
    );
  });

  it("assertReplayIsolationEnv：缺真实模型字段 → 违规", () => {
    const { ok, violations } = isolation.assertReplayIsolationEnv(
      { PINOVEL_EVAL_ONLY: "1", PINOVEL_EVAL_PROTOCOL_VERSION: "pinovel.eval-protocol/1" },
      { requireRealModelFields: true },
    );
    assert.equal(ok, false);
    assert.equal(violations.length, 3);
  });
});

describe("P1 eval-replay-isolation：scratch workspace 与生产面", () => {
  // 使用临时目录，避免污染仓库 .pi/eval-scratch
  const tmpRoot = join(__dirname, ".tmp-eval-scratch-test");
  const fakeProjectRoot = join(tmpRoot, "project");

  before(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    mkdirSync(join(fakeProjectRoot, "workspaces", "ws-real"), {
      recursive: true,
    });
    mkdirSync(
      join(fakeProjectRoot, "config", "evolution-release"),
      { recursive: true },
    );
    writeFileSync(
      join(fakeProjectRoot, "config", "evolution-release", "active-production.json"),
      JSON.stringify({ releaseId: "rel-prod-109" }),
    );
    writeFileSync(
      join(fakeProjectRoot, "workspaces", "ws-real", "config.json"),
      "{}",
    );
  });

  after(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("createScratchWorkspace：marker 写入 + eval- 前缀 workspaceId + cleanup 清除", () => {
    const fixture = buildValidFixture();
    const lease = isolation.createScratchWorkspace({
      projectRoot: fakeProjectRoot,
      fixture,
      scratchParentDir: join(tmpRoot, "scratch"),
    });
    // sanitizeScratchToken 白名单与工具侧 workspaceId 校验对齐（禁 "."）：
    // fixture.smoke-001 -> eval-stub-fixture-smoke-001-run-xxx
    assert.match(lease.workspaceId, /^eval-stub-fixture-smoke-001-run-/);
    assert.ok(existsSync(lease.markerPath), "scratch marker 必须存在");
    assert.ok(lease.workspacePath.startsWith(lease.scratchRoot));

    const marker = isolation.readScratchMarker(lease.scratchRoot);
    assert.equal(marker.ok, true);
    assert.equal(marker.marker.fixtureId, fixture.fixtureId);
    assert.equal(marker.marker.evalOnly, true);

    // 路径边界：scratch 内路径可写；scratch 外路径拒绝
    assert.equal(
      isolation.isPathInsideScratch(lease, join(lease.workspacePath, "chapters")),
      true,
    );
    assert.throws(() =>
      isolation.assertWritablePath(lease, join(fakeProjectRoot, "workspaces", "ws-real", "chapters", "x.json")),
    );

    isolation.cleanupScratchWorkspace(lease);
    assert.equal(existsSync(lease.scratchRoot), false, "cleanup 后 scratch 根应删除");
  });

  it("materializeScratchProjectSkeleton：真实模型回放同时复制 quality-gates.json", () => {
    const routingDir = join(fakeProjectRoot, "config");
    mkdirSync(routingDir, { recursive: true });
    writeFileSync(join(routingDir, "model-routing.json"), "{\"ok\":true}\n");
    writeFileSync(join(routingDir, "quality-gates.json"), "{\"gates\":[]}\n");
    const scratchRoot = join(tmpRoot, "scratch-quality-gates");
    rmSync(scratchRoot, { recursive: true, force: true });
    isolation.materializeScratchProjectSkeleton(scratchRoot, {
      projectRoot: fakeProjectRoot,
      copyModelRouting: true,
    });
    assert.equal(existsSync(join(scratchRoot, "config", "model-routing.json")), true);
    assert.equal(existsSync(join(scratchRoot, "config", "quality-gates.json")), true);
  });

  it("cleanup 拒绝无 marker 的目录（防误删正式目录）", () => {
    const evil = join(tmpRoot, "not-a-scratch");
    mkdirSync(evil, { recursive: true });
    assert.throws(
      () =>
        isolation.cleanupScratchWorkspace({
          leaseId: "fake",
          scratchRoot: evil,
          workspaceId: "eval-fake",
          workspacePath: join(evil, "workspaces", "eval-fake"),
          markerPath: join(evil, isolation.SCRATCH_MARKER_FILENAME),
          fixtureId: "fixture.x",
          replayMode: "stub",
          sourceProjectRoot: fakeProjectRoot,
          createdAt: new Date().toISOString(),
        }),
    );
  });

  it("生产面零变化 → 0 违规；pointer 变化 → production_pointer_mutation", () => {
    // 显式注入 evolutionRoot：测试环境可能设置 PINOVEL_EVOLUTION_ROOT
    // 指向真实治理目录，默认解析不会落到 fakeProjectRoot。
    const paths = {
      evolutionRoot: join(fakeProjectRoot, "config", "evolution-release"),
    };
    const before = isolation.captureProductionSurface(fakeProjectRoot, paths);
    const unchanged = isolation.captureProductionSurface(fakeProjectRoot, paths);
    assert.equal(
      isolation.detectProductionSurfacePollution(before, unchanged).length,
      0,
    );

    writeFileSync(
      join(fakeProjectRoot, "config", "evolution-release", "active-production.json"),
      JSON.stringify({ releaseId: "rel-prod-110" }),
    );
    const after = isolation.captureProductionSurface(fakeProjectRoot, paths);
    const violations = isolation.detectProductionSurfacePollution(before, after);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].kind, "production_pointer_mutation");

    // 恢复现场，避免影响后续用例
    writeFileSync(
      join(fakeProjectRoot, "config", "evolution-release", "active-production.json"),
      JSON.stringify({ releaseId: "rel-prod-109" }),
    );
  });

  it("正式 workspace 新增章节文件 → formal_chapter_save 污染", () => {
    const before = isolation.captureProductionSurface(fakeProjectRoot);
    mkdirSync(join(fakeProjectRoot, "workspaces", "ws-real", "chapters"), {
      recursive: true,
    });
    writeFileSync(
      join(fakeProjectRoot, "workspaces", "ws-real", "chapters", "chapter-001.md"),
      "正文",
    );
    const after = isolation.captureProductionSurface(fakeProjectRoot);
    const violations = isolation.detectProductionSurfacePollution(before, after);
    assert.ok(
      violations.some((v) => v.kind === "formal_chapter_save"),
      JSON.stringify(violations),
    );
  });
});

describe("production_like 必须走扩展 invoke 脚本，不得默认锁 GLM", () => {
  it("resolveInvokeGenerateChapterScript 优先选择扩展脚本", () => {
    const tmpRoot = join(__dirname, ".tmp-invoke-script-resolution");
    rmSync(tmpRoot, { recursive: true, force: true });
    const repoScript = join(tmpRoot, "scripts", "invoke-generate-chapter.mjs");
    const extScript = join(
      tmpRoot,
      ".pi",
      "extensions",
      "novel-studio",
      "scripts",
      "invoke-generate-chapter.mjs",
    );
    mkdirSync(dirname(repoScript), { recursive: true });
    mkdirSync(dirname(extScript), { recursive: true });
    writeFileSync(repoScript, "export const kind = 'repo-dev-lock';\n");
    writeFileSync(extScript, "export const kind = 'extension-prod';\n");
    try {
      const resolved = replayRunner.resolveInvokeGenerateChapterScript(tmpRoot);
      assert.equal(resolved, extScript);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("Gemini 生产路由的 invoke 参数不得带 model-test-route", () => {
    const fixture = buildValidFixture({
      replayMode: "production_like",
    });
    fixture.provenance.modelRoute = "v2_rawstage2_gemini31";
    const resolved = replayRunner.resolveModelRouteInvokeArgs(fixture);
    assert.equal(resolved.ok, true);
    assert.deepEqual(resolved.args, []);
    assert.equal(
      resolved.args.some((arg) => String(arg).includes("model-test-route")),
      false,
    );
  });
});

// ============================================================================
// P4：失败归因
// ============================================================================

describe("P4 eval-failure-attribution：确定性归因", () => {
  it("超时 → timeout", () => {
    const r = attribution.classifyFailureAttribution({
      stage: "2-narrator",
      gate: "model_timeout",
      reason: "请求超时",
    });
    assert.equal(r.attribution, "timeout");
    assert.match(r.ruleId, /^rule:/);
  });

  it("provider 5xx / 配额 → provider_network", () => {
    const r = attribution.classifyFailureAttribution({
      failureType: "provider_error",
      reason: "503 service unavailable",
    });
    assert.equal(r.attribution, "provider_network");
  });

  it("schema 解析失败 → tool_protocol", () => {
    const r = attribution.classifyFailureAttribution({
      errorClass: "parse_error",
      reason: "malformed json from tool response",
    });
    assert.equal(r.attribution, "tool_protocol");
  });

  it("memory hard conflict → state_commit", () => {
    const r = attribution.classifyFailureAttribution({
      gate: "final_state_commit",
      reason: "memory_hard_conflict blocked commit",
    });
    assert.equal(r.attribution, "state_commit");
  });

  it("空响应 → model；未知描述 → unclassified", () => {
    assert.equal(
      attribution.classifyFailureAttribution({ reason: "empty response from writer" })
        .attribution,
      "model",
    );
    assert.equal(
      attribution.classifyFailureAttribution({ reason: "something totally novel" })
        .attribution,
      "unclassified",
    );
  });

  it("归因稳定性：一致 → true；声明随机性 → 允许不一致", () => {
    const a = attribution.classifyFailureAttribution({ reason: "timed out" });
    const b = attribution.classifyFailureAttribution({ reason: "timed out" });
    assert.equal(attribution.isAttributionStable([a, b]), true);

    const c = attribution.classifyFailureAttribution({
      reason: "unknown blip",
      randomnessDeclared: true,
    });
    const d = attribution.classifyFailureAttribution({ reason: "timed out" });
    assert.equal(attribution.isAttributionStable([c, d]), true);
  });

  it("汇总与未分类检测器", () => {
    const results = [
      attribution.classifyFailureAttribution({ reason: "timed out" }),
      attribution.classifyFailureAttribution({ reason: "quota exceeded" }),
      attribution.classifyFailureAttribution({ reason: "mystery" }),
    ];
    const summary = attribution.summarizeAttributions(results);
    assert.equal(summary.total, 3);
    assert.equal(summary.classified, 2);
    assert.equal(summary.unclassified, 1);
    assert.equal(attribution.detectUnclassifiedFailures(results).length, 1);
  });
});

// ============================================================================
// P3：回放矩阵
// ============================================================================

describe("P3 eval-replay-matrix：pass@k / pass^k 计算", () => {
  it("computePassAtK 标准值", () => {
    assert.equal(matrix.computePassAtK([true, true, true], 3), 1);
    assert.equal(matrix.computePassAtK([false, false, false], 3), 0);
    // n=10, c=9, k=3（Codex 论文示例 ≈ 0.9997）
    const samples = Array.from({ length: 10 }, (_, i) => i < 9);
    const v = matrix.computePassAtK(samples, 3);
    assert.ok(v !== null && v > 0.999 && v <= 1, `pass@3=${v}`);
  });

  it("computePassAtK 样本不足 → null", () => {
    assert.equal(matrix.computePassAtK([true, true], 3), null);
    assert.equal(matrix.computePassAtK([], 1), null);
    assert.equal(matrix.computePassAtK([true], 0), null);
  });

  it("computePassPowK 连续组语义", () => {
    assert.equal(matrix.computePassPowK([true, true, true], 3), 1);
    assert.equal(matrix.computePassPowK([true, false, true], 3), 0);
    // 6 样本 2 组全过 → 1
    assert.equal(matrix.computePassPowK([true, true, true, true, true, true], 3), 1);
    // 4 样本：第 1 组全过、尾部 1 样本不足 k 按未通过 → 0.5
    assert.equal(matrix.computePassPowK([true, true, true, true], 3), 0.5);
    assert.equal(matrix.computePassPowK([], 3), null);
  });

  it("percentile：空数组 0；P50 中位数插值", () => {
    assert.equal(matrix.percentile([], 50), 0);
    assert.equal(matrix.percentile([10, 20], 50), 15);
    assert.equal(matrix.percentile([10, 20, 30], 50), 20);
  });
});

describe("P3 eval-replay-matrix：四臂完整性与 verdict", () => {
  const buildArm = (armId, overrides = {}) => ({
    armId,
    runId: `run-${armId}`,
    sampleCount: 3,
    perSamplePass: [true, true, true],
    factHardErrors: 0,
    failureClassificationCompleteness: 1,
    coverage: 0.9,
    completeness: 0.9,
    continuity: 0.95,
    userEditDistance: 0.1,
    modelCalls: 30,
    tokenCost: 90_000,
    firstAttemptSuccessRate: 1,
    recoveredSuccessRate: 1,
    p50LatencyMs: 5_000,
    p95LatencyMs: 12_000,
    longTailFailures: 0,
    ...overrides,
  });

  const buildFourArms = (overrides = {}) => [
    buildArm("baseline", overrides.baseline),
    buildArm("candidate", overrides.candidate),
    buildArm("raw_direct", overrides.raw_direct),
    buildArm("recovery", overrides.recovery),
  ];

  it("四臂缺失检测", () => {
    const missing = matrix.validateMatrixArmCompleteness([buildArm("baseline")]);
    assert.equal(missing.complete, false);
    assert.deepEqual(missing.missing, ["candidate", "raw_direct", "recovery"]);
    const full = matrix.validateMatrixArmCompleteness(buildFourArms());
    assert.equal(full.complete, true);
  });

  it("零容忍违规（状态污染）→ reject", () => {
    const report = matrix.compareMatrixArms({
      candidateReleaseId: "rel-prod-110",
      candidateBundleId: "bundle-b",
      baselineReleaseId: "rel-prod-109",
      arms: buildFourArms(),
      zeroTolerance: {
        ...matrix.EMPTY_ZERO_TOLERANCE,
        statePollution: 1,
      },
    });
    assert.equal(report.verdict, "reject");
    assert.ok(report.verdictReasons.some((r) => r.includes("状态污染")));
  });

  it("缺少 candidate 臂 → reject", () => {
    const report = matrix.compareMatrixArms({
      candidateReleaseId: "rel-prod-110",
      candidateBundleId: "bundle-b",
      baselineReleaseId: "rel-prod-109",
      arms: [buildArm("baseline"), buildArm("raw_direct"), buildArm("recovery")],
    });
    assert.equal(report.verdict, "reject");
    assert.ok(report.verdictReasons.some((r) => r.includes("candidate")));
  });

  it("F2：四臂不完整（仅 baseline + candidate）→ reject（不再放行）", () => {
    const report = matrix.compareMatrixArms({
      candidateReleaseId: "rel-prod-110",
      candidateBundleId: "bundle-b",
      baselineReleaseId: "rel-prod-109",
      arms: [buildArm("baseline"), buildArm("candidate")],
    });
    assert.equal(report.verdict, "reject");
    assert.ok(report.verdictReasons.some((r) => r.includes("四臂不完整")));
    assert.ok(report.verdictReasons.some((r) => r.includes("raw_direct")));
  });

  it("F2：四臂齐全但 candidate pass^3 < 1 → reject", () => {
    const report = matrix.compareMatrixArms({
      candidateReleaseId: "rel-prod-110",
      candidateBundleId: "bundle-b",
      baselineReleaseId: "rel-prod-109",
      arms: buildFourArms({ candidate: { perSamplePass: [true, false, true] } }),
    });
    assert.equal(report.verdict, "reject");
    assert.ok(report.verdictReasons.some((r) => r.includes("pass^3")));
    assert.equal(report.candidatePassAt3, 1); // 能力估计仍记录
    assert.equal(report.candidatePassPow3, 0); // 连续组未全过
  });

  it("F2：candidate 样本不足（pass^3 = null）→ reject", () => {
    const report = matrix.compareMatrixArms({
      candidateReleaseId: "rel-prod-110",
      candidateBundleId: "bundle-b",
      baselineReleaseId: "rel-prod-109",
      arms: buildFourArms({
        candidate: { sampleCount: 2, perSamplePass: [true, true] },
      }),
    });
    assert.equal(report.verdict, "reject");
    assert.ok(report.verdictReasons.some((r) => r.includes("样本不足")));
  });

  it("F2：任意臂 factHardErrors > 0 → reject", () => {
    const report = matrix.compareMatrixArms({
      candidateReleaseId: "rel-prod-110",
      candidateBundleId: "bundle-b",
      baselineReleaseId: "rel-prod-109",
      arms: buildFourArms({ recovery: { factHardErrors: 2 } }),
    });
    assert.equal(report.verdict, "reject");
    assert.ok(report.verdictReasons.some((r) => r.includes("事实硬错")));
  });

  it("F2：任意臂失败分类完整率 < 1 → reject", () => {
    const report = matrix.compareMatrixArms({
      candidateReleaseId: "rel-prod-110",
      candidateBundleId: "bundle-b",
      baselineReleaseId: "rel-prod-109",
      arms: buildFourArms({
        candidate: { failureClassificationCompleteness: 0.8 },
      }),
    });
    assert.equal(report.verdict, "reject");
    assert.ok(report.verdictReasons.some((r) => r.includes("未分类失败")));
  });

  it("F2：任意臂 coverage/completeness/continuity 低于阈值 → reject", () => {
    const lowCoverage = matrix.compareMatrixArms({
      candidateReleaseId: "rel-prod-110",
      candidateBundleId: "bundle-b",
      baselineReleaseId: "rel-prod-109",
      arms: buildFourArms({ baseline: { coverage: 0.5 } }),
    });
    assert.equal(lowCoverage.verdict, "reject");
    assert.ok(lowCoverage.verdictReasons.some((r) => r.includes("coverage")));

    const lowContinuity = matrix.compareMatrixArms({
      candidateReleaseId: "rel-prod-110",
      candidateBundleId: "bundle-b",
      baselineReleaseId: "rel-prod-109",
      arms: buildFourArms({ candidate: { continuity: 0.3 } }),
    });
    assert.equal(lowContinuity.verdict, "reject");
    assert.ok(lowContinuity.verdictReasons.some((r) => r.includes("continuity")));
  });

  it("candidate 成功率退化超阈值 → reject；四臂全过 + pass^3=1 → pass", () => {
    const degraded = matrix.compareMatrixArms({
      candidateReleaseId: "rel-prod-110",
      candidateBundleId: "bundle-b",
      baselineReleaseId: "rel-prod-109",
      arms: buildFourArms({ candidate: { firstAttemptSuccessRate: 0.7 } }),
      maxSuccessRateRegression: 0,
    });
    assert.equal(degraded.verdict, "reject");
    assert.ok(degraded.verdictReasons.some((r) => r.includes("首次成功率退化")));

    const ok = matrix.compareMatrixArms({
      candidateReleaseId: "rel-prod-110",
      candidateBundleId: "bundle-b",
      baselineReleaseId: "rel-prod-109",
      arms: buildFourArms(),
    });
    assert.equal(ok.verdict, "pass");
    assert.deepEqual(ok.verdictReasons, []);
    assert.equal(ok.candidatePassPow3, 1);
  });

  it("人工盲评只存档、不影响 verdict", () => {
    const report = matrix.compareMatrixArms({
      candidateReleaseId: "rel-prod-110",
      candidateBundleId: "bundle-b",
      baselineReleaseId: "rel-prod-109",
      arms: buildFourArms(),
      humanBlindPreference: {
        blindPackId: "blind-001",
        totalVotes: 10,
        candidatePreferred: 0,
        baselinePreferred: 10,
        tie: 0,
      },
    });
    assert.equal(report.verdict, "pass");
    assert.equal(report.humanBlindPreference.baselinePreferred, 10);
  });
});

// ============================================================================
// P5：确定性 Grader（合成 runRoot）
// ============================================================================

describe("P5 eval-deterministic-grader：合成 runRoot 评分", () => {
  const tmpRun = join(__dirname, ".tmp-eval-grader-run");

  const buildManifestEntry = (fixture, tracePath, overrides = {}) => ({
    fixtureId: fixture.fixtureId,
    fixtureHash: fixtureContract.computeEvalFixtureHash(fixture),
    replayMode: fixture.replayMode,
    scratchWorkspaceId: "eval-stub-x",
    status: "completed",
    failureAttribution: null,
    failureEnvelopes: [],
    traceArchived: true,
    traceArchivePath: tracePath,
    isolationViolations: [],
    modelCalls: 0,
    durationMs: 500,
    ...overrides,
  });

  before(() => {
    rmSync(tmpRun, { recursive: true, force: true });
  });

  after(() => {
    rmSync(tmpRun, { recursive: true, force: true });
  });

  it("完整合规 runRoot → 全部检查通过", () => {
    const fixture = buildValidFixture();
    const sampleDir = join(tmpRun, "samples", fixture.fixtureId);
    const tracesDir = join(sampleDir, "traces");
    mkdirSync(tracesDir, { recursive: true });
    writeFileSync(
      join(sampleDir, "fixture.json"),
      JSON.stringify(fixture, null, 2),
    );
    const traceFile = join(tracesDir, "chapter-002-quality-trace.json");
    writeFileSync(traceFile, JSON.stringify({ stageResults: [], recoveryAttempts: [] }));
    writeFileSync(
      join(sampleDir, "state-projection.json"),
      JSON.stringify({ narrativeStateHash: HEX64("state") }),
    );

    const manifest = {
      schemaId: "pinovel.eval-replay-run-manifest",
      schemaVersion: 1,
      runId: "run-grade-001",
      evalProtocolVersion: "pinovel.eval-protocol/1",
      replayMode: "stub",
      releaseId: fixture.provenance.releaseId,
      bundleId: fixture.provenance.bundleId,
      runRoot: tmpRun,
      startedAt: "2026-08-15T00:00:00.000Z",
      finishedAt: "2026-08-15T00:01:00.000Z",
      samples: [buildManifestEntry(fixture, traceFile)],
      summary: {
        totalSamples: 1,
        countedSamples: 1,
        completed: 1,
        failed: 0,
        skipped: 0,
        traceRetentionRate: 1,
        isolationViolationCount: 0,
      },
    };

    const report = grader.gradeDeterministic(manifest, tmpRun);
    assert.equal(
      report.passed,
      true,
      JSON.stringify(
        report.checks.filter((c) => !c.passed).map((c) => c.violations),
        null,
        2,
      ),
    );
    assert.equal(report.failedChecks.length, 0);
    assert.equal(report.checks.length, 11);
  });

  it("trace 归档缺失 → trace_retention 违规；failed 无 envelope → silent_degrade 违规", () => {
    const fixture = buildValidFixture({
      fixtureId: "fixture.broken-002",
    });
    const sampleDir = join(tmpRun, "samples", fixture.fixtureId);
    mkdirSync(sampleDir, { recursive: true });
    writeFileSync(
      join(sampleDir, "fixture.json"),
      JSON.stringify(fixture, null, 2),
    );
    // 故意不写 traces / state-projection

    const manifest = {
      schemaId: "pinovel.eval-replay-run-manifest",
      schemaVersion: 1,
      runId: "run-grade-002",
      evalProtocolVersion: "pinovel.eval-protocol/1",
      replayMode: "stub",
      releaseId: fixture.provenance.releaseId,
      bundleId: fixture.provenance.bundleId,
      runRoot: tmpRun,
      startedAt: "2026-08-15T00:00:00.000Z",
      finishedAt: "2026-08-15T00:01:00.000Z",
      samples: [
        buildManifestEntry(fixture, join(sampleDir, "traces", "missing.json"), {
          status: "failed",
        }),
      ],
      summary: {
        totalSamples: 1,
        countedSamples: 1,
        completed: 0,
        failed: 1,
        skipped: 0,
        traceRetentionRate: 1,
        isolationViolationCount: 0,
      },
    };

    const report = grader.gradeDeterministic(manifest, tmpRun);
    assert.equal(report.passed, false);
    assert.ok(report.failedChecks.includes("trace_retention"));
    assert.ok(report.failedChecks.includes("silent_degrade"));
    assert.ok(report.failedChecks.includes("failure_envelope_completeness"));
  });

  it("production_like 归档 trace 有 2 次 gate 调用但 manifest.modelCalls=0 → model_call_evidence 失败", () => {
    const fixture = buildValidFixture({
      fixtureId: "fixture.model-calls-mismatch-115b",
      replayMode: "production_like",
    });
    const sampleDir = join(tmpRun, "samples", fixture.fixtureId);
    const tracesDir = join(sampleDir, "traces");
    mkdirSync(tracesDir, { recursive: true });
    writeFileSync(join(sampleDir, "fixture.json"), JSON.stringify(fixture, null, 2));
    writeFileSync(
      join(sampleDir, "state-projection.json"),
      JSON.stringify({ narrativeStateHash: HEX64("state-115b") }),
    );
    const traceFile = join(tracesDir, "chapter-002-quality-trace.json");
    writeFileSync(
      traceFile,
      JSON.stringify({
        modelCalls: [],
        gates: [
          {
            stage: "v2_final_selected",
            evidence: {
              modelCalls: [
                {
                  requestedRoute: "v2_rawstage2_gemini31",
                  actualProvider: "gemini31",
                  expectedProvider: "gemini31",
                  tokenUsage: { in: 1602, out: 3746 },
                },
                {
                  requestedRoute: "v2_amplified_gemini31",
                  actualProvider: "gemini31",
                  expectedProvider: "gemini31",
                  tokenUsage: { in: 1719, out: 4705 },
                },
              ],
            },
          },
        ],
      }),
    );

    const manifest = {
      schemaId: "pinovel.eval-replay-run-manifest",
      schemaVersion: 1,
      runId: "run-grade-115b-mismatch",
      evalProtocolVersion: "pinovel.eval-protocol/1",
      replayMode: "production_like",
      releaseId: fixture.provenance.releaseId,
      bundleId: fixture.provenance.bundleId,
      runRoot: tmpRun,
      startedAt: "2026-08-15T00:00:00.000Z",
      finishedAt: "2026-08-15T00:01:00.000Z",
      samples: [
        buildManifestEntry(fixture, traceFile, {
          replayMode: "production_like",
          modelCalls: 0,
        }),
      ],
      summary: {
        totalSamples: 1,
        countedSamples: 1,
        completed: 1,
        failed: 0,
        skipped: 0,
        traceRetentionRate: 1,
        isolationViolationCount: 0,
      },
    };

    const report = grader.gradeDeterministic(manifest, tmpRun);
    assert.equal(report.passed, false);
    assert.ok(report.failedChecks.includes("model_call_evidence"));
    const check = report.checks.find((c) => c.name === "model_call_evidence");
    assert.ok(
      check.violations.some((v) => v.detail.includes("manifest=0") && v.detail.includes("trace=2")),
      JSON.stringify(check.violations),
    );
  });

  it("gradeDeterministicFromRunRoot：manifest 缺失 → fail-closed", () => {
    const report = grader.gradeDeterministicFromRunRoot(
      join(tmpRun, "definitely-not-exist"),
    );
    assert.equal(report.passed, false);
    assert.equal(report.runId, "(missing-manifest)");
  });

  it("F3：samples: null 的损坏 manifest → 结构化失败（不抛 TypeError）", () => {
    const fixture = buildValidFixture({ fixtureId: "fixture.corrupt-003" });
    const corrupt = {
      schemaId: "pinovel.eval-replay-run-manifest",
      schemaVersion: 1,
      runId: "run-corrupt-003",
      evalProtocolVersion: "pinovel.eval-protocol/1",
      replayMode: "stub",
      releaseId: fixture.provenance.releaseId,
      bundleId: fixture.provenance.bundleId,
      runRoot: tmpRun,
      startedAt: "2026-08-15T00:00:00.000Z",
      finishedAt: "2026-08-15T00:01:00.000Z",
      samples: null,
      summary: null,
    };
    let report;
    assert.doesNotThrow(() => {
      report = grader.gradeDeterministic(corrupt, tmpRun);
    });
    assert.equal(report.passed, false);
    assert.equal(report.runId, "run-corrupt-003");
    assert.deepEqual(report.failedChecks, ["manifest_schema"]);
    assert.ok(
      report.checks[0].violations[0].detail.includes("samples"),
      `违规明细应指向 samples：${report.checks[0].violations[0].detail}`,
    );
  });

  it("F3：非对象 manifest 与 summary 缺失 → 结构化失败（不抛 TypeError）", () => {
    let notObject;
    assert.doesNotThrow(() => {
      notObject = grader.gradeDeterministic("not-an-object");
    });
    assert.equal(notObject.passed, false);
    assert.equal(notObject.runId, "(invalid-manifest)");
    assert.deepEqual(notObject.failedChecks, ["manifest_schema"]);

    let nullManifest;
    assert.doesNotThrow(() => {
      nullManifest = grader.gradeDeterministic(null, tmpRun);
    });
    assert.equal(nullManifest.passed, false);
    assert.deepEqual(nullManifest.failedChecks, ["manifest_schema"]);

    // runRoot 未显式传入且 manifest 无 runRoot 字段 → fail-closed
    const noRunRoot = {
      schemaId: "pinovel.eval-replay-run-manifest",
      schemaVersion: 1,
      runId: "run-corrupt-004",
      releaseId: "rel-x",
      bundleId: "bundle-x",
      samples: [],
      summary: { isolationViolationCount: 0 },
    };
    let missingRunRoot;
    assert.doesNotThrow(() => {
      missingRunRoot = grader.gradeDeterministic(noRunRoot);
    });
    assert.equal(missingRunRoot.passed, false);
    assert.ok(missingRunRoot.checks[0].violations[0].detail.includes("runRoot"));
  });

  it("F3：gradeDeterministicFromRunRoot 读取损坏 manifest.json → 结构化失败", () => {
    const corruptRoot = join(tmpRun, "corrupt-run-root");
    mkdirSync(corruptRoot, { recursive: true });
    writeFileSync(
      join(corruptRoot, "manifest.json"),
      JSON.stringify({ runId: "run-corrupt-005", samples: null, summary: null }),
    );
    let report;
    assert.doesNotThrow(() => {
      report = grader.gradeDeterministicFromRunRoot(corruptRoot);
    });
    assert.equal(report.passed, false);
    assert.equal(report.runId, "run-corrupt-005");
    assert.deepEqual(report.failedChecks, ["manifest_schema"]);
  });
});

// ============================================================================
// F4：recorded/synthetic 回放传输 + 冻结 ChapterSeed 注入（离线回放闭环）
// ============================================================================

describe("F4-1 契约：frozenFullSeed / syntheticFaultPlan / recorded 模式强制", () => {
  it("合法 recorded fixture（含 response + 匹配 responseHash）通过校验", () => {
    // canonical 形式：扁平对象键已按字母序（model < text），JSON.stringify 即 canonical 串
    const canonical = '{"model":"test-model","text":"预录正文内容"}';
    const responseHash = createHash("sha256").update(canonical, "utf-8").digest("hex");
    const result = fixtureContract.validateEvalFixtureV1(
      buildValidFixture({
        replayMode: "recorded",
        recordedToolResults: [
          {
            toolName: "novel_generate_chapter",
            responseHash,
            response: { model: "test-model", text: "预录正文内容" },
          },
        ],
      }),
    );
    assert.equal(result.valid, true, `errors: ${JSON.stringify(result.errors)}`);
  });

  it("recorded 模式缺 recordedToolResults -> recorded_mode_requires_responses", () => {
    const result = fixtureContract.validateEvalFixtureV1(
      buildValidFixture({ replayMode: "recorded" }),
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.rule === "recorded_mode_requires_responses"));
  });

  it("recorded 模式 hash-only 条目（无 response）-> recorded_response_payload_required", () => {
    const result = fixtureContract.validateEvalFixtureV1(
      buildValidFixture({
        replayMode: "recorded",
        recordedToolResults: [
          { toolName: "novel_generate_chapter", responseHash: HEX64("hashonly") },
        ],
      }),
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.rule === "recorded_response_payload_required"));
  });

  it("stub 模式携带 syntheticFaultPlan -> synthetic_plan_mode_mismatch", () => {
    const result = fixtureContract.validateEvalFixtureV1(
      buildValidFixture({ syntheticFaultPlan: [{ fault: "timeout", atCall: 1 }] }),
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.rule === "synthetic_plan_mode_mismatch"));
  });

  it("合法 synthetic fixture 通过校验", () => {
    const result = fixtureContract.validateEvalFixtureV1(
      buildValidFixture({
        replayMode: "synthetic",
        syntheticFaultPlan: [
          { fault: "schema_error", atCall: 2, message: "第二次调用注入截断 JSON" },
        ],
      }),
    );
    assert.equal(result.valid, true, `errors: ${JSON.stringify(result.errors)}`);
  });

  it("synthetic 非法 fault 种类 -> invalid_fault_kind", () => {
    const result = fixtureContract.validateEvalFixtureV1(
      buildValidFixture({
        replayMode: "synthetic",
        syntheticFaultPlan: [{ fault: "nuclear_meltdown" }],
      }),
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.rule === "invalid_fault_kind"));
  });

  it("synthetic atCall=0 -> invalid（必须为 >=1 整数）", () => {
    const result = fixtureContract.validateEvalFixtureV1(
      buildValidFixture({
        replayMode: "synthetic",
        syntheticFaultPlan: [{ fault: "timeout", atCall: 0 }],
      }),
    );
    assert.equal(result.valid, false);
    assert.ok(
      result.errors.some(
        (e) => e.field === "/syntheticFaultPlan/0/atCall" && e.rule === "invalid",
      ),
    );
  });

  it("frozenFullSeed chapterId 身份不匹配 -> identity_mismatch", () => {
    const result = fixtureContract.validateEvalFixtureV1(
      buildValidFixture({
        chapterSeed: {
          chapterNumber: 2,
          chapterId: "chapter-002",
          chapterTitle: "第二章",
          intent: { chapterFunction: "escalation" },
          seedSource: "series/outline",
          frozenFullSeed: {
            workspaceId: "ws-src",
            chapterNumber: 2,
            chapterId: "chapter-999",
            intent: { chapterFunction: "escalation" },
            seedSource: "frozen",
          },
        },
      }),
    );
    assert.equal(result.valid, false);
    assert.ok(
      result.errors.some(
        (e) => e.rule === "identity_mismatch" && e.field.includes("frozenFullSeed"),
      ),
    );
  });

  it("frozenFullSeed 非对象 -> invalid", () => {
    const result = fixtureContract.validateEvalFixtureV1(
      buildValidFixture({
        chapterSeed: {
          chapterNumber: 2,
          chapterId: "chapter-002",
          chapterTitle: "第二章",
          intent: { chapterFunction: "escalation" },
          seedSource: "series/outline",
          frozenFullSeed: "not-an-object",
        },
      }),
    );
    assert.equal(result.valid, false);
    assert.ok(
      result.errors.some((e) => e.field === "/chapterSeed/frozenFullSeed" && e.rule === "invalid"),
    );
  });

  it("合法 frozenFullSeed（身份一致）通过校验", () => {
    const result = fixtureContract.validateEvalFixtureV1(
      buildValidFixture({
        chapterSeed: {
          chapterNumber: 2,
          chapterId: "chapter-002",
          chapterTitle: "第二章",
          intent: { chapterFunction: "escalation" },
          seedSource: "series/outline",
          frozenFullSeed: {
            workspaceId: "ws-src",
            chapterNumber: 2,
            chapterId: "chapter-002",
            intent: { chapterFunction: "escalation" },
            seedSource: "frozen",
          },
        },
      }),
    );
    assert.equal(result.valid, true, `errors: ${JSON.stringify(result.errors)}`);
  });
});

describe("F4-3 传输适配器：recorded / synthetic fail-closed 行为", () => {
  const MODEL_INPUT = {
    route: "v2_rawstage2_gemini31",
    kind: "raw_chapter",
    timeoutMs: 30_000,
  };
  const recordedResponse = { model: "test-model", text: "预录正文内容" };
  const recordedCanonical = '{"model":"test-model","text":"预录正文内容"}';
  const recordedHash = createHash("sha256").update(recordedCanonical, "utf-8").digest("hex");

  it("recorded：合法条目按预录 payload 回放（hash 一致 + text 原样）", async () => {
    const fn = modelAdapter.createRecordedModelGenerateFn([
      {
        toolName: "novel_generate_chapter",
        responseHash: recordedHash,
        response: recordedResponse,
      },
    ]);
    const out = await fn(MODEL_INPUT);
    assert.equal(out.text, "预录正文内容");
    assert.equal(out.model, "test-model");
    assert.equal(out.route, "v2_rawstage2_gemini31");
  });

  it("recorded：responseHash 不一致 -> 抛错拒绝回放", async () => {
    const fn = modelAdapter.createRecordedModelGenerateFn([
      {
        toolName: "novel_generate_chapter",
        responseHash: "a".repeat(64),
        response: recordedResponse,
      },
    ]);
    await assert.rejects(() => fn(MODEL_INPUT), /responseHash 不一致/);
  });

  it("recorded：预录序列耗尽 -> 抛错（不静默回退 stub/网络）", async () => {
    const fn = modelAdapter.createRecordedModelGenerateFn([]);
    await assert.rejects(() => fn(MODEL_INPUT), /预录序列耗尽/);
  });

  it("recorded：条目缺 response -> 抛错", async () => {
    const fn = modelAdapter.createRecordedModelGenerateFn([{ responseHash: recordedHash }]);
    await assert.rejects(() => fn(MODEL_INPUT), /response 必须为对象/);
  });

  it("synthetic：schema_error -> 截断 JSON 文本（可触发 parser retry）", async () => {
    const fn = modelAdapter.createSyntheticModelGenerateFn([{ fault: "schema_error" }]);
    const out = await fn(MODEL_INPUT);
    assert.ok(out.text.startsWith("{"), "schema_error 文本应为 JSON 开头");
    assert.ok(!out.text.endsWith("}"), "schema_error 文本应为截断 JSON");
  });

  it("synthetic：empty_output -> 空文本", async () => {
    const fn = modelAdapter.createSyntheticModelGenerateFn([{ fault: "empty_output" }]);
    const out = await fn(MODEL_INPUT);
    assert.equal(out.text, "");
  });

  it("synthetic：timeout -> 立即 reject（不等待真实超时）", async () => {
    const fn = modelAdapter.createSyntheticModelGenerateFn([{ fault: "timeout" }]);
    await assert.rejects(() => fn(MODEL_INPUT), /超时/);
  });

  it("synthetic：provider_error -> reject 含 429 证据", async () => {
    const fn = modelAdapter.createSyntheticModelGenerateFn([{ fault: "provider_error" }]);
    await assert.rejects(() => fn(MODEL_INPUT), /429/);
  });

  it("synthetic：atCall=2 定点注入（第 1 次正常 stub，第 2 次故障）", async () => {
    const fn = modelAdapter.createSyntheticModelGenerateFn([{ fault: "empty_output", atCall: 2 }]);
    const first = await fn(MODEL_INPUT);
    assert.ok(typeof first.text === "string" && first.text.length > 0, "第 1 次调用应正常");
    const second = await fn(MODEL_INPUT);
    assert.equal(second.text, "", "第 2 次调用应注入 empty_output");
  });

  it("synthetic：未知 fault 种类 -> 构造即抛", () => {
    assert.throws(
      () => modelAdapter.createSyntheticModelGenerateFn([{ fault: "no_such_fault" }]),
      /未知 fault 种类/,
    );
  });

  it("loadRecordedEntriesFromPath：不存在 / 非法 JSON / 空数组 -> fail-closed", () => {
    const tmpDir = join(__dirname, ".tmp-f4-transport");
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
    try {
      assert.throws(
        () => modelAdapter.loadRecordedEntriesFromPath(join(tmpDir, "missing.json")),
        /无法读取/,
      );
      const badJsonPath = join(tmpDir, "bad.json");
      writeFileSync(badJsonPath, "not-json");
      assert.throws(
        () => modelAdapter.loadRecordedEntriesFromPath(badJsonPath),
        /不是合法 JSON/,
      );
      const emptyPath = join(tmpDir, "empty.json");
      writeFileSync(emptyPath, "[]");
      assert.throws(
        () => modelAdapter.loadRecordedEntriesFromPath(emptyPath),
        /必须是非空数组/,
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("createEvalReplayModelGenerateFnFromEnv：无传输 env -> null；recorded/synthetic env -> 对应传输", async () => {
    const saved = { ...process.env };
    const TRANSPORT_ENV_KEYS = [
      "PINOVEL_EVAL_RECORDED_RESULTS_PATH",
      "PINOVEL_EVAL_SYNTHETIC_FAULTS",
      "PINOVEL_EVAL_SYNTHETIC_FAULTS_PATH",
    ];
    for (const key of TRANSPORT_ENV_KEYS) delete process.env[key];
    try {
      assert.equal(modelAdapter.createEvalReplayModelGenerateFnFromEnv(), null);

      const tmpDir = join(__dirname, ".tmp-f4-env");
      rmSync(tmpDir, { recursive: true, force: true });
      mkdirSync(tmpDir, { recursive: true });
      try {
        const resultsPath = join(tmpDir, "results.json");
        writeFileSync(
          resultsPath,
          JSON.stringify([
            {
              toolName: "novel_generate_chapter",
              responseHash: recordedHash,
              response: recordedResponse,
            },
          ]),
        );
        process.env.PINOVEL_EVAL_RECORDED_RESULTS_PATH = resultsPath;
        const recordedFn = modelAdapter.createEvalReplayModelGenerateFnFromEnv();
        assert.ok(typeof recordedFn === "function", "recorded env 应产生传输函数");
        const out = await recordedFn(MODEL_INPUT);
        assert.equal(out.text, "预录正文内容");

        delete process.env.PINOVEL_EVAL_RECORDED_RESULTS_PATH;
        process.env.PINOVEL_EVAL_SYNTHETIC_FAULTS = JSON.stringify([{ fault: "timeout" }]);
        const syntheticFn = modelAdapter.createEvalReplayModelGenerateFnFromEnv();
        assert.ok(typeof syntheticFn === "function", "synthetic env 应产生传输函数");
        await assert.rejects(() => syntheticFn(MODEL_INPUT), /超时/);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    } finally {
      for (const key of TRANSPORT_ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });
});

describe("F4-2 冻结 ChapterSeed：loadChapterSeed 优先消费冻结注入", () => {
  const tmpWs = join(__dirname, ".tmp-f4-frozen-ws");

  before(() => {
    rmSync(tmpWs, { recursive: true, force: true });
    mkdirSync(join(tmpWs, "series"), { recursive: true });
    // 兜底 config：身份不匹配回退推导路径时 loadWorkspaceConfig 有可用输入
    writeFileSync(
      join(tmpWs, "config.json"),
      JSON.stringify({ novelName: "回放测试", genre: "xianxia" }, null, 2),
    );
    writeFileSync(
      join(tmpWs, "series", workspaceAdapter.FROZEN_CHAPTER_SEED_FILENAME),
      JSON.stringify({
        workspaceId: "ws-source-original",
        chapterNumber: 2,
        chapterId: "chapter-002",
        chapterTitle: "冻结标题",
        intent: { chapterFunction: "payoff", notes: "frozen" },
        seedSource: "frozen",
      }),
    );
  });

  after(() => {
    rmSync(tmpWs, { recursive: true, force: true });
  });

  it("身份匹配 -> 原样返回冻结 seed（仅重写 workspaceId）+ 消费 warning", () => {
    const bundle = {
      workspaceId: "eval-scratch-xyz",
      workspacePath: tmpWs,
      projectRoot: join(tmpWs, ".."),
      config: { novelName: "回放测试" },
    };
    const result = workspaceAdapter.loadChapterSeed(bundle, 2, "chapter-002");
    assert.ok(result.seed, "冻结 seed 必须非空");
    assert.equal(result.seed.chapterTitle, "冻结标题");
    assert.equal(result.seed.chapterId, "chapter-002");
    assert.equal(result.seed.workspaceId, "eval-scratch-xyz", "workspaceId 必须重写为 scratch 身份");
    assert.equal(result.seed.intent.notes, "frozen", "冻结字段必须原样保留");
    assert.ok(result.warnings.some((w) => w.includes("冻结")));
  });

  it("身份不匹配 -> 回退推导路径 + 身份不匹配 warning（不抛错）", () => {
    const bundle = {
      workspaceId: "eval-scratch-xyz",
      workspacePath: tmpWs,
      projectRoot: join(tmpWs, ".."),
      config: { novelName: "回放测试" },
    };
    let result;
    assert.doesNotThrow(() => {
      result = workspaceAdapter.loadChapterSeed(bundle, 3, "chapter-003");
    });
    assert.ok(
      result.warnings.some((w) => w.includes("身份不匹配")),
      `warnings 应含身份不匹配提示：${JSON.stringify(result.warnings)}`,
    );
  });
});

describe("F4-4 隔离 env：确定性回放模式携带传输标记", () => {
  it("stub/recorded/synthetic -> V2_FORCE_STUB=1 + PINOVEL_EVAL_REPLAY_TRANSPORT=mode", () => {
    for (const mode of ["stub", "recorded", "synthetic"]) {
      const fixture = buildValidFixture({ replayMode: mode });
      if (mode === "recorded") {
        fixture.recordedToolResults = [
          {
            toolName: "novel_generate_chapter",
            responseHash: HEX64("envtest"),
            response: { text: "x" },
          },
        ];
      }
      const env = isolation.buildReplayIsolationEnv(fixture);
      assert.equal(env.V2_FORCE_STUB, "1", `${mode} 模式必须兜底 V2_FORCE_STUB=1`);
      assert.equal(env.PINOVEL_EVAL_REPLAY_TRANSPORT, mode, `${mode} 模式必须声明传输`);
    }
  });

  it("dev_real_model / production_like -> 不携带确定性传输标记（走真实模型）", () => {
    const sourceRoot = join(__dirname, ".tmp-eval-prod-like-transport");
    mkdirSync(join(sourceRoot, "config", "evolution-release"), { recursive: true });
    writeFileSync(
      join(sourceRoot, "config", "evolution-release", "active-production.json"),
      JSON.stringify({ releaseId: "rel-prod-110" }),
      "utf-8",
    );
    try {
      for (const mode of ["dev_real_model", "production_like"]) {
        const fixture = buildValidFixture({ replayMode: mode });
        const env = isolation.buildReplayIsolationEnv(
          fixture,
          process.env,
          undefined,
          mode === "production_like" ? { sourceProjectRoot: sourceRoot } : undefined,
        );
        assert.equal(env.V2_FORCE_STUB, undefined, `${mode} 不应设置 V2_FORCE_STUB`);
        assert.equal(env.PINOVEL_EVAL_REPLAY_TRANSPORT, undefined, `${mode} 不应声明确定性传输`);
      }
    } finally {
      rmSync(sourceRoot, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// 生产矩阵生成器 + 成功 invoke 不得污染归因
// ============================================================================

describe("矩阵报告必须由回放 run 生成，不得手写两字段过门", () => {
  const tmpMatrix = join(__dirname, ".tmp-eval-matrix-gen");

  before(() => {
    mkdirSync(tmpMatrix, { recursive: true });
  });
  after(() => {
    rmSync(tmpMatrix, { recursive: true, force: true });
  });

  const writeArmRun = (armId, sampleCount = 3) => {
    const runRoot = join(tmpMatrix, armId);
    mkdirSync(join(runRoot, "samples"), { recursive: true });
    const samples = [];
    for (let i = 0; i < sampleCount; i += 1) {
      samples.push({
        fixtureId: `fixture.${armId}.${i + 1}`,
        fixtureHash: HEX64(`${armId}-${i}`),
        replayMode: "stub",
        scratchWorkspaceId: `eval-${armId}-${i}`,
        status: "completed",
        failureAttribution: null,
        failureEnvelopes: [],
        traceArchived: true,
        traceArchivePath: join(runRoot, "samples", `fixture.${armId}.${i + 1}`, "traces"),
        isolationViolations: [],
        modelCalls: 0,
        durationMs: 400 + i,
      });
    }
    const manifest = {
      schemaId: "pinovel.eval-replay-run-manifest",
      schemaVersion: 1,
      runId: `run-${armId}`,
      evalProtocolVersion: "pinovel.eval-protocol/1",
      replayMode: "stub",
      releaseId: "rel-prod-110",
      bundleId: "bundle-20260815",
      runRoot,
      startedAt: "2026-08-15T00:00:00.000Z",
      finishedAt: "2026-08-15T00:01:00.000Z",
      samples,
      summary: {
        totalSamples: sampleCount,
        countedSamples: sampleCount,
        completed: sampleCount,
        failed: 0,
        skipped: 0,
        traceRetentionRate: 1,
        isolationViolationCount: 0,
      },
    };
    writeFileSync(join(runRoot, "manifest.json"), JSON.stringify(manifest, null, 2));
    return runRoot;
  };

  it("generateMatrixReportFromReplayRuns 写出 schema/hash/release/bundle 绑定", () => {
    const report = matrix.generateMatrixReportFromReplayRuns({
      candidateReleaseId: "rel-prod-110",
      candidateBundleId: "bundle-20260815",
      baselineReleaseId: "rel-prod-109",
      armRunRoots: {
        baseline: writeArmRun("baseline"),
        candidate: writeArmRun("candidate"),
        raw_direct: writeArmRun("raw_direct"),
        recovery: writeArmRun("recovery"),
      },
      codeCommit: "abc1234deadbeef",
    });
    assert.equal(report.schemaId, "pinovel.eval-replay-matrix");
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.candidateReleaseId, "rel-prod-110");
    assert.equal(report.candidateBundleId, "bundle-20260815");
    assert.equal(report.codeCommit, "abc1234deadbeef");
    assert.equal(report.arms.length, 4);
    assert.equal(report.verdict, "pass");
    assert.equal(report.candidatePassPow3, 1);
    assert.match(report.reportHash, /^[0-9a-f]{64}$/);
    assert.equal(report.reportHash, matrix.computeMatrixReportHash(report));
  });

  it("缺臂时生成器仍产出合法报告且 verdict=reject", () => {
    const report = matrix.generateMatrixReportFromReplayRuns({
      candidateReleaseId: "rel-prod-110",
      candidateBundleId: "bundle-20260815",
      baselineReleaseId: "rel-prod-109",
      armRunRoots: {
        candidate: writeArmRun("candidate-only"),
      },
      codeCommit: "abc1234deadbeef",
    });
    assert.equal(report.verdict, "reject");
    assert.ok(report.verdictReasons.some((r) => r.includes("四臂不完整")));
  });

  it("deriveArmMetrics 从 gate modelCalls 读 tokenCost，不写死 0 / 100%", () => {
    const runRoot = join(tmpMatrix, "trace-cost-arm");
    const fixtureId = "fixture.trace-cost.1";
    const tracesDir = join(runRoot, "samples", fixtureId, "traces");
    mkdirSync(tracesDir, { recursive: true });
    writeFileSync(
      join(tracesDir, "chapter-002-quality-trace.json"),
      JSON.stringify({
        modelCalls: [],
        recoveryAttempts: [],
        gates: [
          {
            stage: "v2_final_selected",
            evidence: {
              modelCalls: [
                {
                  requestedRoute: "v2_rawstage2_gemini31",
                  actualProvider: "gemini31",
                  tokenUsage: { in: 1602, out: 3746 },
                },
                {
                  requestedRoute: "v2_amplified_gemini31",
                  actualProvider: "gemini31",
                  tokenUsage: { in: 1719, out: 4705 },
                },
              ],
            },
          },
        ],
      }),
    );
    const recoveredFixtureId = "fixture.trace-cost.2";
    mkdirSync(join(runRoot, "samples", recoveredFixtureId, "traces"), { recursive: true });
    writeFileSync(
      join(runRoot, "samples", recoveredFixtureId, "traces", "chapter-002-quality-trace.json"),
      JSON.stringify({
        recoveryAttempts: [{ reason: "timeout" }],
        gates: [
          {
            stage: "v2_final_selected",
            evidence: {
              modelCalls: [
                {
                  requestedRoute: "v2_rawstage2_gemini31",
                  actualProvider: "gemini31",
                  tokenUsage: { in: 100, out: 200 },
                },
              ],
            },
          },
        ],
      }),
    );
    const tailFixtureId = "fixture.trace-cost.3";
    mkdirSync(join(runRoot, "samples", tailFixtureId, "traces"), { recursive: true });
    writeFileSync(
      join(runRoot, "samples", tailFixtureId, "traces", "chapter-002-quality-trace.json"),
      JSON.stringify({
        recoveryAttempts: [],
        gates: [{ stage: "v2_final_selected", evidence: { modelCalls: [] } }],
      }),
    );
    const shortSamples = Array.from({ length: 17 }, (_, i) => ({
      fixtureId: `fixture.trace-cost.short.${i + 1}`,
      fixtureHash: HEX64(`short-${i}`),
      replayMode: "production_like",
      scratchWorkspaceId: `eval-short-${i}`,
      status: "completed",
      failureAttribution: null,
      failureEnvelopes: [],
      traceArchived: true,
      traceArchivePath: join(runRoot, "samples", fixtureId, "traces"),
      isolationViolations: [],
      modelCalls: 0,
      durationMs: 400,
    }));
    const manifest = {
      schemaId: "pinovel.eval-replay-run-manifest",
      schemaVersion: 1,
      runId: "run-trace-cost",
      evalProtocolVersion: "pinovel.eval-protocol/1",
      replayMode: "production_like",
      releaseId: "rel-prod-110",
      bundleId: "bundle-20260815",
      runRoot,
      startedAt: "2026-08-15T00:00:00.000Z",
      finishedAt: "2026-08-15T00:01:00.000Z",
      samples: [
        {
          fixtureId,
          fixtureHash: HEX64("trace-cost-1"),
          replayMode: "production_like",
          scratchWorkspaceId: "eval-trace-cost-1",
          status: "completed",
          failureAttribution: null,
          failureEnvelopes: [],
          traceArchived: true,
          traceArchivePath: tracesDir,
          isolationViolations: [],
          modelCalls: 2,
          durationMs: 400,
        },
        {
          fixtureId: recoveredFixtureId,
          fixtureHash: HEX64("trace-cost-2"),
          replayMode: "production_like",
          scratchWorkspaceId: "eval-trace-cost-2",
          status: "completed",
          failureAttribution: null,
          failureEnvelopes: [],
          traceArchived: true,
          traceArchivePath: join(runRoot, "samples", recoveredFixtureId, "traces"),
          isolationViolations: [],
          modelCalls: 1,
          durationMs: 800,
        },
        {
          fixtureId: tailFixtureId,
          fixtureHash: HEX64("trace-cost-3"),
          replayMode: "production_like",
          scratchWorkspaceId: "eval-trace-cost-3",
          status: "failed",
          failureAttribution: "model_timeout",
          failureEnvelopes: [{ stage: "raw", reason: "timeout", severity: "hard" }],
          traceArchived: true,
          traceArchivePath: join(runRoot, "samples", tailFixtureId, "traces"),
          isolationViolations: [],
          modelCalls: 0,
          durationMs: 20_000,
        },
        ...shortSamples,
      ],
      summary: {
        totalSamples: 20,
        countedSamples: 20,
        completed: 19,
        failed: 1,
        skipped: 0,
        traceRetentionRate: 1,
        isolationViolationCount: 0,
      },
    };
    writeFileSync(join(runRoot, "manifest.json"), JSON.stringify(manifest, null, 2));

    const arm = matrix.deriveArmMetricsFromReplayManifest(manifest, "candidate", { runRoot });
    assert.equal(arm.tokenCost, 12072, `tokenCost 应从 traces 汇总，实际 ${arm.tokenCost}`);
    assert.equal(arm.userEditDistance, null);
    assert.equal(arm.firstAttemptSuccessRate, 18 / 20);
    assert.equal(arm.recoveredSuccessRate, 1);
    assert.equal(arm.longTailFailures, 1);
  });
});

describe("成功 invoke 不得记入失败归因", () => {
  it("无 envelope + exit 0 + 未超时 → attribution=null", () => {
    const result = replayRunner.resolveSampleAttribution({
      envelopes: [],
      timedOut: false,
      exitCode: 0,
      stderr: "",
    });
    assert.equal(result, null);
  });

  it("invoke 失败仍分类，不得 silently drop", () => {
    const result = replayRunner.resolveSampleAttribution({
      envelopes: [],
      timedOut: false,
      exitCode: 1,
      stderr: "boom",
    });
    assert.ok(result);
    assert.equal(result.attribution, "replay_environment");
  });
});
