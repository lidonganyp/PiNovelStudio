/**
 * 回放必须从真实 quality-trace 结构统计模型调用与生产身份。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractReplayModelCalls,
  extractReplayRecoveryAttempts,
  extractReplayReleaseIdentity,
  summarizeReplayModelCalls,
  evaluateProductionLikeEvidence,
} from "../dist-test/v2/core/eval-replay-trace-stats.js";

test("count: 真实 v2_final_selected evidence.modelCalls → 3/gemini31=3/raw=1/amplified=2", () => {
  const stats = summarizeReplayModelCalls(
    extractReplayModelCalls({
      modelCalls: [],
      gates: [
        {
          stage: "v2_final_selected",
          evidence: {
            modelCalls: [
              {
                route: "v2_rawstage2",
                requestedRoute: "v2_rawstage2_gemini31",
                actualProvider: "gemini31",
                expectedProvider: "gemini31",
              },
              {
                route: "v2_amplified_gemini31",
                requestedRoute: "v2_amplified_gemini31",
                actualProvider: "gemini31",
                expectedProvider: "gemini31",
              },
              {
                route: "v2_amplified_gemini31",
                requestedRoute: "v2_amplified_gemini31",
                actualProvider: "gemini31",
                expectedProvider: "gemini31",
              },
            ],
            releaseGovernance: {
              devMode: false,
              releaseId: "rel-prod-116",
              environmentFingerprint: "fp",
              approvalRef: "apr",
              behaviorIdentity: {
                bundleId: "bundle",
                modelVersion: "gemini-3.1-pro-preview",
              },
            },
          },
        },
      ],
    }),
  );
  assert.equal(stats.modelCalls, 3);
  assert.equal(stats.byProvider.gemini31, 3);
  assert.equal(stats.byRequestedRoute.v2_rawstage2_gemini31, 1);
  assert.equal(stats.byRequestedRoute.v2_amplified_gemini31, 2);
  assert.equal(stats.unauthorizedCrossModelCount, 0);
});

test("count: tokenUsage in/out 汇总为 tokenCost，recoveryAttempts 不丢", () => {
  const trace = {
    modelCalls: [],
    recoveryAttempts: [{ reason: "timeout" }],
    gates: [
      {
        stage: "v2_final_selected",
        evidence: {
          modelCalls: [
            {
              requestedRoute: "v2_rawstage2_gemini31",
              actualProvider: "gemini31",
              tokenUsage: { in: 1602, out: 3746 },
            },
            {
              requestedRoute: "v2_amplified_gemini31",
              actualProvider: "gemini31",
              tokenUsage: { in: 1719, out: 4705 },
            },
          ],
        },
      },
    ],
  };
  const stats = summarizeReplayModelCalls(
    extractReplayModelCalls(trace),
    extractReplayRecoveryAttempts(trace),
  );
  assert.equal(stats.modelCalls, 2);
  assert.equal(stats.tokenIn, 3321);
  assert.equal(stats.tokenOut, 8451);
  assert.equal(stats.tokenCost, 11772);
  assert.equal(stats.recoveryAttempts, 1);
});

test("identity: releaseGovernance.devMode=true 必须被生产等价检查拒绝", () => {
  const identity = extractReplayReleaseIdentity({
    gates: [
      {
        stage: "v2_final_selected",
        evidence: {
          releaseGovernance: {
            devMode: true,
            releaseId: null,
            environmentFingerprint: null,
            approvalRef: null,
            behaviorIdentity: { bundleId: null, modelVersion: null },
          },
        },
      },
    ],
  });
  const check = evaluateProductionLikeEvidence({
    modelCalls: 0,
    stats: {
      modelCalls: 0,
      tokenIn: 0,
      tokenOut: 0,
      tokenCost: 0,
      recoveryAttempts: 0,
      byProvider: {},
      byRequestedRoute: {},
      unauthorizedCrossModelCount: 0,
    },
    identity,
    expectedRelease: {
      releaseId: "rel-prod-116",
      environmentFingerprint: "fp",
      approvalRef: "apr",
      bundleId: "bundle",
      modelVersion: "gemini-3.1-pro-preview",
    },
    modelRoute: "v2_rawstage2_gemini31",
  });
  assert.equal(check.ok, false);
  assert.ok(check.reasons.some((r) => r.includes("devMode")));
  assert.ok(check.reasons.some((r) => r.includes("modelCalls")));
});

test("identity: 候选 draft 无 approvalRef 时不得要求审批", () => {
  const check = evaluateProductionLikeEvidence({
    modelCalls: 2,
    stats: {
      modelCalls: 2,
      tokenIn: 1,
      tokenOut: 1,
      tokenCost: 2,
      recoveryAttempts: 0,
      byProvider: { gemini31: 2 },
      byRequestedRoute: { v2_rawstage2_gemini31: 1, v2_amplified_gemini31: 1 },
      unauthorizedCrossModelCount: 0,
    },
    identity: {
      devMode: false,
      releaseId: "rel-prod-118",
      environmentFingerprint: "fp",
      approvalRef: null,
      bundleId: "bundle",
      modelVersion: "gemini-3.1-pro-preview",
    },
    expectedRelease: {
      releaseId: "rel-prod-118",
      environmentFingerprint: "fp",
      approvalRef: "",
      bundleId: "bundle",
      modelVersion: "gemini-3.1-pro-preview",
    },
    modelRoute: "v2_rawstage2_gemini31",
  });
  assert.equal(check.ok, true, JSON.stringify(check.reasons));
});
