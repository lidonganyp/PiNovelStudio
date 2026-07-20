/**
 * NB-0 语料审计测试
 *
 * 用合成微语料（临时目录）验证：
 * - 5 种 status 分类（canonical/duplicate/incomplete/mojibake/polluted）
 * - canonical 链接（duplicateOf 指向 canonical bookId）
 * - parseFilename 各格式
 * - detectGenreFromPath
 * - computeBookId/computeAuthorId 稳定性
 * - recordTimestamp:false 重跑 hash 稳定
 * - 原文件 mtime + sha256 未变（只读验证）
 *
 * import 自 dist-eval/novelbench/index.js（lab-only）。
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import {
  auditCorpora,
  parseFilename,
  detectGenreFromPath,
  computeBookId,
  computeAuthorId,
  countChapters,
} from "../dist-eval/novelbench/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// 合成语料构造
// ─────────────────────────────────────────────────────────────────────────────

/** 生成一段含 N 个章节标题的合法中文正文 */
function makeCanonicalText(chapterCount = 5) {
  const lines = ["这是一本测试用的合法中文小说。主角走出家门，开始冒险。"];
  for (let i = 1; i <= chapterCount; i++) {
    lines.push(`第${i}章 测试章节${i}`);
    lines.push("");
    // 每章 ~250 字中文，确保 >1KB 且 >=3 章
    const body = `主角在测试章节${i}中遇到了挑战。他仔细观察周围的环境，发现了一些不寻常的线索。空气中弥漫着紧张的气氛，每一步都需要谨慎。他知道，一旦做出错误的选择，后果将不堪设想。于是，他深吸一口气，握紧了手中的武器，准备迎接即将到来的战斗。远处的山峦在暮色中渐渐模糊，而脚下的路却越来越清晰。这是一个关于勇气、智慧和命运的故事，每一章都将推动主角走向更深的迷雾之中。`;
    lines.push(body);
    lines.push("");
  }
  return lines.join("\n");
}

function makeShortText() {
  return "第一章 短章\n这是很短的内容，不到一KB。\n第二章 短章二\n也很短。";
}

function makeMojibakeBuffer() {
  // 2000 字节 [0x41,0x00] 交替：
  // - utf-16le 解码为 "AAA..."（无 CJK，score=0）
  // - utf-8/gbk 解码为 'A'+NULL 控制符（score 为负）
  // 最高分 = utf-16le score=0 < 0.3 → mojibake
  // 文件 >1KB 避免 incomplete
  const buf = Buffer.alloc(2000);
  for (let i = 0; i < 2000; i += 2) {
    buf[i] = 0x41;
    buf[i + 1] = 0x00;
  }
  return buf;
}

function makePollutedText() {
  const lines = ["这是含广告污染的小说正文。主角走在路上，看着远方的山峦。"];
  for (let i = 1; i <= 5; i++) {
    lines.push(`第${i}章 污染章${i}`);
    lines.push("");
    // 每章足够长确保总文件 >1KB；含广告关键词
    lines.push("更多精彩内容请访问 www.example.com 关注公众号获取。这是正文内容，主角继续冒险。");
    lines.push("他在森林中穿行，树叶在风中沙沙作响。远处传来鸟鸣，空气中弥漫着泥土的气息。");
    lines.push("每一步都踏在松软的落叶上，发出细微的声响。他知道前方有危险，但仍然坚定地前行。");
    lines.push("这是关于勇气和智慧的故事，每一章都推动着主角走向更深的迷雾之中。");
    lines.push("");
  }
  return lines.join("\n");
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

/** 记录目录下所有 .txt 文件的 mtime + sha256（用于只读验证） */
function snapshotFiles(dir, files) {
  const snapshot = {};
  for (const f of files) {
    const fullPath = join(dir, f);
    const content = readFileSync(fullPath);
    snapshot[f] = {
      mtimeMs: statSync(fullPath).mtimeMs,
      hash: sha256(content),
    };
  }
  return snapshot;
}

// ─────────────────────────────────────────────────────────────────────────────
// 测试
// ─────────────────────────────────────────────────────────────────────────────

describe("NB-0 语料审计", () => {
  let tmpDir;
  let fileList;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `nb0-corpus-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
    // 在 tmpDir/玄幻/ 子目录下放文件，测试 detectGenreFromPath
    const genreDir = join(tmpDir, "玄幻");
    mkdirSync(genreDir, { recursive: true });

    // canonical 书
    writeFileSync(join(genreDir, "《剑来》烽火戏诸侯.txt"), makeCanonicalText(5), "utf-8");
    // duplicate（同 title+author，精校版）
    writeFileSync(join(genreDir, "剑来 - 烽火戏诸侯 (精校版).txt"), makeCanonicalText(5), "utf-8");
    // incomplete（<1KB）
    writeFileSync(join(tmpDir, "短书.txt"), makeShortText(), "utf-8");
    // mojibake（>1KB [0x41,0x00] 交替 → 所有编码 score<0.3）
    writeFileSync(join(tmpDir, "broken.txt"), makeMojibakeBuffer());
    // polluted
    writeFileSync(join(tmpDir, "广告书.txt"), makePollutedText(), "utf-8");

    fileList = [
      "玄幻/《剑来》烽火戏诸侯.txt",
      "玄幻/剑来 - 烽火戏诸侯 (精校版).txt",
      "短书.txt",
      "broken.txt",
      "广告书.txt",
    ];
  });

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  test("5 种 status 分类正确", async () => {
    const before = snapshotFiles(tmpDir, fileList);
    const { entries, stats } = await auditCorpora({ root: tmpDir, recordTimestamp: false });

    // 找到各 status 的条目
    const byTitle = new Map(entries.map((e) => [e.title, e]));
    const canonical = entries.find((e) => e.title === "剑来" && e.status === "canonical");
    const duplicate = entries.find((e) => e.title === "剑来" && e.status === "duplicate");
    const incomplete = entries.find((e) => e.title === "短书");
    const mojibake = entries.find((e) => e.title === "broken");
    const polluted = entries.find((e) => e.title === "广告书");

    assert.ok(canonical, "应有 canonical 剑来");
    assert.ok(duplicate, "应有 duplicate 剑来");
    assert.equal(incomplete?.status, "incomplete", "短书应为 incomplete");
    assert.equal(mojibake?.status, "mojibake", "broken 应为 mojibake");
    assert.equal(polluted?.status, "polluted", "广告书应为 polluted");

    // 统计
    assert.equal(stats.totalFiles, 5);
    assert.equal(stats.canonical, 1);
    assert.equal(stats.duplicate, 1);
    assert.equal(stats.incomplete, 1);
    assert.equal(stats.mojibake, 1);
    assert.equal(stats.polluted, 1);

    // 只读验证：原文件 mtime + hash 未变
    const after = snapshotFiles(tmpDir, fileList);
    for (const f of fileList) {
      assert.equal(after[f].hash, before[f].hash, `文件 ${f} 内容 hash 不应变`);
    }
  });

  test("duplicate 的 duplicateOf 指向 canonical bookId", async () => {
    const { entries } = await auditCorpora({ root: tmpDir, recordTimestamp: false });
    const canonical = entries.find((e) => e.title === "剑来" && e.status === "canonical");
    const duplicate = entries.find((e) => e.title === "剑来" && e.status === "duplicate");

    assert.ok(canonical, "应有 canonical");
    assert.ok(duplicate, "应有 duplicate");
    assert.equal(duplicate.duplicateOf, canonical.bookId, "duplicateOf 应指向 canonical bookId");
    // canonical 优先精校版（文件名含"精校"）
    assert.equal(canonical.isProofread, true, "canonical 应为精校版");
  });

  test("detectGenreFromPath 从目录推断类型", () => {
    assert.equal(detectGenreFromPath("D:/corpus/玄幻/剑来.txt"), "玄幻");
    assert.equal(detectGenreFromPath("D:/corpus/武侠/射雕.txt"), "武侠");
    assert.equal(detectGenreFromPath("D:/corpus/灵异/诡异.txt"), "灵异");
    assert.equal(detectGenreFromPath("D:/corpus/末日/废土.txt"), "末日");
    assert.equal(detectGenreFromPath("D:/corpus/无类型/书.txt"), "未分类");
  });

  test("parseFilename 各格式", () => {
    // 《书名》作者
    let r = parseFilename("D:/corpus/《剑来》烽火戏诸侯.txt");
    assert.equal(r.title, "剑来");
    assert.equal(r.author, "烽火戏诸侯");
    assert.equal(r.isProofread, false);

    // 书名 - 作者
    r = parseFilename("D:/corpus/剑来 - 烽火戏诸侯.txt");
    assert.equal(r.title, "剑来");
    assert.equal(r.author, "烽火戏诸侯");

    // 书名 by 作者
    r = parseFilename("D:/corpus/Novel by Author.txt");
    assert.equal(r.title, "Novel");
    assert.equal(r.author, "Author");

    // [精校版]书名
    r = parseFilename("D:/corpus/[精校版]剑来.txt");
    assert.equal(r.title, "剑来");
    assert.equal(r.isProofread, true);

    // 纯书名
    r = parseFilename("D:/corpus/纯书名.txt");
    assert.equal(r.title, "纯书名");
    assert.equal(r.author, undefined);
  });

  test("computeBookId / computeAuthorId 稳定性", () => {
    const id1 = computeBookId("剑来", "烽火戏诸侯");
    const id2 = computeBookId("剑来", "烽火戏诸侯");
    assert.equal(id1, id2, "相同输入应得相同 bookId");
    assert.equal(id1.length, 16, "bookId 应为 16 字符");

    const aid1 = computeAuthorId("烽火戏诸侯");
    const aid2 = computeAuthorId("烽火戏诸侯");
    assert.equal(aid1, aid2, "相同输入应得相同 authorId");
    assert.equal(aid1.length, 16, "authorId 应为 16 字符");

    // 不同书名应得不同 bookId
    const id3 = computeBookId("雪中悍刀行", "烽火戏诸侯");
    assert.notEqual(id1, id3, "不同书名应得不同 bookId");
  });

  test("recordTimestamp:false 重跑 hash 稳定", async () => {
    const r1 = await auditCorpora({ root: tmpDir, recordTimestamp: false });
    const r2 = await auditCorpora({ root: tmpDir, recordTimestamp: false });

    assert.equal(r1.entries.length, r2.entries.length);
    for (let i = 0; i < r1.entries.length; i++) {
      const a = r1.entries[i];
      const b = r2.entries[i];
      assert.equal(a.bookId, b.bookId, `第 ${i} 条 bookId 应一致`);
      assert.equal(a.fileHash, b.fileHash, `第 ${i} 条 fileHash 应稳定`);
      assert.equal(a.contentHash, b.contentHash, `第 ${i} 条 contentHash 应稳定`);
      assert.equal(a.auditTimestamp, "stable", "auditTimestamp 应为 stable");
    }
  });

  test("countChapters 统计章节数", () => {
    const text = "第一章 A\n正文\n第二章 B\n正文\n第三章 C\n正文";
    assert.equal(countChapters(text), 3);
    assert.equal(countChapters("无章节标题的纯正文"), 0);
  });

  test("manifest 按 bookId 排序（确定性）", async () => {
    const { entries } = await auditCorpora({ root: tmpDir, recordTimestamp: false });
    const ids = entries.map((e) => e.bookId);
    const sorted = [...ids].sort();
    assert.deepEqual(ids, sorted, "entries 应按 bookId 升序排列");
  });

  test("byGenre 统计包含玄幻", async () => {
    const { stats } = await auditCorpora({ root: tmpDir, recordTimestamp: false });
    assert.ok(stats.byGenre["玄幻"] >= 2, "玄幻目录下应至少有 2 本书（剑来 canonical + duplicate）");
  });
});
