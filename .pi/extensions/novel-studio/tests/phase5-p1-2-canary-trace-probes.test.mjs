/**
 * Phase 5 P1-2 生产探针：Canary trace 与 envelope 完整性
 *
 * 验证 P1-2 修复：
 * 1. story_preservation 等具体 gate 名在 trace 落盘后不被改写为 v2_error
 * 2. legacy-trace-adapter 正确映射非 "error" stage 的 error record
 *
 * 用户反馈（P1-2）：
 * "返回的 story_preservation envelope 落盘后还会被改写为通用 v2_error"
 *
 * 不调用真实模型，纯规则测试。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLegacyTraceAdapter } from "../dist/v2/adapters/legacy-trace-adapter.js";

// ============================================================================
// P1-2: story_preservation gate 名在 trace 落盘后保留
// ============================================================================

test("P1-2: story_preservation error record 的 failureEnvelope 保留具体 gate 名（非 v2_error）", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "p1-2-trace-env-"));
  try {
    const adapter = createLegacyTraceAdapter({
      workspacePath: tmpDir,
      workspaceId: "ws-p1-2",
      chapterId: "1",
    });

    // 模拟 unified-entry.ts 的 persistEarlyBlockedTrace 行为：
    // 使用 failureEnvelope.stage（如 "story_preservation"）作为 trace record 的 stage
    adapter.record({
      stage: "story_preservation",
      timestamp: new Date().toISOString(),
      error: {
        message: "editorial 删除了 raw 的关键事件（missing_event）",
        code: "story_preservation",
        recoverable: false,
      },
      contextHash: "early-blocked",
    });

    const path = adapter.flush();
    assert.ok(path, "flush 应返回 trace 文件路径");

    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    assert.ok(Array.isArray(parsed.failureEnvelopes), "应有 failureEnvelopes 数组");
    assert.equal(parsed.failureEnvelopes.length, 1, "应有 1 条 failureEnvelope");

    const envelope = parsed.failureEnvelopes[0];
    // P1-2 核心断言：gate 名应保留 "story_preservation"，而非被改写为 "v2_error"
    assert.equal(
      envelope.stage,
      "v2_story_preservation",
      `failureEnvelope.stage 应为 "v2_story_preservation"，实际: "${envelope.stage}"`,
    );
    assert.equal(
      envelope.gate,
      "v2_story_preservation",
      `failureEnvelope.gate 应为 "v2_story_preservation"，实际: "${envelope.gate}"`,
    );
    assert.equal(envelope.reason, "editorial 删除了 raw 的关键事件（missing_event）");
    assert.equal(envelope.recoverable, false);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("P1-2: preflight error record 的 failureEnvelope 保留 preflight gate 名", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "p1-2-preflight-"));
  try {
    const adapter = createLegacyTraceAdapter({
      workspacePath: tmpDir,
      workspaceId: "ws-p1-2",
      chapterId: "2",
    });

    adapter.record({
      stage: "preflight",
      timestamp: new Date().toISOString(),
      error: {
        message: "缺少风格档案",
        code: "preflight",
        recoverable: false,
      },
      contextHash: "early-blocked",
    });

    const path = adapter.flush();
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    const envelope = parsed.failureEnvelopes[0];

    assert.equal(
      envelope.stage,
      "v2_preflight",
      `failureEnvelope.stage 应为 "v2_preflight"，实际: "${envelope.stage}"`,
    );
    assert.equal(
      envelope.gate,
      "v2_preflight",
      `failureEnvelope.gate 应为 "v2_preflight"，实际: "${envelope.gate}"`,
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("P1-2: style_optimization error record 的 failureEnvelope 保留具体 gate 名", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "p1-2-style-"));
  try {
    const adapter = createLegacyTraceAdapter({
      workspacePath: tmpDir,
      workspaceId: "ws-p1-2",
      chapterId: "3",
    });

    adapter.record({
      stage: "style_optimization",
      timestamp: new Date().toISOString(),
      error: {
        message: "风格优化无候选产出（no_guidance）",
        code: "style_optimization",
        recoverable: false,
      },
      contextHash: "early-blocked",
    });

    const path = adapter.flush();
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    const envelope = parsed.failureEnvelopes[0];

    assert.equal(
      envelope.stage,
      "v2_style_optimization",
      `failureEnvelope.stage 应为 "v2_style_optimization"，实际: "${envelope.stage}"`,
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("P1-2: 通用 error stage 仍映射为 v2_error（向后兼容）", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "p1-2-generic-"));
  try {
    const adapter = createLegacyTraceAdapter({
      workspacePath: tmpDir,
      workspaceId: "ws-p1-2",
      chapterId: "4",
    });

    // 使用通用 "error" stage（非 P1-2 修复路径）
    adapter.record({
      stage: "error",
      timestamp: new Date().toISOString(),
      error: {
        message: "model timeout",
        code: "TIMEOUT",
        recoverable: true,
      },
      contextHash: "early-blocked",
    });

    const path = adapter.flush();
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    const envelope = parsed.failureEnvelopes[0];

    // 通用 error stage 仍映射为 v2_error（向后兼容）
    assert.equal(
      envelope.stage,
      "v2_error",
      `通用 error stage 应映射为 "v2_error"，实际: "${envelope.stage}"`,
    );
    assert.equal(envelope.recoverable, true);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("P1-2: error record 的 gate stage 也包含具体阶段名（gates[] 不只 failureEnvelopes[]）", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "p1-2-gates-"));
  try {
    const adapter = createLegacyTraceAdapter({
      workspacePath: tmpDir,
      workspaceId: "ws-p1-2",
      chapterId: "5",
    });

    adapter.record({
      stage: "story_preservation",
      timestamp: new Date().toISOString(),
      error: {
        message: "editorial 漂移",
        code: "story_preservation",
        recoverable: false,
      },
      contextHash: "early-blocked",
    });

    const path = adapter.flush();
    const parsed = JSON.parse(readFileSync(path, "utf-8"));

    // gates[] 也应包含具体阶段名
    assert.ok(Array.isArray(parsed.gates), "应有 gates 数组");
    const gate = parsed.gates.find((g) => g.stage === "v2_story_preservation");
    assert.ok(gate, `gates[] 应包含 "v2_story_preservation" stage`);
    assert.equal(gate.status, "ERROR", `gate.status 应为 ERROR`);
    assert.equal(gate.reason, "editorial 漂移", `gate.reason 应为 error message`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
