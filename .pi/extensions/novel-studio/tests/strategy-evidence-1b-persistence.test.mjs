/**
 * STRATEGY-EVIDENCE-1B: evidence 持久化、撤销与隔离（append/store/import + 严格 human 计数）
 *
 * 验收口径（docs/remaining-development-dispatch-plan-20260715.md §3 P0-D STRATEGY-EVIDENCE-1B）：
 * - append-only；重复 run 去重；撤销恢复计数
 * - contested/invalid/fallback/quarantined 不计 eligible
 * - 旧模型不污染新模型
 * - 只有 validated_human_proxy + humanEquivalent=true 才可计 human
 * - 不同 strategyId/modelVersion 不得汇总准入
 * - 普通机器审阅不得冒充
 * - 负面/污染样本不得提升策略
 * - 写 evidence 不得自动 active
 * - 冲突进入 quarantine，保持 candidate，不影响 raw fallback
 *
 * 边界（READY_LOCAL）：
 * - 不调用真实模型、不保存章节、不提交长期状态
 * - 不修改 alpha/beta / 不改生产策略信誉
 * - 不是 gate；不阻断正文生成
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  STRATEGY_EVIDENCE_SCHEMA_ID,
  STRATEGY_EVIDENCE_SCHEMA_VERSION,
  appendEvidence,
  importEligiblePairAsEvidence,
  compileAdmissionDecisions,
  revokeEvidence,
  detectEvidenceConflicts,
} from "../dist/v2/core/strategy-evidence-dataset.js";
import { createStrategyEvidenceStore } from "../dist-eval/v2/core/strategy-evidence-store.js";

// ============================================================================
// Fixture builders
// ============================================================================

function makeRecord(overrides = {}) {
  return {
    evidenceId: "ev-001",
    strategyId: "strategy-A",
    modelVersion: "glm-5.2",
    orchestratorRunId: "run-001",
    sourceChapter: "ch17",
    outcome: "win",
    source: "judge",
    weight: 1.0,
    timestamp: "2026-07-15T10:00:00Z",
    ...overrides,
  };
}

function makeArtifact(records, overrides = {}) {
  return {
    schemaId: STRATEGY_EVIDENCE_SCHEMA_ID,
    schemaVersion: STRATEGY_EVIDENCE_SCHEMA_VERSION,
    workspaceId: "xinmo",
    records,
    ...overrides,
  };
}

function makeEligiblePair(overrides = {}) {
  return {
    pairId: "pair-001",
    sampleId: "pair-001",
    rawCandidate: {
      candidateId: "raw-001",
      candidateKind: "raw",
      sourcePath: "/cases/case-04/raw-001.md",
      sourceSha256: "abc123",
      orchestratorRunId: "run-001",
      caseId: "case-04",
      layer: "B4",
    },
    editorialCandidate: {
      candidateId: "ed-001",
      candidateKind: "editorial",
      sourcePath: "/cases/case-04/ed-001.md",
      sourceSha256: "def456",
      orchestratorRunId: "run-001",
      caseId: "case-04",
      layer: "B4",
    },
    outcomeType: "editorial_win",
    judgeWinner: "editorial",
    runProvenance: {
      orchestratorRunId: "run-001",
      caseId: "case-04",
      layer: "B4",
      modelVersion: "glm-5.2",
      seed: 0,
    },
    ...overrides,
  };
}

function makeValidVerdict(overrides = {}) {
  return {
    schemaId: "pinovel.human-proxy-provenance",
    verdictId: "case-04::reader_payoff_strengthen",
    preference: "editorial",
    winningSpans: [
      {
        side: "B",
        excerpt: "他终于开口。",
        dimension: "文学性",
        explanation: "落点更准",
      },
    ],
    losingSpans: [],
    rationale: "B 落点更准",
    anonymousMapping: { A: "raw", B: "editorial" },
    provenance: {
      sourceArtifactPath: "/reports/case-04-review.json",
      sourceArtifactHash: "hash-001",
      orchestratorRunId: "run-001",
      caseId: "case-04",
      workspaceId: "xinmo",
      sourceChapter: "ch19",
    },
    modelVersion: "glm-5.2",
    strategyId: "reader_payoff_strengthen",
    sourceChapter: "ch19",
    reviewerType: "validated_human_proxy",
    reviewerModel: "gpt5.6-sol",
    humanEquivalent: true,
    confidence: "clear",
    timestamp: "2026-07-15T10:00:00Z",
    ...overrides,
  };
}

function makeImportContext() {
  return { workspaceId: "xinmo", timestamp: "2026-07-15T10:00:00Z" };
}

// ============================================================================
// 1. appendEvidence：实际 append 操作（append-only，返回新 artifact）
// ============================================================================

test("appendEvidence 是函数", () => {
  assert.equal(typeof appendEvidence, "function");
});

test("appendEvidence：append 成功返回新 artifact，appendedCount 正确", () => {
  const base = makeArtifact([makeRecord({ evidenceId: "ev-1" })]);
  const newRecords = [
    makeRecord({ evidenceId: "ev-2", orchestratorRunId: "run-2" }),
  ];
  const result = appendEvidence(base, newRecords);
  assert.equal(result.ok, true);
  assert.equal(result.artifact.records.length, 2);
  assert.equal(result.appendedCount, 1);
  assert.equal(result.artifact.records[0].evidenceId, "ev-1");
  assert.equal(result.artifact.records[1].evidenceId, "ev-2");
});

test("appendEvidence：原 artifact 不变（不可变）", () => {
  const base = makeArtifact([makeRecord({ evidenceId: "ev-1" })]);
  const snapshot = JSON.parse(JSON.stringify(base));
  appendEvidence(base, [
    makeRecord({ evidenceId: "ev-2", orchestratorRunId: "run-2" }),
  ]);
  assert.deepEqual(base, snapshot);
});

test("appendEvidence：拒绝重复 evidenceId（newRecords 与历史冲突）", () => {
  const base = makeArtifact([makeRecord({ evidenceId: "ev-1" })]);
  const result = appendEvidence(base, [
    makeRecord({ evidenceId: "ev-1", orchestratorRunId: "run-2" }),
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "duplicate_evidence_id");
});

test("appendEvidence：拒绝 newRecords 内部重复 evidenceId", () => {
  const base = makeArtifact([makeRecord({ evidenceId: "ev-1" })]);
  const result = appendEvidence(base, [
    makeRecord({ evidenceId: "ev-2", orchestratorRunId: "run-2" }),
    makeRecord({ evidenceId: "ev-2", orchestratorRunId: "run-3" }),
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "duplicate_evidence_id");
});

test("appendEvidence：拒绝非法新 record（缺必填字段）", () => {
  const base = makeArtifact([makeRecord({ evidenceId: "ev-1" })]);
  const bad = { ...makeRecord({ evidenceId: "ev-2" }) };
  delete bad.strategyId;
  const result = appendEvidence(base, [bad]);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_field");
});

test("appendEvidence：空 newRecords → appendedCount=0，records 不变", () => {
  const base = makeArtifact([makeRecord({ evidenceId: "ev-1" })]);
  const result = appendEvidence(base, []);
  assert.equal(result.ok, true);
  assert.equal(result.appendedCount, 0);
  assert.equal(result.artifact.records.length, 1);
});

test("appendEvidence：拒绝 workspaceId 与 base 不同（在新 record 无法改 workspaceId，但 artifact 级别校验）", () => {
  const base = makeArtifact([makeRecord({ evidenceId: "ev-1" })], {
    workspaceId: "ws-A",
  });
  // appendEvidence 应继承 base.workspaceId；构造的 next 不应改变 workspaceId
  const result = appendEvidence(base, [
    makeRecord({ evidenceId: "ev-2", orchestratorRunId: "run-2" }),
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.artifact.workspaceId, "ws-A");
});

// ============================================================================
// 2. createStrategyEvidenceStore：持久化 load/save/append/round-trip/atomic
// ============================================================================

test("createStrategyEvidenceStore 是函数", () => {
  assert.equal(typeof createStrategyEvidenceStore, "function");
});

test("store：文件不存在时 load 返回空数组（不抛异常）", () => {
  const dir = mkdtempSync(join(tmpdir(), "se1b-load-"));
  const store = createStrategyEvidenceStore({
    filePath: join(dir, "evidence.json"),
    workspaceId: "xinmo",
  });
  assert.deepEqual(store.load(), []);
  rmSync(dir, { recursive: true, force: true });
});

test("store：save 后 load round-trip 一致", () => {
  const dir = mkdtempSync(join(tmpdir(), "se1b-roundtrip-"));
  const filePath = join(dir, "evidence.json");
  const store = createStrategyEvidenceStore({ filePath, workspaceId: "xinmo" });
  const records = [
    makeRecord({ evidenceId: "ev-1" }),
    makeRecord({ evidenceId: "ev-2", orchestratorRunId: "run-2" }),
  ];
  store.save(records);
  assert.ok(existsSync(filePath));
  const loaded = store.load();
  assert.deepEqual(loaded, records);
  rmSync(dir, { recursive: true, force: true });
});

test("store：append 持久化且 append-only（历史保留）", () => {
  const dir = mkdtempSync(join(tmpdir(), "se1b-append-"));
  const filePath = join(dir, "evidence.json");
  const store = createStrategyEvidenceStore({ filePath, workspaceId: "xinmo" });
  store.save([makeRecord({ evidenceId: "ev-1" })]);
  const result = store.append([
    makeRecord({ evidenceId: "ev-2", orchestratorRunId: "run-2" }),
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.appendedCount, 1);
  const loaded = store.load();
  assert.equal(loaded.length, 2);
  assert.equal(loaded[0].evidenceId, "ev-1");
  assert.equal(loaded[1].evidenceId, "ev-2");
  rmSync(dir, { recursive: true, force: true });
});

test("store：append 拒绝重复 evidenceId", () => {
  const dir = mkdtempSync(join(tmpdir(), "se1b-dup-"));
  const filePath = join(dir, "evidence.json");
  const store = createStrategyEvidenceStore({ filePath, workspaceId: "xinmo" });
  store.save([makeRecord({ evidenceId: "ev-1" })]);
  const result = store.append([
    makeRecord({ evidenceId: "ev-1", orchestratorRunId: "run-2" }),
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "duplicate_evidence_id");
  // 原文件不变
  assert.equal(store.load().length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("store：append 拒绝既有文件 workspaceId 与 store workspaceId 不一致", () => {
  const dir = mkdtempSync(join(tmpdir(), "se1b-wsid-"));
  const filePath = join(dir, "evidence.json");
  // 写入一个 workspaceId="other" 的 artifact
  writeFileSync(
    filePath,
    JSON.stringify(
      makeArtifact([makeRecord({ evidenceId: "ev-1" })], { workspaceId: "other" })
    )
  );
  const store = createStrategyEvidenceStore({ filePath, workspaceId: "xinmo" });
  const result = store.append([
    makeRecord({ evidenceId: "ev-2", orchestratorRunId: "run-2" }),
  ]);
  assert.equal(result.ok, false);
  rmSync(dir, { recursive: true, force: true });
});

test("store：atomic save（不残留 .tmp 文件）", () => {
  const dir = mkdtempSync(join(tmpdir(), "se1b-atomic-"));
  const filePath = join(dir, "evidence.json");
  const store = createStrategyEvidenceStore({ filePath, workspaceId: "xinmo" });
  store.save([makeRecord({ evidenceId: "ev-1" })]);
  assert.ok(!existsSync(filePath + ".tmp"));
  assert.ok(existsSync(filePath));
  rmSync(dir, { recursive: true, force: true });
});

test("store：snapshot 返回当前 records（不重新读文件则缓存一致）", () => {
  const dir = mkdtempSync(join(tmpdir(), "se1b-snap-"));
  const filePath = join(dir, "evidence.json");
  const store = createStrategyEvidenceStore({ filePath, workspaceId: "xinmo" });
  store.save([makeRecord({ evidenceId: "ev-1" })]);
  const snap = store.snapshot();
  assert.equal(snap.length, 1);
  assert.equal(snap[0].evidenceId, "ev-1");
  rmSync(dir, { recursive: true, force: true });
});

test("store：artifact() 返回完整 artifact（含 schemaId/schemaVersion/workspaceId）", () => {
  const dir = mkdtempSync(join(tmpdir(), "se1b-art-"));
  const filePath = join(dir, "evidence.json");
  const store = createStrategyEvidenceStore({ filePath, workspaceId: "xinmo" });
  store.save([makeRecord({ evidenceId: "ev-1" })]);
  const artifact = store.artifact();
  assert.equal(artifact.schemaId, STRATEGY_EVIDENCE_SCHEMA_ID);
  assert.equal(artifact.schemaVersion, STRATEGY_EVIDENCE_SCHEMA_VERSION);
  assert.equal(artifact.workspaceId, "xinmo");
  assert.equal(artifact.records.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

// ============================================================================
// 3. importEligiblePairAsEvidence：eligible pair + verdict → evidence record
// ============================================================================

test("importEligiblePairAsEvidence 是函数", () => {
  assert.equal(typeof importEligiblePairAsEvidence, "function");
});

test("import：editorial_win pair + editorial preference → outcome=win, hasHumanVerdict=true, fromEligiblePair=true, source=user", () => {
  const pair = makeEligiblePair({ outcomeType: "editorial_win" });
  const verdict = makeValidVerdict({
    preference: "editorial",
    strategyId: "reader_payoff_strengthen",
  });
  const result = importEligiblePairAsEvidence(pair, verdict, makeImportContext());
  assert.equal(result.ok, true);
  assert.equal(result.record.outcome, "win");
  assert.equal(result.record.hasHumanVerdict, true);
  assert.equal(result.record.fromEligiblePair, true);
  assert.equal(result.record.source, "user");
  assert.equal(result.record.strategyId, "reader_payoff_strengthen");
  assert.equal(result.record.modelVersion, "glm-5.2");
  assert.equal(result.record.orchestratorRunId, "run-001");
  assert.equal(result.record.sourceChapter, "ch19");
});

test("import：judge_raw_win pair + raw preference → outcome=loss", () => {
  const pair = makeEligiblePair({
    outcomeType: "judge_raw_win",
    judgeWinner: "raw",
  });
  const verdict = makeValidVerdict({
    preference: "raw",
    anonymousMapping: { A: "editorial", B: "raw" },
  });
  const result = importEligiblePairAsEvidence(pair, verdict, makeImportContext());
  assert.equal(result.ok, true);
  assert.equal(result.record.outcome, "loss");
  assert.equal(result.record.hasHumanVerdict, true);
});

test("import：tie preference → outcome=tie", () => {
  const pair = makeEligiblePair();
  const verdict = makeValidVerdict({ preference: "tie" });
  const result = importEligiblePairAsEvidence(pair, verdict, makeImportContext());
  assert.equal(result.ok, true);
  assert.equal(result.record.outcome, "tie");
});

test("import：undecided preference → 拒绝（无策略信号）", () => {
  const pair = makeEligiblePair();
  const verdict = makeValidVerdict({ preference: "undecided" });
  const result = importEligiblePairAsEvidence(pair, verdict, makeImportContext());
  assert.equal(result.ok, false);
  assert.ok(
    result.reasons.some((r) => /undecided|无策略信号|no strategy signal/i.test(r))
  );
});

test("import：非 eligible pair outcome（no_editorial）→ 拒绝", () => {
  const pair = makeEligiblePair();
  pair.outcomeType = "no_editorial"; // 运行时篡改，模拟 fallback 样本冒充 eligible
  const verdict = makeValidVerdict();
  const result = importEligiblePairAsEvidence(pair, verdict, makeImportContext());
  assert.equal(result.ok, false);
  assert.ok(
    result.reasons.some((r) => /eligible|no_editorial|fallback/i.test(r))
  );
});

test("import：非 eligible pair outcome（factguard_block）→ 拒绝", () => {
  const pair = makeEligiblePair();
  pair.outcomeType = "factguard_block";
  const verdict = makeValidVerdict();
  const result = importEligiblePairAsEvidence(pair, verdict, makeImportContext());
  assert.equal(result.ok, false);
});

test("import：weight 默认 > 1（user 反馈高权重）", () => {
  const pair = makeEligiblePair();
  const verdict = makeValidVerdict();
  const result = importEligiblePairAsEvidence(pair, verdict, makeImportContext());
  assert.equal(result.ok, true);
  assert.ok(result.record.weight > 1, "user 反馈权重应 > 1");
});

test("import：context.evidenceId 覆盖默认派生 id", () => {
  const pair = makeEligiblePair();
  const verdict = makeValidVerdict();
  const result = importEligiblePairAsEvidence(pair, verdict, {
    ...makeImportContext(),
    evidenceId: "ev-custom-001",
  });
  assert.equal(result.ok, true);
  assert.equal(result.record.evidenceId, "ev-custom-001");
});

// ============================================================================
// 4. 严格 human 计数：只有 validated_human_proxy + humanEquivalent=true 才计 human
// ============================================================================

test("严格 human：validated_human_proxy + humanEquivalent=true → hasHumanVerdict=true", () => {
  const pair = makeEligiblePair();
  const verdict = makeValidVerdict();
  const result = importEligiblePairAsEvidence(pair, verdict, makeImportContext());
  assert.equal(result.ok, true);
  assert.equal(result.record.hasHumanVerdict, true);
});

test("严格 human：reviewerType=natural_person → 拒绝（不得冒充自然人）", () => {
  const pair = makeEligiblePair();
  const verdict = makeValidVerdict({ reviewerType: "natural_person" });
  const result = importEligiblePairAsEvidence(pair, verdict, makeImportContext());
  assert.equal(result.ok, false);
  assert.ok(
    result.reasons.some((r) => /natural_person|validated_human_proxy|冒充/i.test(r))
  );
});

test("严格 human：humanEquivalent=false → 拒绝（普通机器审阅不得冒充）", () => {
  const pair = makeEligiblePair();
  const verdict = makeValidVerdict({ humanEquivalent: false });
  const result = importEligiblePairAsEvidence(pair, verdict, makeImportContext());
  assert.equal(result.ok, false);
  assert.ok(
    result.reasons.some((r) => /humanEquivalent|机器审阅|冒充/i.test(r))
  );
});

test("严格 human：reviewerModel 非 gpt5.6-sol → 拒绝", () => {
  const pair = makeEligiblePair();
  const verdict = makeValidVerdict({ reviewerModel: "gpt-5.5" });
  const result = importEligiblePairAsEvidence(pair, verdict, makeImportContext());
  assert.equal(result.ok, false);
  assert.ok(
    result.reasons.some((r) => /gpt5\.6-sol|reviewerModel/i.test(r))
  );
});

test("严格 human：缺失 reviewerType → 拒绝", () => {
  const pair = makeEligiblePair();
  const verdict = makeValidVerdict();
  delete verdict.reviewerType;
  const result = importEligiblePairAsEvidence(pair, verdict, makeImportContext());
  assert.equal(result.ok, false);
});

test("严格 human：缺失 humanEquivalent → 拒绝", () => {
  const pair = makeEligiblePair();
  const verdict = makeValidVerdict();
  delete verdict.humanEquivalent;
  const result = importEligiblePairAsEvidence(pair, verdict, makeImportContext());
  assert.equal(result.ok, false);
});

// ============================================================================
// 5. provenance 一致性：pair 与 verdict 必须同源
// ============================================================================

test("provenance：pair.runProvenance.modelVersion !== verdict.modelVersion → 拒绝（跨模型污染）", () => {
  const pair = makeEligiblePair(); // glm-5.2
  const verdict = makeValidVerdict({ modelVersion: "doubao-2.1" });
  const result = importEligiblePairAsEvidence(pair, verdict, makeImportContext());
  assert.equal(result.ok, false);
  assert.ok(
    result.reasons.some((r) => /modelVersion|模型版本|不一致|pollution/i.test(r))
  );
});

test("provenance：pair.runProvenance.orchestratorRunId !== verdict.provenance.orchestratorRunId → 拒绝", () => {
  const pair = makeEligiblePair(); // run-001
  const verdict = makeValidVerdict();
  verdict.provenance.orchestratorRunId = "run-999";
  const result = importEligiblePairAsEvidence(pair, verdict, makeImportContext());
  assert.equal(result.ok, false);
});

test("provenance：pair.runProvenance.caseId !== verdict.provenance.caseId → 拒绝", () => {
  const pair = makeEligiblePair(); // case-04
  const verdict = makeValidVerdict();
  verdict.provenance.caseId = "case-99";
  const result = importEligiblePairAsEvidence(pair, verdict, makeImportContext());
  assert.equal(result.ok, false);
});

// ============================================================================
// 6. 不变量：写 evidence 不改生产概率、不自动 active
// ============================================================================

test("不变量：import 产出的 record 不含 alpha/beta/setStatus 字段", () => {
  const pair = makeEligiblePair();
  const verdict = makeValidVerdict();
  const result = importEligiblePairAsEvidence(pair, verdict, makeImportContext());
  assert.equal(result.ok, true);
  const json = JSON.stringify(result.record);
  assert.ok(!/alpha|beta|setStatus|putReputation|recordOutcome/i.test(json));
});

test("不变量：写 1 条 human evidence 不自动 active（需 5/3 阈值）", () => {
  const pair = makeEligiblePair();
  const verdict = makeValidVerdict();
  const result = importEligiblePairAsEvidence(pair, verdict, makeImportContext());
  const decisions = compileAdmissionDecisions([result.record]);
  assert.equal(decisions[0].recommendedStatus, "candidate");
  assert.equal(decisions[0].eligibleDecisionCount, 1);
  assert.equal(decisions[0].humanVerdictCount, 1);
});

test("不变量：store.append 不调用模型、不写 chapter/state/strategy 文件", () => {
  const dir = mkdtempSync(join(tmpdir(), "se1b-noprod-"));
  const filePath = join(dir, "evidence.json");
  const store = createStrategyEvidenceStore({ filePath, workspaceId: "xinmo" });
  const result = store.append([makeRecord({ evidenceId: "ev-1" })]);
  assert.equal(result.ok, true);
  // store 只写 evidence.json，不写 chapter/state/strategy
  assert.ok(!existsSync(join(dir, "chapters")));
  assert.ok(!existsSync(join(dir, "narrative-state-store.json")));
  assert.ok(!existsSync(join(dir, "strategy-policy.json")));
  rmSync(dir, { recursive: true, force: true });
});

// ============================================================================
// 7. 隔离：旧模型不污染新模型 + 不同策略不汇总
// ============================================================================

test("隔离：import 的 evidence modelVersion 来自 verdict，不跨模型汇总", () => {
  const pair = makeEligiblePair(); // glm-5.2
  const verdict = makeValidVerdict({ modelVersion: "glm-5.2" });
  const result = importEligiblePairAsEvidence(pair, verdict, makeImportContext());
  const decisions = compileAdmissionDecisions([
    result.record,
    makeRecord({
      evidenceId: "ev-other",
      modelVersion: "doubao-2.1",
      strategyId: "reader_payoff_strengthen",
      orchestratorRunId: "run-other",
      fromEligiblePair: true,
      hasHumanVerdict: true,
    }),
  ]);
  const glmDec = decisions.find((d) => d.modelVersion === "glm-5.2");
  const doubaoDec = decisions.find((d) => d.modelVersion === "doubao-2.1");
  assert.equal(glmDec.eligibleDecisionCount, 1);
  assert.equal(doubaoDec.eligibleDecisionCount, 1);
  assert.equal(glmDec.recommendedStatus, "candidate");
  assert.equal(doubaoDec.recommendedStatus, "candidate");
});

// ============================================================================
// 8. 冲突隔离与恢复：quarantine + rollback
// ============================================================================

test("恢复：同策略同源 win+loss → quarantined，不计 eligible", () => {
  const records = [
    makeRecord({
      evidenceId: "ev-w",
      strategyId: "s-A",
      source: "user",
      outcome: "win",
      fromEligiblePair: true,
      hasHumanVerdict: true,
      orchestratorRunId: "run-w",
    }),
    makeRecord({
      evidenceId: "ev-l",
      strategyId: "s-A",
      source: "user",
      outcome: "loss",
      fromEligiblePair: true,
      hasHumanVerdict: true,
      orchestratorRunId: "run-l",
    }),
  ];
  const quarantined = detectEvidenceConflicts(records);
  assert.equal(quarantined[0].quarantined, true);
  assert.equal(quarantined[1].quarantined, true);
  const decisions = compileAdmissionDecisions(quarantined);
  assert.equal(decisions.length, 0); // 全部 quarantined，无 effective
});

test("恢复：revoke 后重算降级（rollback，保持 candidate）", () => {
  const records = [];
  for (let i = 0; i < 5; i += 1) {
    records.push(
      makeRecord({
        evidenceId: `ev-${i}`,
        orchestratorRunId: `run-${i}`,
        fromEligiblePair: true,
        hasHumanVerdict: true,
      })
    );
  }
  const before = compileAdmissionDecisions(records);
  assert.equal(before[0].recommendedStatus, "active");
  const revoked = revokeEvidence(records, "ev-0", "撤销");
  const revoked2 = revokeEvidence(revoked, "ev-1", "撤销");
  const after = compileAdmissionDecisions(revoked2);
  assert.equal(after[0].recommendedStatus, "candidate");
  assert.equal(after[0].eligibleDecisionCount, 3);
});

// ============================================================================
// 9. 迁移/回滚 fixture：加载既有 artifact 后 append + revoke
// ============================================================================

test("迁移 fixture：加载既有 artifact 后 append 新 evidence（历史不丢）", () => {
  const dir = mkdtempSync(join(tmpdir(), "se1b-migrate-"));
  const filePath = join(dir, "evidence.json");
  // 既有 artifact（模拟迁移前的历史数据）
  const existing = makeArtifact([
    makeRecord({ evidenceId: "ev-old-1" }),
    makeRecord({ evidenceId: "ev-old-2", orchestratorRunId: "run-2" }),
  ]);
  writeFileSync(filePath, JSON.stringify(existing));
  const store = createStrategyEvidenceStore({ filePath, workspaceId: "xinmo" });
  const result = store.append([
    makeRecord({ evidenceId: "ev-new-1", orchestratorRunId: "run-3" }),
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.appendedCount, 1);
  const loaded = store.load();
  assert.equal(loaded.length, 3);
  assert.equal(loaded[0].evidenceId, "ev-old-1"); // 历史保留
  assert.equal(loaded[2].evidenceId, "ev-new-1"); // 新增在末尾
  rmSync(dir, { recursive: true, force: true });
});

test("回滚 fixture：store save → revoke 关键 evidence → 重算降级", () => {
  const dir = mkdtempSync(join(tmpdir(), "se1b-rollback-"));
  const filePath = join(dir, "evidence.json");
  const records = [];
  for (let i = 0; i < 5; i += 1) {
    records.push(
      makeRecord({
        evidenceId: `ev-${i}`,
        orchestratorRunId: `run-${i}`,
        fromEligiblePair: true,
        hasHumanVerdict: true,
      })
    );
  }
  const store = createStrategyEvidenceStore({ filePath, workspaceId: "xinmo" });
  store.save(records);
  const loaded = store.load();
  const before = compileAdmissionDecisions(loaded);
  assert.equal(before[0].recommendedStatus, "active");
  const revoked = revokeEvidence(loaded, "ev-0", "事后撤销");
  const revoked2 = revokeEvidence(revoked, "ev-1", "事后撤销");
  store.save(revoked2);
  const after = compileAdmissionDecisions(store.load());
  assert.equal(after[0].recommendedStatus, "candidate");
  assert.equal(after[0].eligibleDecisionCount, 3);
  rmSync(dir, { recursive: true, force: true });
});

// ============================================================================
// 10. 反向验证：删除新逻辑后必须 RED
// ============================================================================

test("反向：仅 judge 证据（无 human verdict）即便 5 条也不得 active", () => {
  const records = [];
  for (let i = 0; i < 5; i += 1) {
    records.push(
      makeRecord({
        evidenceId: `ev-judge-${i}`,
        orchestratorRunId: `run-judge-${i}`,
        source: "judge",
        fromEligiblePair: true,
        hasHumanVerdict: false,
      })
    );
  }
  const decisions = compileAdmissionDecisions(records);
  assert.equal(decisions[0].recommendedStatus, "candidate");
  assert.equal(decisions[0].humanVerdictCount, 0);
});

test("反向：polluted evidence 即便 5/3 也不得 active（全部 polluted → 无分区）", () => {
  const records = [];
  for (let i = 0; i < 5; i += 1) {
    records.push(
      makeRecord({
        evidenceId: `ev-poll-${i}`,
        orchestratorRunId: `run-poll-${i}`,
        fromEligiblePair: true,
        hasHumanVerdict: true,
        polluted: true,
      })
    );
  }
  const decisions = compileAdmissionDecisions(records);
  assert.equal(decisions.length, 0); // 全部 polluted，无 effective 分区
});
