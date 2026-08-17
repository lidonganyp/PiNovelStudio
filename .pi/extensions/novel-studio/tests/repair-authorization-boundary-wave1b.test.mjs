/**
 * GREEN 测试：候选不可变存储边界（REASONING-REPAIR-BOUNDARY-1 Wave 1B / RRB-2.1 + RRB-2.2）
 *
 * 锁定 Wave 1B 的期望行为：
 *
 *   RRB-2.1 — hashText / buildCandidateId / createCandidateRevisionManifest /
 *              validateCandidateRevisionManifest 产出合法、可校验的 manifest；
 *              candidateId 必须绑定运行身份 + 内容 hash。
 *   RRB-2.2 — CandidateWorkspace 迁移为 createCandidate + advanceCurrentCandidate：
 *              writeDraft 每次正文变化产生不可变候选（首版可回放），
 *              current pointer 原子推进，且 create 与 advance 分离。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  hashText,
  buildCandidateId,
  createCandidateRevisionManifest,
  validateCandidateRevisionManifest,
} from "../dist/v2/core/candidate-revision-store.js";
import { createCandidateWorkspace } from "../dist/novelos/agent/candidate-workspace.js";

// ============================================================================
// RRB-2.1 — 纯函数：hash / candidateId / manifest / schema 校验
// ============================================================================

test("RRB-2.1: hashText/buildCandidateId/manifest/validate 产出合法 manifest", () => {
  const text = "第一版正文。";
  const textHash = hashText(text);
  assert.equal(textHash.length, 64, "sha256 完整 hex 应为 64 位");

  const candidateId = buildCandidateId({
    runId: "s1",
    derivationType: "agentic_generation",
    textHash,
    sequence: 0,
  });
  assert.ok(candidateId.includes("s1"), "candidateId 含运行身份");
  assert.ok(candidateId.includes("agentic_generation"), "candidateId 含 derivationType");
  assert.ok(candidateId.includes(textHash.slice(0, 16)), "candidateId 含内容 hash 片段");

  const manifest = createCandidateRevisionManifest({
    candidateId,
    chapterId: "ch1",
    parentCandidateId: null,
    sourceCandidateId: null,
    derivationType: "agentic_generation",
    textArtifactRef: `candidates/${candidateId}.md`,
    textHash,
    createdAt: "2026-08-16T00:00:00.000Z",
  });

  const result = validateCandidateRevisionManifest(manifest);
  assert.equal(result.ok, true, `manifest 校验应通过：${result.errors.join("; ")}`);
  assert.equal(manifest.textHash, textHash);
  assert.equal(manifest.parentCandidateId, null);
});

test("RRB-2.1: validateCandidateRevisionManifest 拒绝 candidateId 不含内容 hash 的 manifest", () => {
  const manifest = createCandidateRevisionManifest({
    candidateId: "fixed-chapter-id",
    chapterId: "ch1",
    parentCandidateId: null,
    sourceCandidateId: null,
    derivationType: "agentic_generation",
    textArtifactRef: "candidates/fixed-chapter-id.md",
    textHash: hashText("abc"),
    createdAt: "2026-08-16T00:00:00.000Z",
  });
  const result = validateCandidateRevisionManifest(manifest);
  assert.equal(result.ok, false, "不含内容 hash 的 candidateId 应校验失败");
  assert.ok(
    result.errors.some((e) => e.includes("hash")),
    `应报 candidateId 缺 hash 片段：${result.errors.join("; ")}`,
  );
});

// ============================================================================
// RRB-2.2 — CandidateWorkspace 不可变候选 + current pointer 分离
// ============================================================================

test("RRB-2.2: 连续 writeDraft 产生两个不可变候选，首版可回放", () => {
  const root = mkdtempSync(join(tmpdir(), "rrb-wave1b-"));
  try {
    const ws = createCandidateWorkspace({ workspaceRoot: root, sessionId: "s1" });
    ws.writeDraft("first-draft-甲");
    ws.writeDraft("second-draft-乙");

    const candidatesDir = join(ws.getDir(), "candidates");
    const mdFiles = readdirSync(candidatesDir).filter((f) => f.endsWith(".md"));
    assert.equal(mdFiles.length, 2, "应有两个不可变候选正文");
    const texts = mdFiles.map((f) => readFileSync(join(candidatesDir, f), "utf-8"));
    assert.ok(texts.some((t) => t.includes("first-draft-甲")), "首版正文可回放");
    assert.ok(texts.some((t) => t.includes("second-draft-乙")), "次版正文存在");

    // current pointer 指向最新候选
    assert.equal(ws.readDraft(), "second-draft-乙", "readDraft 返回最新正文");
    const currentId = ws.getCurrentCandidateId();
    assert.ok(currentId, "current pointer 存在");
    assert.equal(ws.readCandidateText(currentId), "second-draft-乙");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("RRB-2.2: createCandidate 不推进 pointer，advanceCurrentCandidate 才推进", () => {
  const root = mkdtempSync(join(tmpdir(), "rrb-wave1b-sep-"));
  try {
    const ws = createCandidateWorkspace({ workspaceRoot: root, sessionId: "s2" });
    const m1 = ws.createCandidate({ text: "candidate-1", chapterId: "ch1" });
    assert.equal(ws.getCurrentCandidateId(), null, "createCandidate 不推进 pointer");
    assert.equal(ws.readDraft(), null, "未推进 pointer 时 readDraft 无内容");

    ws.advanceCurrentCandidate(m1);
    assert.equal(ws.getCurrentCandidateId(), m1.candidateId);
    assert.equal(ws.readDraft(), "candidate-1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("RRB-2.2: 相同正文两次 createCandidate 产生不同 candidateId（sequence 消歧，不覆盖）", () => {
  const root = mkdtempSync(join(tmpdir(), "rrb-wave1b-seq-"));
  try {
    const ws = createCandidateWorkspace({ workspaceRoot: root, sessionId: "s3" });
    const a = ws.createCandidate({ text: "same-text" });
    const b = ws.createCandidate({ text: "same-text" });
    assert.notEqual(a.candidateId, b.candidateId, "相同正文应得到不同 candidateId");
    assert.equal(a.textHash, b.textHash, "相同正文 hash 一致");

    const candidatesDir = join(ws.getDir(), "candidates");
    const mdFiles = readdirSync(candidatesDir).filter((f) => f.endsWith(".md"));
    assert.equal(mdFiles.length, 2, "两个候选互不覆盖");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
