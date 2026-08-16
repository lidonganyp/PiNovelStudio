/**
 * EvolutionReleaseTypes — 进化发行治理类型定义（EVOLUTION-RELEASE-GOVERNANCE-1A）
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §3-§4
 *
 * 定义 EvolutionReleaseManifest 的 schema 常量、状态枚举、变更风险分级与状态事件类型。
 * 本模块只定义类型与常量，不含校验逻辑（校验在 evolution-release-schema.ts）。
 *
 * 设计原则：
 * - schemaId 固定为 "pinovel.evolution-release"，schemaVersion=1
 * - status 状态机由 evolution-release-schema.ts 的 isStatusTransitionValid 守护
 * - parentReleaseId/supersedesRef/rollbackReleaseId 三条链由 validateManifestChain 校验
 * - frozen 后不得原地修改；任何修改创建新 releaseId
 *
 * 边界（READY_LOCAL）：
 * - 不调用模型、不写文件、不依赖 eval 模块
 * - 仅定义类型与常量，可被 dist-test/ / dist/ / dist-eval/ 任意闭包消费
 */

// ============================================================================
// Schema 常量
// ============================================================================

export const EVOLUTION_RELEASE_SCHEMA_ID = "pinovel.evolution-release" as const;
export const EVOLUTION_RELEASE_SCHEMA_VERSION = 1 as const;

/** pointer 文件 schemaId（active-development.json / active-production.json） */
export const EVOLUTION_POINTER_SCHEMA_ID = "pinovel.evolution-release-pointer" as const;
export const EVOLUTION_POINTER_SCHEMA_VERSION = 1 as const;

// ============================================================================
// 状态枚举
// ============================================================================

/**
 * Release 状态机（计划 §4）：
 *
 *   draft
 *     -> candidate
 *     -> frozen
 *     -> evaluated
 *     -> approved_dev | held | rejected | quarantined
 *     -> active_dev
 *     -> candidate_prod
 *     -> active_prod
 *
 *   active_dev / active_prod
 *     -> held | revoked | retired
 *     -> rollbackReleaseId
 *
 * 终态：rejected / quarantined / revoked / retired（不可直接迁回 active，需新 releaseId 重新审批）
 */
export type ReleaseStatus =
  | "draft"
  | "candidate"
  | "frozen"
  | "evaluated"
  | "approved_dev"
  | "active_dev"
  | "candidate_prod"
  | "active_prod"
  | "held"
  | "rejected"
  | "quarantined"
  | "revoked"
  | "retired";

/** 终态集合：不可直接迁回 active */
export const TERMINAL_STATUSES: ReadonlySet<ReleaseStatus> = new Set<ReleaseStatus>([
  "rejected",
  "quarantined",
  "revoked",
  "retired",
]);

/** active 集合：可触发 held/revoked/retired/rollback */
export const ACTIVE_STATUSES: ReadonlySet<ReleaseStatus> = new Set<ReleaseStatus>([
  "active_dev",
  "active_prod",
]);

// ============================================================================
// 变更风险分级（计划 §5）
// ============================================================================

export type ChangeClass = "R0" | "R1" | "R2" | "R3";

// ============================================================================
// 行为身份（DG-1：数据版本与发布治理 §4）
// ============================================================================

/**
 * 策略证据分区键（计划 §4）。
 *
 * 一个 release 声明它贡献哪些策略证据分区。策略信誉按
 *   modelVersion + bundleId + strategyId + evalProtocolVersion
 * 隔离，避免旧 Bundle 或旧评测协议污染新 Bundle 的信誉（DG-4）。
 */
export interface StrategyEvidencePartition {
  modelVersion: string;
  bundleId: string;
  strategyId: string;
  evalProtocolVersion: string;
}

// ============================================================================
// Manifest
// ============================================================================

/**
 * 进化发行单元。一个 manifest 表示一个完整、可复现的系统行为版本。
 * frozen 后不可原地修改；任何修改必须创建新 releaseId。
 */
export interface EvolutionReleaseManifest {
  schemaId: typeof EVOLUTION_RELEASE_SCHEMA_ID;
  schemaVersion: typeof EVOLUTION_RELEASE_SCHEMA_VERSION;
  releaseId: string;
  status: ReleaseStatus;
  /** 父版本（前一个 active_dev / active_prod）；首轮为 null */
  parentReleaseId: string | null;
  /** 回滚目标 releaseId；freeze 前必须非空且指向已存在 manifest */
  rollbackReleaseId: string;
  /** 当本版本修订/反转前一个决策时，指向被取代的 manifest（不覆盖审计历史） */
  supersedesRef: string | null;
  changeClass: ChangeClass;
  /** 预登记 claims：本版本声明的变更目标 */
  claims: string[];
  /** 环境指纹 hash（来自 environment-fingerprint.ts） */
  environmentFingerprint: string;
  /** 产物引用：manifest.json 之外的 artifact 相对路径列表 */
  artifactRefs: string[];
  /** 代理审批 artifact 引用；approved_dev 必须非空 */
  approvalRef: string | null;
  createdAt: string;
  /** 进入 active 状态的时间；非 active 状态为 null */
  activatedAt: string | null;
  // ==========================================================================
  // 行为身份字段（DG-1，计划 §4）。
  //
  // 这些字段在 schema v1 为可选：旧 manifest（如 rel-prod-106）尚未捕获完整行为身份，
  // 仍可加载与审计。DG-3 起生产入口对"新冻结 release"强制要求这些字段完整
  // （见 behavior-bundle.ts:assertBehaviorIdentityComplete）；DG-6 完成单一基线迁移后，
  // 旧 manifest 仅作审计对象，不得作为默认生产输入。
  // ==========================================================================
  /** 完整行为集合的确定性 bundle 标识（由全部行为组成项派生，见 behavior-bundle.ts） */
  bundleId?: string;
  /** 模型版本（生产写作模型身份，如 "gemini-3.1-pro-preview"） */
  modelVersion?: string;
  /** Prompt Bundle 规范化 hash */
  promptBundleHash?: string;
  /** Model Routing 规范化 hash */
  modelRoutingHash?: string;
  /** Tool Contract / 工具 schema 规范化 hash */
  toolSchemaHash?: string;
  /** ContextCompiler 规范化 hash */
  contextCompilerHash?: string;
  /** 质量策略规范化 hash */
  qualityPolicyHash?: string;
  /** 恢复策略规范化 hash */
  recoveryPolicyHash?: string;
  /** 知识数据快照规范化 hash */
  knowledgeSnapshotHash?: string;
  /** 运行环境指纹（区别于 environmentFingerprint：此处为纯运行时组件 hash） */
  runtimeFingerprint?: string;
  /** 本 release 声明的策略证据分区（DG-4 隔离键） */
  strategyEvidencePartition?: StrategyEvidencePartition[];
  /** 评测协议版本（Eval 协议变化产生新版本） */
  evalProtocolVersion?: string;
  /** 冻结能力包集合 hash（CPG-1.4；行为组成项，变化必须改 bundleId） */
  capabilityPackageSetHash?: string;
}

// ============================================================================
// 状态事件（append-only）
// ============================================================================

/**
 * Release 状态变更事件。写入 state-events.jsonl，append-only，不可覆盖。
 * eventId 全局唯一，重复拒绝。
 */
export interface ReleaseStateEvent {
  eventId: string;
  releaseId: string;
  fromStatus: ReleaseStatus | null;
  toStatus: ReleaseStatus;
  reason: string;
  /** 触发者：system 自动 / user 用户 / gpt5.6-sol-proxy 代理审批 */
  actor: "system" | "user" | "gpt5.6-sol-proxy" | "evaluation";
  /** 证据引用（approval artifact / test report 等） */
  evidenceRefs?: string[];
  timestamp: string;
}

// ============================================================================
// Pointer
// ============================================================================

export type PointerKind = "development" | "production";

/**
 * active-development.json / active-production.json 单指针结构。
 * 生产与开发入口只读取 pointer 指向的 manifest。
 */
export interface ReleasePointer {
  schemaId: typeof EVOLUTION_POINTER_SCHEMA_ID;
  schemaVersion: typeof EVOLUTION_POINTER_SCHEMA_VERSION;
  kind: PointerKind;
  releaseId: string;
  /** 切换原因 */
  reason: string;
  /** 触发者 */
  actor: string;
  switchedAt: string;
}

/**
 * 指针切换历史条目（rollback-history.jsonl）。
 * 每次切换与回滚都 append 一条，用于回滚到上一个 pointer。
 */
export interface PointerHistoryEntry {
  schemaId: "pinovel.evolution-release-pointer-history";
  schemaVersion: 1;
  kind: PointerKind;
  /** 本次操作前的 releaseId（首次切换为 null） */
  fromReleaseId: string | null;
  /** 本次操作后的 releaseId；revoke 时为空字符串 */
  toReleaseId: string;
  /** 操作类型：switch 正常切换；rollback 回滚到上一个；revoke 撤销当前指针（无后继） */
  operation: "switch" | "rollback" | "revoke";
  reason: string;
  actor: string;
  timestamp: string;
}

// ============================================================================
// 校验错误类型
// ============================================================================

export interface ReleaseValidationError {
  code:
    | "unknown_schema"
    | "schema_version_mismatch"
    | "missing_field"
    | "invalid_status"
    | "invalid_change_class"
    | "invalid_field_value"
    | "not_object"
    | "empty_field";
  path: string;
  message: string;
}

export interface ManifestChainValidationError {
  message: string;
  field: "parentReleaseId" | "rollbackReleaseId" | "supersedesRef";
}

// ============================================================================
// Frozen 不可变结果
// ============================================================================

export interface FrozenImmutableResult {
  ok: boolean;
  changedFields: string[];
}
