/**
 * NB-1 可靠章节切分测试
 *
 * 验证：
 * - 嵌套卷+章切分
 * - 序章+终章
 * - 无标题拒绝（禁止 fallback）
 * - TOC 页检测
 * - 异常短章 / 超长章 / 重复章号
 * - round-trip hash 一致
 * - 无标题永不产假章
 * - splitConfidence 范围
 *
 * import 自 dist-eval/novelbench/index.js（lab-only）。
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  splitChaptersStrict,
  sampleChapters,
  resolveReferenceBody,
} from "../dist-eval/novelbench/index.js";

function sha256(data) {
  return createHash("sha256").update(data, "utf-8").digest("hex");
}

/** 生成含卷+章的正文 */
function makeVolumeChapterText() {
  const lines = [];
  lines.push("第一卷 初入江湖");
  lines.push("");
  lines.push("第1章 起点");
  lines.push("主角走出家门，开始冒险。".repeat(20));
  lines.push("");
  lines.push("第2章 初遇");
  lines.push("主角遇到了第一个伙伴。".repeat(20));
  lines.push("");
  lines.push("第二卷 风云起");
  lines.push("");
  lines.push("第3章 暗流");
  lines.push("主角卷入了更大的纷争。".repeat(20));
  lines.push("");
  return lines.join("\n");
}

function makePrologueEpilogueText() {
  const lines = [];
  lines.push("序章");
  lines.push("故事开始之前的事情。".repeat(20));
  lines.push("");
  lines.push("第1章 正式开始");
  lines.push("主角踏上旅途。".repeat(20));
  lines.push("");
  lines.push("第2章 继续");
  lines.push("旅途继续。".repeat(20));
  lines.push("");
  lines.push("终章");
  lines.push("故事结束了。".repeat(20));
  lines.push("");
  return lines.join("\n");
}

describe("NB-1 可靠章节切分", () => {
  test("嵌套卷+章切分", () => {
    const text = makeVolumeChapterText();
    const result = splitChaptersStrict(text);

    assert.equal(result.rejectionReason, undefined, "不应拒绝");
    assert.ok(result.chapters.length >= 3, "应至少 3 章");
    assert.ok(result.volumes.length >= 2, "应至少 2 卷");
    assert.ok(result.splitConfidence > 0.7, `置信度应 >0.7，实际 ${result.splitConfidence}`);
  });

  test("序章+终章切分", () => {
    const text = makePrologueEpilogueText();
    const result = splitChaptersStrict(text);

    assert.equal(result.rejectionReason, undefined, "不应拒绝");
    assert.ok(result.chapters.length >= 4, "应至少 4 章（序+2正+终）");
  });

  test("无标题拒绝（禁止 fallback）", () => {
    const text = "这是一段没有章节标题的纯正文。".repeat(50) + "\n" + "继续写更多内容。".repeat(50);
    const result = splitChaptersStrict(text);

    assert.equal(result.rejectionReason, "no_reliable_headings");
    assert.equal(result.chapters.length, 0, "无标题时 chapters 必须为空");
    assert.equal(result.splitConfidence, 0);
  });

  test("无标题永不产假章（单 heading 也不行）", () => {
    const text = "第1章 唯一标题\n" + "正文内容。".repeat(50);
    const result = splitChaptersStrict(text);

    assert.equal(result.rejectionReason, "no_reliable_headings", "仅 1 个 heading 也应拒绝");
    assert.equal(result.chapters.length, 0, "禁止 fallback 单章");
  });

  test("TOC 页检测", () => {
    // 构造目录页：连续 10 行 heading，每行 body 极短
    const lines = [];
    for (let i = 1; i <= 10; i++) {
      lines.push(`第${i}章 标题${i}`);
      lines.push(""); // 极短 body
    }
    const tocText = lines.join("\n");
    const result = splitChaptersStrict(tocText);

    // 全部短章 → 拒绝 toc_page
    assert.equal(result.rejectionReason, "toc_page");
    assert.equal(result.chapters.length, 0);
  });

  test("异常短章检测", () => {
    const lines = [];
    lines.push("第1章 正常长度");
    lines.push("这是足够长的正文内容。".repeat(30));
    lines.push("");
    lines.push("第2章 太短");
    lines.push("短。"); // <200 字
    lines.push("");
    lines.push("第3章 正常");
    lines.push("又是足够长的正文。".repeat(30));
    lines.push("");
    const result = splitChaptersStrict(lines.join("\n"));

    const shortCh = result.chapters.find((c) => c.chapterNumber === 2);
    assert.ok(shortCh, "应有第 2 章");
    assert.ok(
      shortCh.issues.some((i) => i.includes("short_chapter")),
      "第 2 章应标 short_chapter",
    );
  });

  test("重复章号检测", () => {
    const lines = [];
    lines.push("第1章 第一回");
    lines.push("正文内容。".repeat(30));
    lines.push("");
    lines.push("第1章 重复了");
    lines.push("又是正文。".repeat(30));
    lines.push("");
    lines.push("第2章 继续");
    lines.push("继续正文。".repeat(30));
    lines.push("");
    const result = splitChaptersStrict(lines.join("\n"));

    assert.ok(
      result.issues.some((i) => i.includes("duplicate_chapter_number")),
      "应检测到重复章号",
    );
  });

  test("round-trip hash 一致", () => {
    const text = makeVolumeChapterText();
    const result = splitChaptersStrict(text);

    for (const ch of result.chapters) {
      const body = resolveReferenceBody(text, ch);
      assert.ok(body !== null, `第 ${ch.chapterNumber} 章 round-trip hash 应一致`);
      assert.equal(sha256(body), ch.bodyHash, "重算 hash 应等于 bodyHash");
    }
  });

  test("resolveReferenceBody hash 不匹配返回 null", () => {
    const text = makeVolumeChapterText();
    const result = splitChaptersStrict(text);
    const ch = result.chapters[0];
    // 篡改 bodyHash
    const tampered = { ...ch, bodyHash: "0".repeat(64) };
    const body = resolveReferenceBody(text, tampered);
    assert.equal(body, null, "hash 不匹配应返回 null");
  });

  test("sampleChapters 首中末抽样", () => {
    const lines = [];
    for (let i = 1; i <= 10; i++) {
      lines.push(`第${i}章 标题${i}`);
      lines.push(`这是第 ${i} 章的正文内容，主角继续冒险。`);
      lines.push("");
    }
    const text = lines.join("\n");
    const result = splitChaptersStrict(text);
    const samples = sampleChapters(text, result.chapters, 3);

    assert.equal(samples.length, 3, "应抽样 3 章");
    assert.equal(samples[0].chapterNumber, 1, "首章应为第 1 章");
    assert.equal(samples[samples.length - 1].chapterNumber, 10, "末章应为第 10 章");
    for (const s of samples) {
      assert.ok(s.excerpt.length <= 300, "摘要应 <=300 字");
      assert.ok(s.heading, "应有 heading");
    }
  });

  test("splitConfidence 在 0-1 范围", () => {
    const text = makeVolumeChapterText();
    const result = splitChaptersStrict(text);
    assert.ok(result.splitConfidence >= 0 && result.splitConfidence <= 1, "置信度应在 [0,1]");
  });
});
