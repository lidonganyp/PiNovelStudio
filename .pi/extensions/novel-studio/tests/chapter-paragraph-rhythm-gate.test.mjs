/**
 * PiNovelStudio — chapter-paragraph-rhythm-gate 单元测试（P26 Doubao 适配）
 *
 * 验证：
 *   - analyzeChapterParagraphRhythm：分段统计 over220/over280/over360 计数正确
 *   - repairLongParagraphsLocal：对 over360 段在句末标点分段、非破坏性
 *   - recheckAfterLocalRepair：修复后 over360Count 归零
 *   - 常量值：PARAGRAPH_HARD_LIMIT=360 / SOFT=280 / ACTION_SOFT=220
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  analyzeChapterParagraphRhythm,
  repairLongParagraphsLocal,
  recheckAfterLocalRepair,
  PARAGRAPH_HARD_LIMIT,
  PARAGRAPH_SOFT_LIMIT,
  PARAGRAPH_ACTION_SOFT_LIMIT,
} from "../dist/craft/chapter-paragraph-rhythm-gate.js";

// 构造 N 段、每段 M 字的文本（句末用句号便于 repair 切句）
function makeParagraphs(count, charsPerPara) {
  const paras = [];
  for (let i = 0; i < count; i++) {
    const sentenceCount = Math.ceil(charsPerPara / 30);
    const parts = [];
    for (let s = 0; s < sentenceCount; s++) {
      parts.push("他推开沉重的铁门走进昏暗的走廊。");
    }
    paras.push(parts.join(""));
  }
  return paras.join("\n");
}

describe("chapter-paragraph-rhythm-gate 常量", () => {
  it("硬/软/动作软上限阈值正确", () => {
    assert.equal(PARAGRAPH_HARD_LIMIT, 360);
    assert.equal(PARAGRAPH_SOFT_LIMIT, 280);
    assert.equal(PARAGRAPH_ACTION_SOFT_LIMIT, 220);
  });
});

describe("analyzeChapterParagraphRhythm", () => {
  it("正常多段（均 < 220）→ passed=true, 各 over 计数为 0", () => {
    const text = "他推开门。\n风灌进来。\n灯忽明忽暗。";
    const r = analyzeChapterParagraphRhythm(text);
    assert.equal(r.paragraphCount, 3);
    assert.equal(r.over220Count, 0);
    assert.equal(r.over280Count, 0);
    assert.equal(r.over360Count, 0);
    assert.equal(r.passed, true);
    assert.deepEqual(r.blockedParagraphIndexes, []);
    assert.ok(r.maxParagraphLength < 220);
  });

  it("单段超 360 → over360Count=1, passed=false, blockedParagraphIndexes=[0]", () => {
    // 基础句 16 字，repeat(25) = 400 字单段（> 360）
    const text = "他推开沉重的铁门走进昏暗的走廊。".repeat(25);
    const r = analyzeChapterParagraphRhythm(text);
    assert.equal(r.paragraphCount, 1);
    assert.equal(r.over360Count, 1);
    assert.equal(r.passed, false);
    assert.deepEqual(r.blockedParagraphIndexes, [0]);
    assert.ok(r.maxParagraphLength > 360);
  });

  it("5 个 774 字单段 → over360Count=5, blockedParagraphIndexes=[0,1,2,3,4]", () => {
    const text = makeParagraphs(5, 774);
    const r = analyzeChapterParagraphRhythm(text);
    assert.equal(r.paragraphCount, 5);
    assert.equal(r.over360Count, 5);
    assert.equal(r.passed, false);
    assert.deepEqual(r.blockedParagraphIndexes, [0, 1, 2, 3, 4]);
    assert.ok(r.maxParagraphLength > 360);
  });

  it("中等段落超 220 但未超 280 → over220Count>0, over280Count=0, over360Count=0, passed=true", () => {
    // 基础句 16 字，repeat(15) = 240 字单段（> 220, < 280）
    const text = "他推开沉重的铁门走进昏暗的走廊。".repeat(15);
    const r = analyzeChapterParagraphRhythm(text);
    assert.equal(r.paragraphCount, 1);
    assert.ok(r.over220Count >= 1);
    assert.equal(r.over280Count, 0);
    assert.equal(r.over360Count, 0);
    assert.equal(r.passed, true);
  });

  it("空文本 → paragraphCount=0, passed=true", () => {
    const r = analyzeChapterParagraphRhythm("");
    assert.equal(r.paragraphCount, 0);
    assert.equal(r.over360Count, 0);
    assert.equal(r.passed, true);
    assert.equal(r.averageParagraphLength, 0);
  });

  it("averageParagraphLength 正确计算（去空白后字符均值）", () => {
    const text = "他推开门。\n风灌进来。";
    const r = analyzeChapterParagraphRhythm(text);
    assert.equal(r.paragraphCount, 2);
    // 每段 5 字（去空白），均值 5
    assert.equal(r.averageParagraphLength, 5);
  });

  it("repairSuggestion 含 over360 失败说明", () => {
    const text = "他推开沉重的铁门走进昏暗的走廊。".repeat(25);
    const r = analyzeChapterParagraphRhythm(text);
    assert.ok(r.repairSuggestion.includes("段落节奏硬门禁失败"));
    assert.ok(r.repairSuggestion.includes("360"));
  });
});

describe("repairLongParagraphsLocal", () => {
  it("对 over360 段在句末标点分段 → repairedCount 正确，recheck over360Count=0", () => {
    const text = makeParagraphs(3, 774);
    const analysis = analyzeChapterParagraphRhythm(text);
    assert.equal(analysis.over360Count, 3);

    const repair = repairLongParagraphsLocal(text, analysis);
    assert.equal(repair.repairedCount, 3);

    const recheck = recheckAfterLocalRepair(repair.repairedText);
    assert.equal(recheck.over360Count, 0);
    assert.equal(recheck.passed, true);
  });

  it("非破坏性：repair 前后非空白字符总数不变", () => {
    const text = makeParagraphs(2, 500);
    const beforeNonWhitespace = text.replace(/\s/g, "").length;
    const repair = repairLongParagraphsLocal(text);
    const afterNonWhitespace = repair.repairedText.replace(/\s/g, "").length;
    assert.equal(afterNonWhitespace, beforeNonWhitespace, "repair 不应删减文字内容");
  });

  it("无 over360 段时返回原文且 repairedCount=0", () => {
    const text = "他推开门。\n风灌进来。\n灯亮了。";
    const repair = repairLongParagraphsLocal(text);
    assert.equal(repair.repairedCount, 0);
    assert.equal(repair.repairedText, text);
  });

  it("无法切句的极端段（无句末标点）保留原段", () => {
    // 单个无标点长串
    const longNoPunct = "推门".repeat(200); // 400 字无标点
    const text = longNoPunct;
    const repair = repairLongParagraphsLocal(text);
    // 无法切句，保留原段
    assert.ok(repair.repairedText.includes(longNoPunct));
  });

  it("repair 后每段不超过 REPAIR_HARD_CAP=220（可切句的情况下）", () => {
    const text = makeParagraphs(2, 774);
    const repair = repairLongParagraphsLocal(text);
    const recheck = recheckAfterLocalRepair(repair.repairedText);
    // 修复后所有段都应 <= 360（实际上目标 <= 220，但硬保证 <= 360）
    for (const para of recheck.paragraphs) {
      const len = para.replace(/\s/g, "").length;
      assert.ok(len <= 360, `修复后仍有段超 360：len=${len}`);
    }
  });
});
