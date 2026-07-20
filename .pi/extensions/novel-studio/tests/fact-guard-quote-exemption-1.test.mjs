/**
 * FACT-GUARD-QUOTE-EXEMPTION-1 — V2 FactContinuityGuard duplicate_scan
 * 规则公告/标牌/铭牌引文 + 角色有意重读复述的豁免与审计.
 *
 * 阶段：RED（核心豁免测试当前 FAIL，证明 false-positive 存在；
 * 回归保护测试当前已 PASS，确保豁免不破坏既有阻断）。
 *
 * 验收口径（对应任务卡 acceptance）：
 * 1. RED: 真实公告屏引文块 + 主角重读分析 → 应豁免（不输出 hard diagnostic），
 *    并输出 source span / recall span / matchRatio / reason 审计字段。
 * 2. RED: 标牌/铭牌引文块 + 角色对话引用 → 应豁免。
 * 3. RED: 豁免必须输出审计字段（sourceSpan / recallSpan / matchRatio / reason / quoteBlockKind）。
 * 4. 回归: 公告自身重复（同一引文块内同段文本出现 2 次）→ 仍阻断。
 * 5. 回归: 正文拼接重复（无引文块，两段 prose 重复）→ 仍阻断。
 * 6. 回归: 无来源逐字复读（伪公告，叙事 prose 中复读）→ 仍阻断。
 * 7. 回归: 三次以上复制（即便源于公告，重复 3+ 次）→ 仍阻断。
 * 8. 回归: 跨段复制（无引文块，跨段落重复）→ 仍阻断。
 * 9. 回归: 近似复述（非逐字）→ 不触发也不豁免（sliding window 逐字匹配本就不捕获）。
 *
 * 豁免边界（任务卡 acceptance）：
 * - 仅豁免"来源明确的规则公告/标牌/铭牌引文 + 后续角色有意重读或分析"的重复。
 * - 必须识别引文边界、来源和复述语境，不能仅凭类型或关键词放行。
 * - 公告自身重复、正文拼接重复、无来源逐字复读、三次以上复制仍按原规则阻断。
 *
 * 真相源：
 * - 误报根因：workspaces/fuben-clean-window-5-20260715/traces/2-blocked-candidate-evidence.json
 *   ch2 raw 5567 字完整章节被 FactGuard duplicate_scan hard block，
 *   原因是规则公告文本（"如遇停电，请保持原地不动。但第17条不受断电影响。"
 *   / "本馆最多容纳四人。超员时，最后进入者请自行离开。"）
 *   在公告屏引文块 + 主角重读分析中各出现 1 次（共 2 次）。
 * - fuben 类型 = rule_based_survival，"公告 → 主角解构规则"是核心叙事必要，
 *   非模型缺陷；FactGuard duplicate_scan 当前对叙事必要的"引文+重读"模式
 *   产生 false-positive hard block。
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

function runDuplicateScan(text) {
  const guard = createFactContinuityGuard();
  const report = guard.check({
    text,
    context: BASE_CONTEXT,
    knownCharacterNames: [],
    identityContract: null,
    ontologyContract: null,
  });
  return {
    diags: report.allDiagnostics.filter((d) => d.source === "duplicate_scan"),
    hasHardBlock: report.hasHardBlock,
    quoteExemptions: report.quoteExemptions ?? [],
  };
}

// ============================================================================
// RED 测试：核心 false-positive 复现（来自 ch2 raw）
// ============================================================================

test("FACT-GUARD-QUOTE-EXEMPTION-1 RED: 公告屏引文块 + 主角重读分析 → 应豁免（不 hard block）", () => {
  // 真实样本：ch2 raw 中公告屏规则二 + 林觉重读分析
  const text = [
    "门楣上挂着一块LED公告屏，红字滚动：",
    "",
    "> **N-002 规则公告（1/3）**",
    ">",
    "> 规则二：如遇停电，请保持原地不动。但第17条不受断电影响。",
    "",
    "林觉想起入口走廊的门禁屏：规则二说\"如遇停电，请保持原地不动。但第17条不受断电影响。\"停电时所有人不能动，但第17条不受这个限制。",
  ].join("\n");

  const { diags, hasHardBlock } = runDuplicateScan(text);
  assert.equal(
    diags.length,
    0,
    `公告屏引文 + 主角重读分析应被豁免，不应触发 duplicate_scan。实际诊断：${JSON.stringify(diags)}`,
  );
  assert.equal(
    hasHardBlock,
    false,
    "公告屏引文 + 主角重读分析豁免后不应 hard block",
  );
});

test("FACT-GUARD-QUOTE-EXEMPTION-1 RED: 标牌/铭牌引文 + 角色对话引用 → 应豁免", () => {
  // 标牌（非公告屏）+ 角色对话中复述
  const text = [
    "门口贴着一块金属标牌，上面刻着：",
    "",
    "> 标牌：本馆最多容纳四人。超员时，最后进入者请自行离开。",
    "",
    "老周看了一眼标牌，对林觉说：\"本馆最多容纳四人。超员时，最后进入者请自行离开。\"他皱起眉头。",
  ].join("\n");

  const { diags, hasHardBlock } = runDuplicateScan(text);
  assert.equal(
    diags.length,
    0,
    `标牌引文 + 角色对话复述应被豁免。实际诊断：${JSON.stringify(diags)}`,
  );
  assert.equal(hasHardBlock, false);
});

test("FACT-GUARD-QUOTE-EXEMPTION-1 RED: 豁免必须输出审计字段（sourceSpan / recallSpan / matchRatio / reason / quoteBlockKind）", () => {
  const text = [
    "> 规则二：如遇停电，请保持原地不动。但第17条不受断电影响。",
    "",
    "林觉想起门禁屏：规则二说\"如遇停电，请保持原地不动。但第17条不受断电影响。\"",
  ].join("\n");

  const { quoteExemptions } = runDuplicateScan(text);
  assert.ok(
    quoteExemptions.length >= 1,
    `应至少输出 1 条豁免审计记录。实际：${JSON.stringify(quoteExemptions)}`,
  );

  for (const ex of quoteExemptions) {
    assert.ok(ex.sourceSpan && typeof ex.sourceSpan.start === "number" && typeof ex.sourceSpan.end === "number",
      `sourceSpan 必须含 start/end 数字。实际：${JSON.stringify(ex.sourceSpan)}`);
    assert.ok(ex.recallSpan && typeof ex.recallSpan.start === "number" && typeof ex.recallSpan.end === "number",
      `recallSpan 必须含 start/end 数字。实际：${JSON.stringify(ex.recallSpan)}`);
    assert.ok(typeof ex.matchRatio === "number" && ex.matchRatio > 0 && ex.matchRatio <= 1,
      `matchRatio 必须是 (0,1] 数字。实际：${ex.matchRatio}`);
    assert.ok(typeof ex.reason === "string" && ex.reason.length > 0,
      `reason 必须是非空字符串。实际：${ex.reason}`);
    assert.ok(
      ["announcement", "signboard", "nameplate", "rule_text"].includes(ex.quoteBlockKind),
      `quoteBlockKind 必须是 announcement/signboard/nameplate/rule_text 之一。实际：${ex.quoteBlockKind}`,
    );
    // sourceSpan 必须落在引文块内（在 recallSpan 之前）
    assert.ok(ex.sourceSpan.start < ex.recallSpan.start,
      `sourceSpan 必须在 recallSpan 之前。source=${JSON.stringify(ex.sourceSpan)} recall=${JSON.stringify(ex.recallSpan)}`);
  }
});

// ============================================================================
// 回归保护测试：5 类负例仍按原规则阻断
// ============================================================================

test("FACT-GUARD-QUOTE-EXEMPTION-1 回归: 公告自身重复（同一引文块内同段规则出现 2 次）→ 仍阻断", () => {
  // 公告屏内同一段规则被错误地写了两遍——这是公告自身缺陷，不是叙事必要
  const text = [
    "> **规则公告**",
    "> 规则二：如遇停电，请保持原地不动。但第17条不受断电影响。",
    "> 规则二：如遇停电，请保持原地不动。但第17条不受断电影响。",
  ].join("\n");

  const { diags } = runDuplicateScan(text);
  assert.ok(
    diags.length >= 1,
    `公告屏内同段规则重复 2 次仍应阻断。实际诊断：${JSON.stringify(diags)}`,
  );
  assert.equal(diags[0].severity, "hard");
});

test("FACT-GUARD-QUOTE-EXEMPTION-1 回归: 正文拼接重复（无引文块，两段 prose 重复）→ 仍阻断", () => {
  // 普通叙事 prose 中 24+ 字片段重复 2 次，无引文块、无重读语境
  // 文本长度必须 ≥ 24 字符 ×2 才能被 sliding window 捕获
  const repeated = "他独自走到河边看着那缓缓流淌的河水心中涌起无限感慨久久不愿离去";
  const text = repeated + repeated;

  const { diags } = runDuplicateScan(text);
  assert.ok(
    diags.length >= 1,
    `正文拼接重复仍应阻断。实际诊断：${JSON.stringify(diags)}`,
  );
  assert.equal(diags[0].severity, "hard");
});

test("FACT-GUARD-QUOTE-EXEMPTION-1 回归: 无来源逐字复读（伪公告，无引文块格式）→ 仍阻断", () => {
  // 散文中两次"念公告 + 长文本"但格式不像真引文块（无 > 前缀，无引号包裹，无"规则N："结构标记），
  // 这不是"公告+重读"模式，是叙事复读污染；豁免逻辑不得仅凭"公告"关键词放行
  const repeated = "如遇停电时请保持原地不动但第十七条完全不受断电影响";
  const text = `他念公告${repeated}然后又念公告${repeated}最后沉默了。`;

  const { diags } = runDuplicateScan(text);
  assert.ok(
    diags.length >= 1,
    `伪公告无引文块格式的复读仍应阻断。实际诊断：${JSON.stringify(diags)}`,
  );
  assert.equal(diags[0].severity, "hard");
});

test("FACT-GUARD-QUOTE-EXEMPTION-1 回归: 三次以上复制（即便源于公告，重复 3+ 次）→ 仍阻断", () => {
  // 公告引文块 + 主角重读 + 第三人再念 = 3 次复制，超出"引文+重读"叙事必要边界
  const text = [
    "> 规则二：如遇停电，请保持原地不动。但第17条不受断电影响。",
    "",
    "林觉想起：\"如遇停电，请保持原地不动。但第17条不受断电影响。\"",
    "",
    "老周也念了一遍：\"如遇停电，请保持原地不动。但第17条不受断电影响。\"",
  ].join("\n");

  const { diags } = runDuplicateScan(text);
  assert.ok(
    diags.length >= 1,
    `三次以上复制即便源于公告仍应阻断。实际诊断：${JSON.stringify(diags)}`,
  );
  assert.equal(diags[0].severity, "hard");
});

test("FACT-GUARD-QUOTE-EXEMPTION-1 回归: 跨段复制（无引文块，跨段落重复）→ 仍阻断", () => {
  // 跨段落重复 24+ 字片段，无引文块、无重读语境
  // 文本长度必须 ≥ 24 字符 ×2 才能被 sliding window 跨段捕获
  const repeated = "他独自走到河边看着那缓缓流淌的河水心中涌起无限感慨久久不愿离去";
  const text = repeated + "\n\n" + repeated;

  const { diags } = runDuplicateScan(text);
  assert.ok(
    diags.length >= 1,
    `跨段复制仍应阻断。实际诊断：${JSON.stringify(diags)}`,
  );
  assert.equal(diags[0].severity, "hard");
});

test("FACT-GUARD-QUOTE-EXEMPTION-1 回归: 近似复述（非逐字）→ 不触发也不豁免", () => {
  // 24+ 字片段非逐字近似复述：sliding window 逐字匹配本就不捕获，
  // 但豁免逻辑也不应错误地把它当作"公告"豁免其他真实重复
  const text = "他念公告如遇停电请保持原地不动但第十七条不受断电影响然后又念公告如遇停电时请保持原地静止但第十七条不受断电影响最后沉默了。";

  const { diags, quoteExemptions } = runDuplicateScan(text);
  assert.equal(
    diags.length,
    0,
    `非逐字近似复述不应触发 duplicate_scan（sliding window 逐字匹配）。实际诊断：${JSON.stringify(diags)}`,
  );
  assert.equal(
    quoteExemptions.length,
    0,
    `非逐字近似复述不应被错误豁免。实际豁免：${JSON.stringify(quoteExemptions)}`,
  );
});

// ============================================================================
// 现有最简单重复仍触发（baseline 回归保护）
// ============================================================================

test("FACT-GUARD-QUOTE-EXEMPTION-1 回归: 现有最简单大段重复（无任何引文/重读语境）→ 仍 hard block", () => {
  // 既有测试 baseline：纯重复文本必须继续触发，确保新豁免逻辑不破坏既有阻断
  const text = "这是一段重复的文本内容用于测试大段重复污染检测能力".repeat(3);

  const { diags, hasHardBlock } = runDuplicateScan(text);
  assert.ok(diags.length >= 1, "纯重复文本仍应触发 duplicate_scan");
  assert.equal(diags[0].severity, "hard");
  assert.equal(hasHardBlock, true);
});
