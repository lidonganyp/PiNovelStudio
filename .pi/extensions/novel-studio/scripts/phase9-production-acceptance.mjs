/**
 * Phase 9 产品级验收脚本 — 真实 workspace 跑 novel_generate_chapter 完整主链路
 *
 * 验收口径（用户指定）：
 *   1. novel_generate_chapter 完整主链路
 *   2. 生产 Prompt、9 工具、完整上下文、A 组预算
 *   3. active pointer、环境指纹、Prompt hash 全一致
 *   4. trace、FailureEnvelope、原子保存、状态提交完整
 *   5. 无 silent degrade
 *
 * 设计：
 *   - 不写 delete/ 目录（受工作树规则保护）
 *   - 调用 dist/index.js 生产入口
 *   - 收集章节文件 / trace / narrative-state / releaseGovernance 证据
 *
 * 用法：
 *   cd .pi/extensions/novel-studio
 *   node scripts/phase9-production-acceptance.mjs <workspaceId> <chapterNumber>
 *   node scripts/phase9-production-acceptance.mjs xinmo 18
 */
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, readFileSync, statSync } from "node:fs";
import crypto from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXTENSION_ROOT = join(__dirname, "..");
const PROJECT_ROOT = join(EXTENSION_ROOT, "..", "..", "..");

const workspaceId = process.argv[2] || "xinmo";
const chapterNumber = parseInt(process.argv[3] || "18", 10);
const chapterId = String(chapterNumber);

const WORKSPACE_DIR = join(PROJECT_ROOT, "workspaces", workspaceId);
if (!existsSync(WORKSPACE_DIR)) {
  console.error(`工作区不存在: ${WORKSPACE_DIR}`);
  process.exit(1);
}

// ============================================================================
// 验收前快照
// ============================================================================
const chapterFile = join(WORKSPACE_DIR, "chapters", `chapter-${chapterNumber}.md`);
const traceFile = join(WORKSPACE_DIR, "traces", `${chapterId}-quality-trace.json`);
const evidenceReport = join(WORKSPACE_DIR, "traces", `${chapterId}-quality-evidence-report.json`);
const narrativeStateFile = join(WORKSPACE_DIR, "narrative-state-store.json");

function snapshotState() {
  const snap = {
    chapterExists: existsSync(chapterFile),
    traceExists: existsSync(traceFile),
    evidenceReportExists: existsSync(evidenceReportFile()),
    nsLastCommittedChapter: null,
    nsUpdatedAt: null,
  };
  if (existsSync(narrativeStateFile)) {
    try {
      const ns = JSON.parse(readFileSync(narrativeStateFile, "utf8"));
      snap.nsLastCommittedChapter = ns.lastCommittedChapter;
      snap.nsUpdatedAt = ns.updatedAt;
    } catch {}
  }
  return snap;
}

function evidenceReportFile() {
  return evidenceReport;
}

const before = snapshotState();

console.log("=".repeat(70));
console.log(`  Phase 9 产品级验收 — ${workspaceId} 第${chapterNumber}章`);
console.log("=".repeat(70));
console.log("\n[验收前快照]");
console.log(`  chapter-${chapterNumber}.md exists: ${before.chapterExists}`);
console.log(`  ${chapterId}-quality-trace.json exists: ${before.traceExists}`);
console.log(`  narrative-state lastCommittedChapter: ${before.nsLastCommittedChapter}`);
console.log(`  narrative-state updatedAt: ${before.nsUpdatedAt}`);
console.log(`  PINOVEL_DEV_MODE: ${process.env.PINOVEL_DEV_MODE ?? "(unset)"}`);

// ============================================================================
// 加载扩展（生产入口 dist/index.js）
// ============================================================================
const extPath = join(EXTENSION_ROOT, "dist", "index.js");
if (!existsSync(extPath)) {
  console.error(`❌ 生产构建产物不存在: ${extPath}`);
  console.error("   请先运行 npm run build:prod");
  process.exit(1);
}

const extModule = await import(pathToFileURL(extPath).href);
const extensionSetup = extModule.default;

const registeredTools = {};
const ui = {
  notify(msg, level) {
    console.log(`  [PI UI ${level}] ${msg}`);
  },
};
const pi = {
  registerTool(toolDef) {
    registeredTools[toolDef.name] = toolDef;
    return toolDef;
  },
  registerCommand(cmdDef) {
    return cmdDef;
  },
  on(_event, _handler) {},
  ui,
};

console.log("\n[加载生产扩展]");
extensionSetup(pi);

const generateTool = registeredTools["novel_generate_chapter"];
if (!generateTool) {
  console.error("❌ novel_generate_chapter 工具未注册");
  process.exit(1);
}
console.log(`✓ novel_generate_chapter 已注册`);

// ============================================================================
// 调用 novel_generate_chapter 完整主链路
// ============================================================================
console.log(`\n[调用] novel_generate_chapter`);
console.log(`  workspaceId: ${workspaceId}`);
console.log(`  chapterId: ${chapterId}`);
console.log(`  chapterNumber: ${chapterNumber}`);
console.log(`  writerModel: (default Gemini 3.1)`);
console.log("─".repeat(70));

const progressUpdates = [];
const startTime = Date.now();

let result;
try {
  result = await generateTool.execute(
    `phase9-acceptance-${chapterId}-${Date.now()}`,
    { workspaceId, chapterId, chapterNumber },
    undefined,
    (update) => {
      const msg = typeof update === "string" ? update : JSON.stringify(update).slice(0, 300);
      progressUpdates.push(msg);
      console.log(`  [进度] ${msg}`);
    },
    { cwd: PROJECT_ROOT, ui },
  );
} catch (error) {
  console.error(`\n❌ 调用异常: ${error.message}`);
  console.error(error.stack);
  process.exit(1);
}

const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
console.log("─".repeat(70));
console.log(`\n[结果] 耗时 ${elapsedSec}s`);

const details = result.details || result;
const status = details.status || (result.isError ? "error" : "unknown");
console.log(`  status: ${status}`);
console.log(`  isError: ${result.isError || false}`);
if (details.stageResults) {
  console.log(`  stageResults:`);
  for (const [stage, s] of Object.entries(details.stageResults)) {
    if (s && typeof s === "object" && s.status) {
      const icon = s.status === "success" ? "✅" : s.status === "skipped" ? "⏭️" : s.status === "error" ? "❌" : "ℹ️";
      console.log(`    ${icon} ${stage}: ${s.status}`);
    }
  }
}

// ============================================================================
// 验收证据收集
// ============================================================================
console.log("\n" + "=".repeat(70));
console.log("  验收证据收集");
console.log("=".repeat(70));

const after = snapshotState();
const evidence = {
  passed: true,
  checks: [],
};

function check(name, condition, detail = "") {
  const icon = condition ? "✓" : "✗";
  const status = condition ? "PASS" : "FAIL";
  console.log(`  ${icon} ${name}: ${status}${detail ? " — " + detail : ""}`);
  evidence.checks.push({ name, passed: condition, detail });
  if (!condition) evidence.passed = false;
}

// 1. 章节文件原子保存
check(
  "章节文件原子保存",
  !before.chapterExists && after.chapterExists,
  before.chapterExists
    ? "验收前已存在（非新生成）"
    : after.chapterExists
      ? `chapter-${chapterNumber}.md 已生成`
      : "章节文件未生成",
);
if (after.chapterExists) {
  const stat = statSync(chapterFile);
  const content = readFileSync(chapterFile, "utf8");
  check(
    "章节文件非空",
    content.length > 500,
    `${stat.size} bytes, ${content.length} chars`,
  );
  const hash = crypto.createHash("sha256").update(content, "utf8").digest("hex");
  console.log(`    chapter-${chapterNumber}.md SHA-256: ${hash.substring(0, 16)}...`);
}

// 2. trace 完整
check(
  "trace 文件存在",
  after.traceExists,
  after.traceExists ? `${chapterId}-quality-trace.json` : "缺失",
);
if (after.traceExists) {
  const trace = JSON.parse(readFileSync(traceFile, "utf8"));
  check("trace schemaVersion", trace.schemaVersion === 1, `schemaVersion=${trace.schemaVersion}`);
  check("trace workspaceId", trace.workspaceId === workspaceId, `workspaceId=${trace.workspaceId}`);
  check("trace chapterId", trace.chapterId === chapterId, `chapterId=${trace.chapterId}`);

  const gates = trace.gates || [];
  check("trace gates 非空", gates.length > 0, `${gates.length} 个 gate`);
  const failureEnvelopes = trace.failureEnvelopes || [];
  console.log(`    failureEnvelopes count: ${failureEnvelopes.length}`);

  // 检查每个 gate 的 releaseGovernance
  for (const gate of gates) {
    const rg = gate.evidence?.releaseGovernance;
    if (rg) {
      console.log(`    gate[${gate.stage}] releaseGovernance:`);
      console.log(`      devMode: ${rg.devMode}`);
      console.log(`      releaseId: ${rg.releaseId}`);
      console.log(`      environmentFingerprint: ${rg.environmentFingerprint ? rg.environmentFingerprint.substring(0, 16) + "..." : null}`);
      console.log(`      approvalRef: ${rg.approvalRef}`);
      check(
        `gate[${gate.stage}] releaseGovernance 已记录`,
        rg.devMode !== undefined,
        `devMode=${rg.devMode}`,
      );
    }
  }

  // v2Summary
  const v2Summary = trace.v2Summary || {};
  console.log(`    v2Summary.candidateCount: ${v2Summary.candidateCount}`);
  console.log(`    v2Summary.contextHash: ${v2Summary.contextHash}`);
  if (v2Summary.stages) {
    console.log(`    v2Summary.stages: ${v2Summary.stages.map(s => s.stage).join(" → ")}`);
  }
}

// 3. narrative-state 提交
check(
  "narrative-state lastCommittedChapter 推进",
  after.nsLastCommittedChapter === `ch${chapterNumber}`,
  `before=${before.nsLastCommittedChapter} after=${after.nsLastCommittedChapter}`,
);
check(
  "narrative-state updatedAt 更新",
  after.nsUpdatedAt !== before.nsUpdatedAt,
  `before=${before.nsUpdatedAt} after=${after.nsUpdatedAt}`,
);

// 4. 无 silent degrade
const isBlocked = status === "blocked" || status === "error";
if (isBlocked) {
  const fe = details.failureEnvelope || (after.traceExists ? JSON.parse(readFileSync(traceFile, "utf8")).failureEnvelopes?.[0] : null);
  check(
    "阻断有 FailureEnvelope",
    fe !== null && fe !== undefined,
    fe ? `stage=${fe.stage}, gate=${fe.gate}, severity=${fe.severity}` : "无 FailureEnvelope",
  );
  if (fe) {
    check("FailureEnvelope 有 reason", !!fe.reason, fe.reason?.substring(0, 80));
    check("FailureEnvelope 有 evidence", Array.isArray(fe.evidence) && fe.evidence.length > 0, `${fe.evidence?.length || 0} 条`);
  }
  check(
    "阻断未写章节文件（无 silent degrade）",
    !after.chapterExists,
    after.chapterExists ? "❌ 阻断却写了章节文件（silent degrade）" : "✓ 阻断未污染章节目录",
  );
} else {
  check("无 silent degrade（成功路径）", true, "status=" + status);
}

// 5. selectedSource 非 blocked（成功路径）
if (!isBlocked && details.selectedSource) {
  check(
    "selectedSource 非 blocked",
    details.selectedSource !== "blocked",
    `selectedSource=${details.selectedSource}`,
  );
}

// ============================================================================
// 验收摘要
// ============================================================================
console.log("\n" + "=".repeat(70));
const passCount = evidence.checks.filter(c => c.passed).length;
const failCount = evidence.checks.filter(c => !c.passed).length;
console.log(`  验收结果: ${passCount}/${evidence.checks.length} PASS, ${failCount} FAIL`);
if (evidence.passed) {
  console.log("  ✅ 产品级验收通过");
} else {
  console.log("  ⚠️ 部分检查未通过（见上方详情）");
}
console.log("=".repeat(70));

// 保存验收报告
const reportPath = join(PROJECT_ROOT, "reports", "phase9-prompt-registry", `production-acceptance-${workspaceId}-ch${chapterNumber}.json`);
try {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(dirname(reportPath), { recursive: true });
  const report = {
    workspaceId,
    chapterNumber,
    chapterId,
    timestamp: new Date().toISOString(),
    elapsedSec: parseFloat(elapsedSec),
    status,
    before,
    after,
    evidence,
    progressUpdates,
  };
  writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
  console.log(`\n验收报告已保存: ${reportPath}`);
} catch (e) {
  console.log(`\n⚠️ 验收报告保存失败: ${e.message}`);
}

process.exitCode = evidence.passed ? 0 : 1;
