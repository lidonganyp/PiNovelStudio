/**
 * EvalFixture v1 契约与证据模型（离线回放与生产验收闭环 P0）
 *
 * 目标：固定所有回放输入、输出和证据字段，保证任意回放均可追溯到
 * release、bundle、hash、模型与 trace；缺少关键 hash 或 provenance 时
 * fail-closed（回放不得进入结果统计）。
 *
 * 本模块为纯契约层：
 *  - 只定义类型与确定性校验器，不做 IO、不调用模型；
 *  - 复用现有 Release Governance（releaseId）与 Prompt Bundle（bundleId/hash）
 *    的身份体系，不建立第二套晋级版本体系；
 *  - schema 版本策略：schemaId + schemaVersion 双字段冻结；不识别的
 *    schemaId / 更高的 schemaVersion 一律校验失败（前向 fail-closed）。
 *
 * 与既有模块的关系：
 *  - `novelos/eval/eval-types.ts` 的 `EvalFixture` 是 NovelOS M1 局部评测
 *    fixture（retrieval/verifier 消融），本模块的 `EvalFixtureV1` 是完整
 *    `novel_generate_chapter` 公共编排回放的顶层证据契约，二者并存、
 *    互不替代；
 *  - `eval/replay-types.ts` 的 `ReplayCase` 是从外部小说源抽取的抽象节拍
 *    用例，可作为 `EvalFixtureV1.workspace` 快照的生成来源，但不是契约本身。
 */

import { createHash } from "node:crypto";

// ============================================================================
// Schema 常量
// ============================================================================

export const EVAL_FIXTURE_SCHEMA_ID = "pinovel.eval-fixture";
export const EVAL_FIXTURE_SCHEMA_VERSION = 1;

export const EVAL_RUN_MANIFEST_SCHEMA_ID = "pinovel.eval-replay-run-manifest";
export const EVAL_RUN_MANIFEST_SCHEMA_VERSION = 1;

/**
 * 评测协议版本。真实模型回放必须携带此版本；
 * 协议变更（字段语义变化）必须 bump 此值并同步 fixture 重建。
 */
export const EVAL_PROTOCOL_VERSION = "pinovel.eval-protocol/1";

// ============================================================================
// 回放模式（五级隔离，P1 消费）
// ============================================================================

/**
 * 五级回放隔离：
 *  - stub             ：stub 模型，纯编排行为验证；
 *  - recorded         ：固定历史模型结果回放（确定性回归）；
 *  - synthetic        ：合成模型响应（故障注入 / 边界场景）；
 *  - dev_real_model   ：开发环境真实模型（测量随机性 / 能力）；
 *  - production_like  ：生产等价回放（release/bundle/hash/审批全绑定）。
 *  - candidate_like   ：审批前回放（身份+指纹，不要求真实审批）。
 */
export type ReplayMode =
  | "stub"
  | "recorded"
  | "synthetic"
  | "dev_real_model"
  | "production_like"
  | "candidate_like";

export const REPLAY_MODES: ReadonlyArray<ReplayMode> = [
  "stub",
  "recorded",
  "synthetic",
  "dev_real_model",
  "production_like",
  "candidate_like",
];

/** 真实模型回放模式：必须携带完整隔离字段（evalOnly/releaseId/bundleId/…）。 */
export const REAL_MODEL_REPLAY_MODES: ReadonlyArray<ReplayMode> = [
  "dev_real_model",
  "production_like",
  "candidate_like",
];

export function isReplayMode(value: unknown): value is ReplayMode {
  return typeof value === "string" && (REPLAY_MODES as ReadonlyArray<string>).includes(value);
}

// ============================================================================
// Fixture 结构定义
// ============================================================================

/** hash 字段格式：16 位短 hash（PromptHashes 约定）或 64 位完整 SHA-256。 */
const HASH_PATTERN = /^[0-9a-f]{16}(?:[0-9a-f]{48})?$/;
const FIXTURE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export interface EvalFixtureHistoricalChapter {
  chapterNumber: number;
  chapterId: string;
  /** 章节正文内容 SHA-256（完整 64 hex）。 */
  contentHash: string;
  /** 正文内容；recorded/production_like 回放必须内联，stub 可省略。 */
  content?: string;
}

export interface EvalFixtureWorkspaceSnapshotV1 {
  /** 快照对应的 workspace 身份（回放时会重写为 scratch workspaceId）。 */
  sourceWorkspaceId: string;
  /** config.json 快照（novelType / characters / 世界观等）。 */
  config: Record<string, unknown>;
  /** outline.md 内容（可选，高层背景参考）。 */
  outline?: string;
  /** characterId -> 角色档案内容。 */
  characterProfiles: Record<string, string>;
  /** world-items / worldbuilding 快照。 */
  worldItems?: Record<string, unknown>;
  /** series/skeleton.json 快照（可选）。 */
  skeleton?: Record<string, unknown>;
  /**
   * 作者风格档案快照（styles/profile.json，含 editorialGuidance /
   * characterVoiceGuidance / usagePolicy）。统一主链路要求有效风格档案
   * 是必需输入（模型调用前 hard block），回放 fixture 必须内联快照，
   * Runner 物化为 scratch workspace 的 styles/profile.json。
   */
  styleProfile?: Record<string, unknown>;
  /** 前章正文快照（第 2 章及以后必需）。 */
  historicalChapters: EvalFixtureHistoricalChapter[];
}

export interface EvalFixtureChapterSeedV1 {
  chapterNumber: number;
  chapterId: string;
  chapterTitle: string;
  /** ChapterIntent 快照（chapterFunction/readerPressure/inviolableFacts 等）。 */
  intent: Record<string, unknown>;
  /** 种子来源说明（series/outline、ChapterSeed 生成器等）。 */
  seedSource: string;
  /**
   * EVAL-REPLAY-ACCEPTANCE-LOOP F4：冻结的完整 ChapterSeed 快照。
   *
   * 回放时 Runner 把它物化为 scratch workspace 的
   * series/chapter-seed-frozen.json；loadChapterSeed 优先消费冻结 seed，
   * 保证主链路 ContextCompiler 使用的 seed 与采集时逐字段一致，
   * 而不是从 scratch workspace 重新推导（推导结果依赖文件时序，
   * 无法保证与采集时等价）。
   *
   * - 内层 chapterId/chapterNumber（如携带）必须与外层一致（fail-closed）；
   * - workspaceId 会被 Runner 重写为 scratch workspace 身份（身份字段，
   *   不属于行为内容）；
   * - 缺省时回放退回"从物化 workspace 重新推导"（行为兼容，不阻断）。
   */
  frozenFullSeed?: Record<string, unknown>;
}

/**
 * EVAL-REPLAY-ACCEPTANCE-LOOP F4：synthetic 回放的确定性故障注入步骤。
 *
 * 故障注入在模型传输层（ModelGenerateFn）执行：命中 atCall 的调用
 * 返回故障；未命中的调用走 stub 传输（不触网）。同一 plan 重复回放
 * 注入序列完全一致（按调用序确定性）。
 */
export interface EvalFixtureSyntheticFaultStepV1 {
  /**
   * 故障类型：
   * - schema_error    ：返回损坏的结构化输出（JSON 截断）；
   * - empty_output    ：返回空文本；
   * - timeout         ：以超时错误 reject（模拟 PINOVEL_MODEL_REQUEST_TIMEOUT_MS）；
   * - provider_error  ：以 provider 429/5xx 错误 reject。
   */
  fault: "schema_error" | "empty_output" | "timeout" | "provider_error";
  /** 注入到第几次模型调用（1-based；缺省 1）。 */
  atCall?: number;
  /** 附加消息（进入失败证据）。 */
  message?: string;
}

/**
 * 行为身份 provenance：回放必须能追溯到 release、bundle、hash、模型与路由。
 * 与 v2/governance 的 EvolutionReleaseManifest 行为身份字段（DG-1）同名同义。
 */
export interface EvalFixtureProvenanceV1 {
  releaseId: string;
  bundleId: string;
  promptBundleHash: string;
  toolSchemaHash: string;
  contextCompilerHash: string;
  budgetHash: string;
  modelVersion: string;
  modelRoute: string;
  provider?: string;
  /** grader 版本（确定性 grader + 能力 grader 组合标识）。 */
  graderVersion: string;
}

export interface EvalFixtureModelPolicyV1 {
  /** 单次模型请求 timeout（PINOVEL_MODEL_REQUEST_TIMEOUT_MS 对齐）。 */
  requestTimeoutMs: number;
  /** 整章总 timeout（PINOVEL_MODEL_TOTAL_TIMEOUT_MS 对齐）。 */
  totalTimeoutMs: number;
  maxModelCalls: number;
  maxRecoveryModelCalls: number;
}

/** 预期状态不变量：回放结束后由确定性 grader 复核。 */
export interface EvalFixtureExpectedInvariantsV1 {
  /** 正式状态污染必须为 0。 */
  statePollutionForbidden: true;
  /** Eval 修改 production pointer 必须为 0。 */
  productionPointerMutationForbidden: true;
  /** 非 production_like 模式禁止正式章节保存。 */
  formalChapterSaveForbidden: boolean;
  /** trace 归档必须留存（留存率 100%）。 */
  traceArchiveRequired: true;
  /** NarrativeState 提交预期：scratch 内提交=true 允许；正式提交必须为 false。 */
  scratchNarrativeStateCommitAllowed: boolean;
}

/** recorded 回放固定的历史工具调用结果（按调用序）。 */
export interface EvalFixtureRecordedToolResult {
  toolName: string;
  /** 工具响应内容 hash（64 hex，用于 recorded 一致性校验）。 */
  responseHash: string;
  response?: unknown;
}

export interface EvalFixtureV1 {
  schemaId: typeof EVAL_FIXTURE_SCHEMA_ID;
  schemaVersion: 1;
  /** fixture 唯一标识（小写字母数字与 . _ -，<=128 字符）。 */
  fixtureId: string;
  /** 强制字段：回放协议版本，必须 === EVAL_PROTOCOL_VERSION。 */
  evalProtocolVersion: string;
  /** 强制字段：字面量 true。回放输入永远不得进入正式生产统计。 */
  evalOnly: true;
  replayMode: ReplayMode;
  /**
   * 四臂矩阵身份。raw_direct 时 Runner 必须走独立裸写入口（B0），
   * 不得再调用普通 novel_generate_chapter 全链路。
   */
  matrixArm?: "baseline" | "candidate" | "raw_direct" | "recovery";
  createdAt: string;
  provenance: EvalFixtureProvenanceV1;
  workspace: EvalFixtureWorkspaceSnapshotV1;
  chapterSeed: EvalFixtureChapterSeedV1;
  /** 前章 NarrativeState 快照；第 1 章为 null。 */
  priorNarrativeState: Record<string, unknown> | null;
  modelPolicy: EvalFixtureModelPolicyV1;
  recordedToolResults?: EvalFixtureRecordedToolResult[];
  /** EVAL-REPLAY-ACCEPTANCE-LOOP F4：synthetic 回放确定性故障注入计划；仅 synthetic 模式允许携带。 */
  syntheticFaultPlan?: EvalFixtureSyntheticFaultStepV1[];
  expectedInvariants: EvalFixtureExpectedInvariantsV1;
  /** recorded 回放：原始 trace 的 SHA-256，用于确定性比对。 */
  referenceTraceHash?: string;
  /** 强制字段：本次回放 trace 归档路径（相对 fixture 归档根）。 */
  traceArchivePath: string;
}

// ============================================================================
// 校验结果类型
// ============================================================================

export interface EvalContractError {
  /** JSON pointer 风格字段路径，如 "/provenance/releaseId"。 */
  field: string;
  /** 违反的规则标识，如 "missing" / "invalid_hash_format" / "schema_mismatch"。 */
  rule: string;
  message: string;
}

export interface EvalFixtureValidationResult {
  valid: boolean;
  errors: EvalContractError[];
}

export type EvalFixtureParseResult =
  | { ok: true; fixture: EvalFixtureV1 }
  | { ok: false; errors: EvalContractError[] };

// ============================================================================
// Fixture 校验器（fail-closed）
// ============================================================================

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(
  container: Record<string, unknown>,
  field: string,
  basePath: string,
  errors: EvalContractError[],
): void {
  const value = container[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push({
      field: `${basePath}/${field}`,
      rule: "missing_or_empty",
      message: `${basePath}/${field} 必须为非空字符串`,
    });
  }
}

function requireHashField(
  container: Record<string, unknown>,
  field: string,
  basePath: string,
  errors: EvalContractError[],
): void {
  const value = container[field];
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    errors.push({
      field: `${basePath}/${field}`,
      rule: "invalid_hash_format",
      message: `${basePath}/${field} 必须为 16 位短 hash 或 64 位 SHA-256 hex`,
    });
  }
}

function requirePositiveInt(
  container: Record<string, unknown>,
  field: string,
  basePath: string,
  errors: EvalContractError[],
): void {
  const value = container[field];
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    errors.push({
      field: `${basePath}/${field}`,
      rule: "invalid_positive_int",
      message: `${basePath}/${field} 必须为正整数`,
    });
  }
}

function validateProvenance(raw: unknown, errors: EvalContractError[]): void {
  if (!isPlainObject(raw)) {
    errors.push({
      field: "/provenance",
      rule: "missing",
      message: "/provenance 必须为对象",
    });
    return;
  }
  for (const field of [
    "releaseId",
    "bundleId",
    "modelVersion",
    "modelRoute",
    "graderVersion",
  ] as const) {
    requireNonEmptyString(raw, field, "/provenance", errors);
  }
  for (const field of [
    "promptBundleHash",
    "toolSchemaHash",
    "contextCompilerHash",
    "budgetHash",
  ] as const) {
    requireHashField(raw, field, "/provenance", errors);
  }
}

function validateWorkspaceSnapshot(raw: unknown, errors: EvalContractError[]): void {
  if (!isPlainObject(raw)) {
    errors.push({
      field: "/workspace",
      rule: "missing",
      message: "/workspace 必须为对象",
    });
    return;
  }
  requireNonEmptyString(raw, "sourceWorkspaceId", "/workspace", errors);
  if (!isPlainObject(raw.config)) {
    errors.push({
      field: "/workspace/config",
      rule: "missing",
      message: "/workspace/config 必须为对象（config.json 快照）",
    });
  }
  if (!isPlainObject(raw.characterProfiles)) {
    errors.push({
      field: "/workspace/characterProfiles",
      rule: "missing",
      message: "/workspace/characterProfiles 必须为对象（characterId -> 档案内容）",
    });
  }
  if (!Array.isArray(raw.historicalChapters)) {
    errors.push({
      field: "/workspace/historicalChapters",
      rule: "missing",
      message: "/workspace/historicalChapters 必须为数组（可为空数组）",
    });
  } else {
    raw.historicalChapters.forEach((chapter: unknown, index: number) => {
      const base = `/workspace/historicalChapters/${index}`;
      if (!isPlainObject(chapter)) {
        errors.push({ field: base, rule: "invalid", message: `${base} 必须为对象` });
        return;
      }
      requireNonEmptyString(chapter, "chapterId", base, errors);
      if (
        typeof chapter.chapterNumber !== "number" ||
        !Number.isInteger(chapter.chapterNumber) ||
        chapter.chapterNumber < 1
      ) {
        errors.push({
          field: `${base}/chapterNumber`,
          rule: "invalid_chapter_number",
          message: `${base}/chapterNumber 必须为 >=1 的整数`,
        });
      }
      if (typeof chapter.contentHash !== "string" || !/^[0-9a-f]{64}$/.test(chapter.contentHash)) {
        errors.push({
          field: `${base}/contentHash`,
          rule: "invalid_hash_format",
          message: `${base}/contentHash 必须为 64 位 SHA-256 hex`,
        });
      }
    });
  }
}

function validateChapterSeed(raw: unknown, errors: EvalContractError[]): void {
  if (!isPlainObject(raw)) {
    errors.push({
      field: "/chapterSeed",
      rule: "missing",
      message: "/chapterSeed 必须为对象",
    });
    return;
  }
  requireNonEmptyString(raw, "chapterId", "/chapterSeed", errors);
  requireNonEmptyString(raw, "chapterTitle", "/chapterSeed", errors);
  requireNonEmptyString(raw, "seedSource", "/chapterSeed", errors);
  if (
    typeof raw.chapterNumber !== "number" ||
    !Number.isInteger(raw.chapterNumber) ||
    raw.chapterNumber < 1
  ) {
    errors.push({
      field: "/chapterSeed/chapterNumber",
      rule: "invalid_chapter_number",
      message: "/chapterSeed/chapterNumber 必须为 >=1 的整数",
    });
  }
  if (!isPlainObject(raw.intent)) {
    errors.push({
      field: "/chapterSeed/intent",
      rule: "missing",
      message: "/chapterSeed/intent 必须为对象（ChapterIntent 快照）",
    });
  }
  // EVAL-REPLAY-ACCEPTANCE-LOOP F4：冻结完整 ChapterSeed 校验
  if (raw.frozenFullSeed !== undefined) {
    if (!isPlainObject(raw.frozenFullSeed)) {
      errors.push({
        field: "/chapterSeed/frozenFullSeed",
        rule: "invalid",
        message: "/chapterSeed/frozenFullSeed 必须为对象（完整 ChapterSeed 快照）",
      });
    } else {
      const frozen = raw.frozenFullSeed;
      if (
        typeof frozen.chapterId === "string" &&
        typeof raw.chapterId === "string" &&
        frozen.chapterId !== raw.chapterId
      ) {
        errors.push({
          field: "/chapterSeed/frozenFullSeed/chapterId",
          rule: "identity_mismatch",
          message: `frozenFullSeed.chapterId="${frozen.chapterId}" 与外层 chapterSeed.chapterId="${raw.chapterId}" 不一致`,
        });
      }
      if (
        typeof frozen.chapterNumber === "number" &&
        typeof raw.chapterNumber === "number" &&
        frozen.chapterNumber !== raw.chapterNumber
      ) {
        errors.push({
          field: "/chapterSeed/frozenFullSeed/chapterNumber",
          rule: "identity_mismatch",
          message: `frozenFullSeed.chapterNumber=${frozen.chapterNumber} 与外层 chapterSeed.chapterNumber=${raw.chapterNumber} 不一致`,
        });
      }
    }
  }
}

const SYNTHETIC_FAULT_KINDS: ReadonlyArray<string> = [
  "schema_error",
  "empty_output",
  "timeout",
  "provider_error",
];

function validateSyntheticFaultPlan(
  raw: unknown,
  errors: EvalContractError[],
): void {
  if (raw === undefined) {
    return;
  }
  if (!Array.isArray(raw)) {
    errors.push({
      field: "/syntheticFaultPlan",
      rule: "invalid",
      message: "/syntheticFaultPlan 必须为数组",
    });
    return;
  }
  raw.forEach((entry: unknown, index: number) => {
    const base = `/syntheticFaultPlan/${index}`;
    if (!isPlainObject(entry)) {
      errors.push({ field: base, rule: "invalid", message: `${base} 必须为对象` });
      return;
    }
    if (typeof entry.fault !== "string" || !SYNTHETIC_FAULT_KINDS.includes(entry.fault)) {
      errors.push({
        field: `${base}/fault`,
        rule: "invalid_fault_kind",
        message: `${base}/fault 必须为 ${SYNTHETIC_FAULT_KINDS.join(" | ")} 之一`,
      });
    }
    if (
      entry.atCall !== undefined &&
      (typeof entry.atCall !== "number" || !Number.isInteger(entry.atCall) || entry.atCall < 1)
    ) {
      errors.push({
        field: `${base}/atCall`,
        rule: "invalid",
        message: `${base}/atCall 必须为 >=1 的整数（1-based 调用序）`,
      });
    }
    if (entry.message !== undefined && typeof entry.message !== "string") {
      errors.push({
        field: `${base}/message`,
        rule: "invalid",
        message: `${base}/message 必须为字符串`,
      });
    }
  });
}

function validateModelPolicy(raw: unknown, errors: EvalContractError[]): void {
  if (!isPlainObject(raw)) {
    errors.push({
      field: "/modelPolicy",
      rule: "missing",
      message: "/modelPolicy 必须为对象",
    });
    return;
  }
  for (const field of [
    "requestTimeoutMs",
    "totalTimeoutMs",
    "maxModelCalls",
    "maxRecoveryModelCalls",
  ] as const) {
    requirePositiveInt(raw, field, "/modelPolicy", errors);
  }
  if (
    typeof raw.requestTimeoutMs === "number" &&
    typeof raw.totalTimeoutMs === "number" &&
    raw.requestTimeoutMs > raw.totalTimeoutMs
  ) {
    errors.push({
      field: "/modelPolicy/requestTimeoutMs",
      rule: "timeout_inconsistency",
      message: "requestTimeoutMs 不得大于 totalTimeoutMs",
    });
  }
}

function validateExpectedInvariants(raw: unknown, errors: EvalContractError[]): void {
  if (!isPlainObject(raw)) {
    errors.push({
      field: "/expectedInvariants",
      rule: "missing",
      message: "/expectedInvariants 必须为对象",
    });
    return;
  }
  for (const field of [
    "statePollutionForbidden",
    "productionPointerMutationForbidden",
    "traceArchiveRequired",
  ] as const) {
    if (raw[field] !== true) {
      errors.push({
        field: `/expectedInvariants/${field}`,
        rule: "must_be_literal_true",
        message: `/expectedInvariants/${field} 必须为字面量 true（回放安全不变量不可关闭）`,
      });
    }
  }
  if (typeof raw.formalChapterSaveForbidden !== "boolean") {
    errors.push({
      field: "/expectedInvariants/formalChapterSaveForbidden",
      rule: "missing",
      message: "/expectedInvariants/formalChapterSaveForbidden 必须为布尔值",
    });
  }
  if (typeof raw.scratchNarrativeStateCommitAllowed !== "boolean") {
    errors.push({
      field: "/expectedInvariants/scratchNarrativeStateCommitAllowed",
      rule: "missing",
      message: "/expectedInvariants/scratchNarrativeStateCommitAllowed 必须为布尔值",
    });
  }
}

/**
 * 校验原始对象是否为合法 EvalFixtureV1。
 *
 * fail-closed 规则：
 *  - schemaId / schemaVersion 不识别 → invalid；
 *  - 强制字段（evalOnly / evalProtocolVersion / traceArchivePath / provenance hash）
 *    缺失或非法 → invalid；
 *  - 未通过校验的 fixture 不得进入回放，也不得进入结果统计。
 */
export function validateEvalFixtureV1(raw: unknown): EvalFixtureValidationResult {
  const errors: EvalContractError[] = [];

  if (!isPlainObject(raw)) {
    return {
      valid: false,
      errors: [{ field: "/", rule: "not_an_object", message: "fixture 必须为 JSON 对象" }],
    };
  }

  if (raw.schemaId !== EVAL_FIXTURE_SCHEMA_ID) {
    errors.push({
      field: "/schemaId",
      rule: "schema_mismatch",
      message: `schemaId 必须为 "${EVAL_FIXTURE_SCHEMA_ID}"`,
    });
  }
  if (raw.schemaVersion !== EVAL_FIXTURE_SCHEMA_VERSION) {
    errors.push({
      field: "/schemaVersion",
      rule: "schema_version_mismatch",
      message: `schemaVersion 必须为 ${EVAL_FIXTURE_SCHEMA_VERSION}（前向 fail-closed）`,
    });
  }

  if (typeof raw.fixtureId !== "string" || !FIXTURE_ID_PATTERN.test(raw.fixtureId)) {
    errors.push({
      field: "/fixtureId",
      rule: "invalid_fixture_id",
      message: "fixtureId 必须匹配 /^[a-z0-9][a-z0-9._-]{0,127}$/",
    });
  }

  if (raw.evalOnly !== true) {
    errors.push({
      field: "/evalOnly",
      rule: "must_be_literal_true",
      message: "evalOnly 必须为字面量 true（回放输入永远不得进入正式统计）",
    });
  }

  if (raw.evalProtocolVersion !== EVAL_PROTOCOL_VERSION) {
    errors.push({
      field: "/evalProtocolVersion",
      rule: "protocol_version_mismatch",
      message: `evalProtocolVersion 必须为 "${EVAL_PROTOCOL_VERSION}"`,
    });
  }

  if (!isReplayMode(raw.replayMode)) {
    errors.push({
      field: "/replayMode",
      rule: "invalid_replay_mode",
      message: `replayMode 必须为 ${REPLAY_MODES.join(" | ")} 之一`,
    });
  }

  if (raw.matrixArm !== undefined) {
    const allowedArms = ["baseline", "candidate", "raw_direct", "recovery"];
    if (typeof raw.matrixArm !== "string" || !allowedArms.includes(raw.matrixArm)) {
      errors.push({
        field: "/matrixArm",
        rule: "invalid_matrix_arm",
        message: `matrixArm 必须为 ${allowedArms.join(" | ")} 之一`,
      });
    }
  }

  if (typeof raw.createdAt !== "string" || Number.isNaN(Date.parse(raw.createdAt))) {
    errors.push({
      field: "/createdAt",
      rule: "invalid_iso_datetime",
      message: "createdAt 必须为可解析的 ISO 时间字符串",
    });
  }

  validateProvenance(raw.provenance, errors);
  validateWorkspaceSnapshot(raw.workspace, errors);
  validateChapterSeed(raw.chapterSeed, errors);
  validateModelPolicy(raw.modelPolicy, errors);
  validateExpectedInvariants(raw.expectedInvariants, errors);

  if (raw.priorNarrativeState !== null && !isPlainObject(raw.priorNarrativeState)) {
    errors.push({
      field: "/priorNarrativeState",
      rule: "invalid",
      message: "priorNarrativeState 必须为对象或 null",
    });
  }

  if (typeof raw.traceArchivePath !== "string" || raw.traceArchivePath.trim().length === 0) {
    errors.push({
      field: "/traceArchivePath",
      rule: "missing_or_empty",
      message: "traceArchivePath 必须为非空字符串（trace 归档强制字段）",
    });
  }

  if (
    raw.referenceTraceHash !== undefined &&
    (typeof raw.referenceTraceHash !== "string" || !/^[0-9a-f]{64}$/.test(raw.referenceTraceHash))
  ) {
    errors.push({
      field: "/referenceTraceHash",
      rule: "invalid_hash_format",
      message: "referenceTraceHash 必须为 64 位 SHA-256 hex",
    });
  }

  if (raw.recordedToolResults !== undefined) {
    if (!Array.isArray(raw.recordedToolResults)) {
      errors.push({
        field: "/recordedToolResults",
        rule: "invalid",
        message: "recordedToolResults 必须为数组",
      });
    } else {
      raw.recordedToolResults.forEach((entry: unknown, index: number) => {
        const base = `/recordedToolResults/${index}`;
        if (!isPlainObject(entry)) {
          errors.push({ field: base, rule: "invalid", message: `${base} 必须为对象` });
          return;
        }
        requireNonEmptyString(entry, "toolName", base, errors);
        if (typeof entry.responseHash !== "string" || !/^[0-9a-f]{64}$/.test(entry.responseHash)) {
          errors.push({
            field: `${base}/responseHash`,
            rule: "invalid_hash_format",
            message: `${base}/responseHash 必须为 64 位 SHA-256 hex`,
          });
        }
      });
    }
  }

  validateSyntheticFaultPlan(raw.syntheticFaultPlan, errors);

  // EVAL-REPLAY-ACCEPTANCE-LOOP F4：模式相关强制（fail-closed）
  if (isReplayMode(raw.replayMode)) {
    if (raw.replayMode === "recorded") {
      // recorded 回放必须能服务预录响应：非空 + 每条携带 response 载荷。
      if (!Array.isArray(raw.recordedToolResults) || raw.recordedToolResults.length === 0) {
        errors.push({
          field: "/recordedToolResults",
          rule: "recorded_mode_requires_responses",
          message: "replayMode=recorded 必须携带非空 recordedToolResults（固定历史模型结果）",
        });
      } else {
        raw.recordedToolResults.forEach((entry: unknown, index: number) => {
          if (isPlainObject(entry) && entry.response === undefined) {
            errors.push({
              field: `/recordedToolResults/${index}/response`,
              rule: "recorded_response_payload_required",
              message: `recorded 回放的 recordedToolResults[${index}].response 不得缺省（hash-only 条目无法回放）`,
            });
          }
        });
      }
    }
    if (raw.syntheticFaultPlan !== undefined && raw.replayMode !== "synthetic") {
      errors.push({
        field: "/syntheticFaultPlan",
        rule: "synthetic_plan_mode_mismatch",
        message: `syntheticFaultPlan 仅允许 replayMode=synthetic 携带（当前 ${raw.replayMode}）`,
      });
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * 解析并校验 fixture。未通过校验时 ok=false（fail-closed），
 * 调用方必须拒绝该 fixture 进入回放。
 */
export function parseEvalFixtureV1(raw: unknown): EvalFixtureParseResult {
  const result = validateEvalFixtureV1(raw);
  if (!result.valid) {
    return { ok: false, errors: result.errors };
  }
  return { ok: true, fixture: raw as EvalFixtureV1 };
}

// ============================================================================
// Fixture 内容 hash（traceability）
// ============================================================================

/**
 * 计算 fixture 规范化内容 hash（SHA-256，64 hex）。
 * 规范化：按固定键序递归排序后 JSON 序列化，保证语义相同的 fixture
 * 在字段顺序不同时 hash 一致。
 */
export function computeEvalFixtureHash(fixture: EvalFixtureV1): string {
  // createdAt 是采集时间元数据，不属于行为内容指纹：排除后同一
  // workspace+release 快照重复采集得到稳定 hash，fixture 索引才能幂等。
  const snapshot = { ...fixture } as Record<string, unknown>;
  delete snapshot.createdAt;
  const canonical = canonicalize(snapshot);
  return createHash("sha256").update(canonical, "utf-8").digest("hex");
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

// ============================================================================
// ReplayRunManifest（一次回放运行的证据清单）
// ============================================================================

export type ReplaySampleStatus =
  | "completed"
  | "failed"
  | "skipped_invalid_fixture"
  | "skipped_isolation_violation";

export const REPLAY_SAMPLE_STATUSES: ReadonlyArray<ReplaySampleStatus> = [
  "completed",
  "failed",
  "skipped_invalid_fixture",
  "skipped_isolation_violation",
];

export interface ReplayRunSampleEntry {
  fixtureId: string;
  /** fixture 规范化内容 hash（64 hex）。 */
  fixtureHash: string;
  replayMode: ReplayMode;
  /** scratch workspace 身份（P1 隔离层分配）。 */
  scratchWorkspaceId: string;
  status: ReplaySampleStatus;
  /** 失败归因（FailureAttribution 字符串，由 P4 分类器给出；无失败为 null）。 */
  failureAttribution: string | null;
  /** 失败 envelope 摘要（stage/gate/severity/reason）。 */
  failureEnvelopes: Array<{
    stage: string;
    gate?: string;
    severity?: string;
    reason: string;
  }>;
  traceArchived: boolean;
  traceArchivePath: string | null;
  /** 隔离违规（必须为空数组才允许进入结果统计）。 */
  isolationViolations: Array<{ kind: string; detail: string }>;
  /** 模型调用次数与成本（无模型回放为 0）。 */
  modelCalls: number;
  /** production_like：按 provider 聚合（如 gemini31=3）。 */
  modelCallsByProvider?: Record<string, number>;
  /** production_like：按 requestedRoute 聚合。 */
  modelCallsByRequestedRoute?: Record<string, number>;
  /** production_like：未授权跨模型调用数（要求 0）。 */
  unauthorizedCrossModelCount?: number;
  /** 从真实 quality-trace 汇总的 token（in+out）；无调用为 0。 */
  tokenCost?: number;
  /** 从真实 quality-trace 汇总的恢复尝试次数。 */
  recoveryAttemptCount?: number;
  /** 用户编辑距离（有用户改稿证据时写入；无证据不得编造）。 */
  userEditDistance?: number | null;
  /** production_like：从真实 trace 提取的生产身份。 */
  releaseIdentity?: {
    devMode: boolean;
    releaseId: string | null;
    environmentFingerprint: string | null;
    approvalRef: string | null;
    bundleId: string | null;
    modelVersion: string | null;
  };
  /** 端到端延迟（ms）。 */
  durationMs: number;
}

export interface ReplayRunManifestV1 {
  schemaId: typeof EVAL_RUN_MANIFEST_SCHEMA_ID;
  schemaVersion: 1;
  runId: string;
  evalProtocolVersion: string;
  replayMode: ReplayMode;
  /** 本次回放绑定的 release / bundle（与 fixture provenance 一致才可统计）。 */
  releaseId: string;
  bundleId: string;
  /** 回放输入的归档根目录（manifest 与样本产物同根）。 */
  runRoot: string;
  startedAt: string;
  finishedAt: string | null;
  samples: ReplayRunSampleEntry[];
  /** 汇总：仅 status=completed/failed 且 isolationViolations 为空的样本计入。 */
  summary: {
    totalSamples: number;
    countedSamples: number;
    completed: number;
    failed: number;
    skipped: number;
    traceRetentionRate: number;
    isolationViolationCount: number;
  };
}

/**
 * 校验 ReplayRunManifestV1。
 * 缺少关键 hash / provenance / trace 归档记录 → invalid（不得进入结果统计）。
 */
export function validateReplayRunManifestV1(raw: unknown): EvalFixtureValidationResult {
  const errors: EvalContractError[] = [];

  if (!isPlainObject(raw)) {
    return {
      valid: false,
      errors: [{ field: "/", rule: "not_an_object", message: "manifest 必须为 JSON 对象" }],
    };
  }

  if (raw.schemaId !== EVAL_RUN_MANIFEST_SCHEMA_ID) {
    errors.push({
      field: "/schemaId",
      rule: "schema_mismatch",
      message: `schemaId 必须为 "${EVAL_RUN_MANIFEST_SCHEMA_ID}"`,
    });
  }
  if (raw.schemaVersion !== EVAL_RUN_MANIFEST_SCHEMA_VERSION) {
    errors.push({
      field: "/schemaVersion",
      rule: "schema_version_mismatch",
      message: `schemaVersion 必须为 ${EVAL_RUN_MANIFEST_SCHEMA_VERSION}`,
    });
  }
  for (const field of ["runId", "releaseId", "bundleId", "runRoot"] as const) {
    requireNonEmptyString(raw, field, "", errors);
  }
  if (raw.evalProtocolVersion !== EVAL_PROTOCOL_VERSION) {
    errors.push({
      field: "/evalProtocolVersion",
      rule: "protocol_version_mismatch",
      message: `evalProtocolVersion 必须为 "${EVAL_PROTOCOL_VERSION}"`,
    });
  }
  if (!isReplayMode(raw.replayMode)) {
    errors.push({
      field: "/replayMode",
      rule: "invalid_replay_mode",
      message: "replayMode 非法",
    });
  }
  if (!Array.isArray(raw.samples)) {
    errors.push({ field: "/samples", rule: "missing", message: "/samples 必须为数组" });
  } else {
    raw.samples.forEach((entry: unknown, index: number) => {
      const base = `/samples/${index}`;
      if (!isPlainObject(entry)) {
        errors.push({ field: base, rule: "invalid", message: `${base} 必须为对象` });
        return;
      }
      requireNonEmptyString(entry, "fixtureId", base, errors);
      if (typeof entry.fixtureHash !== "string" || !/^[0-9a-f]{64}$/.test(entry.fixtureHash)) {
        errors.push({
          field: `${base}/fixtureHash`,
          rule: "invalid_hash_format",
          message: `${base}/fixtureHash 必须为 64 位 SHA-256 hex`,
        });
      }
      if (!isReplayMode(entry.replayMode)) {
        errors.push({
          field: `${base}/replayMode`,
          rule: "invalid_replay_mode",
          message: `${base}/replayMode 非法`,
        });
      }
      if (
        typeof entry.status !== "string" ||
        !(REPLAY_SAMPLE_STATUSES as ReadonlyArray<string>).includes(entry.status)
      ) {
        errors.push({
          field: `${base}/status`,
          rule: "invalid_status",
          message: `${base}/status 非法`,
        });
      }
      if (typeof entry.traceArchived !== "boolean") {
        errors.push({
          field: `${base}/traceArchived`,
          rule: "missing",
          message: `${base}/traceArchived 必须为布尔值`,
        });
      }
      if (
        !Array.isArray(entry.isolationViolations) ||
        entry.isolationViolations.length > 0
      ) {
        errors.push({
          field: `${base}/isolationViolations`,
          rule: "isolation_violation_present",
          message: `${base}/isolationViolations 必须为空数组（存在违规的 run 不得进入结果统计）`,
        });
      }
    });
  }

  return { valid: errors.length === 0, errors };
}
