/**
 * BLOCKED-CANDIDATE-EVIDENCE-1：hard-block 候选安全证据留存测试
 *
 * 验收口径（派工计划 P0-A）：
 * - blocked raw 保留完整文本（redacted）、SHA-256、长度、finishReason、诊断 span
 * - text/finalText 仍为空；chapter file 不存在；state commit=0
 * - artifact 明确 blocked/non-deliverable
 * - chapter.save/state.commit 不得触发；candidate 不得进入 eligible pair
 * - secret/<think> 必须 redact
 * - artifact 写入失败不得放行正文（仍 hard block，报告 blocked_evidence_unavailable）
 * - Review CLI 可读取
 *
 * 边界：本地确定性，无 LLM 调用；纯模块单测 + fake fs store。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  buildBlockedCandidateEvidence,
  buildDiagnosticSpans,
  resolveBlockedEvidenceArtifactPath,
  saveBlockedCandidateEvidence,
  loadBlockedCandidateEvidence,
  BLOCKED_CANDIDATE_EVIDENCE_SCHEMA_ID,
} from "../dist/v2/core/blocked-candidate-evidence.js";

// ============================================================================
// Helpers
// ============================================================================

function sha256(text) {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

/** 构造 in-memory fake store，记录所有写入。 */
function makeFakeStore(opts = {}) {
  const files = new Map();
  return {
    files,
    writeFileSync(path, content) {
      if (opts.throwOnWrite) {
        throw new Error(opts.throwOnWrite);
      }
      files.set(path, content);
    },
    readFileSync(path) {
      if (!files.has(path)) {
        const e = new Error("ENOENT");
        e.code = "ENOENT";
        throw e;
      }
      return files.get(path);
    },
    existsSync(path) {
      return files.has(path);
    },
    mkdirSync() {
      // no-op
    },
  };
}

function makeBaseArgs(overrides = {}) {
  return {
    workspaceId: "ws-blocked-test",
    chapterId: "ch-021",
    chapterNumber: 21,
    tracesDir: "/tmp/workspaces/ws-blocked-test/traces",
    blockedStage: "raw_fact_guard",
    blockedReason: "raw 事实硬伤：deceased character 铁山在当前时线行动",
    severity: "hard",
    rawText: "这是 raw 正文，长度足够。" ,
    rawFinishReason: "stop",
    rawMaxTokens: 16384,
    rawModel: "glm-5.2",
    modelVersion: "glm-5.2",
    factGuardErrors: ["deceased character 铁山在当前时线行动"],
    completenessFindings: [],
    failureEnvelope: {
      stage: "raw_fact_guard",
      severity: "hard",
      reason: "raw 事实硬伤：deceased character 铁山在当前时线行动",
      recoverable: false,
      degradedTo: "hard_block",
    },
    ...overrides,
  };
}

// ============================================================================
// 1. schema 与字段完整性
// ============================================================================

test("buildBlockedCandidateEvidence 产出符合 schema 的 blocked/non-deliverable artifact", () => {
  const args = makeBaseArgs();
  const ev = buildBlockedCandidateEvidence(args);

  assert.equal(ev.schemaId, BLOCKED_CANDIDATE_EVIDENCE_SCHEMA_ID);
  assert.equal(ev.schemaId, "pinovel.blocked-candidate-evidence/v1");
  assert.equal(ev.blocked, true, "blocked 必须 true");
  assert.equal(ev.deliverable, false, "deliverable 必须 false");
  assert.equal(ev.workspaceId, "ws-blocked-test");
  assert.equal(ev.chapterId, "ch-021");
  assert.equal(ev.chapterNumber, 21);
  assert.equal(ev.blockedStage, "raw_fact_guard");
  assert.equal(ev.severity, "hard");
  assert.equal(ev.failureEnvelope.degradedTo, "hard_block");
  assert.equal(ev.failureEnvelope.recoverable, false);
  assert.ok(ev.createdAt, "createdAt 必须存在");
  assert.ok(ev.artifactPath.endsWith("ch-021-blocked-candidate-evidence.json"));
});

// ============================================================================
// 2. SHA-256 / 长度 / finishReason / modelVersion 保留
// ============================================================================

test("rawSha256 = sha256(original rawText)，rawLength = 原文长度，finishReason/modelVersion 保留", () => {
  const rawText = "第一段正文。第二段正文。第三段正文。".repeat(10);
  const args = makeBaseArgs({ rawText, rawFinishReason: "length", rawMaxTokens: 8192, rawModel: "glm-5.2", modelVersion: "glm-5.2" });
  const ev = buildBlockedCandidateEvidence(args);

  assert.equal(ev.rawSha256, sha256(rawText), "rawSha256 必须是原文 sha256");
  assert.equal(ev.rawLength, rawText.length, "rawLength 必须是原文长度");
  assert.equal(ev.rawFinishReason, "length");
  assert.equal(ev.rawMaxTokens, 8192);
  assert.equal(ev.rawModel, "glm-5.2");
  assert.equal(ev.modelVersion, "glm-5.2");
});

// ============================================================================
// 3. secret / <think> redaction
// ============================================================================

test("rawText 中的 sk-XXX / Bearer / <think> 必须被 redact，redactionLog 记录", () => {
  const rawText = [
    "正常正文一句。",
    "API key 是 sk-abcdefghijklmnopqrstuvwxyz 在请求头里。",
    "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig",
    "<think>这是模型内部推理，不应泄露。</think>",
    "正文继续。",
  ].join("\n");
  const args = makeBaseArgs({ rawText });
  const ev = buildBlockedCandidateEvidence(args);

  assert.ok(ev.storedText.includes("[REDACTED:api-key]"), "sk-XXX 必须 redact");
  assert.ok(ev.storedText.includes("[REDACTED:bearer-token]"), "Bearer 必须 redact");
  assert.ok(ev.storedText.includes("[REDACTED:internal-reasoning]"), "<think> 必须 redact");
  assert.ok(!ev.storedText.includes("sk-abcdefghijklmnopqrstuvwxyz"), "原 key 不得残留");
  assert.ok(!ev.storedText.includes("eyJhbGciOiJIUzI1NiJ9.payload.sig"), "原 token 不得残留");
  assert.ok(!ev.storedText.includes("这是模型内部推理，不应泄露。"), "内部推理不得残留");
  assert.ok(ev.redactionLog.length >= 3, "redactionLog 至少 3 条");
  assert.ok(ev.storedSha256, "storedSha256 必须存在");
  assert.equal(ev.storedSha256, sha256(ev.storedText), "storedSha256 = sha256(storedText)");
  // 原文 sha 仍保留（不受 redaction 影响）
  assert.equal(ev.rawSha256, sha256(rawText));
});

test("正常正文不被误 redact", () => {
  const rawText = "李一凡走进深潭，水冷得刺骨。他攥紧碎片，没有回头。";
  const args = makeBaseArgs({ rawText });
  const ev = buildBlockedCandidateEvidence(args);
  assert.equal(ev.storedText, rawText, "无 secret 时 storedText 应等于原文");
  assert.equal(ev.redactionLog.length, 0);
});

// ============================================================================
// 4. diagnostic spans
// ============================================================================

test("buildDiagnosticSpans 从 factGuard 错误与 completeness findings 生成 span", () => {
  const rawText = "前文。铁山抢走了苏念的玉佩。后文。";
  const spans = buildDiagnosticSpans(rawText, {
    factGuardErrors: ["铁山抢走了苏念的玉佩（已死角色当前时线行动）"],
    completenessFindings: [{ reason: "疑似截断", kind: "truncation", anchor: "玉佩" }],
  });

  assert.ok(spans.length >= 1, "至少生成 1 个 span");
  for (const s of spans) {
    assert.ok(typeof s.start === "number" && s.start >= 0);
    assert.ok(typeof s.end === "number" && s.end > s.start);
    assert.ok(s.kind, "kind 必须存在");
    assert.ok(s.excerpt, "excerpt 必须存在");
    assert.ok(s.reason, "reason 必须存在");
    assert.ok(s.end <= rawText.length, "span 不得越界");
    assert.ok(rawText.slice(s.start, s.end) === s.excerpt || s.excerpt.includes("..."), "excerpt 必须来自原文");
  }
});

test("buildDiagnosticSpans 找不到 anchor 时仍记录 kind/reason 但标记 unresolved", () => {
  const spans = buildDiagnosticSpans("短正文", {
    factGuardErrors: ["某不存在的锚点字符串 xyz123abc"],
    completenessFindings: [],
  });
  assert.ok(spans.length >= 1);
  assert.equal(spans[0].resolved, false);
  assert.ok(spans[0].reason);
});

// ============================================================================
// 5. artifact 路径隔离（不写 chapters/，只写 traces/）
// ============================================================================

test("resolveBlockedEvidenceArtifactPath 写入 traces/ 下，绝不写入 chapters/", () => {
  const tracesDir = "/tmp/workspaces/ws/traces";
  const path = resolveBlockedEvidenceArtifactPath(tracesDir, "ch-021");
  assert.ok(path.includes("traces"), "必须在 traces/ 下");
  assert.ok(!path.includes("chapters"), "不得在 chapters/ 下");
  assert.ok(path.endsWith("ch-021-blocked-candidate-evidence.json"));
});

// ============================================================================
// 6. save / load round-trip
// ============================================================================

test("saveBlockedCandidateEvidence 写入 JSON，loadBlockedCandidateEvidence 读回一致", () => {
  const store = makeFakeStore();
  const args = makeBaseArgs();
  const ev = buildBlockedCandidateEvidence(args);
  const saveRes = saveBlockedCandidateEvidence(ev, store);

  assert.equal(saveRes.saved, true);
  assert.equal(saveRes.artifactPath, ev.artifactPath);
  assert.ok(store.files.has(ev.artifactPath), "store 必须有写入");

  const loaded = loadBlockedCandidateEvidence(ev.artifactPath, store);
  assert.ok(loaded, "loaded 不得为 null");
  assert.equal(loaded.schemaId, ev.schemaId);
  assert.equal(loaded.blocked, true);
  assert.equal(loaded.deliverable, false);
  assert.equal(loaded.rawSha256, ev.rawSha256);
  assert.equal(loaded.rawLength, ev.rawLength);
  assert.equal(loaded.rawFinishReason, ev.rawFinishReason);
  assert.equal(loaded.blockedStage, ev.blockedStage);
  assert.equal(loaded.failureEnvelope.degradedTo, "hard_block");
  assert.deepEqual(loaded.diagnosticSpans, ev.diagnosticSpans);
});

test("loadBlockedCandidateEvidence 文件缺失返回 null", () => {
  const store = makeFakeStore();
  const loaded = loadBlockedCandidateEvidence("/tmp/missing.json", store);
  assert.equal(loaded, null);
});

test("loadBlockedCandidateEvidence 损坏 JSON 返回结构化错误，不抛异常", () => {
  const store = makeFakeStore();
  const path = "/tmp/workspaces/ws/traces/ch-021-blocked-candidate-evidence.json";
  store.writeFileSync(path, "{ not valid json }}}");
  const loaded = loadBlockedCandidateEvidence(path, store);
  assert.equal(loaded, null, "损坏时返回 null（调用方降级为 blocked_evidence_unavailable）");
});

// ============================================================================
// 7. 写入失败不得放行正文（仍 hard block）
// ============================================================================

test("saveBlockedCandidateEvidence 写入抛异常时返回 blocked_evidence_unavailable，不抛出", () => {
  const store = makeFakeStore({ throwOnWrite: "disk full" });
  const args = makeBaseArgs();
  const ev = buildBlockedCandidateEvidence(args);

  let res;
  assert.doesNotThrow(() => {
    res = saveBlockedCandidateEvidence(ev, store);
  }, "写入失败不得抛异常（调用方保持 hard block）");

  assert.equal(res.saved, false);
  assert.equal(res.reason, "blocked_evidence_unavailable");
  assert.ok(res.error, "error 字段必须存在");
});

// ============================================================================
// 8. Case07 风格 fixture：长 raw + "铁山抢走" 诊断 span，完整文本保留
// ============================================================================

test("Case07 风格：长 raw 与 '铁山抢走' 诊断 span 被完整保留", () => {
  // 模拟 Case07 场景：7678 字 raw 中含 "铁山抢走" 触发已死角色当前时线行动
  const head = "心魔界第二十一章。".repeat(2);
  const diagSentence = "铁山抢走了玉衡星的魂，已经送进深渊。";
  const tail = "后续正文继续推进。".repeat(50);
  const rawText = head + diagSentence + tail;

  const args = makeBaseArgs({
    rawText,
    chapterId: "ch-021-case07",
    blockedStage: "raw_fact_guard",
    blockedReason: "deceased character 铁山当前时线行动",
    factGuardErrors: ["铁山抢走了玉衡星的魂（已死角色当前时线行动）"],
    completenessFindings: [],
  });
  const ev = buildBlockedCandidateEvidence(args);

  assert.equal(ev.rawLength, rawText.length, "完整长度保留");
  assert.equal(ev.rawSha256, sha256(rawText), "完整 sha 保留");
  assert.equal(ev.blocked, true);
  assert.equal(ev.deliverable, false);

  // 诊断 span 必须命中 "铁山抢走"
  const tieShanSpan = ev.diagnosticSpans.find((s) => s.excerpt.includes("铁山"));
  assert.ok(tieShanSpan, "必须捕获 '铁山' 诊断 span");
  assert.ok(tieShanSpan.excerpt.includes("铁山抢走"), "excerpt 必须包含 '铁山抢走'");
  assert.ok(tieShanSpan.end <= rawText.length, "span 不得越界");

  // 完整 redacted 文本保留（供复盘）
  assert.ok(ev.storedText.includes("铁山抢走"), "storedText 必须保留 '铁山抢走' 原文");
  assert.ok(ev.storedText.length >= rawText.length - 10, "storedText 长度应接近原文");
});

// ============================================================================
// 9. 不触发 chapter.save / state.commit（模块设计边界）
// ============================================================================

test("模块不得触碰 chapters/ 路径或 state commit（hardBlock 边界不变）", () => {
  const store = makeFakeStore();
  const args = makeBaseArgs();
  const ev = buildBlockedCandidateEvidence(args);
  saveBlockedCandidateEvidence(ev, store);

  // 只写了一个文件，且在 traces/ 下
  assert.equal(store.files.size, 1, "只写一个 artifact 文件");
  const writtenPath = [...store.files.keys()][0];
  assert.ok(writtenPath.includes("traces"), "写入路径必须在 traces/");
  assert.ok(!writtenPath.includes("chapters"), "不得写入 chapters/");

  const written = JSON.parse(store.files.get(writtenPath));
  assert.equal(written.blocked, true);
  assert.equal(written.deliverable, false);
  // artifact 不得包含 chapterFilePath / stateCommit 字段（非交付物）
  assert.equal(written.chapterFilePath, undefined, "blocked evidence 不得含 chapterFilePath");
  assert.equal(written.stateCommit, undefined, "blocked evidence 不得含 stateCommit");
});

// ============================================================================
// 10. 不同 blockedStage（raw_generation 空 / final_text_completeness）
// ============================================================================

test("raw_generation 空 raw 不保存正文但记录 blocked（无 rawText 时 storedText 为空）", () => {
  const args = makeBaseArgs({
    rawText: "",
    blockedStage: "raw_generation",
    blockedReason: "raw 生成返回空文本",
    severity: "fatal",
    rawFinishReason: null,
    factGuardErrors: [],
    completenessFindings: [],
  });
  const ev = buildBlockedCandidateEvidence(args);

  assert.equal(ev.blocked, true);
  assert.equal(ev.deliverable, false);
  assert.equal(ev.rawLength, 0);
  assert.equal(ev.storedText, "");
  assert.equal(ev.rawFinishReason, null);
  assert.equal(ev.severity, "fatal");
  assert.equal(ev.diagnosticSpans.length, 0, "无 rawText 时无诊断 span");
});

test("final_text_completeness 截断场景：finishReason + completeness findings 保留", () => {
  const rawText = "正文开始。".repeat(500) + "突然截断在半句";
  const args = makeBaseArgs({
    rawText,
    blockedStage: "final_text_completeness",
    blockedReason: "raw 正文疑似模型截断",
    severity: "hard",
    rawFinishReason: "length",
    factGuardErrors: [],
    completenessFindings: [{ reason: "末句未闭合，疑似 max_tokens 截断", kind: "truncation", anchor: "突然截断在半句" }],
  });
  const ev = buildBlockedCandidateEvidence(args);

  assert.equal(ev.blockedStage, "final_text_completeness");
  assert.equal(ev.rawFinishReason, "length");
  assert.ok(ev.diagnosticSpans.length >= 1, "completeness finding 必须生成 span");
  const truncSpan = ev.diagnosticSpans.find((s) => s.kind === "truncation" || s.kind === "completeness_truncation");
  assert.ok(truncSpan, "必须有截断 span");
  assert.ok(truncSpan.excerpt.includes("突然截断"), "截断 span excerpt 必须命中截断位置");
});

// ============================================================================
// 11. BLOCKED-CANDIDATE-EVIDENCE-1-REPAIR: final candidate hard-block 上下文字段
//     覆盖 final_fact_recheck / final_text_completeness(final) / atomic_save / control_plane_*(final)
//     路径新增的 candidateId / selectedSource / finalTextSha256 / finalTextLength 字段。
// ============================================================================

test("REPAIR: raw 路径不传 candidateId/selectedSource/finalText 时新字段默认 null（向后兼容）", () => {
  const args = makeBaseArgs(); // 不传 final 路径字段
  const ev = buildBlockedCandidateEvidence(args);

  assert.equal(ev.candidateId, null, "raw 路径 candidateId 默认 null");
  assert.equal(ev.selectedSource, null, "raw 路径 selectedSource 默认 null");
  assert.equal(ev.finalTextSha256, null, "raw 路径 finalTextSha256 默认 null");
  assert.equal(ev.finalTextLength, null, "raw 路径 finalTextLength 默认 null");
  // storedText 仍基于 rawText（向后兼容不变）
  assert.equal(ev.storedText, args.rawText);
  assert.equal(ev.rawSha256, sha256(args.rawText));
  assert.equal(ev.blocked, true);
  assert.equal(ev.deliverable, false);
});

test("REPAIR: final 路径传入 finalText 时 storedText/diagnosticSpans 基于 finalText 而非 rawText", () => {
  const rawText = "raw 原文，无诊断点。";
  const finalText = "final 候选正文，铁山抢走了玉佩。";
  const args = makeBaseArgs({
    rawText,
    blockedStage: "final_fact_recheck",
    blockedReason: "最终正文事实硬伤：铁山抢走了玉佩",
    factGuardErrors: ["铁山抢走了玉佩（已死角色当前时线行动）"],
    candidateId: "cand-editorial-001",
    selectedSource: "editorial",
    finalText,
  });
  const ev = buildBlockedCandidateEvidence(args);

  // 新字段填入
  assert.equal(ev.candidateId, "cand-editorial-001");
  assert.equal(ev.selectedSource, "editorial");
  assert.equal(ev.finalTextSha256, sha256(finalText), "finalTextSha256 = sha256(finalText)");
  assert.equal(ev.finalTextLength, finalText.length);

  // storedText 基于 finalText（被阻断正文），不是 rawText
  assert.equal(ev.storedText, finalText, "storedText 必须基于 finalText");
  assert.notEqual(ev.storedText, rawText, "storedText 不得回退到 rawText");

  // rawSha256 仍是原始 raw 身份指纹（不受 finalText 影响）
  assert.equal(ev.rawSha256, sha256(rawText), "rawSha256 仍是原始 raw 指纹");

  // 诊断 span 在 finalText 中定位（不在 rawText）
  const diagSpan = ev.diagnosticSpans.find((s) => s.excerpt.includes("铁山"));
  assert.ok(diagSpan, "诊断 span 必须命中 finalText 中的 '铁山'");
  assert.ok(diagSpan.end <= finalText.length, "span 不得越界 finalText");
  assert.equal(diagSpan.excerpt, finalText.slice(diagSpan.start, diagSpan.end), "excerpt 必须来自 finalText");
});

test("REPAIR: selectedSource=editorial 且 finalText≠rawText 时 finalTextSha256≠rawSha256", () => {
  const rawText = "raw 原文 A。";
  const finalText = "editorial 候选正文 B。";
  const args = makeBaseArgs({
    rawText,
    blockedStage: "final_text_completeness",
    candidateId: "cand-ed-002",
    selectedSource: "editorial",
    finalText,
  });
  const ev = buildBlockedCandidateEvidence(args);

  assert.notEqual(ev.finalTextSha256, ev.rawSha256, "editorial finalText 与 rawText 不同 → sha 必须不同");
  assert.equal(ev.finalTextSha256, sha256(finalText));
  assert.equal(ev.rawSha256, sha256(rawText));
});

test("REPAIR: deliverRaw 路径 selectedSource=raw 且 finalText=rawText 时 finalTextSha256=rawSha256", () => {
  const rawText = "raw 即最终正文。";
  const args = makeBaseArgs({
    rawText,
    blockedStage: "final_text_completeness",
    candidateId: "cand-raw-003",
    selectedSource: "raw",
    finalText: rawText, // deliverRaw: finalText === rawText
  });
  const ev = buildBlockedCandidateEvidence(args);

  assert.equal(ev.selectedSource, "raw");
  assert.equal(ev.finalTextSha256, ev.rawSha256, "deliverRaw 路径 finalText=rawText → sha 相同");
  assert.equal(ev.finalTextSha256, sha256(rawText));
  assert.equal(ev.finalTextLength, rawText.length);
});

test("REPAIR: final 路径 finalText 中的 secret/<think> 仍被 redact（基于 finalText 而非 rawText）", () => {
  const rawText = "raw 干净正文。";
  const finalText = [
    "editorial 候选正文。",
    "密钥 sk-abcdefghij1234567890 泄露。",
    "<think>内部推理</think>",
    "结尾。",
  ].join("\n");
  const args = makeBaseArgs({
    rawText,
    blockedStage: "final_fact_recheck",
    candidateId: "cand-ed-004",
    selectedSource: "editorial",
    finalText,
    factGuardErrors: [],
  });
  const ev = buildBlockedCandidateEvidence(args);

  assert.ok(ev.storedText.includes("[REDACTED:api-key]"), "finalText 中 sk- 必须 redact");
  assert.ok(ev.storedText.includes("[REDACTED:internal-reasoning]"), "finalText 中 <think> 必须 redact");
  assert.ok(!ev.storedText.includes("sk-abcdefghij1234567890"), "原 key 不得残留");
  assert.ok(!ev.storedText.includes("内部推理"), "内部推理不得残留");
  // rawText 无 secret，身份指纹不受影响
  assert.equal(ev.rawSha256, sha256(rawText));
  // finalTextSha256 基于未 redact 的 finalText（身份指纹，与 storedSha256 不同）
  assert.equal(ev.finalTextSha256, sha256(finalText));
  assert.notEqual(ev.finalTextSha256, ev.storedSha256, "finalTextSha256（身份）≠ storedSha256（redacted 存储）");
});

test("REPAIR: final 路径空 finalText 回退到 raw 路径行为（finalText='' 视为未提供）", () => {
  const rawText = "raw 原文。";
  const args = makeBaseArgs({
    rawText,
    candidateId: "cand-x",
    selectedSource: "raw",
    finalText: "", // 空字符串视为 raw 路径
  });
  const ev = buildBlockedCandidateEvidence(args);

  assert.equal(ev.finalTextSha256, null, "空 finalText → finalTextSha256=null（raw 路径）");
  assert.equal(ev.finalTextLength, null);
  assert.equal(ev.storedText, rawText, "空 finalText → storedText 回退 rawText");
  // candidateId/selectedSource 仍保留（调用方显式传入）
  assert.equal(ev.candidateId, "cand-x");
  assert.equal(ev.selectedSource, "raw");
});

test("REPAIR: save/load round-trip 保留 final 路径新字段，artifact 不含 chapterFilePath/stateCommit", () => {
  const store = makeFakeStore();
  const rawText = "raw 原文。";
  const finalText = "editorial 候选正文，铁山行动。";
  const args = makeBaseArgs({
    rawText,
    blockedStage: "final_fact_recheck",
    factGuardErrors: ["铁山行动"],
    candidateId: "cand-ed-rt",
    selectedSource: "editorial",
    finalText,
  });
  const ev = buildBlockedCandidateEvidence(args);
  const saveRes = saveBlockedCandidateEvidence(ev, store);
  assert.equal(saveRes.saved, true);

  const loaded = loadBlockedCandidateEvidence(ev.artifactPath, store);
  assert.ok(loaded, "loaded 不得为 null");
  assert.equal(loaded.candidateId, "cand-ed-rt");
  assert.equal(loaded.selectedSource, "editorial");
  assert.equal(loaded.finalTextSha256, sha256(finalText));
  assert.equal(loaded.finalTextLength, finalText.length);
  assert.equal(loaded.rawSha256, sha256(rawText));
  assert.equal(loaded.blocked, true);
  assert.equal(loaded.deliverable, false);
  // artifact 仍不含 chapterFilePath / stateCommit（blocked 路径无交付物）
  assert.equal(loaded.chapterFilePath, undefined, "blocked evidence 不得含 chapterFilePath");
  assert.equal(loaded.stateCommit, undefined, "blocked evidence 不得含 stateCommit");
  // 只写一个 artifact 文件，且在 traces/ 下
  assert.equal(store.files.size, 1);
  const writtenPath = [...store.files.keys()][0];
  assert.ok(writtenPath.includes("traces"));
  assert.ok(!writtenPath.includes("chapters"));
});
