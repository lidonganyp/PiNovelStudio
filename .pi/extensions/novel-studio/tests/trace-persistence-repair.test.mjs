/** Trace 留存降级回归：主 trace 两次失败后必须写入备用归档。 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { persistUnifiedTraceWithFallback } from "../dist/v2/core/unified-entry.js";

test("主 trace flush 连续失败时写 reports/traces 备用归档并返回路径", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "pinovel-trace-fallback-"));
  let flushAttempts = 0;
  try {
    const result = persistUnifiedTraceWithFallback({
      projectRoot,
      workspaceId: "trace-workspace",
      chapterId: "9",
      traceRecords: [
        {
          stage: "final_selected",
          timestamp: "2026-08-01T00:00:00.000Z",
          strategyContext: {
            modelVersion: "gemini-3.1-pro-preview",
            selectedStrategyIds: ["voice_emphasis"],
            sourceChapter: "ch9",
            opportunityType: "author_style",
          },
        },
      ],
      adapterFactory: () => ({
        record() {},
        flush() {
          flushAttempts += 1;
          return undefined;
        },
        size() { return 1; },
      }),
    });

    assert.equal(flushAttempts, 2, "主 trace 应重试一次");
    assert.equal(result.status, "fallback");
    assert.ok(result.path && existsSync(result.path), "备用 trace 应真实落盘");
    const fallback = JSON.parse(readFileSync(result.path, "utf8"));
    assert.equal(fallback.workspaceId, "trace-workspace");
    assert.equal(fallback.chapterId, "9");
    assert.equal(fallback.traceRecords.length, 1);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

