/**
 * PiNovelStudio — replay-runner hook causality (HC-001/HC-002) and local
 * repair evidence builder tests.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildGetDraftDialogueCandidateRules,
  buildGetDraftLocalRepairEvidence,
} from "../dist-eval/eval/replay-runner.js";

function makeEvent(overrides) {
  const base = {
    eventId: overrides.eventId || "E1",
    sceneType: overrides.sceneType || "general",
    progression: {
      evidence: {
        informationDelta: { score: 0, hits: [] },
        riskDelta: { score: 0, hits: [] },
        ...overrides.progressionEvidence,
      },
    },
    craftGate: overrides.craftGate || { metrics: {} },
  };
  if (overrides.eventLocation) {
    base.eventLocation = overrides.eventLocation;
  }
  return base;
}

describe("replay-runner HC trigger detection", () => {
  it("HC-001 triggers when last event has no information overlap with earlier events", () => {
    const trace = {
      events: [
        makeEvent({
          eventId: "E1",
          progressionEvidence: { informationDelta: { score: 25, hits: ["照片", "门牌"] } },
        }),
        makeEvent({
          eventId: "E2",
          progressionEvidence: { informationDelta: { score: 25, hits: ["影子"] } },
        }),
        // last event introduces an entirely new fact never seeded earlier
        makeEvent({
          eventId: "E3",
          progressionEvidence: {
            informationDelta: { score: 25, hits: ["全新元素X"] },
            riskDelta: { score: 10, hits: ["风险"] },
          },
        }),
      ],
    };
    const rules = buildGetDraftDialogueCandidateRules(trace);
    const hc001 = rules.find((rule) => rule.id === "HC-001");
    assert.ok(hc001, "HC-001 should trigger when chapter end has no chain reuse");
    assert.deepEqual(hc001.triggeredEventIds, ["E3"]);
    assert.equal(hc001.axis, "hook_causality");
    assert.equal(hc001.patchUnit, "chapter_end");
    assert.equal(hc001.runtimeDefaultEnabled, false);
  });

  it("HC-001 does NOT trigger when last event reuses earlier information", () => {
    const trace = {
      events: [
        makeEvent({
          eventId: "E1",
          progressionEvidence: { informationDelta: { score: 25, hits: ["照片", "门牌"] } },
        }),
        makeEvent({
          eventId: "E2",
          progressionEvidence: {
            informationDelta: { score: 25, hits: ["照片", "影子"] },
            riskDelta: { score: 10, hits: ["威胁"] },
          },
        }),
      ],
    };
    const rules = buildGetDraftDialogueCandidateRules(trace);
    assert.equal(rules.find((rule) => rule.id === "HC-001"), undefined);
  });

  it("HC-002 triggers when last event has zero information AND zero risk delta", () => {
    const trace = {
      events: [
        makeEvent({
          eventId: "E1",
          progressionEvidence: { informationDelta: { score: 25, hits: ["照片"] } },
        }),
        makeEvent({
          eventId: "E2",
          progressionEvidence: {
            informationDelta: { score: 0, hits: [] },
            riskDelta: { score: 0, hits: [] },
          },
        }),
      ],
    };
    const rules = buildGetDraftDialogueCandidateRules(trace);
    const hc002 = rules.find((rule) => rule.id === "HC-002");
    assert.ok(hc002, "HC-002 should trigger when chapter end has no movement");
    assert.deepEqual(hc002.triggeredEventIds, ["E2"]);
    assert.equal(hc002.patchUnit, "chapter_end");
  });

  it("HC-002 does NOT trigger when chapter end has either info or risk movement", () => {
    const trace = {
      events: [
        makeEvent({
          eventId: "E1",
          progressionEvidence: {
            informationDelta: { score: 0, hits: [] },
            riskDelta: { score: 20, hits: ["威胁"] },
          },
        }),
      ],
    };
    const rules = buildGetDraftDialogueCandidateRules(trace);
    assert.equal(rules.find((rule) => rule.id === "HC-002"), undefined);
  });

  it("returns empty when trace is null or has no events", () => {
    assert.deepEqual(buildGetDraftDialogueCandidateRules(null), []);
    assert.deepEqual(buildGetDraftDialogueCandidateRules({ events: [] }), []);
  });
});

describe("replay-runner local repair evidence builder", () => {
  it("emits LC-001 trigger when adjacent events differ in location without setup support", () => {
    const trace = {
      events: [
        makeEvent({ eventId: "E1", eventLocation: "论坛" }),
        makeEvent({
          eventId: "E2",
          eventLocation: "门外",
          progressionEvidence: { setupSupportEvidence: { hits: [] } },
        }),
      ],
    };
    const evidence = buildGetDraftLocalRepairEvidence(trace);
    const lc = evidence.triggers.find((trigger) => trigger.ruleId === "LC-001");
    assert.ok(lc);
    assert.equal(lc.observationMode, false);
    assert.deepEqual(lc.triggeredEventIds, ["E2"]);
  });

  it("emits AA-001 in observation mode when craft gate flags ai phrasing", () => {
    const trace = {
      events: [
        makeEvent({
          eventId: "E1",
          craftGate: { metrics: { aiPhrasing: 1, dialoguePropulsion: 80, contractCoverage: 80 } },
        }),
      ],
    };
    const evidence = buildGetDraftLocalRepairEvidence(trace);
    const aa = evidence.triggers.find((trigger) => trigger.ruleId === "AA-001");
    assert.ok(aa);
    assert.equal(aa.observationMode, true);
    assert.deepEqual(aa.triggeredEventIds, ["E1"]);
  });

  it("emits AA-002 when contract coverage is high but dialogue propulsion is low", () => {
    const trace = {
      events: [
        makeEvent({
          eventId: "E1",
          craftGate: {
            metrics: { aiPhrasing: 0, contractCoverage: 95, dialoguePropulsion: 30 },
          },
        }),
      ],
    };
    const evidence = buildGetDraftLocalRepairEvidence(trace);
    const aa = evidence.triggers.find((trigger) => trigger.ruleId === "AA-002");
    assert.ok(aa);
    assert.equal(aa.observationMode, true);
  });

  it("returns no triggers when trace is null", () => {
    const evidence = buildGetDraftLocalRepairEvidence(null);
    assert.equal(evidence.triggers.length, 0);
    assert.equal(evidence.runtimeDefaultEnabled, false);
  });
});

describe("repairObservations persist into trace and flow to localRepairEvidence", () => {
  it("reads persisted repairObservations from trace and converts to localRepairEvidence.triggers", () => {
    // Simulate a trace where stage5/stage8 wrote repairObservations during
    // generation. This is the authoritative signal that buildGetDraftLocalRepairEvidence
    // must consume, proving the observation field persisted end-to-end.
    const trace = {
      events: [
        {
          eventId: "E1",
          sceneType: "general",
          progression: { evidence: {} },
          craftGate: { metrics: { aiPhrasing: 0, contractCoverage: 80, dialoguePropulsion: 80 } },
        },
      ],
      repairObservations: [
        { ruleId: "LC-001", observationMode: false, patchAccepted: true, rollback: false },
        { ruleId: "AA-002", observationMode: true, patchAccepted: false, rollback: true },
      ],
    };

    const evidence = buildGetDraftLocalRepairEvidence(trace);
    const lc001 = evidence.triggers.find((trigger) => trigger.ruleId === "LC-001");
    const aa002 = evidence.triggers.find((trigger) => trigger.ruleId === "AA-002");
    assert.ok(lc001, "LC-001 should trigger from persisted repairObservations");
    assert.equal(lc001.observationMode, false);
    assert.equal(lc001.axis, "location_continuity");
    assert.ok(aa002, "AA-002 should trigger from persisted repairObservations");
    assert.equal(aa002.observationMode, true);
    assert.equal(aa002.axis, "anti_ai_span_repair");
  });

  it("deduplicates and ignores unknown rule IDs in repairObservations", () => {
    const trace = {
      events: [],
      repairObservations: [
        { ruleId: "LC-001", observationMode: false, patchAccepted: true, rollback: false },
        { ruleId: "LC-001", observationMode: false, patchAccepted: false, rollback: true },
        { ruleId: "UNKNOWN-RULE", observationMode: true, patchAccepted: true, rollback: false },
      ],
    };

    const evidence = buildGetDraftLocalRepairEvidence(trace);
    const triggers = evidence.triggers.filter((trigger) => trigger.ruleId === "LC-001");
    assert.equal(triggers.length, 1, "LC-001 should be deduplicated to one trigger per chapter");
    assert.equal(
      evidence.triggers.find((trigger) => trigger.ruleId === "UNKNOWN-RULE"),
      undefined,
      "unknown rule IDs should be silently ignored"
    );
    assert.equal(evidence.runtimeDefaultEnabled, false);
  });

  it("returns empty triggers when trace has no repairObservations and events are empty", () => {
    const trace = { events: [], repairObservations: undefined };
    const evidence = buildGetDraftLocalRepairEvidence(trace);
    assert.equal(evidence.triggers.length, 0);
  });

  it("produces triggers from repairObservations even when events array is absent", () => {
    // A trace with ONLY repairObservations (edge case: stage5/8 ran but
    // no stage2 events were recorded).
    const trace = {
      repairObservations: [
        { ruleId: "AA-001", observationMode: true, patchAccepted: true, rollback: false },
      ],
    };
    const evidence = buildGetDraftLocalRepairEvidence(trace);
    const aa001 = evidence.triggers.find((trigger) => trigger.ruleId === "AA-001");
    assert.ok(aa001, "AA-001 should trigger from repairObservations even without events");
    assert.equal(aa001.observationMode, true);
  });
});
