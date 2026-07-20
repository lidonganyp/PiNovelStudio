/**
 * PiNovelStudio - V2 LanguageRiskLibrary 平淡叙事 span 证据等价覆盖测试
 *
 * 起源：P35 复合评分器退役决策。dim9（平淡叙事/流水账）的 span 诊断能力须由
 * V2 owner 等价覆盖，方可删除 flat-narration-scanner 的复合评分形态与 stage8 接线。
 *
 * 迁移规则（用户指令）：
 *   - 只补迁尚未覆盖且有真实价值的 span 证据
 *   - 统一输出 riskId + span + evidence + confidence + suggestedScope
 *   - 作为 editorial opportunity / pairwise judge 参考，不决定 winner，不 hard block
 *   - 复合评分（score/verdict）形态退役，只保留 span issues
 *
 * 标定样例从 p41-t02-flat-narration-scanner.test.mjs 迁移，保留原始标定价值：
 *   - MEASUREMENT_RELATIONSHIP_TEXT：测量式关系描写（须检出 measurement_relationship）
 *   - CH17_OPENING_FLAT_TEXT：动作罗列 + 过门段过长（须检出 action_list / overlong_bridge）
 *   - CLEAN_BAIDMIAO_TEXT：白描正样例（不得误判）
 *
 * 依赖：../dist/v2/core/language-risk-library.js（需先 npm run build）
 * 本测试不依赖 stage8 / paradigm-scanner / flat-narration 复合评分。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createLanguageRiskLibrary } from "../dist/v2/core/language-risk-library.js";

// flat-narration 7 类 issue type（须作为 riskId 出现）
const FLAT_NARRATION_RISK_IDS = [
  "action_list",
  "nonfunctional_detail",
  "overlong_bridge",
  "summary_exposition",
  "weak_scene_focus",
  "measurement_relationship",
  "payoff_underwritten",
];

// ────────────────────────────────────────────────────────────────
// 标定样例（从 p41-t02 迁移）
// ────────────────────────────────────────────────────────────────

/** 测量式关系描写（须检出 measurement_relationship） */
const MEASUREMENT_RELATIONSHIP_TEXT = `
林衡走过来，她没像往常那样退后半步。
他注意到她说话比往常短了半截，肩膀离他比平时近半寸。
两人之间的距离比平时近了小半臂，那种微妙的张力让人不安。
她比平时远了半步，又比平时近了半寸，反复调整位置。
`.trim();

/** ch17 开头集结/赶路流水账（连续动作罗列 + 过门段过长） */
const CH17_OPENING_FLAT_TEXT = `
各队陆续到达北城门，林衡起身转身整理衣甲，许棠回头检查装备配置，赵勤走上前低头确认站位分布。

林衡抬头看了一眼天色，低头整理腰带，转身走向营门，回头清点人数，迈步进入通道，推开门走进集结场地。

各小队沿通道一路前行，走过长廊穿过庭院到达集合点，途中经过多处陈设布置，沿线分布着各类守卫配置，通道布局方位严格按照规制设计，整条路线在不同时辰呈现不同人流分布，营门外的环境氛围也在不同天气下呈现不同光线变化，整个集结过程延续了很久。沿途陈设琳琅满目，廊柱雕花细致，门楣上悬挂的灯笼随风轻摆，地面石砖纹路古朴，墙角摆着铜缸铜盆，院中种植着花草树木，远处可见楼阁飞檐，近处可见石狮镇守，整个布局方位严格按照规制设计，处处透着肃穆庄重，沿线守卫分布配置周全。

林衡坐下，许棠站起，赵勤转身。
`.trim();

/** 白描正样例（含功能 delta，不得误判） */
const CLEAN_BAIDMIAO_TEXT = `
林衡推开门，桌上摆着那封未署名的信。
他展开信纸，三行字映入眼帘--这是他要找的线索。
"明天子时，老地方。"信末没有落款，但那道压痕他认得。
把信折好塞进袖中，他转身出了门。这一次，他必须做出选择。
`.trim();

// ────────────────────────────────────────────────────────────────
// 测试
// ────────────────────────────────────────────────────────────────

describe("V2 LanguageRiskLibrary 平淡叙事 span 证据（dim9 等价覆盖）", () => {
  // ==========================================================================
  // 验收标准 1：流水账负样例须检出 flat-narration 类 span 条目
  // ==========================================================================
  describe("流水账负样例检出（p41-t02 标定）", () => {
    it("测量式关系描写：检出 measurement_relationship 条目且带 span", () => {
      const lib = createLanguageRiskLibrary();
      const report = lib.scan(MEASUREMENT_RELATIONSHIP_TEXT);

      const measurementHits = report.entries.filter(
        (e) => e.riskId === "measurement_relationship",
      );
      assert.ok(
        measurementHits.length >= 1,
        `应检出 ≥1 条 measurement_relationship，实际 ${measurementHits.length} 条。` +
          `riskIds: ${report.entries.map((e) => e.riskId).join(",")}`,
      );
      for (const e of measurementHits) {
        assert.ok(
          e.span && typeof e.span.start === "number" && typeof e.span.end === "number",
          `measurement_relationship 条目须带 span.start/end`,
        );
      }
    });

    it("ch17 集结流水账：检出 flat-narration 类条目（action_list/overlong_bridge 等）", () => {
      const lib = createLanguageRiskLibrary();
      const report = lib.scan(CH17_OPENING_FLAT_TEXT);

      const flatHits = report.entries.filter((e) =>
        FLAT_NARRATION_RISK_IDS.includes(e.riskId),
      );
      assert.ok(
        flatHits.length >= 1,
        `应检出 ≥1 条 flat-narration 类条目，实际 ${flatHits.length} 条。` +
          `riskIds: ${report.entries.map((e) => e.riskId).join(",")}`,
      );
      // 每条须带 span
      for (const e of flatHits) {
        assert.ok(
          e.span && typeof e.span.start === "number",
          `flat-narration 条目 ${e.riskId} 须带 span.start`,
        );
      }
    });
  });

  // ==========================================================================
  // 验收标准 2：白描正样例不得误判（不 false-flag 好文）
  // ==========================================================================
  describe("白描正样例不误判（p41-t02 CLEAN_BAIDMIAO）", () => {
    it("CLEAN_BAIDMIAO：不产生 review/critical 级 flat-narration 条目", () => {
      const lib = createLanguageRiskLibrary();
      const report = lib.scan(CLEAN_BAIDMIAO_TEXT);

      const reviewFlatHits = report.entries.filter(
        (e) =>
          FLAT_NARRATION_RISK_IDS.includes(e.riskId) &&
          e.severity === "review",
      );
      assert.ok(
        reviewFlatHits.length === 0,
        `白描正样例不应产生 review 级 flat-narration 条目，实际 ${reviewFlatHits.length} 条：` +
          reviewFlatHits.map((e) => e.riskId).join(","),
      );
    });
  });

  // ==========================================================================
  // 验收标准 3：统一信封字段形状（riskId + span + evidence + confidence + suggestedScope）
  // ==========================================================================
  describe("条目字段形状符合统一信封契约", () => {
    it("flat-narration 检出条目含 riskId + span + description + confidence + suggestedScope", () => {
      const lib = createLanguageRiskLibrary();
      const report = lib.scan(MEASUREMENT_RELATIONSHIP_TEXT);
      const flatEntry = report.entries.find((e) =>
        FLAT_NARRATION_RISK_IDS.includes(e.riskId),
      );
      assert.ok(flatEntry, "须至少一条 flat-narration 检出条目");
      assert.ok(
        typeof flatEntry.riskId === "string" && flatEntry.riskId.length > 0,
        "须含 riskId",
      );
      assert.ok(flatEntry.span, "须含 span");
      assert.ok(
        typeof flatEntry.description === "string" && flatEntry.description.length > 0,
        "须含 description(evidence)",
      );
      assert.ok(
        typeof flatEntry.confidence === "number" &&
          flatEntry.confidence >= 0 &&
          flatEntry.confidence <= 1,
        `须含 confidence∈[0,1]，实际 ${flatEntry.confidence}`,
      );
      assert.ok(
        flatEntry.suggestedScope === "sentence_patch" ||
          flatEntry.suggestedScope === "paragraph_patch",
        `须含 suggestedScope，实际 ${flatEntry.suggestedScope}`,
      );
    });

    it("段落级 flat-narration（action_list 等）suggestedScope=paragraph_patch", () => {
      const lib = createLanguageRiskLibrary();
      const report = lib.scan(CH17_OPENING_FLAT_TEXT);
      const paragraphScopeEntry = report.entries.find(
        (e) => e.suggestedScope === "paragraph_patch",
      );
      assert.ok(
        paragraphScopeEntry,
        "ch17 流水账应至少有一条 suggestedScope=paragraph_patch 的条目",
      );
    });
  });
});
