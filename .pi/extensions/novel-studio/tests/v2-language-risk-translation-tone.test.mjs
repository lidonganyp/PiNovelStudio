/**
 * PiNovelStudio - V2 LanguageRiskLibrary 翻译腔等价覆盖回归测试
 *
 * 起源：P35 复合评分器退役决策。中文网文范式评分器的 dim1（中文自然度/翻译腔）
 * 须由 V2 owner LanguageRiskLibrary 等价覆盖，方可删除 stage8 paradigm judge /
 * hardblock 与 categorized report。
 *
 * 本测试捕获两类有价值的标定样例（从 p35-t01 与 ch17-p34 迁移）：
 *   1. 翻译腔负样例（须检出）：P34 第17章漏检句 + p35-t01 翻译腔文本
 *   2. 母语正样例（不得误判）：p35-t01 CLEAN_TEXT + ch17 干净段落
 *
 * 验收标准（等价覆盖成立的判据）：
 *   - LanguageRiskLibrary.scan() 对翻译腔负样例产出 naturalness 类 risk 条目（带 span）
 *   - 对母语正样例不产生高严重度误报（density 低 / 不含 high severity review 条目针对好文）
 *   - 每条检出条目含 riskId + span + evidence（description）—— 统一信封前置条件
 *
 * 依赖：../dist/v2/core/language-risk-library.js（需先 npm run build）
 * 本测试不依赖 stage8 / paradigm-scanner / translation-tone-local-repair。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createLanguageRiskLibrary } from "../dist/v2/core/language-risk-library.js";

// ────────────────────────────────────────────────────────────────
// 标定样例（从 p35-t01 与 ch17-p34 迁移，保留原始标定价值）
// ────────────────────────────────────────────────────────────────

/** 纯母语正样例：白描 + 短中长句节奏，无翻译腔（来自 p35-t01，不得误判） */
const CLEAN_TEXT = `林深把刀搁在膝上，没急着出手。
对面的三个人成扇形围过来，脚步压着青石板，没发出一点声响。
风穿过堂屋，把供桌上的烛火压低了一截。
"你来的比我想的快。"林深说。
中间那人没接话，刀尖垂着，像是在等什么。
林深看见他左袖口往下掉了一寸，心里有数了——袖子里藏着东西。
烛火又跳了一下。林深动了。
刀光贴着地面走，从供桌底下穿过去，直奔左边那人的脚踝。
那人跳起来，林深已经转身，刀背磕在中间那人的刀刃上，发出一声闷响。
三招过后，堂屋里只剩林深还站着。
他把刀在衣摆上擦了擦，跨过地上的尸体，推开后门。
后院空着，月光铺了一地，墙根下的草动了一下。
林深没回头，翻墙出去了。
他知道，今晚的事没完。
城里还有三个人在等他，其中一个是他的旧相识。
旧相识见面，比陌生人更危险。`;

/** 翻译腔负样例（来自 p35-t01，须检出） */
const TRANSLATION_TONE_TEXT = `当林深走进堂屋的时候，沉默笼罩了整个空间。
恐惧攫住了他的心脏，不安蔓延在空气中。
那三个人近了半步，停了半秒，眼神里藏着警惕。
与此同时，硝烟味呛进了他的鼻腔。
他意识到，这意味着对方已经准备好了。
然而，他并没有退缩。
显然，真正的危险还没有到来。
他低吼道："出来吧。"
对方咆哮道："你休想活命。"
夜色吞没了光亮，黑暗凝固在四周。
他近了半步，停了半秒，凑近了些许。
感到一阵寒意爬上脊背，他明白，这不是普通的对手。
于是他握紧了刀，准备好了。`;

/** 第17章实际漏检句（P34 用户复核结论，10 处翻译腔，须检出大多数） */
const CH17_LEAK_SENTENCES = [
  "突然，先前被压低的紧张感又顶了上来，危险像冷针一样贴住后颈。",
  "然而，表面的平静只维持了一瞬，新的冲突已经贴到眼前。",
  "一道黑影从浑水里翻上来，缠住他的腿。他惊叫一声，声音被拽断在半空——整个人被拖进深水，只剩一串气泡。",
  "水漫过船底那片黑，脚下的深绿一寸寸吞掉光。李一凡最后一个翻身入水。",
  "冷得像一巴掌拍在脸上。耳朵灌满水，闷响一层压一层，睁眼只有暗绿，三尺外全化成模糊的影。",
  "「散开！别扎堆！」他冲着水里吼，声音全糊成一团闷响，没人听得清。",
  "十成战力，这会儿一成都剩不下。这个判断落下来的一瞬，他停了半息。",
  "水面破开。阳光劈头砸下，刺得他睁不开眼。",
  "窗外的高架灯一盏接一盏往后倒，橙的、白的，切碎在玻璃上。",
  "城市的轮廓渐渐堆起来，霓虹在楼群间交错，像谁把整片光泼进了夜里。",
];

// ────────────────────────────────────────────────────────────────
// 测试
// ────────────────────────────────────────────────────────────────

describe("V2 LanguageRiskLibrary 翻译腔等价覆盖（P35 退役前置）", () => {
  // ==========================================================================
  // 验收标准 1：翻译腔负样例须检出 naturalness 类 risk 条目（带 span）
  // ==========================================================================
  describe("翻译腔负样例检出（p35-t01 + ch17-p34 标定）", () => {
    it("p35-t01 翻译腔文本：检出 ≥1 条 naturalness 类条目，且带 span", () => {
      const lib = createLanguageRiskLibrary();
      const report = lib.scan(TRANSLATION_TONE_TEXT);

      const naturalnessEntries = report.entries.filter(
        (e) => e.category === "naturalness" || e.category === "ai_pattern",
      );
      assert.ok(
        naturalnessEntries.length >= 1,
        `翻译腔文本应检出 ≥1 条条目，实际 ${naturalnessEntries.length} 条。` +
          `riskIds: ${naturalnessEntries.map((e) => e.riskId).join(",")}`,
      );

      // 每条须带 span（start/end/excerpt）—— 统一信封前置条件
      for (const e of naturalnessEntries) {
        assert.ok(
          e.span && typeof e.span.start === "number" && typeof e.span.end === "number",
          `条目 ${e.riskId} 须带 span.start/end`,
        );
      }
    });

    it("ch17 第17章漏检句：检出 ≥7/10 处翻译腔", () => {
      const lib = createLanguageRiskLibrary();
      let hitCount = 0;
      const missList = [];
      for (const sent of CH17_LEAK_SENTENCES) {
        const report = lib.scan(sent);
        const hasHit = report.entries.length > 0;
        if (hasHit) {
          hitCount++;
        } else {
          missList.push(sent.slice(0, 24));
        }
      }
      assert.ok(
        hitCount >= 7,
        `应检出 ≥7/10 漏检句，实际 ${hitCount}/10。漏检：${missList.join(" | ")}`,
      );
    });

    it("ch17 '阳光劈头砸下' 等 P34 确定性翻译腔须被检出", () => {
      const lib = createLanguageRiskLibrary();
      const p34Cases = [
        "水面破开。阳光劈头砸下，刺得他睁不开眼。",
        "他惊叫一声，声音被拽断在半空——整个人被拖进深水。",
        "橙的、白的，切碎在玻璃上。",
        "像谁把整片光泼进了夜里。",
        "冷得像一巴掌拍在脸上。",
      ];
      const misses = [];
      for (const sent of p34Cases) {
        const report = lib.scan(sent);
        if (report.entries.length === 0) misses.push(sent.slice(0, 16));
      }
      assert.ok(
        misses.length === 0,
        `P34 确定性翻译腔须全部检出，漏检：${misses.join(" | ")}`,
      );
    });
  });

  // ==========================================================================
  // 验收标准 2：母语正样例不得误判（不 false-flag 好文）
  // ==========================================================================
  describe("母语正样例不误判（p35-t01 CLEAN_TEXT）", () => {
    it("CLEAN_TEXT：不产生 review 级高严重度条目", () => {
      const lib = createLanguageRiskLibrary();
      const report = lib.scan(CLEAN_TEXT);

      const reviewEntries = report.entries.filter((e) => e.severity === "review");
      assert.ok(
        reviewEntries.length === 0,
        `母语正样例不应产生 review 级条目，实际 ${reviewEntries.length} 条：` +
          reviewEntries.map((e) => `${e.riskId}@${e.span?.start}`).join(","),
      );
    });

    it("CLEAN_TEXT：density 不触发 red 级", () => {
      const lib = createLanguageRiskLibrary();
      const report = lib.scan(CLEAN_TEXT);
      assert.notStrictEqual(
        report.level,
        "red",
        `母语正样例 riskLevel 不应为 red，实际 ${report.level}`,
      );
    });
  });

  // ==========================================================================
  // 验收标准 3：统一信封字段形状（riskId + span + evidence + confidence + suggestedScope）
  // ==========================================================================
  describe("条目字段形状符合统一信封契约", () => {
    it("翻译腔检出条目含 riskId + span + description + confidence + suggestedScope", () => {
      const lib = createLanguageRiskLibrary();
      const report = lib.scan(TRANSLATION_TONE_TEXT);
      const entry = report.entries[0];
      assert.ok(entry, "须至少一条检出条目");
      assert.ok(typeof entry.riskId === "string" && entry.riskId.length > 0, "须含 riskId");
      assert.ok(entry.span, "须含 span");
      assert.ok(
        typeof entry.description === "string" && entry.description.length > 0,
        "须含 description(evidence)",
      );
      assert.ok(
        typeof entry.confidence === "number" && entry.confidence >= 0 && entry.confidence <= 1,
        `须含 confidence∈[0,1]，实际 ${entry.confidence}`,
      );
      assert.ok(
        entry.suggestedScope === "sentence_patch" || entry.suggestedScope === "paragraph_patch",
        `须含 suggestedScope，实际 ${entry.suggestedScope}`,
      );
    });
  });
});
