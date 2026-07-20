/**
 * NB-2R 生成器进程隔离测试
 *
 * 验证（任务要求）：
 * - Generator process must be isolated from evaluator process
 * - Generator schema must not contain sourcePath, offset, or reference asset paths
 * - Generator process cannot import ReferenceRegistry.resolve()
 *
 * 测试维度：
 * 1. 架构边界：generator-bundle.js + generator-schema-validator.js 编译产物不含
 *    reference-registry / reference-analyzer / dataset-builder / leakage-scanner / chapter-splitter import
 * 2. generator-bundle.js 编译产物不含 .resolve( 调用（registry.resolve 是 evaluator-only）
 * 3. sanitizeForGenerator 剥离 sourcePath / startOffset / endOffset / priorChapterRefs / referenceHash / leakageAudit
 * 4. sanitizeForGenerator generationInputPath 转相对路径（无盘符 / 不以 / 开头）
 * 5. validateGeneratorSchema 拒绝含 sourcePath / startOffset / endOffset / referenceBody 对象
 * 6. validateGeneratorSchema 接受干净 GeneratorCase
 * 7. assertNoLeakageFields 通过干净对象 / 抛出泄漏对象
 * 8. write→read round-trip：sanitize → write → read → deep equal
 * 9. 端到端：buildDataset 发射 generator bundle，schema 校验通过
 * 10. referenceLocator 严格字段集：仅 referenceId + bodyHash，多余字段被拒
 *
 * import 自 dist-eval/novelbench/index.js（lab-only）。
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import {
  sanitizeForGenerator,
  writeGeneratorBundle,
  readGeneratorBundle,
  validateGeneratorSchema,
  assertNoLeakageFields,
  FORBIDDEN_FIELDS,
  buildDataset,
  partitionByBook,
  ReferenceRegistry,
  splitChaptersStrict,
  computeBookId,
  computeAuthorId,
} from "../dist-eval/novelbench/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXT_ROOT = join(__dirname, "..");
const GENERATOR_BUNDLE_JS = join(EXT_ROOT, "dist-eval", "novelbench", "generator-bundle.js");
const GENERATOR_SCHEMA_VALIDATOR_JS = join(EXT_ROOT, "dist-eval", "novelbench", "generator-schema-validator.js");

function sha256(data) {
  return createHash("sha256").update(data, "utf-8").digest("hex");
}

/** 构造一个含 forbidden 字段的合成 DatasetCase（用于 sanitize 测试） */
function makeSyntheticDatasetCase() {
  return {
    datasetVersion: "test-v1",
    caseId: "test-v1-book001-ch4",
    bookId: "book001",
    authorId: "author001",
    genre: "玄幻",
    mode: "continuation",
    targetChapter: 4,
    priorChapterRefs: [
      {
        bookId: "book001",
        chapterNumber: 1,
        sourcePath: "corpus/book001.txt",  // FORBIDDEN: sourcePath
        startOffset: 100,                   // FORBIDDEN: startOffset
        endOffset: 5000,                    // FORBIDDEN: endOffset
        bodyHash: "abc123",
      },
    ],
    generationInputPath: "D:\\CODE\\PiNovelStudio\\data\\novelbench\\datasets\\generation-inputs\\test-v1-book001-ch4.txt",
    generationInputHash: "def456",
    referenceLocator: {
      referenceId: "test-v1-book001-ch4",
      bodyHash: "ghi789",
    },
    referenceHash: "ghi789",
    splitConfidence: 0.95,
    leakageAudit: {  // FORBIDDEN: leakageAudit
      ngramOverlapRate: 0.01,
      phraseLeakCount: 0,
      entityLeakCount: 0,
      sentenceOverlap: 0,
      titleSpoilerLeak: false,
      passed: true,
      details: [],
    },
  };
}

let tmpDir;
let corpusRoot;
let outputDir;
let registryPath;

beforeEach(() => {
  tmpDir = join(tmpdir(), `novelbench-nb2r-${randomUUID()}`);
  corpusRoot = join(tmpDir, "corpus");
  outputDir = join(tmpDir, "datasets");
  registryPath = join(tmpDir, "reference-registry.json");
  mkdirSync(corpusRoot, { recursive: true });
  mkdirSync(outputDir, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // 忽略清理失败
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. 架构边界：编译产物 import 隔离
// ─────────────────────────────────────────────────────────────────────────────

describe("NB-2R 架构边界：generator-bundle.js + generator-schema-validator.js import 隔离", () => {
  test("generator-bundle.js 不 import reference-registry / reference-analyzer / dataset-builder / leakage-scanner / chapter-splitter", () => {
    assert.ok(existsSync(GENERATOR_BUNDLE_JS), "generator-bundle.js 应存在（需先 build）");
    const src = readFileSync(GENERATOR_BUNDLE_JS, "utf-8");
    const forbiddenImports = [
      'from "./reference-registry',
      'from "./reference-analyzer',
      'from "./dataset-builder',
      'from "./leakage-scanner',
      'from "./chapter-splitter',
      'from "./corpus-auditor',
      'from "./partition',
    ];
    for (const pat of forbiddenImports) {
      assert.ok(
        !src.includes(pat),
        `generator-bundle.js 不得 import ${pat}（生成器进程不得依赖 evaluator/dataset-builder 模块）`,
      );
    }
  });

  test("generator-bundle.js 不含 .resolve( 调用（registry.resolve 是 evaluator-only）", () => {
    assert.ok(existsSync(GENERATOR_BUNDLE_JS), "generator-bundle.js 应存在");
    const src = readFileSync(GENERATOR_BUNDLE_JS, "utf-8");
    assert.ok(
      !src.includes(".resolve("),
      "generator-bundle.js 不得含 .resolve( 调用（生成器进程不得调 ReferenceRegistry.resolve）",
    );
  });

  test("generator-bundle.js 不含 ReferenceRegistry 类引用", () => {
    assert.ok(existsSync(GENERATOR_BUNDLE_JS), "generator-bundle.js 应存在");
    const src = readFileSync(GENERATOR_BUNDLE_JS, "utf-8");
    assert.ok(
      !src.includes("ReferenceRegistry"),
      "generator-bundle.js 不得引用 ReferenceRegistry（生成器进程无 reference registry 访问权）",
    );
  });

  test("generator-schema-validator.js 不 import reference-registry / reference-analyzer / dataset-builder", () => {
    assert.ok(existsSync(GENERATOR_SCHEMA_VALIDATOR_JS), "generator-schema-validator.js 应存在");
    const src = readFileSync(GENERATOR_SCHEMA_VALIDATOR_JS, "utf-8");
    const forbiddenImports = [
      'from "./reference-registry',
      'from "./reference-analyzer',
      'from "./dataset-builder',
      'from "./leakage-scanner',
      'from "./chapter-splitter',
    ];
    for (const pat of forbiddenImports) {
      assert.ok(
        !src.includes(pat),
        `generator-schema-validator.js 不得 import ${pat}（schema 校验器是生成器侧工具，不得依赖 evaluator 模块）`,
      );
    }
  });

  test("generator-schema-validator.js 不含 .resolve( 调用", () => {
    assert.ok(existsSync(GENERATOR_SCHEMA_VALIDATOR_JS), "generator-schema-validator.js 应存在");
    const src = readFileSync(GENERATOR_SCHEMA_VALIDATOR_JS, "utf-8");
    assert.ok(
      !src.includes(".resolve("),
      "generator-schema-validator.js 不得含 .resolve( 调用",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. sanitizeForGenerator 剥离禁止字段
// ─────────────────────────────────────────────────────────────────────────────

describe("NB-2R sanitizeForGenerator 剥离禁止字段", () => {
  test("剥离 sourcePath / startOffset / endOffset / priorChapterRefs / referenceHash / leakageAudit / datasetVersion", () => {
    const datasetCase = makeSyntheticDatasetCase();
    const datasetsRoot = "D:\\CODE\\PiNovelStudio\\data\\novelbench\\datasets";
    const genCase = sanitizeForGenerator(datasetCase, "train", datasetsRoot);

    // 禁止字段不得出现
    for (const forbidden of FORBIDDEN_FIELDS) {
      assert.ok(
        !(forbidden in genCase),
        `GeneratorCase 不得含 ${forbidden}，实际存在`,
      );
    }
    // priorChapterRefs 被剥离
    assert.ok(!("priorChapterRefs" in genCase), "GeneratorCase 不得含 priorChapterRefs");
    // referenceHash 被剥离
    assert.ok(!("referenceHash" in genCase), "GeneratorCase 不得含 referenceHash");
    // leakageAudit 被剥离
    assert.ok(!("leakageAudit" in genCase), "GeneratorCase 不得含 leakageAudit");
    // datasetVersion 被剥离
    assert.ok(!("datasetVersion" in genCase), "GeneratorCase 不得含 datasetVersion");
  });

  test("保留必填字段：caseId / bookId / genre / mode / targetChapter / generationInputHash / split / referenceLocator / splitConfidence", () => {
    const datasetCase = makeSyntheticDatasetCase();
    const datasetsRoot = "D:\\CODE\\PiNovelStudio\\data\\novelbench\\datasets";
    const genCase = sanitizeForGenerator(datasetCase, "validation", datasetsRoot);

    assert.equal(genCase.caseId, "test-v1-book001-ch4");
    assert.equal(genCase.bookId, "book001");
    assert.equal(genCase.authorId, "author001");
    assert.equal(genCase.genre, "玄幻");
    assert.equal(genCase.mode, "continuation");
    assert.equal(genCase.targetChapter, 4);
    assert.equal(genCase.generationInputHash, "def456");
    assert.equal(genCase.split, "validation");
    assert.equal(genCase.splitConfidence, 0.95);
    assert.deepEqual(genCase.referenceLocator, {
      referenceId: "test-v1-book001-ch4",
      bodyHash: "ghi789",
    });
  });

  test("generationInputPath 转相对路径（无盘符 / 不以 / 开头 / 不以 \\\\ 开头）", () => {
    const datasetCase = makeSyntheticDatasetCase();
    const datasetsRoot = "D:\\CODE\\PiNovelStudio\\data\\novelbench\\datasets";
    const genCase = sanitizeForGenerator(datasetCase, "test", datasetsRoot);

    assert.equal(
      genCase.generationInputPath,
      "generation-inputs/test-v1-book001-ch4.txt",
      "generationInputPath 应为相对路径（正斜杠分隔）",
    );
    // 无盘符
    assert.ok(!/^[a-zA-Z]:[\\/]/.test(genCase.generationInputPath), "不得含盘符");
    // 不以 / 开头
    assert.ok(!genCase.generationInputPath.startsWith("/"), "不得以 / 开头");
    // 不以 \\ 开头（UNC）
    assert.ok(!genCase.generationInputPath.startsWith("\\\\"), "不得以 \\\\ 开头");
  });

  test("referenceLocator 仅含 referenceId + bodyHash（无 sourcePath）", () => {
    const datasetCase = makeSyntheticDatasetCase();
    const datasetsRoot = "D:\\CODE\\PiNovelStudio\\data\\novelbench\\datasets";
    const genCase = sanitizeForGenerator(datasetCase, "train", datasetsRoot);

    const locator = genCase.referenceLocator;
    assert.ok(locator.referenceId, "referenceLocator 应有 referenceId");
    assert.ok(locator.bodyHash, "referenceLocator 应有 bodyHash");
    assert.equal(locator.sourcePath, undefined, "referenceLocator 不得有 sourcePath");
    assert.deepEqual(
      Object.keys(locator).sort(),
      ["bodyHash", "referenceId"],
      "referenceLocator 应只有 bodyHash + referenceId",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. validateGeneratorSchema
// ─────────────────────────────────────────────────────────────────────────────

describe("NB-2R validateGeneratorSchema", () => {
  test("接受干净 GeneratorCase", () => {
    const datasetCase = makeSyntheticDatasetCase();
    const datasetsRoot = "D:\\CODE\\PiNovelStudio\\data\\novelbench\\datasets";
    const genCase = sanitizeForGenerator(datasetCase, "train", datasetsRoot);

    const result = validateGeneratorSchema(genCase);
    assert.ok(result.valid, `干净 GeneratorCase 应通过校验，errors: ${result.errors.join("; ")}`);
    assert.equal(result.errors.length, 0);
  });

  test("拒绝含 sourcePath 的对象", () => {
    const datasetCase = makeSyntheticDatasetCase();
    const datasetsRoot = "D:\\CODE\\PiNovelStudio\\data\\novelbench\\datasets";
    const genCase = sanitizeForGenerator(datasetCase, "train", datasetsRoot);
    // 注入禁止字段
    genCase.sourcePath = "corpus/book001.txt";

    const result = validateGeneratorSchema(genCase);
    assert.equal(result.valid, false, "含 sourcePath 应拒绝");
    assert.ok(
      result.errors.some((e) => e.includes("sourcePath")),
      `errors 应提及 sourcePath，实际：${result.errors.join("; ")}`,
    );
  });

  test("拒绝含 startOffset / endOffset 的对象", () => {
    const datasetCase = makeSyntheticDatasetCase();
    const datasetsRoot = "D:\\CODE\\PiNovelStudio\\data\\novelbench\\datasets";
    const genCase = sanitizeForGenerator(datasetCase, "train", datasetsRoot);
    genCase.startOffset = 100;
    genCase.endOffset = 5000;

    const result = validateGeneratorSchema(genCase);
    assert.equal(result.valid, false, "含 startOffset/endOffset 应拒绝");
    assert.ok(result.errors.some((e) => e.includes("startOffset")));
    assert.ok(result.errors.some((e) => e.includes("endOffset")));
  });

  test("拒绝含 referenceBody 的对象", () => {
    const datasetCase = makeSyntheticDatasetCase();
    const datasetsRoot = "D:\\CODE\\PiNovelStudio\\data\\novelbench\\datasets";
    const genCase = sanitizeForGenerator(datasetCase, "train", datasetsRoot);
    genCase.referenceBody = "目标章正文...";

    const result = validateGeneratorSchema(genCase);
    assert.equal(result.valid, false, "含 referenceBody 应拒绝");
    assert.ok(result.errors.some((e) => e.includes("referenceBody")));
  });

  test("拒绝含 priorChapterRefs 的对象", () => {
    const datasetCase = makeSyntheticDatasetCase();
    const datasetsRoot = "D:\\CODE\\PiNovelStudio\\data\\novelbench\\datasets";
    const genCase = sanitizeForGenerator(datasetCase, "train", datasetsRoot);
    genCase.priorChapterRefs = [{ sourcePath: "leak" }];

    const result = validateGeneratorSchema(genCase);
    assert.equal(result.valid, false, "含 priorChapterRefs 应拒绝");
    assert.ok(result.errors.some((e) => e.includes("priorChapterRefs")));
  });

  test("拒绝 referenceLocator 含 sourcePath", () => {
    const datasetCase = makeSyntheticDatasetCase();
    const datasetsRoot = "D:\\CODE\\PiNovelStudio\\data\\novelbench\\datasets";
    const genCase = sanitizeForGenerator(datasetCase, "train", datasetsRoot);
    genCase.referenceLocator = {
      referenceId: "x",
      bodyHash: "y",
      sourcePath: "leak.txt",  // 注入禁止字段
    };

    const result = validateGeneratorSchema(genCase);
    assert.equal(result.valid, false, "referenceLocator 含 sourcePath 应拒绝");
    assert.ok(
      result.errors.some((e) => e.includes("referenceLocator") && e.includes("sourcePath")),
      `errors 应提及 referenceLocator.sourcePath，实际：${result.errors.join("; ")}`,
    );
  });

  test("拒绝 referenceLocator 含多余字段", () => {
    const datasetCase = makeSyntheticDatasetCase();
    const datasetsRoot = "D:\\CODE\\PiNovelStudio\\data\\novelbench\\datasets";
    const genCase = sanitizeForGenerator(datasetCase, "train", datasetsRoot);
    genCase.referenceLocator = {
      referenceId: "x",
      bodyHash: "y",
      extraField: "should be rejected",
    };

    const result = validateGeneratorSchema(genCase);
    assert.equal(result.valid, false, "referenceLocator 含多余字段应拒绝");
    assert.ok(result.errors.some((e) => e.includes("extraField")));
  });

  test("拒绝绝对路径 generationInputPath（Windows 盘符）", () => {
    const datasetCase = makeSyntheticDatasetCase();
    const datasetsRoot = "D:\\CODE\\PiNovelStudio\\data\\novelbench\\datasets";
    const genCase = sanitizeForGenerator(datasetCase, "train", datasetsRoot);
    genCase.generationInputPath = "D:\\leak\\absolute\\path.txt";

    const result = validateGeneratorSchema(genCase);
    assert.equal(result.valid, false, "绝对路径 generationInputPath 应拒绝");
    assert.ok(result.errors.some((e) => e.includes("generationInputPath")));
  });

  test("拒绝 Unix 绝对路径 generationInputPath", () => {
    const datasetCase = makeSyntheticDatasetCase();
    const datasetsRoot = "D:\\CODE\\PiNovelStudio\\data\\novelbench\\datasets";
    const genCase = sanitizeForGenerator(datasetCase, "train", datasetsRoot);
    genCase.generationInputPath = "/unix/absolute/path.txt";

    const result = validateGeneratorSchema(genCase);
    assert.equal(result.valid, false, "Unix 绝对路径应拒绝");
  });

  test("拒绝非法 split 值", () => {
    const datasetCase = makeSyntheticDatasetCase();
    const datasetsRoot = "D:\\CODE\\PiNovelStudio\\data\\novelbench\\datasets";
    const genCase = sanitizeForGenerator(datasetCase, "train", datasetsRoot);
    genCase.split = "frozen";  // 非法

    const result = validateGeneratorSchema(genCase);
    assert.equal(result.valid, false, "非法 split 应拒绝");
  });

  test("拒绝非法 mode 值", () => {
    const datasetCase = makeSyntheticDatasetCase();
    const datasetsRoot = "D:\\CODE\\PiNovelStudio\\data\\novelbench\\datasets";
    const genCase = sanitizeForGenerator(datasetCase, "train", datasetsRoot);
    genCase.mode = "leak";  // 非法

    const result = validateGeneratorSchema(genCase);
    assert.equal(result.valid, false, "非法 mode 应拒绝");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. assertNoLeakageFields
// ─────────────────────────────────────────────────────────────────────────────

describe("NB-2R assertNoLeakageFields", () => {
  test("干净 GeneratorCase 不抛", () => {
    const datasetCase = makeSyntheticDatasetCase();
    const datasetsRoot = "D:\\CODE\\PiNovelStudio\\data\\novelbench\\datasets";
    const genCase = sanitizeForGenerator(datasetCase, "train", datasetsRoot);
    // 不应抛
    assert.doesNotThrow(() => assertNoLeakageFields(genCase));
  });

  test("含 sourcePath 抛出", () => {
    const genCase = { caseId: "x", sourcePath: "leak.txt" };
    assert.throws(
      () => assertNoLeakageFields(genCase),
      /sourcePath/,
      "应抛出含 sourcePath 的错误",
    );
  });

  test("含多个禁止字段抛出并列出全部", () => {
    const genCase = { caseId: "x", sourcePath: "leak", startOffset: 1, referenceBody: "body" };
    assert.throws(
      () => assertNoLeakageFields(genCase),
      (err) => {
        assert.ok(err.message.includes("sourcePath"), "错误应含 sourcePath");
        assert.ok(err.message.includes("startOffset"), "错误应含 startOffset");
        assert.ok(err.message.includes("referenceBody"), "错误应含 referenceBody");
        return true;
      },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. write→read round-trip
// ─────────────────────────────────────────────────────────────────────────────

describe("NB-2R writeGeneratorBundle + readGeneratorBundle round-trip", () => {
  test("sanitize → write → read → deep equal", () => {
    const datasetCase = makeSyntheticDatasetCase();
    const datasetsRoot = "D:\\CODE\\PiNovelStudio\\data\\novelbench\\datasets";
    const genCase = sanitizeForGenerator(datasetCase, "test", datasetsRoot);

    const bundleDir = join(tmpDir, "generator-bundles");
    const writtenPath = writeGeneratorBundle(genCase, bundleDir);
    assert.ok(existsSync(writtenPath), "bundle 文件应存在");

    const readBack = readGeneratorBundle(writtenPath);
    assert.deepEqual(readBack, genCase, "read 应等于 write 的对象");
  });

  test("读出的 bundle 通过 schema 校验 + assertNoLeakageFields", () => {
    const datasetCase = makeSyntheticDatasetCase();
    const datasetsRoot = "D:\\CODE\\PiNovelStudio\\data\\novelbench\\datasets";
    const genCase = sanitizeForGenerator(datasetCase, "train", datasetsRoot);

    const bundleDir = join(tmpDir, "generator-bundles");
    const writtenPath = writeGeneratorBundle(genCase, bundleDir);
    const readBack = readGeneratorBundle(writtenPath);

    const validation = validateGeneratorSchema(readBack);
    assert.ok(validation.valid, `读出的 bundle 应通过 schema 校验，errors: ${validation.errors.join("; ")}`);
    assert.doesNotThrow(() => assertNoLeakageFields(readBack));
  });

  test("读出不存在的 bundle 抛出", () => {
    const nonExistent = join(tmpDir, "no-such-bundle.json");
    assert.throws(
      () => readGeneratorBundle(nonExistent),
      /不存在/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. 端到端：buildDataset 发射 generator bundle
// ─────────────────────────────────────────────────────────────────────────────

/** 生成一本含 4 章的合成书（章标题不含书名） */
function makeBookText(title) {
  const chapterTitles = ["暗夜寻踪", "古卷重现", "激流暗涌", "终局抉择"];
  const chapterBodies = [
    `夜色笼罩着古老的城池，主角独自走在空旷的街道上。他紧了紧衣领，目光警惕地扫视着两侧的阴影。远处隐约传来打更人的梆子声，提示着时辰已深。此行目的是寻找一份失落已久的地图残页，据说藏有通往秘境的线索。每一步都需格外小心，因为暗处可能潜伏着未知的危险。`,
    `晨光透过窗棂洒入室内，主角摊开昨夜寻获的残卷仔细端详。泛黄的纸页上墨迹斑驳，依稀可辨几处关键的标记。他取出随身携带的炭笔，在另一张纸上临摹下这些符号。隔壁房间传来同伴准备早膳的声响，提醒他新的一天已经到来。解读这些文字需要时间，但线索似乎指向城外的废墟。`,
    `午后阳光炽烈，主角与对手在集市边缘不期而遇。对方显然有备而来，言辞间暗含试探与威胁。主角不动声色地周旋，暗中观察对方身后的随从配置。空气仿佛凝固了一瞬，周围的行人纷纷绕行。这场无声的交锋虽未诉诸武力，却比刀剑相向更加凶险。`,
    `黄昏时分，主角终于抵达此行的终点。眼前是一座半塌的石塔，藤蔓爬满了残存的墙壁。他深吸一口气，推开摇摇欲坠的木门。内部空间比想象中更为开阔，尽头隐约可见微弱的光芒。多年的追寻即将在此刻揭晓答案。无论结果如何，这段旅程都将画上句号。`,
  ];

  const lines = [];
  lines.push(`《${title}》`);
  lines.push("");
  for (let i = 1; i <= 4; i++) {
    lines.push(`第${i}章 ${chapterTitles[i - 1]}`);
    lines.push("");
    lines.push(chapterBodies[i - 1]);
    lines.push("");
  }
  return lines.join("\n");
}

function setupEndToEndData() {
  const book1Text = makeBookText("星河秘录");
  const book2Text = makeBookText("星河续篇");
  const book3Text = makeBookText("剑影江湖");

  writeFileSync(join(corpusRoot, "星河秘录-作者甲.txt"), book1Text, "utf-8");
  writeFileSync(join(corpusRoot, "星河续篇-作者甲.txt"), book2Text, "utf-8");
  writeFileSync(join(corpusRoot, "剑影江湖-作者乙.txt"), book3Text, "utf-8");

  const manifest = [
    {
      bookId: computeBookId("星河秘录", "作者甲"),
      authorId: computeAuthorId("作者甲"),
      title: "星河秘录",
      author: "作者甲",
      genre: "玄幻",
      sourcePath: "星河秘录-作者甲.txt",
      status: "canonical",
      isProofread: false,
      issues: [],
    },
    {
      bookId: computeBookId("星河续篇", "作者甲"),
      authorId: computeAuthorId("作者甲"),
      title: "星河续篇",
      author: "作者甲",
      genre: "玄幻",
      sourcePath: "星河续篇-作者甲.txt",
      status: "canonical",
      isProofread: false,
      issues: [],
    },
    {
      bookId: computeBookId("剑影江湖", "作者乙"),
      authorId: computeAuthorId("作者乙"),
      title: "剑影江湖",
      author: "作者乙",
      genre: "武侠",
      sourcePath: "剑影江湖-作者乙.txt",
      status: "canonical",
      isProofread: false,
      issues: [],
    },
  ];

  const splits = new Map();
  for (const entry of manifest) {
    const text = readFileSync(join(corpusRoot, entry.sourcePath), "utf-8");
    const result = splitChaptersStrict(text);
    splits.set(entry.bookId, result.chapters);
  }

  return { manifest, splits, corpusRoot };
}

describe("NB-2R 端到端：buildDataset 发射 generator bundle", () => {
  test("buildDataset with generatorBundleDir 发射 sanitized bundle", async () => {
    const { manifest, splits, corpusRoot } = setupEndToEndData();
    const partition = partitionByBook(
      manifest.map((e) => ({ bookId: e.bookId, authorId: e.authorId })),
      { train: 0.7, validation: 0.15, test: 0.15 },
    );
    const registry = new ReferenceRegistry(registryPath);
    const generationInputDir = join(outputDir, "generation-inputs");
    mkdirSync(generationInputDir, { recursive: true });
    const generatorBundleDir = join(outputDir, "generator-bundles");
    mkdirSync(generatorBundleDir, { recursive: true });

    const result = await buildDataset({
      datasetVersion: "test-v1",
      mode: "continuation",
      partition,
      splits,
      manifest,
      corpusRoot,
      outputDir: generationInputDir,
      registry,
      datasetsRoot: outputDir,
      generatorBundleDir,
    });

    assert.ok(result.cases.length > 0, "应至少生成 1 个 case");
    assert.ok(result.generatorBundlesWritten > 0, "应至少写入 1 个 generator bundle");
    assert.equal(
      result.generatorBundlesWritten,
      result.cases.length,
      "generator bundle 数应等于 case 数",
    );

    // 读出每个 bundle，校验 schema + 无禁止字段
    for (const c of result.cases) {
      const bundlePath = join(generatorBundleDir, `${c.caseId}.json`);
      assert.ok(existsSync(bundlePath), `bundle 应存在: ${bundlePath}`);
      const genCase = readGeneratorBundle(bundlePath);

      // schema 校验
      const validation = validateGeneratorSchema(genCase);
      assert.ok(
        validation.valid,
        `bundle ${c.caseId} 应通过 schema 校验，errors: ${validation.errors.join("; ")}`,
      );

      // 无禁止字段
      assert.doesNotThrow(() => assertNoLeakageFields(genCase));

      // 无 sourcePath / startOffset / endOffset / priorChapterRefs
      const json = readFileSync(bundlePath, "utf-8");
      assert.ok(!json.includes("sourcePath"), `bundle ${c.caseId} 不得含 sourcePath`);
      assert.ok(!json.includes("startOffset"), `bundle ${c.caseId} 不得含 startOffset`);
      assert.ok(!json.includes("endOffset"), `bundle ${c.caseId} 不得含 endOffset`);
      assert.ok(!json.includes("priorChapterRefs"), `bundle ${c.caseId} 不得含 priorChapterRefs`);
      assert.ok(!json.includes("referenceBody"), `bundle ${c.caseId} 不得含 referenceBody`);

      // generationInputPath 为相对路径
      assert.ok(
        !/^[a-zA-Z]:[\\/]/.test(genCase.generationInputPath),
        `bundle ${c.caseId} generationInputPath 不得含盘符`,
      );
      assert.ok(
        genCase.generationInputPath.startsWith("generation-inputs/"),
        `bundle ${c.caseId} generationInputPath 应以 generation-inputs/ 开头`,
      );

      // generationInputPath 指向的 .txt bundle 存在
      const txtBundlePath = join(outputDir, genCase.generationInputPath);
      assert.ok(existsSync(txtBundlePath), `generationInput .txt 应存在: ${txtBundlePath}`);
    }
  });

  test("buildDataset without generatorBundleDir 不发射 bundle（向后兼容）", async () => {
    const { manifest, splits, corpusRoot } = setupEndToEndData();
    const partition = partitionByBook(
      manifest.map((e) => ({ bookId: e.bookId, authorId: e.authorId })),
      { train: 0.7, validation: 0.15, test: 0.15 },
    );
    const registry = new ReferenceRegistry(registryPath);
    const generationInputDir = join(outputDir, "generation-inputs");
    mkdirSync(generationInputDir, { recursive: true });

    const result = await buildDataset({
      datasetVersion: "test-v1",
      mode: "continuation",
      partition,
      splits,
      manifest,
      corpusRoot,
      outputDir: generationInputDir,
      registry,
      datasetsRoot: outputDir,
      // 不传 generatorBundleDir
    });

    assert.ok(result.cases.length > 0, "应至少生成 1 个 case");
    assert.equal(result.generatorBundlesWritten, 0, "不传 generatorBundleDir 时不应写 bundle");
  });
});
