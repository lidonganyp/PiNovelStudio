/**
 * NB-2 防泄漏扫描器测试
 *
 * 验证：
 * - 注入目标章短语 → passed===false, phraseLeakCount>=1
 * - 纯前文 input → passed===true
 * - 目标标题泄漏 → titleSpoilerLeak===true, passed===false
 * - 合法前文复用 → ngramOverlapRate 低（排除 prior n-gram），passed===true
 *
 * import 自 dist-eval/novelbench/index.js（lab-only）。
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { auditLeakage } from "../dist-eval/novelbench/index.js";

describe("NB-2 防泄漏扫描器", () => {
  test("注入目标章短语 → passed===false, phraseLeakCount>=1", () => {
    // reference 含独特短语"暗夜星辉秘术"
    const referenceBody = "主角在山洞中发现了暗夜星辉秘术的残卷。这是一段关于古老力量的记载。他仔细研读每一个字。";
    const priorChapterBodies = [
      "主角走进山林，寻找传说中的洞窟。周围一片寂静，只有风声。",
    ];
    // input 注入了 reference 的独特短语
    const generationInput = "主角继续前行，回忆起暗夜星辉秘术的残卷内容，心中有了计较。前方的路还很漫长。";

    const result = auditLeakage(generationInput, referenceBody, priorChapterBodies, {
      targetChapterTitle: "山洞秘卷",
    });

    assert.equal(result.passed, false, "注入目标章短语应未通过");
    assert.ok(result.phraseLeakCount >= 1, `phraseLeakCount 应 >=1，实际 ${result.phraseLeakCount}`);
    assert.ok(
      result.details.some((d) => d.includes("phrase_leak")),
      "details 应含 phrase_leak 描述",
    );
  });

  test("纯前文 input → passed===true", () => {
    // reference 是目标章正文
    const referenceBody = "主角推开了石门，眼前出现了一座古老的祭坛。祭坛上刻满了奇怪的符文。空气中弥漫着灰尘的味道。";
    const priorChapterBodies = [
      "主角沿着山路跋涉，终于到达了传说中的遗迹入口。他深吸一口气，准备迎接未知的挑战。远处的山峰在夕阳下显得格外壮丽。",
    ];
    // input 完全来自 prior，不含 reference 内容
    const generationInput = "主角沿着山路跋涉，终于到达了传说中的遗迹入口。他深吸一口气，准备迎接未知的挑战。";

    const result = auditLeakage(generationInput, referenceBody, priorChapterBodies);

    assert.equal(result.passed, true, `纯前文 input 应通过，实际 details: ${result.details.join("; ")}`);
    assert.equal(result.phraseLeakCount, 0, "phraseLeakCount 应为 0");
    assert.equal(result.entityLeakCount, 0, "entityLeakCount 应为 0");
    assert.equal(result.titleSpoilerLeak, false, "titleSpoilerLeak 应为 false");
  });

  test("目标标题泄漏 → titleSpoilerLeak===true, passed===false", () => {
    const referenceBody = "主角与反派在悬崖边对峙。风很大，双方都不退让。最终主角做出了关键的选择。";
    const priorChapterBodies = [
      "主角一路追踪反派的踪迹，穿过密林，越过溪流。每一步都充满危险。",
    ];
    // input 含目标章标题关键词"悬崖对决"
    const generationInput = "主角继续追踪，心中预感悬崖对决即将到来。他握紧了武器，脚步更加坚定。";
    const targetChapterTitle = "悬崖对决";

    const result = auditLeakage(generationInput, referenceBody, priorChapterBodies, {
      targetChapterTitle,
    });

    assert.equal(result.titleSpoilerLeak, true, "标题关键词泄漏应检测到");
    assert.equal(result.passed, false, "标题泄漏应未通过");
    assert.ok(
      result.details.some((d) => d.includes("title_spoiler_leak")),
      "details 应含 title_spoiler_leak 描述",
    );
  });

  test("合法前文复用 → ngramOverlapRate 低，passed===true", () => {
    // prior 和 input 共享大量 4-gram（合法前文复用）
    const priorText = "主角走进古老的图书馆，书架上满是灰尘。他翻开一本破旧的日记，上面记录着前人的冒险经历。每一页都承载着历史的重量。";
    const referenceBody = "日记的最后一页记载着一个秘密坐标。主角决定前往探查。那里据说隐藏着远古文明的遗产。";
    // input 复用 prior 的内容（合法），不含 reference 独特内容
    const generationInput = "主角走进古老的图书馆，书架上满是灰尘。他翻开一本破旧的日记，上面记录着前人的冒险经历。现在他要基于这些信息行动。";

    const result = auditLeakage(generationInput, referenceBody, [priorText]);

    assert.equal(result.passed, true, `合法前文复用应通过，实际 details: ${result.details.join("; ")}`);
    // ngramOverlapRate 应很低（prior n-gram 被排除，input 与 reference 的 novel n-gram 交集小）
    assert.ok(
      result.ngramOverlapRate < 0.02,
      `ngramOverlapRate 应 <0.02（排除 prior n-gram 后），实际 ${result.ngramOverlapRate}`,
    );
    assert.equal(result.phraseLeakCount, 0, "phraseLeakCount 应为 0");
  });
});
