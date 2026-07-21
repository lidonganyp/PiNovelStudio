/** Numeric chapter filename compatibility regression. */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  resolveExistingChapterFile,
  resolveExistingChapterFileFromChaptersDir,
} from "../dist/utils/chapter-path.js";

test("中央章节解析器兼容工作区中的纯数字章节文件名", () => {
  const workspacePath = mkdtempSync(join(tmpdir(), "pinovel-numeric-chapter-"));
  const chaptersDir = join(workspacePath, "chapters");
  mkdirSync(chaptersDir, { recursive: true });
  const numericPath = join(chaptersDir, "17.md");
  writeFileSync(numericPath, "第十七章测试内容", "utf8");

  assert.deepEqual(resolveExistingChapterFile(workspacePath, "17"), {
    path: numericPath,
    format: "numeric",
  });
  assert.deepEqual(resolveExistingChapterFileFromChaptersDir(chaptersDir, "chapter-17.md"), {
    path: numericPath,
    format: "numeric",
  });
});
