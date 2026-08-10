/**
 * Phase 9 验收证据复检脚本 — 基于已生成产物重新验证，不重跑 pipeline
 *
 * 用途：当 pipeline 已成功运行但验收脚本因 bug 误报时，
 *       读取现有章节/trace/narrative-state 产物重新执行检查并生成修正报告。
 *
 * 用法：
 *   cd .pi/extensions/novel-studio
 *   node scripts/phase9-acceptance-reverify.mjs <workspaceId> <chapterNumber>
 *   node scripts/phase9-acceptance-reverify.mjs xinmo 18
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import crypto from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXTENSION_ROOT = join(__dirname, "..");
const PROJECT_ROOT = join(EXTENSION_ROOT, "..", "..", "..");

const workspaceId = process.argv[2] || "xinmo";
const chapterNumber = parseInt(process.argv[3] || "18", 10);
const chapterId = String(chapterNumber);

const WORKSPACE_DIR = join(PROJECT_ROOT, "workspaces", workspaceId);

// 章节文件命名兼容两种格式
const chapterFileCandidates = [
  join(WORKSPACE_DIR, "chapters", `${chapterNumber}.md`),
  join(WORKSPACE_DIR, "chapters", `chapter-${chapterNumber}.md`),
];
const chapterFile = chapterFileCandidates.find((p) => existsSync(p)) ?? null;

const traceFile = join(WORKSPACE_DIR, "traces", `${chapterId}-quality-trace.json`);
const narrativeStateFile = join(WORKSPACE_DIR, "narrative-state-store.json");

console.log("=".repeat(70));
console.log(`  Phase 9 验收证据复检 — ${workspaceId} 第${chapterNumber}章`);
console.log("=".repeat(70));

const evidence = { passed: true, checks: [] };

function check(name, condition, detail = "") {
  const icon = condition ? "✓" : "✗";
  const status = condition ? "PASS" : "FAIL";
  console.log(`  ${icon} ${name}: ${status}${detail ? " — " + detail : ""}`);
  evidence.checks.push({ name, passed: condition, detail });
  if (!condition) evidence.passed = false;
}

// ============================================================================
// 1. 章节文件原子保存
// ============================================================================
console.log("\n[1. 章节文件]");
check("章节文件存在", chapterFile !== null, chapterFile ? chapterFile.split(/[\\/]/).pop() : "未找到");

if (chapterFile) {
  const stat = statSync(chapterFile);
  const content = readFileSync(chapterFile, "utf8");
  const hash = crypto.createHash("sha256").update(content, "utf8").digest("hex");
  check("章节文件非空", content.length > 500, `${stat.size} bytes, ${content.length} chars`);
  console.log(`    SHA-256: ${hash.substring(0, 16)}...`);
  // 统计中文字符总数（标点不计入 CJK 范围，用计数而非连续匹配）
  const cjkChars = (content.match(/[\u4e00-\u9fff]/g) || []).length;
  check("章节内容含中文正文", cjkChars > 200, `${cjkChars} 个中文字符`);

  // 记录 hash 供后续交叉验证
  evidence.chapterHash = hash.substring(0, 12);
  evidence.chapterFile = chapterFile.split(/[\\/]/).pop();
}

// ============================================================================
// 2. trace 完整性
// ============================================================================
console.log("\n[2. trace 文件]");
check("trace 文件存在", existsSync(traceFile), existsSync(traceFile) ? `${chapterId}-quality-trace.json` : "缺失");

let traceData = null;
let failureEnvelopes = [];
if (existsSync(traceFile)) {
  traceData = JSON.parse(readFileSync(traceFile, "utf8"));
  check("trace schemaVersion", traceData.schemaVersion === 1, `schemaVersion=${traceData.schemaVersion}`);
  check("trace workspaceId", traceData.workspaceId === workspaceId, `workspaceId=${traceData.workspaceId}`);
  check("trace chapterId", traceData.chapterId === chapterId, `chapterId=${traceData.chapterId}`);

  const gates = traceData.gates || [];
  check("trace gates 非空", gates.length > 0, `${gates.length} 个 gate`);

  failureEnvelopes = traceData.failureEnvelopes || [];
  console.log(`    failureEnvelopes count: ${failureEnvelopes.length}`);

  // P0 硬门：releaseGovernance 必须 devMode=false 才算生产验收。
  // 防止 dev-mode 验收（devMode=true）再次被误报为生产验收。
  // 生产验收要求 devMode=false 且 release 身份/指纹/审批引用齐全
  // （releaseId / environmentFingerprint / approvalRef 均由已通过门禁的
  //  releaseGovernance 携带；任一缺失即视为非生产验收）。
  let releaseGovernanceGateCount = 0;
  let nonProdGates = 0;
  for (const gate of gates) {
    const rg = gate.evidence?.releaseGovernance;
    if (!rg) continue;
    releaseGovernanceGateCount += 1;
    const isProd =
      rg.devMode === false &&
      rg.releaseId != null &&
      rg.approvalRef != null &&
      rg.environmentFingerprint != null;
    check(
      `gate[${gate.stage}] 生产 releaseGovernance（devMode=false）`,
      isProd,
      `devMode=${rg.devMode}, releaseId=${rg.releaseId}, ` +
        `approvalRef=${rg.approvalRef}, ` +
        `fingerprint=${rg.environmentFingerprint ? rg.environmentFingerprint.slice(0, 16) + "…" : null}`,
    );
    if (!isProd) nonProdGates += 1;
  }
  if (releaseGovernanceGateCount > 0) {
    check(
      "全部 releaseGovernance gate 均为生产（无 dev-mode 误报）",
      nonProdGates === 0,
      `${releaseGovernanceGateCount} 个 gate`,
    );
  }

  // v2Summary
  const v2Summary = traceData.v2Summary || {};
  console.log(`    v2Summary.candidateCount: ${v2Summary.candidateCount}`);
  console.log(`    v2Summary.contextHash: ${v2Summary.contextHash}`);

  // finalSelection
  const finalSel = gates.find(g => g.stage === "v2_final_selected")?.evidence?.finalSelection;
  if (finalSel) {
    check("finalSelection 存在", true, `selectedSource=${finalSel.selectedSource}, gain=${finalSel.projectGain}`);
    check("selectedSource 非 blocked", finalSel.selectedSource !== "blocked", `selectedSource=${finalSel.selectedSource}`);
  }

  // modelCalls
  const modelCalls = finalSel?.modelCalls || gates.find(g => g.evidence?.modelCalls)?.evidence?.modelCalls || [];
  if (modelCalls.length > 0) {
    console.log(`    modelCalls (${modelCalls.length}):`);
    for (const mc of modelCalls) {
      console.log(`      ${mc.kind}: ${mc.model} (${mc.durationMs}ms, in=${mc.tokenUsage?.in}, out=${mc.tokenUsage?.out})`);
    }
    check("modelCalls 非空", modelCalls.length > 0, `${modelCalls.length} 次模型调用`);

    // 验证使用的是 Gemini 3.1 Pro Preview
    const allGemini31 = modelCalls.every(mc => mc.model === "gemini-3.1-pro-preview");
    check("模型路由一致（Gemini 3.1 Pro Preview）", allGemini31, allGemini31 ? "全部使用 gemini-3.1-pro-preview" : "存在非 Gemini 3.1 调用");

    // 验证 A 组预算（soft=6, hard=10）
    const totalModelCalls = modelCalls.length;
    check("A 组预算未超限", totalModelCalls <= 10, `实际调用 ${totalModelCalls} 次 (soft=6, hard=10)`);
  }
}

// ============================================================================
// 3. narrative-state 提交
// ============================================================================
console.log("\n[3. narrative-state]");
check("narrative-state 文件存在", existsSync(narrativeStateFile), existsSync(narrativeStateFile) ? "narrative-state-store.json" : "缺失");

let nsData = null;
if (existsSync(narrativeStateFile)) {
  nsData = JSON.parse(readFileSync(narrativeStateFile, "utf8"));
  check(
    "lastCommittedChapter 推进到当前章",
    nsData.lastCommittedChapter === `ch${chapterNumber}`,
    `lastCommittedChapter=${nsData.lastCommittedChapter}`,
  );
  check("updatedAt 存在", !!nsData.updatedAt, `updatedAt=${nsData.updatedAt}`);

  // 交叉验证：narrative-state 中是否引用了章节文件的 hash
  if (evidence.chapterHash) {
    const nsContent = readFileSync(narrativeStateFile, "utf8");
    const hashRefs = (nsContent.match(new RegExp(evidence.chapterHash, "g")) || []).length;
    check(
      "narrative-state 引用章节 hash",
      hashRefs > 0,
      `hash=${evidence.chapterHash} 出现 ${hashRefs} 次`,
    );
  }
}

// ============================================================================
// 4. 无 silent degrade
// ============================================================================
console.log("\n[4. silent degrade 检查]");
if (traceData) {
  const finalGate = traceData.gates?.find(g => g.stage === "v2_final_selected");
  const finalSel = finalGate?.evidence?.finalSelection;

  if (finalSel && finalSel.selectedSource !== "blocked") {
    // 成功路径：有 final_selected gate 且非 blocked
    check("无 silent degrade（成功路径）", true, `selectedSource=${finalSel.selectedSource}, pipeline 成功完成`);
    check("章节文件已保存", chapterFile !== null, chapterFile ? chapterFile.split(/[\\/]/).pop() : "未保存");
    check("narrative-state 已提交", nsData?.lastCommittedChapter === `ch${chapterNumber}`, `lastCommittedChapter=${nsData?.lastCommittedChapter}`);
  } else {
    // 阻断路径：无 final_selected 或 selectedSource=blocked
    check("阻断有 FailureEnvelope", failureEnvelopes.length > 0, `${failureEnvelopes.length} 个 envelope`);
    check("阻断未写章节文件", chapterFile === null, chapterFile ? "❌ 阻断却写了章节文件（silent degrade）" : "✓ 阻断未污染章节目录");
  }
}

// ============================================================================
// 验收摘要
// ============================================================================
console.log("\n" + "=".repeat(70));
const passCount = evidence.checks.filter(c => c.passed).length;
const failCount = evidence.checks.filter(c => !c.passed).length;
console.log(`  复检结果: ${passCount}/${evidence.checks.length} PASS, ${failCount} FAIL`);
if (evidence.passed) {
  console.log("  ✅ 产品级验收复检通过 — 所有证据一致");
} else {
  console.log("  ⚠️ 部分检查未通过（见上方详情）");
}
console.log("=".repeat(70));

// 保存复检报告
const reportPath = join(PROJECT_ROOT, "reports", "phase9-prompt-registry", `production-acceptance-reverify-${workspaceId}-ch${chapterNumber}.json`);
try {
  mkdirSync(dirname(reportPath), { recursive: true });
  const report = {
    workspaceId,
    chapterNumber,
    chapterId,
    timestamp: new Date().toISOString(),
    type: "reverify",
    evidence,
  };
  writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
  console.log(`\n复检报告已保存: ${reportPath}`);
} catch (e) {
  console.log(`\n⚠️ 复检报告保存失败: ${e.message}`);
}

process.exitCode = evidence.passed ? 0 : 1;
