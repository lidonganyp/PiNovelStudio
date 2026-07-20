#!/usr/bin/env node
/**
 * REFERENCE-HOLDOUT-SPLIT-1：留出集切分 CLI
 *
 * 任务卡 §6：防止根据已看过的 reference 反复调 prompt，形成样本过拟合。
 *
 * 输入：REFERENCE-CORPUS-ADAPTER-1 产物 chapters.jsonl（每行一个 ExternalChapterManifestEntry）
 * 输出：split-manifest.json + split-hash.sha256 + frozen-access-audit.jsonl（初始为空）
 *
 * 三集合：
 * - analysisSet    分析集（30 章）：允许读取 reference 和资产，用于提出工艺假设
 * - validationSet  验证集（15 章）：允许聚合评测结果，不允许人工逐章改规则
 * - frozenTestSet  冻结测试集（15 章）：调参期间不解封，只在候选策略定版后运行一次
 *
 * 9 类 coverageGuess（按物理位置百分位分层，不读 body 内容，是位置启发式标注）：
 * - opening_anomaly       开篇与异常首次出现  [0%, 5%)
 * - daily_to_horror       日常转恐怖            [5%, 15%)
 * - rule_discovery        规则发现              [15%, 25%)
 * - investigation_info    调查与信息释放        [25%, 40%)
 * - survival_choice       生存选择与代价        [40%, 55%)
 * - character_conflict    人物冲突              [55%, 70%)
 * - stage_climax          阶段高潮              [70%, 85%)
 * - high_pressure_ending  高压章末              [85%, 95%)
 * - transition            过渡章节              [95%, 100%]
 *
 * 非邻接约束（buffer）：
 * - 默认 buffer=2：分析集与冻结集、验证集与冻结集之间物理章号距离 ≥ buffer
 * - 实现方式：先选 frozen 集，标记其 buffer 范围为禁区，再在禁区外选 analysis/validation
 *
 * 确定性：
 * - mulberry32(seed) PRNG；同 seed + 同输入 → 同 splitHash
 * - splitHash = sha256(canonical JSON, 排除 createdAt)
 * - sourceManifestHash = sha256(chapters.jsonl 字节内容)
 *
 * 权限隔离：
 * - frozenTestSet 条目 sealed:true，分析与验证集不 sealed
 * - audit log 由 audit-frozen-access.mjs 维护（本 CLI 只创建空文件）
 *
 * 用法：
 *   node scripts/novelbench/holdout-split.mjs \
 *     --input <chapters.jsonl> --book-id <ID> --out-dir <DIR> \
 *     [--seed 42] [--analysis-count 30] [--validation-count 15] [--frozen-count 15] \
 *     [--buffer 2] [--help]
 *
 * 授权边界：本 CLI 全程离线，不调用任何模型 API。
 */

import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(__filename, "..", "..", "..");

// ─────────────────────────────────────────────────────────────────────────────
// CLI 参数解析
// ─────────────────────────────────────────────────────────────────────────────

const { values } = parseArgs({
  options: {
    input: { type: "string" },
    "book-id": { type: "string" },
    "out-dir": { type: "string" },
    seed: { type: "string", default: "42" },
    "analysis-count": { type: "string", default: "30" },
    "validation-count": { type: "string", default: "15" },
    "frozen-count": { type: "string", default: "15" },
    buffer: { type: "string", default: "2" },
    help: { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  process.stdout.write(`REFERENCE-HOLDOUT-SPLIT-1：留出集切分 CLI

用法：
  node scripts/novelbench/holdout-split.mjs \\
    --input <chapters.jsonl> --book-id <ID> --out-dir <DIR> \\
    [--seed 42] [--analysis-count 30] [--validation-count 15] [--frozen-count 15] \\
    [--buffer 2] [--help]

必填参数：
  --input <chapters.jsonl>    REFERENCE-CORPUS-ADAPTER-1 产物路径
  --book-id <ID>              书籍唯一 ID（与 RCA-1 一致，用作 referenceId 前缀）
  --out-dir <DIR>             产物输出目录

可选参数：
  --seed <N>                  伪随机种子（默认 42，同 seed 确定性可复现）
  --analysis-count <N>        分析集样本数（默认 30）
  --validation-count <N>      验证集样本数（默认 15）
  --frozen-count <N>          冻结测试集样本数（默认 15）
  --buffer <N>                集合间最小物理章号距离（默认 2，避免相邻章节泄漏）
  --help                      显示本帮助

产物：
  <out-dir>/split-manifest.json          留出集 manifest（含三集合 + 元数据）
  <out-dir>/split-hash.sha256            manifest 确定性 hash（排除 createdAt）
  <out-dir>/frozen-access-audit.jsonl    冻结访问审计日志（初始为空文件）

设计要点：
  - 三集合：analysisSet（30）+ validationSet（15）+ frozenTestSet（15，sealed:true）
  - 9 类 coverageGuess：按物理位置百分位分层，position-based heuristic
  - 非邻接：先选 frozen 集，标记其 ±buffer 范围为禁区，再在禁区外选 analysis/validation
  - 确定性：mulberry32(seed) PRNG；同 seed + 同输入 → 同 splitHash
  - 权限：frozen 集访问由 audit-frozen-access.mjs 记录并使本轮失效
  - 全程离线，不调用任何模型 API
`);
  process.exit(0);
}

const inputRaw = values.input;
const bookId = values["book-id"];
const outDirRaw = values["out-dir"];
const seed = parseInt(values.seed, 10);
const analysisCount = parseInt(values["analysis-count"], 10);
const validationCount = parseInt(values["validation-count"], 10);
const frozenCount = parseInt(values["frozen-count"], 10);
const buffer = parseInt(values.buffer, 10);

if (!inputRaw || !bookId || !outDirRaw) {
  process.stderr.write(
    `错误：--input、--book-id、--out-dir 均为必填\n` +
      `使用 --help 查看完整用法\n`,
  );
  process.exit(1);
}

if (!Number.isFinite(seed) || seed < 0) {
  process.stderr.write(`错误：--seed 应为非负整数，实际：${values.seed}\n`);
  process.exit(1);
}

for (const [name, val] of [
  ["--analysis-count", analysisCount],
  ["--validation-count", validationCount],
  ["--frozen-count", frozenCount],
  ["--buffer", buffer],
]) {
  if (!Number.isFinite(val) || val < 0) {
    process.stderr.write(`错误：${name} 应为非负整数\n`);
    process.exit(1);
  }
}

if (!/^[a-zA-Z0-9_\-]+$/.test(bookId)) {
  process.stderr.write(
    `错误：--book-id 只能含字母/数字/下划线/连字符，实际：${bookId}\n`,
  );
  process.exit(1);
}

const inputPath = resolve(PROJECT_ROOT, inputRaw);
const outDir = resolve(PROJECT_ROOT, outDirRaw);

if (!existsSync(inputPath)) {
  process.stderr.write(`错误：输入文件不存在：${inputPath}\n`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

// ─────────────────────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────────────────────

function sha256(data) {
  return createHash("sha256").update(data, "utf-8").digest("hex");
}

/** Mulberry32 — 确定性 PRNG（同 seed 可复现） */
function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 9 类 coverageGuess 的物理位置百分位分层 */
const STRATA = [
  { coverage: "opening_anomaly", startPct: 0.0, endPct: 0.05 },
  { coverage: "daily_to_horror", startPct: 0.05, endPct: 0.15 },
  { coverage: "rule_discovery", startPct: 0.15, endPct: 0.25 },
  { coverage: "investigation_info", startPct: 0.25, endPct: 0.4 },
  { coverage: "survival_choice", startPct: 0.4, endPct: 0.55 },
  { coverage: "character_conflict", startPct: 0.55, endPct: 0.7 },
  { coverage: "stage_climax", startPct: 0.7, endPct: 0.85 },
  { coverage: "high_pressure_ending", startPct: 0.85, endPct: 0.95 },
  { coverage: "transition", startPct: 0.95, endPct: 1.0 },
];

function buildStrata(totalChapters) {
  // 用前一个 stratum 的 endIdx 作为下一个的 startIdx，避免 N 较小时出现重叠
  // （例如 N=30 时 floor(0.05*30)=1 与 ceil(0.05*30)=2 不一致会导致 s0/s1 重叠）
  const result = [];
  let prevEnd = 0;
  for (let i = 0; i < STRATA.length; i++) {
    const endIdx =
      i === STRATA.length - 1
        ? totalChapters
        : Math.min(totalChapters, Math.ceil(STRATA[i].endPct * totalChapters));
    const safeEnd = Math.max(endIdx, prevEnd);
    result.push({
      coverage: STRATA[i].coverage,
      startIdx: prevEnd,
      endIdx: safeEnd,
    });
    prevEnd = safeEnd;
  }
  return result;
}

/** 把 total 均分到 strataCount 份，余数从前往后补 */
function distributeCounts(total, strataCount) {
  const base = Math.floor(total / strataCount);
  const remainder = total - base * strataCount;
  const counts = Array(strataCount).fill(base);
  for (let i = 0; i < remainder; i++) counts[i] += 1;
  return counts;
}

/** 用 seeded rng 从 available 中抽 n 个，返回排序后的数组 */
function pickSamples(rng, available, count) {
  if (count <= 0 || available.length === 0) return [];
  const arr = [...available];
  // Fisher-Yates shuffle with seeded rng
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, count).sort((a, b) => a - b);
}

/**
 * 三集合选择（保证非邻接约束）。
 *
 * 算法：
 * 1. 先选 frozen 集（最受限）— 聚簇放置以最小化 buffer 占用：
 *    - 边界 stratum（首/末）靠 book 边缘放置，buffer 延伸到 off-book
 *    - 中间 stratum 随机选起始位置（seeded），连续放置 actualTarget 个 frozen
 *    - 聚簇使 buffer 占用从 F×(2B+1) 降到 F+2B per stratum
 * 2. 标记每个 frozen 的 ±buffer 范围为禁区
 * 3. 再选 analysis 集（跳过 frozen 禁区，按 strata 配额 + shortfall 全局补足）
 * 4. 最后选 validation 集（跳过 frozen 禁区 + 已选）
 *
 * 注：analysis 与 validation 之间无 buffer 约束（只有各自与 frozen 之间有约束）。
 */
function selectSplit(chapters, counts, buffer, seed) {
  const total = chapters.length;
  const strata = buildStrata(total);
  const rng = mulberry32(seed);

  // 已分配章节（physicalChapterIndex）
  const used = new Set();
  // frozen 禁区（physicalChapterIndex，不可被 analysis/validation 选中）
  const frozenBuffer = new Set();

  function markFrozenBuffer(idx) {
    for (let b = idx - buffer; b <= idx + buffer; b++) {
      if (b >= 0 && b < total && b !== idx) frozenBuffer.add(b);
    }
  }

  function availableInStratum(stratum, extraExclude) {
    const out = [];
    for (let i = stratum.startIdx; i < stratum.endIdx; i++) {
      if (used.has(i)) continue;
      if (extraExclude && extraExclude.has(i)) continue;
      out.push(i);
    }
    return out;
  }

  function availableGlobal(extraExclude) {
    const out = [];
    for (let i = 0; i < total; i++) {
      if (used.has(i)) continue;
      if (extraExclude && extraExclude.has(i)) continue;
      out.push(i);
    }
    return out;
  }

  function pickFromStrata(countPerStratum, extraExclude) {
    const picked = [];
    let shortfall = 0;
    for (let s = 0; s < strata.length; s++) {
      const target = countPerStratum[s];
      if (target === 0) continue;
      const available = availableInStratum(strata[s], extraExclude);
      const chosen = pickSamples(rng, available, target);
      for (const idx of chosen) {
        picked.push({ idx, coverage: strata[s].coverage });
        used.add(idx);
      }
      shortfall += target - chosen.length;
    }
    // 补足 shortfall：从全局任意可用位置选
    while (shortfall > 0) {
      const available = availableGlobal(extraExclude);
      if (available.length === 0) break;
      const chosen = pickSamples(rng, available, 1);
      if (chosen.length === 0) break;
      const idx = chosen[0];
      // 找对应 coverage
      let cov = "transition";
      for (const s of strata) {
        if (idx >= s.startIdx && idx < s.endIdx) {
          cov = s.coverage;
          break;
        }
      }
      picked.push({ idx, coverage: cov });
      used.add(idx);
      shortfall--;
    }
    return picked;
  }

  // 1. 选 frozen 集（聚簇放置以最小化 buffer 占用）
  const frozenCounts = distributeCounts(counts.frozenTest, strata.length);
  const frozenPicked = [];

  for (let s = 0; s < strata.length; s++) {
    const target = frozenCounts[s];
    if (target === 0) continue;

    const stratum = strata[s];
    const stratumSize = stratum.endIdx - stratum.startIdx;
    if (stratumSize === 0) continue;

    // 计算该 stratum 内可用位置
    const stratumAvailable = [];
    for (let i = stratum.startIdx; i < stratum.endIdx; i++) {
      if (!used.has(i)) stratumAvailable.push(i);
    }
    const actualTarget = Math.min(target, stratumAvailable.length);
    if (actualTarget === 0) continue;

    // 聚簇放置：选择连续 actualTarget 个位置
    // 边界 stratum 靠 book 边缘（buffer 延伸到 off-book，减少占用）
    let startOffset;
    if (s === 0) {
      // 首 stratum：从 book 起点开始
      startOffset = 0;
    } else if (s === strata.length - 1) {
      // 末 stratum：靠 book 末尾
      startOffset = stratumSize - actualTarget;
    } else {
      // 中间 stratum：随机选起始位置（seeded，确定性）
      const maxStart = stratumSize - actualTarget;
      startOffset = maxStart > 0 ? Math.floor(rng() * (maxStart + 1)) : 0;
    }

    // 放置 actualTarget 个连续 frozen（跳过已占用的位置）
    let placed = 0;
    for (let i = 0; i < stratumSize && placed < actualTarget; i++) {
      const idx = stratum.startIdx + startOffset + i;
      if (idx >= stratum.endIdx) break;
      if (used.has(idx)) continue;
      frozenPicked.push({ idx, coverage: stratum.coverage });
      used.add(idx);
      placed++;
    }
  }

  // frozen shortfall 补足：从全局可用位置随机抽
  let frozenShortfall = counts.frozenTest - frozenPicked.length;
  while (frozenShortfall > 0) {
    const available = [];
    for (let i = 0; i < total; i++) {
      if (!used.has(i)) available.push(i);
    }
    if (available.length === 0) break;
    const chosen = pickSamples(rng, available, 1);
    if (chosen.length === 0) break;
    const idx = chosen[0];
    let cov = "transition";
    for (const s of strata) {
      if (idx >= s.startIdx && idx < s.endIdx) {
        cov = s.coverage;
        break;
      }
    }
    frozenPicked.push({ idx, coverage: cov });
    used.add(idx);
    frozenShortfall--;
  }

  // 2. 标记 frozen buffer（frozen 周围 ±buffer 范围禁止 analysis/validation）
  for (const { idx } of frozenPicked) {
    markFrozenBuffer(idx);
  }

  // 3. 选 analysis 集（跳过 frozen 禁区）
  const analysisCounts = distributeCounts(counts.analysis, strata.length);
  const analysisPicked = pickFromStrata(analysisCounts, frozenBuffer);

  // 4. 选 validation 集（跳过 frozen 禁区 + 已选 — used 已包含 analysis 与 frozen）
  const validationCounts = distributeCounts(counts.validation, strata.length);
  const validationPicked = pickFromStrata(validationCounts, frozenBuffer);

  return {
    analysis: analysisPicked,
    validation: validationPicked,
    frozen: frozenPicked,
  };
}

/** 把 selected 索引列表转成 manifest entry */
function toManifestEntries(chapters, picked, bookId, sealed) {
  return picked.map(({ idx, coverage }) => {
    const ch = chapters[idx];
    const entry = {
      referenceId: `${bookId}:physical:${idx}`,
      physicalChapterIndex: idx,
      bodyHash: ch.bodyHash,
      coverageGuess: coverage,
    };
    if (sealed) entry.sealed = true;
    return entry;
  });
}

/** 计算 splitHash（排除 createdAt 的确定性 hash） */
function computeSplitHash(canonical) {
  // 排序 key 保证确定性
  const sorted = JSON.stringify(canonical, Object.keys(canonical).sort());
  return sha256(sorted);
}

// 1. 读 chapters.jsonl
const chaptersJsonlContent = readFileSync(inputPath, "utf-8");
const sourceManifestHash = sha256(chaptersJsonlContent);

const chapters = chaptersJsonlContent
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

if (chapters.length === 0) {
  process.stderr.write(`错误：chapters.jsonl 为空或无有效记录\n`);
  process.exit(2);
}

// 验证字段
for (const ch of chapters) {
  if (
    typeof ch.physicalChapterIndex !== "number" ||
    typeof ch.bodyHash !== "string"
  ) {
    process.stderr.write(
      `错误：chapters.jsonl 记录缺少 physicalChapterIndex 或 bodyHash：${JSON.stringify(ch)}`,
    );
    process.exit(2);
  }
}

const sourceChapterCount = chapters.length;
const totalRequired = analysisCount + validationCount + frozenCount;

// 章节数绝对下限：至少能容纳三集合总数
// （buffer 禁区由 selectSplit 在选择时动态避开；若避不开会返回数量不足）
if (sourceChapterCount < totalRequired) {
  process.stderr.write(
    `错误：输入章节数不足（insufficient chapters）。\n` +
      `  输入：${sourceChapterCount} 章\n` +
      `  所需：analysis=${analysisCount} + validation=${validationCount} + frozen=${frozenCount} = ${totalRequired}\n` +
      `  请减少 --analysis-count/--validation-count/--frozen-count，或增加输入章节\n`,
  );
  process.exit(2);
}

process.stderr.write(
  `[RHS-1] 输入：${inputPath}\n` +
    `[RHS-1] chapters：${sourceChapterCount}，sourceManifestHash=${sourceManifestHash.slice(0, 16)}...\n` +
    `[RHS-1] 目标：analysis=${analysisCount} + validation=${validationCount} + frozen=${frozenCount}，buffer=${buffer}，seed=${seed}\n`,
);

// 2. 选择三集合
const selection = selectSplit(
  chapters,
  { analysis: analysisCount, validation: validationCount, frozenTest: frozenCount },
  buffer,
  seed,
);

// 验证数量
if (
  selection.analysis.length !== analysisCount ||
  selection.validation.length !== validationCount ||
  selection.frozen.length !== frozenCount
) {
  process.stderr.write(
    `错误：选择数量与目标不符（可能因 buffer 禁区过大）。\n` +
      `  analysis: ${selection.analysis.length}/${analysisCount}\n` +
      `  validation: ${selection.validation.length}/${validationCount}\n` +
      `  frozen: ${selection.frozen.length}/${frozenCount}\n` +
      `  请减小 --buffer 或减少目标数量\n`,
  );
  process.exit(3);
}

// 3. 构造 manifest entries
const analysisSet = toManifestEntries(chapters, selection.analysis, bookId, false);
const validationSet = toManifestEntries(chapters, selection.validation, bookId, false);
const frozenTestSet = toManifestEntries(chapters, selection.frozen, bookId, true);

// 4. 构造 manifest（不含 createdAt，便于计算 splitHash）
const canonical = {
  schemaVersion: 1,
  bookId,
  sourceManifestPath: inputPath,
  sourceManifestHash,
  sourceChapterCount,
  seed,
  buffer,
  counts: {
    analysis: analysisCount,
    validation: validationCount,
    frozenTest: frozenCount,
  },
  analysisSet,
  validationSet,
  frozenTestSet,
};

const splitHash = computeSplitHash(canonical);

// 5. 加上 createdAt 写入文件
const manifest = {
  ...canonical,
  splitHash,
  createdAt: new Date().toISOString(),
};

writeFileSync(
  join(outDir, "split-manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
  "utf-8",
);
writeFileSync(join(outDir, "split-hash.sha256"), splitHash + "\n", "utf-8");

// 6. 初始化空的 frozen-access-audit.jsonl（如果不存在）
const auditLogPath = join(outDir, "frozen-access-audit.jsonl");
if (!existsSync(auditLogPath)) {
  writeFileSync(auditLogPath, "", "utf-8");
}

process.stderr.write(
  `[RHS-1] 产物：\n` +
    `  ${join(outDir, "split-manifest.json")}\n` +
    `  ${join(outDir, "split-hash.sha256")}=${splitHash}\n` +
    `  ${auditLogPath}（初始空文件）\n`,
);
process.stderr.write(
  `[RHS-1] 完成：analysis=${analysisSet.length} + validation=${validationSet.length} + frozen=${frozenTestSet.length}，splitHash=${splitHash.slice(0, 16)}...\n`,
);
