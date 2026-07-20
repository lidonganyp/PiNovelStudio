/**
 * NB-2 数据集构建器测试
 *
 * 验证：
 * - 架构边界：dataset-builder.js 编译产物不含 .resolve( 调用
 * - 分区完整性：同作者全作品在同 split；同 bookId 不跨 split
 * - generationInputHash 重算：读 bundle 重算 sha256 === case.generationInputHash
 * - case JSON 无 sourcePath：referenceLocator 仅 referenceId + bodyHash
 * - continuation 无目标章：leakageAudit.passed===true
 * - round-trip reference：ReferenceRegistry.resolve(referenceId) → sha256(body)===referenceHash
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
const DATASET_BUILDER_JS = join(EXT_ROOT, "dist-eval", "novelbench", "dataset-builder.js");

function sha256(data) {
  return createHash("sha256").update(data, "utf-8").digest("hex");
}

/** 生成一本含 4 章的合成书（章标题不含书名，章正文各不相同） */
function makeBookText(title) {
  // 章标题与书名完全不同，避免 titleSpoilerLeak 误判
  const chapterTitles = ["暗夜寻踪", "古卷重现", "激流暗涌", "终局抉择"];
  // 每章正文使用不同句子，避免跨章句子重叠
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

let tmpDir;
let corpusRoot;
let outputDir;
let registryPath;

beforeEach(() => {
  tmpDir = join(tmpdir(), `novelbench-nb2-${randomUUID()}`);
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

/** 构造测试数据：2 本书（同作者）+ 1 本书（不同作者），返回 { manifest, splits, corpusRoot } */
function setupTestData() {
  // 书 1 和书 2 同作者，书 3 不同作者
  const book1Text = makeBookText("星河秘录");
  const book2Text = makeBookText("星河续篇");
  const book3Text = makeBookText("剑影江湖");

  writeFileSync(join(corpusRoot, "星河秘录-作者甲.txt"), book1Text, "utf-8");
  writeFileSync(join(corpusRoot, "星河续篇-作者甲.txt"), book2Text, "utf-8");
  writeFileSync(join(corpusRoot, "剑影江湖-作者乙.txt"), book3Text, "utf-8");

  const authorJia = computeAuthorId("作者甲");
  const authorYi = computeAuthorId("作者乙");

  const manifest = [
    {
      bookId: computeBookId("星河秘录", "作者甲"),
      authorId: authorJia,
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
      authorId: authorJia,
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
      authorId: authorYi,
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

describe("NB-2 数据集构建器", () => {
  test("架构边界：dataset-builder.js 不含 .resolve( 调用", () => {
    assert.ok(existsSync(DATASET_BUILDER_JS), "dataset-builder.js 应存在（需先 build）");
    const src = readFileSync(DATASET_BUILDER_JS, "utf-8");
    // 检查不含 .resolve( 方法调用（registry.resolve 是 evaluator-only）
    // 注意：resolveReferenceBody 是裸函数调用，不匹配 .resolve(
    // resolve from node:path 也是裸函数调用
    assert.ok(
      !src.includes(".resolve("),
      "dataset-builder.js 不得含 .resolve( 方法调用（generator 路径不得调 registry.resolve；架构边界）",
    );
  });

  test("分区完整性：同作者全作品在同 split；同 bookId 不跨 split", () => {
    const { manifest } = setupTestData();
    const partition = partitionByBook(
      manifest.map((e) => ({ bookId: e.bookId, authorId: e.authorId })),
      { train: 0.7, validation: 0.15, test: 0.15 },
    );

    // 同作者全作品在同 split
    const authorJiaBooks = manifest.filter((e) => e.author).filter((e) => e.author === "作者甲");
    if (authorJiaBooks.length >= 2) {
      const splits = ["train", "validation", "test"];
      const locations = authorJiaBooks.map((b) => {
        for (const s of splits) {
          if (partition[s].includes(b.bookId)) return s;
        }
        return null;
      });
      const allSame = locations.every((l) => l === locations[0]);
      assert.ok(allSame, `同作者作品应在同 split，实际 locations: ${JSON.stringify(locations)}`);
    }

    // 同 bookId 不跨 split：所有 bookId 应只出现在一个 split 中
    const allBookIds = manifest.map((e) => e.bookId);
    for (const id of allBookIds) {
      const count =
        (partition.train.includes(id) ? 1 : 0) +
        (partition.validation.includes(id) ? 1 : 0) +
        (partition.test.includes(id) ? 1 : 0);
      assert.equal(count, 1, `bookId ${id} 应只出现在 1 个 split，实际 ${count}`);
    }

    // 所有 bookId 都被分配
    const assigned = [...partition.train, ...partition.validation, ...partition.test];
    assert.equal(assigned.length, allBookIds.length, "所有 bookId 应被分配");
  });

  test("generationInputHash 重算：读 bundle 重算 sha256 === case.generationInputHash", async () => {
    const { manifest, splits, corpusRoot } = setupTestData();
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
    });

    assert.ok(result.cases.length > 0, "应至少生成 1 个 case");
    for (const c of result.cases) {
      assert.ok(existsSync(c.generationInputPath), `bundle 应存在: ${c.generationInputPath}`);
      const bundleContent = readFileSync(c.generationInputPath, "utf-8");
      const recomputed = sha256(bundleContent);
      assert.equal(
        recomputed,
        c.generationInputHash,
        `case ${c.caseId}: 重算 sha256 应等于 generationInputHash`,
      );
    }
  });

  test("case JSON 无 sourcePath：referenceLocator 仅 referenceId + bodyHash", async () => {
    const { manifest, splits, corpusRoot } = setupTestData();
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
    });

    for (const c of result.cases) {
      // referenceLocator 应只有 referenceId 和 bodyHash，无 sourcePath
      const locator = c.referenceLocator;
      assert.ok(locator.referenceId, "referenceLocator 应有 referenceId");
      assert.ok(locator.bodyHash, "referenceLocator 应有 bodyHash");
      assert.equal(locator.sourcePath, undefined, "referenceLocator 不应有 sourcePath");
      assert.equal(
        Object.keys(locator).sort().join(","),
        "bodyHash,referenceId",
        "referenceLocator 应只有 bodyHash + referenceId 字段",
      );
    }
  });

  test("continuation 无目标章：leakageAudit.passed===true", async () => {
    const { manifest, splits, corpusRoot } = setupTestData();
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
    });

    assert.ok(result.cases.length > 0, "应至少生成 1 个 case");
    // continuation 模式：generationInput 只含前章 + workGoal，不含目标章正文
    // leakageAudit.passed 应为 true（无泄漏）
    for (const c of result.cases) {
      assert.equal(c.mode, "continuation");
      // 验证 generationInput 不含目标章正文（通过 leakage audit）
      assert.equal(
        c.leakageAudit.passed,
        true,
        `case ${c.caseId}: continuation 不应泄漏目标章，实际 details: ${c.leakageAudit.details.join("; ")}`,
      );
    }
  });

  test("round-trip reference：resolve(referenceId) → sha256(body)===referenceHash", async () => {
    const { manifest, splits, corpusRoot } = setupTestData();
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
    });

    assert.ok(result.cases.length > 0, "应至少生成 1 个 case");
    // round-trip：registry.resolve 应返回 body，其 sha256 === referenceHash
    for (const c of result.cases) {
      const body = registry.resolve(c.referenceLocator.referenceId);
      assert.ok(body !== null, `case ${c.caseId}: resolve 应返回 body（非 null）`);
      const bodyHash = sha256(body);
      assert.equal(
        bodyHash,
        c.referenceHash,
        `case ${c.caseId}: sha256(resolve body) 应等于 referenceHash`,
      );
    }
  });
});
