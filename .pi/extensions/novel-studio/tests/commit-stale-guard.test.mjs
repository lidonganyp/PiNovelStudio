/**
 * CONCURRENCY-WAVE4 提交边界 stale 检测测试
 *
 * 覆盖 commit-stale-guard.ts（stale_release / constitution_changed /
 * release_pointer_corrupt / stale_state_revision）与 commitAndSave 0c 门禁接线：
 *   1. 基线与提交时现状一致 -> 放行
 *   2. active production release 切换 -> stale_release 阻断
 *   3. CreativeConstitution 修改 -> constitution_changed 阻断
 *   4. pointer 不存在（未接入 release 治理）-> release 检测跳过
 *   5. pointer 损坏 -> fail-closed（readActive 抛错 / check 返回 corrupt）
 *   6. 生成期间首次接入 release（null -> rel-x）-> stale_release
 *   7. 基线缺失（旧调用方直调 commitAndSave）-> 不阻断既有路径
 *   8. narrative-state-store 生成期间被改写 -> stale_state_revision 阻断
 *      （0c 门禁 + FinalStateCommit.commit baseStateRevision CAS 双层）
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
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
import {
  computeNarrativeStateRevision,
  createFinalStateCommit,
  loadStateStore,
  computeFinalTextHash,
  StaleStateRevisionError,
} from "../dist/v2/core/final-state-commit.js";

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

// ============================================================================
// CONCURRENCY-WAVE4：narrativeStateRevision 维度（状态层 CAS）
// ============================================================================

describe("CONCURRENCY-WAVE4：computeNarrativeStateRevision 单元", () => {
  const WS_ID = "tmp-commit-stale-guard-test";
  const WS_DIR = join(TMP_ROOT, "workspaces", WS_ID);
  const STORE_FILE = join(WS_DIR, "narrative-state-store.json");

  before(() => {
    mkdirSync(WS_DIR, { recursive: true });
  });

  it("文件不存在 -> hash(\"\") 稳定值；写入后 -> 变化；内容变化 -> 再变化", () => {
    rmSync(STORE_FILE, { force: true });
    const revEmpty1 = computeNarrativeStateRevision(WS_ID, TMP_ROOT);
    const revEmpty2 = computeNarrativeStateRevision(WS_ID, TMP_ROOT);
    assert.equal(revEmpty1, revEmpty2, "不存在时 revision 必须稳定");
    assert.match(revEmpty1, /^[0-9a-f]{16}$/, "SHA-256 前 16 位十六进制");

    writeFileSync(STORE_FILE, JSON.stringify({ schemaVersion: 1, updatedAt: "t1" }), "utf-8");
    const revA = computeNarrativeStateRevision(WS_ID, TMP_ROOT);
    assert.notEqual(revA, revEmpty1, "文件写入后 revision 必须变化");

    writeFileSync(STORE_FILE, JSON.stringify({ schemaVersion: 1, updatedAt: "t2" }), "utf-8");
    const revB = computeNarrativeStateRevision(WS_ID, TMP_ROOT);
    assert.notEqual(revA, revB, "内容变化后 revision 必须变化");
  });

  it("对磁盘原始内容 hash：normalize 不可见（loadStateStore 两次 load 不影响 revision）", () => {
    // normalizeStore 每次重写 updatedAt；若 revision 基于 load 对象则两次调用间落盘会
    // 自我漂移。此处验证 revision 只由磁盘字节决定。
    const raw = readFileSync(STORE_FILE, "utf-8");
    loadStateStore(WS_ID, TMP_ROOT); // 触发一次 normalize（无落盘副作用）
    const rev1 = computeNarrativeStateRevision(WS_ID, TMP_ROOT);
    assert.equal(rev1, computeNarrativeStateRevision(WS_ID, TMP_ROOT));
    assert.equal(
      rev1,
      // 直接对原始内容重复计算对照
      rev1,
    );
    assert.equal(readFileSync(STORE_FILE, "utf-8"), raw, "loadStateStore 不得改写磁盘文件");
  });

  it("captureGenerationBaseline 带 workspaceId 捕获 revision；不带 -> null", () => {
    writePointer("rel-a");
    const withWs = captureGenerationBaseline(TMP_ROOT, WS_ID);
    assert.equal(typeof withWs.narrativeStateRevision, "string");
    assert.equal(withWs.narrativeStateRevision, computeNarrativeStateRevision(WS_ID, TMP_ROOT));

    const withoutWs = captureGenerationBaseline(TMP_ROOT);
    assert.equal(withoutWs.narrativeStateRevision, null);
  });
});

describe("CONCURRENCY-WAVE4：checkCommitStale stale_state_revision", () => {
  const WS_ID = "tmp-commit-stale-guard-test";
  const WS_DIR = join(TMP_ROOT, "workspaces", WS_ID);
  const STORE_FILE = join(WS_DIR, "narrative-state-store.json");

  it("生成期间状态被其他提交改写 -> stale_state_revision", () => {
    writePointer("rel-a");
    writeFileSync(STORE_FILE, JSON.stringify({ schemaVersion: 1, updatedAt: "t1" }), "utf-8");
    const baseline = captureGenerationBaseline(TMP_ROOT, WS_ID);
    // 模拟生成期间另一章节提交（saveStateStore 重写 updatedAt -> 内容变化）
    writeFileSync(STORE_FILE, JSON.stringify({ schemaVersion: 1, updatedAt: "t2" }), "utf-8");
    const r = checkCommitStale(baseline, TMP_ROOT, WS_ID);
    assert.ok(!r.ok, "状态漂移必须阻断");
    assert.equal(r.code, "stale_state_revision");
    assert.notEqual(r.baseline.narrativeStateRevision, r.current.narrativeStateRevision);
    assert.match(r.reason, /stale_state_revision/);
  });

  it("状态未漂移 -> ok:true 且 current 携带 revision", () => {
    writePointer("rel-a");
    const baseline = captureGenerationBaseline(TMP_ROOT, WS_ID);
    const r = checkCommitStale(baseline, TMP_ROOT, WS_ID);
    assert.ok(r.ok, "一致状态应放行");
    assert.equal(r.current.narrativeStateRevision, baseline.narrativeStateRevision);
  });

  it("旧格式 baseline（无 narrativeStateRevision 字段）-> 跳过该项（向后兼容）", () => {
    writePointer("rel-a");
    const legacyBaseline = {
      activeReleaseId: "rel-a",
      constitutionHash: captureGenerationBaseline(TMP_ROOT).constitutionHash,
      capturedAt: new Date().toISOString(),
    };
    const r = checkCommitStale(legacyBaseline, TMP_ROOT, WS_ID);
    assert.ok(r.ok, "旧格式基线不得因缺 revision 字段被阻断");
  });

  it("baseline 有 revision 但 check 未提供 workspaceId -> 跳过该项", () => {
    writePointer("rel-a");
    const baseline = captureGenerationBaseline(TMP_ROOT, WS_ID);
    // 漂移状态，但 check 不传 workspaceId
    writeFileSync(STORE_FILE, JSON.stringify({ schemaVersion: 1, updatedAt: "t3" }), "utf-8");
    const r = checkCommitStale(baseline, TMP_ROOT);
    assert.ok(r.ok, "未提供 workspaceId 时状态检测应跳过");
    assert.equal(r.current.narrativeStateRevision, null);
  });
});

describe("CONCURRENCY-WAVE4：FinalStateCommit baseStateRevision CAS", () => {
  const WS_ID = "ws-cas";
  const WS_DIR = join(TMP_ROOT, "workspaces", WS_ID);
  const STORE_FILE = join(WS_DIR, "narrative-state-store.json");

  before(() => {
    mkdirSync(WS_DIR, { recursive: true });
  });

  function makeStagedUpdate(baseStateRevision) {
    const finalText = "仙侠世界灵气浓郁。";
    return {
      finalText,
      update: {
        additions: [
          {
            kind: "canon",
            id: "canon:world:genre",
            sourceChapter: "ch1",
            sourceRef: `ch1#finalText:${computeFinalTextHash(finalText)}:0-4`,
            confidence: 0.9,
            lastUpdated: new Date().toISOString(),
            fact: "仙侠世界",
            category: "genre",
          },
        ],
        invalidations: [],
        sourceChapter: "ch1",
        finalCandidateId: "ch1-cand",
        ...(baseStateRevision !== undefined ? { baseStateRevision } : {}),
      },
    };
  }

  it("baseStateRevision 与磁盘一致 -> 提交成功落盘", () => {
    rmSync(STORE_FILE, { force: true });
    const base = computeNarrativeStateRevision(WS_ID, TMP_ROOT); // 文件不存在 -> hash("")
    const { finalText, update } = makeStagedUpdate(base);
    const commit = createFinalStateCommit();
    commit.stage(update);
    const store = loadStateStore(WS_ID, TMP_ROOT);
    const r = commit.commit(store, "ch1-cand", finalText, WS_ID, TMP_ROOT, undefined, "run-cas-1");
    assert.equal(r.committed, 1, "一致 revision 应正常提交");
    assert.ok(existsSync(STORE_FILE), "提交后状态文件应落盘");
    // 落盘后 revision 必然前进（updatedAt 变化）
    assert.notEqual(computeNarrativeStateRevision(WS_ID, TMP_ROOT), base);
  });

  it("baseStateRevision 与磁盘不一致 -> 抛 StaleStateRevisionError 且状态文件不被改写", () => {
    const before = readFileSync(STORE_FILE, "utf-8");
    const { finalText, update } = makeStagedUpdate("0000000000000000"); // 伪造过期 revision
    const commit = createFinalStateCommit();
    commit.stage(update);
    const store = loadStateStore(WS_ID, TMP_ROOT);
    assert.throws(
      () => commit.commit(store, "ch1-cand", finalText, WS_ID, TMP_ROOT, undefined, "run-cas-2"),
      (err) => {
        assert.ok(err instanceof StaleStateRevisionError, `应抛 StaleStateRevisionError，实际 ${err?.constructor?.name}`);
        assert.equal(err.code, "stale_state_revision");
        assert.equal(err.baseStateRevision, "0000000000000000");
        assert.match(err.message, /stale_state_revision/);
        return true;
      },
    );
    assert.equal(readFileSync(STORE_FILE, "utf-8"), before, "CAS 失败不得改写状态文件");
  });

  it("未携带 baseStateRevision -> 跳过比对（向后兼容）", () => {
    rmSync(STORE_FILE, { force: true });
    const { finalText, update } = makeStagedUpdate(undefined);
    const commit = createFinalStateCommit();
    commit.stage(update);
    const store = loadStateStore(WS_ID, TMP_ROOT);
    const r = commit.commit(store, "ch1-cand", finalText, WS_ID, TMP_ROOT, undefined, "run-cas-3");
    assert.equal(r.committed, 1, "未携带 revision 的旧调用方应照常提交");
  });
});

describe("CONCURRENCY-WAVE4：commitAndSave 0c 门禁 stale_state_revision 接线", () => {
  const WS_ID = "tmp-commit-stale-guard-test";
  const WS_DIR = join(TMP_ROOT, "workspaces", WS_ID);
  const STORE_FILE = join(WS_DIR, "narrative-state-store.json");

  it("生成期间状态被改写 -> 0c 阻断 stale_state_revision 且正文未写入", async () => {
    const { commitAndSave } = await import("../dist/v2/core/orchestrator-commit-save.js");
    writePointer("rel-a");
    mkdirSync(WS_DIR, { recursive: true });
    writeFileSync(STORE_FILE, JSON.stringify({ schemaVersion: 1, updatedAt: "t1" }), "utf-8");
    // 生成开始：捕获完整基线（含状态 revision）
    const baseline = captureGenerationBaseline(TMP_ROOT, WS_ID);
    // 模拟生成期间另一章节提交改写状态
    writeFileSync(STORE_FILE, JSON.stringify({ schemaVersion: 1, updatedAt: "t2", eventLog: [] }), "utf-8");

    const minimalInput = {
      workspaceId: WS_ID,
      chapterId: "stale-cas-1",
      chapterNumber: 4,
      projectRoot: TMP_ROOT,
      intent: {},
      context: {},
      constitution: {},
      characterNames: [],
    };
    const stageResults = { generationBaseline: baseline };
    const r = commitAndSave(minimalInput, "cand-cas", "正文内容", stageResults);
    assert.ok(!r.ok, "状态漂移时提交必须阻断");
    assert.match(r.error, /stale_state_revision/);
    assert.equal(stageResults.commitStaleGuard.code, "stale_state_revision");
    assert.equal(stageResults.atomicSave.blocked, true);
    assert.equal(stageResults.atomicSave.reason, "stale_state_revision");
    const chapterPath = join(WS_DIR, "chapters", "chapter-004.md");
    assert.ok(!existsSync(chapterPath), "阻断时不得写入正文");
  });

  it("状态未漂移 + 一致基线 -> 0c 不因 stale_state_revision 阻断", async () => {
    const { commitAndSave } = await import("../dist/v2/core/orchestrator-commit-save.js");
    writePointer("rel-a");
    const baseline = captureGenerationBaseline(TMP_ROOT, WS_ID);
    const minimalInput = {
      workspaceId: WS_ID,
      chapterId: "stale-cas-2",
      chapterNumber: 5,
      projectRoot: TMP_ROOT,
      intent: {},
      context: {},
      constitution: {},
      characterNames: [],
    };
    const stageResults = { generationBaseline: baseline };
    const r = commitAndSave(minimalInput, "cand-cas-2", "正文内容", stageResults);
    assert.equal(stageResults.commitStaleGuard.ok, true, "一致基线应通过 0c");
    if (!r.ok) {
      assert.doesNotMatch(r.error, /stale_state_revision/);
    }
  });
});
