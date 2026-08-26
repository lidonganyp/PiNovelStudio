import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { buildChineseAiLanguageGuidance } from "../dist/craft/chinese-ai-language-guidance.js";

test("研究库编译为有界的中文网文软提示", () => {
  const cwd = resolve(process.cwd());
  const projectRoot = existsSync(resolve(cwd, "data/runtime/chinese-webnovel-ai-language-patterns.json"))
    ? cwd
    : resolve(cwd, "../../../");
  const guidance = buildChineseAiLanguageGuidance(projectRoot);
  assert.equal(guidance.source, "runtime_dataset");
  assert.equal(guidance.recordCount, 63);
  assert.ok(guidance.recordIds.length > 0);
  assert.ok(guidance.block.length <= 2600);
  assert.match(guidance.block, /软提示/);
  assert.match(guidance.block, /慢了半拍|少了两分|凝实了一分/);
  assert.match(guidance.block, /不是禁词表/);
  assert.equal(guidance.blockHash.length, 64);
});

test("研究库缺失时使用内置兜底且仍保持软诊断语义", () => {
  const guidance = buildChineseAiLanguageGuidance("C:/path/that/does/not/exist");
  assert.equal(guidance.source, "built_in_fallback");
  assert.ok(guidance.recordIds.includes("CNW-AI-057"));
  assert.match(guidance.block, /平静而顺利/);
  assert.match(guidance.block, /不是禁词表/);
});
