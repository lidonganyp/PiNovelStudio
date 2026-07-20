/**
 * TEXT-INTEGRITY-1 — FinalTextCompletenessGate RED contract.
 *
 * User journey:
 * As a chapter-generation user, I must never receive or persist a chapter that
 * is visibly cut off by model/transport truncation, while legitimate short or
 * open-ended hooks remain deliverable.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createUnifiedOrchestrator } from "../dist/v2/core/unified-orchestrator.js";
import { scanFinalTextCompleteness } from "../dist/v2/core/final-text-completeness-guard.js";
import { loadBlockedCandidateEvidence } from "../dist/v2/core/blocked-candidate-evidence.js";
import { createHash } from "node:crypto";

const RQ4F_TRUNCATED_CH20 = [
  "大蛇的身体猛然僵直，随后重重砸进泥水。",
  "李一凡靠着墙坐下，左臂的绷带已经被血浸透。",
  "窗外没有风，冰箱压缩机低低响着。",
  "他闭上眼，又看见那双竖瞳涣散的光。和他自己",
].join("\n");

const VALID_OPEN_HOOK = [
  "大蛇的身体猛然僵直，随后重重砸进泥水。",
  "李一凡靠着墙坐下，左臂的绷带已经被血浸透。",
  "窗外没有风，冰箱压缩机低低响着。",
  "门外忽然响了三声。",
  "他没有开门。门外的人，到底是谁？",
].join("\n");

function makeInput(projectRoot, chapterId, rawText) {
  return {
    workspaceId: "text-integrity-workspace",
    chapterId,
    chapterNumber: 20,
    projectRoot,
    intent: {
      chapterFunction: "承接战斗余波",
      readerExperience: ["紧张"],
      currentPressure: ["伤势未处理"],
      meaningfulChoices: [],
      promisesToAdvance: [],
      possibleEndPressure: [],
      relevantCharacters: ["李一凡"],
      inviolableFacts: [],
      sourceRefs: ["rq4f:ch20"],
    },
    context: {
      facts: [],
      characterStates: [],
      openLoops: [],
      worldRules: [],
      styleReferences: [],
      sourceMap: [],
      constitution: null,
      longTermState: null,
    },
    constitution: null,
    characterNames: ["李一凡"],
    modelGenerate: async (input) => {
      if (input.kind === "raw_chapter") {
        return { text: rawText, model: "stub-raw", route: input.route, durationMs: 1 };
      }
      return {
        text: JSON.stringify({
          winner: "tie",
          confidence: "uncertain",
          decisiveReasons: [],
          factualRisks: [],
          regressionRisks: [],
          constitutionAlignment: "无",
        }),
        model: "stub-judge",
        route: input.route,
        durationMs: 1,
      };
    },
  };
}

async function withRawOnlyBudget(run) {
  const previousSoft = process.env.PINOVEL_MODEL_CALL_SOFT;
  const previousHard = process.env.PINOVEL_MODEL_CALL_HARD;
  process.env.PINOVEL_MODEL_CALL_SOFT = "1";
  process.env.PINOVEL_MODEL_CALL_HARD = "2";
  try {
    return await run();
  } finally {
    if (previousSoft === undefined) delete process.env.PINOVEL_MODEL_CALL_SOFT;
    else process.env.PINOVEL_MODEL_CALL_SOFT = previousSoft;
    if (previousHard === undefined) delete process.env.PINOVEL_MODEL_CALL_HARD;
    else process.env.PINOVEL_MODEL_CALL_HARD = previousHard;
  }
}

test("TEXT-INTEGRITY-1 unit: 只阻断确定性截断，缺标点但语义不明时仅 review", () => {
  const truncated = scanFinalTextCompleteness(RQ4F_TRUNCATED_CH20);
  assert.equal(truncated.status, "blocked");
  assert.equal(truncated.passed, false);
  assert.equal(truncated.findings[0]?.code, "dangling_tail");
  assert.equal(
    RQ4F_TRUNCATED_CH20.slice(
      truncated.findings[0].span.start,
      truncated.findings[0].span.end,
    ),
    "和他自己",
  );

  const ambiguous = scanFinalTextCompleteness("他走到窗前，看见远处的灯火一盏接一盏亮起来");
  assert.equal(ambiguous.status, "review");
  assert.equal(ambiguous.passed, true, "不确定的缺标点只进入人工审阅，不得机械 hard block");
  assert.equal(ambiguous.findings[0]?.code, "missing_terminal_punctuation");
});

test("FINAL-TRUNCATION-TAIL-1 unit: 完整句后残留短中文词干属于 hard truncation", () => {
  const report = scanFinalTextCompleteness("李一凡把力量压了回去。黑色虚");
  assert.equal(report.status, "blocked");
  assert.equal(report.passed, false);
  assert.equal(report.findings[0]?.code, "incomplete_tail_fragment");
  assert.equal(
    "李一凡把力量压了回去。黑色虚".slice(report.findings[0]?.span?.start, report.findings[0]?.span?.end),
    "黑色虚",
  );
  assert.match(report.findings[0]?.reason ?? "", /黑色虚|截断/);
});

test("TEXT-INTEGRITY-1 unit: 合法问句、短对白、引号和省略号结尾通过", () => {
  for (const text of [
    "门外的人，到底是谁？",
    "他只说了一句：\"别回头。\"",
    "脚步声越来越近……",
    "她点了点头。",
  ]) {
    const report = scanFinalTextCompleteness(text);
    assert.equal(report.status, "pass", text);
    assert.equal(report.passed, true, text);
    assert.deepEqual(report.findings, [], text);
  }
});

test("TEXT-INTEGRITY-1 unit: 显式截断标记和悬空连接词属于 hard finding", () => {
  for (const text of [
    "他推开门，因为",
    "他看见了那张脸。[内容截断]",
    "他闭上眼。和他自己",
  ]) {
    const report = scanFinalTextCompleteness(text);
    assert.equal(report.status, "blocked", text);
    assert.equal(report.passed, false, text);
    assert.equal(report.findings[0]?.severity, "hard", text);
  }
});

test("TEXT-INTEGRITY-1: RQ4F 悬空尾句在 raw-only 保存和状态提交前 hard block", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "text-integrity-red-"));
  const chapterPath = join(
    projectRoot,
    "workspaces",
    "text-integrity-workspace",
    "chapters",
    "ch20-truncated.md",
  );
  try {
    const result = await withRawOnlyBudget(() =>
      createUnifiedOrchestrator().orchestrate(
        makeInput(projectRoot, "ch20-truncated", RQ4F_TRUNCATED_CH20),
      ),
    );

    assert.equal(result.status, "blocked");
    assert.equal(result.failureEnvelope?.stage, "final_text_completeness");
    assert.equal(result.chapterFilePath, null);
    assert.equal(result.stateCommit, null);
    assert.equal(existsSync(chapterPath), false, "截断正文不得落盘");
    assert.equal(result.stageResults.atomicSave, undefined, "截断正文不得进入原子保存");
    assert.equal(result.stageResults.stateCommit, undefined, "截断正文不得提交长期状态");
    assert.equal(result.stageResults.finalTextCompleteness?.passed, false);
    assert.match(result.stageResults.finalTextCompleteness?.findings?.[0]?.reason ?? "", /悬空|截断/);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("FINAL-TRUNCATION-TAIL-1 integration: 短词干截断不得保存或提交状态", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "final-truncation-tail-"));
  const chapterPath = join(
    projectRoot,
    "workspaces",
    "text-integrity-workspace",
    "chapters",
    "ch20-tail-truncated.md",
  );
  try {
    const result = await withRawOnlyBudget(() =>
      createUnifiedOrchestrator().orchestrate(
        makeInput(projectRoot, "ch20-tail-truncated", "李一凡把力量压了回去。黑色虚"),
      ),
    );

    assert.equal(result.status, "blocked");
    assert.equal(result.failureEnvelope?.stage, "final_text_completeness");
    assert.equal(result.chapterFilePath, null);
    assert.equal(result.stateCommit, null);
    assert.equal(existsSync(chapterPath), false);
    assert.equal(result.stageResults.finalTextCompleteness?.findings?.[0]?.code, "incomplete_tail_fragment");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("TEXT-INTEGRITY-1: 合法短句和开放式问句仍可 raw-only 交付", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "text-integrity-open-hook-"));
  try {
    const result = await withRawOnlyBudget(() =>
      createUnifiedOrchestrator().orchestrate(
        makeInput(projectRoot, "ch20-open-hook", VALID_OPEN_HOOK),
      ),
    );

    assert.equal(result.status, "ok");
    assert.equal(result.selectedSource, "raw");
    assert.equal(result.stageResults.finalTextCompleteness?.passed, true);
    assert.ok(result.chapterFilePath && existsSync(result.chapterFilePath));
    assert.equal(readFileSync(result.chapterFilePath, "utf8"), VALID_OPEN_HOOK);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// BLOCKED-CANDIDATE-EVIDENCE-1-REPAIR: final candidate hard-block 证据留存
// deliverRaw 路径 final_text_completeness 阻断必须写入带候选上下文的 artifact。
// ============================================================================

test("REPAIR: deliverRaw final_text_completeness 阻断写入带候选上下文的 blocked evidence artifact", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "blocked-evidence-repair-"));
  const chapterPath = join(
    projectRoot,
    "workspaces",
    "text-integrity-workspace",
    "chapters",
    "ch20-blocked-ev.md",
  );
  const artifactPath = join(
    projectRoot,
    "workspaces",
    "text-integrity-workspace",
    "traces",
    "ch20-blocked-ev-blocked-candidate-evidence.json",
  );
  try {
    const result = await withRawOnlyBudget(() =>
      createUnifiedOrchestrator().orchestrate(
        makeInput(projectRoot, "ch20-blocked-ev", RQ4F_TRUNCATED_CH20),
      ),
    );

    // hard block 基本不变量
    assert.equal(result.status, "blocked");
    assert.equal(result.failureEnvelope?.stage, "final_text_completeness");
    assert.equal(result.text, "", "blocked 路径 text 必须为空");
    assert.equal(result.chapterFilePath, null);
    assert.equal(result.stateCommit, null);
    assert.equal(result.candidates.length, 0, "候选不得进入 eligible pair");
    assert.equal(existsSync(chapterPath), false, "截断正文不得落盘 chapters/");

    // stageResults.blockedCandidateEvidence 必须含 final 路径新字段
    const blockedEv = result.stageResults.blockedCandidateEvidence;
    assert.ok(blockedEv, "stageResults.blockedCandidateEvidence 必须存在");
    assert.equal(blockedEv.saved, true, "artifact 必须成功写入");
    assert.equal(blockedEv.artifactPath, artifactPath, "artifact 路径必须在 traces/ 下");
    // REPAIR 新字段：deliverRaw 路径 selectedSource=raw，finalText=rawText
    assert.ok(blockedEv.candidateId, "candidateId 必须填入（raw 候选 id）");
    assert.equal(blockedEv.selectedSource, "raw", "deliverRaw 路径 selectedSource=raw");
    assert.ok(blockedEv.finalTextSha256, "finalTextSha256 必须填入");
    assert.equal(blockedEv.finalTextLength, RQ4F_TRUNCATED_CH20.length);
    // deliverRaw 路径 finalText=rawText → finalTextSha256 应等于 rawSha256
    assert.equal(blockedEv.finalTextSha256, blockedEv.rawSha256, "deliverRaw finalText=rawText → sha 相同");

    // 从磁盘读回 artifact 并校验完整字段
    assert.equal(existsSync(artifactPath), true, "artifact 文件必须落盘 traces/");
    const loaded = loadBlockedCandidateEvidence(artifactPath);
    assert.ok(loaded, "loadBlockedCandidateEvidence 必须读回 artifact");
    assert.equal(loaded.blocked, true);
    assert.equal(loaded.deliverable, false);
    assert.equal(loaded.blockedStage, "final_text_completeness");
    assert.equal(loaded.candidateId, blockedEv.candidateId);
    assert.equal(loaded.selectedSource, "raw");
    assert.equal(loaded.finalTextSha256, createHash("sha256").update(RQ4F_TRUNCATED_CH20, "utf-8").digest("hex"));
    assert.equal(loaded.finalTextLength, RQ4F_TRUNCATED_CH20.length);
    assert.equal(loaded.rawSha256, createHash("sha256").update(RQ4F_TRUNCATED_CH20, "utf-8").digest("hex"));
    // 被阻断正文（finalText）必须 redact 后保留在 storedText
    assert.ok(loaded.storedText.includes("李一凡"), "storedText 必须保留被阻断正文");
    // artifact 不得含 chapterFilePath / stateCommit
    assert.equal(loaded.chapterFilePath, undefined);
    assert.equal(loaded.stateCommit, undefined);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("REPAIR: 短词干截断 final_text_completeness 阻断同样写入候选上下文 artifact", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "blocked-evidence-tail-"));
  const artifactPath = join(
    projectRoot,
    "workspaces",
    "text-integrity-workspace",
    "traces",
    "ch20-tail-ev-blocked-candidate-evidence.json",
  );
  const truncatedTail = "李一凡把力量压了回去。黑色虚";
  try {
    const result = await withRawOnlyBudget(() =>
      createUnifiedOrchestrator().orchestrate(
        makeInput(projectRoot, "ch20-tail-ev", truncatedTail),
      ),
    );

    assert.equal(result.status, "blocked");
    assert.equal(result.failureEnvelope?.stage, "final_text_completeness");

    const blockedEv = result.stageResults.blockedCandidateEvidence;
    assert.equal(blockedEv.saved, true);
    assert.ok(blockedEv.candidateId, "candidateId 必须填入");
    assert.equal(blockedEv.selectedSource, "raw");
    assert.ok(blockedEv.finalTextSha256);
    assert.equal(blockedEv.finalTextLength, truncatedTail.length);

    const loaded = loadBlockedCandidateEvidence(artifactPath);
    assert.ok(loaded);
    assert.equal(loaded.candidateId, blockedEv.candidateId);
    assert.equal(loaded.selectedSource, "raw");
    assert.equal(loaded.finalTextSha256, createHash("sha256").update(truncatedTail, "utf-8").digest("hex"));
    // 截断 span 必须在诊断 span 中
    const tailSpan = loaded.diagnosticSpans.find((s) => s.excerpt.includes("黑色虚"));
    assert.ok(tailSpan, "诊断 span 必须命中截断尾 '黑色虚'");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// BLOCKED-CANDIDATE-EVIDENCE-CLI-ADOPTION-1: editorial final-stage hard-block
//   集成测试。验证 editorial 候选胜出后被 final_text_completeness hard-block 时，
//   orchestrator 落盘带 selectedSource=editorial 上下文的 blocked evidence artifact。
//
// 设计说明：
// - final_fact_recheck 与 editorial FactGuard 共用同一确定性 checkCandidateFactGuard
//   函数（同 text + 同 input），因此 editorial 通过 FactGuard 后 final_fact_recheck
//   不可能确定性失败（defense-in-depth，正常流程不可触发）。
// - 本测试通过 final_text_completeness（line 1720）触发 editorial 路径 hard-block：
//   editorial 候选含 `？` 钩子（judge 选 editorial）+ 悬空尾句 `和他自己`（completeness 阻断）。
// - 验证 selectedSource=editorial、candidateId=editorial.id、finalTextSha256≠rawSha256。
// ============================================================================

/** raw 正文：合法完整句（无 `？` 钩子），章末平淡 → 触发 chapter_end_pressure 编辑机会 */
const EDITORIAL_PATH_RAW_VALID = [
  "大蛇的身体猛然僵直，随后重重砸进泥水。",
  "李一凡靠着墙坐下，左臂的绷带已经被血浸透。",
  "窗外没有风，冰箱压缩机低低响着。",
  "门外忽然响了三声。",
  "他没有开门，坐在床边休息。",
].join("\n");

/**
 * editorial 正文：含 `？` 钩子（judge 选 editorial）+ 悬空尾句 `和他自己`（completeness 阻断）。
 *
 * 设计要点：`？` 必须紧接 `和他自己`，使 tail = "和他自己"（startsWith 命中），
 * 避免 scanFinalTextCompleteness 的 span 在 endsWith 分支 overshoot（pre-existing edge case）。
 */
const EDITORIAL_PATH_EDITORIAL_TRUNCATED = [
  "大蛇的身体猛然僵直，随后重重砸进泥水。",
  "李一凡靠着墙坐下，左臂的绷带已经被血浸透。",
  "窗外没有风，冰箱压缩机低低响着。",
  "门外忽然响了三声。他没有开门。门外的人到底是谁？和他自己",
].join("\n");

/**
 * 构造支持 editorial 候选路径的复合 stub：
 * - raw_chapter → 返回 rawText（合法完整）
 * - editorial_amplified → 返回 editorialText（含 `？` + 截断尾）
 * - literary_judge → 解析 prompt，含 `？` 的候选胜出
 *
 * judge stub 按 betterMarker=`？` 决定 winner：editorial 含 `？` 而 raw 不含 → editorial 胜。
 */
function makeEditorialPathStub(opts) {
  const { rawText, editorialText, betterMarker = "？" } = opts;
  return async (input) => {
    if (input.kind === "raw_chapter") {
      return { text: rawText, model: "stub-raw", route: input.route, durationMs: 10 };
    }
    if (input.kind === "editorial_amplified") {
      return { text: editorialText, model: "stub-ed", route: input.route, durationMs: 10 };
    }
    if (input.kind === "opportunity_judge") {
      return {
        text: JSON.stringify({
          opportunities: [{
            opportunityType: "chapter_end_pressure",
            diagnosis: "章末因果牵引力不足",
            evidenceExcerpt: "坐在床边休息",
            expectedReaderGain: "增强继续阅读意愿",
            damageRisks: ["可能破坏既定章末事实"],
            confidence: 0.8,
          }],
          noOpReason: null,
        }),
        model: "stub-opportunity",
        route: input.route,
        durationMs: 10,
      };
    }
    if (input.kind === "literary_judge") {
      const aMatch = input.userPrompt.match(/【候选甲】\n+([\s\S]*?)\n+（候选甲总字符数/);
      const bMatch = input.userPrompt.match(/【候选乙】\n+([\s\S]*?)\n+（候选乙总字符数/);
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
        confidence: winner === "tie" ? "uncertain" : "clear",
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

function makeEditorialPathInput(projectRoot, chapterId) {
  return {
    workspaceId: "text-integrity-workspace",
    chapterId,
    chapterNumber: 20,
    projectRoot,
    intent: {
      chapterFunction: "承接战斗余波",
      readerExperience: ["紧张"],
      currentPressure: ["伤势未处理"],
      meaningfulChoices: [],
      promisesToAdvance: [],
      possibleEndPressure: [],
      relevantCharacters: ["李一凡"],
      inviolableFacts: [],
      sourceRefs: ["rq4f:ch20"],
    },
    context: {
      facts: [],
      characterStates: [],
      openLoops: [],
      worldRules: [],
      styleReferences: [],
      sourceMap: [],
      constitution: null,
      longTermState: null,
    },
    constitution: null,
    characterNames: ["李一凡"],
    allowAutomaticLiterarySelection: true,
    modelGenerate: makeEditorialPathStub({
      rawText: EDITORIAL_PATH_RAW_VALID,
      editorialText: EDITORIAL_PATH_EDITORIAL_TRUNCATED,
    }),
  };
}

test("CLI-ADOPTION-1: editorial 胜出后 final_text_completeness hard-block 落盘 selectedSource=editorial artifact", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "blocked-ev-editorial-"));
  const chapterPath = join(
    projectRoot,
    "workspaces",
    "text-integrity-workspace",
    "chapters",
    "ch20-editorial-blocked.md",
  );
  const artifactPath = join(
    projectRoot,
    "workspaces",
    "text-integrity-workspace",
    "traces",
    "ch20-editorial-blocked-blocked-candidate-evidence.json",
  );
  try {
    // editorial 路径需要 raw + editorial + judge 共 3 次模型调用，
    // 不能用 withRawOnlyBudget（SOFT=1/HARD=2 会截断 editorial/judge 调用）。
    // 使用默认预算（SOFT=6/HARD=10）让 editorial 候选正常生成与裁判。
    const result = await createUnifiedOrchestrator().orchestrate(
      makeEditorialPathInput(projectRoot, "ch20-editorial-blocked"),
    );

    // hard block 基本不变量
    assert.equal(result.status, "blocked", "editorial 截断必须 hard block");
    assert.equal(result.failureEnvelope?.stage, "final_text_completeness");
    assert.equal(result.text, "", "blocked 路径 text 必须为空");
    assert.equal(result.chapterFilePath, null, "不得保存章节");
    assert.equal(result.stateCommit, null, "不得提交状态");
    assert.equal(result.candidates.length, 0, "候选不得进入 eligible pair");
    assert.equal(existsSync(chapterPath), false, "截断正文不得落盘 chapters/");

    // stageResults.blockedCandidateEvidence 必须含 editorial 上下文
    const blockedEv = result.stageResults.blockedCandidateEvidence;
    assert.ok(blockedEv, "stageResults.blockedCandidateEvidence 必须存在");
    assert.equal(blockedEv.saved, true, "artifact 必须成功写入");
    assert.equal(blockedEv.artifactPath, artifactPath, "artifact 路径必须在 traces/ 下");

    // REPAIR 核心断言：selectedSource=editorial（不是 raw）
    assert.equal(blockedEv.selectedSource, "editorial", "editorial 胜出路径 selectedSource 必须为 editorial");
    assert.ok(blockedEv.candidateId, "candidateId 必须填入（editorial 候选 id）");
    assert.ok(blockedEv.finalTextSha256, "finalTextSha256 必须填入");

    // editorial 路径 finalText=editorial.text ≠ raw.text → finalTextSha256 ≠ rawSha256
    assert.notEqual(
      blockedEv.finalTextSha256,
      blockedEv.rawSha256,
      "editorial finalText≠rawText → finalTextSha256 必须不同于 rawSha256",
    );
    assert.equal(
      blockedEv.finalTextSha256,
      createHash("sha256").update(EDITORIAL_PATH_EDITORIAL_TRUNCATED, "utf-8").digest("hex"),
      "finalTextSha256 = sha256(editorial.text)",
    );
    assert.equal(
      blockedEv.rawSha256,
      createHash("sha256").update(EDITORIAL_PATH_RAW_VALID, "utf-8").digest("hex"),
      "rawSha256 = sha256(raw.text)",
    );
    assert.equal(blockedEv.finalTextLength, EDITORIAL_PATH_EDITORIAL_TRUNCATED.length);

    // 从磁盘读回 artifact 并校验完整字段
    assert.equal(existsSync(artifactPath), true, "artifact 文件必须落盘 traces/");
    const loaded = loadBlockedCandidateEvidence(artifactPath);
    assert.ok(loaded, "loadBlockedCandidateEvidence 必须读回 artifact");
    assert.equal(loaded.blocked, true);
    assert.equal(loaded.deliverable, false);
    assert.equal(loaded.blockedStage, "final_text_completeness");
    assert.equal(loaded.selectedSource, "editorial", "loaded artifact selectedSource=editorial");
    assert.equal(loaded.candidateId, blockedEv.candidateId);
    assert.equal(loaded.finalTextSha256, createHash("sha256").update(EDITORIAL_PATH_EDITORIAL_TRUNCATED, "utf-8").digest("hex"));
    assert.equal(loaded.finalTextLength, EDITORIAL_PATH_EDITORIAL_TRUNCATED.length);
    assert.notEqual(loaded.finalTextSha256, loaded.rawSha256, "loaded: editorial finalTextSha256 ≠ rawSha256");

    // storedText 必须基于 finalText（editorial.text），不是 rawText
    assert.ok(loaded.storedText.includes("门外的人"), "storedText 必须基于 editorial 正文");
    assert.ok(loaded.storedText.includes("和他自己"), "storedText 必须保留截断尾");

    // 诊断 span 必须命中截断尾 '和他自己'（在 finalText 中定位）
    const tailSpan = loaded.diagnosticSpans.find((s) => s.excerpt.includes("和他自己"));
    assert.ok(tailSpan, "诊断 span 必须命中截断尾 '和他自己'");
    assert.ok(tailSpan.end <= EDITORIAL_PATH_EDITORIAL_TRUNCATED.length, "span 不得越界 finalText");

    // artifact 不得含 chapterFilePath / stateCommit（非交付物）
    assert.equal(loaded.chapterFilePath, undefined);
    assert.equal(loaded.stateCommit, undefined);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
