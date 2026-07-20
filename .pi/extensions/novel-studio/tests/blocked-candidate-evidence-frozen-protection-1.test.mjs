/**
 * BLOCKED-CANDIDATE-EVIDENCE-FROZEN-PROTECTION-1 — 冻结证据不可变机制
 *
 * 阶段：RED → GREEN（HOLD-aware 写入保护）
 *
 * 背景：
 * 2026-07-16 RECOVERY-5 ch3 raw（hash 4a2e...）被 HOLD 清单冻结为
 * HOLD_QUOTE_EXEMPTION_PROD_MISS。随后一次运行直接覆写
 * workspaces/fuben-clean-window-5-20260715/traces/3-blocked-candidate-evidence.json
 * 为 hash 75cf...，原始冻结 raw 永久丢失（workspaces/ 在 .gitignore:87，无 git 历史）。
 *
 * 根因：
 * saveBlockedCandidateEvidence 用 writeFileSync 直接覆盖 artifactPath，
 * 不检查同目录是否存在引用该文件的 HOLD 清单（{chapterId}-hold-*.json）。
 * ch2 的 recovery 链靠脚本显式备份到 .recovery-N.json，ch3 没遵循此模式。
 *
 * 验收口径（用户授权 SKIP+文档+机制修复）：
 * 1. 现存 evidence 文件的 storedSha256 匹配某 HOLD 清单的 frozenSha256
 *    → 该文件被视为冻结证据，saveBlockedCandidateEvidence 拒绝覆盖，
 *    返回 { saved:false, reason:"frozen_evidence_protected", holdManifestPath, frozenSha256, recoveryArtifactPath }。
 * 2. 拒绝覆盖时，原始文件 storedSha256 不变（未被覆盖）。
 * 3. 拒绝覆盖时，recoveryArtifactPath 指向 {chapterId}-blocked-candidate-evidence.recovery-{N}.json，
 *    N 为现有最大 recovery 序号 + 1。
 * 4. saveBlockedCandidateEvidenceToRecoveryPath 写入 recovery 路径，返回 saved:true + recovery artifactPath。
 * 5. 无 HOLD 清单 → 正常覆盖（不触发保护）。
 * 6. HOLD 清单存在但现存文件 hash 已不匹配（已损坏/已被覆盖）→ 不保护，允许覆盖
 *    （冻结证据已丢失，保护无意义；新写入至少恢复 evidence 文件可用性）。
 * 7. 新 evidence 的 storedSha256 与 HOLD frozenSha256 相同（同内容重写）→ 允许写入（幂等）。
 * 8. nodeBlockedEvidenceStore 暴露 readdirSync（HOLD 清单发现依赖）。
 *
 * 边界：
 * - 本地确定性，无 LLM 调用。
 * - 纯模块单测 + fake fs store（支持 readdirSync）。
 * - 不修改正式 workspace 数据；不触碰 chapters/。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createHash } from "node:crypto";

import {
  buildBlockedCandidateEvidence,
  resolveBlockedEvidenceArtifactPath,
  saveBlockedCandidateEvidence,
  saveBlockedCandidateEvidenceToRecoveryPath,
  isFrozenEvidenceProtected,
  findHoldManifestsForChapter,
  resolveRecoveryEvidenceArtifactPath,
  nodeBlockedEvidenceStore,
} from "../dist/v2/core/blocked-candidate-evidence.js";

// ============================================================================
// Helpers
// ============================================================================

function sha256(text) {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

/**
 * 构造 in-memory fake store，支持 readdirSync（HOLD 清单发现）。
 *
 * 注意：node:path.join 在 Windows 上产出反斜杠路径，而测试用例以正斜杠声明 tracesDir。
 * readdirSync 必须同时兼容两种分隔符，否则前缀匹配会全部落空。
 */
function makeFakeStore(opts = {}) {
  const files = new Map();
  const norm = (p) => p.replace(/\\/g, "/").replace(/\/+$/, "");
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
    readdirSync(path) {
      const normalizedDir = norm(path);
      const names = new Set();
      for (const key of files.keys()) {
        const normalizedKey = norm(key);
        if (normalizedKey.startsWith(normalizedDir + "/")) {
          const rest = normalizedKey.slice(normalizedDir.length + 1);
          if (!rest.includes("/")) {
            names.add(rest);
          }
        }
      }
      return Array.from(names);
    },
  };
}

function makeBaseArgs(overrides = {}) {
  return {
    workspaceId: "ws-frozen-protection-test",
    chapterId: "ch-003",
    chapterNumber: 3,
    tracesDir: "/tmp/workspaces/ws-frozen-protection-test/traces",
    blockedStage: "raw_fact_guard",
    blockedReason: "raw 事实硬伤：duplicate_scan 误报",
    severity: "hard",
    rawText: "这是冻结 raw 正文，长度足够以通过 sha256 区分。",
    rawFinishReason: "stop",
    rawMaxTokens: 16384,
    rawModel: "glm-5.2",
    modelVersion: "glm-5.2",
    factGuardErrors: ["duplicate_scan 误报"],
    completenessFindings: [],
    failureEnvelope: {
      stage: "raw_fact_guard",
      severity: "hard",
      reason: "raw 事实硬伤：duplicate_scan 误报",
      recoverable: false,
      degradedTo: "hard_block",
    },
    ...overrides,
  };
}

/** 构造一个 HOLD 清单（schemaId=pinovel.hold-manifest/v1）。 */
function makeHoldManifest(chapterId, frozenSha256, storedTextPath, slug = "quote-exemption-prod-miss") {
  return {
    schemaId: "pinovel.hold-manifest/v1",
    holdState: `HOLD_${slug.toUpperCase().replace(/-/g, "_")}`,
    task: "FACT-GUARD-QUOTE-EXEMPTION-PROD-TRIGGER-1",
    frozenAt: "2026-07-16",
    workspaceId: "ws-frozen-protection-test",
    chapterId,
    chapterNumber: 3,
    frozenEvidence: {
      rawSha256: frozenSha256,
      rawLength: 11571,
      storedTextPath,
      storedTextField: "storedText",
      storedSha256: frozenSha256,
      qualityTracePath: `${storedTextPath.replace("blocked-candidate-evidence", "quality-trace")}`,
      blockedEvidencePath: storedTextPath,
      candidateId: null,
      selectedSource: null,
      finalTextSha256: null,
      finalTextLength: null,
    },
    holdRules: [
      "不得修改冻结 raw（storedText 字段原样保留）",
      "RED fixture 必须使用本冻结 raw",
    ],
  };
}

/** 写入一个 evidence 文件到 fake store。 */
function writeEvidenceFile(store, artifactPath, evidence) {
  store.writeFileSync(artifactPath, JSON.stringify(evidence, null, 2));
}

// ============================================================================
// 测试
// ============================================================================

test("RED: nodeBlockedEvidenceStore 暴露 readdirSync（HOLD 清单发现依赖）", () => {
  assert.equal(
    typeof nodeBlockedEvidenceStore.readdirSync,
    "function",
    "nodeBlockedEvidenceStore 必须暴露 readdirSync 以支持 HOLD 清单发现",
  );
});

test("RED: findHoldManifestsForChapter 发现 {chapterId}-hold-*.json 并解析 schemaId", () => {
  const store = makeFakeStore();
  const tracesDir = "/tmp/workspaces/ws/hold-test/traces";
  const chapterId = "ch-003";
  const frozenSha = sha256("frozen raw text");
  const evidencePath = resolveBlockedEvidenceArtifactPath(tracesDir, chapterId);

  const hold = makeHoldManifest(chapterId, frozenSha, evidencePath);
  store.writeFileSync(join(tracesDir, `${chapterId}-hold-quote-exemption-prod-miss.json`), JSON.stringify(hold, null, 2));
  // 不相关文件
  store.writeFileSync(join(tracesDir, "4-hold-other.json"), JSON.stringify({ schemaId: "pinovel.hold-manifest/v1" }, null, 2));
  store.writeFileSync(join(tracesDir, `${chapterId}-quality-trace.json`), "{}");

  const manifests = findHoldManifestsForChapter(tracesDir, chapterId, store);
  assert.equal(manifests.length, 1, `应发现 1 个 ch-003 的 HOLD 清单。实际：${manifests.length}`);
  assert.equal(manifests[0].holdState, hold.holdState);
  assert.equal(manifests[0].frozenEvidence.storedSha256, frozenSha);
  assert.ok(manifests[0].manifestPath, "manifest 应携带 manifestPath（用于审计）");
  assert.match(manifests[0].manifestPath, /ch-003-hold-.*\.json$/);
});

test("RED: isFrozenEvidenceProtected — 现存文件 hash 匹配 HOLD frozenSha → protected=true", () => {
  const store = makeFakeStore();
  const tracesDir = "/tmp/workspaces/ws/protect-test/traces";
  const chapterId = "ch-003";
  const frozenSha = sha256("frozen raw text");
  const evidencePath = resolveBlockedEvidenceArtifactPath(tracesDir, chapterId);

  // 现存 evidence 文件 hash == HOLD frozenSha
  const existingEvidence = buildBlockedCandidateEvidence(makeBaseArgs({ rawText: "frozen raw text" }));
  writeEvidenceFile(store, evidencePath, existingEvidence);

  const hold = makeHoldManifest(chapterId, frozenSha, evidencePath);
  store.writeFileSync(join(tracesDir, `${chapterId}-hold-quote-exemption-prod-miss.json`), JSON.stringify(hold, null, 2));

  const result = isFrozenEvidenceProtected(tracesDir, chapterId, store);
  assert.equal(result.protected, true, "现存文件 hash 匹配 HOLD frozenSha 时应 protected=true");
  assert.equal(result.frozenSha256, frozenSha);
  assert.ok(result.holdManifestPath, "应返回 holdManifestPath");
});

test("RED: isFrozenEvidenceProtected — 无 HOLD 清单 → protected=false", () => {
  const store = makeFakeStore();
  const tracesDir = "/tmp/workspaces/ws/no-hold/traces";
  const chapterId = "ch-003";
  const evidencePath = resolveBlockedEvidenceArtifactPath(tracesDir, chapterId);

  const existingEvidence = buildBlockedCandidateEvidence(makeBaseArgs());
  writeEvidenceFile(store, evidencePath, existingEvidence);

  const result = isFrozenEvidenceProtected(tracesDir, chapterId, store);
  assert.equal(result.protected, false, "无 HOLD 清单应 protected=false");
});

test("RED: isFrozenEvidenceProtected — HOLD 存在但现存文件 hash 不匹配（已损坏）→ protected=false", () => {
  const store = makeFakeStore();
  const tracesDir = "/tmp/workspaces/ws/corrupted/traces";
  const chapterId = "ch-003";
  const frozenSha = sha256("original frozen raw text");
  const evidencePath = resolveBlockedEvidenceArtifactPath(tracesDir, chapterId);

  // 现存文件已被覆写为不同 hash
  const corruptedEvidence = buildBlockedCandidateEvidence(makeBaseArgs({ rawText: "overwritten different text" }));
  writeEvidenceFile(store, evidencePath, corruptedEvidence);

  const hold = makeHoldManifest(chapterId, frozenSha, evidencePath);
  store.writeFileSync(join(tracesDir, `${chapterId}-hold-quote-exemption-prod-miss.json`), JSON.stringify(hold, null, 2));

  const result = isFrozenEvidenceProtected(tracesDir, chapterId, store);
  assert.equal(
    result.protected,
    false,
    "HOLD 存在但现存文件 hash 不匹配（冻结证据已丢失）时应 protected=false，允许覆盖恢复可用性",
  );
});

test("RED: saveBlockedCandidateEvidence — 冻结证据被保护，拒绝覆盖，返回 frozen_evidence_protected + recoveryArtifactPath", () => {
  const store = makeFakeStore();
  const tracesDir = "/tmp/workspaces/ws/refuse-overwrite/traces";
  const chapterId = "ch-003";
  const frozenSha = sha256("frozen raw text");
  const evidencePath = resolveBlockedEvidenceArtifactPath(tracesDir, chapterId);

  // 1. 写入冻结 evidence（hash = frozenSha）
  const frozenEvidence = buildBlockedCandidateEvidence(makeBaseArgs({ rawText: "frozen raw text", tracesDir }));
  writeEvidenceFile(store, evidencePath, frozenEvidence);

  // 2. 写入 HOLD 清单
  const hold = makeHoldManifest(chapterId, frozenSha, evidencePath);
  store.writeFileSync(join(tracesDir, `${chapterId}-hold-quote-exemption-prod-miss.json`), JSON.stringify(hold, null, 2));

  // 3. 尝试用不同 hash 覆盖
  const newEvidence = buildBlockedCandidateEvidence(makeBaseArgs({ rawText: "new different raw text", tracesDir }));
  assert.notEqual(newEvidence.storedSha256, frozenSha, "新 evidence hash 应不同于冻结 hash");

  const result = saveBlockedCandidateEvidence(newEvidence, store);
  assert.equal(result.saved, false, "冻结证据被保护时应 saved=false");
  assert.equal(result.reason, "frozen_evidence_protected");
  assert.equal(result.frozenSha256, frozenSha);
  assert.ok(result.holdManifestPath, "应返回 holdManifestPath");
  assert.ok(result.recoveryArtifactPath, "应返回 recoveryArtifactPath");
  assert.match(
    result.recoveryArtifactPath,
    new RegExp(`${chapterId}-blocked-candidate-evidence\\.recovery-\\d+\\.json$`),
  );

  // 4. 原始文件未被覆盖
  const originalContent = store.readFileSync(evidencePath);
  const originalParsed = JSON.parse(originalContent);
  assert.equal(
    originalParsed.storedSha256,
    frozenSha,
    "原始冻结文件 storedSha256 必须不变（未被覆盖）",
  );
});

test("RED: saveBlockedCandidateEvidence — 同 hash 幂等写入（新 evidence hash == frozenSha）→ 允许", () => {
  const store = makeFakeStore();
  const tracesDir = "/tmp/workspaces/ws/idempotent/traces";
  const chapterId = "ch-003";
  const frozenSha = sha256("frozen raw text");
  const evidencePath = resolveBlockedEvidenceArtifactPath(tracesDir, chapterId);

  const frozenEvidence = buildBlockedCandidateEvidence(makeBaseArgs({ rawText: "frozen raw text", tracesDir }));
  writeEvidenceFile(store, evidencePath, frozenEvidence);

  const hold = makeHoldManifest(chapterId, frozenSha, evidencePath);
  store.writeFileSync(join(tracesDir, `${chapterId}-hold-quote-exemption-prod-miss.json`), JSON.stringify(hold, null, 2));

  // 同 hash 重新写入（幂等）
  const result = saveBlockedCandidateEvidence(frozenEvidence, store);
  assert.equal(result.saved, true, "同 hash 幂等写入应允许（不触发保护）");
  assert.equal(result.artifactPath, evidencePath);
});

test("RED: saveBlockedCandidateEvidence — 无 HOLD 清单 → 正常覆盖", () => {
  const store = makeFakeStore();
  const tracesDir = "/tmp/workspaces/ws/no-hold-overwrite/traces";
  const chapterId = "ch-003";
  const evidencePath = resolveBlockedEvidenceArtifactPath(tracesDir, chapterId);

  const original = buildBlockedCandidateEvidence(makeBaseArgs({ rawText: "original text", tracesDir }));
  writeEvidenceFile(store, evidencePath, original);

  const newEvidence = buildBlockedCandidateEvidence(makeBaseArgs({ rawText: "new text", tracesDir }));
  const result = saveBlockedCandidateEvidence(newEvidence, store);
  assert.equal(result.saved, true, "无 HOLD 清单应正常覆盖");
  assert.equal(result.artifactPath, evidencePath);

  const content = JSON.parse(store.readFileSync(evidencePath));
  assert.equal(content.storedSha256, newEvidence.storedSha256, "文件应被新 evidence 覆盖");
});

test("RED: saveBlockedCandidateEvidence — HOLD 存在但现存文件已损坏 → 允许覆盖恢复", () => {
  const store = makeFakeStore();
  const tracesDir = "/tmp/workspaces/ws/recover-corrupted/traces";
  const chapterId = "ch-003";
  const frozenSha = sha256("original frozen raw text");
  const evidencePath = resolveBlockedEvidenceArtifactPath(tracesDir, chapterId);

  const corrupted = buildBlockedCandidateEvidence(makeBaseArgs({ rawText: "overwritten corrupted text", tracesDir }));
  writeEvidenceFile(store, evidencePath, corrupted);

  const hold = makeHoldManifest(chapterId, frozenSha, evidencePath);
  store.writeFileSync(join(tracesDir, `${chapterId}-hold-quote-exemption-prod-miss.json`), JSON.stringify(hold, null, 2));

  const newEvidence = buildBlockedCandidateEvidence(makeBaseArgs({ rawText: "recovery attempt text", tracesDir }));
  const result = saveBlockedCandidateEvidence(newEvidence, store);
  assert.equal(result.saved, true, "HOLD 存在但现存文件已损坏时应允许覆盖恢复可用性");
});

test("RED: resolveRecoveryEvidenceArtifactPath — 序号自增（无现有 recovery → recovery-1）", () => {
  const store = makeFakeStore();
  const tracesDir = "/tmp/workspaces/ws/recovery-path-1/traces";
  const chapterId = "ch-003";

  const path = resolveRecoveryEvidenceArtifactPath(tracesDir, chapterId, store);
  assert.match(
    path,
    new RegExp(`${chapterId}-blocked-candidate-evidence\\.recovery-1\\.json$`),
    "无现有 recovery 文件时应返回 recovery-1.json",
  );
});

test("RED: resolveRecoveryEvidenceArtifactPath — 序号自增（现有 recovery-1, recovery-2 → recovery-3）", () => {
  const store = makeFakeStore();
  const tracesDir = "/tmp/workspaces/ws/recovery-path-3/traces";
  const chapterId = "ch-003";

  store.writeFileSync(join(tracesDir, `${chapterId}-blocked-candidate-evidence.recovery-1.json`), "{}");
  store.writeFileSync(join(tracesDir, `${chapterId}-blocked-candidate-evidence.recovery-2.json`), "{}");
  store.writeFileSync(join(tracesDir, `${chapterId}-quality-trace.json`), "{}");

  const path = resolveRecoveryEvidenceArtifactPath(tracesDir, chapterId, store);
  assert.match(
    path,
    new RegExp(`${chapterId}-blocked-candidate-evidence\\.recovery-3\\.json$`),
    "现有 recovery-1/2 时应返回 recovery-3.json",
  );
});

test("RED: saveBlockedCandidateEvidenceToRecoveryPath — 写入 recovery 路径，返回 saved:true", () => {
  const store = makeFakeStore();
  const tracesDir = "/tmp/workspaces/ws/save-recovery/traces";
  const chapterId = "ch-003";

  const newEvidence = buildBlockedCandidateEvidence(makeBaseArgs({ rawText: "recovery raw text", tracesDir }));

  const result = saveBlockedCandidateEvidenceToRecoveryPath(newEvidence, store);
  assert.equal(result.saved, true, "应成功写入 recovery 路径");
  assert.match(
    result.artifactPath,
    new RegExp(`${chapterId}-blocked-candidate-evidence\\.recovery-1\\.json$`),
  );

  // recovery 文件内容完整
  const content = JSON.parse(store.readFileSync(result.artifactPath));
  assert.equal(content.schemaId, newEvidence.schemaId);
  assert.equal(content.storedSha256, newEvidence.storedSha256);
  assert.equal(content.artifactPath, result.artifactPath, "recovery evidence 的 artifactPath 应更新为 recovery 路径");
});

test("RED: saveBlockedCandidateEvidenceToRecoveryPath — 不影响冻结原始文件", () => {
  const store = makeFakeStore();
  const tracesDir = "/tmp/workspaces/ws/save-recovery-keep-original/traces";
  const chapterId = "ch-003";
  const frozenSha = sha256("frozen raw text");
  const evidencePath = resolveBlockedEvidenceArtifactPath(tracesDir, chapterId);

  const frozenEvidence = buildBlockedCandidateEvidence(makeBaseArgs({ rawText: "frozen raw text", tracesDir }));
  writeEvidenceFile(store, evidencePath, frozenEvidence);

  const newEvidence = buildBlockedCandidateEvidence(makeBaseArgs({ rawText: "new recovery text", tracesDir }));
  const result = saveBlockedCandidateEvidenceToRecoveryPath(newEvidence, store);
  assert.equal(result.saved, true);

  // 原始冻结文件不变
  const original = JSON.parse(store.readFileSync(evidencePath));
  assert.equal(original.storedSha256, frozenSha, "原始冻结文件 storedSha256 必须不变");
});
