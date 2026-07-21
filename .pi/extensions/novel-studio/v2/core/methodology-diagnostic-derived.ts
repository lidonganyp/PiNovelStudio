/**
 * Derived advisory assessments computed from the base MethodologyDiagnosticState
 * contexts. All outputs are advisory-only: they provide signals to the post-raw
 * judge and trace, never enter the raw prompt, and cannot authorize candidates.
 *
 * The thresholds here are soft signals, not mechanical gates. They exist to give
 * the LLM judge compact, span-referenced evidence about cross-chapter pressure,
 * not to prescribe how the chapter must be written.
 */

import type {
  ClosureDiagnosticContext,
  EnsembleDiagnosticContext,
  FatigueDiagnosticContext,
  SerialDiagnosticState,
} from "./methodology-diagnostic-state.js";

export type FatigueSeverity = "none" | "mild" | "moderate" | "severe";

export interface OverdueAlertEntry {
  itemId: string;
  itemType: "expectation" | "promise" | "foreshadow";
  severity: "yellow" | "red";
  description: string;
  expectedLatest: number | null;
  chaptersOverdue: number | null;
  sourceRef: string;
}

export interface StagnationAssessment {
  detected: boolean;
  chaptersSinceLastPeak: number | null;
  stagnantArcIds: string[];
  sourceRefs: string[];
  emptyReason: string | null;
}

export interface EnsembleClimaxOpportunity {
  detected: boolean;
  convergentArcs: string[];
  criticalRelationships: string[];
  convergentExpectations: string[];
  estimatedWindow: { earliest: number | null; optimal: number | null } | null;
  sourceRefs: string[];
  emptyReason: string | null;
}

// Soft thresholds — advisory signals, not mechanical gates.
const STAGNATION_THRESHOLD = 3;
const YELLOW_WINDOW = 2;
const CLIMAX_LOOKAHEAD = 3;
const CRITICAL_RELATIONSHIP_STATES = new Set([
  "cooling",
  "tense",
  "breaking",
  "critical",
  "strained",
  "broken",
]);

/**
 * Build REM overdue alerts from expectations, promises, and pending foreshadows.
 * Yellow = approaching latest window or delayed status.
 * Red = past latest window or escalated status.
 */
export function buildOverdueAlerts(
  serialState: SerialDiagnosticState,
  closure: ClosureDiagnosticContext,
  chapterNumber: number,
): OverdueAlertEntry[] {
  const alerts: OverdueAlertEntry[] = [];

  for (const foreshadow of closure.pendingForeshadows) {
    const latest = foreshadow.expectedRecallWindow?.latest ?? null;
    if (latest === null) continue;
    if (chapterNumber > latest) {
      alerts.push({
        itemId: foreshadow.foreshadowId,
        itemType: "foreshadow",
        severity: "red",
        description: foreshadow.description,
        expectedLatest: latest,
        chaptersOverdue: chapterNumber - latest,
        sourceRef: foreshadow.sourceRef,
      });
    } else if (chapterNumber >= latest - YELLOW_WINDOW) {
      alerts.push({
        itemId: foreshadow.foreshadowId,
        itemType: "foreshadow",
        severity: "yellow",
        description: foreshadow.description,
        expectedLatest: latest,
        chaptersOverdue: null,
        sourceRef: foreshadow.sourceRef,
      });
    }
  }

  for (const expectation of serialState.expectations) {
    if (expectation.status === "escalated") {
      alerts.push({
        itemId: expectation.expectationId,
        itemType: "expectation",
        severity: "red",
        description: expectation.description,
        expectedLatest: null,
        chaptersOverdue: null,
        sourceRef: expectation.sourceRefs[0] ?? "",
      });
    } else if (expectation.status === "delayed") {
      alerts.push({
        itemId: expectation.expectationId,
        itemType: "expectation",
        severity: "yellow",
        description: expectation.description,
        expectedLatest: null,
        chaptersOverdue: null,
        sourceRef: expectation.sourceRefs[0] ?? "",
      });
    }
  }

  for (const promise of serialState.promises) {
    if (promise.status === "escalated" || promise.status === "delayed") {
      alerts.push({
        itemId: promise.promiseId,
        itemType: "promise",
        severity: promise.status === "escalated" ? "red" : "yellow",
        description: promise.description,
        expectedLatest: null,
        chaptersOverdue: null,
        sourceRef: promise.sourceRefs[0] ?? "",
      });
    }
  }

  return alerts;
}

/**
 * Detect consecutive stagnation: primary signal is chaptersSinceLastPeak from
 * readerExpectation; secondary signal is multiple open arcs that haven't started
 * advancing. Advisory only — does not block or force rewrite.
 */
export function buildStagnation(
  serialState: SerialDiagnosticState,
  closure: ClosureDiagnosticContext,
): StagnationAssessment {
  const chaptersSinceLastPeak = serialState.fatigue.chaptersSinceLastPeak;
  const stagnantArcIds = closure.openArcs
    .filter((arc) => arc.status === "idle" || arc.status === "opened" || arc.status === "open")
    .map((arc) => arc.arcId);

  const detected =
    (chaptersSinceLastPeak !== null && chaptersSinceLastPeak >= STAGNATION_THRESHOLD) ||
    stagnantArcIds.length >= 2;

  const sourceRefs = new Set<string>();
  if (chaptersSinceLastPeak !== null) {
    sourceRefs.add("series/narrative-state.json#readerExpectation.chaptersSinceLastPeak");
  }
  for (const arc of closure.openArcs) {
    if (stagnantArcIds.includes(arc.arcId)) {
      sourceRefs.add(arc.sourceRef);
    }
  }

  return {
    detected,
    chaptersSinceLastPeak,
    stagnantArcIds,
    sourceRefs: [...sourceRefs].sort(),
    emptyReason:
      chaptersSinceLastPeak === null && stagnantArcIds.length === 0
        ? "no_stagnation_signal_available"
        : null,
  };
}

/**
 * Assess fatigue severity from repetition indicators. This is a derived signal
 * that summarizes the raw fatigue context into a compact severity level + signals
 * list for the judge. Does not introduce new mechanical gates.
 */
export function assessFatigueSeverity(fatigue: FatigueDiagnosticContext): {
  severity: FatigueSeverity;
  severitySignals: string[];
} {
  const consecutiveSameType = fatigue.consecutiveSameType ?? 0;
  const consecutiveSameHorrorTechnique = fatigue.consecutiveSameHorrorTechnique ?? 0;

  const signals: string[] = [];
  if (consecutiveSameType >= 3) signals.push(`consecutiveSameType:${consecutiveSameType}`);
  if (consecutiveSameHorrorTechnique >= 3) {
    signals.push(`consecutiveSameHorrorTechnique:${consecutiveSameHorrorTechnique}`);
  }
  if (signals.length > 0) return { severity: "severe", severitySignals: signals };

  if (consecutiveSameType >= 2) signals.push(`consecutiveSameType:${consecutiveSameType}`);
  if (consecutiveSameHorrorTechnique >= 2) {
    signals.push(`consecutiveSameHorrorTechnique:${consecutiveSameHorrorTechnique}`);
  }
  if (signals.length > 0) return { severity: "moderate", severitySignals: signals };

  const activeCooldowns = Object.entries(fatigue.cooldownPeriods)
    .filter(([, remaining]) => remaining > 0)
    .map(([pattern, remaining]) => `cooldown:${pattern}:${remaining}`);
  if (activeCooldowns.length > 0) {
    return { severity: "mild", severitySignals: activeCooldowns };
  }

  return { severity: "none", severitySignals: [] };
}

/**
 * Detect ensemble climax opportunity: multiple open arcs converging on their
 * optimal closure window, critical relationship states, and escalated
 * expectations all peaking together. Advisory signal for the judge — does not
 * force a climax or block alternatives.
 */
export function buildClimaxOpportunity(
  ensemble: EnsembleDiagnosticContext,
  closure: ClosureDiagnosticContext,
  serialState: SerialDiagnosticState,
  chapterNumber: number,
): EnsembleClimaxOpportunity {
  const convergentArcs = closure.openArcs
    .filter((arc) => {
      const optimal = arc.expectedClosureWindow?.optimal ?? null;
      return (
        optimal !== null &&
        optimal >= chapterNumber &&
        optimal <= chapterNumber + CLIMAX_LOOKAHEAD
      );
    })
    .map((arc) => arc.arcId);

  const criticalRelationships = ensemble.relationships
    .filter((rel) => rel.state !== null && CRITICAL_RELATIONSHIP_STATES.has(rel.state))
    .map((rel) => rel.relationshipId);

  const convergentExpectations = serialState.expectations
    .filter((exp) => exp.status === "escalated")
    .map((exp) => exp.expectationId);

  const conditionsMet = [
    convergentArcs.length >= 2,
    criticalRelationships.length >= 2,
    convergentExpectations.length >= 2,
  ].filter(Boolean).length;

  const detected = conditionsMet >= 2;

  const optimalChapters = closure.openArcs
    .filter((arc) => convergentArcs.includes(arc.arcId))
    .map((arc) => arc.expectedClosureWindow?.optimal ?? null)
    .filter((opt): opt is number => opt !== null)
    .sort((a, b) => a - b);

  const estimatedWindow =
    optimalChapters.length > 0
      ? {
          earliest: optimalChapters[0],
          optimal: optimalChapters[Math.floor(optimalChapters.length / 2)],
        }
      : null;

  const sourceRefs = new Set<string>();
  for (const arc of closure.openArcs) {
    if (convergentArcs.includes(arc.arcId)) sourceRefs.add(arc.sourceRef);
  }
  for (const rel of ensemble.relationships) {
    if (criticalRelationships.includes(rel.relationshipId)) sourceRefs.add(rel.sourceRef);
  }
  for (const exp of serialState.expectations) {
    if (convergentExpectations.includes(exp.expectationId)) {
      for (const ref of exp.sourceRefs) sourceRefs.add(ref);
    }
  }

  const noSignals =
    convergentArcs.length === 0 &&
    criticalRelationships.length === 0 &&
    convergentExpectations.length === 0;

  return {
    detected,
    convergentArcs,
    criticalRelationships,
    convergentExpectations,
    estimatedWindow,
    sourceRefs: [...sourceRefs].sort(),
    emptyReason: !detected && noSignals ? "no_convergence_signals" : null,
  };
}
