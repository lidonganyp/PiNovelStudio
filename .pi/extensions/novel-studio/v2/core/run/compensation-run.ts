/**
 * COMPENSATION-RUN — 回滚通过新补偿运行完成（P6）
 *
 * 硬规则：
 * - 不得把旧 run 从 committed 倒退
 * - 启动新 runId，parentRunId 指向被补偿 run
 * - 成本/trace 事实保留
 */

import { createRunId, createTraceId } from "../audit/audit-event-ids.js";
import { AuditEventStore } from "../audit/audit-event-store.js";
import {
  createRunAggregateRepository,
  type RunAggregateRepository,
} from "./run-aggregate-repository.js";
import type { RunAggregate } from "./run-aggregate-types.js";

export interface StartCompensationRunInput {
  projectRoot: string;
  workspaceId: string;
  chapterId: string;
  /** 被补偿的已提交 run */
  parentRunId: string;
  /** 复用 trace 以便审计串联；默认新建 */
  traceId?: string;
  reason: string;
  commandId?: string;
  persist?: boolean;
}

export interface CompensationRunSession {
  store: AuditEventStore;
  repository: RunAggregateRepository;
  parentRunId: string;
  runId: string;
  traceId: string;
}

/**
 * 启动补偿运行：新 runId + compensation_started 事件。
 * 不修改父 run 的 workflowState。
 */
export function startCompensationRun(
  input: StartCompensationRunInput,
): CompensationRunSession {
  const runId = createRunId();
  const traceId = input.traceId ?? createTraceId();
  const persist = input.persist ?? true;

  const store = new AuditEventStore({
    projectRoot: input.projectRoot,
    workspaceId: input.workspaceId,
    runId,
    traceId,
    persist,
  });
  const repository = createRunAggregateRepository({
    projectRoot: input.projectRoot,
    workspaceId: input.workspaceId,
    chapterId: input.chapterId,
    runId,
    traceId,
    persist,
  });

  const { append: start } = repository.appendEvent(store, {
    actor: "orchestrator",
    stage: "run",
    eventType: "run_started",
    status: "started",
    evidenceLevel: "observed",
    parentEventId: null,
    payload: {
      compensation: true,
      parentRunId: input.parentRunId,
      reason: input.reason,
    },
  });
  void start;

  repository.appendEvent(store, {
    actor: "recovery",
    stage: "recovery",
    eventType: "compensation_started",
    status: "started",
    evidenceLevel: "observed",
    decisionReason: input.reason,
    payload: {
      parentRunId: input.parentRunId,
      commandId: input.commandId,
    },
  });

  return {
    store,
    repository,
    parentRunId: input.parentRunId,
    runId,
    traceId,
  };
}

/**
 * 父 run 保持 committed；仅检查不得就地倒退。
 */
export function assertParentRunNotRetreated(
  parent: RunAggregate,
): { ok: true } | { ok: false; reason: string } {
  if (parent.workflowState !== "committed" && parent.terminalStatus !== "committed") {
    return {
      ok: false,
      reason: `compensation 目标父 run 非 committed：workflow=${parent.workflowState}`,
    };
  }
  return { ok: true };
}
