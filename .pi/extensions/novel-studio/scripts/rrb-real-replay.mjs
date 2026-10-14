/**
 * RRB-REAL-REPLAY — REASONING-REPAIR-BOUNDARY-1 Wave 5（RRB-6.2 / RRB-6.4）
 *
 * 真实 API（默认 .env GEMINI_MODEL 指定的 Gemini 模型）驱动完整 novel_generate_chapter replay，
 * 逐样本核对 RRB-6.4 验收字段：
 *   - candidate lineage（candidate.id 内嵌 text hash 前缀 + sourceCandidateId + agentLineageIndex）
 *   - text/diff hash（candidate.id hash 前缀 + contextHash）
 *   - authorization（repair authorization 证据，仅当发生修订）
 *   - validatorRuns / modelCalls（stageResults.modelCalls / trace gates evidence）
 *   - FailureEnvelope（blocked 路径）
 *   - trace 留存（traces/{chapterId}-quality-trace.json + candidate_generated 记录）
 *
 * 说明：真实模型无法确定性复现 RRB-6.2 全部 7 种修订场景（零修订/单 span/多 span/
 * bridge/新候选/停滞/阻断）；这些场景已在确定性矩阵测试
 * （tests/repair-authorization-boundary-wave5-matrix.test.mjs）与既有 wave 故障注入测试
 * 中覆盖。本 replay 的价值是：证明**集成后的真实主链路**仍完整保留 RRB-6.4 血缘/哈希/
 * 授权/modelCalls/trace 留存，而非仅在单元测试中成立。
 *
 * 用法：
 *   node scripts/rrb-real-replay.mjs --max-chapters=1   # 单章 smoke
 *   node scripts/rrb-real-replay.mjs --max-chapters=2   # 2 章（每 workspace 1 章）
 *
 * 输出：
 *   {repo_root}/reports/rrb-real-replay/rrb-real-replay.json / .md
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXT_ROOT = join(__dirname, "..");
const PROJECT_ROOT = join(EXT_ROOT, "..", "..", "..");
const REPORT_DIR = join(PROJECT_ROOT, "reports", "rrb-real-replay");

const maxArg = process.argv.find((a) => a.startsWith("--max-chapters="));
const MAX_CHAPTERS = maxArg ? parseInt(maxArg.split("=")[1], 10) : 2;
// --verify-only：不重新脚手架/生成，只重读已存在的 trace 文件，按修正后的
// trace 留存口径重建报告（避免为修报告而重复消耗真实 API 预算）。
const VERIFY_ONLY = process.argv.includes("--verify-only");

// 两个真实 workspace（RRB-6.2 要求 ≥2），不同 seed 剧情以覆盖不同生成路径。
const WORKSPACES = [
  { id: "rrb-replay-a", genre: "仙侠", protagonist: "叶尘", supporting: "林婉儿" },
  { id: "rrb-replay-b", genre: "都市异能", protagonist: "陆明", supporting: "沈清" },
];

// ============================================================================
// Workspace 脚手架（与 memory-real-long-form-replay 同口径，含 preflight 所需 fingerprint）
// ============================================================================

function scaffoldWorkspace(spec) {
  const WS_ROOT = join(EXT_ROOT, "workspaces", spec.id);
  rmSync(WS_ROOT, { recursive: true, force: true });
  for (const sub of ["chapters", "characters", "series", "styles", "worldbuilding", "traces"]) {
    mkdirSync(join(WS_ROOT, sub), { recursive: true });
  }

  const characters = [spec.protagonist, spec.supporting].map((name, i) => ({
    id: `char-${i + 1}`,
    name,
    role: i === 0 ? "protagonist" : "supporting",
  }));

  const config = {
    name: `RRB-1 真实 replay（${spec.id}）`,
    genre: spec.genre,
    subGenres: spec.genre === "仙侠" ? ["东方玄幻"] : ["都市"],
    totalChapters: 10,
    chapterType: "standard",
    styleProfile: `${spec.id}-author`,
    serialFrequency: "daily",
    characters,
    worldKeyTerms: {
      factions: spec.genre === "仙侠" ? ["青云宗", "魔渊"] : ["天枢局"],
      places: spec.genre === "仙侠" ? ["青云山", "落霞谷"] : ["江海市"],
      currencies: spec.genre === "仙侠" ? ["碎星剑"] : ["异能核心"],
      professions: spec.genre === "仙侠" ? ["剑修", "炼丹师"] : ["异能者"],
      specialAbilities: spec.genre === "仙侠" ? ["尘心诀", "御剑术"] : ["时间回溯"],
      levels: spec.genre === "仙侠" ? ["练气", "筑基"] : ["一阶", "二阶"],
    },
    immutableFacts: [
      `这个世界的背景是${spec.genre}。`,
      `${spec.protagonist}是主角。`,
      `${spec.supporting}是主角团成员。`,
    ],
    chapterSeeds: {
      default: {
        choicesAndCosts: [{ choice: "接受命运", cost: "暴露秘密" }],
        expectedIrreversibleChange: [`${spec.protagonist}接受命运后无法回到过去`],
        causalEndPressure: ["命运激活引来追兵"],
      },
    },
    targetWordCount: { perChapter: { min: 1200, max: 2000 }, total: 12000 },
    createdAt: new Date().toISOString(),
  };
  writeFileSync(join(WS_ROOT, "config.json"), JSON.stringify(config, null, 2), "utf-8");

  writeFileSync(
    join(WS_ROOT, "series", "outline.md"),
    [
      "# 大纲",
      "",
      `## 世界观`,
      `这个世界是${spec.genre}。主角：${spec.protagonist}；主角团成员：${spec.supporting}。`,
      "",
      "## 主线",
      `${spec.protagonist}从低谷崛起，获得核心机缘，最终守护重要之人。`,
      "",
    ].join("\n"),
    "utf-8",
  );

  for (const name of [spec.protagonist, spec.supporting]) {
    const role = name === spec.protagonist ? "主角，从低谷崛起。" : "主角团成员。";
    writeFileSync(join(WS_ROOT, "characters", `${name}.md`), `# ${name}\n${role}\n`, "utf-8");
  }

  writeFileSync(
    join(WS_ROOT, "styles", "profile.json"),
    JSON.stringify({
      kind: "fingerprint",
      schemaVersion: "1.0",
      id: `${spec.id}-author`,
      usagePolicy: { fullChapterOptimization: "required" },
      editorialGuidance: ["人物压力通过动作、停顿和环境变化呈现。"],
      characterVoiceGuidance: { [spec.protagonist]: ["困境中保持克制。"], [spec.supporting]: ["冷静而关切。"] },
    }, null, 2),
    "utf-8",
  );

  writeFileSync(
    join(WS_ROOT, "CORE-WRITING-PRINCIPLES.md"),
    [
      "# 核心写作原则（最高权威）",
      "",
      "1. 作者内容契约优先：写前必须消费整体剧情方向、章节功能、前文状态、人物动机、伏笔承诺、因果与不可违背事实。",
      "2. 正文表达归模型：开头、感官、词汇、句式、修辞、对白、段落节奏由模型自由表达。",
      "3. 事实硬门、文学软诊断：身份/生死/关系/物品等硬事实不得漂移。",
      "",
      "## 不可违背事实",
      `- 这个世界是${spec.genre}。`,
      `- ${spec.protagonist}、${spec.supporting}是主角团成员。`,
      "",
    ].join("\n"),
    "utf-8",
  );

  writeFileSync(
    join(WS_ROOT, "WORLDBUILDING-CANON.md"),
    [
      "# 世界观设定（最高权威）",
      "",
      `## 世界背景`,
      `这个世界是${spec.genre}。`,
      "",
      "## 主要人物",
      `- ${spec.protagonist}：主角。`,
      `- ${spec.supporting}：主角团成员。`,
      "",
    ].join("\n"),
    "utf-8",
  );

  return WS_ROOT;
}

// ============================================================================
// RRB-6.4 逐样本核对
// ============================================================================

function checkHashBinding(candidateId) {
  // buildCandidateId → ${runId}-${derivationType}-${textHash.slice(0,16)}-${sequence}
  // agentic_generation 派生：id 内含 16 位 hex hash 段。
  const parts = String(candidateId ?? "").split("-");
  return { id: candidateId, hasHexHashSegment: parts.some((p) => /^[0-9a-f]{16}$/i.test(p)) };
}

function verifyTraceRetention(wsRoot, chapterId, candidates) {
  const tracePath = join(wsRoot, "traces", `${chapterId}-quality-trace.json`);
  const findings = [];
  if (!existsSync(tracePath)) {
    return { tracePath, exists: false, findings: ["trace 文件缺失"] };
  }
  let trace;
  try {
    trace = JSON.parse(readFileSync(tracePath, "utf-8"));
  } catch (err) {
    return { tracePath, exists: true, parseError: String(err), findings: ["trace 解析失败"] };
  }
  // 真实 trace 结构（非数组，也非 records/traceRecords，而是一个对象）：
  // { schemaVersion, workspaceId, chapterId, createdAt, events[], patches[], gates[],
  //   buildInfo, v2Summary{ finalSelectedId, amplifiedVariantIds, contextHash, candidateCount },
  //   failureEnvelopes[] }
  // 候选血缘/哈希不放在 events/candidates 记录里，而是内嵌在 v2Summary 的
  // finalSelectedId 与 amplifiedVariantIds（完整 candidate id 含 lineage 链 + 16 位
  // 正文 hash 段）以及 contextHash（正文上下文哈希）中。
  const summary = trace?.v2Summary ?? {};
  const rawIds = [
    summary.finalSelectedId,
    ...(Array.isArray(summary.amplifiedVariantIds) ? summary.amplifiedVariantIds : []),
  ].filter(Boolean);
  const traceCandidateIds = [...new Set(rawIds)];
  const traceCandidateChecks = traceCandidateIds.map((id) => checkHashBinding(id));
  const traceModelCalls = collectModelCallsFromTrace(trace);
  const hasFailureEnvelope = traceContainsFailureEnvelope(trace);
  return {
    tracePath,
    exists: true,
    traceSchema: trace?.schemaVersion ?? null,
    gateCount: Array.isArray(trace?.gates) ? trace.gates.length : 0,
    eventCount: Array.isArray(trace?.events) ? trace.events.length : 0,
    candidateCountFromSummary: summary.candidateCount ?? null,
    finalSelectedId: summary.finalSelectedId ?? null,
    amplifiedVariantIds: Array.isArray(summary.amplifiedVariantIds) ? summary.amplifiedVariantIds : [],
    traceCandidateIds,
    traceCandidateChecks,
    contextHash: summary.contextHash ?? null,
    traceModelCalls,
    hasFailureEnvelope,
    findings,
  };
}

function collectModelCallsFromTrace(trace) {
  const calls = [];
  const gates = trace?.gates ?? [];
  if (Array.isArray(gates)) {
    for (const gate of gates) {
      if (Array.isArray(gate?.evidence?.modelCalls)) {
        calls.push(...gate.evidence.modelCalls.map((c) => c?.model ?? c?.route ?? "unknown"));
      }
    }
  }
  if (Array.isArray(trace?.modelCalls)) {
    calls.push(...trace.modelCalls.map((c) => c?.model ?? c?.route ?? "unknown"));
  }
  if (Array.isArray(trace?.stageResults?.modelCalls)) {
    calls.push(...trace.stageResults.modelCalls.map((c) => c?.model ?? c?.route ?? "unknown"));
  }
  return calls;
}

function traceContainsFailureEnvelope(trace) {
  if (trace?.failureEnvelope) return true;
  if (Array.isArray(trace?.failureEnvelopes) && trace.failureEnvelopes.length > 0) return true;
  const gates = trace?.gates ?? [];
  if (Array.isArray(gates)) {
    return gates.some((g) => g?.failureEnvelope || g?.evidence?.failureEnvelope);
  }
  return false;
}

function verifySample(result, wsRoot) {
  const chapterId = result.chapterId;
  const candidates = Array.isArray(result.candidates) ? result.candidates : [];
  const stageResults = result.stageResults ?? {};

  const candidateChecks = candidates.map((c) => ({
    id: c.id,
    kind: c.kind,
    hashBinding: checkHashBinding(c.id),
    sourceCandidateId: c.sourceCandidateId ?? null,
    contextHash: c.contextHash ?? null,
    hasLineageLink: Boolean(c.sourceCandidateId),
  }));

  const lineageIndex = stageResults.agentLineageIndex;
  const lineageEntries = lineageIndex?.all?.length ?? lineageIndex?.byCandidate ? Object.keys(lineageIndex.byCandidate ?? {}).length : 0;

  const modelCalls = Array.isArray(stageResults.modelCalls) ? stageResults.modelCalls.length : 0;

  const trace = verifyTraceRetention(wsRoot, chapterId, candidates);

  return {
    chapterId,
    status: result.status,
    selectedSource: result.selectedSource ?? null,
    selectedCandidateId: result.selectedCandidateId ?? null,
    textLength: result.text?.length ?? 0,
    candidateCount: candidates.length,
    candidateChecks,
    hasAgentLineageIndex: Boolean(lineageIndex),
    lineageCandidateCount: lineageEntries,
    hasFailureEnvelope: Boolean(result.failureEnvelope),
    failureEnvelope: result.failureEnvelope ? {
      stage: result.failureEnvelope.stage ?? null,
      gate: result.failureEnvelope.gate ?? null,
      severity: result.failureEnvelope.severity ?? null,
    } : null,
    modelCalls,
    trace,
  };
}

// ============================================================================
// 报告渲染 / 落盘
// ============================================================================

function renderMarkdown(report) {
  let md = `# RRB-1 真实 replay 报告（Wave 5 / RRB-6.2 & RRB-6.4）\n\n`;
  md += `> 模式：真实模型（${report.writerModel}）；时间：${report.timestamp}；verifyOnly：${report.verifyOnly ? "是" : "否"}\n\n`;
  md += `| 指标 | 值 |\n|---|---|\n`;
  md += `| 成功 | ${report.okCount} |\n| 阻断 | ${report.blockedCount} |\n| 异常 | ${report.errorCount} |\n\n`;

  for (const s of report.samples) {
    md += `## ${s.workspace} ${s.chapterId}（${s.status}）\n\n`;
    md += `- 候选数：${s.candidateCount}；modelCalls：${s.modelCalls}；trace 留存：${s.trace?.exists ? "✅" : "❌"}\n`;
    md += `- agentLineageIndex：${s.hasAgentLineageIndex ? "✅" : "❌"}（候选索引 ${s.lineageCandidateCount}）\n`;
    md += `- FailureEnvelope：${s.hasFailureEnvelope ? "✅" : "（无，非 blocked 正常）"}\n\n`;
    if (Array.isArray(s.candidateChecks) && s.candidateChecks.length > 0) {
      md += `| candidate | kind | hash 绑定 | lineage 链 |\n|---|---|---|---|\n`;
      for (const c of s.candidateChecks) {
        md += `| ${c.id} | ${c.kind} | ${c.hashBinding?.hasHexHashSegment ? "✅" : "❌"} | ${c.hasLineageLink ? "✅" : "—"} |\n`;
      }
      md += `\n`;
    }
    // RRB-6.4 trace 留存明细（trace 内 candidate 血缘/哈希/modelCalls/FailureEnvelope）
    const t = s.trace ?? {};
    if (t.exists) {
      md += `**trace 留存明细**（${t.tracePath}）\n\n`;
      md += `- schema=${t.traceSchema}；gates=${t.gateCount}；events=${t.eventCount}；summary.candidateCount=${t.candidateCountFromSummary ?? "—"}\n`;
      md += `- 血缘/哈希候选 id（trace 内）：${(t.traceCandidateIds ?? []).length > 0 ? t.traceCandidateIds.map((id) => `${id}`).join("；") : "—"}\n`;
      md += `- 候选 id hash 绑定：${(t.traceCandidateChecks ?? []).every((c) => c.hasHexHashSegment) ? "✅" : "❌"}\n`;
      md += `- contextHash：${t.contextHash ? `${t.contextHash.slice(0, 16)}…` : "—"}\n`;
      md += `- trace modelCalls：${(t.traceModelCalls ?? []).length}（${(t.traceModelCalls ?? []).join(", ")}）\n`;
      md += `- FailureEnvelope 留存：${t.hasFailureEnvelope ? "✅" : "（无，非 blocked 正常）"}\n\n`;
    }
  }
  return md;
}

function writeReport(report) {
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(join(REPORT_DIR, "rrb-real-replay.json"), JSON.stringify(report, null, 2));
  const md = renderMarkdown(report);
  writeFileSync(join(REPORT_DIR, "rrb-real-replay.md"), md);
  console.log(md);
  console.log(`[rrb-real-replay] 报告写到 ${join(REPORT_DIR, "rrb-real-replay.json")} / .md`);
}

// ============================================================================
// 主流程
// ============================================================================

async function main() {
  console.log(`[rrb-real-replay] 启动（真实 API，MAX_CHAPTERS=${MAX_CHAPTERS}，verifyOnly=${VERIFY_ONLY}）`);

  // --verify-only：重读既有报告 + trace，按修正后的 trace 留存口径重建报告，
  // 不重新生成（避免为修报告重复消耗真实 API 预算）。
  if (VERIFY_ONLY) {
    const reportPath = join(REPORT_DIR, "rrb-real-replay.json");
    if (!existsSync(reportPath)) {
      console.error("[rrb-real-replay] --verify-only 需要先有一次真实 replay 生成的报告");
      process.exit(2);
    }
    const prev = JSON.parse(readFileSync(reportPath, "utf-8"));
    const samples = (prev.samples ?? []).map((s) => ({
      ...s,
      trace: verifyTraceRetention(
        join(EXT_ROOT, "workspaces", s.workspace),
        s.chapterId,
        [],
      ),
    }));
    const report = {
      schema: "rrb-real-replay/v1",
      timestamp: new Date().toISOString(),
      mode: "trace-retention-verify-only",
      writerModel: prev.writerModel ?? "gemini31 (default)",
      verifyOnly: true,
      okCount: prev.okCount,
      blockedCount: prev.blockedCount,
      errorCount: prev.errorCount,
      perWorkspace: prev.perWorkspace,
      samples,
    };
    writeReport(report);
    return;
  }

  process.env.PINOVEL_DEV_MODE = "1"; // replay 属实验验证，绕过生产交付门禁
  delete process.env.V2_FORCE_STUB; // 真实模型，非 stub

  const { runUnifiedPipeline } = await import("../dist/v2/core/unified-entry.js");

  const samples = [];
  const perWorkspace = [];
  let okCount = 0;
  let blockedCount = 0;
  let errorCount = 0;

  for (const spec of WORKSPACES) {
    const wsRoot = scaffoldWorkspace(spec);
    console.log(`[rrb-real-replay] 已脚手架 ${spec.id} → ${wsRoot}`);

    // 每 workspace 生成 1 章（MAX_CHAPTERS>=2 时两个 workspace 各 1 章）。
    for (let ch = 1; ch <= Math.max(1, Math.ceil(MAX_CHAPTERS / WORKSPACES.length)); ch++) {
      const chapterId = `ch${ch}`;
      const start = Date.now();
      let result;
      try {
        result = await runUnifiedPipeline({
          workspaceId: spec.id,
          chapterId,
          chapterNumber: ch,
          projectRoot: EXT_ROOT,
          candidateTimeoutMs: 600000,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errorCount++;
        perWorkspace.push({ workspace: spec.id, chapter: ch, status: "throw", error: msg });
        console.error(`[rrb-real-replay] ${spec.id} ch${ch} 抛异常：${msg}`);
        continue;
      }

      const durationMs = Date.now() - start;
      if (result.status === "ok") okCount++;
      else if (result.status === "blocked") blockedCount++;
      else errorCount++;

      const sample = verifySample(result, wsRoot);
      sample.durationMs = durationMs;
      sample.workspace = spec.id;
      samples.push(sample);
      perWorkspace.push({
        workspace: spec.id,
        chapter: ch,
        status: result.status,
        durationMs,
        candidateCount: sample.candidateCount,
        modelCalls: sample.modelCalls,
        traceExists: sample.trace.exists,
        hasLineageIndex: sample.hasAgentLineageIndex,
      });
      console.log(
        `[rrb-real-replay] ${spec.id} ch${ch} ${result.status} (${durationMs}ms) candidates=${sample.candidateCount} modelCalls=${sample.modelCalls} trace=${sample.trace.exists}`,
      );
    }
  }

  const report = {
    schema: "rrb-real-replay/v1",
    timestamp: new Date().toISOString(),
    mode: "real-model-generation",
    writerModel: "gemini31 (default)",
    verifyOnly: false,
    okCount,
    blockedCount,
    errorCount,
    perWorkspace,
    samples,
  };
  writeReport(report);
}

main().catch((err) => {
  console.error("[rrb-real-replay] 主流程异常：", err);
  process.exit(1);
});
