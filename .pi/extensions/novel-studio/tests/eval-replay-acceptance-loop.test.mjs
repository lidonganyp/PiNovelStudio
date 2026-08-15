/**
 * 离线回放与生产验收闭环（P0/P1/P3/P4/P5）契约测试
 *
 * 覆盖：
 *  - P0 eval-fixture-contract：fixture/manifest 校验 fail-closed、hash 规范化；
 *  - P1 eval-replay-isolation：隔离字段 fail-closed、scratch 生命周期、生产面污染检测；
 *  - P4 eval-failure-attribution：确定性归因、未分类检测、稳定性；
 *  - P3 eval-replay-matrix：pass@k / pass^k、四臂完整性、verdict 规则；
 *  - P5 eval-deterministic-grader：合成 runRoot 评分（全过 / 违规检出）。
 *
 * 运行方式：
 *   node --import ./tests/setup-test-env.mjs --test tests/eval-replay-acceptance-loop.test.mjs
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
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
    assert.match(lease.workspaceId, /^eval-stub-fixture\.smoke-001-run-/);
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
    sampleCount: 3,
    perSamplePass: [true, true, true],
    factHardErrors: 0,
    unclassifiedFailures: 0,
    avgCoverage: 0.9,
    avgCompleteness: 0.9,
    continuityViolations: 0,
    avgUserEditDistance: 0.1,
    modelCalls: 30,
    totalTokens: 90_000,
    totalCostUsd: 1.2,
    firstAttemptSuccessRate: 1,
    recoveredSuccessRate: 1,
    p50LatencyMs: 5_000,
    p95LatencyMs: 12_000,
    longTailFailures: 0,
    ...overrides,
  });

  it("四臂缺失检测", () => {
    const missing = matrix.validateMatrixArmCompleteness([buildArm("baseline")]);
    assert.equal(missing.complete, false);
    assert.deepEqual(missing.missing, ["candidate", "raw_direct", "recovery"]);
    const full = matrix.validateMatrixArmCompleteness([
      buildArm("baseline"),
      buildArm("candidate"),
      buildArm("raw_direct"),
      buildArm("recovery"),
    ]);
    assert.equal(full.complete, true);
  });

  it("零容忍违规（状态污染）→ reject", () => {
    const report = matrix.compareMatrixArms({
      candidateReleaseId: "rel-prod-110",
      candidateBundleId: "bundle-b",
      baselineReleaseId: "rel-prod-109",
      arms: [buildArm("baseline"), buildArm("candidate")],
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
      arms: [buildArm("baseline")],
    });
    assert.equal(report.verdict, "reject");
  });

  it("candidate 成功率退化超阈值 → reject；正常 → pass", () => {
    const degraded = matrix.compareMatrixArms({
      candidateReleaseId: "rel-prod-110",
      candidateBundleId: "bundle-b",
      baselineReleaseId: "rel-prod-109",
      arms: [
        buildArm("baseline", { firstAttemptSuccessRate: 1 }),
        buildArm("candidate", { firstAttemptSuccessRate: 0.7 }),
      ],
      maxSuccessRateRegression: 0,
    });
    assert.equal(degraded.verdict, "reject");

    const ok = matrix.compareMatrixArms({
      candidateReleaseId: "rel-prod-110",
      candidateBundleId: "bundle-b",
      baselineReleaseId: "rel-prod-109",
      arms: [
        buildArm("baseline"),
        buildArm("candidate", { perSamplePass: [true, false, true] }),
      ],
    });
    assert.equal(ok.verdict, "pass");
    assert.equal(ok.candidatePassAt3, 1); // n=3,k=3,c=2 → 1（任一组合含通过）
    assert.equal(ok.candidatePassPow3, 0); // 连续组未全过
  });

  it("人工盲评只存档、不影响 verdict", () => {
    const report = matrix.compareMatrixArms({
      candidateReleaseId: "rel-prod-110",
      candidateBundleId: "bundle-b",
      baselineReleaseId: "rel-prod-109",
      arms: [buildArm("baseline"), buildArm("candidate")],
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
    assert.equal(report.checks.length, 10);
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

  it("gradeDeterministicFromRunRoot：manifest 缺失 → fail-closed", () => {
    const report = grader.gradeDeterministicFromRunRoot(
      join(tmpRun, "definitely-not-exist"),
    );
    assert.equal(report.passed, false);
    assert.equal(report.runId, "(missing-manifest)");
  });
});
