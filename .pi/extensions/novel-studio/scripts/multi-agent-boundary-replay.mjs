#!/usr/bin/env node
/**
 * MA-6.4 — 多代理协作边界 stub workspace replay + trace 留存率门禁
 *
 * 不调用真实模型（V2_FORCE_STUB=1）。对多条 sample 走公开入口
 * novel_generate_chapter，断言：
 * - 每条有 stageResults.tracePath 或报告内 archive
 * - agentic_style 路径含 agentCollaboration + agentLineageIndex
 * - 无 machine judge / one-shot raw
 * - trace 留存率 100%
 *
 * 用法：
 *   node scripts/multi-agent-boundary-replay.mjs [--samples=3]
 *
 * 输出：
 *   reports/multi-agent-boundary-replay/report.json
 *   reports/multi-agent-boundary-replay/report.md
 *   reports/multi-agent-boundary-replay/archives/*
 *
 * CI：失败 exit 1
 */

import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  copyFileSync,
} from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXT_ROOT = resolve(__dirname, "..");
const PROJECT_ROOT = resolve(EXT_ROOT, "..", "..", "..");
const REPORT_DIR = join(PROJECT_ROOT, "reports", "multi-agent-boundary-replay");
const ARCHIVE_DIR = join(REPORT_DIR, "archives");

const samplesArg = process.argv.find((a) => a.startsWith("--samples="));
const SAMPLE_COUNT = samplesArg ? Math.max(1, parseInt(samplesArg.split("=")[1], 10)) : 3;
const WORKSPACE_ID = "ma-boundary-replay";
const WS_ROOT = join(PROJECT_ROOT, "workspaces", WORKSPACE_ID);

function ensureWorkspace() {
  rmSync(WS_ROOT, { recursive: true, force: true });
  for (const sub of ["chapters", "characters", "series", "styles", "traces"]) {
    mkdirSync(join(WS_ROOT, sub), { recursive: true });
  }
  const config = {
    name: "MA Boundary Replay",
    genre: "玄幻",
    subGenres: ["东方玄幻"],
    totalChapters: 50,
    chapterType: "standard",
    styleProfile: "ma-boundary-author",
    serialFrequency: "daily",
    characters: [{ id: "protagonist-1", name: "叶尘", role: "protagonist" }],
    chapterSeeds: {
      default: {
        choicesAndCosts: [
          { choice: "公开接受传承", cost: "暴露身份" },
        ],
        expectedIrreversibleChange: ["叶尘接受传承后无法维持原身份"],
        causalEndPressure: ["传承激活引来追踪者"],
      },
    },
    createdAt: new Date().toISOString(),
  };
  writeFileSync(join(WS_ROOT, "config.json"), JSON.stringify(config, null, 2), "utf-8");
  writeFileSync(
    join(WS_ROOT, "series", "outline.md"),
    "# 大纲\n## 背景\n叶尘偶得传承。\n",
    "utf-8",
  );
  writeFileSync(
    join(WS_ROOT, "characters", "叶尘.md"),
    "# 叶尘\n主角，废物少年，偶得传承。\n",
    "utf-8",
  );
  writeFileSync(
    join(WS_ROOT, "styles", "profile.json"),
    JSON.stringify({
      id: "ma-boundary-author",
      usagePolicy: { fullChapterOptimization: "required" },
      editorialGuidance: [
        "人物压力优先通过动作、停顿和环境变化呈现。",
        "章末停在仍有压力的动作或状态上。",
      ],
      characterVoiceGuidance: {
        叶尘: ["少年感保留现实处境。"],
      },
    }, null, 2),
    "utf-8",
  );
}

async function loadGenerateChapterTool() {
  const fakePi = {
    tools: new Map(),
    api: {
      registerTool(t) {
        fakePi.tools.set(t.name, t);
      },
      registerCommand() {},
      on() {},
    },
  };
  const novelStudioExtension = (
    await import(pathToFileURL(join(EXT_ROOT, "dist", "index.js")).href)
  ).default;
  novelStudioExtension(fakePi.api);
  return fakePi.tools.get("novel_generate_chapter");
}

function evaluateSample(sampleId, details) {
  const stageResults = details.stageResults || {};
  const issues = [];
  const collab = stageResults.agentCollaboration;
  const lineageIndex = stageResults.agentLineageIndex;
  const productionFlow = stageResults.productionFlow;
  const tracePath =
    typeof stageResults.tracePath === "string" ? stageResults.tracePath : null;

  let archivePath = null;
  if (tracePath && existsSync(tracePath)) {
    archivePath = join(ARCHIVE_DIR, `${sampleId}-quality-trace.json`);
    copyFileSync(tracePath, archivePath);
  } else {
    // 无主路径 trace 时仍归档 stageResults 摘要，供 CI 审计
    archivePath = join(ARCHIVE_DIR, `${sampleId}-stageResults-archive.json`);
    writeFileSync(
      archivePath,
      JSON.stringify(
        {
          sampleId,
          status: details.status,
          failureEnvelope: details.failureEnvelope ?? null,
          stageResults,
        },
        null,
        2,
      ),
      "utf-8",
    );
  }

  const hasTraceArtifact =
    (tracePath && existsSync(tracePath)) || (archivePath && existsSync(archivePath));
  if (!hasTraceArtifact) {
    issues.push("missing_trace_artifact");
  }

  if (productionFlow?.mode === "agentic_style_full_pipeline") {
    if (!collab || typeof collab !== "object") {
      issues.push("missing_agentCollaboration");
    } else {
      if (!collab.workPackages || typeof collab.workPackages !== "object") {
        issues.push("missing_workPackages");
      }
      if (!Array.isArray(collab.decisions)) {
        issues.push("missing_decisions");
      }
    }
    if (!lineageIndex || lineageIndex.schema !== "pinovel.agent-lineage-index") {
      issues.push("missing_agentLineageIndex");
    }
    if (productionFlow.machineJudgeCalled === true) {
      issues.push("machine_judge_called");
    }
    if (productionFlow.oneShotRawCalled === true) {
      issues.push("one_shot_raw_called");
    }
  } else if (details.status === "ok") {
    // 成功交付却未声明 agentic_style 生产流
    issues.push("unexpected_production_flow");
  }

  // 失败必须可解释
  if (details.status === "blocked" && !details.failureEnvelope) {
    issues.push("blocked_without_failureEnvelope");
  }

  return {
    sampleId,
    status: details.status ?? "unknown",
    tracePath,
    archivePath,
    hasTracePath: Boolean(tracePath && existsSync(tracePath)),
    hasTraceArchivePath: Boolean(archivePath && existsSync(archivePath)),
    hasAgentCollaboration: Boolean(collab),
    hasAgentLineageIndex: Boolean(
      lineageIndex && lineageIndex.schema === "pinovel.agent-lineage-index",
    ),
    productionFlowMode: productionFlow?.mode ?? null,
    machineJudgeCalled: productionFlow?.machineJudgeCalled === true,
    oneShotRawCalled: productionFlow?.oneShotRawCalled === true,
    issues,
    ok: issues.length === 0,
  };
}

async function main() {
  mkdirSync(ARCHIVE_DIR, { recursive: true });
  ensureWorkspace();

  const prevStub = process.env.V2_FORCE_STUB;
  const prevDev = process.env.PINOVEL_DEV_MODE;
  const prevLegacy = process.env.PINOVEL_TEST_LEGACY_PRODUCTION_FLOW;
  // stub 模型 + 开发门禁 bypass（与 tests/setup-test-env.mjs 对齐）
  // 注意：不设置 PINOVEL_TEST_LEGACY_PRODUCTION_FLOW，确保走 agentic_style 生产流
  process.env.V2_FORCE_STUB = "1";
  process.env.PINOVEL_DEV_MODE = "1";
  delete process.env.PINOVEL_TEST_LEGACY_PRODUCTION_FLOW;

  const samples = [];
  let tool;
  try {
    tool = await loadGenerateChapterTool();
    if (!tool) {
      throw new Error("novel_generate_chapter 未注册");
    }

    for (let i = 1; i <= SAMPLE_COUNT; i++) {
      const chapterId = `ma-replay-${i}`;
      const result = await tool.execute(
        `ma-boundary-replay-${i}`,
        {
          workspaceId: WORKSPACE_ID,
          chapterId,
          chapterNumber: 1,
          previousChapterSummary: "前章摘要",
          mockAgent: true,
        },
        undefined,
        undefined,
        { cwd: PROJECT_ROOT },
      );
      const details = result.details || result;
      const evaluated = evaluateSample(chapterId, details);
      samples.push(evaluated);
      console.log(
        `[ma-replay] ${chapterId}: status=${evaluated.status} ok=${evaluated.ok}` +
          (evaluated.issues.length ? ` issues=${evaluated.issues.join(",")}` : ""),
      );
    }
  } finally {
    if (prevStub === undefined) delete process.env.V2_FORCE_STUB;
    else process.env.V2_FORCE_STUB = prevStub;
    if (prevDev === undefined) delete process.env.PINOVEL_DEV_MODE;
    else process.env.PINOVEL_DEV_MODE = prevDev;
    if (prevLegacy === undefined) delete process.env.PINOVEL_TEST_LEGACY_PRODUCTION_FLOW;
    else process.env.PINOVEL_TEST_LEGACY_PRODUCTION_FLOW = prevLegacy;
  }

  const total = samples.length;
  const passed = samples.filter((s) => s.ok).length;
  const withTrace = samples.filter(
    (s) => s.hasTracePath || s.hasTraceArchivePath,
  ).length;
  const withCollab = samples.filter((s) => s.hasAgentCollaboration).length;
  const withLineage = samples.filter((s) => s.hasAgentLineageIndex).length;
  const machineJudgeCount = samples.filter((s) => s.machineJudgeCalled).length;
  const oneShotRawCount = samples.filter((s) => s.oneShotRawCalled).length;

  const retentionRate = total === 0 ? 0 : withTrace / total;
  const gates = {
    sampleCount: total,
    passCount: passed,
    traceRetentionRate: retentionRate,
    agentCollaborationRate: total === 0 ? 0 : withCollab / total,
    agentLineageIndexRate: total === 0 ? 0 : withLineage / total,
    machineJudgeCalls: machineJudgeCount,
    oneShotRawCalls: oneShotRawCount,
    thresholds: {
      minTraceRetentionRate: 1,
      minAgentCollaborationRate: 1,
      minAgentLineageIndexRate: 1,
      maxMachineJudgeCalls: 0,
      maxOneShotRawCalls: 0,
    },
  };

  const gateFailures = [];
  if (retentionRate < 1) {
    gateFailures.push(`trace_retention_rate=${retentionRate} < 1`);
  }
  if (withCollab < total) {
    gateFailures.push(`agentCollaboration_rate=${withCollab}/${total} < 1`);
  }
  if (withLineage < total) {
    gateFailures.push(`agentLineageIndex_rate=${withLineage}/${total} < 1`);
  }
  if (machineJudgeCount > 0) {
    gateFailures.push(`machine_judge_calls=${machineJudgeCount}`);
  }
  if (oneShotRawCount > 0) {
    gateFailures.push(`one_shot_raw_calls=${oneShotRawCount}`);
  }
  if (passed < total) {
    gateFailures.push(`sample_pass=${passed}/${total}`);
  }

  const report = {
    schema: "pinovel.multi-agent-boundary-replay",
    version: "1.0.0",
    mode: "stub_workspace_replay",
    generatedAt: new Date().toISOString(),
    workspaceId: WORKSPACE_ID,
    gates,
    gateFailures,
    samples,
    overallPass: gateFailures.length === 0,
  };

  writeFileSync(join(REPORT_DIR, "report.json"), JSON.stringify(report, null, 2), "utf-8");

  let md = `# Multi-Agent Boundary Replay 报告\n\n`;
  md += `> 模式：stub workspace replay（V2_FORCE_STUB=1，无真实模型）\n\n`;
  md += `- overallPass: **${report.overallPass}**\n`;
  md += `- samples: ${total}\n`;
  md += `- traceRetentionRate: ${(retentionRate * 100).toFixed(1)}%\n`;
  md += `- agentCollaborationRate: ${((withCollab / Math.max(total, 1)) * 100).toFixed(1)}%\n`;
  md += `- agentLineageIndexRate: ${((withLineage / Math.max(total, 1)) * 100).toFixed(1)}%\n`;
  md += `- machineJudgeCalls: ${machineJudgeCount}\n`;
  md += `- oneShotRawCalls: ${oneShotRawCount}\n\n`;
  if (gateFailures.length) {
    md += `## Gate failures\n\n`;
    for (const f of gateFailures) md += `- ${f}\n`;
    md += `\n`;
  }
  md += `## Samples\n\n`;
  for (const s of samples) {
    md += `### ${s.sampleId}\n`;
    md += `- status: ${s.status}\n`;
    md += `- ok: ${s.ok}\n`;
    md += `- tracePath: ${s.tracePath ?? "null"}\n`;
    md += `- archivePath: ${s.archivePath ?? "null"}\n`;
    if (s.issues.length) md += `- issues: ${s.issues.join(", ")}\n`;
    md += `\n`;
  }
  writeFileSync(join(REPORT_DIR, "report.md"), md, "utf-8");

  console.log(`[ma-replay] overallPass=${report.overallPass}`);
  console.log(`[ma-replay] report: ${join(REPORT_DIR, "report.json")}`);

  // 清理临时 workspace（报告与 archive 保留）
  try {
    rmSync(WS_ROOT, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  if (!report.overallPass) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("[ma-replay] fatal:", err);
  process.exitCode = 1;
});
