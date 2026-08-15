/**
 * ReplayTraceStats — 从真实 quality-trace 提取模型调用与生产身份
 *
 * 生产 quality-trace 把 modelCalls / releaseGovernance 写在
 * gates[].evidence 下（尤其 v2_final_selected），而不是顶层
 * trace.modelCalls。回放统计必须读这套真实结构。
 */

export interface ReplayModelCallRecord {
  route?: string;
  requestedRoute?: string;
  provider?: string;
  actualProvider?: string;
  expectedProvider?: string;
  actualModel?: string;
  expectedModel?: string;
  model?: string;
  durationMs?: number;
  ts?: number;
  tokenIn?: number;
  tokenOut?: number;
}

export interface ReplayModelCallStats {
  modelCalls: number;
  tokenIn: number;
  tokenOut: number;
  tokenCost: number;
  recoveryAttempts: number;
  byProvider: Record<string, number>;
  byRequestedRoute: Record<string, number>;
  unauthorizedCrossModelCount: number;
}

export interface ReplayReleaseIdentity {
  devMode: boolean;
  releaseId: string | null;
  environmentFingerprint: string | null;
  approvalRef: string | null;
  bundleId: string | null;
  modelVersion: string | null;
}

export interface ProductionLikeRouteExpectation {
  allowedProviders: string[];
  allowedRequestedRoutes: string[];
}

const GEMINI31_PRODUCTION_EXPECTATION: ProductionLikeRouteExpectation = {
  allowedProviders: ["gemini31"],
  allowedRequestedRoutes: ["v2_rawstage2_gemini31", "v2_amplified_gemini31"],
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asCallRecord(value: unknown): ReplayModelCallRecord | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const route = typeof value.route === "string" ? value.route : undefined;
  const requestedRoute =
    typeof value.requestedRoute === "string" ? value.requestedRoute : undefined;
  const provider = typeof value.provider === "string" ? value.provider : undefined;
  const actualProvider =
    typeof value.actualProvider === "string" ? value.actualProvider : undefined;
  const expectedProvider =
    typeof value.expectedProvider === "string" ? value.expectedProvider : undefined;
  const actualModel =
    typeof value.actualModel === "string" ? value.actualModel : undefined;
  const expectedModel =
    typeof value.expectedModel === "string" ? value.expectedModel : undefined;
  const model = typeof value.model === "string" ? value.model : undefined;
  const durationMs =
    typeof value.durationMs === "number" && Number.isFinite(value.durationMs)
      ? value.durationMs
      : undefined;
  const ts = typeof value.ts === "number" && Number.isFinite(value.ts) ? value.ts : undefined;
  const usage = isPlainObject(value.tokenUsage) ? value.tokenUsage : null;
  const tokenIn =
    usage && typeof usage.in === "number" && Number.isFinite(usage.in) ? usage.in : undefined;
  const tokenOut =
    usage && typeof usage.out === "number" && Number.isFinite(usage.out) ? usage.out : undefined;
  if (
    !route &&
    !requestedRoute &&
    !provider &&
    !actualProvider &&
    !model &&
    !actualModel
  ) {
    return null;
  }
  return {
    route,
    requestedRoute,
    provider,
    actualProvider,
    expectedProvider,
    actualModel,
    expectedModel,
    model,
    durationMs,
    ts,
    tokenIn,
    tokenOut,
  };
}

function collectCallsFromArray(value: unknown): ReplayModelCallRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const calls: ReplayModelCallRecord[] = [];
  for (const item of value) {
    const record = asCallRecord(item);
    if (record) {
      calls.push(record);
    }
  }
  return calls;
}

function collectCallsFromGateEvidence(trace: Record<string, unknown>): ReplayModelCallRecord[] {
  if (!Array.isArray(trace.gates)) {
    return [];
  }
  const preferred: ReplayModelCallRecord[] = [];
  const fallback: ReplayModelCallRecord[] = [];
  for (const gate of trace.gates) {
    if (!isPlainObject(gate) || !isPlainObject(gate.evidence)) {
      continue;
    }
    const calls = collectCallsFromArray(gate.evidence.modelCalls);
    if (calls.length === 0) {
      continue;
    }
    if (gate.stage === "v2_final_selected") {
      preferred.push(...calls);
    } else {
      fallback.push(...calls);
    }
  }
  return preferred.length > 0 ? preferred : fallback;
}

/**
 * 从真实 quality-trace 提取模型调用条目。
 * 优先 v2_final_selected.evidence.modelCalls，再退到其他 gate / 顶层字段。
 */
export function extractReplayModelCalls(trace: unknown): ReplayModelCallRecord[] {
  if (!isPlainObject(trace)) {
    return [];
  }
  const fromGates = collectCallsFromGateEvidence(trace);
  if (fromGates.length > 0) {
    return fromGates;
  }
  const fromTopLevel = collectCallsFromArray(trace.modelCalls);
  if (fromTopLevel.length > 0) {
    return fromTopLevel;
  }
  if (isPlainObject(trace.stageResults)) {
    const fromStage = collectCallsFromArray(trace.stageResults.modelCalls);
    if (fromStage.length > 0) {
      return fromStage;
    }
  }
  return [];
}

export function extractReplayRecoveryAttempts(trace: unknown): number {
  if (!isPlainObject(trace)) {
    return 0;
  }
  if (Array.isArray(trace.recoveryAttempts)) {
    return trace.recoveryAttempts.length;
  }
  let total = 0;
  if (Array.isArray(trace.gates)) {
    for (const gate of trace.gates) {
      if (isPlainObject(gate) && isPlainObject(gate.evidence) && Array.isArray(gate.evidence.recoveryAttempts)) {
        total += gate.evidence.recoveryAttempts.length;
      }
    }
  }
  return total;
}

export function summarizeReplayModelCalls(
  calls: readonly ReplayModelCallRecord[],
  recoveryAttempts = 0,
): ReplayModelCallStats {
  const byProvider: Record<string, number> = {};
  const byRequestedRoute: Record<string, number> = {};
  let unauthorizedCrossModelCount = 0;
  let tokenIn = 0;
  let tokenOut = 0;
  for (const call of calls) {
    tokenIn += call.tokenIn ?? 0;
    tokenOut += call.tokenOut ?? 0;
    const provider = call.actualProvider ?? call.provider;
    if (provider) {
      byProvider[provider] = (byProvider[provider] ?? 0) + 1;
    }
    const requestedRoute = call.requestedRoute ?? call.route;
    if (requestedRoute) {
      byRequestedRoute[requestedRoute] = (byRequestedRoute[requestedRoute] ?? 0) + 1;
    }
    const actualProvider = call.actualProvider ?? call.provider;
    const expectedProvider = call.expectedProvider;
    const actualModel = call.actualModel ?? call.model;
    const expectedModel = call.expectedModel;
    if (
      (expectedProvider && actualProvider && expectedProvider !== actualProvider) ||
      (expectedModel && actualModel && expectedModel !== actualModel)
    ) {
      unauthorizedCrossModelCount += 1;
    }
  }
  return {
    modelCalls: calls.length,
    tokenIn,
    tokenOut,
    tokenCost: tokenIn + tokenOut,
    recoveryAttempts,
    byProvider,
    byRequestedRoute,
    unauthorizedCrossModelCount,
  };
}

function readReleaseGovernance(trace: Record<string, unknown>): Record<string, unknown> | null {
  if (Array.isArray(trace.gates)) {
    for (const gate of trace.gates) {
      if (
        isPlainObject(gate) &&
        gate.stage === "v2_final_selected" &&
        isPlainObject(gate.evidence) &&
        isPlainObject(gate.evidence.releaseGovernance)
      ) {
        return gate.evidence.releaseGovernance;
      }
    }
    for (const gate of trace.gates) {
      if (isPlainObject(gate) && isPlainObject(gate.evidence) && isPlainObject(gate.evidence.releaseGovernance)) {
        return gate.evidence.releaseGovernance;
      }
    }
  }
  if (isPlainObject(trace.releaseGovernance)) {
    return trace.releaseGovernance;
  }
  if (isPlainObject(trace.stageResults) && isPlainObject(trace.stageResults.releaseGovernance)) {
    return trace.stageResults.releaseGovernance;
  }
  return null;
}

export function extractReplayReleaseIdentity(trace: unknown): ReplayReleaseIdentity | null {
  if (!isPlainObject(trace)) {
    return null;
  }
  const gov = readReleaseGovernance(trace);
  if (!gov) {
    return null;
  }
  const identity = isPlainObject(gov.behaviorIdentity) ? gov.behaviorIdentity : {};
  return {
    devMode: gov.devMode === true,
    releaseId: typeof gov.releaseId === "string" ? gov.releaseId : null,
    environmentFingerprint:
      typeof gov.environmentFingerprint === "string" ? gov.environmentFingerprint : null,
    approvalRef: typeof gov.approvalRef === "string" ? gov.approvalRef : null,
    bundleId: typeof identity.bundleId === "string" ? identity.bundleId : null,
    modelVersion: typeof identity.modelVersion === "string" ? identity.modelVersion : null,
  };
}

export function resolveProductionLikeRouteExpectation(
  modelRoute?: string,
  modelVersion?: string,
): ProductionLikeRouteExpectation {
  const route = modelRoute ?? "";
  const version = modelVersion ?? "";
  if (
    route.includes("gemini31") ||
    version.includes("gemini-3.1") ||
    route === "v2_rawstage2_gemini31" ||
    route === "v2_amplified_gemini31"
  ) {
    return GEMINI31_PRODUCTION_EXPECTATION;
  }
  if (route === "v2_rawstage2" || route === "v2_amplified") {
    return {
      allowedProviders: ["claude"],
      allowedRequestedRoutes: ["v2_rawstage2", "v2_amplified"],
    };
  }
  return GEMINI31_PRODUCTION_EXPECTATION;
}

export interface ProductionLikeEvidenceCheckInput {
  modelCalls: number;
  stats: ReplayModelCallStats;
  identity: ReplayReleaseIdentity | null;
  expectedRelease: {
    releaseId: string;
    environmentFingerprint: string;
    approvalRef: string;
    bundleId: string;
    modelVersion?: string | null;
  };
  modelRoute?: string;
}

export function evaluateProductionLikeEvidence(
  input: ProductionLikeEvidenceCheckInput,
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (input.modelCalls <= 0 || input.stats.modelCalls <= 0) {
    reasons.push(`modelCalls=${input.modelCalls}（production_like 要求大于 0）`);
  }
  if (!input.identity) {
    reasons.push("production_like 缺少 releaseGovernance 身份");
    return { ok: false, reasons };
  }
  if (input.identity.devMode) {
    reasons.push("devMode=true（production_like 禁止 DEV_MODE 旁路）");
  }
  const requiredIdentity: Array<[string, string | null]> = [
    ["releaseId", input.identity.releaseId],
    ["environmentFingerprint", input.identity.environmentFingerprint],
    ["approvalRef", input.identity.approvalRef],
    ["bundleId", input.identity.bundleId],
    ["modelVersion", input.identity.modelVersion],
  ];
  for (const [field, value] of requiredIdentity) {
    if (!value || value.trim().length === 0) {
      reasons.push(`生产身份缺失：${field}`);
    }
  }
  if (input.identity.releaseId && input.identity.releaseId !== input.expectedRelease.releaseId) {
    reasons.push(
      `releaseId 漂移：trace=${input.identity.releaseId} active=${input.expectedRelease.releaseId}`,
    );
  }
  if (
    input.identity.environmentFingerprint &&
    input.identity.environmentFingerprint !== input.expectedRelease.environmentFingerprint
  ) {
    reasons.push("environmentFingerprint 与 active manifest 不一致");
  }
  if (input.identity.approvalRef && input.identity.approvalRef !== input.expectedRelease.approvalRef) {
    reasons.push("approvalRef 与 active manifest 不一致");
  }
  if (input.identity.bundleId && input.identity.bundleId !== input.expectedRelease.bundleId) {
    reasons.push("bundleId 与 active manifest 不一致");
  }
  if (
    input.expectedRelease.modelVersion &&
    input.identity.modelVersion &&
    input.identity.modelVersion !== input.expectedRelease.modelVersion
  ) {
    reasons.push("modelVersion 与 active manifest 不一致");
  }
  if (input.stats.unauthorizedCrossModelCount !== 0) {
    reasons.push(
      `unauthorizedCrossModelCount=${input.stats.unauthorizedCrossModelCount}（要求 0）`,
    );
  }
  const expectation = resolveProductionLikeRouteExpectation(
    input.modelRoute,
    input.identity.modelVersion ?? input.expectedRelease.modelVersion ?? undefined,
  );
  for (const [provider, count] of Object.entries(input.stats.byProvider)) {
    if (count > 0 && !expectation.allowedProviders.includes(provider)) {
      reasons.push(`provider 路由漂移：${provider} 不在 ${expectation.allowedProviders.join("|")}`);
    }
  }
  for (const [route, count] of Object.entries(input.stats.byRequestedRoute)) {
    if (count > 0 && !expectation.allowedRequestedRoutes.includes(route)) {
      reasons.push(
        `requestedRoute 漂移：${route} 不在 ${expectation.allowedRequestedRoutes.join("|")}`,
      );
    }
  }
  return { ok: reasons.length === 0, reasons };
}
