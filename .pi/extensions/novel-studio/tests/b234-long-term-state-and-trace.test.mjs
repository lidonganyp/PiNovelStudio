/**
 * B2/B3/B4：四类长期状态 + promise upsert 去重 + 多候选裁判 trace 完整持久化
 *
 * 对应审计阻断：
 * - B2：四类长期状态（CanonState / CharacterState / PromiseLedger / PatternMemory）
 *       完整进入正常生成（不只 PromiseLedger）
 * - B3：promise 按 ID upsert 去重，防止长期运行重复累积同一 entry
 * - B4：多候选裁判 trace 完整持久化（allArbitrationResults + allJudgeEvidence），
 *       不只最终选中的那一个
 *
 * 测试层级：
 * - B2 unit：reanchorStagedStateToFinalText 处理四种 kind 的正文重锚定
 * - B2 e2e：orchestrator 提交的状态含四类 entry（canon/character/promise/pattern）
 * - B3 unit：commit 同 id 跨章节 upsert，store 不重复累积
 * - B4 e2e：orchestrator 输出 allArbitrationResults 含全部 editorial 候选的完整证据
 * - B4 trace：trace candidate_compared 含 allJudgeEvidence（多候选时）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadStateStore,
  saveStateStore,
  createFinalStateCommit,
  computeFinalTextHash,
  reanchorStagedStateToFinalText,
} from "../dist/v2/core/final-state-commit.js";
import { createUnifiedOrchestrator } from "../dist/v2/core/unified-orchestrator.js";

// ============================================================================
// 辅助
// ============================================================================

function makeTempProject() {
  const dir = mkdtempSync(join(tmpdir(), "b234-test-"));
  const workspaceId = "test-ws";
  const wsDir = join(dir, "workspaces", workspaceId);
  mkdirSync(wsDir, { recursive: true });
  return { dir, workspaceId, wsDir };
}

function makeIntent(overrides = {}) {
  return {
    chapterFunction: "推进核心冲突",
    readerExperience: ["紧张"],
    currentPressure: ["救援压力"],
    meaningfulChoices: [],
    promisesToAdvance: [],
    possibleEndPressure: [],
    relevantCharacters: ["林川", "苏婉"],
    inviolableFacts: ["水下暗流不可消除"],
    sourceRefs: ["chapter-seed"],
    ...overrides,
  };
}

function makeContext(overrides = {}) {
  return {
    facts: [],
    characterStates: [],
    openLoops: [],
    worldRules: [],
    styleReferences: [],
    sourceMap: [],
    constitution: null,
    longTermState: null,
    ...overrides,
  };
}

/** raw 正文：章末平淡（触发 chapter_end_pressure 编辑机会） */
const RAW_TEXT_WEAK_END = [
  "林川推开门，走了进去。房间里很暗，他摸索着前进。",
  "他抓住苏婉的手臂，把她往水面拉。",
  "暗流拉扯着他的腿，他用力蹬水，把苏婉推到浅滩。",
  "过了一会儿，他回到了岸上，换了干衣服，坐在床边休息。",
  "窗外的雨还在下，水面恢复了平静，他闭上眼睛，很快睡着了。",
].join("\n");

/** editorial 正文：章末有钩子（含"？") + 含感知侵蚀词"意识到"（触发 pattern 扫描） */
const EDITORIAL_TEXT_STRONG_HOOK = [
  "林川推开门，走了进去。房间里很暗，他摸索着前进。",
  "他抓住苏婉的手臂，把她往水面拉，暗流拉扯着他的腿。",
  "他把苏婉推到浅滩，又一次跳进水里去找老周。",
  "浑浊的水下，一个黑影正缓缓游向老周。",
  "林川心里一紧，他意识到那东西的形状不像鱼。老周为什么在笑？他到底看到了什么？",
].join("\n");

function makeCompositeStub(opts) {
  const {
    rawText,
    editorialText,
    betterMarker = "？",
    judgeConfidence = "clear",
    editorialThrow = false,
  } = opts;
  return async (input) => {
    if (input.kind === "raw_chapter") {
      return { text: rawText, model: "stub-raw", route: input.route, durationMs: 10 };
    }
    if (input.kind === "editorial_amplified") {
      if (editorialThrow) throw new Error("editorial 生成异常（stub）");
      return { text: editorialText, model: "stub-ed", route: input.route, durationMs: 10 };
    }
    if (input.kind === "literary_judge") {
      const aMatch = input.userPrompt.match(/【候选 A】\n([\s\S]*?)\n（候选 A 总字符数/);
      const bMatch = input.userPrompt.match(/【候选 B】\n([\s\S]*?)\n（候选 B 总字符数/);
      const textA = aMatch ? aMatch[1] : "";
      const textB = bMatch ? bMatch[1] : "";
      const aHas = textA.includes(betterMarker);
      const bHas = textB.includes(betterMarker);
      let winner;
      let worseText;
      if (aHas && !bHas) { winner = "A"; worseText = textB; }
      else if (bHas && !aHas) { winner = "B"; worseText = textA; }
      else { winner = "tie"; worseText = ""; }
      const worseLabel = winner === "A" ? "B" : "A";
      const span = worseText
        ? { start: 0, end: Math.min(8, worseText.length), excerpt: worseText.slice(0, Math.min(8, worseText.length)) }
        : { start: 0, end: 1, excerpt: "x" };
      const verdict = {
        winner,
        confidence: winner === "tie" ? "uncertain" : judgeConfidence,
        decisiveReasons: [{
          dimension: "章末钩子",
          betterCandidate: winner === "tie" ? "neither" : winner,
          evidenceA: worseLabel === "A" ? [span] : [],
          evidenceB: worseLabel === "B" ? [span] : [],
          explanation: winner === "tie" ? "两者接近" : `${winner} 钩子更强`,
        }],
        factualRisks: [],
        regressionRisks: [],
        constitutionAlignment: "两者均对齐",
      };
      return { text: JSON.stringify(verdict), model: "stub-judge", route: input.route, durationMs: 10 };
    }
    return { text: "", model: "stub", route: input.route, durationMs: 10 };
  };
}

// ============================================================================
// B2 unit：reanchorStagedStateToFinalText 处理四种 kind
// ============================================================================

test("B2: reanchorStagedStateToFinalText 处理 canon kind（命中→span，未命中→not-found）", () => {
  const finalText = "林川抓住苏婉的手臂。暗流拉扯着他的腿。世界存在灵气。";
  const hash = computeFinalTextHash(finalText);
  const update = {
    additions: [
      {
        kind: "canon",
        id: "canon:fact:0:ch3",
        sourceChapter: "ch3",
        sourceRef: "seed:canon:0",
        confidence: 0.6,
        lastUpdated: "2026-01-01T00:00:00.000Z",
        fact: "世界存在灵气",
        category: "entity",
      },
      {
        kind: "canon",
        id: "canon:fact:1:ch3",
        sourceChapter: "ch3",
        sourceRef: "seed:canon:1",
        confidence: 0.6,
        lastUpdated: "2026-01-01T00:00:00.000Z",
        fact: "魔法禁咒体系",
        category: "entity",
      },
    ],
    invalidations: [],
    sourceChapter: "ch3",
  };

  const reanchored = reanchorStagedStateToFinalText(update, finalText, 3);

  // canon 1：正文命中"世界存在灵气" → sourceRef 指向真实 span，confidence 提升
  const c1 = reanchored.additions[0];
  assert.ok(c1.sourceRef.includes(`finalText:${hash}:`), `应含 finalText hash，实际: ${c1.sourceRef}`);
  assert.ok(c1.sourceRef.match(/:\d+-\d+$/), "应含 span");
  assert.equal(c1.confidence, 0.7, "正文确认命中应提升 confidence");

  // canon 2：正文未命中 → sourceRef 标记 not-found，confidence 降级
  const c2 = reanchored.additions[1];
  assert.ok(c2.sourceRef.includes(":not-found"), `应标记 not-found，实际: ${c2.sourceRef}`);
  assert.equal(c2.confidence, 0.25, "正文未命中应降级 confidence");
});

test("B2: reanchorStagedStateToFinalText 处理 character kind（命中→span，未命中→not-found）", () => {
  const finalText = "林川抓住苏婉的手臂。暗流拉扯着他的腿。";
  const hash = computeFinalTextHash(finalText);
  const update = {
    additions: [
      {
        kind: "character",
        id: "character:林川:ch3",
        sourceChapter: "ch3",
        sourceRef: "seed:character:林川",
        confidence: 0.6,
        lastUpdated: "2026-01-01T00:00:00.000Z",
        characterId: "林川",
        field: "participation",
        value: "protagonist",
      },
      {
        kind: "character",
        id: "character:幽灵:ch3",
        sourceChapter: "ch3",
        sourceRef: "seed:character:幽灵",
        confidence: 0.6,
        lastUpdated: "2026-01-01T00:00:00.000Z",
        characterId: "不存在的幽灵",
        field: "participation",
        value: "present",
      },
    ],
    invalidations: [],
    sourceChapter: "ch3",
  };

  const reanchored = reanchorStagedStateToFinalText(update, finalText, 3);

  // character 1：正文命中"林川" → sourceRef 指向真实 span
  const ch1 = reanchored.additions[0];
  assert.ok(ch1.sourceRef.includes(`finalText:${hash}:`), `应含 finalText hash，实际: ${ch1.sourceRef}`);
  assert.ok(ch1.sourceRef.match(/:\d+-\d+$/), "应含 span");
  assert.equal(ch1.confidence, 0.7, "正文确认命中应提升 confidence");

  // character 2：正文未命中 → sourceRef 标记 not-found
  const ch2 = reanchored.additions[1];
  assert.ok(ch2.sourceRef.includes(":not-found"), `应标记 not-found，实际: ${ch2.sourceRef}`);
  assert.equal(ch2.confidence, 0.25, "正文未命中应降级 confidence");
});

test("B2: reanchorStagedStateToFinalText 处理 pattern kind（hash 前缀，无 span）", () => {
  const finalText = "林川抓住苏婉的手臂。暗流拉扯着他的腿。";
  const hash = computeFinalTextHash(finalText);
  const update = {
    additions: [
      {
        kind: "pattern",
        id: "pattern:ai_pattern:ch3",
        sourceChapter: "ch3",
        sourceRef: "seed:pattern:ai_pattern",
        confidence: 0.8,
        lastUpdated: "2026-01-01T00:00:00.000Z",
        patternType: "sentence_risk",
        description: "AI 腔风险",
        occurrenceCount: 3,
      },
    ],
    invalidations: [],
    sourceChapter: "ch3",
  };

  const reanchored = reanchorStagedStateToFinalText(update, finalText, 3);
  const p1 = reanchored.additions[0];
  // pattern：sourceRef 加 finalText hash 标记来源，无 span（统计条目）
  assert.ok(
    p1.sourceRef === `ch3#finalText:${hash}`,
    `pattern sourceRef 应为 ch3#finalText:{hash}（无 span），实际: ${p1.sourceRef}`,
  );
});

// ============================================================================
// B2 e2e：orchestrator 提交的状态含四类 entry（canon/character/promise/pattern）
// ============================================================================

test("B2 e2e: orchestrator 提交 canon/character/promise/pattern 四类状态到 store", async () => {
  const { dir, workspaceId } = makeTempProject();
  try {
    const stagedStateUpdate = {
      additions: [
        {
          kind: "promise",
          id: "promise:dark-current",
          sourceChapter: "ch1",
          sourceRef: "seed:promise:dark-current",
          confidence: 0.6,
          lastUpdated: new Date().toISOString(),
          promiseId: "promise:dark-current",
          description: "暗流",
          currentHeat: 1,
          status: "advancing",
        },
        {
          kind: "canon",
          id: "canon:fact:0:ch1",
          sourceChapter: "ch1",
          sourceRef: "seed:canon:0",
          confidence: 0.6,
          lastUpdated: new Date().toISOString(),
          fact: "暗流",
          category: "entity",
        },
        {
          kind: "character",
          id: "character:林川:ch1",
          sourceChapter: "ch1",
          sourceRef: "seed:character:林川",
          confidence: 0.6,
          lastUpdated: new Date().toISOString(),
          characterId: "林川",
          field: "participation",
          value: "protagonist",
        },
      ],
      invalidations: [],
      sourceChapter: "ch1",
    };

    const input = {
      workspaceId,
      chapterId: "ch-b2-e2e",
      chapterNumber: 1,
      projectRoot: dir,
      intent: makeIntent(),
      context: makeContext(),
      constitution: null,
      characterNames: ["林川", "苏婉"],
      modelGenerate: makeCompositeStub({
        rawText: RAW_TEXT_WEAK_END,
        editorialText: EDITORIAL_TEXT_STRONG_HOOK,
      }),
      stagedStateUpdate,
    };

    const orch = createUnifiedOrchestrator();
    const result = await orch.orchestrate(input);
    assert.equal(result.status, "ok");

    // 读取落盘的 narrative-state-store.json
    const statePath = join(dir, "workspaces", workspaceId, "narrative-state-store.json");
    assert.ok(existsSync(statePath), "narrative-state-store.json 应已落盘");
    const store = JSON.parse(readFileSync(statePath, "utf-8"));

    // B2：四类状态都应存在
    assert.ok(store.promise.length >= 1, `promise 应有 entry，实际: ${store.promise.length}`);
    assert.ok(store.canon.length >= 1, `canon 应有 entry，实际: ${store.canon.length}`);
    assert.ok(store.character.length >= 1, `character 应有 entry，实际: ${store.character.length}`);
    assert.ok(store.pattern.length >= 1, `pattern 应有 entry（从正文扫描），实际: ${store.pattern.length}`);

    // 验证 canon entry 的 sourceRef 含 finalText（重锚定后不再 seed:*）
    const canon = store.canon.find((c) => c.id === "canon:fact:0:ch1");
    assert.ok(canon, "应有 canon:fact:0:ch1 entry");
    assert.ok(canon.sourceRef.includes("finalText:"), `canon sourceRef 应含 finalText:，实际: ${canon.sourceRef}`);
    assert.ok(!canon.sourceRef.includes("seed:"), `canon sourceRef 不应含 seed:，实际: ${canon.sourceRef}`);

    // 验证 character entry 的 sourceRef 含 finalText
    const character = store.character.find((c) => c.id === "character:林川:ch1");
    assert.ok(character, "应有 character:林川:ch1 entry");
    assert.ok(character.sourceRef.includes("finalText:"), `character sourceRef 应含 finalText:，实际: ${character.sourceRef}`);

    // 验证 pattern entry 保留 scanner 的全部正文证据 span
    const pattern = store.pattern[0];
    assert.equal(pattern.patternType, "sentence_risk", `pattern patternType 应为 sentence_risk，实际: ${pattern.patternType}`);
    assert.match(pattern.sourceRef, /finalText:\w+:\d+-\d+$/, `pattern sourceRef 应指向首个 scanner span，实际: ${pattern.sourceRef}`);
    assert.ok(Array.isArray(pattern.sourceRefs) && pattern.sourceRefs.length >= 1, "pattern 应保留全部 scanner sourceRefs");
    assert.ok(pattern.sourceRefs.every((sourceRef) => /finalText:\w+:\d+-\d+$/.test(sourceRef)), "pattern sourceRefs 必须全部指向正文 span");
    assert.ok(typeof pattern.occurrenceCount === "number" && pattern.occurrenceCount >= 1, "pattern 应有 occurrenceCount");

    // 验证 stageResults.stateCommit 记录 patternEntriesAdded
    assert.ok(
      typeof result.stageResults.stateCommit.patternEntriesAdded === "number",
      `stageResults.stateCommit.patternEntriesAdded 应为 number，实际: ${result.stageResults.stateCommit.patternEntriesAdded}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// B3：promise 按 ID upsert 去重（跨章节同 id 不重复累积）
// ============================================================================

test("B3: 同 id promise 跨章节 commit upsert，store 不重复累积", () => {
  const { dir, workspaceId } = makeTempProject();
  try {
    const now = () => new Date().toISOString();
    const finalText = "暗流的秘密在水面下涌动。";

    // 第 3 章：提交 promise:dark-current，status=open
    const commit3 = createFinalStateCommit();
    const store3 = loadStateStore(workspaceId, dir);
    commit3.stage({
      additions: [
        {
          kind: "promise",
          id: "promise:dark-current",
          sourceChapter: "ch3",
          sourceRef: `ch3#finalText:${computeFinalTextHash(finalText)}:0-2`,
          confidence: 0.7,
          lastUpdated: now(),
          promiseId: "promise:dark-current",
          description: "暗流",
          currentHeat: 1,
          status: "open",
        },
      ],
      invalidations: [],
      sourceChapter: "ch3",
      finalCandidateId: "amp-1",
    });
    commit3.commit(store3, "amp-1", finalText, workspaceId, dir);

    let loaded = loadStateStore(workspaceId, dir);
    assert.equal(loaded.promise.length, 1, "第3章后应有 1 条 promise");
    assert.equal(loaded.promise[0].status, "open");

    // 第 5 章：提交相同 id promise:dark-current，status=advancing（应 upsert，不 push）
    const commit5 = createFinalStateCommit();
    const store5 = loadStateStore(workspaceId, dir);
    commit5.stage({
      additions: [
        {
          kind: "promise",
          id: "promise:dark-current",
          sourceChapter: "ch5",
          sourceRef: `ch5#finalText:${computeFinalTextHash(finalText)}:0-2`,
          confidence: 0.8,
          lastUpdated: now(),
          promiseId: "promise:dark-current",
          description: "暗流",
          currentHeat: 2,
          status: "advancing",
        },
      ],
      invalidations: [],
      sourceChapter: "ch5",
      finalCandidateId: "amp-2",
    });
    commit5.commit(store5, "amp-2", finalText, workspaceId, dir);

    loaded = loadStateStore(workspaceId, dir);
    // B3 核心：同 id upsert，store.promise 仍为 1 条（非 2 条）
    assert.equal(
      loaded.promise.length,
      1,
      `B3：同 id promise 应 upsert 不重复累积，实际: ${loaded.promise.length}`,
    );
    // 应为第5章的更新版本（status=advancing, currentHeat=2）
    assert.equal(loaded.promise[0].status, "advancing", "应为第5章 upsert 后的 status");
    assert.equal(loaded.promise[0].currentHeat, 2, "应为第5章 upsert 后的 currentHeat");
    assert.equal(loaded.promise[0].sourceChapter, "ch5", "应为第5章 upsert 后的 sourceChapter");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B3: 同 id canon 跨章节 commit upsert，store 不重复累积", () => {
  const { dir, workspaceId } = makeTempProject();
  try {
    const now = () => new Date().toISOString();
    const finalText = "世界存在灵气。";

    // 第 1 章：提交 canon:world:rule1
    const commit1 = createFinalStateCommit();
    const store1 = loadStateStore(workspaceId, dir);
    commit1.stage({
      additions: [
        {
          kind: "canon",
          id: "canon:world:rule1",
          sourceChapter: "ch1",
          sourceRef: `ch1#finalText:${computeFinalTextHash(finalText)}:0-3`,
          confidence: 0.7,
          lastUpdated: now(),
          fact: "世界存在灵气",
          category: "ability_rule",
        },
      ],
      invalidations: [],
      sourceChapter: "ch1",
      finalCandidateId: "amp-1",
    });
    commit1.commit(store1, "amp-1", finalText, workspaceId, dir);

    // 第 4 章：提交相同 id canon:world:rule1，更新 confidence
    const commit4 = createFinalStateCommit();
    const store4 = loadStateStore(workspaceId, dir);
    commit4.stage({
      additions: [
        {
          kind: "canon",
          id: "canon:world:rule1",
          sourceChapter: "ch4",
          sourceRef: `ch4#finalText:${computeFinalTextHash(finalText)}:0-3`,
          confidence: 0.95,
          lastUpdated: now(),
          fact: "世界存在灵气",
          category: "ability_rule",
        },
      ],
      invalidations: [],
      sourceChapter: "ch4",
      finalCandidateId: "amp-2",
    });
    commit4.commit(store4, "amp-2", finalText, workspaceId, dir);

    const loaded = loadStateStore(workspaceId, dir);
    assert.equal(
      loaded.canon.length,
      1,
      `B3：同 id canon 应 upsert 不重复累积，实际: ${loaded.canon.length}`,
    );
    assert.equal(loaded.canon[0].confidence, 0.95, "应为第4章 upsert 后的 confidence");
    assert.equal(loaded.canon[0].sourceChapter, "ch4", "应为第4章 upsert 后的 sourceChapter");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// B4：多候选裁判 trace 完整持久化（allArbitrationResults + allJudgeEvidence）
// ============================================================================

test("B4: orchestrator 输出 allArbitrationResults 含全部 editorial 候选的完整证据", async () => {
  const { dir, workspaceId } = makeTempProject();
  try {
    const input = {
      workspaceId,
      chapterId: "ch-b4-arb",
      chapterNumber: 1,
      projectRoot: dir,
      intent: makeIntent(),
      context: makeContext(),
      constitution: null,
      characterNames: ["林川", "苏婉", "老周"],
      modelGenerate: makeCompositeStub({
        rawText: RAW_TEXT_WEAK_END,
        editorialText: EDITORIAL_TEXT_STRONG_HOOK,
      }),
    };

    const orch = createUnifiedOrchestrator();
    const result = await orch.orchestrate(input);
    assert.equal(result.status, "ok");

    // B4：allArbitrationResults 必须存在且为数组
    assert.ok(
      Array.isArray(result.allArbitrationResults),
      `allArbitrationResults 应为数组，实际: ${typeof result.allArbitrationResults}`,
    );

    // 当存在 editorial 候选时，allArbitrationResults 至少 1 条
    const editorialCandidates = result.candidates.filter((c) => c.kind === "editorial_amplified");
    if (editorialCandidates.length > 0) {
      assert.ok(
        result.allArbitrationResults.length >= 1,
        `有 editorial 候选时 allArbitrationResults 应 >= 1，实际: ${result.allArbitrationResults.length}`,
      );

      // 每条 allArbitrationResults 含 candidateId + 完整 ArbitratorResult（非摘要）
      for (const arb of result.allArbitrationResults) {
        assert.ok(typeof arb.candidateId === "string", "每条应含 candidateId");
        assert.ok(arb.result, "每条应含 result（ArbitratorResult）");
        // 完整 ArbitratorResult 字段（非摘要）
        assert.ok(Array.isArray(arb.result.rounds), "result.rounds 应为数组");
        assert.ok(arb.result.rounds.length >= 1, "result.rounds 至少 1 轮");
        assert.equal(typeof arb.result.auditSummary, "string", "result.auditSummary 应为 string");
        assert.equal(typeof arb.result.reverseReviewed, "boolean", "result.reverseReviewed 应为 boolean");
        assert.equal(typeof arb.result.arbitrationTriggered, "boolean", "result.arbitrationTriggered 应为 boolean");
        assert.equal(typeof arb.result.conflicted, "boolean", "result.conflicted 应为 boolean");
      }

      // candidateId 应对应 editorial 候选 id（非 raw）
      const editorialIds = new Set(editorialCandidates.map((c) => c.id));
      for (const arb of result.allArbitrationResults) {
        assert.ok(
          editorialIds.has(arb.candidateId),
          `allArbitrationResults.candidateId (${arb.candidateId}) 应为 editorial 候选 id`,
        );
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B4: deliverRaw 路径 allArbitrationResults 为空数组", async () => {
  const { dir, workspaceId } = makeTempProject();
  try {
    // editorial 候选生成抛异常 → deliverRaw 路径（无 editorial 裁判）
    const input = {
      workspaceId,
      chapterId: "ch-b4-raw",
      chapterNumber: 1,
      projectRoot: dir,
      intent: makeIntent(),
      context: makeContext(),
      constitution: null,
      characterNames: ["林川", "苏婉", "老周"],
      modelGenerate: makeCompositeStub({
        rawText: RAW_TEXT_WEAK_END,
        editorialText: EDITORIAL_TEXT_STRONG_HOOK,
        editorialThrow: true,
      }),
    };

    const orch = createUnifiedOrchestrator();
    const result = await orch.orchestrate(input);

    // editorial 生成失败 → 交付 raw（selectedSource === "raw"）
    assert.equal(result.status, "ok", "editorial 失败应交付 raw 而非 blocked");
    assert.equal(result.selectedSource, "raw", "应交付 raw");

    // deliverRaw 路径：allArbitrationResults 为空数组（无 editorial 裁判）
    assert.ok(
      Array.isArray(result.allArbitrationResults),
      "deliverRaw 路径 allArbitrationResults 仍应为数组",
    );
    assert.equal(
      result.allArbitrationResults.length,
      0,
      `deliverRaw 路径 allArbitrationResults 应为空，实际: ${result.allArbitrationResults.length}`,
    );
    // judgeResult 为 null（无裁判）
    assert.equal(result.judgeResult, null, "deliverRaw 路径 judgeResult 应为 null");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
