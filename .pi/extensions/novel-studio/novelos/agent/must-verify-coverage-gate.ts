/**
 * Must-verify coverage gate.
 *
 * Production Agentic loop wires the real gate. CEG-5.1：硬覆盖只接受
 * confirmed + sourceRef + 同一 snapshot；derived/advisory/conflicted
 * 与 confirmed_state 不计硬覆盖。无 snapshotId 时保留旧 eval 字符串覆盖。
 */

import { existsSync, readFileSync } from "node:fs";
import type { EvidencePlan } from "./evidence-plan.js";

export type FactRiskLevel = "P0" | "P1" | "P2";

export interface ClassifiedMustVerify {
  item: string;
  riskLevel: FactRiskLevel;
  reason: string;
}

export interface ConfirmedCoverageFact {
  statement: string;
  sourceRef: string;
  snapshotId: string;
}

export interface CoverageGateInput {
  evidencePlan: EvidencePlan;
  trajectoryPath: string;
  inviolableFacts: string[];
  contextCoveredFacts: string[];
  /** CEG-1.6 / CEG-5.1：硬覆盖必须属于同一 snapshot。 */
  snapshotId?: string;
  /** CEG-5.1：来自 ContextPackage 权威槽的 confirmed 覆盖。 */
  confirmedCoverage?: ConfirmedCoverageFact[];
  /** CEG-4.1 / CEG-5.4：本轮检索结局。 */
  retrievalOutcomes?: Array<{
    queryId: string;
    status: "match" | "no_match" | "retrieval_error" | "truncated";
    evidence?: unknown[];
    nextQueryHint?: string | null;
    budget?: { usedCalls: number; remainingCalls: number };
  }>;
  /** CEG-5.3：检索预算快照。 */
  retrievalBudget?: {
    usedCalls: number;
    remainingCalls: number;
    lastQuery: string | null;
  };
}

export interface CoverageGateFailureEnvelope {
  stage: "must_verify_coverage_gate";
  gate:
    | "unverified_high_risk_facts"
    | "retrieval_budget_exhausted"
    | "retrieval_error";
  failureClass: "blocked" | "recoverable";
  severity: "hard";
  evidence:
    | Array<{
        item: string;
        riskLevel: FactRiskLevel;
        reason: string;
      }>
    | {
        unverifiedHighRisk: Array<{
          item: string;
          riskLevel: FactRiskLevel;
          reason: string;
        }>;
        lastQuery?: string | null;
        usedCalls?: number;
        remainingCalls?: number;
      };
  recoverable: boolean;
  retryPlan: "agent_loop_retry_with_explicit_must_verify_prompt";
  userActionRequired?: string[];
}

export interface CoverageGateResult {
  passed: boolean;
  unverifiedHighRisk: Array<{
    item: string;
    riskLevel: FactRiskLevel;
    reason: string;
  }>;
  confirmedItems: Array<{
    item: string;
    matchedEvidence: string;
  }>;
  skippedReason?:
    | "no_must_verify"
    | "context_covered"
    | "no_high_risk"
    | "stub_not_implemented";
  failureEnvelope?: CoverageGateFailureEnvelope;
}

export interface CoverageGate {
  checkAndBlock(input: CoverageGateInput): CoverageGateResult;
}

interface ConfirmedEvidence {
  sourceRef: string;
  excerpt: string;
  snapshotId?: string;
}

const CONFIRMED_EVIDENCE_LEVELS = new Set([
  "confirmed",
]);

const P0_MARKERS = [
  "身份",
  "真实身份",
  "世界规则",
  "不可违背",
  "不可违反",
  "核心设定",
  "功法",
  "境界",
  "封印",
  "禁制",
];

const P1_MARKERS = [
  "状态",
  "位置",
  "时间",
  "伤势",
  "关系",
  "承诺",
  "伏笔",
  "债务",
  "年龄",
  "进度",
];

const FACT_STOP_WORDS = new Set([
  "确认",
  "验证",
  "查证",
  "核对",
  "了解",
  "当前",
  "本章",
  "相关",
  "是否",
]);

/** 主语分隔词——用于切分事实的主语和谓语 */
const SUBJECT_SPLITTERS = ["是", "的", "在", "有", "为", "被", "将", "属于"];

function normalizeFact(value: string): string {
  return value.replace(/\s+/gu, "").trim();
}

/**
 * 提取事实的主语（第一个分隔词之前的部分）。
 * 用于实体感知：不同主语的事实不应判为覆盖。
 * 例如 "叶尘是主角团成员" -> "叶尘"，"林婉儿是主角团成员" -> "林婉儿"
 */
function extractSubject(fact: string): string | null {
  let earliestIdx = -1;
  for (const splitter of SUBJECT_SPLITTERS) {
    const idx = fact.indexOf(splitter);
    if (idx > 0 && (earliestIdx === -1 || idx < earliestIdx)) {
      earliestIdx = idx;
    }
  }
  return earliestIdx > 0 ? fact.slice(0, earliestIdx) : null;
}

/**
 * 提取中文关键短语（≥ minLength 字）。
 * minLength=6 以避免 "是主角团成" 等通用谓语片段造成误匹配。
 */
function extractKeyPhrases(value: string, minLength = 6): string[] {
  const phrases = new Set<string>();
  const segments = normalizeFact(value).match(/[\u4e00-\u9fff]+/gu) ?? [];
  for (const segment of segments) {
    for (let length = minLength; length <= segment.length; length += 1) {
      for (let index = 0; index <= segment.length - length; index += 1) {
        const phrase = segment.slice(index, index + length);
        if (!FACT_STOP_WORDS.has(phrase)) phrases.add(phrase);
      }
    }
  }
  return [...phrases];
}

function factsMatch(item: string, candidate: string): boolean {
  const normalizedItem = normalizeFact(item);
  const normalizedCandidate = normalizeFact(candidate);
  if (!normalizedItem || !normalizedCandidate) return false;
  if (
    normalizedItem.includes(normalizedCandidate) ||
    normalizedCandidate.includes(normalizedItem)
  ) {
    return true;
  }

  // 实体感知：如果两条事实都有可识别主语，且主语不同（无包含关系），则不匹配。
  // 这防止 "叶尘是主角团成员" 匹配 "林婉儿是主角团成员"。
  const itemSubject = extractSubject(normalizedItem);
  const candidateSubject = extractSubject(normalizedCandidate);
  if (
    itemSubject &&
    candidateSubject &&
    itemSubject !== candidateSubject &&
    !itemSubject.includes(candidateSubject) &&
    !candidateSubject.includes(itemSubject)
  ) {
    return false;
  }

  return extractKeyPhrases(normalizedItem).some((phrase) =>
    normalizedCandidate.includes(phrase),
  );
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const record = item as Record<string, unknown>;
      return typeof record.text === "string" ? record.text : "";
    })
    .join("");
}

function readConfirmedEvidence(trajectoryPath: string): ConfirmedEvidence[] {
  if (!trajectoryPath || !existsSync(trajectoryPath)) return [];
  try {
    const lines = readFileSync(trajectoryPath, "utf8").split(/\r?\n/gu);
    const evidence: ConfirmedEvidence[] = [];
    const seen = new Set<string>();

    const addEvidence = (sourceRef: unknown, excerpt: unknown, snapshotId?: unknown): void => {
      if (typeof sourceRef !== "string" || typeof excerpt !== "string" || !excerpt) {
        return;
      }
      const key = `${sourceRef}\u0000${excerpt}`;
      if (seen.has(key)) return;
      seen.add(key);
      evidence.push({
        sourceRef,
        excerpt,
        snapshotId: typeof snapshotId === "string" ? snapshotId : undefined,
      });
    };

    const visit = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      const record = value as Record<string, unknown>;
      if (record.type === "ranked_evidence") {
        const data = record.data;
        if (data && typeof data === "object") {
          const dataRecord = data as Record<string, unknown>;
          const evidences = dataRecord.evidences ?? dataRecord.rankedEvidences;
          if (Array.isArray(evidences)) {
            for (const item of evidences) {
              if (!item || typeof item !== "object") continue;
              const ranked = item as Record<string, unknown>;
              if (CONFIRMED_EVIDENCE_LEVELS.has(String(ranked.evidenceLevel ?? ""))) {
                addEvidence(
                  ranked.sourceRef,
                  ranked.excerpt,
                  ranked.snapshotId ?? dataRecord.snapshotId,
                );
              }
            }
          }
        }
      }
      const details = record.details;
      if (details && typeof details === "object") {
        const detailRecord = details as Record<string, unknown>;
        const inheritedSnapshot = detailRecord.snapshotId;
        if (
          CONFIRMED_EVIDENCE_LEVELS.has(String(detailRecord.evidenceLevel ?? "")) &&
          typeof detailRecord.sourceRef === "string"
        ) {
          const excerpt =
            typeof record.excerpt === "string"
              ? record.excerpt
              : typeof record.text === "string"
                ? record.text
                : extractText(record.content);
          addEvidence(detailRecord.sourceRef, excerpt, inheritedSnapshot);
        }
        const nested = detailRecord.rankedEvidences ?? detailRecord.evidences;
        if (Array.isArray(nested)) {
          for (const item of nested) {
            if (!item || typeof item !== "object") continue;
            const ranked = item as Record<string, unknown>;
            if (CONFIRMED_EVIDENCE_LEVELS.has(String(ranked.evidenceLevel ?? ""))) {
              addEvidence(
                ranked.sourceRef,
                ranked.excerpt,
                ranked.snapshotId ?? inheritedSnapshot,
              );
            }
          }
        }
      }
      for (const child of Object.values(record)) {
        if (child && typeof child === "object") visit(child);
      }
    };

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        visit(JSON.parse(line) as unknown);
      } catch {
        // Ignore malformed lines. Missing confirmed evidence must still block.
      }
    }
    return evidence;
  } catch {
    return [];
  }
}

function makeFailureEnvelope(
  unverifiedHighRisk: CoverageGateResult["unverifiedHighRisk"],
  input?: CoverageGateInput,
): CoverageGateFailureEnvelope {
  const budget = input?.retrievalBudget;
  const hasRetrievalError = (input?.retrievalOutcomes ?? []).some(
    (outcome) => outcome.status === "retrieval_error",
  );
  if (budget && budget.remainingCalls <= 0 && budget.usedCalls > 0) {
    return {
      stage: "must_verify_coverage_gate",
      gate: "retrieval_budget_exhausted",
      failureClass: "blocked",
      severity: "hard",
      evidence: {
        unverifiedHighRisk,
        lastQuery: budget.lastQuery,
        usedCalls: budget.usedCalls,
        remainingCalls: budget.remainingCalls,
      },
      recoverable: false,
      retryPlan: "agent_loop_retry_with_explicit_must_verify_prompt",
      userActionRequired: [
        "提高本章检索预算或补齐必须验证的事实来源后重试",
        ...(budget.lastQuery ? [`最后查询：${budget.lastQuery}`] : []),
        ...unverifiedHighRisk.slice(0, 5).map((item) => `未覆盖：${item.item}`),
      ],
    };
  }
  if (hasRetrievalError) {
    const errored = (input?.retrievalOutcomes ?? []).find((outcome) => outcome.status === "retrieval_error");
    return {
      stage: "must_verify_coverage_gate",
      gate: "retrieval_error",
      failureClass: "recoverable",
      severity: "hard",
      evidence: {
        unverifiedHighRisk,
        lastQuery: errored?.queryId ?? budget?.lastQuery ?? null,
        usedCalls: budget?.usedCalls,
        remainingCalls: budget?.remainingCalls,
      },
      recoverable: true,
      retryPlan: "agent_loop_retry_with_explicit_must_verify_prompt",
    };
  }
  return {
    stage: "must_verify_coverage_gate",
    gate: "unverified_high_risk_facts",
    failureClass: "blocked",
    severity: "hard",
    evidence: unverifiedHighRisk,
    recoverable: true,
    retryPlan: "agent_loop_retry_with_explicit_must_verify_prompt",
  };
}

/** Classify mustVerify items without a model call. */
export function assessMustVerifyRisk(
  mustVerify: string[],
  inviolableFacts: string[],
): ClassifiedMustVerify[] {
  return mustVerify.map((item) => {
    const overlap = inviolableFacts.find((fact) => factsMatch(item, fact));
    if (overlap) {
      return {
        item,
        riskLevel: "P0" as FactRiskLevel,
        reason: `mustVerify overlaps an inviolable fact: ${overlap}`,
      };
    }

    const normalized = normalizeFact(item);
    const p0Marker = P0_MARKERS.find((marker) => normalized.includes(marker));
    if (p0Marker) {
      return {
        item,
        riskLevel: "P0" as FactRiskLevel,
        reason: `matched P0 high-impact marker: ${p0Marker}`,
      };
    }

    const p1Marker = P1_MARKERS.find((marker) => normalized.includes(marker));
    if (p1Marker) {
      return {
        item,
        riskLevel: "P1" as FactRiskLevel,
        reason: `matched P1 state marker: ${p1Marker}`,
      };
    }

    return {
      item,
      riskLevel: "P2" as FactRiskLevel,
      reason: "no P0/P1 marker; advisory only",
    };
  });
}

/**
 * Check high-risk mustVerify coverage.
 *
 * P0/P1 items are covered only by compiled context or confirmed trajectory
 * evidence. P2 items do not block generation.
 */
export function checkMustVerifyCoverage(
  input: CoverageGateInput,
): CoverageGateResult {
  const mustVerify = input.evidencePlan.mustVerify ?? [];
  if (mustVerify.length === 0) {
    return {
      passed: true,
      unverifiedHighRisk: [],
      confirmedItems: [],
      skippedReason: "no_must_verify",
      failureEnvelope: undefined,
    };
  }

  const classified = assessMustVerifyRisk(mustVerify, input.inviolableFacts);
  const highRisk = classified.filter((item) => item.riskLevel !== "P2");
  if (highRisk.length === 0) {
    return {
      passed: true,
      unverifiedHighRisk: [],
      confirmedItems: [],
      skippedReason: "no_high_risk",
      failureEnvelope: undefined,
    };
  }

  const trajectoryEvidence = readConfirmedEvidence(input.trajectoryPath);
  const confirmedItems: CoverageGateResult["confirmedItems"] = [];
  const unverifiedHighRisk: CoverageGateResult["unverifiedHighRisk"] = [];
  let contextOnly = true;
  const snapshotBound = Boolean(input.snapshotId);

  for (const item of highRisk) {
    if (snapshotBound) {
      const packaged = (input.confirmedCoverage ?? []).find((fact) =>
        fact.snapshotId === input.snapshotId
        && Boolean(fact.sourceRef)
        && factsMatch(item.item, fact.statement),
      );
      if (packaged) {
        confirmedItems.push({
          item: item.item,
          matchedEvidence: packaged.sourceRef,
        });
        continue;
      }
    } else {
      const contextMatch = input.contextCoveredFacts.find((fact) =>
        factsMatch(item.item, fact),
      );
      if (contextMatch) {
        confirmedItems.push({
          item: item.item,
          matchedEvidence: `context:${contextMatch}`,
        });
        continue;
      }
    }

    const evidenceMatch = trajectoryEvidence.find((evidence) => {
      if (!factsMatch(item.item, evidence.excerpt)) return false;
      if (!evidence.sourceRef) return false;
      if (snapshotBound && evidence.snapshotId !== input.snapshotId) return false;
      return true;
    });
    if (evidenceMatch) {
      contextOnly = false;
      confirmedItems.push({
        item: item.item,
        matchedEvidence: evidenceMatch.sourceRef,
      });
      continue;
    }

    unverifiedHighRisk.push({
      item: item.item,
      riskLevel: item.riskLevel,
      reason: item.reason,
    });
  }

  if (unverifiedHighRisk.length > 0) {
    return {
      passed: false,
      unverifiedHighRisk,
      confirmedItems,
      failureEnvelope: makeFailureEnvelope(unverifiedHighRisk, input),
    };
  }

  return {
    passed: true,
    unverifiedHighRisk: [],
    confirmedItems,
    skippedReason: contextOnly ? "context_covered" : undefined,
    failureEnvelope: undefined,
  };
}

/** Factory for the real gate; production orchestration wiring is a later slice. */
export function createMustVerifyCoverageGate(): CoverageGate {
  return {
    checkAndBlock(input: CoverageGateInput): CoverageGateResult {
      return checkMustVerifyCoverage(input);
    },
  };
}

/**
 * Compatibility stub retained for the original interface-only eval tests.
 * It is intentionally not suitable for production wiring.
 */
export function createStubCoverageGate(): CoverageGate {
  return {
    checkAndBlock(input: CoverageGateInput): CoverageGateResult {
      void input;
      return {
        passed: true,
        unverifiedHighRisk: [],
        confirmedItems: [],
        skippedReason: "stub_not_implemented",
        failureEnvelope: undefined,
      };
    },
  };
}
