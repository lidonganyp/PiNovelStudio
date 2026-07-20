/**
 * P1: commitAndSave stateCommit 异常时返回值必须包含 error 字段
 *
 * 真相源：用户核验结论（2026-07-17）
 * 位置：v2/core/orchestrator-commit-save.ts:175-185
 *
 * 现状（RED）：
 *   catch 块把 error 写进 stageResults.stateCommit = { error: msg, committed: 0, rejected: 0 }，
 *   但 return 语句返回 { ok: true, stateCommit: { committed, rejected } } — error 被吞掉。
 *   调用方看到 ok:true + stateCommit 无 error 字段，可能误记成功反馈。
 *
 * 期望（GREEN）：
 *   return 语句包含 error 字段：{ ok: true, stateCommit: { committed, rejected, error } }。
 *   调用方可通过 stateCommit.error 检测状态提交失败并记录 warning。
 *
 * 语义保持：
 *   - ok:true 不变（正文已保存，不阻断交付 — 计划 §3 FinalStateCommit 事务边界）
 *   - error 字段为可选，向后兼容（旧调用方读 committed/rejected 不受影响）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { commitAndSave } from "../dist-test/v2/core/orchestrator-commit-save.js";

test("P1: stateCommit 异常时返回值必须包含 error 字段（不被 ok:true 吞掉）", () => {
  const root = mkdtempSync(join(tmpdir(), "commit-save-p1-"));
  try {
    const workspaceId = "ws-p1";
    const workspacePath = join(root, "workspaces", workspaceId);
    // 创建 chapters/ 目录，让正文原子保存成功
    mkdirSync(join(workspacePath, "chapters"), { recursive: true });

    // 构造 input：stagedStateUpdate 用 Proxy，任何属性访问都抛错
    // 这会让 reanchorStagedStateToFinalText 抛异常，进入 catch 块
    const stagedStateUpdate = new Proxy(
      {},
      {
        get() {
          throw new Error("P1 测试：故意触发 stateCommit 异常");
        },
      },
    );

    const input = {
      workspaceId,
      projectRoot: root,
      chapterId: "ch1",
      chapterNumber: 1,
      characterNames: [],
      stagedStateUpdate,
    };
    const stageResults = {};

    const result = commitAndSave(input, "cand-1", "这是正文内容。", stageResults);

    // 正文已保存 -> ok:true（不阻断交付，计划 §3 事务边界）
    assert.equal(result.ok, true, "正文保存成功时 ok 必须为 true（不阻断交付）");

    // stateCommit 必须非 null（stagedStateUpdate 存在，走了 commit 路径）
    assert.ok(result.stateCommit, "stateCommit 必须非 null（stagedStateUpdate 存在）");

    // P1 核心断言：error 必须在返回值中暴露（不能被 ok:true 吞掉）
    assert.ok(
      result.stateCommit.error,
      "P1: stateCommit.error 必须非空 — 异常被传播到返回值，不能被 ok:true 吞掉",
    );

    // stageResults 与返回值一致
    assert.equal(
      stageResults.stateCommit?.error,
      result.stateCommit.error,
      "stageResults.stateCommit.error 与返回值 stateCommit.error 必须一致",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
