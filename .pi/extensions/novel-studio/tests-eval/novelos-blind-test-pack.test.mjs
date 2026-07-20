/**
 * NovelOS Blind Test Pack 测试（D.3）
 *
 * 验证 prepareBlindTestPack 的正确性：
 * 1. 三文件存在：A.txt/B.txt/C.txt
 * 2. mapping.csv 格式正确（header + 3 data rows，source ∈ {b1,b2,b3}）
 * 3. fixture-id.txt 内容正确
 * 4. 确定性：同一 fixture 多次调用产出相同 mapping
 * 5. 映射正确性：A/B/C 文件内容与 candidates[source].text 对应
 * 6. 洗牌逻辑正确性：mapping 顺序与 sha256(fixture.id) % 6 → PERMUTATIONS 一致；
 *    且不同 fixture.id 产生不同排列（验证洗牌确实分布）
 *
 * 测试从 ../dist/ 导入构建产物（遵循 project_memory 教训）。
 * prepareBlindTestPack 只访问 fixture.id，故用最小内联 fixture 保持自包含。
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { prepareBlindTestPack } from "../dist-eval/novelos/eval/blind-test-pack.js";

// ============================================================================
// 常量（与源码 blind-test-pack.ts 完全一致，用于验证洗牌逻辑）
// ============================================================================

/** 3! = 6 种 b1/b2/b3 排列（与源码 PERMUTATIONS 一致） */
const PERMUTATIONS = [
  ["b1", "b2", "b3"],
  ["b1", "b3", "b2"],
  ["b2", "b1", "b3"],
  ["b2", "b3", "b1"],
  ["b3", "b1", "b2"],
  ["b3", "b2", "b1"],
];

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 用与源码相同的逻辑计算 fixture.id 对应的预期排列顺序。
 * sha256(fixtureId).slice(0,8) → parseInt(hex, 16) → % 6 → PERMUTATIONS[idx]
 */
function computeExpectedOrder(fixtureId) {
  const seed = createHash("sha256").update(fixtureId, "utf8").digest("hex");
  const seedNum = parseInt(seed.slice(0, 8), 16);
  return PERMUTATIONS[seedNum % PERMUTATIONS.length];
}

/** 构造 3 个可区分候选（b1/b2/b3 各含不同文本） */
function makeCandidates() {
  return [
    { mode: "b1", text: "这是 B1 基线正文，直接从 CompiledContext 生成。" },
    { mode: "b2", text: "这是 B2 基线正文，经过 agentic 检索后生成。" },
    { mode: "b3", text: "这是 B3 基线正文，经过检索 + verifier + patch 后生成。" },
  ];
}

/** 构造最小 fixture（prepareBlindTestPack 只访问 fixture.id） */
function makeFixture(id) {
  return { id };
}

// ============================================================================
// 临时目录管理
// ============================================================================

const tmpRoots = [];

function makeTmpDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpRoots.length > 0) {
    const root = tmpRoots.pop();
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // 忽略清理失败
    }
  }
});

// ============================================================================
// 测试
// ============================================================================

describe("NovelOS Blind Test Pack（D.3）", () => {
  it("三文件存在：prepareBlindTestPack 写入 A.txt/B.txt/C.txt", () => {
    const outputDir = makeTmpDir("novelos-blind-1-");
    const fixture = makeFixture("blind-test-fixture-1");
    const candidates = makeCandidates();

    prepareBlindTestPack(fixture, candidates, outputDir);

    assert.ok(existsSync(join(outputDir, "A.txt")), "A.txt 应存在");
    assert.ok(existsSync(join(outputDir, "B.txt")), "B.txt 应存在");
    assert.ok(existsSync(join(outputDir, "C.txt")), "C.txt 应存在");
  });

  it("mapping.csv 格式正确：header + 3 data rows，source ∈ {b1,b2,b3}", () => {
    const outputDir = makeTmpDir("novelos-blind-2-");
    const fixture = makeFixture("blind-test-fixture-2");
    const candidates = makeCandidates();

    prepareBlindTestPack(fixture, candidates, outputDir);

    const csv = readFileSync(join(outputDir, "mapping.csv"), "utf-8");
    const lines = csv.split("\n").filter((l) => l.length > 0);

    // header + 3 data rows
    assert.equal(lines.length, 4, "mapping.csv 应有 4 行（header + 3 data）");
    assert.equal(lines[0], "file,source,fixture_id", "header 应为 file,source,fixture_id");

    const validSources = new Set(["b1", "b2", "b3"]);
    const dataRows = lines.slice(1);
    const sources = new Set();
    for (const row of dataRows) {
      const fields = row.split(",");
      assert.equal(fields.length, 3, `每行应有 3 字段，实际：${row}`);
      assert.ok(["A.txt", "B.txt", "C.txt"].includes(fields[0]), `file 应为 A/B/C.txt，实际：${fields[0]}`);
      assert.ok(validSources.has(fields[1]), `source 应为 b1/b2/b3，实际：${fields[1]}`);
      assert.equal(fields[2], fixture.id, `fixture_id 应为 ${fixture.id}，实际：${fields[2]}`);
      sources.add(fields[1]);
    }
    // 3 个 data row 应覆盖全部 3 个 source（无重复）
    assert.equal(sources.size, 3, "3 个 data row 应覆盖 b1/b2/b3 各一次");
  });

  it("fixture-id.txt 内容正确：等于 fixture.id", () => {
    const outputDir = makeTmpDir("novelos-blind-3-");
    const fixture = makeFixture("blind-test-fixture-3");
    const candidates = makeCandidates();

    prepareBlindTestPack(fixture, candidates, outputDir);

    const content = readFileSync(join(outputDir, "fixture-id.txt"), "utf-8");
    assert.equal(content, fixture.id, "fixture-id.txt 内容应等于 fixture.id");
  });

  it("确定性：同一 fixture 多次调用产出相同 mapping", () => {
    const fixture = makeFixture("blind-test-fixture-4");
    const candidates = makeCandidates();

    const dir1 = makeTmpDir("novelos-blind-4a-");
    const dir2 = makeTmpDir("novelos-blind-4b-");

    const pack1 = prepareBlindTestPack(fixture, candidates, dir1);
    const pack2 = prepareBlindTestPack(fixture, candidates, dir2);

    assert.deepEqual(
      pack1.mapping,
      pack2.mapping,
      "同一 fixture 多次调用应产出完全相同的 mapping",
    );

    // 文件内容也应一致
    for (const label of ["A.txt", "B.txt", "C.txt"]) {
      const content1 = readFileSync(join(dir1, label), "utf-8");
      const content2 = readFileSync(join(dir2, label), "utf-8");
      assert.equal(content1, content2, `${label} 内容应一致`);
    }
  });

  it("映射正确性：A/B/C 文件内容与 candidates[source].text 对应", () => {
    const outputDir = makeTmpDir("novelos-blind-5-");
    const fixture = makeFixture("blind-test-fixture-5");
    const candidates = makeCandidates();

    const pack = prepareBlindTestPack(fixture, candidates, outputDir);

    // 构造 source → text 映射
    const sourceToText = new Map();
    for (const c of candidates) {
      sourceToText.set(c.mode, c.text);
    }

    // 每个 mapping 条目的文件内容应等于 candidates[source].text
    for (const m of pack.mapping) {
      const fileContent = readFileSync(join(outputDir, m.file), "utf-8");
      const expectedText = sourceToText.get(m.source);
      assert.equal(
        fileContent,
        expectedText,
        `${m.file} 内容应等于 candidates[${m.source}].text`,
      );
    }
  });

  it("洗牌逻辑正确性：mapping 顺序与 sha256(fixture.id)%6 一致，且不同 fixture 产生不同排列", () => {
    // 验证多个 fixture 的 mapping 顺序与预期排列一致
    const fixtureIds = [
      "blind-test-fixture-6a",
      "blind-test-fixture-6b",
      "blind-test-fixture-6c",
      "blind-test-fixture-6d",
      "blind-test-fixture-6e",
      "blind-test-fixture-6f",
    ];
    const candidates = makeCandidates();
    const seenOrders = new Set();

    for (const id of fixtureIds) {
      const outputDir = makeTmpDir(`novelos-blind-6-${id}-`);
      const fixture = makeFixture(id);
      const pack = prepareBlindTestPack(fixture, candidates, outputDir);

      // 实际 mapping 的 source 顺序
      const actualOrder = pack.mapping.map((m) => m.source);
      // 预期排列
      const expectedOrder = computeExpectedOrder(id);

      assert.deepEqual(
        actualOrder,
        expectedOrder,
        `fixture ${id} 的 mapping 顺序应与 sha256(%6) 一致`,
      );

      seenOrders.add(JSON.stringify(actualOrder));
    }

    // 至少存在 2 种不同排列（验证洗牌确实分布，而非固定输出）
    assert.ok(
      seenOrders.size >= 2,
      `6 个不同 fixture 应产生 ≥2 种排列，实际 ${seenOrders.size} 种`,
    );
  });
});
