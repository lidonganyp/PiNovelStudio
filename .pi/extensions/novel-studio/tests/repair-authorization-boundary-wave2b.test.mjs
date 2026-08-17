/**
 * GREEN 测试：不可变候选派生与血缘（REASONING-REPAIR-BOUNDARY-1 Wave 2B / RRB-2.3~2.5）
 *
 * 锁定 Wave 2B 的期望行为：
 *
 *   RRB-2.3 — deriveChildCandidate 从父候选派生子候选，产生 diff artifact + hash，
 *            关联 parentCandidateId；原父候选正文与 manifest 永不变化。
 *   RRB-2.4 — new_candidate 创建新的完整正文候选并关联失败父候选；
 *            不得调用 full rewrite merger 覆盖父候选。
 *   RRB-2.5 — author_style_transform 标记为独立转换类型，与 repair 类型分离。
 *
 * 对照计划 §7 最小验收矩阵：
 *   T16  patch 通过全部门禁 → 生成新 candidateId、parentCandidateId、textHash、diffHash
 *   T17  后续再 patch → 所有祖先 artifact/hash 不变，可完整回溯
 *   T18  作者风格整章优化 → 标记独立 transform，不消耗 repair authorization
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { computeLineDiff, hashDiff, serializeDiff, deserializeDiff } from "../dist/v2/core/diff-utils.js";
import { createCandidateWorkspace } from "../dist/novelos/agent/candidate-workspace.js";

// ============================================================================
// diff-utils 纯函数测试
// ============================================================================

test("computeLineDiff: 相同文本 → 全是 same 行", () => {
  const text = "第一行\n第二行\n第三行";
  const diff = computeLineDiff(text, text);
  assert.equal(diff.lines.length, 3);
  assert.ok(diff.lines.every((l) => l.type === "same"));
  assert.equal(diff.stats.added, 0);
  assert.equal(diff.stats.removed, 0);
  assert.equal(diff.stats.unchanged, 3);
});

test("computeLineDiff: 替换一行 → 一删一加", () => {
  const parent = "第一行\n第二行\n第三行";
  const child = "第一行\n修改行\n第三行";
  const diff = computeLineDiff(parent, child);
  assert.equal(diff.stats.added, 1);
  assert.equal(diff.stats.removed, 1);
  assert.ok(diff.lines.some((l) => l.type === "remove" && l.text === "第二行"));
  assert.ok(diff.lines.some((l) => l.type === "add" && l.text === "修改行"));
});

test("computeLineDiff: 添加行 → 只有 add", () => {
  const parent = "第一行\n第二行";
  const child = "第一行\n第二行\n第三行";
  const diff = computeLineDiff(parent, child);
  assert.equal(diff.stats.added, 1);
  assert.equal(diff.stats.removed, 0);
  assert.ok(diff.lines.some((l) => l.type === "add" && l.text === "第三行"));
});

test("hashDiff: 相同 diff 产生相同 hash", () => {
  const diff1 = computeLineDiff("a\nb", "a\nc");
  const diff2 = computeLineDiff("a\nb", "a\nc");
  assert.equal(hashDiff(diff1), hashDiff(diff2));
});

test("hashDiff: 不同 diff 产生不同 hash", () => {
  const diff1 = computeLineDiff("a\nb", "a\nc");
  const diff2 = computeLineDiff("a\nb", "a\nd");
  assert.notEqual(hashDiff(diff1), hashDiff(diff2));
});

test("serializeDiff/deserializeDiff: 往返一致", () => {
  const diff = computeLineDiff("a\nb\nc", "a\nx\nc");
  const serialized = serializeDiff(diff);
  const parsed = deserializeDiff(serialized);
  assert.equal(parsed.length, diff.lines.length);
  for (let i = 0; i < parsed.length; i++) {
    assert.equal(parsed[i].type, diff.lines[i].type);
    assert.equal(parsed[i].text, diff.lines[i].text);
  }
});

// ============================================================================
// RRB-2.3：deriveChildCandidate 派生候选
// ============================================================================

test("RRB-2.3: deriveChildCandidate span_patch → 产生子候选 + parent 链接", () => {
  const root = mkdtempSync(join(tmpdir(), "rrb-wave2b-"));
  try {
    const ws = createCandidateWorkspace({ workspaceRoot: root, sessionId: "s1" });

    // 1. 创建父候选
    const parentText = "第一行\n第二行\n第三行";
    const parent = ws.createCandidate({ text: parentText, chapterId: "ch1" });
    ws.advanceCurrentCandidate(parent);

    // 2. 派生子候选（span_patch）
    const childText = "第一行\n修改行\n第三行";
    const child = ws.deriveChildCandidate({
      parentManifest: parent,
      childText,
      derivationType: "span_patch",
      authorizationId: "auth-001",
    });

    // 验证 child manifest
    assert.ok(child.candidateId !== parent.candidateId, "子候选应有不同 candidateId");
    assert.equal(child.parentCandidateId, parent.candidateId, "应关联 parentCandidateId");
    assert.equal(child.derivationType, "span_patch");
    assert.equal(child.authorizationId, "auth-001");
    assert.ok(child.textHash, "应有 textHash");
    assert.ok(child.diffArtifactRef, "应有 diff artifact 引用");
    assert.ok(child.diffHash, "应有 diff hash");
    assert.equal(child.parentTextHash, parent.textHash, "parentTextHash 应等于父候选 textHash");

    // 验证父候选未变
    const parentReread = ws.readCandidateManifest(parent.candidateId);
    assert.ok(parentReread, "父候选 manifest 仍存在");
    assert.equal(parentReread.textHash, parent.textHash, "父候选 textHash 不变");
    const parentTextReread = ws.readCandidateText(parent.candidateId);
    assert.equal(parentTextReread, parentText, "父候选正文不变");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("RRB-2.3: 连续两次 patch → 三代谱系可回溯", () => {
  const root = mkdtempSync(join(tmpdir(), "rrb-wave2b-gen3-"));
  try {
    const ws = createCandidateWorkspace({ workspaceRoot: root, sessionId: "s2" });

    // Gen 1: 原始 draft
    const gen1 = ws.createCandidate({ text: "第一版正文", chapterId: "ch1" });
    ws.advanceCurrentCandidate(gen1);

    // Gen 2: 第一次 patch
    const gen2 = ws.deriveChildCandidate({
      parentManifest: gen1,
      childText: "第二版正文（修复）",
      derivationType: "span_patch",
    });
    ws.advanceCurrentCandidate(gen2);

    // Gen 3: 第二次 patch
    const gen3 = ws.deriveChildCandidate({
      parentManifest: gen2,
      childText: "第三版正文（再次修复）",
      derivationType: "span_patch",
    });
    ws.advanceCurrentCandidate(gen3);

    // 验证谱系
    assert.equal(gen2.parentCandidateId, gen1.candidateId);
    assert.equal(gen3.parentCandidateId, gen2.candidateId);

    // 验证所有祖先正文不变
    assert.equal(ws.readCandidateText(gen1.candidateId), "第一版正文");
    assert.equal(ws.readCandidateText(gen2.candidateId), "第二版正文（修复）");
    assert.equal(ws.readCandidateText(gen3.candidateId), "第三版正文（再次修复）");

    // 验证祖先 manifest 不变
    const gen1Reread = ws.readCandidateManifest(gen1.candidateId);
    assert.equal(gen1Reread.textHash, gen1.textHash);
    const gen2Reread = ws.readCandidateManifest(gen2.candidateId);
    assert.equal(gen2Reread.textHash, gen2.textHash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// RRB-2.4：new_candidate 派生
// ============================================================================

test("RRB-2.4: new_candidate 派生 → derivationType=new_candidate + 关联父候选", () => {
  const root = mkdtempSync(join(tmpdir(), "rrb-wave2b-newc-"));
  try {
    const ws = createCandidateWorkspace({ workspaceRoot: root, sessionId: "s3" });

    const parent = ws.createCandidate({ text: "失败父候选正文", chapterId: "ch1" });
    ws.advanceCurrentCandidate(parent);

    const child = ws.deriveChildCandidate({
      parentManifest: parent,
      childText: "全新候选正文",
      derivationType: "new_candidate",
    });

    assert.equal(child.derivationType, "new_candidate");
    assert.equal(child.parentCandidateId, parent.candidateId);
    // new_candidate 的 diff 来自父候选对比
    assert.ok(child.diffHash, "new_candidate 也应有 diff（对比父候选）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// RRB-2.5：author_style_transform
// ============================================================================

test("RRB-2.5: author_style_transform → 独立 transform 类型", () => {
  const root = mkdtempSync(join(tmpdir(), "rrb-wave2b-style-"));
  try {
    const ws = createCandidateWorkspace({ workspaceRoot: root, sessionId: "s4" });

    const parent = ws.createCandidate({ text: "Agentic 原始草稿", chapterId: "ch1" });
    ws.advanceCurrentCandidate(parent);

    const child = ws.deriveChildCandidate({
      parentManifest: parent,
      childText: "作者风格优化后的正文",
      derivationType: "author_style_transform",
    });

    assert.equal(child.derivationType, "author_style_transform");
    assert.equal(child.parentCandidateId, parent.candidateId);
    // author_style_transform 不应有 authorizationId（与 repair 分离）
    assert.equal(child.authorizationId, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// RRB-2.3：派生候选不覆盖父候选
// ============================================================================

test("RRB-2.3: 派生候选后父候选候选数不变（append-only）", () => {
  const root = mkdtempSync(join(tmpdir(), "rrb-wave2b-append-"));
  try {
    const ws = createCandidateWorkspace({ workspaceRoot: root, sessionId: "s5" });

    const parent = ws.createCandidate({ text: "父候选" });
    ws.advanceCurrentCandidate(parent);

    const parentHashBefore = parent.textHash;
    const parentTextBefore = ws.readCandidateText(parent.candidateId);

    // 派生
    ws.deriveChildCandidate({
      parentManifest: parent,
      childText: "子候选正文",
      derivationType: "span_patch",
    });

    // 父候选不变
    const parentReread = ws.readCandidateManifest(parent.candidateId);
    assert.equal(parentReread.textHash, parentHashBefore, "父候选 hash 不变");
    assert.equal(ws.readCandidateText(parent.candidateId), parentTextBefore, "父候选正文不变");

    // candidates/ 目录有 2 个 md 文件（父 + 子）
    const mdFiles = readdirSync(ws.getCandidatesDir())
      .filter((f) => f.endsWith(".md"));
    assert.equal(mdFiles.length, 2, "应有 2 个不可变候选正文");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// 边界：无父候选的派生
// ============================================================================

test("RRB-2.3: parentManifest=null → 无 parent 链接的新候选", () => {
  const root = mkdtempSync(join(tmpdir(), "rrb-wave2b-orphan-"));
  try {
    const ws = createCandidateWorkspace({ workspaceRoot: root, sessionId: "s6" });

    const child = ws.deriveChildCandidate({
      parentManifest: null,
      childText: "独立新候选正文",
      derivationType: "agentic_generation",
    });

    assert.equal(child.parentCandidateId, null);
    assert.equal(child.parentTextHash, null);
    assert.equal(child.diffArtifactRef, null);
    assert.equal(child.diffHash, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});