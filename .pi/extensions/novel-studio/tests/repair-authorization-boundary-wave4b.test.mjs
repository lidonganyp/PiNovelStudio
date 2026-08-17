/**
 * GREEN 测试：主链路提交门禁（REASONING-REPAIR-BOUNDARY-1 Wave 4B / RRB-5.1~5.3）
 *
 * 锁定 Wave 4B 的期望行为：
 * - RRB-5.1：`runUnifiedPipeline` 只接受"已清零且 lineage/hash 完整"的 Agentic
 *   current candidate；候选正文与 candidateId 的 hash 绑定失败即 fail-closed 拒绝。
 * - RRB-5.3：候选 hash 不一致时，章节文件 / 长期状态 / commit receipt 均不得产生
 *   （本文件用确定性纯函数锁定 id↔text 绑定这一最小不变量；提交事务的零产物保证
 *   由 commitAndSave 的 artifact_hash_mismatch 门禁在 orchestrator-commit-save-p1
 *   与 commit-authorization-boundary 中锁定）。
 *
 * 对照计划 §7 最小验收矩阵：
 *   T24  verifier 未清零 → 正文文件、状态、commit receipt 均不产生
 *   T16  patch 通过全部门禁 → 生成新 candidateId、parentCandidateId、textHash、diffHash
 * 对照计划 §8 门槛：
 *   未清零候选提交 = 0；无 snapshot/hash 的自动修订 = 0
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  hashText,
  buildCandidateId,
  checkCandidateTextHashBinding,
  validateCandidateRevisionManifest,
} from "../dist/v2/core/candidate-revision-store.js";

const TEXT = "初始草稿。人物走进现场，开始调查。";

// ============================================================================
// RRB-5.1：candidateId ↔ text hash 绑定（纯函数）
// ============================================================================

test("RRB-5.1: 合法候选（buildCandidateId 构造）通过 hash 绑定校验", () => {
  const textHash = hashText(TEXT);
  const candidateId = buildCandidateId({
    runId: "session-1",
    derivationType: "agentic_generation",
    textHash,
    sequence: 0,
  });
  const result = checkCandidateTextHashBinding({ id: candidateId, text: TEXT });
  assert.equal(result.ok, true);
});

test("RRB-5.1: candidateId 不含正文 hash 前缀 → candidate_text_hash_mismatch", () => {
  const result = checkCandidateTextHashBinding({
    id: "session-1-agentic_generation-deadbeefdeadbeef-0",
    text: TEXT,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "candidate_text_hash_mismatch");
});

test("RRB-5.1: 正文为空 → candidate_text_empty", () => {
  const textHash = hashText("");
  const candidateId = buildCandidateId({
    runId: "s",
    derivationType: "agentic_generation",
    textHash,
    sequence: 0,
  });
  const result = checkCandidateTextHashBinding({ id: candidateId, text: "" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "candidate_text_empty");
});

test("RRB-5.1: candidateId 缺失 → candidate_id_missing", () => {
  const result = checkCandidateTextHashBinding({ id: "", text: TEXT });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "candidate_id_missing");
});

test("RRB-5.1: 正文被篡改后原 candidateId 失效（零修改承诺的确定性前提）", () => {
  // 构造合法候选，然后篡改正文 → 绑定必然失败，编排器据此拒绝交付/保存。
  const candidateId = buildCandidateId({
    runId: "session-1",
    derivationType: "agentic_generation",
    textHash: hashText(TEXT),
    sequence: 0,
  });
  const tampered = checkCandidateTextHashBinding({ id: candidateId, text: TEXT + "【篡改】" });
  assert.equal(tampered.ok, false);
  assert.equal(tampered.reason, "candidate_text_hash_mismatch");
});

// ============================================================================
// RRB-5.3：manifest 级 hash 绑定与候选绑定口径一致
// ============================================================================

test("RRB-5.3: manifest.candidateId 不含 textHash 前缀被 validate 拒绝（与候选绑定同口径）", () => {
  const result = validateCandidateRevisionManifest({
    candidateId: "session-1-agentic_generation-deadbeefdeadbeef-0",
    chapterId: "1",
    parentCandidateId: null,
    sourceCandidateId: null,
    derivationType: "agentic_generation",
    textArtifactRef: "candidates/x.md",
    textHash: hashText(TEXT),
    createdAt: "2026-08-16T00:00:00.000Z",
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("内容 hash")));
});

test("RRB-5.3: 合法 manifest（含 hash 绑定）通过 validate，与候选绑定一致", () => {
  const textHash = hashText(TEXT);
  const candidateId = buildCandidateId({
    runId: "session-1",
    derivationType: "agentic_generation",
    textHash,
    sequence: 0,
  });
  const result = validateCandidateRevisionManifest({
    candidateId,
    chapterId: "1",
    parentCandidateId: null,
    sourceCandidateId: null,
    derivationType: "agentic_generation",
    textArtifactRef: "candidates/x.md",
    textHash,
    diffArtifactRef: null,
    diffHash: null,
    createdAt: "2026-08-16T00:00:00.000Z",
  });
  assert.equal(result.ok, true);
});
