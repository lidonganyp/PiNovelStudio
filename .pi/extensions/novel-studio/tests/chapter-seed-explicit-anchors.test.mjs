/** Configured prose-execution anchors must not enter the production ChapterSeed. */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildChapterSeed } from "../dist-test/craft/chapter-seed-builder.js";

test("ChapterSeedBuilder ignores configured candidateAnchors as prose instructions", () => {
  const workspacePath = mkdtempSync(join(tmpdir(), "pinovel-explicit-seed-anchor-"));
  try {
    mkdirSync(join(workspacePath, "characters"), { recursive: true });
    writeFileSync(join(workspacePath, "config.json"), JSON.stringify({
      novelName: "测试作品",
      genre: "灵异",
      subGenres: ["悬疑"],
      characters: [{ id: "p1", name: "林川", role: "protagonist" }],
      chapterSeeds: {
        "1": {
          candidateAnchors: [
            { id: "choice-1", description: " 主动选择：追查门外脚步；代价验证：暴露位置 ", channel: "cognitive", weight: 0.9 },
            { id: "choice-2", description: "主动选择：关闭照明；代价验证：失去视觉", channel: "emotional", weight: 0.8 },
            { id: "invalid", description: "", channel: "visual", weight: 1.5 },
          ],
        },
      },
    }, null, 2), "utf8");

    const result = buildChapterSeed({
      workspacePath,
      workspaceId: "explicit-seed-anchor",
      chapterId: "1",
      chapterNumber: 1,
    });

    assert.deepEqual(result.seed.candidateAnchors, []);
    assert.equal(result.warnings.some((warning) => warning.includes("candidateAnchors")), false);
    assert.equal(result.seed.candidateAnchors.some((anchor) => anchor.id === "invalid"), false);
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
});
