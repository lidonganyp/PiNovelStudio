/**
 * ENTITY-CHECKER-1 — V2 FactContinuityGuard 实体幻觉误报回归测试.
 *
 * 阶段：RED（tests 1/3 当前 FAIL，证明 bug 存在；tests 2/4/5 为回归/正例，已 PASS）。
 *
 * 验收口径（对应任务卡 acceptance）：
 * 1. RED: "溶洞通道" ×3 不应触发 entity_checker（"溶洞通"+"道" 被 greedy 正则捕获，
 *    但"道"在此是名词后缀，构成复合词"通道"，非言说动词）。
 * 2. 回归: "知道" ×3 不应触发 entity_checker（现有 partial fix 已过滤代词主语+"知道"，
 *    本测试确保 ENTITY-CHECKER-1 新增 compound 过滤不破坏既有"知道"过滤行为）。
 * 3. RED: "溶洞道路" ×3 不应触发 entity_checker（"溶洞"+"道" 被捕获，但"道"作名词前缀
 *    构成复合词"道路"，非言说动词）。
 * 4. 正例: "魏无道：" ×3 仍应触发 entity_checker（"道"后紧跟冒号"："
 *    是真实言说动词，符合 entity_checker 设计意图）。
 * 5. 回归: "王五说" ×3 仍应触发 entity_checker（最简单的言说正例，
 *    确保修复不破坏既有 entity_checker 真实正例检测）。
 *
 * 真相源：
 * - 误报根因：fact-continuity-guard.ts checkEntityHallucination 的 regex
 *   `/([\u4e00-\u9fff]{2,4})(道|说|问|笑|怒|喊|叹|答|回|应)/g` greedy
 *   匹配 "溶洞通道" 时回溯到 {3}="溶洞通"+"道"，"溶洞通" 不在 allowlist、
 *   非已知角色子串，≥3 次触发误报。
 * - 真实样本来源：reports/real-quality-4g-result-20260714.md 中 ch18 正文出现
 *   "溶洞通道" 被 entity_checker 误判为"溶洞通"角色幻觉。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createFactContinuityGuard } from "../dist/v2/core/fact-continuity-guard.js";

const BASE_CONTEXT = {
  facts: [],
  characterStates: [],
  openLoops: [],
  worldRules: [],
  styleReferences: [],
  sourceMap: [],
  constitution: null,
  longTermState: null,
};

function runEntityCheck(text, knownCharacterNames = []) {
  const guard = createFactContinuityGuard();
  const report = guard.check({
    text,
    context: BASE_CONTEXT,
    knownCharacterNames,
    identityContract: null,
    ontologyContract: null,
  });
  return report.allDiagnostics.filter((d) => d.source === "entity_checker");
}

// ──────────────────────────────────────────────────────────────────────────
// 测试 1: "溶洞通道" ×3 不应触发（"道"作名词后缀，复合词"通道"）
// ──────────────────────────────────────────────────────────────────────────

test("EC1 RED: '溶洞通道' ×3 不应触发 entity_checker（'道'为复合词后缀）", () => {
  const text =
    "溶洞通道在前方延伸。溶洞通道里很黑。溶洞通道很狭窄，只能容一人通过。";
  const diags = runEntityCheck(text, []);
  assert.equal(
    diags.length,
    0,
    `'溶洞通道' 不应被误报为角色幻觉（"溶洞通"非角色名）。实际诊断：${JSON.stringify(diags)}`,
  );
});

// ──────────────────────────────────────────────────────────────────────────
// 测试 2（回归保护）: "知道" ×3 不应触发（"道"作动词后缀，复合词"知道"）
// 现有 partial fix 已过滤代词主语 + "知道"，本测试作为回归保护，
// 确保 ENTITY-CHECKER-1 新增的 compound 过滤不破坏既有"知道"过滤行为。
// ──────────────────────────────────────────────────────────────────────────

test("EC1 回归: '知道' ×3 不应触发 entity_checker（'道'为复合词后缀，非言说）", () => {
  // 注意：后续字符必须非言语动词（真/内/一 都不在 道说问笑怒喊叹答回应 中），
  // 否则贪婪 {4}/{3} 会先匹配 "他知道答" 之类，把"他知"计数打散到 <3 而掩盖误报。
  const text = "他知道真相。他知道内情。他知道一切。";
  const diags = runEntityCheck(text, []);
  assert.equal(
    diags.length,
    0,
    `'知道' 不应被误报为角色幻觉（"他知"非角色名）。实际诊断：${JSON.stringify(diags)}`,
  );
});

// ──────────────────────────────────────────────────────────────────────────
// 测试 3: "溶洞道路" ×3 不应触发（"道"作名词前缀，复合词"道路"）
// ──────────────────────────────────────────────────────────────────────────

test("EC1 RED: '溶洞道路' ×3 不应触发 entity_checker（'道'为复合词前缀）", () => {
  const text = "溶洞道路很滑。溶洞道路很长。溶洞道路很窄。";
  const diags = runEntityCheck(text, []);
  assert.equal(
    diags.length,
    0,
    `'溶洞道路' 不应被误报为角色幻觉（"溶洞"非角色名）。实际诊断：${JSON.stringify(diags)}`,
  );
});

// ──────────────────────────────────────────────────────────────────────────
// 测试 4（正例）: "魏无道：" ×3 仍应触发（"道"后接冒号是真实言说）
// ──────────────────────────────────────────────────────────────────────────

test("EC1 正例: '魏无道：' ×3 仍应触发 entity_checker（'道'后冒号=真实言说）", () => {
  const text = "魏无道：你好。魏无道：再见。魏无道：快点。";
  const diags = runEntityCheck(text, []);
  assert.ok(
    diags.length >= 1,
    `'魏无道：' 应触发 entity_checker（"道"后接冒号是真实言说）。实际诊断：${JSON.stringify(diags)}`,
  );
  const evidence = diags.map((d) => d.evidence).join(" ");
  assert.ok(
    evidence.includes("魏无"),
    `诊断证据应含"魏无"。实际证据：${evidence}`,
  );
});

// ──────────────────────────────────────────────────────────────────────────
// 测试 5（回归保护）: "王五说" ×3 仍应触发（简单言说正例不破坏）
// ──────────────────────────────────────────────────────────────────────────

test("EC1 回归: '王五说' ×3 仍应触发 entity_checker（最简单言说正例）", () => {
  const text = "王五说了一句话。王五说了另一句。王五说了第三句。";
  const diags = runEntityCheck(text, []);
  assert.ok(
    diags.length >= 1,
    `'王五说' 应触发 entity_checker（简单言说正例）。实际诊断：${JSON.stringify(diags)}`,
  );
  const evidence = diags.map((d) => d.evidence).join(" ");
  assert.ok(
    evidence.includes("王五"),
    `诊断证据应含"王五"。实际证据：${evidence}`,
  );
});
