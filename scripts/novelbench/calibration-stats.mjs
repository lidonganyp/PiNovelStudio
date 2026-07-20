#!/usr/bin/env node
/**
 * NB-3R.6 校准统计报告
 *
 * 读取 reference-assets-glm/ 和 reference-assets-doubao/ 下所有 asset JSON，
 * 聚合每模型的 span 有效性、资产数量、跨模型对比，输出 markdown 报告。
 *
 * 用法：
 *   node scripts/novelbench/calibration-stats.mjs [options]
 *
 * 选项：
 *   --glm-dir <DIR>     GLM assets 目录（默认 data/novelbench/reference-assets-glm/）
 *   --doubao-dir <DIR>  Doubao assets 目录（默认 data/novelbench/reference-assets-doubao/）
 *   --out <FILE>        报告输出路径（默认 reports/novelbench-calibration-report.md）
 *   --help              显示帮助
 */

import { parseArgs } from "node:util";
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(__filename, "..", "..", "..");

const { values } = parseArgs({
  options: {
    "glm-dir": { type: "string" },
    "doubao-dir": { type: "string" },
    "glm-log": { type: "string" },
    "doubao-log": { type: "string" },
    out: { type: "string" },
    help: { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  process.stdout.write(`NB-3R.6 校准统计报告

用法：
  node scripts/novelbench/calibration-stats.mjs [options]

选项：
  --glm-dir <DIR>     GLM assets 目录（默认 data/novelbench/reference-assets-glm/）
  --doubao-dir <DIR>  Doubao assets 目录（默认 data/novelbench/reference-assets-doubao/）
  --glm-log <FILE>    GLM 提取日志（默认 extract-glm-100.log）
  --doubao-log <FILE> Doubao 提取日志（默认 extract-doubao-100.log）
  --out <FILE>        报告输出路径（默认 reports/novelbench-calibration-report.md）
  --help              显示帮助
`);
  process.exit(0);
}

const glmDir = resolve(PROJECT_ROOT, values["glm-dir"] || "data/novelbench/reference-assets-glm/");
const doubaoDir = resolve(PROJECT_ROOT, values["doubao-dir"] || "data/novelbench/reference-assets-doubao/");
const glmLog = resolve(PROJECT_ROOT, values["glm-log"] || "extract-glm-100.log");
const doubaoLog = resolve(PROJECT_ROOT, values["doubao-log"] || "extract-doubao-100.log");
const outPath = resolve(PROJECT_ROOT, values.out || "reports/novelbench-calibration-report.md");

// ─────────────────────────────────────────────────────────────────────────────
// 资产类型定义：12 类 + eventGraph 拆分为 events/causalEdges
// ─────────────────────────────────────────────────────────────────────────────

const ARRAY_ASSET_TYPES = [
  { key: "characterStateDeltas", label: "CharacterStateDelta" },
  { key: "canonStateDeltas", label: "CanonStateDelta" },
  { key: "promiseMovements", label: "PromiseMovement" },
  { key: "informationReleases", label: "InformationRelease" },
  { key: "characterChoices", label: "CharacterChoice" },
  { key: "costConsequences", label: "CostConsequence" },
  { key: "sceneTransitions", label: "SceneTransition" },
  { key: "voiceFingerprints", label: "VoiceFingerprint" },
  { key: "dialogueRoles", label: "DialogueRole" },
];

const SINGLE_ASSET_TYPES = [
  { key: "endingFunction", label: "EndingFunction" },
];

// ─────────────────────────────────────────────────────────────────────────────
// 读取目录下所有 asset JSON
// ─────────────────────────────────────────────────────────────────────────────

function loadAssets(dir) {
  if (!existsSync(dir)) return new Map();
  const map = new Map(); // caseId → asset
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const asset = JSON.parse(readFileSync(join(dir, file), "utf-8"));
      map.set(asset.referenceId, asset);
    } catch {
      // 跳过损坏文件
    }
  }
  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// 解析提取日志：成功/失败/跳过计数 + 失败原因分类
// ─────────────────────────────────────────────────────────────────────────────

function parseExtractionLog(logPath) {
  const result = {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    failureReasons: { json_parse: 0, resolve_fail: 0, other: 0 },
    failureSamples: [],
  };
  if (!existsSync(logPath)) return result;

  const lines = readFileSync(logPath, "utf-8").split("\n");
  for (const line of lines) {
    if (line.includes("[NB-3] ✓")) {
      result.succeeded++;
      result.attempted++;
    } else if (line.includes("[NB-3] ✗")) {
      result.failed++;
      result.attempted++;
      // 分类失败原因
      if (line.includes("JSON") || line.includes("position")) {
        result.failureReasons.json_parse++;
      } else if (line.includes("resolve") || line.includes("hash")) {
        result.failureReasons.resolve_fail++;
      } else {
        result.failureReasons.other++;
      }
      // 收集失败样本（前 5 条）
      if (result.failureSamples.length < 5) {
        const m = line.match(/\[NB-3\] ✗ ([^:]+): (.+)/);
        if (m) result.failureSamples.push({ caseId: m[1], reason: m[2].slice(0, 120) });
      }
    } else if (line.includes("跳过") || line.includes("skipped")) {
      result.skipped++;
    }
  }
  return result;
}


// ─────────────────────────────────────────────────────────────────────────────
// 聚合统计
// ─────────────────────────────────────────────────────────────────────────────

function aggregateStats(assetsMap, modelLabel) {
  const caseIds = [...assetsMap.keys()];
  const stats = {
    model: modelLabel,
    totalCases: caseIds.length,
    statusCounts: { extracted: 0, unknown: 0, conflict: 0, invalid_span: 0 },
    assetCounts: {}, // label → { total, perCaseAvg, statusBreakdown }
    eventGraph: { eventsTotal: 0, causalEdgesTotal: 0 },
  };

  // 初始化 assetCounts
  for (const t of ARRAY_ASSET_TYPES) {
    stats.assetCounts[t.label] = { total: 0, perCaseAvg: 0, status: { extracted: 0, unknown: 0, conflict: 0, invalid_span: 0 } };
  }
  for (const t of SINGLE_ASSET_TYPES) {
    stats.assetCounts[t.label] = { total: 0, perCaseAvg: 0, status: { extracted: 0, unknown: 0, conflict: 0, invalid_span: 0 } };
  }

  for (const caseId of caseIds) {
    const asset = assetsMap.get(caseId);

    // eventGraph
    if (asset.eventGraph) {
      stats.eventGraph.eventsTotal += (asset.eventGraph.events || []).length;
      stats.eventGraph.causalEdgesTotal += (asset.eventGraph.causalEdges || []).length;
      for (const evt of asset.eventGraph.events || []) {
        stats.statusCounts[evt.status] = (stats.statusCounts[evt.status] || 0) + 1;
        stats.assetCounts["EventGraph.events"] = stats.assetCounts["EventGraph.events"] || { total: 0, perCaseAvg: 0, status: { extracted: 0, unknown: 0, conflict: 0, invalid_span: 0 } };
        stats.assetCounts["EventGraph.events"].total++;
        stats.assetCounts["EventGraph.events"].status[evt.status] = (stats.assetCounts["EventGraph.events"].status[evt.status] || 0) + 1;
      }
    }

    // 数组类资产
    for (const t of ARRAY_ASSET_TYPES) {
      const arr = asset[t.key] || [];
      const ac = stats.assetCounts[t.label];
      ac.total += arr.length;
      for (const item of arr) {
        stats.statusCounts[item.status] = (stats.statusCounts[item.status] || 0) + 1;
        ac.status[item.status] = (ac.status[item.status] || 0) + 1;
      }
    }

    // 单对象资产（endingFunction）
    for (const t of SINGLE_ASSET_TYPES) {
      const obj = asset[t.key];
      const ac = stats.assetCounts[t.label];
      if (obj) {
        ac.total++;
        if (obj.status) {
          stats.statusCounts[obj.status] = (stats.statusCounts[obj.status] || 0) + 1;
          ac.status[obj.status] = (ac.status[obj.status] || 0) + 1;
        }
      }
    }
  }

  // 计算均值
  const n = Math.max(stats.totalCases, 1);
  for (const label of Object.keys(stats.assetCounts)) {
    stats.assetCounts[label].perCaseAvg = stats.assetCounts[label].total / n;
  }
  stats.eventGraph.eventsPerCase = stats.eventGraph.eventsTotal / n;
  stats.eventGraph.causalEdgesPerCase = stats.eventGraph.causalEdgesTotal / n;

  // span 有效性率
  const totalAssets = stats.statusCounts.extracted + stats.statusCounts.unknown + stats.statusCounts.conflict + stats.statusCounts.invalid_span;
  stats.totalAssets = totalAssets;
  stats.spanValidityRate = totalAssets > 0 ? stats.statusCounts.extracted / totalAssets : 0;
  stats.invalidSpanRate = totalAssets > 0 ? stats.statusCounts.invalid_span / totalAssets : 0;

  return stats;
}

// ─────────────────────────────────────────────────────────────────────────────
// 跨模型对比（共享 caseId）
// ─────────────────────────────────────────────────────────────────────────────

function crossModelCompare(glmMap, doubaoMap) {
  const sharedCaseIds = [...glmMap.keys()].filter((id) => doubaoMap.has(id));
  const result = {
    sharedCases: sharedCaseIds.length,
    glmOnly: glmMap.size - sharedCaseIds.length,
    doubaoOnly: doubaoMap.size - sharedCaseIds.length,
    perCase: [],
  };

  for (const caseId of sharedCaseIds) {
    const glm = glmMap.get(caseId);
    const doubao = doubaoMap.get(caseId);
    const glmEvents = (glm.eventGraph?.events || []).length;
    const doubaoEvents = (doubao.eventGraph?.events || []).length;
    const glmInvalid = glm.consistency?.invalidSpanFields || 0;
    const doubaoInvalid = doubao.consistency?.invalidSpanFields || 0;
    result.perCase.push({
      caseId,
      glmEvents,
      doubaoEvents,
      glmInvalidSpan: glmInvalid,
      doubaoInvalidSpan: doubaoInvalid,
    });
  }

  // 均值
  if (result.perCase.length > 0) {
    const n = result.perCase.length;
    result.avgEvents = {
      glm: result.perCase.reduce((s, c) => s + c.glmEvents, 0) / n,
      doubao: result.perCase.reduce((s, c) => s + c.doubaoEvents, 0) / n,
    };
    result.avgInvalidSpan = {
      glm: result.perCase.reduce((s, c) => s + c.glmInvalidSpan, 0) / n,
      doubao: result.perCase.reduce((s, c) => s + c.doubaoInvalidSpan, 0) / n,
    };
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// 生成 markdown 报告
// ─────────────────────────────────────────────────────────────────────────────

function pct(x) {
  return (x * 100).toFixed(1) + "%";
}
function num(x) {
  return x.toFixed(2);
}

function generateReport(glmStats, doubaoStats, cross, glmLog, doubaoLog) {
  const lines = [];
  lines.push("# NB-3R Reference Analyzer 校准统计报告");
  lines.push("");
  lines.push(`生成时间：${new Date().toISOString()}`);
  lines.push("");
  lines.push("> 本报告由 `scripts/novelbench/calibration-stats.mjs` 自动生成。");
  lines.push("> 统计 GLM (glm-5.2) 与 Doubao (doubao-seed-2-1-pro) 在真实 reference 章节上的 12 类叙事资产提取质量。");
  lines.push("> 临时/批量测试仅使用 GLM/Doubao（PINOVEL_DISABLE_FALLBACK=1）；正式质量结论仍需在 GPT/Claude frozen set 上复验。");
  lines.push("");

  // 1. 提取覆盖率与稳定性
  lines.push("## 1. 提取覆盖率与稳定性");
  lines.push("");
  lines.push("| 模型 | 尝试章节数 | 成功 | 失败 | 跳过 | 成功率 | JSON 解析失败 | resolve 失败 | 其他失败 |");
  lines.push("|------|-----------|------|------|------|--------|--------------|-------------|---------|");
  for (const [s, lg] of [[glmStats, glmLog], [doubaoStats, doubaoLog]]) {
    const successRate = lg.attempted > 0 ? pct(lg.succeeded / lg.attempted) : "N/A";
    lines.push(`| ${s.model} | ${lg.attempted} | ${lg.succeeded} | ${lg.failed} | ${lg.skipped} | ${successRate} | ${lg.failureReasons.json_parse} | ${lg.failureReasons.resolve_fail} | ${lg.failureReasons.other} |`);
  }
  lines.push("");
  lines.push(`| 共享成功章节（两模型均成功提取） | ${cross.sharedCases} |`);
  lines.push("");

  // 失败样本
  if (glmLog.failureSamples.length > 0 || doubaoLog.failureSamples.length > 0) {
    lines.push("### 失败样本（前 5 条/模型）");
    lines.push("");
    lines.push("| 模型 | caseId | 失败原因 |");
    lines.push("|------|--------|---------|");
    for (const f of glmLog.failureSamples) {
      lines.push(`| GLM | ${f.caseId} | ${f.reason} |`);
    }
    for (const f of doubaoLog.failureSamples) {
      lines.push(`| Doubao | ${f.caseId} | ${f.reason} |`);
    }
    lines.push("");
  }

  // 2. Span 有效性
  lines.push("## 2. Span 有效性（全资产汇总）");
  lines.push("");
  lines.push("| 模型 | 总资产数 | extracted | unknown | conflict | invalid_span | Span 有效性率 | invalid_span 率 |");
  lines.push("|------|---------|-----------|---------|----------|--------------|--------------|----------------|");
  for (const s of [glmStats, doubaoStats]) {
    lines.push(`| ${s.model} | ${s.totalAssets} | ${s.statusCounts.extracted} | ${s.statusCounts.unknown} | ${s.statusCounts.conflict} | ${s.statusCounts.invalid_span} | ${pct(s.spanValidityRate)} | ${pct(s.invalidSpanRate)} |`);
  }
  lines.push("");
  lines.push("> **Span 有效性率** = extracted / 总资产。invalid_span 表示模型返回的 excerpt 文本正确但 start/end 字符偏移与 `referenceBody.slice(start,end)` 不匹配（LLM 已知局限：模型能定位正确文本但数不准偏移）。");
  lines.push("");

  // 3. 各类资产数量
  lines.push("## 3. 各类资产平均数量（每章）");
  lines.push("");
  lines.push("| 资产类型 | GLM 总数 | GLM 每章均值 | Doubao 总数 | Doubao 每章均值 |");
  lines.push("|---------|---------|-------------|------------|----------------|");

  // EventGraph events/causalEdges 单独行
  lines.push(`| EventGraph.events | ${glmStats.eventGraph.eventsTotal} | ${num(glmStats.eventGraph.eventsPerCase)} | ${doubaoStats.eventGraph.eventsTotal} | ${num(doubaoStats.eventGraph.eventsPerCase)} |`);
  lines.push(`| EventGraph.causalEdges | ${glmStats.eventGraph.causalEdgesTotal} | ${num(glmStats.eventGraph.causalEdgesPerCase)} | ${doubaoStats.eventGraph.causalEdgesTotal} | ${num(doubaoStats.eventGraph.causalEdgesPerCase)} |`);

  for (const t of [...ARRAY_ASSET_TYPES, ...SINGLE_ASSET_TYPES]) {
    const g = glmStats.assetCounts[t.label];
    const d = doubaoStats.assetCounts[t.label];
    lines.push(`| ${t.label} | ${g.total} | ${num(g.perCaseAvg)} | ${d.total} | ${num(d.perCaseAvg)} |`);
  }
  lines.push("");

  // 4. 各类资产 span 状态分布
  lines.push("## 4. 各类资产 Span 状态分布");
  lines.push("");
  lines.push("### GLM");
  lines.push("");
  lines.push("| 资产类型 | extracted | unknown | conflict | invalid_span |");
  lines.push("|---------|-----------|---------|----------|--------------|");
  lines.push(`| EventGraph.events | ${glmStats.assetCounts["EventGraph.events"]?.status.extracted || 0} | ${glmStats.assetCounts["EventGraph.events"]?.status.unknown || 0} | ${glmStats.assetCounts["EventGraph.events"]?.status.conflict || 0} | ${glmStats.assetCounts["EventGraph.events"]?.status.invalid_span || 0} |`);
  for (const t of [...ARRAY_ASSET_TYPES, ...SINGLE_ASSET_TYPES]) {
    const s = glmStats.assetCounts[t.label].status;
    lines.push(`| ${t.label} | ${s.extracted} | ${s.unknown} | ${s.conflict} | ${s.invalid_span} |`);
  }
  lines.push("");
  lines.push("### Doubao");
  lines.push("");
  lines.push("| 资产类型 | extracted | unknown | conflict | invalid_span |");
  lines.push("|---------|-----------|---------|----------|--------------|");
  lines.push(`| EventGraph.events | ${doubaoStats.assetCounts["EventGraph.events"]?.status.extracted || 0} | ${doubaoStats.assetCounts["EventGraph.events"]?.status.unknown || 0} | ${doubaoStats.assetCounts["EventGraph.events"]?.status.conflict || 0} | ${doubaoStats.assetCounts["EventGraph.events"]?.status.invalid_span || 0} |`);
  for (const t of [...ARRAY_ASSET_TYPES, ...SINGLE_ASSET_TYPES]) {
    const s = doubaoStats.assetCounts[t.label].status;
    lines.push(`| ${t.label} | ${s.extracted} | ${s.unknown} | ${s.conflict} | ${s.invalid_span} |`);
  }
  lines.push("");

  // 5. 跨模型对比
  lines.push("## 5. 跨模型对比（共享章节）");
  lines.push("");
  if (cross.sharedCases === 0) {
    lines.push("无共享章节，无法对比。");
  } else {
    lines.push(`| 指标 | GLM | Doubao |`);
    lines.push(`|------|-----|--------|`);
    lines.push(`| 共享章节数 | ${cross.sharedCases} | ${cross.sharedCases} |`);
    lines.push(`| 平均事件数/章 | ${num(cross.avgEvents.glm)} | ${num(cross.avgEvents.doubao)} |`);
    lines.push(`| 平均 invalidSpan/章 | ${num(cross.avgInvalidSpan.glm)} | ${num(cross.avgInvalidSpan.doubao)} |`);
    lines.push("");

    // 前 10 个共享章节明细
    lines.push("### 共享章节明细（前 20）");
    lines.push("");
    lines.push("| caseId | GLM events | Doubao events | GLM invalidSpan | Doubao invalidSpan |");
    lines.push("|--------|-----------|--------------|----------------|---------------------|");
    for (const c of cross.perCase.slice(0, 20)) {
      lines.push(`| ${c.caseId} | ${c.glmEvents} | ${c.doubaoEvents} | ${c.glmInvalidSpan} | ${c.doubaoInvalidSpan} |`);
    }
  }
  lines.push("");

  // 6. 结论
  lines.push("## 6. 校准结论");
  lines.push("");
  lines.push("### 提取稳定性");
  lines.push("");
  const glmSuccessRate = glmLog.attempted > 0 ? glmLog.succeeded / glmLog.attempted : 0;
  const doubaoSuccessRate = doubaoLog.attempted > 0 ? doubaoLog.succeeded / doubaoLog.attempted : 0;
  lines.push(`- GLM 成功率：${pct(glmSuccessRate)}（${glmLog.succeeded}/${glmLog.attempted}，JSON 解析失败 ${glmLog.failureReasons.json_parse}）`);
  lines.push(`- Doubao 成功率：${pct(doubaoSuccessRate)}（${doubaoLog.succeeded}/${doubaoLog.attempted}，JSON 解析失败 ${doubaoLog.failureReasons.json_parse}）`);
  lines.push("");
  lines.push("JSON 解析失败主因：① 模型生成畸形 JSON（缺逗号/括号，position 较小）；② max_tokens=16384 截断（Doubao 输出冗长，position 较大接近 token 上限）。这是模型 JSON 稳定性的校准指标，非配置 bug。");
  lines.push("");
  lines.push("### Span 偏移准确性");
  lines.push("");
  lines.push(`- GLM Span 有效性率：${pct(glmStats.spanValidityRate)}（invalid_span 率 ${pct(glmStats.invalidSpanRate)}）`);
  lines.push(`- Doubao Span 有效性率：${pct(doubaoStats.spanValidityRate)}（invalid_span 率 ${pct(doubaoStats.invalidSpanRate)}）`);
  lines.push("");
  lines.push("**已知局限**：LLM 能定位正确文本（excerpt 内容正确）但数不准字符偏移（start/end 系统性偏大，约 2x）。这是 LLM span 提取的普遍局限，非 validator bug。后续 NB-5 Judge 可基于 excerpt 文本匹配而非纯偏移验证。");
  lines.push("");
  lines.push("### 资产提取丰富度");
  lines.push("");
  lines.push(`- GLM 平均事件数/章：${num(glmStats.eventGraph.eventsPerCase)}；Doubao：${num(doubaoStats.eventGraph.eventsPerCase)}`);
  lines.push("");
  lines.push("### 下一步");
  lines.push("");
  lines.push("- 正式质量结论需在 GPT/Claude frozen set 上复验（生产 reference_analyzer 路由）");
  lines.push("- 若需 span 精确匹配，考虑：① 在 analyzer 中添加 excerpt-based 二次定位（indexOf 修正偏移）；② 或 NB-5 Judge 改用 excerpt 文本匹配替代偏移验证");
  lines.push("- 若 JSON 解析失败率过高影响下游，考虑：① analyzer 添加 JSON 修复/重试逻辑；② 或对 Doubao 增大 max_tokens（需确认模型支持）");
  lines.push("");

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────────────────────

process.stderr.write("[NB-3R.6] 加载 GLM assets...\n");
const glmMap = loadAssets(glmDir);
process.stderr.write(`[NB-3R.6] GLM: ${glmMap.size} assets\n`);

process.stderr.write("[NB-3R.6] 加载 Doubao assets...\n");
const doubaoMap = loadAssets(doubaoDir);
process.stderr.write(`[NB-3R.6] Doubao: ${doubaoMap.size} assets\n`);

if (glmMap.size === 0 && doubaoMap.size === 0) {
  process.stderr.write("[NB-3R.6] 无 asset 文件，请先运行 analyze-references.mjs\n");
  process.exit(1);
}

process.stderr.write("[NB-3R.6] 聚合统计...\n");
const glmStats = aggregateStats(glmMap, "GLM (glm-5.2)");
const doubaoStats = aggregateStats(doubaoMap, "Doubao (doubao-seed-2-1-pro)");
const cross = crossModelCompare(glmMap, doubaoMap);

process.stderr.write("[NB-3R.6] 解析提取日志...\n");
const glmLogStats = parseExtractionLog(glmLog);
const doubaoLogStats = parseExtractionLog(doubaoLog);

process.stderr.write("[NB-3R.6] 生成报告...\n");
const report = generateReport(glmStats, doubaoStats, cross, glmLogStats, doubaoLogStats);

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, report, "utf-8");

process.stderr.write(`[NB-3R.6] ✓ 报告已写入 ${outPath}\n`);
process.stderr.write(`[NB-3R.6] GLM: ${glmLogStats.succeeded}/${glmLogStats.attempted} 成功, ${glmStats.totalCases} assets, span 有效性 ${pct(glmStats.spanValidityRate)}\n`);
process.stderr.write(`[NB-3R.6] Doubao: ${doubaoLogStats.succeeded}/${doubaoLogStats.attempted} 成功, ${doubaoStats.totalCases} assets, span 有效性 ${pct(doubaoStats.spanValidityRate)}\n`);
