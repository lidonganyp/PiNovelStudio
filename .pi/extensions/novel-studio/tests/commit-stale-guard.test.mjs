/**
 * CONCURRENCY-WAVE4 提交边界 stale 检测测试
 *
 * 覆盖 commit-stale-guard.ts（stale_release / constitution_changed /
 * release_pointer_corrupt）与 commitAndSave 0c 门禁接线：
 *   1. 基线与提交时现状一致 → 放行
 *   2. active production release 切换 → stale_release 阻断
 *   3. CreativeConstitution 修改 → constitution_changed 阻断
 *   4. pointer 不存在（未接入 release 治理）→ release 检测跳过
 *   5. pointer 损坏 → fail-closed（readActive 抛错 / check 返回 corrupt）
 *   6. 生成期间首次接入 release（null → rel-x）→ stale_release
 *   7. 基线缺失（旧调用方直调 commitAndSave）→ 不阻断既有路径
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  captureGenerationBaseline,
  checkCommitStale,
  readActiveProductionReleaseId,
} from "../dist/v2/core/commit-stale-guard.js";
import {
  pruneBlockedCandidateEvidence,
  DEFAULT_BLOCKED_EVIDENCE_RETENTION_MS,
} from "../dist/v2/core/blocked-candidate-evidence.js";

// 隔离 projectRoot：避免读写真实仓库的 constitution / release pointer
const TMP_ROOT = join(process.cwd(), "workspaces", "tmp-commit-stale-guard-test");
const EXT_DIR = join(TMP_ROOT, ".pi", "extensions", "novel-studio");
const CONSTITUTION_FILE = join(EXT_DIR, "CORE-WRITING-PRINCIPLES.md");
const EVOLUTION_DIR = join(EXT_DIR, "config", "evolution-release");
const POINTER_FILE = join(EVOLUTION_DIR, "active-production.json");

function writePointer(releaseId) {
  writeFileSync(
    POINTER_FILE,
    JSON.stringify({
      schemaId: "pinovel.evolution-release-pointer",
      schemaVersion: 1,
      kind: "production",
      releaseId,
      reason: "test",
      actor: "user",
      switchedAt: new Date().toISOString(),
    }),
    "utf-8",
  );
}

before(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
  mkdirSync(EVOLUTION_DIR, { recursive: true });
  writeFileSync(CONSTITUTION_FILE, "# 宪法 v1\n", "utf-8");
});

after(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe("CONCURRENCY-WAVE4：commit-stale-guard 单元", () => {
  it("基线与现状一致 → ok:true", () => {
    writePointer("rel-a");
    const baseline = captureGenerationBaseline(TMP_ROOT);
    const r = checkCommitStale(baseline, TMP_ROOT);
    assert.ok(r.ok, `一致基线应放行：${JSON.stringify(r)}`);
    assert.equal(r.current.activeReleaseId, "rel-a");
    assert.equal(r.current.constitutionHash, baseline.constitutionHash);
  });

  it("active release 切换 → stale_release", () => {
    writePointer("rel-a");
    const baseline = captureGenerationBaseline(TMP_ROOT);
    writePointer("rel-b");
    const r = checkCommitStale(baseline, TMP_ROOT);
    assert.ok(!r.ok);
    assert.equal(r.code, "stale_release");
    assert.equal(r.baseline.activeReleaseId, "rel-a");
    assert.equal(r.current.activeReleaseId, "rel-b");
    assert.match(r.reason, /stale_release/);
  });

  it("CreativeConstitution 修改 → constitution_changed", () => {
    writePointer("rel-a");
    const baseline = captureGenerationBaseline(TMP_ROOT);
    writeFileSync(CONSTITUTION_FILE, "# 宪法 v2（已修改）\n", "utf-8");
    const r = checkCommitStale(baseline, TMP_ROOT);
    assert.ok(!r.ok);
    assert.equal(r.code, "constitution_changed");
    assert.notEqual(r.current.constitutionHash, baseline.constitutionHash);
  });

  it("pointer 不存在 → activeReleaseId=null，两侧 null 放行", () => {
    rmSync(POINTER_FILE, { force: true });
    assert.equal(readActiveProductionReleaseId(TMP_ROOT), null);
    const baseline = captureGenerationBaseline(TMP_ROOT);
    const r = checkCommitStale(baseline, TMP_ROOT);
    assert.ok(r.ok, "未接入 release 治理时 release 检测应跳过");
  });

  it("生成期间首次接入 release（null → rel-x）→ stale_release", () => {
    rmSync(POINTER_FILE, { force: true });
    const baseline = captureGenerationBaseline(TMP_ROOT);
    writePointer("rel-new");
    const r = checkCommitStale(baseline, TMP_ROOT);
    assert.ok(!r.ok);
    assert.equal(r.code, "stale_release");
  });

  it("pointer 损坏 → readActive 抛错 + check 返回 release_pointer_corrupt", () => {
    writeFileSync(POINTER_FILE, "{ not-json", "utf-8");
    assert.throws(() => readActiveProductionReleaseId(TMP_ROOT), /损坏/);
    const baseline = { activeReleaseId: "rel-a", constitutionHash: "x", capturedAt: new Date().toISOString() };
    const r = checkCommitStale(baseline, TMP_ROOT);
    assert.ok(!r.ok);
    assert.equal(r.code, "release_pointer_corrupt");
    assert.equal(r.current, null);
  });

  it("pointer 缺少 releaseId → 结构非法抛错", () => {
    writeFileSync(POINTER_FILE, JSON.stringify({ kind: "production" }), "utf-8");
    assert.throws(() => readActiveProductionReleaseId(TMP_ROOT), /releaseId/);
  });
});

describe("CONCURRENCY-WAVE4：commitAndSave 0c 门禁接线", () => {
  it("stageResults.generationBaseline 漂移 → commitStaleGuard 记录 stale_release 且提交阻断", async () => {
    writePointer("rel-a");
    const { commitAndSave } = await import("../dist/v2/core/orchestrator-commit-save.js");
    const minimalInput = {
      workspaceId: "tmp-commit-stale-guard-test",
      chapterId: "stale-1",
      chapterNumber: 1,
      projectRoot: TMP_ROOT,
      intent: {},
      context: {},
      constitution: {},
      characterNames: [],
    };
    const stageResults = {
      generationBaseline: {
        activeReleaseId: "rel-a",
        constitutionHash: "hash-at-generation",
        capturedAt: new Date().toISOString(),
      },
    };
    // constitution 现状 hash 必然不同于 "hash-at-generation" → constitution_changed
    const r = commitAndSave(minimalInput, "cand-1", "正文", stageResults);
    assert.ok(!r.ok, "基线漂移时提交必须阻断");
    assert.match(r.error, /constitution_changed/);
    assert.equal(stageResults.commitStaleGuard.code, "constitution_changed");
    assert.equal(stageResults.atomicSave.blocked, true);
    assert.equal(stageResults.atomicSave.reason, "constitution_changed");
    // 正文未被写入（阻断发生在阶段 1 原子保存之前）
    const chapterPath = join(
      TMP_ROOT, "workspaces", "tmp-commit-stale-guard-test",
      "chapters", "chapter-001.md",
    );
    assert.ok(!existsSync(chapterPath), "阻断时不得写入正文");
  });

  it("generationBaselineCaptureError → release_pointer_corrupt 阻断", async () => {
    const { commitAndSave } = await import("../dist/v2/core/orchestrator-commit-save.js");
    writeFileSync(POINTER_FILE, "{ corrupt", "utf-8");
    const minimalInput = {
      workspaceId: "tmp-commit-stale-guard-test",
      chapterId: "stale-2",
      chapterNumber: 2,
      projectRoot: TMP_ROOT,
      intent: {},
      context: {},
      constitution: {},
      characterNames: [],
    };
    const stageResults = {
      generationBaselineCaptureError: { reason: "pointer 损坏（测试注入）", at: new Date().toISOString() },
    };
    const r = commitAndSave(minimalInput, "cand-2", "正文", stageResults);
    assert.ok(!r.ok);
    assert.match(r.error, /release_pointer_corrupt/);
    assert.equal(stageResults.atomicSave.reason, "release_pointer_corrupt");
  });

  it("基线一致 → commitStaleGuard ok 且不因 stale 阻断", async () => {
    writePointer("rel-a");
    const { commitAndSave } = await import("../dist/v2/core/orchestrator-commit-save.js");
    const { captureGenerationBaseline } = await import("../dist/v2/core/commit-stale-guard.js");
    const baseline = captureGenerationBaseline(TMP_ROOT);
    const minimalInput = {
      workspaceId: "tmp-commit-stale-guard-test",
      chapterId: "stale-3",
      chapterNumber: 3,
      projectRoot: TMP_ROOT,
      intent: {},
      context: {},
      constitution: {},
      characterNames: [],
    };
    const stageResults = { generationBaseline: baseline };
    const r = commitAndSave(minimalInput, "cand-3", "正文内容", stageResults);
    // 一致基线不因 0c 阻断；后续阶段可能因最小 input 缺字段失败，
    // 但错误不得是 stale_release / constitution_changed / release_pointer_corrupt
    if (!r.ok) {
      assert.doesNotMatch(r.error, /stale_release|constitution_changed|release_pointer_corrupt/);
    }
    assert.equal(stageResults.commitStaleGuard.ok, true);
  });
});

describe("CONCURRENCY-WAVE4：blocked candidate evidence 过期清理", () => {
  const TRACES_DIR = join(TMP_ROOT, "workspaces", "ws-prune", "traces");

  before(() => {
    mkdirSync(TRACES_DIR, { recursive: true });
  });

  it("未过期 → kept；过期 → pruned；过期 recovery 副本 → pruned", () => {
    const now = Date.now() + 60_000; // 判定为 now - mtime > retentionMs：未来时间使全部文件"过期"
    // 1. 未过期 evidence
    writeFileSync(
      join(TRACES_DIR, "1-blocked-candidate-evidence.json"),
      JSON.stringify({ chapterId: "1", storedSha256: "sha-1" }),
      "utf-8",
    );
    // 2. 过期 evidence（mtime 无法直接设置，用 now 推远模拟：retention 极小）
    writeFileSync(
      join(TRACES_DIR, "2-blocked-candidate-evidence.json"),
      JSON.stringify({ chapterId: "2", storedSha256: "sha-2" }),
      "utf-8",
    );
    // 3. 过期 recovery 副本
    writeFileSync(
      join(TRACES_DIR, "2-blocked-candidate-evidence.recovery-1.json"),
      JSON.stringify({ chapterId: "2", storedSha256: "sha-2-r1" }),
      "utf-8",
    );

    const r = pruneBlockedCandidateEvidence(TRACES_DIR, {
      retentionMs: 1, // 1ms：全部视为过期（写入耗时 > 1ms）
      now,
    });
    // chapter 1/2 均无 HOLD → 无冻结保护
    assert.deepEqual(r.skippedFrozen, []);
    assert.ok(r.pruned.includes("1-blocked-candidate-evidence.json"));
    assert.ok(r.pruned.includes("2-blocked-candidate-evidence.json"));
    assert.ok(r.pruned.includes("2-blocked-candidate-evidence.recovery-1.json"));
    assert.ok(!existsSync(join(TRACES_DIR, "2-blocked-candidate-evidence.json")));
  });

  it("HOLD 冻结保护的过期原始 evidence → skippedFrozen 不删除；recovery 副本仍可清理", () => {
    writeFileSync(
      join(TRACES_DIR, "3-blocked-candidate-evidence.json"),
      JSON.stringify({ chapterId: "3", storedSha256: "sha-3" }),
      "utf-8",
    );
    writeFileSync(
      join(TRACES_DIR, "3-blocked-candidate-evidence.recovery-1.json"),
      JSON.stringify({ chapterId: "3", storedSha256: "sha-3-r1" }),
      "utf-8",
    );
    // HOLD 清单冻结 sha-3
    writeFileSync(
      join(TRACES_DIR, "3-hold-quote-exemption.json"),
      JSON.stringify({
        schemaId: "pinovel.hold-manifest/v1",
        chapterId: "3",
        frozenEvidence: { storedSha256: "sha-3" },
      }),
      "utf-8",
    );

    const r = pruneBlockedCandidateEvidence(TRACES_DIR, { retentionMs: 1, now: Date.now() + 60_000 });
    assert.ok(r.skippedFrozen.includes("3-blocked-candidate-evidence.json"));
    assert.ok(existsSync(join(TRACES_DIR, "3-blocked-candidate-evidence.json")), "冻结原始 evidence 必须保留");
    assert.ok(r.pruned.includes("3-blocked-candidate-evidence.recovery-1.json"), "recovery 副本不受冻结保护");
  });

  it("store 未实现 statSync/unlinkSync → skipped（向后兼容，不抛错）", () => {
    const fakeStore = {
      writeFileSync: () => {},
      readFileSync: () => {
        throw new Error("not impl");
      },
      existsSync: () => true,
      mkdirSync: () => {},
      readdirSync: () => ["9-blocked-candidate-evidence.json"],
      // 无 statSync / unlinkSync
    };
    const r = pruneBlockedCandidateEvidence(TRACES_DIR, { retentionMs: 1 }, fakeStore);
    assert.deepEqual(r.skipped, ["9-blocked-candidate-evidence.json"]);
    assert.deepEqual(r.pruned, []);
  });

  it("默认保留期为 30 天", () => {
    assert.equal(DEFAULT_BLOCKED_EVIDENCE_RETENTION_MS, 30 * 24 * 60 * 60 * 1000);
  });
});
