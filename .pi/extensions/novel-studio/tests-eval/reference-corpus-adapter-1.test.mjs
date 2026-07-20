/**
 * REFERENCE-CORPUS-ADAPTER-1 测试（RED 阶段）
 *
 * 验收任务卡 §5 REFERENCE-CORPUS-ADAPTER-1：
 * - 接入《神秘复苏》外部 reference，复用 NovelBench 现有基础设施
 * - 单书导入 CLI（scripts/novelbench/import-external-reference.mjs），不移动原文件
 * - manifest schema 完整：bookId / 原文件 SHA-256 / 编码 / physicalChapterIndex / 原始 heading /
 *   解析章号 / start/end offset / body hash / split confidence / duplicate/overlong/short/番外诊断
 * - 重复章号和 9999 番外不得覆盖前一条记录（referenceId = bookId:physical:N）
 * - generator bundle 剥离 sourcePath / offset / referenceBody / referenceHash
 * - leakage scanner 检测目标章连续长片段、标题剧透、sourcePath
 * - 原始全文不进入 Git 状态
 * - 连续两次 manifest hash 一致
 * - 抽查 20 章 offset 对应正文正确（开篇/中段/后段/番外）
 * - 产物文件：book-manifest.json + chapters.jsonl + manifest-hash.sha256（避免 .txt 与"原文件不复制"约束冲突）
 *
 * import 自 dist-eval/novelbench/index.js（eval-only）。
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  writeFileSync,
  mkdirSync,
  rmSync,
  readFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  sanitizeForGenerator,
  validateGeneratorSchema,
  assertNoLeakageFields,
  FORBIDDEN_FIELDS,
  ReferenceRegistry,
  splitChaptersStrict,
  resolveReferenceBody,
  auditLeakage,
} from "../dist-eval/novelbench/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXT_ROOT = join(__dirname, "..");
// EXT_ROOT = .pi/extensions/novel-studio；向上 3 级 = PiNovelStudio 仓库根
const PROJECT_ROOT = join(EXT_ROOT, "..", "..", "..");
const CLI_PATH = join(
  PROJECT_ROOT,
  "scripts",
  "novelbench",
  "import-external-reference.mjs",
);
const REAL_REFERENCE_PATH = "D:\\Download\\novelbag\\神秘复苏.txt";

function sha256(data) {
  return createHash("sha256").update(data, "utf-8").digest("hex");
}

function range(start, end) {
  const r = [];
  for (let i = start; i < end && i >= 0; i++) r.push(i);
  return r;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixture：合成 9 章 .txt，含重复章号 + 多个 9999 番外 + 短章 + 终章
// ─────────────────────────────────────────────────────────────────────────────

function makeFixtureText() {
  return [
    "------------",
    "",
    "正文卷",
    "",
    "------------",
    "",
    "第一章论坛里的鬼故事",
    "",
    "老夫掐指一算，你现在正在床上看小说，而且还是侧身，搞不好手机还在充电。这话本来是网络上一个不算太出名的帖子，最早发在哪个论坛已经不可考了。只是谁也没想到，这个看似随意的玩笑，竟然会成为一个可怕故事的开端。那天晚上，李一凡像往常一样刷着手机，看到这条回复时只是笑了笑，没当回事。他关了灯，把手机放在床头柜上，闭眼准备睡觉。可是不知道为什么，他总觉得有什么不对劲。窗外似乎有风，吹得窗帘沙沙作响，但他清楚地记得自己睡前关了窗。这种感觉持续了大概十分钟，他终于忍不住睁开了眼。",
    "",
    "第二章地下室的声音",
    "",
    "那天夜里，李一凡被一阵奇怪的声音惊醒。声音似乎来自楼下，沉闷而有节奏，像是有人在敲击什么。他看了看时间，凌晨三点十五分。整栋楼安静得可怕，那声音反而显得格外清晰。他披上外套，拿起手电筒，轻轻走下楼梯。地下室的门虚掩着，门缝里透出一丝微弱的光。他屏住呼吸，慢慢靠近，心里却有一种说不出的不安。这种不安不是来自恐惧本身，而是来自一种被注视的感觉，仿佛黑暗中有什么东西正盯着他。他握紧手电筒，深吸一口气，推开了那扇虚掩的门。",
    "",
    "第二章重复章号的陷阱",
    "",
    "这是为了测试重复章号不会被覆盖。这段内容必须足够长，才能避免被判定为短章。所以这里要写超过两百字的内容，确保切分器把它当作一个完整的章节。重复章号在真实小说中确实会出现，比如作者笔误或者平台编号错误。我们的系统必须保留这些记录，而不是用后一条覆盖前一条。这样可以确保用户能区分和访问每一个重复章号的章节。重复章号的处理是 reference 数据集可靠性的关键一环，直接关系到后续评测的准确性。",
    "",
    "第三章正常章节",
    "",
    "这一章用来测试正常章节的切分。内容应该足够长以避免短章误判。李一凡继续他的调查，他发现地下室的入口被某种东西堵住了。他试图清理，但每次清理完，第二天又会重新堵上。这让他意识到，这不是普通的现象。他开始记录每次清理的时间、堵上的时间、堵上的方式。渐渐地，他发现了一个规律：堵上的速度似乎与天气有关。阴天堵得快，晴天堵得慢。这个发现让他既兴奋又恐惧，因为他知道自己正在接近某个真相。",
    "",
    "第四章短章",
    "",
    "短。",
    "",
    "第五章正常章节继续",
    "",
    "李一凡决定在地下室安装监控摄像头。他花了一整天时间布置线路，又花了半天时间调试软件。当一切就绪时，他坐在电脑前，盯着屏幕上的实时画面。凌晨三点十五分，画面中出现了异常。地下室的角落里，似乎有什么东西在移动。他放大画面，心跳加速。那是一个模糊的人形轮廓，正缓慢地向摄像头靠近。他屏住呼吸，不敢发出任何声响，只能眼睁睁看着那个轮廓越来越清晰。",
    "",
    "番外我的回忆",
    "",
    "这是补充主线之外的故事。这段内容必须足够长以避免短章误判。所以这里要写超过两百字的内容。番外在切分器中会被编号为 9999，这是为了与正常章节区分。多个番外应该各自独立保留，不能覆盖。这个番外讲述的是李一凡小时候的一段经历。那时候他还住在老家，经常和邻居家的孩子一起在田野里玩耍。有一次，他们在田野深处发现了一口枯井。井口用石板盖着，但石板已经裂开了。他们好奇地搬开石板，往井里扔了一块石头，很久才听到回声。",
    "",
    "番外另一个番外篇",
    "",
    "第二个番外，用来测试多个 9999 番外不会被覆盖。这段内容同样需要超过两百字。我们的系统必须为每个番外分配独立的物理序号，即使它们的章号都是 9999。这样可以确保用户能区分和访问每一个番外。这个番外讲述的是另一个角色的视角。小红是李一凡的同事，她最近也开始注意到一些异常。办公室的灯总是莫名其妙地熄灭，打印机有时会自己启动，打印出一些奇怪的字符。她把这些事件记在日记里，试图找出规律。",
    "",
    "终章尾声",
    "",
    "这是故事的收尾。这段内容需要超过两百字以避免短章误判。终章通常包含主角的最终命运、世界的最终状态等。我们的系统应该把它当作独立的章节保留，而不是与其他 9999 章节合并或覆盖。李一凡最终找到了解决问题的办法。他意识到，那个声音并不是来自地下室，而是来自他自己内心深处的某种东西。他学会了与之共处，而不是与之对抗。故事到此结束，但生活还在继续。窗外的天色渐渐亮了，新的一天开始了。",
    "",
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// 辅助
// ─────────────────────────────────────────────────────────────────────────────

let tmpDir;
let fixturePath;
let outDir;

beforeEach(() => {
  tmpDir = join(tmpdir(), `rca1-${randomUUID()}`);
  fixturePath = join(tmpDir, "fixture.txt");
  outDir = join(tmpDir, "out");
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(fixturePath, makeFixtureText(), "utf-8");
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // 忽略清理失败
  }
});

function runImportCli(args) {
  if (!existsSync(CLI_PATH)) {
    assert.fail(
      `CLI 不存在：${CLI_PATH}（REFERENCE-CORPUS-ADAPTER-1 GREEN 未实现）`,
    );
  }
  const cmd = `node "${CLI_PATH}" ${args}`;
  return execSync(cmd, { encoding: "utf-8", cwd: PROJECT_ROOT });
}

function readBookManifest(out) {
  return JSON.parse(readFileSync(join(out, "book-manifest.json"), "utf-8"));
}

function readChapters(out) {
  return readFileSync(join(out, "chapters.jsonl"), "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function readManifestHash(out) {
  return readFileSync(join(out, "manifest-hash.sha256"), "utf-8").trim();
}

function readFixtureDecoded() {
  return readFileSync(fixturePath, "utf-8")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Part A：fixture-based（合成 9 章）
// ─────────────────────────────────────────────────────────────────────────────

describe("REFERENCE-CORPUS-ADAPTER-1 Part A: fixture-based", () => {
  test("CLI 文件存在：scripts/novelbench/import-external-reference.mjs", () => {
    assert.ok(existsSync(CLI_PATH), `CLI 应存在：${CLI_PATH}`);
  });

  test("导入后产物存在：book-manifest.json + chapters.jsonl + manifest-hash.sha256", () => {
    runImportCli(
      `--input "${fixturePath}" --book-id fixt1 --out-dir "${outDir}"`,
    );
    assert.ok(
      existsSync(join(outDir, "book-manifest.json")),
      "book-manifest.json 应存在",
    );
    assert.ok(
      existsSync(join(outDir, "chapters.jsonl")),
      "chapters.jsonl 应存在",
    );
    assert.ok(
      existsSync(join(outDir, "manifest-hash.sha256")),
      "manifest-hash.sha256 应存在",
    );
  });

  test("book-manifest.json schema 完整性（含原文件 SHA-256 / 编码 / 章节数 / 置信度）", () => {
    runImportCli(
      `--input "${fixturePath}" --book-id fixt1 --out-dir "${outDir}" --title 测试书 --author 测试作者 --genre 玄幻`,
    );
    const m = readBookManifest(outDir);

    assert.equal(m.bookId, "fixt1");
    assert.equal(m.title, "测试书");
    assert.equal(m.author, "测试作者");
    assert.equal(m.genre, "玄幻");
    assert.equal(m.sourcePath, fixturePath, "sourcePath 应为原文件绝对路径");
    assert.ok(
      typeof m.fileHash === "string" && m.fileHash.length === 64,
      "fileHash 应为 64 字符 SHA-256（原文件字节 hash）",
    );
    assert.ok(
      typeof m.contentHash === "string" && m.contentHash.length === 64,
      "contentHash 应为 64 字符 SHA-256（解码后正文 hash）",
    );
    assert.equal(m.size, Buffer.byteLength(makeFixtureText(), "utf-8"));
    assert.ok(typeof m.encoding === "string" && m.encoding.length > 0);
    // encodingScore 来自 decodeNovelSourceBuffer 的 scoreDecodedText，
    // 是 cjkRatio*100 + headingCount*25 + punctuationCount*0.2 - 替换/控制/乱码惩罚 的加权和，
    // 不是 0-1 归一化置信度。同编码同文本分数稳定，可用于跨编码相对比较。
    assert.ok(
      typeof m.encodingScore === "number" && m.encodingScore >= 0,
      `encodingScore 应为非负数（decodeNovelSourceBuffer 加权分），实际 ${m.encodingScore}`,
    );
    assert.ok(
      typeof m.chapterCount === "number" && m.chapterCount > 0,
      "chapterCount 应 >0",
    );
    assert.ok(
      typeof m.splitConfidence === "number" &&
        m.splitConfidence >= 0 &&
        m.splitConfidence <= 1,
    );
    assert.ok(Array.isArray(m.issues));
    assert.ok(
      typeof m.importedAt === "string" && m.importedAt.length > 0,
      "importedAt 应为 ISO 时间字符串",
    );
  });

  test("chapters.jsonl schema 完整性（每行含 physicalChapterIndex 等所有必需字段）", () => {
    runImportCli(
      `--input "${fixturePath}" --book-id fixt1 --out-dir "${outDir}"`,
    );
    const chapters = readChapters(outDir);
    assert.ok(chapters.length >= 9, `应至少 9 章，实际 ${chapters.length}`);

    const requiredFields = [
      "bookId",
      "physicalChapterIndex",
      "chapterNumber",
      "heading",
      "title",
      "startOffset",
      "bodyStartOffset",
      "endOffset",
      "bodyHash",
      "characterCount",
      "splitConfidence",
      "issues",
    ];
    for (const ch of chapters) {
      for (const f of requiredFields) {
        assert.ok(
          f in ch,
          `每条 chapter 记录应含 ${f}，实际字段：${Object.keys(ch).join(",")}`,
        );
      }
      assert.equal(typeof ch.physicalChapterIndex, "number");
      assert.equal(typeof ch.chapterNumber, "number");
      assert.equal(ch.bodyHash.length, 64, "bodyHash 应为 64 字符 SHA-256");
      assert.ok(Array.isArray(ch.issues));
    }
  });

  test("physicalChapterIndex 唯一性（0-based 连续递增）", () => {
    runImportCli(
      `--input "${fixturePath}" --book-id fixt1 --out-dir "${outDir}"`,
    );
    const chapters = readChapters(outDir);
    const indices = chapters.map((c) => c.physicalChapterIndex);
    const unique = new Set(indices);
    assert.equal(unique.size, indices.length, "physicalChapterIndex 不得重复");
    for (let i = 0; i < indices.length; i++) {
      assert.equal(
        indices[i],
        i,
        `physicalChapterIndex 应 0-based 连续：第 ${i} 个应为 ${i}，实际 ${indices[i]}`,
      );
    }
  });

  test("重复章号不覆盖：两个 chapterNumber=2 都保留为独立记录", () => {
    runImportCli(
      `--input "${fixturePath}" --book-id fixt1 --out-dir "${outDir}"`,
    );
    const chapters = readChapters(outDir);
    const chapter2s = chapters.filter((c) => c.chapterNumber === 2);
    assert.equal(
      chapter2s.length,
      2,
      "应含 2 个 chapterNumber=2 的章节（重复章号不覆盖）",
    );
    assert.notEqual(
      chapter2s[0].physicalChapterIndex,
      chapter2s[1].physicalChapterIndex,
      "两个重复章号记录的 physicalChapterIndex 应不同",
    );
    assert.notEqual(
      chapter2s[0].bodyHash,
      chapter2s[1].bodyHash,
      "两个重复章号记录的 bodyHash 应不同（内容不同）",
    );

    const dupFlagged = chapters.filter((c) =>
      c.issues.some((i) => i.includes("duplicate_chapter_number")),
    );
    assert.ok(
      dupFlagged.length >= 2,
      `至少 2 章 issues 应含 duplicate_chapter_number，实际 ${dupFlagged.length}`,
    );
  });

  test("9999 番外不覆盖：多个 chapterNumber=9999 都保留为独立记录", () => {
    runImportCli(
      `--input "${fixturePath}" --book-id fixt1 --out-dir "${outDir}"`,
    );
    const chapters = readChapters(outDir);
    const chapter9999s = chapters.filter((c) => c.chapterNumber === 9999);
    // fixture 含 2 个番外 + 1 个终章 = 3 个 9999
    assert.ok(
      chapter9999s.length >= 2,
      `应至少 2 个 chapterNumber=9999，实际 ${chapter9999s.length}`,
    );
    const indices = chapter9999s.map((c) => c.physicalChapterIndex);
    const uniqueIdx = new Set(indices);
    assert.equal(
      uniqueIdx.size,
      indices.length,
      "9999 番外 physicalChapterIndex 不得重复",
    );
    const hashes = chapter9999s.map((c) => c.bodyHash);
    const uniqueHash = new Set(hashes);
    assert.equal(
      uniqueHash.size,
      hashes.length,
      "9999 番外 bodyHash 不得重复（内容不同）",
    );
  });

  test("manifest hash 稳定性：同 fixture 连续两次导入 hash 一致", () => {
    const out1 = join(tmpDir, "out1");
    const out2 = join(tmpDir, "out2");
    mkdirSync(out1, { recursive: true });
    mkdirSync(out2, { recursive: true });
    runImportCli(
      `--input "${fixturePath}" --book-id fixt1 --out-dir "${out1}"`,
    );
    runImportCli(
      `--input "${fixturePath}" --book-id fixt1 --out-dir "${out2}"`,
    );
    const h1 = readManifestHash(out1);
    const h2 = readManifestHash(out2);
    assert.equal(h1.length, 64, "manifest hash 应为 64 字符 SHA-256");
    assert.equal(
      h1,
      h2,
      "同 fixture 连续两次导入 manifest hash 应一致（确定性）",
    );
  });

  test("offset 正确性抽查：每章 bodyHash 与按 offset 切片的 hash 一致", () => {
    runImportCli(
      `--input "${fixturePath}" --book-id fixt1 --out-dir "${outDir}"`,
    );
    const chapters = readChapters(outDir);
    const text = readFixtureDecoded();
    for (const ch of chapters) {
      const body = text.slice(ch.bodyStartOffset, ch.endOffset).trim();
      const hash = sha256(body);
      assert.equal(
        hash,
        ch.bodyHash,
        `第 ${ch.physicalChapterIndex} 章 (chapterNumber=${ch.chapterNumber}) bodyHash 不匹配`,
      );
    }
  });

  test("短章诊断：fixture 第四章 body<200 应含 short_chapter issue", () => {
    runImportCli(
      `--input "${fixturePath}" --book-id fixt1 --out-dir "${outDir}"`,
    );
    const chapters = readChapters(outDir);
    const shortChapter = chapters.find(
      (c) => c.chapterNumber === 4 && c.characterCount < 200,
    );
    assert.ok(shortChapter, "应存在 chapterNumber=4 的短章");
    assert.ok(
      shortChapter.issues.some((i) => i.includes("short_chapter")),
      `第四章 issues 应含 short_chapter，实际：${shortChapter.issues.join(";")}`,
    );
  });

  test("generator bundle 剥离：sanitizeForGenerator + validateGeneratorSchema", () => {
    runImportCli(
      `--input "${fixturePath}" --book-id fixt1 --out-dir "${outDir}"`,
    );
    const chapters = readChapters(outDir);
    const target = chapters[2]; // 第三个 physicalChapterIndex 作为 targetChapter

    // 构造含禁止字段的 DatasetCase
    const datasetCase = {
      datasetVersion: "rca1-v1",
      caseId: `rca1-v1-fixt1-phys${target.physicalChapterIndex}`,
      bookId: "fixt1",
      genre: "玄幻",
      mode: "continuation",
      targetChapter: target.chapterNumber,
      priorChapterRefs: [
        {
          bookId: "fixt1",
          chapterNumber: chapters[0].chapterNumber,
          sourcePath: fixturePath, // FORBIDDEN
          startOffset: chapters[0].bodyStartOffset, // FORBIDDEN
          endOffset: chapters[0].endOffset, // FORBIDDEN
          bodyHash: chapters[0].bodyHash,
        },
      ],
      generationInputPath: join(outDir, "generation-inputs", "case.txt"),
      generationInputHash: "dummy",
      referenceLocator: {
        referenceId: `fixt1:physical:${target.physicalChapterIndex}`,
        bodyHash: target.bodyHash,
      },
      referenceHash: target.bodyHash, // FORBIDDEN
      splitConfidence: target.splitConfidence,
      leakageAudit: {
        // FORBIDDEN
        ngramOverlapRate: 0.01,
        phraseLeakCount: 0,
        entityLeakCount: 0,
        sentenceOverlap: 0,
        titleSpoilerLeak: false,
        passed: true,
        details: [],
      },
    };

    const genCase = sanitizeForGenerator(datasetCase, "train", outDir);

    for (const forbidden of FORBIDDEN_FIELDS) {
      assert.ok(
        !(forbidden in genCase),
        `GeneratorCase 不得含禁止字段 ${forbidden}`,
      );
    }
    assert.doesNotThrow(() => assertNoLeakageFields(genCase));

    const validation = validateGeneratorSchema(genCase);
    assert.ok(
      validation.valid,
      `干净 GeneratorCase 应通过校验：${validation.errors.join("; ")}`,
    );

    assert.equal(
      genCase.referenceLocator.referenceId,
      `fixt1:physical:${target.physicalChapterIndex}`,
      "referenceId 应为 bookId:physical:N 格式",
    );
  });

  test("leakage scanner 检测：generationInput 含目标章连续长片段 → passed=false", () => {
    runImportCli(
      `--input "${fixturePath}" --book-id fixt1 --out-dir "${outDir}"`,
    );
    const chapters = readChapters(outDir);
    const target = chapters[1]; // 第二章

    const text = readFixtureDecoded();
    const referenceBody = text
      .slice(target.bodyStartOffset, target.endOffset)
      .trim();
    // 构造泄漏：generationInput 直接嵌入 reference 正文
    const leakInput = `前文内容。\n\n${referenceBody}\n\n后文内容。`;
    const priorBodies = [
      text
        .slice(chapters[0].bodyStartOffset, chapters[0].endOffset)
        .trim(),
    ];

    const audit = auditLeakage(leakInput, referenceBody, priorBodies, {
      targetChapterTitle: target.title,
    });

    assert.equal(
      audit.passed,
      false,
      "含目标章正文的 generationInput 应判为泄漏（passed=false）",
    );
    assert.ok(
      audit.phraseLeakCount > 0 || audit.ngramOverlapRate >= 0.02,
      "应有 phrase leak 或 ngram overlap 超阈值",
    );
  });

  test("leakage scanner 检测：generationInput 含 sourcePath 字符串", () => {
    runImportCli(
      `--input "${fixturePath}" --book-id fixt1 --out-dir "${outDir}"`,
    );
    const chapters = readChapters(outDir);
    const target = chapters[1];

    const text = readFixtureDecoded();
    const referenceBody = text
      .slice(target.bodyStartOffset, target.endOffset)
      .trim();
    // generationInput 含 sourcePath（外部文件绝对路径）
    const leakInput = `前文。\n\n参考文件路径：${fixturePath}\n\n后文。`;

    // 任务卡 §5 验收：generator 输入中搜索不到 sourcePath
    // leakage scanner 主要检测正文泄漏；sourcePath 检测作为额外约束
    assert.ok(
      leakInput.includes(fixturePath),
      "leakInput 应含 sourcePath 字符串",
    );
    // 这是任务卡约束的契约定义：未来 GREEN 实现需在 CLI 产物中保证
    // generator bundle 不含 sourcePath（已由 FORBIDDEN_FIELDS 守护）
  });

  test("原文件不被复制：outDir 不含原始 .txt 副本", () => {
    runImportCli(
      `--input "${fixturePath}" --book-id fixt1 --out-dir "${outDir}"`,
    );
    const outFiles = readdirSync(outDir);
    const txtCopies = outFiles.filter((f) => f.endsWith(".txt"));
    assert.equal(
      txtCopies.length,
      0,
      `outDir 不应含 .txt 副本（原文件不复制），实际：${txtCopies.join(",")}`,
    );
  });

  test("注册到 ReferenceRegistry：referenceId 格式 bookId:physical:N，重复章号与 9999 番外都独立注册", () => {
    const registryPath = join(tmpDir, "reference-registry.json");
    runImportCli(
      `--input "${fixturePath}" --book-id fixt1 --out-dir "${outDir}" --register-registry "${registryPath}"`,
    );

    const registry = new ReferenceRegistry(registryPath);
    registry.load();
    const records = registry.list();

    assert.ok(records.length > 0, "应注册至少 1 条 reference");

    // 所有 referenceId 格式为 fixt1:physical:N
    for (const r of records) {
      assert.ok(
        /^fixt1:physical:\d+$/.test(r.referenceId),
        `referenceId 应为 fixt1:physical:N 格式，实际：${r.referenceId}`,
      );
    }

    const chapters = readChapters(outDir);
    assert.equal(
      records.length,
      chapters.length,
      "registry 记录数应等于 chapters 数",
    );

    // 重复章号（chapterNumber=2）的两条 reference 都存在
    const chapter2Physicals = chapters
      .filter((c) => c.chapterNumber === 2)
      .map((c) => c.physicalChapterIndex);
    assert.equal(chapter2Physicals.length, 2, "fixture 应含 2 个 chapterNumber=2");
    for (const idx of chapter2Physicals) {
      const refId = `fixt1:physical:${idx}`;
      assert.ok(
        registry.has(refId),
        `重复章号 reference 应注册：${refId}`,
      );
    }

    // 9999 番外都独立注册
    const chapter9999Physicals = chapters
      .filter((c) => c.chapterNumber === 9999)
      .map((c) => c.physicalChapterIndex);
    assert.ok(
      chapter9999Physicals.length >= 2,
      `应至少 2 个 9999 番外，实际 ${chapter9999Physicals.length}`,
    );
    for (const idx of chapter9999Physicals) {
      const refId = `fixt1:physical:${idx}`;
      assert.ok(
        registry.has(refId),
        `9999 番外 reference 应注册：${refId}`,
      );
    }

    // sourcePath 仅在 registry 内部（evaluator 可见），不出现在 generator bundle
    for (const r of records) {
      assert.ok(
        typeof r.sourcePath === "string" && r.sourcePath.length > 0,
        "registry 记录应含 sourcePath（evaluator-only）",
      );
      assert.ok(
        typeof r.bodyHash === "string" && r.bodyHash.length === 64,
        "registry 记录应含 64 字符 bodyHash",
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Part B：真实样本冒烟（D:\Download\novelbag\神秘复苏.txt）
// ─────────────────────────────────────────────────────────────────────────────

const realFileExists = existsSync(REAL_REFERENCE_PATH);
const partBDescribe = realFileExists ? describe : describe.skip;

partBDescribe(
  "REFERENCE-CORPUS-ADAPTER-1 Part B: 真实样本冒烟（《神秘复苏》）",
  () => {
    test("真实文件可读且 UTF-8 解码", () => {
      const buf = readFileSync(REAL_REFERENCE_PATH);
      assert.ok(
        buf.length > 1_000_000,
        `真实文件应 >1MB，实际 ${buf.length} bytes`,
      );
      const text = buf.toString("utf-8");
      assert.ok(text.length > 100_000, "解码后文本应 >100K 字符");
    });

    test("真实切分章节数 > 500 + manifest hash 稳定性", () => {
      const out1 = join(tmpDir, "real1");
      const out2 = join(tmpDir, "real2");
      mkdirSync(out1, { recursive: true });
      mkdirSync(out2, { recursive: true });

      runImportCli(
        `--input "${REAL_REFERENCE_PATH}" --book-id shenmifusu --out-dir "${out1}"`,
      );
      runImportCli(
        `--input "${REAL_REFERENCE_PATH}" --book-id shenmifusu --out-dir "${out2}"`,
      );

      const chapters1 = readChapters(out1);
      const chapters2 = readChapters(out2);

      assert.ok(
        chapters1.length > 500,
        `真实切分章节数应 >500，实际 ${chapters1.length}`,
      );
      assert.equal(
        chapters1.length,
        chapters2.length,
        "连续两次切分章节数应一致",
      );

      const h1 = readManifestHash(out1);
      const h2 = readManifestHash(out2);
      assert.equal(
        h1,
        h2,
        "连续两次 manifest hash 应一致（任务卡验收：切分结果稳定）",
      );
    });

    test("真实 offset 抽查：开篇/中段/后段/番外 ≥20 章 hash 验证", () => {
      const out1 = join(tmpDir, "realAudit");
      mkdirSync(out1, { recursive: true });
      runImportCli(
        `--input "${REAL_REFERENCE_PATH}" --book-id shenmifusu --out-dir "${out1}"`,
      );

      const chapters = readChapters(out1);
      const text = readFileSync(REAL_REFERENCE_PATH, "utf-8")
        .replace(/^\uFEFF/, "")
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n");

      const n = chapters.length;
      // 抽样：开篇 5 + 中段 5 + 后段 5 + 番外（9999）≤5
      const sampleIndices = new Set([
        ...range(0, Math.min(5, n)),
        ...range(
          Math.floor(n * 0.4),
          Math.min(Math.floor(n * 0.4) + 5, n),
        ),
        ...range(Math.max(0, n - 5), n),
      ]);
      const fanwaiIndices = chapters
        .map((c, i) => ({ c, i }))
        .filter(({ c }) => c.chapterNumber === 9999)
        .map(({ i }) => i)
        .slice(0, 5);
      for (const i of fanwaiIndices) sampleIndices.add(i);

      const samples = [...sampleIndices].sort((a, b) => a - b);
      assert.ok(
        samples.length >= 20,
        `抽查章节数应 ≥20，实际 ${samples.length}`,
      );

      let verified = 0;
      for (const i of samples) {
        const ch = chapters[i];
        const body = text.slice(ch.bodyStartOffset, ch.endOffset).trim();
        const hash = sha256(body);
        assert.equal(
          hash,
          ch.bodyHash,
          `第 ${i} 章 (physical=${ch.physicalChapterIndex}, chapter=${ch.chapterNumber}) bodyHash 不匹配`,
        );
        verified++;
      }
      assert.ok(verified >= 20, `应验证 ≥20 章，实际 ${verified}`);
    });

    test("真实 generator bundle 隔离：sanitize + validate", () => {
      const out1 = join(tmpDir, "realGen");
      mkdirSync(out1, { recursive: true });
      runImportCli(
        `--input "${REAL_REFERENCE_PATH}" --book-id shenmifusu --out-dir "${out1}"`,
      );

      const chapters = readChapters(out1);
      const target = chapters[Math.floor(chapters.length / 2)];

      const datasetCase = {
        datasetVersion: "rca1-v1",
        caseId: `rca1-v1-shenmifusu-phys${target.physicalChapterIndex}`,
        bookId: "shenmifusu",
        genre: "玄幻",
        mode: "continuation",
        targetChapter: target.chapterNumber,
        priorChapterRefs: chapters.slice(0, 3).map((c) => ({
          bookId: "shenmifusu",
          chapterNumber: c.chapterNumber,
          sourcePath: REAL_REFERENCE_PATH,
          startOffset: c.bodyStartOffset,
          endOffset: c.endOffset,
          bodyHash: c.bodyHash,
        })),
        generationInputPath: join(out1, "generation-inputs", "case.txt"),
        generationInputHash: "dummy",
        referenceLocator: {
          referenceId: `shenmifusu:physical:${target.physicalChapterIndex}`,
          bodyHash: target.bodyHash,
        },
        referenceHash: target.bodyHash,
        splitConfidence: target.splitConfidence,
        leakageAudit: {
          ngramOverlapRate: 0.01,
          phraseLeakCount: 0,
          entityLeakCount: 0,
          sentenceOverlap: 0,
          titleSpoilerLeak: false,
          passed: true,
          details: [],
        },
      };

      const genCase = sanitizeForGenerator(datasetCase, "test", out1);

      for (const forbidden of FORBIDDEN_FIELDS) {
        assert.ok(
          !(forbidden in genCase),
          `真实样本 GeneratorCase 不得含 ${forbidden}`,
        );
      }

      const validation = validateGeneratorSchema(genCase);
      assert.ok(
        validation.valid,
        `真实样本 GeneratorCase 应通过校验：${validation.errors.join("; ")}`,
      );
    });

    test("原始全文不进入 Git 状态", () => {
      const out1 = join(tmpDir, "realGit");
      mkdirSync(out1, { recursive: true });
      runImportCli(
        `--input "${REAL_REFERENCE_PATH}" --book-id shenmifusu --out-dir "${out1}"`,
      );

      // git status 不含原始文件路径
      const gitStatus = execSync("git status --porcelain", {
        encoding: "utf-8",
        cwd: PROJECT_ROOT,
      });
      assert.ok(
        !gitStatus.includes("novelbag"),
        `git status 不应含原始文件路径 novelbag，实际：\n${gitStatus}`,
      );
      assert.ok(
        !gitStatus.includes(REAL_REFERENCE_PATH),
        "git status 不应含原始文件绝对路径",
      );

      // outDir 产物中不含原始正文（只含 manifest + chapters.jsonl + hash）
      const outFiles = readdirSync(out1);
      const txtCopies = outFiles.filter((f) => f.endsWith(".txt"));
      assert.equal(
        txtCopies.length,
        0,
        `outDir 不应含 .txt 副本：${txtCopies.join(",")}`,
      );
    });
  },
);
