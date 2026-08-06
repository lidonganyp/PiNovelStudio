/**
 * Must-verify coverage gate.
 *
 * This module is still eval-only until the unified production orchestrator
 * explicitly wires it in. The gate itself is deterministic and fail-closed:
 * P0/P1 facts must be covered by compiled context or confirmed trajectory
 * evidence; P2 facts remain advisory.
 */

import { existsSync, readFileSync } from "node:fs";
import type { EvidencePlan } from "./evidence-plan.js";

export type FactRiskLevel = "P0" | "P1" | "P2";

export interface ClassifiedMustVerify {
  item: string;
  riskLevel: FactRiskLevel;
  reason: string;
}

export interface CoverageGateInput {
  evidencePlan: EvidencePlan;
  trajectoryPath: string;
  inviolableFacts: string[];
  contextCoveredFacts: string[];
}

export interface CoverageGateFailureEnvelope {
  stage: "must_verify_coverage_gate";
  gate: "unverified_high_risk_facts";
  severity: "hard";
  evidence: Array<{
    item: string;
    riskLevel: FactRiskLevel;
    reason: string;
  }>;
  recoverable: true;
  retryPlan: "agent_loop_retry_with_explicit_must_verify_prompt";
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
}

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

function normalizeFact(value: string): string {
  return value.replace(/\s+/gu, "").trim();
}

function extractKeyPhrases(value: string): string[] {
  const phrases = new Set<string>();
  const segments = normalizeFact(value).match(/[\u4e00-\u9fff]+/gu) ?? [];
  for (const segment of segments) {
    // Short fragments such as a character name are not enough to establish
    // that two facts are semantically the same. Keep fuzzy overlap bounded to
    // meaningful four-character phrases; exact containment remains available
    // for shorter, explicitly identical facts.
    for (let length = 4; length <= segment.length; length += 1) {
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

    const visit = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      const record = value as Record<string, unknown>;
      const details = record.details;
      if (details && typeof details === "object") {
        const detailRecord = details as Record<string, unknown>;
        if (
          detailRecord.evidenceLevel === "confirmed" &&
          typeof detailRecord.sourceRef === "string"
        ) {
          const excerpt =
            typeof record.excerpt === "string"
              ? record.excerpt
              : typeof record.text === "string"
                ? record.text
                : extractText(record.content);
          const key = `${detailRecord.sourceRef}\u0000${excerpt}`;
          if (excerpt && !seen.has(key)) {
            seen.add(key);
            evidence.push({
              sourceRef: detailRecord.sourceRef,
              excerpt,
            });
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
): CoverageGateFailureEnvelope {
  return {
    stage: "must_verify_coverage_gate",
    gate: "unverified_high_risk_facts",
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

  for (const item of highRisk) {
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

    const evidenceMatch = trajectoryEvidence.find((evidence) =>
      factsMatch(item.item, evidence.excerpt),
    );
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
      failureEnvelope: makeFailureEnvelope(unverifiedHighRisk),
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
