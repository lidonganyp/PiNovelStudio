/**
 * AGENT-LINEAGE-INDEX — 统一 run/candidate 血缘查询（MA-5.2）
 *
 * 把 stageResults / agentCollaboration / trajectory 元数据 / FailureEnvelope
 * 关联到同一 orchestratorRunId + candidateId 索引，供审计与回放查询。
 *
 * 不读思维链；不替代 AuditEventStore 持久化。
 */

export interface LineageIndexEntry {
  orchestratorRunId: string;
  workspaceId?: string;
  chapterId?: string;
  candidateId?: string | null;
  sourceCandidateId?: string | null;
  parentCandidateId?: string | null;
  agentRole?: string;
  agentSessionId?: string;
  strategyId?: string | null;
  strategyBundleId?: string | null;
  stage?: string;
  status?: string;
  workPackageId?: string | null;
  workPackageHash?: string | null;
  trajectoryPath?: string | null;
  failureTraceId?: string | null;
  decisionIds?: string[];
  refs: string[];
}

export interface AgentLineageIndex {
  schema: "pinovel.agent-lineage-index";
  version: "1.0.0";
  orchestratorRunId: string;
  workspaceId?: string;
  chapterId?: string;
  byCandidate: Record<string, LineageIndexEntry[]>;
  bySession: Record<string, LineageIndexEntry[]>;
  byRole: Record<string, LineageIndexEntry[]>;
  all: LineageIndexEntry[];
  incomplete: string[];
}

function push(
  map: Record<string, LineageIndexEntry[]>,
  key: string | undefined | null,
  entry: LineageIndexEntry,
): void {
  if (!key) return;
  if (!map[key]) map[key] = [];
  map[key].push(entry);
}

/**
 * 从 stageResults（含 agentCollaboration）构建可查询血缘索引。
 */
export function buildAgentLineageIndex(input: {
  stageResults: Record<string, unknown>;
  orchestratorRunId?: string;
  workspaceId?: string;
  chapterId?: string;
}): AgentLineageIndex {
  const collab = (input.stageResults.agentCollaboration ?? {}) as {
    orchestratorRunId?: string;
    workPackages?: Record<string, Record<string, unknown>>;
    agentResults?: Record<string, Record<string, unknown>>;
    decisions?: Array<Record<string, unknown>>;
  };

  const orchestratorRunId =
    input.orchestratorRunId ??
    collab.orchestratorRunId ??
    (typeof input.stageResults.orchestratorRunId === "string"
      ? input.stageResults.orchestratorRunId
      : "unknown-run");

  const novelos = (input.stageResults.novelos ?? {}) as {
    sessionId?: string;
    trajectoryPath?: string;
    candidateId?: string | null;
  };

  const failureEnvelope = (input.stageResults.failureEnvelope ??
    null) as { traceId?: string } | null;

  const all: LineageIndexEntry[] = [];
  const incomplete: string[] = [];
  const byCandidate: Record<string, LineageIndexEntry[]> = {};
  const bySession: Record<string, LineageIndexEntry[]> = {};
  const byRole: Record<string, LineageIndexEntry[]> = {};

  const results = collab.agentResults ?? {};
  const packages = collab.workPackages ?? {};
  const decisions = collab.decisions ?? [];

  for (const [role, result] of Object.entries(results)) {
    const lineage = (result.lineage ?? {}) as Record<string, unknown>;
    const pkg = packages[role] ?? {};
    const candidateId =
      (typeof result.candidateId === "string" && result.candidateId) ||
      (typeof lineage.candidateId === "string" ? lineage.candidateId : null) ||
      novelos.candidateId ||
      null;
    const sessionId =
      (typeof result.sessionId === "string" && result.sessionId) ||
      (typeof lineage.agentSessionId === "string" ? lineage.agentSessionId : "") ||
      novelos.sessionId ||
      "";

    const relatedDecisions = decisions
      .filter(
        (d) =>
          d.sourceAgentRole === role ||
          (candidateId && d.candidateId === candidateId),
      )
      .map((d) => String(d.decisionId ?? ""));

    const entry: LineageIndexEntry = {
      orchestratorRunId:
        (typeof lineage.orchestratorRunId === "string" &&
          lineage.orchestratorRunId) ||
        orchestratorRunId,
      workspaceId: input.workspaceId,
      chapterId: input.chapterId,
      candidateId,
      sourceCandidateId:
        (typeof lineage.sourceCandidateId === "string"
          ? lineage.sourceCandidateId
          : null) ??
        (typeof result.sourceCandidateId === "string"
          ? result.sourceCandidateId
          : null),
      parentCandidateId:
        typeof lineage.parentCandidateId === "string"
          ? lineage.parentCandidateId
          : null,
      agentRole: role,
      agentSessionId: sessionId || undefined,
      strategyId:
        typeof lineage.strategyId === "string" ? lineage.strategyId : null,
      strategyBundleId:
        typeof lineage.strategyBundleId === "string"
          ? lineage.strategyBundleId
          : typeof pkg.strategyBundleId === "string"
            ? pkg.strategyBundleId
            : null,
      stage: typeof pkg.stage === "string" ? pkg.stage : role,
      status: typeof result.status === "string" ? result.status : undefined,
      workPackageId:
        (typeof lineage.workPackageId === "string"
          ? lineage.workPackageId
          : null) ??
        (typeof pkg.packageId === "string" ? pkg.packageId : null),
      workPackageHash:
        (typeof lineage.workPackageHash === "string"
          ? lineage.workPackageHash
          : null) ??
        (typeof pkg.packageHash === "string" ? pkg.packageHash : null),
      trajectoryPath: novelos.trajectoryPath ?? null,
      failureTraceId: failureEnvelope?.traceId ?? null,
      decisionIds: relatedDecisions.filter(Boolean),
      refs: Array.isArray(lineage.usedEvidenceRefs)
        ? (lineage.usedEvidenceRefs as string[])
        : [],
    };

    if (!entry.candidateId && entry.status === "ok") {
      incomplete.push(`${role}: missing candidateId on ok result`);
    }
    if (!entry.agentSessionId) {
      incomplete.push(`${role}: missing agentSessionId`);
    }
    if (!entry.workPackageId) {
      incomplete.push(`${role}: missing workPackageId`);
    }

    all.push(entry);
    push(byCandidate, entry.candidateId, entry);
    push(bySession, entry.agentSessionId, entry);
    push(byRole, entry.agentRole, entry);
  }

  // 若尚无 agentResults，但有 novelos 会话，仍建立最小索引
  if (all.length === 0 && (novelos.sessionId || novelos.candidateId)) {
    const entry: LineageIndexEntry = {
      orchestratorRunId,
      workspaceId: input.workspaceId,
      chapterId: input.chapterId,
      candidateId: novelos.candidateId ?? null,
      agentRole: "novelos_agentic",
      agentSessionId: novelos.sessionId,
      trajectoryPath: novelos.trajectoryPath ?? null,
      failureTraceId: failureEnvelope?.traceId ?? null,
      refs: [],
    };
    all.push(entry);
    push(byCandidate, entry.candidateId, entry);
    push(bySession, entry.agentSessionId, entry);
    push(byRole, entry.agentRole, entry);
    incomplete.push("agentCollaboration.agentResults empty; used novelos fallback");
  }

  return {
    schema: "pinovel.agent-lineage-index",
    version: "1.0.0",
    orchestratorRunId,
    workspaceId: input.workspaceId,
    chapterId: input.chapterId,
    byCandidate,
    bySession,
    byRole,
    all,
    incomplete,
  };
}

export function queryLineageByCandidate(
  index: AgentLineageIndex,
  candidateId: string,
): LineageIndexEntry[] {
  return index.byCandidate[candidateId] ?? [];
}

export function queryLineageBySession(
  index: AgentLineageIndex,
  sessionId: string,
): LineageIndexEntry[] {
  return index.bySession[sessionId] ?? [];
}

export function isLineageCompleteForStrategyUpdate(
  index: AgentLineageIndex,
  candidateId: string,
): { ok: boolean; reasons: string[] } {
  const entries = queryLineageByCandidate(index, candidateId);
  const reasons: string[] = [];
  if (entries.length === 0) {
    reasons.push("no lineage entries for candidate");
  }
  for (const e of entries) {
    if (!e.orchestratorRunId) reasons.push("missing orchestratorRunId");
    if (!e.agentSessionId) reasons.push("missing agentSessionId");
    if (!e.workPackageHash) reasons.push("missing workPackageHash");
  }
  if (index.incomplete.length > 0) {
    reasons.push(...index.incomplete);
  }
  return { ok: reasons.length === 0, reasons };
}
