/**
 * Phase 3 P1-1 生产探针：FinalStateCommit 强制最终正文 provenance
 *
 * 验证 commit() 唯一落盘入口的 fail-closed 行为：
 * - seed:* sourceRef 必须被拒绝（防止绕过 reanchor 写入权威状态）
 * - ch{N}#finalText:{hash}:{start}-{end} sourceRef 应通过
 * - ch{N}#finalText:{hash} sourceRef（pattern kind，无 span）应通过
 * - ch{N}#finalText:{hash}:not-found sourceRef 应被拒绝
 * - ch{N}#finalText:{hash}:semantic-conflict sourceRef 应被拒绝
 *
 * 用户反馈（P1-1）：
 * "直接 stage sourceRef=seed:* 可以绕过重锚定并写入 canon，
 *  因为无 span 格式被直接放行。正常编排当前会先重锚定，
 *  但唯一落盘入口没有 fail-closed。"
 *
 * 不调用真实模型，纯规则测试。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createFinalStateCommit,
  computeFinalTextHash,
  loadStateStore,
} from "../dist/v2/core/final-state-commit.js";

// ============================================================================
// 辅助函数
// ============================================================================

function makeTempProject() {
  const dir = mkdtempSync(join(tmpdir(), "p1-1-provenance-"));
  const workspaceId = "ws-p1-1-test";
  return { dir, workspaceId };
}

function makeCanonEntry(id, fact, sourceRef) {
  return {
    id,
    kind: "canon",
    fact,
    category: "entity",
    sourceChapter: "ch5",
    sourceRef,
    confidence: 0.7,
    lastUpdated: new Date().toISOString(),
  };
}

function makeCharacterEntry(characterId, field, value, sourceRef) {
  return {
    id: `character:${characterId}:${field}`,
    kind: "character",
    characterId,
    field,
    value,
    sourceChapter: "ch5",
    sourceRef,
    confidence: 0.7,
    lastUpdated: new Date().toISOString(),
  };
}

function makePatternEntry(sourceRef) {
  return {
    id: "pattern:sentence_risk:0:ch5",
    kind: "pattern",
    patternType: "sentence_risk",
    description: "AI 腔句式",
    occurrenceCount: 1,
    sourceChapter: "ch5",
    sourceRef,
    confidence: 0.7,
    lastUpdated: new Date().toISOString(),
  };
}

// ============================================================================
// P1-1: seed:* sourceRef 必须被拒绝
// ============================================================================

describe("P1-1: FinalStateCommit 强制最终正文 provenance", () => {
  it("P1-1: seed:* sourceRef → canon entry 应被拒绝（fail-closed）", () => {
    const { dir, workspaceId } = makeTempProject();
    try {
      const finalText = "叶尘推开石门，走入密室。";
      const store = loadStateStore(workspaceId, dir);

      const commit = createFinalStateCommit();
      // 直接 stage seed:* sourceRef，不经过 reanchor
      commit.stage({
        additions: [
          makeCanonEntry("canon:fact:0:ch5", "叶尘推开石门", "seed:ch5:canon:0"),
        ],
        invalidations: [],
        sourceChapter: "ch5",
        finalCandidateId: "amp-1",
      });

      const result = commit.commit(store, "amp-1", finalText, workspaceId, dir);

      // 应被拒绝
      assert.equal(result.committed, 0, `seed:* sourceRef 应被拒绝，实际 committed=${result.committed}`);
      assert.equal(result.rejected.length, 1, `应有 1 条 rejected entry`);
      assert.ok(
        result.rejected[0].errors.some((e) => e.includes("#finalText:")),
        `rejected 原因应提及 #finalText:，实际 errors: ${JSON.stringify(result.rejected[0].errors)}`,
      );

      // 验证落盘的 store 不含该 entry
      const loaded = loadStateStore(workspaceId, dir);
      assert.equal(loaded.canon.length, 0, "落盘 store 不应含 seed:* 的 canon entry");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("P1-1: seed:* sourceRef → character entry 应被拒绝", () => {
    const { dir, workspaceId } = makeTempProject();
    try {
      const finalText = "林默踏入筑基期。";
      const store = loadStateStore(workspaceId, dir);

      const commit = createFinalStateCommit();
      commit.stage({
        additions: [
          makeCharacterEntry("林默", "realm", "筑基期", "seed:ch5:character:林默"),
        ],
        invalidations: [],
        sourceChapter: "ch5",
        finalCandidateId: "amp-1",
      });

      const result = commit.commit(store, "amp-1", finalText, workspaceId, dir);

      assert.equal(result.committed, 0, `seed:* sourceRef 应被拒绝`);
      assert.equal(result.rejected.length, 1, `应有 1 条 rejected entry`);
      assert.ok(
        result.rejected[0].errors.some((e) => e.includes("#finalText:")),
        `rejected 原因应提及 #finalText:`,
      );

      const loaded = loadStateStore(workspaceId, dir);
      assert.equal(loaded.character.length, 0, "落盘 store 不应含 seed:* 的 character entry");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("P1-1: 正确重锚定的 sourceRef (ch{N}#finalText:{hash}:{span}) 应通过", () => {
    const { dir, workspaceId } = makeTempProject();
    try {
      const finalText = "叶尘推开石门，走入密室。";
      const hash = computeFinalTextHash(finalText);
      const store = loadStateStore(workspaceId, dir);

      const commit = createFinalStateCommit();
      commit.stage({
        additions: [
          makeCanonEntry(
            "canon:fact:0:ch5",
            "叶尘推开石门",
            `ch5#finalText:${hash}:0-4`,
          ),
        ],
        invalidations: [],
        sourceChapter: "ch5",
        finalCandidateId: "amp-1",
      });

      const result = commit.commit(store, "amp-1", finalText, workspaceId, dir);

      assert.equal(result.committed, 1, `正确重锚定的 sourceRef 应通过，实际 committed=${result.committed}`);
      assert.equal(result.rejected.length, 0, `不应有 rejected entry`);

      const loaded = loadStateStore(workspaceId, dir);
      assert.equal(loaded.canon.length, 1, "落盘 store 应含 1 条 canon entry");
      assert.ok(
        loaded.canon[0].sourceRef.includes("#finalText:"),
        `落盘 sourceRef 应含 #finalText:`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("P1-1: pattern kind 的 ch{N}#finalText:{hash}（无 span）应通过", () => {
    const { dir, workspaceId } = makeTempProject();
    try {
      const finalText = "天空湛蓝如洗。";
      const hash = computeFinalTextHash(finalText);
      const store = loadStateStore(workspaceId, dir);

      const commit = createFinalStateCommit();
      commit.stage({
        additions: [
          makePatternEntry(`ch5#finalText:${hash}`),
        ],
        invalidations: [],
        sourceChapter: "ch5",
        finalCandidateId: "amp-1",
      });

      const result = commit.commit(store, "amp-1", finalText, workspaceId, dir);

      // pattern kind 无 span 但有 #finalText: → 应通过
      assert.equal(result.committed, 1, `pattern kind 的 #finalText: sourceRef 应通过`);
      assert.equal(result.rejected.length, 0, `不应有 rejected entry`);

      const loaded = loadStateStore(workspaceId, dir);
      assert.equal(loaded.pattern.length, 1, "落盘 store 应含 1 条 pattern entry");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("P1-1: not-found sourceRef 应被拒绝（已有行为回归保护）", () => {
    const { dir, workspaceId } = makeTempProject();
    try {
      const finalText = "无关文本。";
      const hash = computeFinalTextHash(finalText);
      const store = loadStateStore(workspaceId, dir);

      const commit = createFinalStateCommit();
      commit.stage({
        additions: [
          makeCanonEntry(
            "canon:fact:0:ch5",
            "某事实",
            `ch5#finalText:${hash}:not-found`,
          ),
        ],
        invalidations: [],
        sourceChapter: "ch5",
        finalCandidateId: "amp-1",
      });

      const result = commit.commit(store, "amp-1", finalText, workspaceId, dir);

      assert.equal(result.committed, 0, `not-found sourceRef 应被拒绝`);
      assert.equal(result.rejected.length, 1, `应有 1 条 rejected entry`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("P1-1: semantic-conflict sourceRef 应被拒绝（已有行为回归保护）", () => {
    const { dir, workspaceId } = makeTempProject();
    try {
      const finalText = "叶尘不在场。";
      const hash = computeFinalTextHash(finalText);
      const store = loadStateStore(workspaceId, dir);

      const commit = createFinalStateCommit();
      commit.stage({
        additions: [
          makeCharacterEntry(
            "叶尘",
            "participation",
            "present",
            `ch5#finalText:${hash}:semantic-conflict`,
          ),
        ],
        invalidations: [],
        sourceChapter: "ch5",
        finalCandidateId: "amp-1",
      });

      const result = commit.commit(store, "amp-1", finalText, workspaceId, dir);

      assert.equal(result.committed, 0, `semantic-conflict sourceRef 应被拒绝`);
      assert.equal(result.rejected.length, 1, `应有 1 条 rejected entry`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("P1-1: 混合场景 — seed:* 被拒绝，#finalText: 通过，同一 commit 不互相干扰", () => {
    const { dir, workspaceId } = makeTempProject();
    try {
      const finalText = "叶尘推开石门，走入密室。";
      const hash = computeFinalTextHash(finalText);
      const store = loadStateStore(workspaceId, dir);

      const commit = createFinalStateCommit();
      commit.stage({
        additions: [
          // 正确重锚定 → 应通过
          makeCanonEntry(
            "canon:fact:0:ch5",
            "叶尘推开石门",
            `ch5#finalText:${hash}:0-4`,
          ),
          // 未重锚定 → 应被拒绝
          makeCharacterEntry(
            "叶尘",
            "location",
            "密室",
            "seed:ch5:character:叶尘:location",
          ),
        ],
        invalidations: [],
        sourceChapter: "ch5",
        finalCandidateId: "amp-1",
      });

      const result = commit.commit(store, "amp-1", finalText, workspaceId, dir);

      // 1 通过，1 拒绝
      assert.equal(result.committed, 1, `应有 1 条通过（#finalText:）`);
      assert.equal(result.rejected.length, 1, `应有 1 条拒绝（seed:*）`);
      assert.ok(
        result.rejected[0].entry.id.includes("character"),
        `rejected entry 应为 character（seed:*）`,
      );

      const loaded = loadStateStore(workspaceId, dir);
      assert.equal(loaded.canon.length, 1, "canon 应有 1 条（通过的）");
      assert.equal(loaded.character.length, 0, "character 应为 0（被拒绝的）");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
