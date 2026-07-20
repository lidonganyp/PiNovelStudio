/**
 * REFERENCE-HOLDOUT-SPLIT-1 测试（RED 阶段）
 *
 * 验收任务卡 §6 REFERENCE-HOLDOUT-SPLIT-1：
 * 防止根据已看过的 reference 反复调 prompt，形成样本过拟合。
 *
 * 核心要求：
 * - 首轮最少 60 章：分析集 30 章 / 验证集 15 章 / 冻结测试集 15 章
 * - 样本需覆盖 9 类：开篇与异常首次出现 / 日常转恐怖 / 规则发现 / 调查与信息释放 /
 *   生存选择与代价 / 人物冲突 / 阶段高潮 / 高压章末 / 过渡章节
 * - split manifest 固定 seed、样本 ID 和 hash
 * - 同一连续故事窗口不能跨分析集和冻结测试集（buffer=2 章最小间隔，避免相邻章节泄漏）
 * - 调参程序无冻结测试集 reference 解封权限
 * - 任何查看冻结 reference 的行为写入审计日志并使本轮结果失效
 *
 * 实现：
 * - scripts/novelbench/holdout-split.mjs           生成 split-manifest.json + split-hash.sha256 + frozen-access-audit.jsonl
 * - scripts/novelbench/audit-frozen-access.mjs     审计日志记录 / 检查轮次有效性
 *
 * 输入：REFERENCE-CORPUS-ADAPTER-1 的 chapters.jsonl（含 physicalChapterIndex / bodyHash / chapterNumber 等）
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
  appendFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXT_ROOT = join(__dirname, "..");
// EXT_ROOT = .pi/extensions/novel-studio；向上 3 级 = PiNovelStudio 仓库根
const PROJECT_ROOT = join(EXT_ROOT, "..", "..", "..");
const SPLIT_CLI_PATH = join(
  PROJECT_ROOT,
  "scripts",
  "novelbench",
  "holdout-split.mjs",
);
const AUDIT_CLI_PATH = join(
  PROJECT_ROOT,
  "scripts",
  "novelbench",
  "audit-frozen-access.mjs",
);
const IMPORT_CLI_PATH = join(
  PROJECT_ROOT,
  "scripts",
  "novelbench",
  "import-external-reference.mjs",
);
const REAL_REFERENCE_PATH = "D:\\Download\\novelbag\\神秘复苏.txt";

function sha256(data) {
  return createHash("sha256").update(data, "utf-8").digest("hex");
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixture：合成 chapters.jsonl（每行一个 ExternalChapterManifestEntry）
// 字段对齐 import-external-reference.mjs 产物
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 生成 N 章合成 chapters.jsonl。
 * 每章 bodyHash 唯一，characterCount 足够大以避免短章标记。
 */
function makeChaptersJsonl(bookId, count) {
  const records = [];
  for (let i = 0; i < count; i++) {
    // bodyHash 唯一：sha256(bookId + ":" + i)
    const bodyHash = sha256(`${bookId}:${i}:body`);
    records.push({
      bookId,
      physicalChapterIndex: i,
      chapterNumber: i + 1,
      heading: `第${i + 1}章 测试章节${i + 1}`,
      title: `测试章节${i + 1}`,
      startOffset: i * 1000,
      bodyStartOffset: i * 1000 + 20,
      endOffset: (i + 1) * 1000,
      bodyHash,
      characterCount: 950 + (i % 50),
      splitConfidence: 0.9,
      issues: [],
    });
  }
  return records.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

/** 计算 chapters.jsonl 的 sha256（与 import-external-reference.mjs 一致） */
function computeChaptersJsonlHash(jsonlContent) {
  return sha256(jsonlContent);
}

// ─────────────────────────────────────────────────────────────────────────────
// 辅助
// ─────────────────────────────────────────────────────────────────────────────

let tmpDir;
let chaptersJsonlPath;
let outDir;

beforeEach(() => {
  tmpDir = join(tmpdir(), `rhs1-${randomUUID()}`);
  chaptersJsonlPath = join(tmpDir, "chapters.jsonl");
  outDir = join(tmpDir, "out");
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // 忽略清理失败
  }
});

function writeChaptersJsonl(bookId, count) {
  const content = makeChaptersJsonl(bookId, count);
  writeFileSync(chaptersJsonlPath, content, "utf-8");
  return content;
}

function runSplitCli(args) {
  if (!existsSync(SPLIT_CLI_PATH)) {
    assert.fail(
      `CLI 不存在：${SPLIT_CLI_PATH}（REFERENCE-HOLDOUT-SPLIT-1 GREEN 未实现）`,
    );
  }
  const cmd = `node "${SPLIT_CLI_PATH}" ${args}`;
  return execSync(cmd, { encoding: "utf-8", cwd: PROJECT_ROOT });
}

function runAuditCli(args) {
  if (!existsSync(AUDIT_CLI_PATH)) {
    assert.fail(
      `CLI 不存在：${AUDIT_CLI_PATH}（REFERENCE-HOLDOUT-SPLIT-1 GREEN 未实现）`,
    );
  }
  const cmd = `node "${AUDIT_CLI_PATH}" ${args}`;
  return execSync(cmd, { encoding: "utf-8", cwd: PROJECT_ROOT });
}

function readSplitManifest(out) {
  return JSON.parse(readFileSync(join(out, "split-manifest.json"), "utf-8"));
}

function readSplitHash(out) {
  return readFileSync(join(out, "split-hash.sha256"), "utf-8").trim();
}

function readAuditLog(out) {
  const p = join(out, "frozen-access-audit.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

// ─────────────────────────────────────────────────────────────────────────────
// Part A：fixture-based（合成 100 章 chapters.jsonl）
// ─────────────────────────────────────────────────────────────────────────────

describe("REFERENCE-HOLDOUT-SPLIT-1 Part A: fixture-based", () => {
  test("CLI 文件存在：scripts/novelbench/holdout-split.mjs", () => {
    assert.ok(existsSync(SPLIT_CLI_PATH), `CLI 应存在：${SPLIT_CLI_PATH}`);
  });

  test("导入后产物存在：split-manifest.json + split-hash.sha256 + frozen-access-audit.jsonl", () => {
    writeChaptersJsonl("fixt1", 100);
    runSplitCli(
      `--input "${chaptersJsonlPath}" --book-id fixt1 --out-dir "${outDir}"`,
    );
    assert.ok(
      existsSync(join(outDir, "split-manifest.json")),
      "split-manifest.json 应存在",
    );
    assert.ok(
      existsSync(join(outDir, "split-hash.sha256")),
      "split-hash.sha256 应存在",
    );
    assert.ok(
      existsSync(join(outDir, "frozen-access-audit.jsonl")),
      "frozen-access-audit.jsonl 应存在（即使为空文件）",
    );
  });

  test("split-manifest.json schema 完整性（含 seed / counts / buffer / 三集合 / sourceManifestHash）", () => {
    writeChaptersJsonl("fixt1", 100);
    runSplitCli(
      `--input "${chaptersJsonlPath}" --book-id fixt1 --out-dir "${outDir}" --seed 42`,
    );
    const m = readSplitManifest(outDir);

    assert.equal(m.schemaVersion, 1, "schemaVersion 应为 1");
    assert.equal(m.bookId, "fixt1");
    assert.equal(m.sourceManifestPath, chaptersJsonlPath);
    assert.ok(
      typeof m.sourceManifestHash === "string" &&
        m.sourceManifestHash.length === 64,
      "sourceManifestHash 应为 64 字符 SHA-256",
    );
    assert.equal(m.sourceChapterCount, 100);
    assert.equal(m.seed, 42, "seed 应固定为 42");
    assert.equal(m.buffer, 2, "默认 buffer 应为 2");

    assert.deepEqual(m.counts, {
      analysis: 30,
      validation: 15,
      frozenTest: 15,
    });

    assert.ok(Array.isArray(m.analysisSet));
    assert.ok(Array.isArray(m.validationSet));
    assert.ok(Array.isArray(m.frozenTestSet));
    assert.ok(typeof m.splitHash === "string" && m.splitHash.length === 64);
    assert.ok(
      typeof m.createdAt === "string" && m.createdAt.length > 0,
      "createdAt 应为 ISO 时间字符串",
    );
  });

  test("三集合样本数符合 30/15/15 默认", () => {
    writeChaptersJsonl("fixt1", 100);
    runSplitCli(
      `--input "${chaptersJsonlPath}" --book-id fixt1 --out-dir "${outDir}"`,
    );
    const m = readSplitManifest(outDir);
    assert.equal(m.analysisSet.length, 30, "analysisSet 应含 30 章");
    assert.equal(m.validationSet.length, 15, "validationSet 应含 15 章");
    assert.equal(m.frozenTestSet.length, 15, "frozenTestSet 应含 15 章");
  });

  test("每条样本含 referenceId / physicalChapterIndex / bodyHash / coverageGuess", () => {
    writeChaptersJsonl("fixt1", 100);
    runSplitCli(
      `--input "${chaptersJsonlPath}" --book-id fixt1 --out-dir "${outDir}"`,
    );
    const m = readSplitManifest(outDir);
    const all = [
      ...m.analysisSet,
      ...m.validationSet,
      ...m.frozenTestSet,
    ];

    for (const entry of all) {
      assert.ok(
        typeof entry.referenceId === "string" && entry.referenceId.length > 0,
        `referenceId 应非空：${JSON.stringify(entry)}`,
      );
      assert.ok(
        entry.referenceId.startsWith("fixt1:physical:"),
        `referenceId 应以 'fixt1:physical:' 开头（与 RCA-1 一致），实际：${entry.referenceId}`,
      );
      assert.equal(
        typeof entry.physicalChapterIndex,
        "number",
        "physicalChapterIndex 应为 number",
      );
      assert.ok(
        typeof entry.bodyHash === "string" && entry.bodyHash.length === 64,
        "bodyHash 应为 64 字符 SHA-256",
      );
      assert.ok(
        typeof entry.coverageGuess === "string" &&
          entry.coverageGuess.length > 0,
        `coverageGuess 应非空：${JSON.stringify(entry)}`,
      );
    }
  });

  test("frozenTestSet 条目含 sealed:true（标记冻结状态）", () => {
    writeChaptersJsonl("fixt1", 100);
    runSplitCli(
      `--input "${chaptersJsonlPath}" --book-id fixt1 --out-dir "${outDir}"`,
    );
    const m = readSplitManifest(outDir);
    for (const entry of m.frozenTestSet) {
      assert.equal(
        entry.sealed,
        true,
        `frozenTestSet 条目应 sealed:true：${JSON.stringify(entry)}`,
      );
    }
    // analysis / validation 不应带 sealed:true
    for (const entry of m.analysisSet) {
      assert.notEqual(entry.sealed, true, "analysisSet 条目不应 sealed:true");
    }
    for (const entry of m.validationSet) {
      assert.notEqual(entry.sealed, true, "validationSet 条目不应 sealed:true");
    }
  });

  test("physicalChapterIndex 全集唯一（三集合不重叠）", () => {
    writeChaptersJsonl("fixt1", 100);
    runSplitCli(
      `--input "${chaptersJsonlPath}" --book-id fixt1 --out-dir "${outDir}"`,
    );
    const m = readSplitManifest(outDir);
    const all = [
      ...m.analysisSet,
      ...m.validationSet,
      ...m.frozenTestSet,
    ];
    const indices = all.map((e) => e.physicalChapterIndex);
    const unique = new Set(indices);
    assert.equal(
      unique.size,
      indices.length,
      "physicalChapterIndex 在三集合间不得重复",
    );
  });

  test("physicalChapterIndex 在源 chapters.jsonl 范围内", () => {
    writeChaptersJsonl("fixt1", 100);
    runSplitCli(
      `--input "${chaptersJsonlPath}" --book-id fixt1 --out-dir "${outDir}"`,
    );
    const m = readSplitManifest(outDir);
    const all = [
      ...m.analysisSet,
      ...m.validationSet,
      ...m.frozenTestSet,
    ];
    for (const entry of all) {
      assert.ok(
        entry.physicalChapterIndex >= 0 &&
          entry.physicalChapterIndex < m.sourceChapterCount,
        `physicalChapterIndex 应在 [0, ${m.sourceChapterCount})，实际：${entry.physicalChapterIndex}`,
      );
    }
  });

  test("bodyHash 与源 chapters.jsonl 对应记录一致", () => {
    const jsonlContent = writeChaptersJsonl("fixt1", 100);
    const sourceRecords = jsonlContent
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    runSplitCli(
      `--input "${chaptersJsonlPath}" --book-id fixt1 --out-dir "${outDir}"`,
    );
    const m = readSplitManifest(outDir);
    const all = [
      ...m.analysisSet,
      ...m.validationSet,
      ...m.frozenTestSet,
    ];
    for (const entry of all) {
      const src = sourceRecords[entry.physicalChapterIndex];
      assert.ok(src, `源记录缺失：physicalChapterIndex=${entry.physicalChapterIndex}`);
      assert.equal(
        entry.bodyHash,
        src.bodyHash,
        `bodyHash 应与源记录一致：physicalChapterIndex=${entry.physicalChapterIndex}`,
      );
    }
  });

  test("sourceManifestHash 与源 chapters.jsonl 的 sha256 一致", () => {
    const jsonlContent = writeChaptersJsonl("fixt1", 100);
    const expectedHash = computeChaptersJsonlHash(jsonlContent);
    runSplitCli(
      `--input "${chaptersJsonlPath}" --book-id fixt1 --out-dir "${outDir}"`,
    );
    const m = readSplitManifest(outDir);
    assert.equal(
      m.sourceManifestHash,
      expectedHash,
      "sourceManifestHash 应等于源 chapters.jsonl 的 sha256",
    );
  });

  test("确定性：同 seed + 同输入 → 同 splitHash", () => {
    writeChaptersJsonl("fixt1", 100);
    const out1 = join(tmpDir, "out1");
    const out2 = join(tmpDir, "out2");
    mkdirSync(out1, { recursive: true });
    mkdirSync(out2, { recursive: true });
    runSplitCli(
      `--input "${chaptersJsonlPath}" --book-id fixt1 --out-dir "${out1}" --seed 42`,
    );
    runSplitCli(
      `--input "${chaptersJsonlPath}" --book-id fixt1 --out-dir "${out2}" --seed 42`,
    );
    const h1 = readSplitHash(out1);
    const h2 = readSplitHash(out2);
    assert.equal(h1.length, 64, "split-hash 应为 64 字符 SHA-256");
    assert.equal(
      h1,
      h2,
      "同 seed + 同输入应产生相同 splitHash（确定性）",
    );
    // manifest 内 splitHash 字段也应一致
    const m1 = readSplitManifest(out1);
    const m2 = readSplitManifest(out2);
    assert.equal(m1.splitHash, m2.splitHash);
    assert.equal(m1.splitHash, h1, "split-manifest.json 内 splitHash 应与 split-hash.sha256 文件一致");
  });

  test("seed 敏感性：不同 seed → 不同 splitHash（极大概率）", () => {
    writeChaptersJsonl("fixt1", 100);
    const out1 = join(tmpDir, "out1");
    const out2 = join(tmpDir, "out2");
    mkdirSync(out1, { recursive: true });
    mkdirSync(out2, { recursive: true });
    runSplitCli(
      `--input "${chaptersJsonlPath}" --book-id fixt1 --out-dir "${out1}" --seed 42`,
    );
    runSplitCli(
      `--input "${chaptersJsonlPath}" --book-id fixt1 --out-dir "${out2}" --seed 999`,
    );
    const h1 = readSplitHash(out1);
    const h2 = readSplitHash(out2);
    assert.notEqual(
      h1,
      h2,
      "不同 seed 应产生不同 splitHash（极大概率）",
    );
  });

  test("splitHash 排除 createdAt（确定性）", () => {
    writeChaptersJsonl("fixt1", 100);
    const out1 = join(tmpDir, "out1");
    const out2 = join(tmpDir, "out2");
    mkdirSync(out1, { recursive: true });
    mkdirSync(out2, { recursive: true });
    runSplitCli(
      `--input "${chaptersJsonlPath}" --book-id fixt1 --out-dir "${out1}" --seed 42`,
    );
    // 等待 1.1 秒以保证 createdAt 不同
    execSync('node -e "setTimeout(()=>{},1100)"');
    runSplitCli(
      `--input "${chaptersJsonlPath}" --book-id fixt1 --out-dir "${out2}" --seed 42`,
    );
    const m1 = readSplitManifest(out1);
    const m2 = readSplitManifest(out2);
    assert.notEqual(
      m1.createdAt,
      m2.createdAt,
      "两次 createdAt 应不同（间隔 >1s）",
    );
    assert.equal(
      m1.splitHash,
      m2.splitHash,
      "splitHash 应排除 createdAt，确定性保持一致",
    );
  });

  test("非邻接约束：分析集与冻结测试集之间物理章号距离 ≥ buffer", () => {
    writeChaptersJsonl("fixt1", 100);
    runSplitCli(
      `--input "${chaptersJsonlPath}" --book-id fixt1 --out-dir "${outDir}" --buffer 2`,
    );
    const m = readSplitManifest(outDir);
    const analysisIndices = m.analysisSet.map((e) => e.physicalChapterIndex);
    const frozenIndices = m.frozenTestSet.map((e) => e.physicalChapterIndex);

    for (const a of analysisIndices) {
      for (const f of frozenIndices) {
        const dist = Math.abs(a - f);
        assert.ok(
          dist >= m.buffer,
          `analysis(${a}) 与 frozen(${f}) 距离 ${dist} < buffer=${m.buffer}，违反非邻接约束`,
        );
      }
    }
  });

  test("非邻接约束：验证集与冻结测试集之间物理章号距离 ≥ buffer", () => {
    writeChaptersJsonl("fixt1", 100);
    runSplitCli(
      `--input "${chaptersJsonlPath}" --book-id fixt1 --out-dir "${outDir}" --buffer 2`,
    );
    const m = readSplitManifest(outDir);
    const validationIndices = m.validationSet.map((e) => e.physicalChapterIndex);
    const frozenIndices = m.frozenTestSet.map((e) => e.physicalChapterIndex);

    for (const v of validationIndices) {
      for (const f of frozenIndices) {
        const dist = Math.abs(v - f);
        assert.ok(
          dist >= m.buffer,
          `validation(${v}) 与 frozen(${f}) 距离 ${dist} < buffer=${m.buffer}，违反非邻接约束`,
        );
      }
    }
  });

  test("非邻接约束：buffer=5 时距离 ≥ 5", () => {
    writeChaptersJsonl("fixt1", 200);
    runSplitCli(
      `--input "${chaptersJsonlPath}" --book-id fixt1 --out-dir "${outDir}" --buffer 5 --seed 7`,
    );
    const m = readSplitManifest(outDir);
    assert.equal(m.buffer, 5);
    const analysisIndices = m.analysisSet.map((e) => e.physicalChapterIndex);
    const frozenIndices = m.frozenTestSet.map((e) => e.physicalChapterIndex);

    let violations = 0;
    for (const a of analysisIndices) {
      for (const f of frozenIndices) {
        if (Math.abs(a - f) < 5) violations++;
      }
    }
    assert.equal(violations, 0, `buffer=5 应零违反，实际 ${violations} 次`);
  });

  test("覆盖 9 类：analysisSet 覆盖所有 coverageGuess 类型", () => {
    writeChaptersJsonl("fixt1", 200);
    runSplitCli(
      `--input "${chaptersJsonlPath}" --book-id fixt1 --out-dir "${outDir}" --seed 42`,
    );
    const m = readSplitManifest(outDir);
    const expectedCoverage = [
      "opening_anomaly", // 开篇与异常首次出现
      "daily_to_horror", // 日常转恐怖
      "rule_discovery", // 规则发现
      "investigation_info", // 调查与信息释放
      "survival_choice", // 生存选择与代价
      "character_conflict", // 人物冲突
      "stage_climax", // 阶段高潮
      "high_pressure_ending", // 高压章末
      "transition", // 过渡章节
    ];
    const actualCoverage = new Set(m.analysisSet.map((e) => e.coverageGuess));
    for (const cov of expectedCoverage) {
      assert.ok(
        actualCoverage.has(cov),
        `analysisSet 应含 coverageGuess=${cov}，实际：${[...actualCoverage].join(",")}`,
      );
    }
  });

  test("coverageGuess 在合法枚举内", () => {
    writeChaptersJsonl("fixt1", 100);
    runSplitCli(
      `--input "${chaptersJsonlPath}" --book-id fixt1 --out-dir "${outDir}"`,
    );
    const m = readSplitManifest(outDir);
    const all = [
      ...m.analysisSet,
      ...m.validationSet,
      ...m.frozenTestSet,
    ];
    const allowed = new Set([
      "opening_anomaly",
      "daily_to_horror",
      "rule_discovery",
      "investigation_info",
      "survival_choice",
      "character_conflict",
      "stage_climax",
      "high_pressure_ending",
      "transition",
    ]);
    for (const entry of all) {
      assert.ok(
        allowed.has(entry.coverageGuess),
        `coverageGuess 非法：${entry.coverageGuess}（应 ∈ ${[...allowed].join(",")}）`,
      );
    }
  });

  test("输入章节数不足时显式失败（< 60 章无法满足默认 30/15/15）", () => {
    writeChaptersJsonl("fixt1", 50);
    let err;
    try {
      runSplitCli(
        `--input "${chaptersJsonlPath}" --book-id fixt1 --out-dir "${outDir}"`,
      );
    } catch (e) {
      err = e;
    }
    assert.ok(err, "章节数不足应失败");
    assert.match(
      err.stderr?.toString() ?? err.message,
      /insufficient|不足|too few|至少/i,
      "失败信息应说明章节数不足",
    );
  });

  test("自定义计数：--analysis-count 6 --validation-count 3 --frozen-count 3 = 12 章", () => {
    writeChaptersJsonl("fixt1", 30);
    runSplitCli(
      `--input "${chaptersJsonlPath}" --book-id fixt1 --out-dir "${outDir}" --analysis-count 6 --validation-count 3 --frozen-count 3 --buffer 1`,
    );
    const m = readSplitManifest(outDir);
    assert.equal(m.analysisSet.length, 6);
    assert.equal(m.validationSet.length, 3);
    assert.equal(m.frozenTestSet.length, 3);
    assert.deepEqual(m.counts, { analysis: 6, validation: 3, frozenTest: 3 });
  });

  test("frozen-access-audit.jsonl 初始为空文件（0 行）", () => {
    writeChaptersJsonl("fixt1", 100);
    runSplitCli(
      `--input "${chaptersJsonlPath}" --book-id fixt1 --out-dir "${outDir}"`,
    );
    const log = readAuditLog(outDir);
    assert.equal(log.length, 0, "新构建 split 后 audit log 应为空");
  });

  test("bookId 校验：只允许字母/数字/下划线/连字符", () => {
    writeChaptersJsonl("fixt1", 100);
    let err;
    try {
      runSplitCli(
        `--input "${chaptersJsonlPath}" --book-id "fixt 1" --out-dir "${outDir}"`,
      );
    } catch (e) {
      err = e;
    }
    assert.ok(err, "非法 bookId 应失败");
  });

  test("--help 不报错并显示用法", () => {
    const out = runSplitCli(`--help`);
    assert.match(out, /holdout-split/i);
    assert.match(out, /--input/);
    assert.match(out, /--book-id/);
    assert.match(out, /--seed/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Part B：审计日志与权限隔离
// ─────────────────────────────────────────────────────────────────────────────

describe("REFERENCE-HOLDOUT-SPLIT-1 Part B: 审计日志与权限隔离", () => {
  test("audit-frozen-access.mjs CLI 文件存在", () => {
    assert.ok(existsSync(AUDIT_CLI_PATH), `CLI 应存在：${AUDIT_CLI_PATH}`);
  });

  test("记录一次冻结访问：append JSONL 行 + invalidatesRound=true", () => {
    writeChaptersJsonl("fixt1", 100);
    runSplitCli(
      `--input "${chaptersJsonlPath}" --book-id fixt1 --out-dir "${outDir}"`,
    );
    const m = readSplitManifest(outDir);
    const frozenId = m.frozenTestSet[0].referenceId;

    runAuditCli(
      `record --manifest "${join(outDir, "split-manifest.json")}" --reference-id "${frozenId}" --accessor "tuning-script" --reason "debug-peek"`,
    );

    const log = readAuditLog(outDir);
    assert.equal(log.length, 1, "应记录 1 条访问");
    const entry = log[0];
    assert.match(entry.timestamp, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(entry.action, "view_frozen_reference");
    assert.equal(entry.referenceId, frozenId);
    assert.equal(entry.accessor, "tuning-script");
    assert.equal(entry.reason, "debug-peek");
    assert.equal(
      entry.invalidatesRound,
      true,
      "任何冻结访问都应使本轮结果失效",
    );
  });

  test("记录非冻结 referenceId 应失败（不允许审计非冻结访问）", () => {
    writeChaptersJsonl("fixt1", 100);
    runSplitCli(
      `--input "${chaptersJsonlPath}" --book-id fixt1 --out-dir "${outDir}"`,
    );
    const m = readSplitManifest(outDir);
    const analysisId = m.analysisSet[0].referenceId;

    let err;
    try {
      runAuditCli(
        `record --manifest "${join(outDir, "split-manifest.json")}" --reference-id "${analysisId}" --accessor "tuning-script" --reason "should-fail"`,
      );
    } catch (e) {
      err = e;
    }
    assert.ok(err, "记录非冻结 referenceId 应失败");
    const log = readAuditLog(outDir);
    assert.equal(log.length, 0, "失败时不应写入 audit log");
  });

  test("记录未知 referenceId 应失败", () => {
    writeChaptersJsonl("fixt1", 100);
    runSplitCli(
      `--input "${chaptersJsonlPath}" --book-id fixt1 --out-dir "${outDir}"`,
    );

    let err;
    try {
      runAuditCli(
        `record --manifest "${join(outDir, "split-manifest.json")}" --reference-id "fixt1:physical:9999" --accessor "x" --reason "unknown"`,
      );
    } catch (e) {
      err = e;
    }
    assert.ok(err, "未知 referenceId 应失败");
  });

  test("--check 模式：未记录访问时 exit 0 且输出 valid=true", () => {
    writeChaptersJsonl("fixt1", 100);
    runSplitCli(
      `--input "${chaptersJsonlPath}" --book-id fixt1 --out-dir "${outDir}"`,
    );
    const out = runAuditCli(
      `check --manifest "${join(outDir, "split-manifest.json")}"`,
    );
    assert.match(out, /"roundValid"\s*:\s*true/);
  });

  test("--check 模式：记录访问后 exit 非 0 且输出 valid=false", () => {
    writeChaptersJsonl("fixt1", 100);
    runSplitCli(
      `--input "${chaptersJsonlPath}" --book-id fixt1 --out-dir "${outDir}"`,
    );
    const m = readSplitManifest(outDir);
    const frozenId = m.frozenTestSet[0].referenceId;

    runAuditCli(
      `record --manifest "${join(outDir, "split-manifest.json")}" --reference-id "${frozenId}" --accessor "tuning-script" --reason "peek"`,
    );

    let err;
    try {
      runAuditCli(
        `check --manifest "${join(outDir, "split-manifest.json")}"`,
      );
    } catch (e) {
      err = e;
    }
    assert.ok(err, "轮次失效后 --check 应非 0 退出");
    const out = err.stdout?.toString() ?? "";
    assert.match(out, /"roundValid"\s*:\s*false/);
  });

  test("审计日志保留多条记录（不覆盖）", () => {
    writeChaptersJsonl("fixt1", 100);
    runSplitCli(
      `--input "${chaptersJsonlPath}" --book-id fixt1 --out-dir "${outDir}"`,
    );
    const m = readSplitManifest(outDir);
    const frozenId1 = m.frozenTestSet[0].referenceId;
    const frozenId2 = m.frozenTestSet[1].referenceId;

    runAuditCli(
      `record --manifest "${join(outDir, "split-manifest.json")}" --reference-id "${frozenId1}" --accessor "a1" --reason "r1"`,
    );
    runAuditCli(
      `record --manifest "${join(outDir, "split-manifest.json")}" --reference-id "${frozenId2}" --accessor "a2" --reason "r2"`,
    );

    const log = readAuditLog(outDir);
    assert.equal(log.length, 2, "应保留 2 条访问记录");
    assert.equal(log[0].referenceId, frozenId1);
    assert.equal(log[1].referenceId, frozenId2);
  });

  test("audit CLI --help 不报错并显示用法", () => {
    const out = runAuditCli(`--help`);
    assert.match(out, /audit-frozen-access/i);
    assert.match(out, /record/);
    assert.match(out, /check/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Part C：真实样本 smoke（《神秘复苏》1607 章）
// ─────────────────────────────────────────────────────────────────────────────

describe("REFERENCE-HOLDOUT-SPLIT-1 Part C: 真实样本 smoke", () => {
  test("真实 1607 章 chapters.jsonl → 60 章 holdout split", () => {
    if (!existsSync(REAL_REFERENCE_PATH)) {
      console.warn(`跳过：真实样本文件不存在 ${REAL_REFERENCE_PATH}`);
      return;
    }
    if (!existsSync(IMPORT_CLI_PATH)) {
      console.warn(`跳过：import-external-reference.mjs 不存在`);
      return;
    }

    // 1. 导入神秘复苏.txt → chapters.jsonl
    const importOut = join(tmpDir, "imported");
    mkdirSync(importOut, { recursive: true });
    execSync(
      `node "${IMPORT_CLI_PATH}" --input "${REAL_REFERENCE_PATH}" --book-id smsf --out-dir "${importOut}" --title 神秘复苏 --genre 悬疑`,
      { encoding: "utf-8", cwd: PROJECT_ROOT },
    );
    const importedJsonlPath = join(importOut, "chapters.jsonl");
    assert.ok(existsSync(importedJsonlPath), "应生成 chapters.jsonl");

    const importManifest = JSON.parse(
      readFileSync(join(importOut, "book-manifest.json"), "utf-8"),
    );
    assert.ok(
      importManifest.chapterCount >= 1000,
      `神秘复苏应至少 1000 章，实际 ${importManifest.chapterCount}`,
    );

    // 2. 跑 holdout-split
    runSplitCli(
      `--input "${importedJsonlPath}" --book-id smsf --out-dir "${outDir}" --seed 42`,
    );
    const m = readSplitManifest(outDir);

    // 3. 集合大小
    assert.equal(m.analysisSet.length, 30);
    assert.equal(m.validationSet.length, 15);
    assert.equal(m.frozenTestSet.length, 15);

    // 4. referenceId 格式
    const all = [
      ...m.analysisSet,
      ...m.validationSet,
      ...m.frozenTestSet,
    ];
    for (const entry of all) {
      assert.match(
        entry.referenceId,
        /^smsf:physical:\d+$/,
        `referenceId 应匹配 smsf:physical:N：${entry.referenceId}`,
      );
    }

    // 5. 非邻接约束（分析 vs 冻结）
    const analysisIndices = m.analysisSet.map((e) => e.physicalChapterIndex);
    const frozenIndices = m.frozenTestSet.map((e) => e.physicalChapterIndex);
    for (const a of analysisIndices) {
      for (const f of frozenIndices) {
        assert.ok(
          Math.abs(a - f) >= m.buffer,
          `analysis(${a}) 与 frozen(${f}) 距离 < buffer=${m.buffer}`,
        );
      }
    }

    // 6. 全部 physicalChapterIndex 在范围内
    for (const entry of all) {
      assert.ok(
        entry.physicalChapterIndex >= 0 &&
          entry.physicalChapterIndex < importManifest.chapterCount,
        `physicalChapterIndex 越界：${entry.physicalChapterIndex}`,
      );
    }

    // 7. splitHash 稳定性
    const out2 = join(tmpDir, "out2");
    mkdirSync(out2, { recursive: true });
    runSplitCli(
      `--input "${importedJsonlPath}" --book-id smsf --out-dir "${out2}" --seed 42`,
    );
    const h1 = readSplitHash(outDir);
    const h2 = readSplitHash(out2);
    assert.equal(h1, h2, "同 seed + 同输入应产生相同 splitHash");
  });

  test("真实样本：覆盖 9 类 coverageGuess", () => {
    if (!existsSync(REAL_REFERENCE_PATH)) {
      console.warn(`跳过：真实样本文件不存在`);
      return;
    }
    if (!existsSync(IMPORT_CLI_PATH)) {
      console.warn(`跳过：import-external-reference.mjs 不存在`);
      return;
    }

    const importOut = join(tmpDir, "imported");
    mkdirSync(importOut, { recursive: true });
    execSync(
      `node "${IMPORT_CLI_PATH}" --input "${REAL_REFERENCE_PATH}" --book-id smsf --out-dir "${importOut}"`,
      { encoding: "utf-8", cwd: PROJECT_ROOT },
    );
    runSplitCli(
      `--input "${join(importOut, "chapters.jsonl")}" --book-id smsf --out-dir "${outDir}" --seed 42`,
    );
    const m = readSplitManifest(outDir);
    const expectedCoverage = new Set([
      "opening_anomaly",
      "daily_to_horror",
      "rule_discovery",
      "investigation_info",
      "survival_choice",
      "character_conflict",
      "stage_climax",
      "high_pressure_ending",
      "transition",
    ]);
    const actualCoverage = new Set(m.analysisSet.map((e) => e.coverageGuess));
    for (const cov of expectedCoverage) {
      assert.ok(
        actualCoverage.has(cov),
        `analysisSet 应含 coverageGuess=${cov}，实际：${[...actualCoverage].join(",")}`,
      );
    }
  });
});
