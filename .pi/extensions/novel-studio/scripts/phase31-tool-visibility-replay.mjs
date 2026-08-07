#!/usr/bin/env node
/**
 * PHASE-31-TOOL-VISIBILITY-REPLAY：Phase 3.1 收口 — 完整 eval-only replay 工具可见性证据
 *
 * 用真实 createAgenticRawCandidateSource（经 runAgentLoopForEval 的 b2 全链路）跑一次
 * 确定性 eval-only replay（stub model，零真实模型调用），产出真实持久化 trajectory，
 * 并核对 allowedTools → runtime tools → schema → visibleTools 全链路。
 *
 * 用法：
 *   node scripts/phase31-tool-visibility-replay.mjs [--output <dir>]
 *
 * 选项：
 *   --output <dir>   输出目录（默认 reports/phase31-tool-visibility/）
 *
 * 产物：
 *   reports/phase31-tool-visibility/replay-trajectory.jsonl  真实持久化 trajectory 副本
 *   reports/phase31-tool-visibility/verification-report.json  全链路核对结果
 *   reports/phase31-tool-visibility/verification-report.md    人类可读核对报告
 */

import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync, copyFileSync, existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const { values } = parseArgs({
  options: {
    "output": { type: "string" },
    "help": { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  process.stdout.write(`PHASE-31-TOOL-VISIBILITY-REPLAY CLI：Phase 3.1 收口 tool_visibility 证据

用法：
  node scripts/phase31-tool-visibility-replay.mjs [--output <dir>]

选项：
  --output <dir>   输出目录（默认 reports/phase31-tool-visibility/）

产物：
  replay-trajectory.jsonl   真实持久化 trajectory 副本
  verification-report.json  全链路核对结果
  verification-report.md    人类可读核对报告
`);
  process.exit(0);
}

// ── 路径常量 ──────────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = resolve(__filename, "..");
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..", "..", "..", "..");
const EXT_ROOT = join(PROJECT_ROOT, ".pi", "extensions", "novel-studio");
const OUTPUT_DIR = values.output
  ? resolve(values.output)
  : join(PROJECT_ROOT, "reports", "phase31-tool-visibility");

const evalHarnessUrl = pathToFileURL(join(EXT_ROOT, "dist-eval", "novelos", "eval", "eval-harness.js")).href;
const fixturesUrl = pathToFileURL(join(EXT_ROOT, "dist-eval", "novelos", "eval", "fixtures.js")).href;
const injectorUrl = pathToFileURL(join(EXT_ROOT, "dist", "novelos", "adapters", "tool-schema-injector.js")).href;
const narrativeToolsUrl = pathToFileURL(join(EXT_ROOT, "dist", "novelos", "tools", "narrative-tools.js")).href;
const searchServiceUrl = pathToFileURL(join(EXT_ROOT, "dist", "novelos", "agent", "narrative-search-service.js")).href;

const { setupFixtureWorkspace, runAgentLoopForEval } = await import(evalHarnessUrl);
const { EVAL_FIXTURES } = await import(fixturesUrl);
const { injectToolSchemas, REACT_CALLING_CONVENTION } = await import(injectorUrl);
const { createNarrativeTools, NARRATIVE_TOOL_NAMES } = await import(narrativeToolsUrl);
const { createNarrativeSearchService } = await import(searchServiceUrl);

// ── 读取 trajectory，按 type 分组 ─────────────────────────────────────────
function readTrajectory(trajectoryPath) {
  const byType = new Map();
  for (const line of readFileSync(trajectoryPath, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line);
    if (!byType.has(entry.type)) byType.set(entry.type, []);
    byType.get(entry.type).push(entry.data);
  }
  return byType;
}

const fixture = EVAL_FIXTURES.find((f) => f.id === "F1-historical-fact");
if (!fixture) {
  console.error("找不到 F1-historical-fact fixture");
  process.exit(1);
}

const { projectRoot, workspaceId, cleanup } = setupFixtureWorkspace(fixture);
let byType;
let result;
try {
  // b2 = enableRetrieval=true, enableVerification=false（有检索工具，触发真实工具调用）
  result = await runAgentLoopForEval(fixture, "b2", projectRoot, workspaceId);
  if (!result.trajectoryPath || !existsSync(result.trajectoryPath)) {
    throw new Error("trajectory 未落盘：缺少持久化 trace 证据");
  }
  byType = readTrajectory(result.trajectoryPath);

  // 复制真实 trajectory 到报告目录（持久化证据副本）
  mkdirSync(OUTPUT_DIR, { recursive: true });
  copyFileSync(result.trajectoryPath, join(OUTPUT_DIR, "replay-trajectory.jsonl"));
} finally {
  cleanup();
}

// ── 全链路核对 ────────────────────────────────────────────────────────────
const vis = byType.get("tool_visibility") ?? [];
const snapshot = vis[vis.length - 1];
const checks = [];

// 链路1：visibleTools ⊆ systemAllowedTools
let link1 = true;
for (const t of snapshot.visibleTools) {
  if (!snapshot.systemAllowedTools.includes(t)) { link1 = false; break; }
}
checks.push({ name: "allowedTools→runtime tools：visibleTools ⊆ systemAllowedTools", passed: link1 });

// 链路2：rejectedTools ∩ visibleTools = ∅
const link2 = snapshot.rejectedTools.every((t) => !snapshot.visibleTools.includes(t));
checks.push({ name: "rejectedTools 不可见：rejectedTools ∩ visibleTools = ∅", passed: link2 });

// 链路3：runtime tools / schema — 过滤后的真实工具 == visibleTools，且可注入
const searchService = createNarrativeSearchService({
  projectRoot, workspaceId, sourceChapter: fixture.chapterIntent.chapterId ?? "ch3",
});
const allTools = createNarrativeTools({ searchService });
const visibleFiltered = allTools.filter((t) => snapshot.visibleTools.includes(t.name));
const toolNamesMatch =
  visibleFiltered.length === snapshot.visibleTools.length &&
  JSON.stringify(visibleFiltered.map((t) => t.name).sort()) ===
    JSON.stringify([...snapshot.visibleTools].sort());
let schemaOk = false;
try {
  const injected = injectToolSchemas("你是网文作家。", visibleFiltered, NARRATIVE_TOOL_NAMES);
  schemaOk = injected.includes(REACT_CALLING_CONVENTION);
} catch {
  schemaOk = false;
}
checks.push({ name: "runtime tools == visibleTools（过滤后真实工具名一致）", passed: toolNamesMatch });
checks.push({ name: "schema 注入：filtered 工具可被 injectToolSchemas 注入", passed: schemaOk });

// 链路4：实际执行工具 ⊆ visibleTools
const metrics = byType.get("tool_call_metrics") ?? [];
const link4 = metrics.every((m) => snapshot.visibleTools.includes(m.toolName));
checks.push({ name: "实际执行工具 ⊆ visibleTools", passed: link4 });

const allPassed = checks.every((c) => c.passed);

// ── 汇总报告 ──────────────────────────────────────────────────────────────
const metricsSummary = metrics.map((m) => ({
  toolName: m.toolName,
  query: m.args?.query ?? "",
  resultChars: m.resultChars,
  evidenceLevel: m.evidenceLevel,
  sourceRefCount: m.sourceRefCount,
  empty: m.empty,
  timeout: m.timeout,
  isError: m.isError,
  duplicateQuery: m.duplicateQuery,
}));

const report = {
  timestamp: new Date().toISOString(),
  fixtureId: fixture.id,
  mode: "b2",
  model: "stub（零真实模型调用）",
  candidateFallback: result.candidate === null,
  trajectoryPath: result.trajectoryPath,
  trajectoryCopiedTo: join(OUTPUT_DIR, "replay-trajectory.jsonl"),
  tool_visibility: {
    systemAllowedTools: snapshot.systemAllowedTools,
    selectedTools: snapshot.selectedTools,
    rejectedTools: snapshot.rejectedTools,
    visibleTools: snapshot.visibleTools,
  },
  tool_call_metrics: metricsSummary,
  checks,
  allChecksPassed: allPassed,
};

writeFileSync(join(OUTPUT_DIR, "verification-report.json"), JSON.stringify(report, null, 2), "utf-8");

const md = [
  "# Phase 3.1 收口 — tool_visibility 全链路核对报告",
  "",
  `**时间**：${report.timestamp}`,
  `**Fixture**：${fixture.id}（b2 eval-only replay，stub model，零真实模型调用）`,
  `**候选 fallback**：${report.candidateFallback ? "是" : "否"}`,
  `**全链路核对**：**${allPassed ? "PASS" : "FAIL"}**`,
  "",
  "## 核对项",
  "",
  "| 链路 | 结果 |",
  "|------|------|",
  ...checks.map((c) => `| ${c.name} | ${c.passed ? "✓" : "✗"} |`),
  "",
  "## tool_visibility 快照",
  "",
  `- systemAllowedTools：${snapshot.systemAllowedTools.join(", ")}`,
  `- selectedTools：${snapshot.selectedTools.join(", ")}`,
  `- rejectedTools：${snapshot.rejectedTools.join(", ")}`,
  `- visibleTools：${snapshot.visibleTools.join(", ")}`,
  "",
  "## 实际工具调用",
  "",
  metricsSummary.length === 0
    ? "（本次 replay 无工具实际执行）"
    : "| 工具 | query | 字符数 | evidenceLevel | sourceRef 数 | 空 | 超时 | 错误 | 重复查询 |",
  metricsSummary.length === 0 ? "" : "|------|-------|--------|---------------|-------------|-----|------|------|---------|",
  ...(metricsSummary.length === 0
    ? []
    : metricsSummary.map(
        (m) =>
          `| ${m.toolName} | ${m.query} | ${m.resultChars} | ${m.evidenceLevel ?? "-"} | ${m.sourceRefCount} | ${m.empty ? "✓" : "✗"} | ${m.timeout ? "✓" : "✗"} | ${m.isError ? "✓" : "✗"} | ${m.duplicateQuery ? "✓" : "✗"} |`,
      )),
  "",
  `## 持久化证据`,
  `- 原始 trajectory：${result.trajectoryPath}`,
  `- 报告副本：${report.trajectoryCopiedTo}`,
  "",
  `验收：allowedTools → runtime tools → schema → visibleTools 全链路${allPassed ? "一致" : "存在不一致"}。`,
  "",
].join("\n");

writeFileSync(join(OUTPUT_DIR, "verification-report.md"), md, "utf-8");

process.stdout.write(md);
process.exit(allPassed ? 0 : 1);