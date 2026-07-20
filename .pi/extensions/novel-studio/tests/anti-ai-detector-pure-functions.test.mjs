/**
 * Anti-AI Detector 纯函数 characterization 测试
 *
 * 目的：在 anti-ai-detector.ts（约 3,082 行）拆分纯函数到独立模块前，
 * 先捕获当前导出行为作为安全网。这些测试对当前代码应全部 GREEN；
 * 后续提取 removeExactRepeatedSentences / autoPatchAIPatterns /
 * repairIdiomStackingLocally / pattern 分类 / 文本窗口等纯函数到独立模块时，
 * 本测试必须保持 GREEN，否则说明提取改变了行为。
 *
 * 覆盖范围（模块级纯导出，非 AntiAIDetector 类门面）：
 * - removeExactRepeatedSentences（重复句清理）
 * - autoPatchAIPatterns（自动修复：重复句 + 结尾套话 + 感知动词 + 否定铺垫）
 * - repairIdiomStackingLocally（局部四字格堆叠拆分）
 * - classifyPatternResidueKind / isStructuralResidueBlocklisted（pattern 风险分类）
 * - buildAntiAILLMDetectionTextWindow（LLM 检测文本窗口）
 * - isTextActuallyComplete（文本完整性判定）
 *
 * 边界（READY_LOCAL）：不调用真实模型、不联网；仅断言纯函数输入→输出。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  removeExactRepeatedSentences,
  classifyPatternResidueKind,
  isStructuralResidueBlocklisted,
  buildAntiAILLMDetectionTextWindow,
  isTextActuallyComplete,
} from "../dist/craft/anti-ai-detector.js";
import {
  autoPatchAIPatterns,
  repairIdiomStackingLocally,
} from "../dist-test/craft/anti-ai-auto-patch.js";

// ============================================================================
// removeExactRepeatedSentences
// ============================================================================

test("removeExactRepeatedSentences: 无重复 → 原文不变，removedCount=0", () => {
  const text = "夜色渐渐笼罩了整座城市。远处传来几声犬吠。";
  const result = removeExactRepeatedSentences(text);
  assert.equal(result.text, text);
  assert.equal(result.removedCount, 0);
  assert.deepEqual(result.positions, []);
});

test("removeExactRepeatedSentences: 完全重复句 → 保留首句，删除后续", () => {
  const text = "夜色渐渐笼罩了整座城市。夜色渐渐笼罩了整座城市。";
  const result = removeExactRepeatedSentences(text);
  assert.equal(result.text, "夜色渐渐笼罩了整座城市。");
  assert.equal(result.removedCount, 1);
  assert.equal(result.positions.length, 1);
  // 第二句起始位置 = 首句长度（含句号）
  assert.equal(result.positions[0], "夜色渐渐笼罩了整座城市。".length);
});

test("removeExactRepeatedSentences: 尾标点不同（一带句号一带无）→ 归一化键不等，不去重", () => {
  // 归一化保留尾标点：normalize 返回带尾标点的 normalized 形式（非去尾的 content），
  // 故"城市。"与"城市"键不等，不判为重复（捕获当前行为）
  const text = "夜色渐渐笼罩了整座城市。夜色渐渐笼罩了整座城市";
  const result = removeExactRepeatedSentences(text);
  assert.equal(result.removedCount, 0, "尾标点不同时归一化键不等，当前不去重");
});

test("removeExactRepeatedSentences: 短句（<8 字）不参与去重", () => {
  const text = "好的。好的。";
  const result = removeExactRepeatedSentences(text);
  assert.equal(result.text, text, "短句应原样保留");
  assert.equal(result.removedCount, 0);
});

test("removeExactRepeatedSentences: 章节标题式句式不参与去重", () => {
  // 【...】整体匹配章节标记正则，且 ≥8 字通过长度门
  const text = "【这是一个标题】。【这是一个标题】。";
  const result = removeExactRepeatedSentences(text);
  assert.equal(result.text, text, "章节标题式不应被去重");
  assert.equal(result.removedCount, 0);
});

test("removeExactRepeatedSentences: 空字符串 → 原样返回", () => {
  const result = removeExactRepeatedSentences("");
  assert.equal(result.text, "");
  assert.equal(result.removedCount, 0);
  assert.deepEqual(result.positions, []);
});

test("removeExactRepeatedSentences: 多次重复 → 仅保留首句，删除全部后续", () => {
  const text = "夜色渐渐笼罩了整座城市。夜色渐渐笼罩了整座城市。夜色渐渐笼罩了整座城市。";
  const result = removeExactRepeatedSentences(text);
  assert.equal(result.text, "夜色渐渐笼罩了整座城市。");
  assert.equal(result.removedCount, 2);
  assert.equal(result.positions.length, 2);
});

// ============================================================================
// autoPatchAIPatterns
// ============================================================================

test("autoPatchAIPatterns: 空字符串 → 0 修复", () => {
  const result = autoPatchAIPatterns("");
  assert.equal(result.patchedText, "");
  assert.equal(result.fixesApplied, 0);
  assert.deepEqual(result.fixDetails, []);
});

test("autoPatchAIPatterns: 干净文本 → 0 修复，原文不变", () => {
  const text = "这是一段完全正常的中文正文，没有任何AI腔的痕迹。";
  const result = autoPatchAIPatterns(text);
  assert.equal(result.patchedText, text);
  assert.equal(result.fixesApplied, 0);
});

test("autoPatchAIPatterns: 重复句 → 删除重复（走 removeExactRepeatedSentences）", () => {
  const text = "夜色渐渐笼罩了整座城市。夜色渐渐笼罩了整座城市。";
  const result = autoPatchAIPatterns(text);
  assert.equal(result.patchedText, "夜色渐渐笼罩了整座城市。");
  assert.ok(result.fixesApplied >= 1, "应至少修复 1 处");
  assert.ok(result.fixDetails.some((d) => d.includes("删除重复句")));
});

test("autoPatchAIPatterns: 结尾套话 → 删除", () => {
  const text = "故事继续发展。欲知后事如何，且听下回分解。";
  const result = autoPatchAIPatterns(text);
  assert.equal(result.patchedText, "故事继续发展。");
  assert.ok(result.fixesApplied >= 1);
  assert.ok(result.fixDetails.some((d) => d.includes("删除结尾套话")));
});

test("autoPatchAIPatterns: 感知确认动词 → 删除", () => {
  const text = "他看到了远处的灯光。";
  const result = autoPatchAIPatterns(text);
  assert.equal(result.patchedText, "远处的灯光。");
  assert.ok(result.fixesApplied >= 1);
  assert.ok(result.fixDetails.some((d) => d.includes("删除感知动词")));
});

test("autoPatchAIPatterns: 带修饰语的否定铺垫 → 删除'不是X，是'保留 Y", () => {
  const text = "这不是一次普通的异常，而是某种特殊征兆。";
  const result = autoPatchAIPatterns(text);
  assert.equal(result.patchedText, "某种特殊征兆。");
  assert.ok(result.fixesApplied >= 1);
  assert.ok(result.fixDetails.some((d) => d.includes("修复否定铺垫")));
});

test("autoPatchAIPatterns: 短情绪/认知对比（≤4字）→ 文学修辞保留不修改", () => {
  const text = "不是惊讶，是认得。";
  const result = autoPatchAIPatterns(text);
  assert.equal(result.patchedText, text, "短情绪对比属文学修辞，不应修改");
  assert.equal(result.fixesApplied, 0);
});

// ============================================================================
// repairIdiomStackingLocally
// ============================================================================

test("repairIdiomStackingLocally: 空字符串 → 0 修复", () => {
  const result = repairIdiomStackingLocally("");
  assert.equal(result.repairedText, "");
  assert.equal(result.fixesApplied, 0);
  assert.deepEqual(result.fixDetails, []);
});

test("repairIdiomStackingLocally: 无堆叠 → 原文不变", () => {
  const text = "他走在路上，看着远处的风景。";
  const result = repairIdiomStackingLocally(text);
  assert.equal(result.repairedText, text);
  assert.equal(result.fixesApplied, 0);
});

test("repairIdiomStackingLocally: 三四字格堆叠 → 拆分连接符为句号", () => {
  const text = "风平浪静，云淡风轻，水到渠成。";
  const result = repairIdiomStackingLocally(text);
  assert.ok(result.fixesApplied >= 1, "应检测到堆叠并修复");
  assert.ok(
    result.repairedText.includes("风平浪静。"),
    "应把四字格间连接符替换为句号",
  );
  assert.notEqual(result.repairedText, text);
});

test("repairIdiomStackingLocally: 代词开头句 → 跳过不修复", () => {
  // 以代词开头的叙事句不视为成语堆叠
  const text = "他风平浪静，云淡风轻，水到渠成。";
  const result = repairIdiomStackingLocally(text);
  assert.equal(result.repairedText, text, "代词开头句应跳过");
  assert.equal(result.fixesApplied, 0);
});

test("repairIdiomStackingLocally: 角色名开头句 → 跳过不修复", () => {
  const text = "林风风平浪静，云淡风轻，水到渠成。";
  const result = repairIdiomStackingLocally(text, new Set(["林风"]));
  assert.equal(result.repairedText, text, "角色名开头句应跳过");
  assert.equal(result.fixesApplied, 0);
});

// ============================================================================
// classifyPatternResidueKind / isStructuralResidueBlocklisted
// ============================================================================

test("classifyPatternResidueKind: 白名单内 patternId → style_conflict", () => {
  assert.equal(classifyPatternResidueKind("excessive_ellipsis"), "style_conflict");
  assert.equal(classifyPatternResidueKind("weak_adverb"), "style_conflict");
  assert.equal(classifyPatternResidueKind("heart_surge"), "style_conflict");
});

test("classifyPatternResidueKind: 非白名单 patternId → 默认 structural_ai_residue", () => {
  assert.equal(classifyPatternResidueKind("parenthetical_explanation"), "structural_ai_residue");
  assert.equal(classifyPatternResidueKind("summarize"), "structural_ai_residue");
  assert.equal(classifyPatternResidueKind("totally_unknown_pattern"), "structural_ai_residue");
});

test("isStructuralResidueBlocklisted: 黑名单内 → true", () => {
  assert.equal(isStructuralResidueBlocklisted("parenthetical_explanation"), true);
  assert.equal(isStructuralResidueBlocklisted("over_explain"), true);
  assert.equal(isStructuralResidueBlocklisted("empty_beast_eye_metaphor"), true);
});

test("isStructuralResidueBlocklisted: 非黑名单 → false", () => {
  assert.equal(isStructuralResidueBlocklisted("excessive_ellipsis"), false);
  assert.equal(isStructuralResidueBlocklisted("totally_unknown_pattern"), false);
});

// ============================================================================
// buildAntiAILLMDetectionTextWindow
// ============================================================================

test("buildAntiAILLMDetectionTextWindow: ≤12000 字 → 全量返回", () => {
  const short = "x".repeat(12000);
  assert.equal(buildAntiAILLMDetectionTextWindow(short), short);
  assert.equal(buildAntiAILLMDetectionTextWindow("短文本"), "短文本");
});

test("buildAntiAILLMDetectionTextWindow: >12000 字 → 头8000 + 省略标注 + 尾4000", () => {
  const head = "a".repeat(8000);
  const middle = "MIDDLE";
  const tail = "b".repeat(4000);
  const long = head + middle + tail; // 12006 > 12000
  const result = buildAntiAILLMDetectionTextWindow(long);
  assert.ok(result.startsWith(head), "应保留头部 8000 字");
  assert.ok(result.endsWith(tail), "应保留尾部 4000 字");
  assert.ok(
    result.includes("[...中段省略，仅保留开篇与结尾用于检测...]"),
    "应插入中段省略标注",
  );
  // 头尾之间只剩省略标注，不应残留 middle
  assert.ok(!result.includes("MIDDLE"), "中段应被省略");
});

// ============================================================================
// isTextActuallyComplete
// ============================================================================

test("isTextActuallyComplete: 空串/纯空白 → false", () => {
  assert.equal(isTextActuallyComplete(""), false);
  assert.equal(isTextActuallyComplete("   "), false);
});

test("isTextActuallyComplete: 无终止标点 → false", () => {
  assert.equal(isTextActuallyComplete("一段未结束的文字"), false);
  assert.equal(isTextActuallyComplete("abc"), false);
});

test("isTextActuallyComplete: 以终止标点收尾 → true", () => {
  assert.equal(isTextActuallyComplete("一段完整的文字。"), true);
  assert.equal(isTextActuallyComplete("完整的文字！"), true);
  assert.equal(isTextActuallyComplete("完整的文字？"), true);
  assert.equal(isTextActuallyComplete("（完）"), true);
});

test("isTextActuallyComplete: 尾部空白被 trimEnd 后判定", () => {
  assert.equal(isTextActuallyComplete("一段文字。   "), true, "尾部空白应被忽略");
  assert.equal(isTextActuallyComplete("未结束   "), false);
});
