/**
 * BlockedCandidateEvidence — hard-block 候选安全证据留存（BLOCKED-CANDIDATE-EVIDENCE-1，派工计划 P0-A）
 *
 * 目标：在 raw/candidate 被事实 hard block 时，保留足以复盘的只读候选证据，
 * 而不保存章节、不提交状态、不泄露敏感信息。
 *
 * 核心不变量（派工计划 P0-A acceptance / negative verification）：
 * - blocked raw 保留完整文本（secret/<think> redacted 后）、SHA-256、长度、finishReason、诊断 span。
 * - artifact 明确 blocked=true / deliverable=false；不写 chapterFilePath / stateCommit。
 * - chapter.save/state.commit 不得触发；本模块只写 traces/ 下隔离 artifact，不触碰 chapters/。
 * - candidate 不得进入 eligible pair（由 hardBlock 返回 candidates:[] 保证，本模块不涉及）。
 * - secret/`<think>` 必须 redact（复用 review-surface-cli.redactSecrets）。
 * - artifact 写入失败不得放行正文：返回 blocked_evidence_unavailable，调用方保持 hard block。
 * - Review CLI 可读取（loadBlockedCandidateEvidence）。
 *
 * 边界（L0 工程闭环）：
 * - 本地确定性，无 LLM 调用。
 * - 不修改 finalText；不提交状态；不是 gate；不阻断正文生成（hardBlock 已阻断，本模块只补证据）。
 * - fs 操作通过 BlockedEvidenceStore 注入，便于单测注入 fake store。
 */

import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { redactSecrets } from "./review-surface-cli.js";

// ============================================================================
// 常量
// ============================================================================

export const BLOCKED_CANDIDATE_EVIDENCE_SCHEMA_ID = "pinovel.blocked-candidate-evidence/v1" as const;

// ============================================================================
// 数据契约
// ============================================================================

/**
 * 诊断 span：从 FactGuard 错误 / completeness findings 中提取的可定位证据片段。
 */
export interface BlockedDiagnosticSpan {
  /** span 在原文中的起始位置（未命中时为 0） */
  start: number;
  /** span 在原文中的结束位置（未命中时为 0） */
  end: number;
  /** 诊断类型：fact_guard_violation / truncation / completeness_truncation 等 */
  kind: string;
  /** span 原文片段（命中时为 rawText.slice(start,end)；未命中时为空串） */
  excerpt: string;
  /** 关联的证据/原因（来自 factGuard error 或 completeness finding reason） */
  reason: string;
  /** 是否在 rawText 中定位到证据 span */
  resolved: boolean;
}

/**
 * hard-block 候选安全证据 artifact。
 *
 * 字段说明：
 * - blocked/deliverable：明确是非交付物，Review CLI 与 trace 据此区分。
 * - rawSha256/rawLength：原始 raw 的身份指纹（不受 redaction 影响）。
 * - storedText：redacted 后的完整正文（secret/<think> 已过滤），供复盘读取。
 * - storedSha256：storedText 的 sha256，便于校验存储完整性。
 * - candidateId/selectedSource/finalTextSha256/finalTextLength：
 *   BLOCKED-CANDIDATE-EVIDENCE-1-REPAIR 新增，仅 final 路径阻断时填入；
 *   raw 路径（raw_generation/raw_fact_guard/final_text_completeness@raw）为 null。
 *   final 路径下 storedText 基于 finalText（被阻断的最终候选正文）redact，
 *   finalTextSha256 = sha256(finalText)，当 selectedSource="editorial" 时与 rawSha256 不同。
 * - 不含 chapterFilePath / stateCommit：blocked 路径无章节文件、无状态提交。
 */
export interface BlockedCandidateEvidence {
  schemaId: typeof BLOCKED_CANDIDATE_EVIDENCE_SCHEMA_ID;
  workspaceId: string;
  chapterId: string;
  chapterNumber: number;
  /** 阻断 stage（与 FailureEnvelope.stage 一致） */
  blockedStage: string;
  /** 阻断原因（与 FailureEnvelope.reason 一致） */
  blockedReason: string;
  /** 阻断严重度 */
  severity: "fatal" | "hard";
  /** artifact 写入路径（traces/ 下） */
  artifactPath: string;
  /** 明确为阻断产物 */
  blocked: true;
  /** 明确为非交付物 */
  deliverable: false;
  /** 原始 raw 的 SHA-256（身份指纹） */
  rawSha256: string;
  /** 原始 raw 长度（字符数） */
  rawLength: number;
  /** redacted 后的完整正文 */
  storedText: string;
  /** storedText 的 SHA-256（存储完整性校验） */
  storedSha256: string;
  /** raw 完成原因（finish_reason） */
  rawFinishReason: string | null;
  /** raw 最大 token 预算 */
  rawMaxTokens: number | null;
  /** raw 实际模型名 */
  rawModel: string | null;
  /** raw 模型版本（detectModelVersion 结果，隔离策略信誉） */
  modelVersion: string | null;
  /** 诊断 span */
  diagnosticSpans: BlockedDiagnosticSpan[];
  /** redaction 日志 */
  redactionLog: string[];
  /** 创建时间戳（ISO） */
  createdAt: string;
  /** 失败 envelope 摘要（与 trace failureEnvelope 一致） */
  failureEnvelope: {
    stage: string;
    severity: string;
    reason: string;
    recoverable: boolean;
    degradedTo: string;
  };
  // ── BLOCKED-CANDIDATE-EVIDENCE-1-REPAIR: final candidate hard-block 上下文 ──
  // 仅 final_fact_recheck / final_text_completeness(final) / atomic_save / control_plane_*(final)
  // 路径填入；raw 路径为 null。
  /** 被阻断的最终候选 ID（final 路径；raw 路径或无候选时为 null） */
  candidateId?: string | null;
  /** 被阻断候选的来源（final 路径；raw 路径为 null） */
  selectedSource?: "raw" | "editorial" | null;
  /**
   * 被阻断的最终正文 SHA-256。
   * - raw 路径为 null（与 rawSha256 一致，不重复）
   * - final 路径 = sha256(finalText)，当 selectedSource="editorial" 时与 rawSha256 不同
   */
  finalTextSha256?: string | null;
  /** 被阻断的最终正文长度（final 路径；raw 路径为 null） */
  finalTextLength?: number | null;
}

/**
 * fs 存储抽象（便于单测注入 fake store）。
 *
 * `readdirSync` 为可选方法：HOLD 清单发现（frozen evidence 不可变保护）依赖它；
 * 旧 fake store 未实现时不触发保护（视为无 HOLD 清单），保持向后兼容。
 */
export interface BlockedEvidenceStore {
  writeFileSync(path: string, content: string): void;
  readFileSync(path: string): string;
  existsSync(path: string): boolean;
  mkdirSync(path: string, opts?: { recursive: boolean }): void;
  readdirSync?(path: string): string[];
  /** CONCURRENCY-WAVE4：过期清理用（可选，未实现时 prune 跳过过期检查） */
  statSync?(path: string): { mtimeMs: number };
  unlinkSync?(path: string): void;
}

/** 默认 node 同步 fs store。 */
export const nodeBlockedEvidenceStore: BlockedEvidenceStore = {
  writeFileSync,
  readFileSync: (path) => readFileSync(path, "utf-8"),
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
};

// ============================================================================
// 纯函数
// ============================================================================

/**
 * redact raw 文本中的 secret 与私有思维（复用 review-surface-cli.redactSecrets）。
 */
export function redactRawText(rawText: string): { storedText: string; redactionLog: string[] } {
  const { redacted, log } = redactSecrets(rawText);
  return { storedText: redacted, redactionLog: log };
}

/**
 * 计算原始 raw 文本的 SHA-256（身份指纹，不受 redaction 影响）。
 */
export function computeRawSha256(rawText: string): string {
  return createHash("sha256").update(rawText, "utf-8").digest("hex");
}

/**
 * 从 FactGuard 错误与 completeness findings 提取可定位的诊断 span。
 *
 * - factGuard 错误：剥离括号注释后，在 rawText 中查找最长匹配子串；命中则 resolved=true。
 * - completeness findings：用 anchor 在 rawText 中定位；命中则 resolved=true。
 * - 未命中仍记录 span（resolved=false），保留 reason 供人工复盘。
 */
export function buildDiagnosticSpans(
  rawText: string,
  inputs: {
    factGuardErrors: string[];
    completenessFindings?: Array<{
      reason: string;
      kind: string;
      anchor?: string;
      /** 预解析 span（如 completeness guard 已计算 start/end）；提供时优先使用，避免重复 indexOf */
      span?: { start: number; end: number };
    }>;
  },
): BlockedDiagnosticSpan[] {
  const spans: BlockedDiagnosticSpan[] = [];

  for (const err of inputs.factGuardErrors) {
    const hit = findLongestMatchingSubstring(err, rawText);
    if (hit) {
      spans.push({
        start: hit.start,
        end: hit.end,
        kind: "fact_guard_violation",
        excerpt: rawText.slice(hit.start, hit.end),
        reason: err,
        resolved: true,
      });
    } else {
      spans.push({
        start: 0,
        end: 0,
        kind: "fact_guard_violation",
        excerpt: "",
        reason: err,
        resolved: false,
      });
    }
  }

  for (const finding of inputs.completenessFindings ?? []) {
    // 优先使用预解析 span（精确，避免 indexOf 命中首次出现的偏置）
    if (finding.span && finding.span.end > finding.span.start && finding.span.end <= rawText.length) {
      spans.push({
        start: finding.span.start,
        end: finding.span.end,
        kind: finding.kind,
        excerpt: rawText.slice(finding.span.start, finding.span.end),
        reason: finding.reason,
        resolved: true,
      });
      continue;
    }
    const anchor = finding.anchor ?? "";
    const idx = anchor ? rawText.indexOf(anchor) : -1;
    if (idx >= 0) {
      spans.push({
        start: idx,
        end: idx + anchor.length,
        kind: finding.kind,
        excerpt: rawText.slice(idx, idx + anchor.length),
        reason: finding.reason,
        resolved: true,
      });
    } else {
      spans.push({
        start: 0,
        end: 0,
        kind: finding.kind,
        excerpt: "",
        reason: finding.reason,
        resolved: false,
      });
    }
  }

  return spans;
}

/**
 * 解析 blocked evidence artifact 路径（traces/ 下，与 quality-trace.json 同目录）。
 */
export function resolveBlockedEvidenceArtifactPath(tracesDir: string, chapterId: string): string {
  return join(tracesDir, `${chapterId}-blocked-candidate-evidence.json`);
}

/**
 * 构造 BlockedCandidateEvidence（纯函数，无 fs 副作用）。
 *
 * BLOCKED-CANDIDATE-EVIDENCE-1-REPAIR：
 * - raw 路径（raw_generation/raw_fact_guard/final_text_completeness@raw）只传 rawText，
 *   storedText/diagnosticSpans 基于 rawText，candidateId/selectedSource/finalTextSha256 为 null。
 * - final 路径（final_fact_recheck/final_text_completeness@final/atomic_save/control_plane@final）
 *   传 rawText（原始 raw 身份）+ finalText（被阻断的最终候选正文）+ candidateId + selectedSource。
 *   storedText/diagnosticSpans 基于 finalText（被阻断正文），finalTextSha256 = sha256(finalText)。
 *   当 selectedSource="editorial" 时 finalTextSha256 与 rawSha256 不同。
 */
export function buildBlockedCandidateEvidence(args: {
  workspaceId: string;
  chapterId: string;
  chapterNumber: number;
  tracesDir: string;
  blockedStage: string;
  blockedReason: string;
  severity: "fatal" | "hard";
  rawText: string;
  rawFinishReason: string | null;
  rawMaxTokens: number | null;
  rawModel: string | null;
  modelVersion: string | null;
  factGuardErrors: string[];
  completenessFindings?: Array<{ reason: string; kind: string; anchor?: string }>;
  failureEnvelope: {
    stage: string;
    severity: string;
    reason: string;
    recoverable: boolean;
    degradedTo: string;
  };
  // BLOCKED-CANDIDATE-EVIDENCE-1-REPAIR: final candidate hard-block 上下文
  /** 被阻断的最终候选 ID（final 路径；raw 路径省略或 null） */
  candidateId?: string | null;
  /** 被阻断候选的来源（final 路径；raw 路径省略或 null） */
  selectedSource?: "raw" | "editorial" | null;
  /**
   * 被阻断的最终正文（final 路径）。
   * 提供时 storedText/diagnosticSpans 基于 finalText redact/定位，
   * finalTextSha256 = sha256(finalText)；省略时回退到 rawText（raw 路径，向后兼容）。
   */
  finalText?: string | null;
}): BlockedCandidateEvidence {
  // 确定"被阻断正文"：final 路径用 finalText，raw 路径回退到 rawText。
  const isFinalPath = args.finalText != null && args.finalText.length > 0;
  const blockedText = isFinalPath ? (args.finalText as string) : args.rawText;

  const { storedText, redactionLog } = redactRawText(blockedText);
  const diagnosticSpans = buildDiagnosticSpans(blockedText, {
    factGuardErrors: args.factGuardErrors,
    completenessFindings: args.completenessFindings,
  });
  return {
    schemaId: BLOCKED_CANDIDATE_EVIDENCE_SCHEMA_ID,
    workspaceId: args.workspaceId,
    chapterId: args.chapterId,
    chapterNumber: args.chapterNumber,
    blockedStage: args.blockedStage,
    blockedReason: args.blockedReason,
    severity: args.severity,
    artifactPath: resolveBlockedEvidenceArtifactPath(args.tracesDir, args.chapterId),
    blocked: true,
    deliverable: false,
    rawSha256: computeRawSha256(args.rawText),
    rawLength: args.rawText.length,
    storedText,
    storedSha256: computeRawSha256(storedText),
    rawFinishReason: args.rawFinishReason,
    rawMaxTokens: args.rawMaxTokens,
    rawModel: args.rawModel,
    modelVersion: args.modelVersion,
    diagnosticSpans,
    redactionLog,
    createdAt: new Date().toISOString(),
    failureEnvelope: args.failureEnvelope,
    candidateId: args.candidateId ?? null,
    selectedSource: args.selectedSource ?? null,
    finalTextSha256: isFinalPath ? computeRawSha256(args.finalText as string) : null,
    finalTextLength: isFinalPath ? (args.finalText as string).length : null,
  };
}

// ============================================================================
// HOLD-aware 冻结证据不可变保护（BLOCKED-CANDIDATE-EVIDENCE-FROZEN-PROTECTION-1）
// ============================================================================
//
// 背景：2026-07-16 RECOVERY-5 ch3 raw（hash 4a2e...）被 HOLD 清单冻结为
// HOLD_QUOTE_EXEMPTION_PROD_MISS。随后一次运行直接覆写
// workspaces/fuben-clean-window-5-20260715/traces/3-blocked-candidate-evidence.json
// 为 hash 75cf...，原始冻结 raw 永久丢失（workspaces/ 在 .gitignore:87，无 git 历史）。
//
// 根因：saveBlockedCandidateEvidence 用 writeFileSync 直接覆盖 artifactPath，
// 不检查同目录是否存在引用该文件的 HOLD 清单（{chapterId}-hold-*.json）。
// ch2 的 recovery 链靠脚本显式备份到 .recovery-N.json，ch3 没遵循此模式。
//
// 修复：写入前检查同目录是否存在引用该 evidence 文件且 frozenSha256 匹配现存文件 hash 的
// HOLD 清单。匹配时拒绝覆盖，调用方应改走 saveBlockedCandidateEvidenceToRecoveryPath。
// 已损坏（hash 不匹配）的现存文件不保护——冻结证据已丢失，保护无意义，允许覆盖恢复可用性。

/**
 * HOLD 清单（pinovel.hold-manifest/v1）的最小消费契约。
 *
 * 实际清单字段更多（holdState/task/frozenEvidence/holdRules 等），这里只声明
 * 本模块消费所需的字段，避免与生成端 schema 强耦合。
 */
export interface HoldManifest {
  schemaId: "pinovel.hold-manifest/v1";
  /** HOLD 状态标识（如 HOLD_QUOTE_EXEMPTION_PROD_MISS） */
  holdState?: string;
  chapterId?: string;
  /** 冻结证据指纹；与本模块的 storedSha256 对齐 */
  frozenEvidence?: {
    storedSha256?: string;
    rawSha256?: string;
    storedTextPath?: string;
    blockedEvidencePath?: string;
    [k: string]: unknown;
  };
  /** 由 findHoldManifestsForChapter 注入，便于审计 */
  manifestPath?: string;
  [k: string]: unknown;
}

/**
 * 发现 tracesDir 下属于指定 chapter 的 HOLD 清单。
 *
 * 命名约定：`{chapterId}-hold-*.json`（如 `3-hold-quote-exemption-prod-miss.json`）。
 * 解析失败的清单被静默跳过（不抛异常），返回 manifestPath 供审计。
 *
 * 当 store 未实现 readdirSync（旧 fake store）时返回空数组，保持向后兼容。
 */
export function findHoldManifestsForChapter(
  tracesDir: string,
  chapterId: string,
  store: BlockedEvidenceStore,
): HoldManifest[] {
  if (typeof store.readdirSync !== "function") return [];
  let entries: string[];
  try {
    entries = store.readdirSync(tracesDir);
  } catch {
    return [];
  }
  const prefix = `${chapterId}-hold-`;
  const manifests: HoldManifest[] = [];
  for (const name of entries) {
    if (typeof name !== "string") continue;
    if (!name.startsWith(prefix)) continue;
    if (!name.endsWith(".json")) continue;
    const manifestPath = join(tracesDir, name);
    try {
      const raw = store.readFileSync(manifestPath);
      const parsed = JSON.parse(raw) as HoldManifest;
      if (parsed && parsed.schemaId === "pinovel.hold-manifest/v1") {
        parsed.manifestPath = manifestPath;
        manifests.push(parsed);
      }
    } catch {
      // 损坏清单跳过，不影响其他清单发现
    }
  }
  return manifests;
}

/**
 * 判断现存 evidence 文件是否被某 HOLD 清单冻结（即"冻结证据"），不得覆盖。
 *
 * 保护条件（同时满足）：
 * 1. 存在属于本章的 HOLD 清单，且其 frozenEvidence.storedSha256 非空。
 * 2. 现存 evidence 文件存在。
 * 3. 现存 evidence 文件的 storedSha256 与某 HOLD frozenSha256 匹配。
 *
 * 不保护的情况：
 * - 无 HOLD 清单 → protected=false（正常覆盖）。
 * - HOLD 存在但现存文件不存在 → protected=false（首次写入）。
 * - HOLD 存在但现存文件 hash 已不匹配（已被损坏/覆盖）→ protected=false
 *   （冻结证据已丢失，保护无意义；允许覆盖恢复可用性）。
 * - store 未实现 readdirSync → protected=false（视为无 HOLD 清单）。
 *
 * 返回多 HOLD 命中时优先第一个匹配的清单（同 raw 通常只对应一个 HOLD 状态）。
 */
export function isFrozenEvidenceProtected(
  tracesDir: string,
  chapterId: string,
  store: BlockedEvidenceStore,
): { protected: true; holdManifestPath: string; frozenSha256: string } | { protected: false } {
  const manifests = findHoldManifestsForChapter(tracesDir, chapterId, store);
  if (manifests.length === 0) return { protected: false };

  const evidencePath = resolveBlockedEvidenceArtifactPath(tracesDir, chapterId);
  if (!store.existsSync(evidencePath)) return { protected: false };

  let existingSha: string;
  try {
    const content = store.readFileSync(evidencePath);
    const parsed = JSON.parse(content) as { storedSha256?: string };
    existingSha = parsed.storedSha256 ?? "";
  } catch {
    return { protected: false };
  }
  if (!existingSha) return { protected: false };

  for (const m of manifests) {
    const frozenSha = m.frozenEvidence?.storedSha256;
    if (typeof frozenSha === "string" && frozenSha.length > 0 && frozenSha === existingSha) {
      return { protected: true, holdManifestPath: m.manifestPath ?? "", frozenSha256: frozenSha };
    }
  }
  return { protected: false };
}

/**
 * 解析 recovery evidence artifact 路径：`{chapterId}-blocked-candidate-evidence.recovery-{N}.json`，
 * N 为现有最大 recovery 序号 + 1（无现有 recovery → 1）。
 *
 * 当 store 未实现 readdirSync 时回退为 recovery-1.json。
 */
export function resolveRecoveryEvidenceArtifactPath(
  tracesDir: string,
  chapterId: string,
  store: BlockedEvidenceStore,
): string {
  let maxN = 0;
  if (typeof store.readdirSync === "function") {
    let entries: string[];
    try {
      entries = store.readdirSync(tracesDir);
    } catch {
      entries = [];
    }
    const base = `${chapterId}-blocked-candidate-evidence.recovery-`;
    for (const name of entries) {
      if (typeof name !== "string") continue;
      if (!name.startsWith(base)) continue;
      if (!name.endsWith(".json")) continue;
      const nStr = name.slice(base.length, -".json".length);
      const n = parseInt(nStr, 10);
      if (Number.isFinite(n) && n > maxN) maxN = n;
    }
  }
  return join(tracesDir, `${chapterId}-blocked-candidate-evidence.recovery-${maxN + 1}.json`);
}

// ============================================================================
// fs I/O（注入 store）
// ============================================================================

/** saveBlockedCandidateEvidence 的成功返回。 */
export interface SaveBlockedEvidenceOk {
  saved: true;
  artifactPath: string;
}

/** saveBlockedCandidateEvidence 的写入失败返回（保持 hard block）。 */
export interface SaveBlockedEvidenceUnavailable {
  saved: false;
  error: string;
  reason: "blocked_evidence_unavailable";
}

/**
 * saveBlockedCandidateEvidence 的冻结证据保护返回。
 *
 * 当现存 evidence 文件被某 HOLD 清单冻结，且新 evidence 的 storedSha256 与冻结 hash 不同时触发。
 * 调用方应改走 saveBlockedCandidateEvidenceToRecoveryPath 写入 recovery 路径，
 * 原始冻结文件保持不变。
 */
export interface SaveBlockedEvidenceFrozenProtected {
  saved: false;
  reason: "frozen_evidence_protected";
  /** 触发保护的 HOLD 清单路径（审计） */
  holdManifestPath: string;
  /** 冻结证据 storedSha256 */
  frozenSha256: string;
  /** 建议的 recovery artifact 路径（已计算，调用方可直接使用） */
  recoveryArtifactPath: string;
}

/** saveBlockedCandidateEvidence 返回类型。 */
export type SaveBlockedEvidenceResult =
  | SaveBlockedEvidenceOk
  | SaveBlockedEvidenceUnavailable
  | SaveBlockedEvidenceFrozenProtected;

/**
 * 保存 blocked evidence artifact。
 *
 * - 写入失败不得放行正文：返回 { saved: false, reason: "blocked_evidence_unavailable" }，
 *   调用方保持 hard block。
 * - 冻结证据保护：现存文件被 HOLD 清单冻结且新 hash 不同 → 拒绝覆盖，返回
 *   { saved: false, reason: "frozen_evidence_protected", holdManifestPath, frozenSha256, recoveryArtifactPath }。
 *   调用方应改走 saveBlockedCandidateEvidenceToRecoveryPath。原始冻结文件保持不变。
 *   同 hash 幂等写入允许（不触发保护）。
 *   现存文件已损坏（hash 不匹配）时允许覆盖恢复可用性。
 * - 不抛异常（hardBlock 路径不应被证据保存失败二次打断）。
 */
export function saveBlockedCandidateEvidence(
  evidence: BlockedCandidateEvidence,
  store: BlockedEvidenceStore = nodeBlockedEvidenceStore,
): SaveBlockedEvidenceResult {
  try {
    const dir = dirname(evidence.artifactPath);
    // 冻结证据保护检查：artifactPath 所在 tracesDir 与 chapterId 从 evidence 推断
    const tracesDir = dir;
    const chapterId = evidence.chapterId;
    const protection = isFrozenEvidenceProtected(tracesDir, chapterId, store);
    if (
      protection.protected &&
      evidence.storedSha256 !== protection.frozenSha256
    ) {
      const recoveryArtifactPath = resolveRecoveryEvidenceArtifactPath(tracesDir, chapterId, store);
      return {
        saved: false,
        reason: "frozen_evidence_protected",
        holdManifestPath: protection.holdManifestPath,
        frozenSha256: protection.frozenSha256,
        recoveryArtifactPath,
      };
    }
    store.mkdirSync(dir, { recursive: true });
    store.writeFileSync(evidence.artifactPath, JSON.stringify(evidence, null, 2));
    return { saved: true, artifactPath: evidence.artifactPath };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { saved: false, error: msg, reason: "blocked_evidence_unavailable" };
  }
}

/**
 * 加载 blocked evidence artifact（供 Review CLI 读取）。
 *
 * - 文件缺失 → null（非错误，可能尚未保存）。
 * - 损坏 JSON → null（调用方降级为 blocked_evidence_unavailable，不抛异常）。
 */
export function loadBlockedCandidateEvidence(
  path: string,
  store: BlockedEvidenceStore = nodeBlockedEvidenceStore,
): BlockedCandidateEvidence | null {
  if (!store.existsSync(path)) return null;
  try {
    const content = store.readFileSync(path);
    return JSON.parse(content) as BlockedCandidateEvidence;
  } catch {
    return null;
  }
}

/**
 * 写入 recovery evidence artifact 路径（不触碰冻结原始文件）。
 *
 * 用途：当 saveBlockedCandidateEvidence 返回 frozen_evidence_protected 时，调用方应改走本函数，
 * 把新 evidence 写入 `{chapterId}-blocked-candidate-evidence.recovery-{N}.json`，保留原始冻结证据。
 *
 * - 内部基于 evidence.artifactPath 推断 tracesDir 与 chapterId，调用 resolveRecoveryEvidenceArtifactPath
 *   计算下一个 recovery 序号路径。
 * - 写入的 recovery evidence 的 artifactPath 字段会被更新为 recovery 路径（保证 load 回读时自洽）。
 * - 写入失败返回 { saved: false, error, reason: "blocked_evidence_unavailable" }，不抛异常。
 * - 本函数不会覆盖冻结原始文件（路径隔离）。
 */
export function saveBlockedCandidateEvidenceToRecoveryPath(
  evidence: BlockedCandidateEvidence,
  store: BlockedEvidenceStore = nodeBlockedEvidenceStore,
):
  | { saved: true; artifactPath: string }
  | { saved: false; error: string; reason: "blocked_evidence_unavailable" } {
  try {
    const tracesDir = dirname(evidence.artifactPath);
    const chapterId = evidence.chapterId;
    const recoveryPath = resolveRecoveryEvidenceArtifactPath(tracesDir, chapterId, store);
    const recoveryEvidence: BlockedCandidateEvidence = {
      ...evidence,
      artifactPath: recoveryPath,
    };
    store.mkdirSync(tracesDir, { recursive: true });
    store.writeFileSync(recoveryPath, JSON.stringify(recoveryEvidence, null, 2));
    return { saved: true, artifactPath: recoveryPath };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { saved: false, error: msg, reason: "blocked_evidence_unavailable" };
  }
}

// ============================================================================
// 过期清理（CONCURRENCY-WAVE4，计划 Wave 4 任务 6）
// ============================================================================

/** blocked evidence 默认保留期：30 天（审计复盘窗口） */
export const DEFAULT_BLOCKED_EVIDENCE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** pruneBlockedCandidateEvidence 结果。pruned/kept/skippedFrozen 为 tracesDir 相对文件名。 */
export interface PruneBlockedEvidenceResult {
  /** 已删除（超过保留期且非冻结保护） */
  pruned: string[];
  /** 保留（未过期） */
  kept: string[];
  /** 保留（HOLD 冻结保护，即使过期也不删） */
  skippedFrozen: string[];
  /** 跳过（store 未实现 statSync/unlinkSync 或读取失败） */
  skipped: string[];
}

/**
 * 清理过期的 blocked candidate evidence artifact（含 recovery-N 副本）。
 *
 * 策略（计划 Wave 4 任务 6：candidate 过期、撤销、清理与审计保留周期）：
 * - 匹配 `{chapterId}-blocked-candidate-evidence.json` 与 `.recovery-{N}.json`；
 * - 文件 mtime 超过保留期（默认 30 天）→ 删除；
 * - HOLD 清单冻结保护的原始 evidence（isFrozenEvidenceProtected）→ 即使过期也不删；
 * - recovery 副本不查冻结保护（冻结语义只绑定原始 evidence hash）；
 * - store 未实现 statSync/unlinkSync → 全部 skipped（向后兼容，不抛错）。
 *
 * 审计：结果结构化返回（pruned/kept/skippedFrozen/skipped），调用方负责写 trace。
 */
export function pruneBlockedCandidateEvidence(
  tracesDir: string,
  options?: { retentionMs?: number; now?: number },
  store: BlockedEvidenceStore = nodeBlockedEvidenceStore,
): PruneBlockedEvidenceResult {
  const retentionMs = options?.retentionMs ?? DEFAULT_BLOCKED_EVIDENCE_RETENTION_MS;
  const now = options?.now ?? Date.now();
  const result: PruneBlockedEvidenceResult = { pruned: [], kept: [], skippedFrozen: [], skipped: [] };

  if (typeof store.readdirSync !== "function") return result;
  let entries: string[];
  try {
    entries = store.readdirSync(tracesDir);
  } catch {
    return result;
  }

  const frozenChapters = new Set<string>();
  for (const name of entries) {
    const m = /^(\S+)-blocked-candidate-evidence\.json$/.exec(name);
    if (!m) continue;
    const chapterId = m[1];
    if (isFrozenEvidenceProtected(tracesDir, chapterId, store).protected) {
      frozenChapters.add(chapterId);
    }
  }

  for (const name of entries) {
    const m = /^(\S+)-blocked-candidate-evidence(\.recovery-\d+)?\.json$/.exec(name);
    if (!m) continue;
    const chapterId = m[1];
    const isRecovery = m[2] !== undefined;
    const path = join(tracesDir, name);

    if (!isRecovery && frozenChapters.has(chapterId)) {
      result.skippedFrozen.push(name);
      continue;
    }
    if (typeof store.statSync !== "function" || typeof store.unlinkSync !== "function") {
      result.skipped.push(name);
      continue;
    }
    try {
      const mtimeMs = store.statSync(path).mtimeMs;
      if (now - mtimeMs > retentionMs) {
        store.unlinkSync(path);
        result.pruned.push(name);
      } else {
        result.kept.push(name);
      }
    } catch {
      result.skipped.push(name);
    }
  }
  return result;
}

// ============================================================================
// 内部：最长匹配子串查找
// ============================================================================

/**
 * 从 error 文本中剥离括号注释后，查找在 rawText 中出现的最长连续子串。
 *
 * - 剥离 （...） 与 (...) 内的注释（如 "已死角色当前时线行动"）。
 * - 按标点/空白切分为短语，最长优先匹配。
 * - 命中返回 { start, end }；全部未命中返回 null。
 */
function findLongestMatchingSubstring(error: string, rawText: string): { start: number; end: number } | null {
  // 剥离中英文括号注释
  const cleaned = error
    .replace(/（[^）]*）/g, "")
    .replace(/\([^)]*\)/g, "")
    .trim();
  if (!cleaned) return null;

  // 按标点/空白切分短语，过滤空串，按长度降序
  const phrases = cleaned
    .split(/[，。；：、,;:\s。！？!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .sort((a, b) => b.length - a.length);

  for (const phrase of phrases) {
    const idx = rawText.indexOf(phrase);
    if (idx >= 0) {
      return { start: idx, end: idx + phrase.length };
    }
  }

  // 整段也尝试一次（短语切分可能丢失组合）
  const wholeIdx = rawText.indexOf(cleaned);
  if (wholeIdx >= 0) {
    return { start: wholeIdx, end: wholeIdx + cleaned.length };
  }

  return null;
}
