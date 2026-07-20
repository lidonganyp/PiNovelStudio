/**
 * NB-1R 章节切分校准单元测试
 *
 * 测试覆盖：
 * - splitter 与 ground-truth 完全一致 → 全部 correct，high_confidence
 * - ground-truth 含「回」单位（splitter 无）→ missing_heading（FN）
 * - splitter 产生 spurious heading → false_positive（FP）
 * - < 2 heading → rejected
 * - 序章/番外/终章 特殊类型
 * - offset_mismatch 标注
 * - aggregateCalibrationStats 聚合
 * - 标注不含正文
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  calibrateChapterSplitting,
  aggregateCalibrationStats,
} from "../dist-eval/novelbench/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// 测试用文本构造器
// ─────────────────────────────────────────────────────────────────────────────

function buildBook(chapters) {
  return chapters
    .map((c) => `${c.heading}\n${c.body ?? ""}`)
    .join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────

describe("NB-1R calibrateChapterSplitting", () => {
  test("splitter 与 ground-truth 完全一致 → 全部 correct，high_confidence", () => {
    const text = buildBook([
      { heading: "第1章 开端", body: "这是一段足够长的正文内容用于通过短章检测。".repeat(20) },
      { heading: "第2章 发展", body: "这是第二章的正文内容用于通过短章检测。".repeat(20) },
      { heading: "第3章 高潮", body: "这是第三章的正文内容用于通过短章检测。".repeat(20) },
    ]);

    const result = calibrateChapterSplitting({
      bookId: "test-perfect",
      title: "完美匹配",
      genre: "玄幻",
      decodedText: text,
    });

    assert.equal(result.verdict, "high_confidence");
    assert.equal(result.groundTruthCount, 3);
    assert.equal(result.splitterCount, 3);
    assert.equal(result.truePositive, 3);
    assert.equal(result.falsePositive, 0);
    assert.equal(result.falseNegative, 0);
    assert.equal(result.precision, 1);
    assert.equal(result.recall, 1);
    assert.equal(result.annotations.length, 3);
    for (const a of result.annotations) {
      assert.equal(a.label, "correct");
      assert.equal(a.errorCategory, undefined);
      assert.equal(a.annotator, "nb-1r-programmatic-v1");
    }
  });

  test("ground-truth 含「回」单位（splitter 无）→ missing_heading（FN）", () => {
    // 第N回 是武侠/历史经典单位，splitter 不识别，ground-truth 识别
    const text = buildBook([
      { heading: "第1回 楔子", body: "这是第一回的正文内容用于通过短章检测。".repeat(20) },
      { heading: "第2回 风起", body: "这是第二回的正文内容用于通过短章检测。".repeat(20) },
      { heading: "第3回 云涌", body: "这是第三回的正文内容用于通过短章检测。".repeat(20) },
    ]);

    const result = calibrateChapterSplitting({
      bookId: "test-hui",
      title: "章回体",
      genre: "武侠",
      decodedText: text,
    });

    // splitter 不识别「回」→ rejected（< 2 heading）
    assert.equal(result.verdict, "rejected");
    assert.equal(result.rejectionReason, "no_reliable_headings");
    // ground-truth 找到 3 个「回」heading，全部标为 missing
    assert.equal(result.groundTruthCount, 3);
    assert.equal(result.falseNegative, 3);
    assert.equal(result.annotations.length, 3);
    for (const a of result.annotations) {
      assert.equal(a.label, "missing");
      assert.equal(a.errorCategory, "rejected_no_headings");
    }
  });

  test("< 2 heading → rejected，ground-truth 全部 missing", () => {
    const text = buildBook([
      { heading: "第1章 唯一", body: "这是唯一一章的正文。".repeat(20) },
    ]);

    const result = calibrateChapterSplitting({
      bookId: "test-single",
      title: "单章书",
      genre: "玄幻",
      decodedText: text,
    });

    assert.equal(result.verdict, "rejected");
    assert.equal(result.rejectionReason, "no_reliable_headings");
    assert.equal(result.groundTruthCount, 1);
    assert.equal(result.splitterCount, 0);
    assert.equal(result.falseNegative, 1);
    assert.equal(result.annotations.length, 1);
    assert.equal(result.annotations[0].label, "missing");
    assert.equal(result.annotations[0].errorCategory, "rejected_no_headings");
  });

  test("序章 + 正文章节 → ground-truth 与 splitter 均识别序章", () => {
    const text = buildBook([
      { heading: "序章", body: "这是序章的正文内容用于通过短章检测。".repeat(20) },
      { heading: "第1章 开始", body: "这是第一章的正文内容用于通过短章检测。".repeat(20) },
      { heading: "第2章 继续", body: "这是第二章的正文内容用于通过短章检测。".repeat(20) },
    ]);

    const result = calibrateChapterSplitting({
      bookId: "test-prologue",
      title: "有序章",
      genre: "玄幻",
      decodedText: text,
    });

    // 序章 + 2 正文章 = 3 个 heading，splitter 应识别全部
    assert.equal(result.groundTruthCount, 3);
    assert.equal(result.splitterCount, 3);
    assert.equal(result.truePositive, 3);
    assert.equal(result.verdict, "high_confidence");
  });

  test("番外 + 终章 特殊类型 → 两者均识别", () => {
    const text = buildBook([
      { heading: "第1章 主体", body: "这是第一章的正文内容用于通过短章检测。".repeat(20) },
      { heading: "第2章 发展", body: "这是第二章的正文内容用于通过短章检测。".repeat(20) },
      { heading: "终章", body: "这是终章的正文内容用于通过短章检测。".repeat(20) },
      { heading: "番外 彩蛋", body: "这是番外的正文内容用于通过短章检测。".repeat(20) },
    ]);

    const result = calibrateChapterSplitting({
      bookId: "test-special",
      title: "特殊章",
      genre: "玄幻",
      decodedText: text,
    });

    assert.equal(result.groundTruthCount, 4);
    assert.equal(result.splitterCount, 4);
    assert.equal(result.truePositive, 4);
    assert.equal(result.verdict, "high_confidence");
  });

  test("ground-truth 识别更多特殊类型（前言/引子/后记）→ splitter 漏识别 → missing", () => {
    const text = buildBook([
      { heading: "前言", body: "这是前言的正文内容用于通过短章检测。".repeat(20) },
      { heading: "第1章 主体", body: "这是第一章的正文内容用于通过短章检测。".repeat(20) },
      { heading: "第2章 发展", body: "这是第二章的正文内容用于通过短章检测。".repeat(20) },
      { heading: "后记", body: "这是后记的正文内容用于通过短章检测。".repeat(20) },
    ]);

    const result = calibrateChapterSplitting({
      bookId: "test-extra-special",
      title: "扩展特殊章",
      genre: "历史",
      decodedText: text,
    });

    // splitter 识别 第1章/第2章（2 个），ground-truth 识别全部 4 个
    // 前言/后记 是 splitter 没有的特殊类型 → missing
    assert.ok(result.groundTruthCount >= 4, `gt=${result.groundTruthCount}`);
    // splitter 至少识别 2 个正文章节
    assert.ok(result.splitterCount >= 2, `splitter=${result.splitterCount}`);
    // 应有 missing 标注（前言/后记）
    const missing = result.annotations.filter((a) => a.label === "missing");
    assert.ok(missing.length >= 1, `missing=${missing.length}`);
    for (const m of missing) {
      assert.equal(m.errorCategory, "missing_heading");
    }
  });

  test("标注不含正文（仅 offset + heading + 标签）", () => {
    const text = buildBook([
      { heading: "第1章 测试", body: "SECRET_BODY_CONTENT_1".repeat(20) },
      { heading: "第2章 验证", body: "SECRET_BODY_CONTENT_2".repeat(20) },
    ]);

    const result = calibrateChapterSplitting({
      bookId: "test-no-leak",
      title: "无正文泄漏",
      genre: "玄幻",
      decodedText: text,
    });

    const json = JSON.stringify(result);
    assert.ok(!json.includes("SECRET_BODY_CONTENT"), "标注中不得包含正文");
  });

  test("heading 与 body 同行时截断 heading，防止正文泄漏", () => {
    // 模拟源语料中 heading 与 body 同行（无换行）的情况
    // splitter 的 regex 会捕获整行作为 heading
    const longBody = "宇澈脸上挂著从容的微笑但实则被自己吓到了他从来没感受过那么快的速度".repeat(5);
    const text = `第1章 开端${longBody}\n第2章 结尾${longBody}\n`;

    const result = calibrateChapterSplitting({
      bookId: "test-truncate",
      title: "heading截断",
      genre: "玄幻",
      decodedText: text,
    });

    // 所有 heading 字段不得超过 81 字符（80 + …）
    for (const a of result.annotations) {
      assert.ok(
        a.heading.length <= 81,
        `heading 过长（${a.heading.length} 字符）：${a.heading.slice(0, 50)}...`,
      );
    }
    // 不得包含完整 body
    const json = JSON.stringify(result);
    assert.ok(!json.includes(longBody), "截断后不得包含完整 body");
  });

  test("splitter 置信度透传到校准结果", () => {
    const text = buildBook([
      { heading: "第1章 一", body: "正文".repeat(200) },
      { heading: "第2章 二", body: "正文".repeat(200) },
      { heading: "第3章 三", body: "正文".repeat(200) },
    ]);

    const result = calibrateChapterSplitting({
      bookId: "test-confidence",
      title: "置信度",
      genre: "玄幻",
      decodedText: text,
    });

    assert.ok(result.splitConfidence > 0, "置信度应 > 0");
    assert.ok(result.splitConfidence <= 1, "置信度应 ≤ 1");
  });
});

describe("NB-1R aggregateCalibrationStats", () => {
  test("聚合多本书统计正确", () => {
    const text1 = buildBook([
      { heading: "第1章 甲", body: "正文".repeat(200) },
      { heading: "第2章 乙", body: "正文".repeat(200) },
    ]);
    const text2 = buildBook([
      { heading: "第1回 楔", body: "正文".repeat(200) },
      { heading: "第2回 风起", body: "正文".repeat(200) },
    ]);

    const r1 = calibrateChapterSplitting({
      bookId: "agg-1", title: "书1", genre: "玄幻", decodedText: text1,
    });
    const r2 = calibrateChapterSplitting({
      bookId: "agg-2", title: "书2", genre: "武侠", decodedText: text2,
    });

    const stats = aggregateCalibrationStats([r1, r2]);

    assert.equal(stats.totalBooks, 2);
    assert.equal(stats.highConfidence, 1); // r1
    assert.equal(stats.rejected, 1); // r2（回 不被 splitter 识别）
    assert.equal(stats.lowConfidence, 0);
    assert.equal(stats.totalGroundTruth, 4); // 2 + 2
    assert.equal(stats.totalTP, 2); // r1 的 2 章
    assert.equal(stats.totalFN, 2); // r2 的 2 章
    assert.equal(stats.totalFP, 0);
    assert.ok(stats.overallPrecision > 0);
    // errorDistribution 应含 rejected_no_headings
    assert.ok(
      (stats.errorDistribution["rejected_no_headings"] ?? 0) >= 2,
      "应含 rejected_no_headings 错误",
    );
  });

  test("空结果集不抛错", () => {
    const stats = aggregateCalibrationStats([]);
    assert.equal(stats.totalBooks, 0);
    assert.equal(stats.overallPrecision, 0);
    assert.equal(stats.overallRecall, 0);
  });

  test("整体 precision = totalTP / (totalTP + totalFP)", () => {
    const text = buildBook([
      { heading: "第1章 甲", body: "正文".repeat(200) },
      { heading: "第2章 乙", body: "正文".repeat(200) },
      { heading: "第3章 丙", body: "正文".repeat(200) },
    ]);

    const r = calibrateChapterSplitting({
      bookId: "prec-1", title: "精度", genre: "玄幻", decodedText: text,
    });
    const stats = aggregateCalibrationStats([r]);

    const expected = stats.totalTP / (stats.totalTP + stats.totalFP);
    assert.ok(Math.abs(stats.overallPrecision - expected) < 1e-9);
  });
});
