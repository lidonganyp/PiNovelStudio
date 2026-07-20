/**
 * CraftPhenomenonReport - post-raw methodology observations with cited spans.
 *
 * The report helps an editor understand a chapter. It cannot rewrite prose,
 * select a winner, assign a literary score, or enter the raw prompt.
 */

import type { TextSpan } from "./types.js";

export const CRAFT_PHENOMENON_DOMAINS = [
  "dialogue",
  "rhythm_and_climax",
  "expectation_and_serial",
  "genre_contract",
  "supporting_characters",
  "world_revelation",
  "ensemble",
  "ending_and_closure",
  "chapter_progression",
  "cross_chapter_health",
] as const;

export type CraftPhenomenonDomain = typeof CRAFT_PHENOMENON_DOMAINS[number];
export type CraftPhenomenonStatus = "observed" | "uncertain" | "not_applicable";

export interface CraftPhenomenonObservationInput {
  domain: CraftPhenomenonDomain;
  status: CraftPhenomenonStatus;
  phenomenon: string;
  readerImpact: string;
  evidenceExcerpt?: string;
  confidence: number;
}

export interface CraftPhenomenonObservation {
  domain: CraftPhenomenonDomain;
  status: CraftPhenomenonStatus;
  phenomenon: string;
  readerImpact: string;
  sourceSpans: TextSpan[];
  confidence: number;
}

export interface RejectedCraftPhenomenonObservation {
  observation: CraftPhenomenonObservationInput;
  reason: string;
}

export interface CraftPhenomenonReport {
  schemaVersion: "craft-phenomenon-report-v1";
  status: "completed" | "skipped";
  sourceCandidateId: string;
  methodologySource: "docs/AI小说工作流-从故事设计到长篇成书的系统方法.md";
  domains: readonly CraftPhenomenonDomain[];
  observations: CraftPhenomenonObservation[];
  rejectedObservations: RejectedCraftPhenomenonObservation[];
  advisoryOnly: true;
  canDirectlyRewrite: false;
  canSelectWinner: false;
  canTriggerEditorialOpportunity: boolean;
  emptyReason: string | null;
}

export interface BuildCraftPhenomenonReportInput {
  rawText: string;
  rawCandidateId: string;
  observations: CraftPhenomenonObservationInput[];
}

const DOMAIN_SET = new Set<string>(CRAFT_PHENOMENON_DOMAINS);
const STATUS_SET = new Set<string>(["observed", "uncertain", "not_applicable"]);

export function buildCraftPhenomenonReport(
  input: BuildCraftPhenomenonReportInput,
): CraftPhenomenonReport {
  const observations: CraftPhenomenonObservation[] = [];
  const rejectedObservations: RejectedCraftPhenomenonObservation[] = [];

  for (const observation of input.observations) {
    const rejection = validateObservationInput(observation);
    if (rejection) {
      rejectedObservations.push({ observation, reason: rejection });
      continue;
    }

    if (observation.status === "not_applicable") {
      if (observation.evidenceExcerpt?.trim()) {
        rejectedObservations.push({
          observation,
          reason: "not_applicable 不能携带正文 span",
        });
        continue;
      }
      observations.push({
        domain: observation.domain,
        status: observation.status,
        phenomenon: observation.phenomenon.trim(),
        readerImpact: observation.readerImpact.trim(),
        sourceSpans: [],
        confidence: observation.confidence,
      });
      continue;
    }

    const excerpt = observation.evidenceExcerpt?.trim() ?? "";
    const start = excerpt ? input.rawText.indexOf(excerpt) : -1;
    if (start < 0) {
      rejectedObservations.push({
        observation,
        reason: "evidenceExcerpt 在原文中定位失败",
      });
      continue;
    }
    observations.push({
      domain: observation.domain,
      status: observation.status,
      phenomenon: observation.phenomenon.trim(),
      readerImpact: observation.readerImpact.trim(),
      sourceSpans: [{ start, end: start + excerpt.length, excerpt }],
      confidence: observation.confidence,
    });
  }

  return {
    schemaVersion: "craft-phenomenon-report-v1",
    status: "completed",
    sourceCandidateId: input.rawCandidateId,
    methodologySource: "docs/AI小说工作流-从故事设计到长篇成书的系统方法.md",
    domains: CRAFT_PHENOMENON_DOMAINS,
    observations,
    rejectedObservations,
    advisoryOnly: true,
    canDirectlyRewrite: false,
    canSelectWinner: false,
    canTriggerEditorialOpportunity: observations.some(
      (entry) => entry.status === "observed" || entry.status === "uncertain",
    ),
    emptyReason: observations.length === 0 ? "没有通过 span 校验的工艺现象" : null,
  };
}

export function skippedCraftPhenomenonReport(
  reason: string,
  rawCandidateId: string,
): CraftPhenomenonReport {
  return {
    schemaVersion: "craft-phenomenon-report-v1",
    status: "skipped",
    sourceCandidateId: rawCandidateId,
    methodologySource: "docs/AI小说工作流-从故事设计到长篇成书的系统方法.md",
    domains: CRAFT_PHENOMENON_DOMAINS,
    observations: [],
    rejectedObservations: [],
    advisoryOnly: true,
    canDirectlyRewrite: false,
    canSelectWinner: false,
    canTriggerEditorialOpportunity: false,
    emptyReason: reason,
  };
}

export function validateCraftPhenomenonReport(report: CraftPhenomenonReport): string | null {
  if (report.schemaVersion !== "craft-phenomenon-report-v1") return "schemaVersion 非法";
  if (report.advisoryOnly !== true) return "advisoryOnly 必须为 true";
  if (report.canDirectlyRewrite !== false) return "工艺报告不得直接改写正文";
  if (report.canSelectWinner !== false) return "工艺报告不得选择 winner";
  if (!report.sourceCandidateId) return "sourceCandidateId 不能为空";
  for (const observation of report.observations) {
    if (!DOMAIN_SET.has(observation.domain)) return `未知工艺域：${observation.domain}`;
    if (!STATUS_SET.has(observation.status)) return `未知现象状态：${observation.status}`;
    if (observation.status === "not_applicable" && observation.sourceSpans.length > 0) {
      return "not_applicable 不能携带正文 span";
    }
    if (observation.status !== "not_applicable" && observation.sourceSpans.length === 0) {
      return `${observation.status} 必须携带正文 span`;
    }
  }
  return null;
}

function validateObservationInput(observation: CraftPhenomenonObservationInput): string | null {
  if (!DOMAIN_SET.has(observation.domain)) return `未知工艺域：${observation.domain}`;
  if (!STATUS_SET.has(observation.status)) return `未知现象状态：${observation.status}`;
  if (!observation.phenomenon?.trim()) return "phenomenon 不能为空";
  if (!observation.readerImpact?.trim()) return "readerImpact 不能为空";
  if (!Number.isFinite(observation.confidence) || observation.confidence < 0 || observation.confidence > 1) {
    return "confidence 必须是 [0,1] 数值";
  }
  return null;
}

