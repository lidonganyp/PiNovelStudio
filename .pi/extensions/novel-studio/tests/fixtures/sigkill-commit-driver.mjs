/**
 * SIGKILL 注入子进程驱动 — commitAndSave 事务边界
 *
 * 由 tests/run-lifecycle-sigkill-injection.test.mjs 派生，在独立子进程中真实执行
 * commitAndSave。测试框架通过 PINOVEL_SIGKILL_FAULT_POINT + PINOVEL_SIGKILL_MARKER_DIR
 * 控制注入点；注入点命中时进程同步阻塞等待 SIGKILL。
 *
 * 本脚本是「commit」与「recover」两用的同一入口：
 *   - commit 模式：env 设置故障点 → 进程在故障点被 SIGKILL（无 stdout 输出）
 *   - recover 模式：env 无故障点 → 正常完成，向 stdout 打印恢复后状态 JSON
 *
 * 输出 JSON（recover 模式）字段：
 *   result      { ok, error, idempotent, commitIntentId, committed, rejected }
 *   chapterContent  恢复后正文文件内容（null = 不存在）
 *   chapterExists   恢复后正文文件是否存在
 *   stateCanonCount 恢复后 narrative-state-store.json 的 canon 条目数
 *   stateCanonIds   canon 条目 id 列表（验证无重复累积）
 *   ledgerExists    恢复后 commit-intents.json 账本是否存在
 *   gate         { approvalState, workflowState, commitIntent, foldError }
 *   events       [] 审计事件类型列表
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createAuditRunSession } from "../../dist/v2/core/audit/audit-run-session.js";
import { commitAndSave } from "../../dist/v2/core/orchestrator-commit-save.js";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const projectRoot = arg("root");
const workspaceId = arg("ws");
const chapterId = arg("chapter");
const chapterNumber = Number(arg("chapterNumber", "1"));
const runId = arg("runId");
const traceId = arg("traceId");
const commitIntentId = arg("commitIntentId");
const artifactRevision = arg("artifactRevision");
const withState = arg("withState") === "1";

if (!projectRoot || !workspaceId || !chapterId || !runId || !traceId || !commitIntentId || !artifactRevision) {
  process.stderr.write("missing required args\n");
  process.exit(2);
}

// 固定正文（含 canon 关键词，供状态重锚定命中 span）
const finalText = "暗流在水面之下悄然涌动，叶尘握紧了手中的剑。";

const stagedStateUpdate = withState
  ? {
      additions: [
        {
          kind: "canon",
          id: "canon:fact:0:ch1",
          sourceChapter: "ch1",
          sourceRef: "seed:canon:0",
          confidence: 0.6,
          lastUpdated: "2026-08-14T00:00:00.000Z",
          fact: "暗流",
          category: "entity",
        },
      ],
      invalidations: [],
      sourceChapter: "ch1",
    }
  : undefined;

// 与事务边界一致：restart 用相同 runId/traceId 复用同一事件文件，构造器 bootstrap 历史事件。
const session = createAuditRunSession({
  projectRoot,
  workspaceId,
  chapterId,
  chapterNumber,
  persist: true,
  runId,
  traceId,
});
session.start({});

const input = {
  workspaceId,
  projectRoot,
  chapterId,
  chapterNumber,
  characterNames: [],
  stagedStateUpdate,
  auditSink: session,
};

const stageResults = { commitIntentId, artifactRevision };

let result;
try {
  result = commitAndSave(input, "candidate-sigkill", finalText, stageResults);
} catch (e) {
  result = { ok: false, error: e instanceof Error ? e.message : String(e) };
}

const wsPath = join(projectRoot, "workspaces", workspaceId);
const chapterPath = join(wsPath, "chapters", `${chapterId}.md`);
const statePath = join(wsPath, "narrative-state-store.json");
const ledgerPath = join(wsPath, "chapter-approvals", `${chapterId}.commit-intents.json`);

let stateCanonCount = 0;
let stateCanonIds = [];
if (existsSync(statePath)) {
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf-8"));
    stateCanonCount = Array.isArray(raw?.canon) ? raw.canon.length : 0;
    stateCanonIds = Array.isArray(raw?.canon) ? raw.canon.map((c) => c.id) : [];
  } catch {
    stateCanonCount = -1;
  }
}

const gate = session.getLifecycleGate();

process.stdout.write(
  JSON.stringify({
    mode: "done",
    result: {
      ok: result.ok,
      error: result.error ?? null,
      idempotent: result.idempotent ?? false,
      commitIntentId: result.commitIntentId ?? null,
      committed: result.stateCommit?.committed ?? null,
      rejected: result.stateCommit?.rejected ?? null,
    },
    chapterExists: existsSync(chapterPath),
    chapterContent: existsSync(chapterPath) ? readFileSync(chapterPath, "utf-8") : null,
    stateCanonCount,
    stateCanonIds,
    ledgerExists: existsSync(ledgerPath),
    gate: {
      approvalState: gate.approvalState,
      workflowState: gate.workflowState,
      commitIntent: gate.commitIntent,
      foldError: gate.foldError,
    },
    events: session.getEntries().map((e) => e.eventType),
  }) + "\n",
);
process.exit(0);
