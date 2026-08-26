#!/usr/bin/env node
/**
 * AGENTIC-EVIDENCE-MERGE-1 §9 三条交付物 trace 构造脚本。
 *
 * 构造计划要求的三条可审计 trace：
 * 1. 检索后生成 trace（firstAction=tool_call, retrieval>0）
 *    — 用 eval-harness b2 模式（createAgenticRawCandidateSource 生产代码 + stub 模型），
 *      F1-historical-fact fixture 有 retrievalQueries，stub 必然发 search_narrative_evidence 指令。
 *      归档 trajectory.jsonl + AgenticRawSourceResult 摘要为可审计制品。
 * 2. coverage 不足阻断 trace（mustVerify 未被 contextCoveredFacts 覆盖）
 *    - 用 runUnifiedPipeline + V2_FORCE_STUB=1（受控），
 *      ch1-outline-explicit.md 用 `## 事件 1` 格式 + `必须包含` 注入不在 immutableFacts 中的事实，
 *      使 mustVerify 包含此事实但 contextCoveredFacts 不含它 -> coverage 门阻断。
 *      注意：此构造依赖旧的 mustVerify 语义（authorMustInclude 进入 mustVerify），
 *      该语义已于 2026-08-25 作为 coverage gate 死锁缺陷修复（待写内容不再进入 mustVerify）；
 *      修复后本用例预期 coveragePassed=true（章纲待写事实不再触发阻断），可作为死锁修复的行为验证。
 * 3. envelope 级 recoverable failure trace（gate=model_timeout, severity=recoverable）
 *    — 用 runUnifiedPipeline + 真实模型 + PINOVEL_MODEL_REQUEST_TIMEOUT_MS=100，
 *      100ms 太短，真实模型无法响应 → 生成 recoverable envelope。
 *      注意：retry 使用同一超时，也会失败 → 最终 hard block。
 *      此 trace 展示 recoverable envelope 结构；"→ 成功"需瞬时故障恢复，受控环境无法构造。
 *
 * 用法：
 *   node scripts/agentic-evidence-merge-trace-construction.mjs --case=retrieval
 *   node scripts/agentic-evidence-merge-trace-construction.mjs --case=coverage
 *   node scripts/agentic-evidence-merge-trace-construction.mjs --case=recovery
 *   node scripts/agentic-evidence-merge-trace-construction.mjs --all
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, copyFileSync, readdirSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXT_ROOT = join(__dirname, "..");
const PROJECT_ROOT = join(EXT_ROOT, "..", "..", "..");

const WORKSPACE_ID = "agentic-evidence-merge-trace";
const WS_ROOT = join(EXT_ROOT, "workspaces", WORKSPACE_ID);
const REPORT_DIR = join(PROJECT_ROOT, "reports", "agentic-evidence-merge-real");
const TRACE_ARCHIVE_DIR = join(REPORT_DIR, "traces");

const caseArg = process.argv.find((a) => a.startsWith("--case="));
const TARGET_CASE = caseArg ? caseArg.split("=")[1] : null;
const RUN_ALL = process.argv.includes("--all");

// ============================================================================
// 通用脚手架
// ============================================================================

function cleanWorkspace() {
  rmSync(WS_ROOT, { recursive: true, force: true });
  mkdirSync(join(WS_ROOT, "chapters"), { recursive: true });
  mkdirSync(join(WS_ROOT, "characters"), { recursive: true });
  mkdirSync(join(WS_ROOT, "series"), { recursive: true });
  mkdirSync(join(WS_ROOT, "styles"), { recursive: true });
  mkdirSync(join(WS_ROOT, "worldbuilding"), { recursive: true });
}

function writeStyleProfile() {
  writeFileSync(
    join(WS_ROOT, "styles", "profile.json"),
    JSON.stringify({
      kind: "fingerprint",
      schemaVersion: "1.0",
      id: "agentic-evidence-merge-trace-author",
      usagePolicy: { fullChapterOptimization: "required" },
      editorialGuidance: ["人物压力通过动作、停顿和环境变化呈现。"],
      characterVoiceGuidance: { 叶尘: ["少年感保留现实处境。"] },
    }, null, 2),
    "utf-8",
  );
}

function writeWorldbuilding() {
  writeFileSync(
    join(WS_ROOT, "worldbuilding", "power-system.md"),
    [
      "# 修炼体系",
      "",
      "仙侠修炼体系：练气、筑基等境界，宗门门派林立，修士修炼功法、心法、秘法、秘术、禁术、上古功法、上古心法、神功，以法宝（神器、仙器、至宝、圣物、天器）对敌，以封印、禁制、阵法御敌。",
      "",
    ].join("\n"),
    "utf-8",
  );
}

function writeCorePrinciples(extraFacts = []) {
  writeFileSync(
    join(WS_ROOT, "CORE-WRITING-PRINCIPLES.md"),
    [
      "# 核心写作原则（最高权威）",
      "",
      "1. 作者内容契约优先：写前必须消费整体剧情方向、章节功能、前文状态、人物动机、伏笔承诺、因果与不可违背事实。",
      "2. 正文表达归模型：开头、感官、词汇、句式、修辞、对白、段落节奏由模型自由表达，系统不机械指定。",
      "3. 事实硬门、文学软诊断：身份/生死/关系/物品等硬事实不得漂移。",
      "",
      "## 不可违背事实",
      "- 这个世界是仙侠世界。",
      "- 叶尘、林婉儿、苏影是主角团成员。",
      ...extraFacts,
      "",
    ].join("\n"),
    "utf-8",
  );
}

function writeWorldbuildingCanon(focus) {
  writeFileSync(
    join(WS_ROOT, "WORLDBUILDING-CANON.md"),
    [
      "# 世界观设定（最高权威）",
      "",
      "## 世界背景",
      "这个世界是仙侠世界。",
      "",
      "## 主要人物",
      "- 叶尘：主角，废物少年，偶得传承，获得碎星剑。",
      "- 林婉儿：主角团成员，与叶尘结为道侣。",
      "- 苏影：主角团成员，来自海外修仙界。",
      "",
      focus ? `## 当前焦点\n${focus}\n` : "",
    ].join("\n"),
    "utf-8",
  );
}

function archiveTrace(caseName) {
  mkdirSync(TRACE_ARCHIVE_DIR, { recursive: true });
  let archived = 0;

  // quality traces + blocked evidence
  const traceDir = join(WS_ROOT, "traces");
  if (existsSync(traceDir)) {
    for (const file of readdirSync(traceDir)) {
      const src = join(traceDir, file);
      const dst = join(TRACE_ARCHIVE_DIR, `${caseName}-${file}`);
      copyFileSync(src, dst);
      archived++;
    }
  }

  // novelos session artifacts (lineage / evidence-plan / trajectory)
  const sessionsRoot = join(WS_ROOT, "novelos-sessions");
  if (existsSync(sessionsRoot)) {
    for (const sessionName of readdirSync(sessionsRoot)) {
      const sessionDir = join(sessionsRoot, sessionName);
      for (const file of ["lineage.json", "evidence-plan.json", "trajectory.jsonl", "verifier-report.json"]) {
        const src = join(sessionDir, file);
        if (!existsSync(src)) continue;
        const dst = join(TRACE_ARCHIVE_DIR, `${caseName}-${sessionName}-${file}`);
        copyFileSync(src, dst);
        archived++;
      }
    }
  }

  return archived;
}

function readQualityTrace(chapterId) {
  const path = join(WS_ROOT, "traces", `${chapterId}-quality-trace.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8"));
}

/**
 * 从 quality-trace 抽取 novelos 可观测字段。
 * 成功路径：gates 中 stage === "v2_novelos_agentic" 的 evidence.novelos
 * 阻断路径：failureEnvelopes[*].evidence.stageResults.novelos
 */
function extractNovelosFromTrace(trace) {
  const gates = Array.isArray(trace?.gates) ? trace.gates : [];
  const passGate = gates.find((g) => g?.stage === "v2_novelos_agentic" && g?.evidence?.novelos);
  if (passGate?.evidence?.novelos) return passGate.evidence.novelos;

  const failEnvelopes = Array.isArray(trace?.failureEnvelopes) ? trace.failureEnvelopes : [];
  for (const env of failEnvelopes) {
    const novelos = env?.evidence?.stageResults?.novelos;
    if (novelos) return novelos;
  }

  for (const gate of gates) {
    const nested = gate?.evidence?.failureEnvelope?.evidence?.stageResults?.novelos
      ?? gate?.evidence?.stageResults?.novelos
      ?? gate?.evidence?.novelos;
    if (nested) return nested;
  }
  return {};
}

function extractTraceMetrics(trace) {
  const gates = Array.isArray(trace?.gates) ? trace.gates : [];
  const novelos = extractNovelosFromTrace(trace);

  const seenCalls = new Map();
  for (const gate of gates) {
    const calls = gate?.evidence?.modelCalls;
    if (!Array.isArray(calls)) continue;
    for (const call of calls) {
      const key = `${call.ts ?? 0}|${call.route ?? ""}`;
      if (!seenCalls.has(key)) seenCalls.set(key, call);
    }
  }
  // 阻断路径 modelCalls 也可能在 stageResults 中
  for (const env of (Array.isArray(trace?.failureEnvelopes) ? trace.failureEnvelopes : [])) {
    const calls = env?.evidence?.stageResults?.modelCalls;
    if (!Array.isArray(calls)) continue;
    for (const call of calls) {
      const key = `${call.ts ?? 0}|${call.route ?? ""}`;
      if (!seenCalls.has(key)) seenCalls.set(key, call);
    }
  }
  const modelCalls = [...seenCalls.values()];

  const failEnvelopes = Array.isArray(trace?.failureEnvelopes) ? trace.failureEnvelopes : [];
  const hasRecoverableFailure = failEnvelopes.some(
    (e) => e?.recoverable === true || e?.severity === "recoverable",
  );
  const recoverableEnvelopes = failEnvelopes.filter(
    (e) => e?.recoverable === true || e?.severity === "recoverable",
  );

  return {
    decisionMode: novelos.decisionMode ?? null,
    firstAction: novelos.firstAction ?? null,
    actualRetrievalCalls: novelos.actualRetrievalCalls ?? null,
    mustVerifyCount: novelos.mustVerifyCount ?? null,
    mustVerifyCoveredCount: novelos.mustVerifyCoveredCount ?? null,
    coveragePassed: novelos.coverageResult?.passed ?? null,
    coverageResult: novelos.coverageResult ?? null,
    stopReason: novelos.stopReason ?? null,
    failureKind: novelos.failureKind ?? null,
    modelCallsByKind: novelos.modelCallsByKind ?? null,
    totalModelCalls: modelCalls.length,
    hasRecoverableFailure,
    recoverableEnvelopes,
    failureEnvelopes: failEnvelopes,
  };
}

// ============================================================================
// Case 1: 检索后生成 trace
// 用 eval-harness b2 模式：createAgenticRawCandidateSource（生产代码）+ stub 模型。
// F1-historical-fact fixture 有 retrievalQueries，
// stub 在 b2 模式必然发 search_narrative_evidence 指令 → firstAction=tool_call, retrieval>0。
// 归档 trajectory.jsonl + AgenticRawSourceResult 摘要为可审计制品。
// ============================================================================

async function constructRetrievalTrace() {
  console.log("[trace-construction] Case 1: 检索后生成 trace（eval-harness b2）");
  cleanWorkspace();

  const { setupFixtureWorkspace, runAgentLoopForEval } = await import(
    "../dist-eval/novelos/eval/eval-harness.js"
  );
  const { EVAL_FIXTURES } = await import("../dist-eval/novelos/eval/fixtures.js");

  const fixture = EVAL_FIXTURES.find((f) => f.id === "F1-historical-fact");
  if (!fixture) throw new Error("F1-historical-fact fixture 未找到");

  const { projectRoot, workspaceId, cleanup } = setupFixtureWorkspace(fixture);
  try {
    // b2 = enableRetrieval=true, enableVerification=false
    // stub 模型在 b2 模式下会发 search_narrative_evidence 工具调用
    const result = await runAgentLoopForEval(fixture, "b2", projectRoot, workspaceId);

    // 归档 trajectory.jsonl
    mkdirSync(TRACE_ARCHIVE_DIR, { recursive: true });
    let archived = 0;
    if (result.trajectoryPath && existsSync(result.trajectoryPath)) {
      copyFileSync(
        result.trajectoryPath,
        join(TRACE_ARCHIVE_DIR, "retrieval-b2-trajectory.jsonl"),
      );
      archived++;
    }

    // 归档 AgenticRawSourceResult 摘要（含 firstAction, actualRetrievalCalls 等可观测字段）
    const summary = {
      case: "retrieval",
      source: "eval-harness b2（createAgenticRawCandidateSource 生产代码 + stub 模型）",
      fixtureId: fixture.id,
      timestamp: new Date().toISOString(),
      decisionMode: result.decisionMode,
      firstAction: result.firstAction,
      actualRetrievalCalls: result.actualRetrievalCalls,
      mustVerifyCount: result.mustVerifyCount,
      mustVerifyCoveredCount: result.mustVerifyCoveredCount,
      coverageResult: result.coverageResult ?? null,
      modelCallsByKind: result.modelCallsByKind,
      candidateTextLength: result.candidate?.text?.length ?? 0,
      verifierCleared: result.verifierCleared ?? null,
      trajectoryPath: result.trajectoryPath ?? null,
      archivedFiles: archived,
    };
    writeFileSync(
      join(TRACE_ARCHIVE_DIR, "retrieval-b2-summary.json"),
      JSON.stringify(summary, null, 2),
      "utf-8",
    );
    writeFileSync(
      join(TRACE_ARCHIVE_DIR, "retrieval-b2-candidate.txt"),
      result.candidate?.text ?? "",
      "utf-8",
    );

    console.log(
      `[trace-construction] firstAction=${summary.firstAction} retrieval=${summary.actualRetrievalCalls} ` +
        `mv=${summary.mustVerifyCoveredCount}/${summary.mustVerifyCount} archived=${archived + 2}`,
    );

    return { case: "retrieval", summary, archived: archived + 2 };
  } finally {
    cleanup();
  }
}

// ============================================================================
// Case 2: coverage 不足阻断 trace
// 用 runUnifiedPipeline + V2_FORCE_STUB=1（受控）。
// ch1-outline-explicit.md 用 `## 事件 1` 格式 + `必须包含` 注入不在 immutableFacts 中的事实。
// 使 mustVerify 包含此事实但 contextCoveredFacts 不含它 → coverage 门阻断。
// ============================================================================

async function constructCoverageTrace() {
  console.log("[trace-construction] Case 2: coverage 不足阻断 trace");
  cleanWorkspace();

  writeFileSync(join(WS_ROOT, "config.json"), JSON.stringify({
    name: "coverage 阻断 trace 构造",
    genre: "仙侠",
    subGenres: ["东方玄幻"],
    totalChapters: 1,
    chapterType: "standard",
    targetWordCount: { perChapter: { min: 1500, max: 2500 } },
    characters: [
      { name: "叶尘", role: "主角" },
      { name: "林婉儿", role: "主角团成员" },
    ],
    worldKeyTerms: ["碎星剑", "尘心诀", "天机宗"],
    // immutableFacts 不包含"叶尘的真实身份是上古剑修转世"
    // 但 ch1-outline-explicit.md 的必须包含会包含它
    immutableFacts: [
      "这个世界是仙侠世界。",
      "叶尘是主角。",
      "林婉儿是主角团成员。",
      "碎星剑是叶尘的神兵。",
      "尘心诀是碎星剑附带的心法。",
    ],
  }, null, 2), "utf-8");

  writeFileSync(
    join(WS_ROOT, "series", "outline.md"),
    [
      "# 大纲",
      "",
      "## 主线",
      "叶尘从废物少年崛起，发现自身真实身份，与林婉儿对抗天机宗。",
      "",
    ].join("\n"),
    "utf-8",
  );

  // 关键：用正确的 `## 事件 1` 格式（不是 `## 章节功能`），
  // 并在 `必须包含` 中注入不在 immutableFacts 中的事实。
  // 旧语义（2026-08-25 前）：这会让 mustVerify 包含此事实（来自 authorMustInclude），
  // 但 contextCoveredFacts 不包含它（来自 immutableFacts）-> coverage 门阻断。
  // 新语义（死锁修复后）：authorMustInclude（待写内容）不再进入 mustVerify，
  // 本构造预期 coveragePassed=true（验证死锁已修复）。
  writeFileSync(
    join(WS_ROOT, "series", "ch1-outline-explicit.md"),
    [
      "# 第1章：身份之谜",
      "",
      "## 事件 1：叶尘觉醒真实身份",
      "",
      "必须包含：叶尘的真实身份是上古剑修转世、碎星剑是叶尘的前世本命法宝、天机宗追杀叶尘是因为他的前世身份",
      "参与角色：叶尘、林婉儿",
      "感知锚点：叶尘在修炼中突然看到前世画面",
      "类型：觉醒",
      "",
    ].join("\n"),
    "utf-8",
  );

  writeFileSync(join(WS_ROOT, "characters", "叶尘.md"), "# 叶尘\n主角，废物少年，偶得传承，获得碎星剑。\n", "utf-8");
  writeFileSync(join(WS_ROOT, "characters", "林婉儿.md"), "# 林婉儿\n主角团成员，天机宗弟子。\n", "utf-8");

  writeStyleProfile();
  writeWorldbuilding();
  writeCorePrinciples(["碎星剑是叶尘的神兵。", "尘心诀是碎星剑附带的心法。"]);
  writeWorldbuildingCanon("叶尘发现自身真实身份是上古剑修转世。天机宗因此追杀他。");

  // 受控模式：stub 模型（不调真实 API）
  process.env.PINOVEL_DEV_MODE = "1";
  process.env.V2_FORCE_STUB = "1";

  const { runUnifiedPipeline } = await import("../dist/v2/core/unified-entry.js");
  const result = await runUnifiedPipeline({
    workspaceId: WORKSPACE_ID,
    chapterId: "ch1",
    chapterNumber: 1,
    projectRoot: EXT_ROOT,
    candidateTimeoutMs: 600000,
  });

  const trace = readQualityTrace("ch1");
  const metrics = trace ? extractTraceMetrics(trace) : null;
  const archived = archiveTrace("coverage");

  console.log(
    `[trace-construction] status=${result.status} coveragePassed=${metrics?.coveragePassed} ` +
      `mv=${metrics?.mustVerifyCoveredCount}/${metrics?.mustVerifyCount} archived=${archived}`,
  );

  // 清理 env
  delete process.env.V2_FORCE_STUB;

  return { case: "coverage", result, metrics, archived };
}

// ============================================================================
// Case 3: envelope 级 recoverable failure trace
// 用 runUnifiedPipeline + 真实模型 + PINOVEL_MODEL_REQUEST_TIMEOUT_MS=100。
// 100ms 太短，真实模型无法响应 → 生成 severity=recoverable / gate=model_timeout envelope。
// 注意：retry 使用同一超时也会失败 → 最终 hard block。
// 此 trace 展示 recoverable envelope 结构。
// ============================================================================

async function constructRecoveryTrace() {
  console.log("[trace-construction] Case 3: recoverable failure trace（model_timeout）");
  cleanWorkspace();

  writeFileSync(join(WS_ROOT, "config.json"), JSON.stringify({
    name: "recovery trace 构造",
    genre: "仙侠",
    subGenres: ["东方玄幻"],
    totalChapters: 1,
    chapterType: "standard",
    targetWordCount: { perChapter: { min: 1500, max: 2500 } },
    characters: [
      { name: "叶尘", role: "主角" },
      { name: "林婉儿", role: "主角团成员" },
    ],
    worldKeyTerms: ["碎星剑", "尘心诀"],
    immutableFacts: [
      "这个世界是仙侠世界。",
      "叶尘是主角。",
      "林婉儿是主角团成员。",
      "宗门与门派是仙侠世界的主要势力组织。",
      "法宝（含神器、仙器、至宝、圣物、天器）是修士的重要对敌道具。",
      "心法、功法、秘法、秘术、禁术、上古功法、上古心法、神功是修士的修炼传承。",
      "封印、禁制、阵法是仙侠世界中常见的封禁与防御手段。",
      "碎星剑是叶尘的神兵。",
    ],
  }, null, 2), "utf-8");

  writeFileSync(
    join(WS_ROOT, "series", "outline.md"),
    [
      "# 大纲",
      "",
      "## 主线",
      "叶尘从废物少年崛起，获得碎星剑，与林婉儿结盟。",
      "",
    ].join("\n"),
    "utf-8",
  );

  writeFileSync(join(WS_ROOT, "characters", "叶尘.md"), "# 叶尘\n主角，废物少年，偶得传承，获得碎星剑。\n", "utf-8");
  writeFileSync(join(WS_ROOT, "characters", "林婉儿.md"), "# 林婉儿\n主角团成员。\n", "utf-8");

  writeStyleProfile();
  writeWorldbuilding();
  writeCorePrinciples(["碎星剑是叶尘的神兵。"]);
  writeWorldbuildingCanon();

  // 真实模型（不设 V2_FORCE_STUB）
  process.env.PINOVEL_DEV_MODE = "1";
  delete process.env.V2_FORCE_STUB;

  // 关键：构造 recoverable envelope 的策略
  // 1. 启动本地 HTTP 服务器，接受请求但不调用 res.end()，让 fetch 挂起等待响应
  // 2. 设置 PINOVEL_MODEL_REQUEST_TIMEOUT_MS=100（单次请求超时 100ms）
  //    → fetchWithTimeout 的 AbortController 在 100ms 后 abort fetch
  //    → 抛出 "OpenAI-compatible:gemini-3.1-pro-preview timed out after 100ms"
  // 3. 该错误消息含 "timed out" 关键词 → classifyFailureKind 识别为 model_timeout
  // 4. orchestrator 生成 gate=model_timeout / severity=recoverable envelope
  // 5. 工具层 register-tools.ts 检测 gate==="model_timeout" && severity==="recoverable"
  //    → chapter_level_retry 重试一次（使用同样 100ms 超时，也会失败）
  //    → 最终 hard block，但 trace 中保留 recoverable envelope
  //
  // 之前尝试失败的原因：
  // - 10.255.255.1:80 在 Windows 上立即返回 EHOSTUNREACH（不是挂起）
  //   → fetch 立即失败为 "fetch failed"（不含 timeout 关键词）
  // - TCP 挂起服务器（createTcpServer）也失败为 "fetch failed"：
  //   Node.js fetch 检测到 TCP 连接已建立，但服务器没有发送 HTTP 响应行，
  //   内部 HTTP 解析器立即报错 "fetch failed"（不是挂起等待）
  // - HTTP 服务器（createHttpServer）接受 HTTP 请求但不调用 res.end()：
  //   fetch 成功发送 HTTP 请求，等待响应；AbortController 在 100ms 后触发，
  //   抛出 "timed out after 100ms"（含超时关键词）
  const hangingServer = createHttpServer((req, res) => {
    // 接受 HTTP 请求但不调用 res.end()，让 fetch 挂起等待响应
    // 不设置任何超时，让请求一直挂起，直到 AbortController 触发
    req.on("error", () => {}); // 忽略请求错误
    res.on("error", () => {}); // 忽略响应错误
  });
  // 设置 keepAlive 超时为长值，避免服务器主动关闭连接
  hangingServer.keepAliveTimeout = 60000;
  hangingServer.requestTimeout = 60000;
  await new Promise((resolve) => hangingServer.listen(0, "127.0.0.1", resolve));
  const hangingPort = hangingServer.address().port;

  const savedBaseUrl = process.env.GOOGLE_GEMINI_BASE_URL;
  process.env.GOOGLE_GEMINI_BASE_URL = `http://127.0.0.1:${hangingPort}`;

  // 关键：设置单次请求超时为 100ms，让 fetchWithTimeout 的 AbortController 生效
  const savedRequestTimeout = process.env.PINOVEL_MODEL_REQUEST_TIMEOUT_MS;
  process.env.PINOVEL_MODEL_REQUEST_TIMEOUT_MS = "100";

  let result;
  try {
    const { runUnifiedPipeline } = await import("../dist/v2/core/unified-entry.js");
    result = await runUnifiedPipeline({
      workspaceId: WORKSPACE_ID,
      chapterId: "ch1",
      chapterNumber: 1,
      projectRoot: EXT_ROOT,
      // 关键：candidateTimeoutMs 会被传入 orchestrator.timeoutMs，
      // 再传入 fetchWithTimeout 的 options.timeoutMs，覆盖 PINOVEL_MODEL_REQUEST_TIMEOUT_MS。
      // 设为 100 让单次 fetch 在 100ms 后被 AbortController 终止，
      // 抛出 "OpenAI-compatible:gemini-3.1-pro-preview timed out after 100ms"。
      candidateTimeoutMs: 100,
    });
  } finally {
    // 清理：关闭挂起服务器 + 恢复 env
    hangingServer.close();
    if (savedBaseUrl !== undefined) {
      process.env.GOOGLE_GEMINI_BASE_URL = savedBaseUrl;
    } else {
      delete process.env.GOOGLE_GEMINI_BASE_URL;
    }
    if (savedRequestTimeout !== undefined) {
      process.env.PINOVEL_MODEL_REQUEST_TIMEOUT_MS = savedRequestTimeout;
    } else {
      delete process.env.PINOVEL_MODEL_REQUEST_TIMEOUT_MS;
    }
  }

  const trace = readQualityTrace("ch1");
  const metrics = trace ? extractTraceMetrics(trace) : null;
  const archived = archiveTrace("recovery-timeout");

  // 查找 recoverable envelope
  const recoverableEnvelopes = (metrics?.failureEnvelopes ?? []).filter(
    (e) => e?.severity === "recoverable" || e?.recoverable === true,
  );

  console.log(
    `[trace-construction] status=${result.status} hasRecoverable=${metrics?.hasRecoverableFailure} ` +
      `envelopes=${metrics?.failureEnvelopes?.length ?? 0} recoverable=${recoverableEnvelopes.length} archived=${archived}`,
  );

  return { case: "recovery", result, metrics, recoverableEnvelopes, archived };
}

// ============================================================================
// 主流程
// ============================================================================

async function main() {
  const cases = RUN_ALL
    ? ["retrieval", "coverage", "recovery"]
    : TARGET_CASE
      ? [TARGET_CASE]
      : ["retrieval", "coverage", "recovery"];

  const results = {};

  for (const c of cases) {
    console.log(`\n[trace-construction] ===== ${c} =====\n`);
    try {
      if (c === "retrieval") results.retrieval = await constructRetrievalTrace();
      else if (c === "coverage") results.coverage = await constructCoverageTrace();
      else if (c === "recovery") results.recovery = await constructRecoveryTrace();
    } catch (err) {
      console.error(`[trace-construction] ${c} 异常:`, err);
      results[c] = { error: err instanceof Error ? err.message : String(err) };
    }
  }

  // 写汇总
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(
    join(REPORT_DIR, "trace-construction-report.json"),
    JSON.stringify(results, null, 2),
    "utf-8",
  );

  console.log(`\n[trace-construction] 汇总报告写到 ${join(REPORT_DIR, "trace-construction-report.json")}`);
  console.log(`[trace-construction] trace 归档目录: ${TRACE_ARCHIVE_DIR}`);
}

main().catch((err) => {
  console.error("[trace-construction] 主流程异常:", err);
  process.exit(1);
});
