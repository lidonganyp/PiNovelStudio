/**
 * FACT-GUARD-ENTITY-CHECKER-RULE-TEXT-1 — entity_checker 误报修复
 *
 * 阶段：RED（4 类误报当前 FAIL，证明 false-positive 存在；
 * 回归保护测试当前已 PASS，确保修复不破坏真实幻觉检测）。
 *
 * 真相源：workspaces/fuben-clean-window-5-20260715/traces/2-blocked-candidate-evidence.json
 *   RECOVERY-3 ch2 raw (12870 字) 被 FactGuard entity_checker hard block，
 *   4 条误报（禁止返/规则二/没有/广播），全部来自规则公告文本片段与常见词。
 *
 * 误报根因分析（来自 RECOVERY-3 raw storedText）：
 * 1. "禁止返" (4 次)：来自 "禁止返回入口"，正则匹配 "禁止返"+"回"，
 *    但 "返回" 中的 "回" 是运动动词（返回），非言说动词（回答）。
 *    出现在 markdown > 引文块（规则一公告）+ 正文重读分析。
 * 2. "规则二" (3 次)：来自 "规则二说停电时保持不动"，"规则二" 是规则标签，
 *    非角色名。出现在正文重读分析（"规则二说..."）。
 * 3. "没有" (3 次)：来自 "没有说/回/应" 等否定词+动词组合，"没有" 是否定词，
 *    非角色名。
 * 4. "广播" (3 次)：来自 "广播说/回/应" 等场景道具+动词组合，"广播" 是无生命主语，
 *    非角色名。
 *
 * 修复边界（用户授权 2026-07-16）：
 * - 仅排除 Markdown 引文块中的规则文本和被误识别的常见词
 * - 真实实体幻觉仍须 hard block
 * - 不破坏既有 ENTITY-CHECKER-1（"道"非言说复合词）与 ENTITY_COMMON_NOUN_ALLOWLIST 逻辑
 *
 * 验收口径：
 * 1. RED: "禁止返回入口" 引文块+重读 → 不触发 entity_checker（"回"运动复合词）
 * 2. RED: "规则二说" 正文重读 → 不触发 entity_checker（规则标签）
 * 3. RED: "没有说" ×3 → 不触发 entity_checker（否定词扩展 allowlist）
 * 4. RED: "广播说" ×3 → 不触发 entity_checker（无生命名词扩展 allowlist）
 * 5. RED: markdown > 引文块内的规则文本片段 → 不触发 entity_checker
 * 6. 回归: 真实角色幻觉（"慕容彻说"×3，不在 known names）→ 仍 hard block
 * 7. 回归: 引文块外的真实角色幻觉 → 仍 hard block（引文块排除不放过真实幻觉）
 * 8. 回归: 既有 "道" 非言说复合词（"溶洞通道"）→ 不触发（ENTITY-CHECKER-1 不破坏）
 * 9. 回归: 既有 allowlist 常见词（"不是笑"）→ 不触发（FACTGUARD-SCANNER-FIX-1 不破坏）
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

function runEntityChecker(text, knownCharacterNames = []) {
  const guard = createFactContinuityGuard();
  const report = guard.check({
    text,
    context: BASE_CONTEXT,
    knownCharacterNames,
    identityContract: null,
    ontologyContract: null,
  });
  return {
    diags: report.allDiagnostics.filter((d) => d.source === "entity_checker"),
    hasHardBlock: report.hasHardBlock,
  };
}

// ============================================================================
// RED 测试：4 类误报复现（来自 RECOVERY-3 ch2 raw）
// ============================================================================

test("FACT-GUARD-ENTITY-CHECKER-RULE-TEXT-1 RED: \"禁止返回入口\" 引文块+重读 → 不触发（\"回\"运动复合词）", () => {
  // 真实样本：RECOVERY-3 raw 中规则一公告 + 林觉重读分析
  // "禁止返回入口" 中的 "回" 是运动动词（返回），非言说动词（回答）
  const text = [
    "> **灰级副本 N-002 规则公告**",
    ">",
    "> 规则一：进入后请沿疏散标识方向移动，禁止返回入口。",
    "",
    "规则一说沿疏散标识方向移动，禁止返回入口。入口那扇防火门已经看不到了。",
    "他记得规则一禁止返回入口，所以没有回头。禁止返回入口是明确的禁令。",
  ].join("\n");

  const { diags } = runEntityChecker(text, ["林觉"]);
  const falsePositives = diags.filter((d) => d.evidence.includes("禁止返"));
  assert.equal(
    falsePositives.length,
    0,
    `"禁止返" 不应被误判为角色幻觉（"回"在"返回"中是运动动词）。实际诊断：${JSON.stringify(diags)}`,
  );
});

test("FACT-GUARD-ENTITY-CHECKER-RULE-TEXT-1 RED: \"规则二说\" 正文重读 → 不触发（规则标签）", () => {
  // 真实样本：RECOVERY-3 raw 中林觉重读分析
  // "规则二" 是规则标签，非角色名
  // 注意：greedy 正则 {2,4} 会吞掉前面汉字，需确保 "规则二" 前面是非汉字字符（行首/标点后）
  const text = [
    "规则二说停电时保持不动，第17条说不受断电影响。",
    "广播里说，规则二说停电时保持不动。两条规则同时生效。",
    "林觉记得：规则二说停电时保持不动，但第17条不受断电影响。",
  ].join("\n");

  const { diags } = runEntityChecker(text, ["林觉"]);
  const falsePositives = diags.filter((d) => d.evidence.includes("规则二"));
  assert.equal(
    falsePositives.length,
    0,
    `"规则二" 不应被误判为角色幻觉（规则标签非角色名）。实际诊断：${JSON.stringify(diags)}`,
  );
});

test("FACT-GUARD-ENTITY-CHECKER-RULE-TEXT-1 RED: \"没有说\" ×3 → 不触发（否定词扩展 allowlist）", () => {
  // "没有" 是否定词，跟在言说动词前不是角色名
  // 注意：greedy 正则 {2,4} 会吞掉前面汉字，需确保 "没有" 前面是非汉字字符（行首/标点后）
  // 且需同一个言说动词重复 3 次，否则 "没有回"+"答" 等会分散 count
  const text = [
    "林觉站着。没有说话。他只是看着墙上的字。",
    "灰衣人低头。没有说话。他不想看林觉。",
    "广播安静。没有说话。整个房间能听到电流声。",
  ].join("\n");

  const { diags } = runEntityChecker(text, ["林觉"]);
  const falsePositives = diags.filter((d) => d.evidence.includes("\"没有\""));
  assert.equal(
    falsePositives.length,
    0,
    `"没有" 不应被误判为角色幻觉（否定词）。实际诊断：${JSON.stringify(diags)}`,
  );
});

test("FACT-GUARD-ENTITY-CHECKER-RULE-TEXT-1 RED: \"广播说\" ×3 → 不触发（无生命名词扩展 allowlist）", () => {
  // "广播" 是场景道具/无生命主语，非角色名
  const text = [
    "广播说：\"各位，欢迎来到N-002。请确认您已阅读规则公告。\"",
    "广播说倒计时持续运行，请沿疏散标识方向移动。",
    "广播说样本N-7已抵达出口区域。林觉听到了那个声音。",
  ].join("\n");

  const { diags } = runEntityChecker(text, ["林觉"]);
  const falsePositives = diags.filter((d) => d.evidence.includes("\"广播\""));
  assert.equal(
    falsePositives.length,
    0,
    `"广播" 不应被误判为角色幻觉（无生命主语）。实际诊断：${JSON.stringify(diags)}`,
  );
});

test("FACT-GUARD-ENTITY-CHECKER-RULE-TEXT-1 RED: markdown > 引文块内规则文本片段 → 不触发", () => {
  // 用户明确要求：排除 Markdown 引文块中的规则文本
  // 引文块内的 "规则一/二/三/四" 标签 + 规则内容片段不应被误判为角色名
  const text = [
    "> **灰级副本 N-002 规则公告**",
    ">",
    "> 规则一：进入后请沿疏散标识方向移动，禁止返回入口。",
    ">",
    "> 规则二：如遇停电，请保持原地不动。",
    ">",
    "> 规则三：广播播报期间，禁止交谈。",
    ">",
    "> 规则四：请在计时器归零前抵达出口。",
    ">",
    "> 第17条：不受断电影响。",
  ].join("\n");

  const { diags } = runEntityChecker(text, ["林觉"]);
  // 引文块内的规则文本不应触发 entity_checker
  const ruleTextFalsePositives = diags.filter(
    (d) => d.evidence.includes("规则") || d.evidence.includes("禁止返") || d.evidence.includes("广播"),
  );
  assert.equal(
    ruleTextFalsePositives.length,
    0,
    `引文块内规则文本不应被误判为角色幻觉。实际诊断：${JSON.stringify(diags)}`,
  );
});

// ============================================================================
// 回归保护测试：真实幻觉仍 hard block
// ============================================================================

test("FACT-GUARD-ENTITY-CHECKER-RULE-TEXT-1 回归: 真实角色幻觉（\"慕容彻说\"×3，不在 known names）→ 仍 hard block", () => {
  // 真实幻觉：未在角色档案中的角色名 + 言说动词 ×3
  const text = [
    "慕容彻说：\"你来了。\"",
    "慕容彻说：\"坐下吧。\"",
    "慕容彻说：\"我们谈谈。\"",
  ].join("\n");

  const { diags, hasHardBlock } = runEntityChecker(text, ["林觉"]);
  const murongDiags = diags.filter((d) => d.evidence.includes("慕容彻"));
  assert.ok(
    murongDiags.length >= 1,
    `真实角色幻觉"慕容彻"应被检测。实际诊断：${JSON.stringify(diags)}`,
  );
  assert.equal(murongDiags[0].severity, "hard");
  assert.equal(hasHardBlock, true);
});

test("FACT-GUARD-ENTITY-CHECKER-RULE-TEXT-1 回归: 引文块外的真实角色幻觉 → 仍 hard block", () => {
  // 引文块排除不放过真实幻觉：引文块外真实幻觉仍须检测
  const text = [
    "> 规则一：这是一条规则文本。",
    "",
    "萧玄说：\"你来了。\"",
    "萧玄说：\"坐下吧。\"",
    "萧玄说：\"我们谈谈。\"",
  ].join("\n");

  const { diags, hasHardBlock } = runEntityChecker(text, ["林觉"]);
  const xiaoxuanDiags = diags.filter((d) => d.evidence.includes("萧玄"));
  assert.ok(
    xiaoxuanDiags.length >= 1,
    `引文块外真实角色幻觉"萧玄"应被检测。实际诊断：${JSON.stringify(diags)}`,
  );
  assert.equal(xiaoxuanDiags[0].severity, "hard");
  assert.equal(hasHardBlock, true);
});

test("FACT-GUARD-ENTITY-CHECKER-RULE-TEXT-1 回归: 既有 \"道\" 非言说复合词（\"溶洞通道\"）→ 不触发（ENTITY-CHECKER-1 不破坏）", () => {
  // 既有 ENTITY-CHECKER-1 修复："溶洞通道" 中的 "道" 是名词性复合词，非言说动词
  // 此测试确保新修复不破坏既有逻辑
  const text = [
    "他走进溶洞通道。溶洞通道很深，看不到尽头。",
    "溶洞通道里回响着水滴声。他沿着溶洞通道往前走。",
    "溶洞通道的尽头有一扇门。他停在溶洞通道的末端。",
  ].join("\n");

  const { diags } = runEntityChecker(text, ["林觉"]);
  const falsePositives = diags.filter((d) => d.evidence.includes("溶洞通"));
  assert.equal(
    falsePositives.length,
    0,
    `"溶洞通" 不应被误判（ENTITY-CHECKER-1 既有修复应保持）。实际诊断：${JSON.stringify(diags)}`,
  );
});

test("FACT-GUARD-ENTITY-CHECKER-RULE-TEXT-1 回归: 既有 allowlist 常见词（\"不是笑\"）→ 不触发（FACTGUARD-SCANNER-FIX-1 不破坏）", () => {
  // 既有 FACTGUARD-SCANNER-FIX-1 修复："不是" 是否定/系词短语，非角色名
  // 此测试确保新修复不破坏既有 allowlist
  const text = [
    "林觉不是笑。他只是看着墙上的字。",
    "她不是笑。眼睛里没有笑意。",
    "灰衣人不是笑。表情很严肃。",
  ].join("\n");

  const { diags } = runEntityChecker(text, ["林觉"]);
  const falsePositives = diags.filter((d) => d.evidence.includes("\"不是\""));
  assert.equal(
    falsePositives.length,
    0,
    `"不是" 不应被误判（FACTGUARD-SCANNER-FIX-1 既有修复应保持）。实际诊断：${JSON.stringify(diags)}`,
  );
});
