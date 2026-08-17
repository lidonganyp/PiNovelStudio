/**
 * RED 测试：模型内部推理 / 外部验证 / 最小修订边界（REASONING-REPAIR-BOUNDARY-1 Wave 0 / RRB-0.4）
 *
 * 每个测试断言**期望契约**，针对当前实现应当稳定失败（RED），从而证明六项 P0 缺口：
 *
 *   G1 证据权威   —— finding.sourceRef 只是 diagnostic ID；EvidenceRecord.sourceContentHash 恒为空
 *   G2 修订权限   —— span ≥40% 时 localReplacement=false，静默升级为整章输出
 *   G3 候选不可变 —— CandidateWorkspace.writeDraft() 覆盖 draft.md，旧正文不可回放
 *   G4 多 span    —— evaluatePatch 只对 [proposal.targetSpan] 单 span 校验同一 patchedText
 *   G5 新 hard    —— reverify 后 currentText = patchedText 无条件推进；只按 finding 数量判断进展
 *   G6 调用计量   —— 同步 verifier.verify() 被累计进 verifyModelCalls / modelCallsByKind.verify
 *
 * RED → GREEN 语义：Phase 1~4 落地后，下面断言所针对的“坏模式”应从源码/运行时移除，
 * 测试随之转绿。运行时断言（G2/G3）直接调用生产 API；结构断言（G1/G4/G5/G6）沿用
 * dependency-boundary.test.mjs 的 readFileSync + 字符串断言模式，读取 .ts 源码锁定。
 *
 * 注意：结构断言只锁定特定坏模式字符串；重构后若以不同写法重现同一缺陷，测试可能假绿。
 * Phase 1~4 各工作包落地时应同步把对应断言升级为更精确的行为断言。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { createCandidatePatchService } from "../dist/novelos/agent/candidate-patch-service.js";
import { createCandidateWorkspace } from "../dist/novelos/agent/candidate-workspace.js";

const EXT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 读取扩展根目录下的源码文件（结构断言的锁定目标）。 */
function readSource(relPath) {
  return readFileSync(join(EXT_ROOT, relPath), "utf-8");
}

// ============================================================================
// G1 — 证据权威：sourceRef 不得是裸 diagnostic.id；sourceContentHash 不得恒为空
// ============================================================================

test("G1: finding.sourceRef 不得是裸 diagnostic.id（须为可回源证据引用）", () => {
  const src = readSource("novelos/verification/narrative-verifier-suite.ts");
  assert.ok(
    !src.includes("sourceRef: diagnostic.id"),
    "narrative-verifier-suite.ts 仍把 diagnostic.id 直接写入 sourceRef；" +
      "diagnostic.id 只能作 finding identity，权威引用须经 EvidenceRecord 回源（RRB-1.2）",
  );
});

test("G1: EvidenceRecord.sourceContentHash 不得硬编码为空串", () => {
  const src = readSource("v2/core/evidence-record-adapter.ts");
  assert.ok(
    !src.includes('sourceContentHash: ""'),
    "evidence-record-adapter.ts 仍把 sourceContentHash 硬编码为空；" +
      "自动修订准入要求 non-empty sourceContentHash + evidenceExcerptHash（RRB-1.1）",
  );
});

// ============================================================================
// G2 — 修订权限：span ≥40% 不得静默升级为整章输出
// ============================================================================

test("G2: span ≥40% 不得被静默升级为整章重写", () => {
  const svc = createCandidatePatchService();
  const draft = "甲".repeat(100); // 100 字
  const feedback = {
    findingId: "f-entity-1",
    span: { start: 10, end: 60, excerpt: "" }, // 50 字 = 50% 正文
    conflictFact: "未在角色档案中的实体",
    sourceRef: "evidence:char:1",
    failureType: "entity_hallucination",
    confidence: 1,
    allowedRepairRange: { start: 10, end: 60, excerpt: "" },
    repairSuggestion: "替换为已知角色",
    certainty: "deterministic",
    coverageStatus: "missing",
  };

  const proposal = svc.proposePatch(draft, feedback);

  // 期望：50% span 要么保持局部修复，要么被拒绝，绝不能被标记为整章输出。
  // 当前实现：localReplacement=false（`spanLength < draft.length * 0.4` 不成立）→ 整章重写。
  assert.ok(
    proposal.localReplacement === true || proposal.rejected === true,
    "span ≥40% 时 localReplacement=false 会路由到 buildFullRewritePrompt（整章输出）；" +
      "span 过大只能拒绝、缩小授权或走显式 new_candidate（RRB-3.1）",
  );
});

// ============================================================================
// G3 — 候选不可变：writeDraft 覆盖旧正文，旧候选不可回放
// ============================================================================

test("G3: 连续两次 writeDraft 后首版正文必须仍可回放", () => {
  const root = mkdtempSync(join(tmpdir(), "rrb-red-g3-"));
  try {
    const ws = createCandidateWorkspace({ workspaceRoot: root, sessionId: "s1" });
    ws.writeDraft("first-draft-甲");
    ws.writeDraft("second-draft-乙");

    // 期望：每次正文变化都产生不可变子候选，首版必须保留在 candidates/ 子目录。
    // 旧实现：draft.md 被覆盖为 second-draft-乙，first-draft-甲 无处回放。
    const dir = ws.getDir();
    const candidatesDir = join(dir, "candidates");
    const artifacts = (existsSync(candidatesDir) ? readdirSync(candidatesDir) : [])
      .filter((f) => f.endsWith(".md"))
      .map((f) => readFileSync(join(candidatesDir, f), "utf-8"));

    assert.ok(
      artifacts.some((c) => c.includes("first-draft-甲")),
      "writeDraft 覆盖了旧正文，首版候选不可回放；" +
        "应迁移为 createCandidate() + advanceCurrentCandidate() 的 append-only 谱系（RRB-2.2）",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// G4 — 多 span：immutability 须对本轮全部授权 span 联合校验
// ============================================================================

test("G4: evaluatePatch 不得只对单 proposal span 校验（须联合全部授权 span）", () => {
  const src = readSource("novelos/agent/candidate-patch-service.ts");
  assert.ok(
    !src.includes("checkSpanImmutability(originalDraft, patchedText, [proposal.targetSpan])"),
    "evaluatePatch 仍以 [proposal.targetSpan] 单 span 校验同一 patchedText；" +
      "应把本轮全部 authorizedRanges 规范化后一次性联合校验（RRB-3.3）",
  );
});

// ============================================================================
// G5 — 新 hard finding：reverify 后不得无条件推进 currentText / 只按数量判进展
// ============================================================================

test("G5: reverify 后 currentText 不得无条件指向 patchedText", () => {
  const src = readSource("novelos/agent/narrative-agent-loop.ts");
  assert.ok(
    !src.includes("currentText = patchedText"),
    "verifyAndPatch 仍无条件 currentText = patchedText；" +
      "新增 hard finding 时整轮应拒绝，current pointer 保持不变（RRB-3.6 / RRB-3.7）",
  );
});

test("G5: 进展判断不得只比较 finding 数量", () => {
  const src = readSource("novelos/agent/narrative-agent-loop.ts");
  assert.ok(
    !src.includes("nextFindingIds.size < previousFindingIds.size"),
    "进展仍只按 finding 数量比较；" +
      "应比较 finding identity/severity/evidence/candidate hash，同数量但 identity 换新不得视为进展（RRB-4.5）",
  );
});

// ============================================================================
// G6 — 调用计量：本地 validator 不得计作 model call
// ============================================================================

test("G6: 本地 verifier 运行不得累计进 verifyModelCalls", () => {
  const src = readSource("novelos/agent/narrative-agent-loop.ts");
  assert.ok(
    !src.includes("verifyModelCalls += 1"),
    "同步 verifier.verify() 仍被手工累计进 verifyModelCalls；" +
      "应拆分为 validatorRuns 与真实 modelCalls，模型 wrapper 是 model call 唯一计数点（RRB-4.1 / RRB-4.3）",
  );
});

test("G6: modelCallsByKind 不得包含旧 verify 口径", () => {
  const src = readSource("novelos/agent/narrative-agent-loop.ts");
  assert.ok(
    !src.includes("verify: verifyModelCalls"),
    "modelCallsByKind 仍含 verify 口径；" +
      "应收敛为 draft/patch/newCandidate/authorStyle 真实模型调用，删除旧 verify 字段（RRB-4.1 / RRB-4.7）",
  );
});
