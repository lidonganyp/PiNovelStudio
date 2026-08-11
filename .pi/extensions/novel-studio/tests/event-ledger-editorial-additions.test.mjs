/**
 * P0-2 RED — editorial 引入新事件应被识别为替换事件
 *
 * 审计断言：drift editorial 虽被判定 preserved=false，但 replacedEvents 为空。
 * editorial-story-preservation-gate.test.mjs:204 失败（期望 replacedEvents >= 1）。
 *
 * 根因（已代码核实）：event-ledger-comparator.ts 的 forward pass 只迭代
 * rawExtractable，editorialExtractable 中未被 matchedEditorialIds 标记的事件
 * （即 editorial 引入的新事件）完全漏检。
 *
 * 本测试用最小夹具锁定该失败断言，GREEN 后 comparator 新增 editorial-only
 * 事件反向检测，replacedEvents 应包含 editorial 引入的新故事事件。
 *
 * 夹具设计说明：
 * - editorial 事件必须能被 event-extractor 抽取为 extractable=true 的事件
 *   （即句子含 ACTION_VERBS 表中的动词，如"走出来"/"离开"/"进入"等）
 * - editorial 事件的 subject/entities 必须含已知实体且该实体不在 rawText 中
 *   （这样才会触发 editorial-only 反向检测）
 * - 不能用"逆推"/"翻涌"/"丈量"等不在 ACTION_VERBS 表中的词（不会被抽取为事件）
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  checkEditorialStoryPreservation,
} from "../dist/v2/core/editorial-story-preservation-gate.js";

// ============================================================================
// 用例 1：最小夹具 — editorial 引入 raw 中不存在的实体事件
// ============================================================================

test("P0-2 RED: editorial 引入 raw 中不存在的实体事件 → replacedEvents >= 1", () => {
  const rawText = "祝明朗走到梦堂。长乘神像空缺。黑色雾气渗出。";
  const editorialText = "祝明朗走到梦堂。洪摩走出来。";
  const knownEntities = [
    "祝明朗", "梦堂", "长乘", "黑色雾气", "洪摩",
  ];

  const report = checkEditorialStoryPreservation({
    rawText,
    editorialText,
    knownEntities,
    entityCoverage: "full_entities",
  });

  // 前置：preserved 必须为 false（editorial 引入了 raw 不存在的故事线）
  assert.equal(
    report.preserved,
    false,
    "editorial 引入洪摩走出来事件，必须判定 preserved=false",
  );

  // 核心断言：replacedEvents 必须识别出 editorial 引入的新事件
  assert.ok(
    Array.isArray(report.replacedEvents),
    "replacedEvents 必须是数组",
  );
  assert.ok(
    report.replacedEvents.length >= 1,
    `replacedEvents 至少 1 个（editorial 新增的洪摩走出来），实际 ${report.replacedEvents.length}`,
  );

  // 至少一个 replacedEvent 的 editorialSentence 包含 "洪摩"
  const hasExpectedEntity = report.replacedEvents.some(
    (e) => (e.editorialSentence || "").includes("洪摩"),
  );
  assert.ok(
    hasExpectedEntity,
    "replacedEvents 中至少一个的 editorialSentence 必须包含洪摩",
  );
});

// ============================================================================
// 用例 2：复用现有夹具 — DRIFTED_EDITORIAL 的洪摩走出来/离开（用 ACTION_VERBS 中的词）
// ============================================================================

test("P0-2 RED: DRIFTED_EDITORIAL 新增洪摩走出来/离开 → replacedEvents >= 1", () => {
  // 与 editorial-story-preservation-gate.test.mjs 相同的夹具（简化版）
  const rawText = `第1106章 梦堂缺席者

祝明朗走到长乘的神像前。神像朦胧，几乎快要消散了。他伸出手，指尖触碰长乘的神像。一股寒意顺着指尖传来。指尖上竟然沾了一层薄薄的黑色雾气。

采悠脸色微变："吾神，您说的该不会是……蚀神瘴？"

祝明朗回到玉衡星宫。玉衡星女神指着星图标注处——禁星渊。"前任玉衡星神，就是在探查禁星渊时陨落的。"`;

  const editorialText = `第1106章 暗潮涌动

洪摩走出来。祝明朗立刻运转神力，将那道残余的印记彻底碾碎。

脚下的灵脉水道忽然无端翻涌了一下。那涟漪从桥下朝两侧扩散，沿着灵脉水道一路蔓延向仙城深处。

洪摩离开。他在丈量玉衡星宫的防线。`;

  const knownEntities = [
    "祝明朗", "洪逸", "长隍", "长乘", "采悠", "玉衡星女神", "洪摩",
    "梦堂", "玉衡星宫", "禁星渊", "蚀神瘴", "黑色雾气", "灵脉水道",
  ];

  const report = checkEditorialStoryPreservation({
    rawText,
    editorialText,
    knownEntities,
    entityCoverage: "full_entities",
  });

  // 前置：preserved 必须为 false
  assert.equal(
    report.preserved,
    false,
    "editorial 删除 raw 主线并新增洪摩走出来/离开，必须判定 preserved=false",
  );

  // 核心断言：replacedEvents 至少 1 个
  assert.ok(
    Array.isArray(report.replacedEvents),
    "replacedEvents 必须是数组",
  );
  assert.ok(
    report.replacedEvents.length >= 1,
    `replacedEvents 至少 1 个（洪摩走出来/离开），实际 ${report.replacedEvents.length}`,
  );
});

// ============================================================================
// 用例 3：防误报 — 同组实体做不同事不应因新规则误报
// ============================================================================

test("P0-2 防误报: 同组已知实体做不同事，replacedEvents 由现有动作替换规则识别", () => {
  const rawText = "祝明朗攻击林默。";
  const editorialText = "祝明朗防御林默。";
  const knownEntities = ["祝明朗", "林默"];

  const report = checkEditorialStoryPreservation({
    rawText,
    editorialText,
    knownEntities,
    entityCoverage: "full_entities",
  });

  // editorial 中祝明朗和林默都在 raw 中出现，不应触发 editorial-only 检测
  // 但可能被现有动作替换规则识别（攻击→防御是动作替换）
  // 关键：不应因为"防御"是 raw 中没有的动作就误报为 editorial-only 新事件
  // （现有规则识别为 replacedEvents 是正确行为，不是误报）

  // 如果触发了 replacedEvents，原因应该是"动作替换"而非"editorial-only 新事件"
  for (const e of report.replacedEvents || []) {
    // editorial-only 事件的 rawEventId 为空字符串，rawSentence 为空
    // 这里验证：同组实体的动作替换不应被标记为 editorial-only
    if (e.rawEventId === "" && e.rawSentence === "") {
      // 如果是 editorial-only 类型，说明误报了（因为祝明朗和林默都在 raw 中）
      assert.fail(
        `同组实体（祝明朗/林默都在 raw 中）不应被标记为 editorial-only 事件：${JSON.stringify(e).slice(0, 300)}`,
      );
    }
  }
});

// ============================================================================
// 用例 4：真实长程 replay 误杀治理 — 共享引语的同义改写不构成事件替换
// ============================================================================

test("回归：共享同一段引语的引导语改写不判为事件替换（preserved=true）", () => {
  // ch2 真实样本抽取：raw 与 editorial 承载同一句对白"这位姑娘说笑了"，
  // 仅引导语被风格改写（"装出一副茫然的样子苦笑道" → "苦笑着摇了摇头说道"）。
  const rawText = "叶尘装出一副茫然的样子苦笑道：“这位姑娘说笑了……”";
  const editorialText = "叶尘苦笑着摇了摇头说道：“这位姑娘说笑了……”";
  const knownEntities = ["叶尘"];

  const report = checkEditorialStoryPreservation({
    rawText,
    editorialText,
    knownEntities,
    entityCoverage: "full_entities",
  });

  // 同一言语事件、仅引导语改写，不应判定为故事骨架漂移
  assert.equal(
    report.preserved,
    true,
    `共享同一段引语的对白改写应通过 story preservation。实际: ${JSON.stringify(report).slice(0, 400)}`,
  );
});

// ============================================================================
// 用例 5：真实长程 replay 误杀治理 — 同义抓握动作改写不构成事件替换
// ============================================================================

test("回归：\"拉住\"→\"死死拽住\"同义改写不判为关键动作替换（preserved=true）", () => {
  // ch7 真实样本：raw"一把拉住叶尘的衣袖" → editorial"一把死死拽住叶尘的衣袖"。
  // "拉住"是关键动作，"拽住"属同义抓握族，风格改写不应触发"动作→非动作"关键替换。
  const rawText = "苏影一把拉住叶尘的衣袖低喝道：“停下！”";
  const editorialText = "苏影一把死死拽住叶尘的衣袖，沉声道：“停下！”";
  const knownEntities = ["苏影", "叶尘"];

  const report = checkEditorialStoryPreservation({
    rawText,
    editorialText,
    knownEntities,
    entityCoverage: "full_entities",
  });

  // 同义抓握动作改写，应通过 story preservation
  assert.equal(
    report.preserved,
    true,
    `\"拉住\"→\"拽住\"同义改写应通过 story preservation。实际: ${JSON.stringify(report).slice(0, 400)}`,
  );
});
