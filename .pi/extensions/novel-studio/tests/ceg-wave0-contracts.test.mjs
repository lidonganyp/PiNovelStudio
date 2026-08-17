/**
 * CEG-0.1 / CEG-0.4 / CEG-0.5 — 契约冻结、生产 A 基线守护、FailureEnvelope gate。
 *
 * Wave 0 不改变生产行为。本文件必须通过：证明契约已冻结，且当前生产常量未被顺手改动。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AUTHORITY_CLASS_TO_SLOT_AUTHORITY,
  AUTHORITY_CLASS_TO_TRUST_CLASS,
  CEG_CONTENT_HASH_KINDS,
  CEG_CONTRACT_SCHEMA_VERSION,
  CEG_FAILURE_GATES,
  CEG_FAILURE_GATE_DEFAULTS,
  CEG_PRODUCTION_A_BASELINE,
  CONTEXT_DELIVERY_ACTIONS,
  EVIDENCE_SELECTION_STAGES,
  LIFECYCLE_ELIGIBILITY,
  MEMORY_TO_EVIDENCE_EPISTEMIC,
  MEMORY_TYPE_DEFAULT_ROLE,
  REUSED_EXISTING_TYPES,
  TOOL_RESULT_KIND_TO_OUTCOME_STATUS,
  CEG_FAILURE_GATE_EXISTING_ALIASES,
  isLegacyQuantityContextHash,
  retrievalOutcomeStatusFromToolResult,
  createCegFailure,
} from "../dist-test/v2/core/evidence-governance-contracts.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = resolve(__dirname, "..");

function readSrc(relPath) {
  return readFileSync(resolve(EXT_ROOT, relPath), "utf8");
}

test("CEG-0.1: 契约 schema 与五类协议已冻结", () => {
  assert.equal(CEG_CONTRACT_SCHEMA_VERSION, 1);
  assert.deepEqual([...EVIDENCE_SELECTION_STAGES], [
    "eligibility",
    "authority_partition",
    "conflict_isolation",
    "required_evidence_reservation",
    "match_quality_within_authority_tier",
    "temporal_validity_or_recency",
    "diversity",
    "token_utility",
  ]);
  assert.deepEqual([...CONTEXT_DELIVERY_ACTIONS], [
    "discovered",
    "eligible",
    "rejected",
    "selected",
    "rendered_preloaded",
    "retrieved_on_demand",
    "delivered_to_model",
    "dropped",
  ]);
  assert.deepEqual([...CEG_CONTENT_HASH_KINDS], [
    "knowledgeSnapshotHash",
    "contextPackageHash",
    "modelInputHash",
  ]);
  assert.ok(REUSED_EXISTING_TYPES.includes("MemoryRecord.authorityClass"));
  assert.ok(REUSED_EXISTING_TYPES.includes("ContextPackage / ContextSlotItem / contextHash"));
  assert.ok(REUSED_EXISTING_TYPES.includes("TrustedToolResult.contentHash / evidenceRefs / contentTrust"));
  assert.ok(REUSED_EXISTING_TYPES.includes("AuditEvent + TrustAuditEvent"));
  assert.ok(
    REUSED_EXISTING_TYPES.includes("UnifiedProductionFailureEnvelope.stage / gate / failureClass"),
    "复用权威必须是 UnifiedProductionFailureEnvelope.failureClass，不是兼容 severity",
  );
  assert.equal(
    REUSED_EXISTING_TYPES.includes("FailureEnvelope.stage / gate / severity"),
    false,
    "禁止把兼容字段 severity 冻成复用权威",
  );
});

test("CEG-0.1: MemoryRecord / trust / 生命周期映射完整且无平行枚举", () => {
  assert.deepEqual(MEMORY_TO_EVIDENCE_EPISTEMIC, {
    declared: "confirmed",
    confirmed: "confirmed",
    derived: "derived",
    planned: "not_evidence",
    hypothesis: "advisory",
    disputed: "conflicted",
    superseded: "not_evidence",
  });
  assert.equal(AUTHORITY_CLASS_TO_TRUST_CLASS.author_declaration, "author_authority");
  assert.equal(AUTHORITY_CLASS_TO_TRUST_CLASS.final_text_explicit, "committed_state");
  assert.equal(AUTHORITY_CLASS_TO_TRUST_CLASS.system_derived, "retrieved_reference");
  assert.equal(AUTHORITY_CLASS_TO_SLOT_AUTHORITY.author_declaration, "hard_constraint");
  assert.equal(AUTHORITY_CLASS_TO_SLOT_AUTHORITY.system_derived, "reference_only");
  assert.equal(MEMORY_TYPE_DEFAULT_ROLE.canon, "hard_fact_candidate");
  assert.equal(MEMORY_TYPE_DEFAULT_ROLE.pattern, "advisory");
  assert.equal(MEMORY_TYPE_DEFAULT_ROLE.plan, "not_retrievable_as_fact");
  assert.equal(LIFECYCLE_ELIGIBILITY.active, "eligible");
  assert.equal(LIFECYCLE_ELIGIBILITY.expired, "reject");
  assert.equal(LIFECYCLE_ELIGIBILITY.conflicted, "reject");
  assert.equal(TOOL_RESULT_KIND_TO_OUTCOME_STATUS.no_match, "no_match");
  assert.equal(TOOL_RESULT_KIND_TO_OUTCOME_STATUS.ranked_evidence, "match");
  assert.equal(TOOL_RESULT_KIND_TO_OUTCOME_STATUS.canon_entries, "match");
  assert.equal(retrievalOutcomeStatusFromToolResult({ resultKind: "no_match" }), "no_match");
  assert.equal(retrievalOutcomeStatusFromToolResult({ resultKind: "ranked_evidence", truncated: true }), "truncated");
  assert.equal(retrievalOutcomeStatusFromToolResult({ ok: false, error: { code: "hash_mismatch" } }), "retrieval_error");
  assert.notEqual(
    retrievalOutcomeStatusFromToolResult({ resultKind: "no_match" }),
    "retrieval_error",
    "no_match 不得承担 retrieval_error",
  );
});

test("CEG-0.5: 七个 FailureEnvelope gate 使用生产 FailureClass，不写 hard_block", () => {
  assert.deepEqual([...CEG_FAILURE_GATES], [
    "snapshot_build",
    "snapshot_hash_mismatch",
    "evidence_conflict",
    "retrieval_error",
    "retrieval_budget_exhausted",
    "must_verify_coverage",
    "context_package_validation",
  ]);
  assert.equal(CEG_FAILURE_GATE_DEFAULTS.snapshot_build.failureClass, "preflight");
  assert.equal(CEG_FAILURE_GATE_DEFAULTS.snapshot_hash_mismatch.failureClass, "blocked");
  assert.equal(CEG_FAILURE_GATE_DEFAULTS.evidence_conflict.failureClass, "blocked");
  assert.equal(CEG_FAILURE_GATE_DEFAULTS.retrieval_error.failureClass, "recoverable");
  assert.equal(CEG_FAILURE_GATE_DEFAULTS.retrieval_budget_exhausted.failureClass, "blocked");
  assert.equal(CEG_FAILURE_GATE_DEFAULTS.must_verify_coverage.failureClass, "blocked");
  assert.equal(CEG_FAILURE_GATE_DEFAULTS.context_package_validation.failureClass, "blocked");
  assert.equal(CEG_FAILURE_GATE_EXISTING_ALIASES.must_verify_coverage, "unverified_high_risk_facts");
  const serialized = JSON.stringify(CEG_FAILURE_GATE_DEFAULTS);
  assert.equal(serialized.includes("hard_block"), false);
  assert.equal(serialized.includes("\"hard\""), false);
  for (const gate of CEG_FAILURE_GATES) {
    const defaults = CEG_FAILURE_GATE_DEFAULTS[gate];
    assert.equal(Object.hasOwn(defaults, "failureClass"), true, `${gate} 必须声明 failureClass`);
    assert.equal(Object.hasOwn(defaults, "severity"), false, `${gate} 不得把兼容 severity 冻成默认权威`);
  }
  const budget = createCegFailure("retrieval_budget_exhausted", "预算耗尽");
  assert.equal(budget.failureClass, "blocked");
  assert.equal(budget.gate, "retrieval_budget_exhausted");
});

test("CEG-0.4: 生产 A 基线检索参数与源码一致，不得顺手调整", () => {
  const historical = readSrc("v2/core/model-prompt-adapter.ts");
  assert.match(historical, /canon 4×2400、character 6×1800/);
  assert.match(historical, /canonCfg\.maxEntries \?\? 4/);
  assert.match(historical, /canonCfg\.maxChars \?\? 2400/);
  assert.match(historical, /characterCfg\.maxEntries \?\? 6/);
  assert.match(historical, /characterCfg\.maxChars \?\? 1800/);
  assert.match(historical, /patternCfg\.maxEntries \?\? 4/);
  assert.match(historical, /patternCfg\.maxChars \?\? 1000/);

  const compiler = readSrc("v2/core/context-compiler.ts");
  assert.match(compiler, /Math\.min\(48, Math\.max\(24, Math\.floor\(safeTotal \/ 4\)\)\)/);

  const retrieval = readSrc("v2/core/context-retrieval.ts");
  assert.match(retrieval, /item\.score >= 10/);
  assert.match(retrieval, /Math\.floor\(itemLimit \/ 8\)/);
  assert.match(retrieval, /score \+= 50/);
  assert.match(retrieval, /score \+= 120/);

  const evidencePlan = readSrc("novelos/agent/evidence-plan.ts");
  assert.match(evidencePlan, /mustVerify\.length > 0 \? 4 : 2/);
  assert.match(evidencePlan, /"search_narrative_evidence"/);
  assert.match(evidencePlan, /"query_voice_evidence"/);

  const tools = readSrc("novelos/tools/narrative-tools.ts");
  for (const name of CEG_PRODUCTION_A_BASELINE.dedicatedTools) {
    assert.match(tools, new RegExp(`"${name}"`));
  }
  assert.equal(CEG_PRODUCTION_A_BASELINE.dedicatedTools.length, 9);
  assert.equal(CEG_PRODUCTION_A_BASELINE.historicalContinuity.maxEntries, 4);
  assert.equal(CEG_PRODUCTION_A_BASELINE.historicalCharacterState.maxEntries, 6);
  assert.equal(CEG_PRODUCTION_A_BASELINE.recentPatternMemory.maxEntries, 4);
  assert.equal(CEG_PRODUCTION_A_BASELINE.retrievalCallLimit.withMustVerify, 4);
  assert.equal(CEG_PRODUCTION_A_BASELINE.retrievalCallLimit.withoutMustVerify, 2);
  assert.equal(CEG_PRODUCTION_A_BASELINE.productionRendererProfile, "gemini_writer_v2");
  assert.equal(CEG_PRODUCTION_A_BASELINE.layeredRendererProfile, "gemini_writer_v2_layered");

  const evidencePlanSrc = readSrc("novelos/agent/evidence-plan.ts");
  assert.match(evidencePlanSrc, /slice\(0, 8\)/);
  assert.match(evidencePlanSrc, /s\.length > 80 \? s\.slice\(0, 80\)/);
  assert.match(evidencePlanSrc, /总数 ≤ 12 条/);
  const adapterSrc = readSrc("v2/core/model-prompt-adapter.ts");
  assert.match(adapterSrc, /let remainingBudget = 3200;/);
  assert.match(adapterSrc, /Math\.min\(900, remainingBudget\)/);
  const retrievalSrc = readSrc("v2/core/context-retrieval.ts");
  assert.match(retrievalSrc, /summarize\(entry\)\.slice\(0, 160\)/);
  const searchSrc = readSrc("novelos/agent/narrative-search-service.ts");
  assert.match(searchSrc, /maxChapters = 10/);
  assert.match(searchSrc, /maxResults = 10/);
  const entrySrc = readSrc("v2/core/unified-entry.ts");
  assert.match(entrySrc, /PINOVEL_CONTEXT_WINDOW_TOKENS/);
  assert.equal(CEG_PRODUCTION_A_BASELINE.promptItemSummaryChars, 160);
  assert.equal(CEG_PRODUCTION_A_BASELINE.mustVerifyMaxItems, 8);
  assert.equal(CEG_PRODUCTION_A_BASELINE.knownSummary.maxItems, 12);
  assert.equal(CEG_PRODUCTION_A_BASELINE.contextSafetyTokens.modelWindow, 128000);
  assert.equal(CEG_PRODUCTION_A_BASELINE.searchChapterSpan.maxResults, 10);
});

test("CEG-0.4: 数量签名识别器只标记旧 hash，不把内容 hash 误判为数量签名", () => {
  assert.equal(isLegacyQuantityContextHash("f2-l1-c3-w1-s2"), true);
  assert.equal(isLegacyQuantityContextHash("a43509f0c1d2e3f4"), false);
  assert.equal(isLegacyQuantityContextHash(""), false);
});
