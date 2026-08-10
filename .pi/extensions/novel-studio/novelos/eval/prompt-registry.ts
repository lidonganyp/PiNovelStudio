/**
 * Phase 9 - Prompt Registry 核心模块（eval-only）
 *
 * Prompt 版本管理系统：对生产 Prompt 进行版本化追踪、hash 指纹、生命周期管理。
 *
 * 设计原则：
 * - **被动观测层**：registry 不拦截、不替代生产 Prompt 调用。生产路径继续直接引用
 *   硬编码常量（NOVELOS_SYSTEM_PROMPT / STYLE_SYSTEM_PROMPT / WRITER_ADAPTER_SYSTEM_PROMPT），
 *   registry 只做快照、hash 和版本追踪。
 * - **hash 指纹**：每个版本记录 4 类 hash（prompt / toolSchema / context / budget），
 *   任何维度变更都可通过 hash diff 检测。
 * - **生命周期状态机**：draft -> eval -> {rejected | held | canary} -> active，
 *   禁止自动晋级（canary -> active 必须手动确认）。
 * - **production pointer**：每个 prompt slot 有一个 active 版本指针，基线回放证明
 *   registry 包裹不改变生产行为后，pointer 保持不动。
 *
 * eval-only：只注册在 tsconfig.eval.json，不进入生产构建。
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

// ── 生产 Prompt 常量（hash 输入）──
import { NOVELOS_SYSTEM_PROMPT } from "../agent/agentic-raw-candidate-source.js";
import { STYLE_SYSTEM_PROMPT } from "../../v2/core/author-style-optimizer.js";
import { WRITER_ADAPTER_SYSTEM_PROMPT } from "../../v2/core/model-prompt-adapter.js";
import { NARRATIVE_TOOL_NAMES } from "../tools/narrative-tools.js";
import { REAL_SYSTEM_PROMPT_BASE } from "./tool-ab-real-runner.js";
import { GEMINI_RETRIEVAL_SYSTEM_PROMPT_BASE, GEMINI_SYSTEM_PROMPT } from "./gemini-prompt-library.js";
import { DEFAULT_BUDGET_CONFIG } from "../runtime/budget-policy.js";

// ============================================================================
// 常量
// ============================================================================

export const REGISTRY_SCHEMA = "pinovel-prompt-registry/v1";
export const REGISTRY_VERSION = "1.0.0";

/**
 * 上下文编译器名称列表（orchestrator-raw.ts buildRawPrompt 的 12 个编译器）。
 *
 * 用于计算 contextHash：如果编译器列表变更（增删/重命名），hash 会变化，
 * 提示需要重新评测。
 */
export const CONTEXT_COMPILER_NAMES: readonly string[] = [
  "compilePromiseContext",
  "compileExpectationContext",
  "compileGenreContract",
  "compileDialogueCraftContext",
  "compileEmotionRhythmContext",
  "compileSupportingFunctionContext",
  "compileKnowledgeConsumptionContext",
  "compileCharacterVoiceContext",
  "compileWorldPresentationContext",
  "compileEnsembleLayeringContext",
  "compileIdentityContract",
  "compileOntologyContract",
];

/**
 * 编排器层默认预算（A 组）。
 *
 * 与 unified-orchestrator.ts 一致：
 * - positiveGainProductionEnabled=false: SOFT=6, HARD=10
 * - positiveGainProductionEnabled=true: SOFT=8, HARD=14
 * 生产默认 false（positiveGain 不开启），A 组 = SOFT=6/HARD=10。
 */
export const ORCHESTRATOR_BUDGET_A = {
  soft: 6,
  hard: 10,
} as const;

// ============================================================================
// 类型
// ============================================================================

/** Prompt slot：每个生产 Prompt 对应一个 slot */
export type PromptSlot =
  | "novelos_agentic"    // NovelOS Agentic 系统 Prompt
  | "style_optimizer"    // 作者风格优化系统 Prompt
  | "writer_adapter"     // Writer adapter 系统 Prompt（raw/editorial 共用）
  | "retrieval_eval";    // 评测用检索决策 Prompt（eval-only，不进入生产）

/** 版本生命周期状态 */
export type PromptVersionStatus =
  | "draft"     // 草稿：刚创建，未进入评测
  | "eval"      // 评测中：已关联 manifest，正在跑 replay
  | "rejected"  // 已拒绝：评测门禁未通过或 canary 失败
  | "held"      // 暂挂：评测结果不确定，需人工复查或回滚
  | "canary"    // 金丝雀：门禁通过，受控接入观察中
  | "active";   // 生产：正式生效（production pointer 指向此版本）

/** hash 指纹：4 类 hash 唯一标识一个 prompt 版本的完整运行时上下文 */
export interface PromptHashes {
  /** system prompt 内容的 SHA-256（前 16 hex） */
  promptHash: string;
  /** 可见工具集（9 个叙事工具名，排序后 join）的 SHA-256 */
  toolSchemaHash: string;
  /** 上下文编译器配置（12 个编译器名，排序后 join）的 SHA-256 */
  contextHash: string;
  /** 预算配置（NovelOS budget + orchestrator SOFT/HARD）的 SHA-256 */
  budgetHash: string;
}

/** 状态转换记录 */
export interface StatusTransition {
  from: PromptVersionStatus;
  to: PromptVersionStatus;
  timestamp: string;
  reason: string;
  /** 触发者：manual=人工操作，eval-gate=评测门禁自动触发 */
  actor: "manual" | "eval-gate";
}

/** Prompt 版本 */
export interface PromptVersion {
  /** 唯一版本 ID（如 "novelos-agentic-v1"） */
  versionId: string;
  /** 所属 slot */
  slot: PromptSlot;
  /** slot 内序号（从 1 递增） */
  version: number;
  /** 人类可读标签 */
  label: string;
  /** 目标模型 route（如 "narrator_primary"） */
  modelRoute: string;
  /** WriterPromptProfile（如 "gemini_writer_v2"），仅 writer_adapter slot */
  writerProfile?: string;
  /** hash 指纹 */
  hashes: PromptHashes;
  /** 当前状态 */
  status: PromptVersionStatus;
  /** 状态转换历史 */
  statusHistory: StatusTransition[];
  /** 关联的评测 manifest ID */
  evalManifestId?: string;
  /** 评测报告路径 */
  evalReportPath?: string;
  /** 拒绝原因（status=rejected 时必填） */
  rejectedReason?: string;
  /** 创建时间 ISO */
  createdAt: string;
  /** 最后更新时间 ISO */
  updatedAt: string;
}

/** 生产指针：每个 slot 指向当前 active 版本 */
export interface ProductionPointer {
  slot: PromptSlot;
  activeVersionId: string;
  pinnedAt: string;
}

/** Prompt Registry 文件格式 */
export interface PromptRegistry {
  schema: string;
  version: string;
  updatedAt: string;
  /** 所有版本（含 rejected/held 历史） */
  versions: PromptVersion[];
  /** 生产指针 */
  productionPointers: ProductionPointer[];
}

// ============================================================================
// Hash 计算
// ============================================================================

/** SHA-256 前 16 hex 字符 */
function sha256(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex").slice(0, 16);
}

/** 计算 system prompt hash */
export function computePromptHash(systemPrompt: string): string {
  return sha256(systemPrompt);
}

/** 计算工具 schema hash（排序后的工具名 join） */
export function computeToolSchemaHash(toolNames: ReadonlySet<string>): string {
  const sorted = Array.from(toolNames).sort().join(",");
  return sha256(sorted);
}

/** 计算上下文编译器 hash */
export function computeContextHash(compilerNames: readonly string[]): string {
  const sorted = [...compilerNames].sort().join(",");
  return sha256(sorted);
}

/** 计算预算 hash（NovelOS budget + orchestrator SOFT/HARD） */
export function computeBudgetHash(
  novelosBudget: typeof DEFAULT_BUDGET_CONFIG,
  orchestratorSoft: number,
  orchestratorHard: number,
): string {
  return sha256(JSON.stringify({
    maxTurns: novelosBudget.maxTurns,
    maxToolCalls: novelosBudget.maxToolCalls,
    maxLatencyMs: novelosBudget.maxLatencyMs,
    orchestratorSoft,
    orchestratorHard,
  }));
}

/** 计算当前生产工具集 hash */
export function computeProductionToolSchemaHash(): string {
  return computeToolSchemaHash(NARRATIVE_TOOL_NAMES);
}

/** 计算当前生产上下文编译器 hash */
export function computeProductionContextHash(): string {
  return computeContextHash(CONTEXT_COMPILER_NAMES);
}

/** 计算当前 A 组预算 hash */
export function computeProductionBudgetHash(): string {
  return computeBudgetHash(DEFAULT_BUDGET_CONFIG, ORCHESTRATOR_BUDGET_A.soft, ORCHESTRATOR_BUDGET_A.hard);
}

// ============================================================================
// 生命周期状态机
// ============================================================================

/** 合法状态转换映射 */
const VALID_TRANSITIONS: Record<PromptVersionStatus, PromptVersionStatus[]> = {
  draft: ["eval"],
  eval: ["rejected", "held", "canary"],
  rejected: [],      // 终态：不可转换
  held: ["draft", "eval"],  // 可重新进入草稿或评测
  canary: ["active", "rejected"],
  active: ["held"],  // 可回滚到 held
};

/** 验证状态转换是否合法 */
export function isValidTransition(
  from: PromptVersionStatus,
  to: PromptVersionStatus,
): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * 执行状态转换。
 *
 * 铁律：禁止自动晋级（canary -> active 必须 actor="manual"）。
 * eval-gate 只能触发 eval -> rejected 或 eval -> canary。
 */
export function transitionStatus(
  version: PromptVersion,
  to: PromptVersionStatus,
  reason: string,
  actor: "manual" | "eval-gate" = "manual",
): PromptVersion {
  // 禁止 eval-gate 执行 canary -> active
  if (to === "active" && actor === "eval-gate") {
    throw new Error(
      `[prompt-registry] 禁止自动晋级：canary -> active 必须手动确认（versionId=${version.versionId}）`,
    );
  }

  if (!isValidTransition(version.status, to)) {
    throw new Error(
      `[prompt-registry] 非法状态转换：${version.status} -> ${to}（versionId=${version.versionId}）`,
    );
  }

  const now = new Date().toISOString();
  const transition: StatusTransition = {
    from: version.status,
    to,
    timestamp: now,
    reason,
    actor,
  };

  return {
    ...version,
    status: to,
    statusHistory: [...version.statusHistory, transition],
    updatedAt: now,
    rejectedReason: to === "rejected" ? reason : version.rejectedReason,
  };
}

// ============================================================================
// 版本创建
// ============================================================================

/**
 * 为指定 slot 创建生产快照版本。
 *
 * 从当前生产常量计算 hash，创建 draft 状态版本。
 */
export function createProductionSnapshot(
  slot: PromptSlot,
  version: number,
  label: string,
  modelRoute: string,
  systemPrompt: string,
  writerProfile?: string,
): PromptVersion {
  const now = new Date().toISOString();
  return {
    versionId: `${slot}-v${version}`,
    slot,
    version,
    label,
    modelRoute,
    writerProfile,
    hashes: {
      promptHash: computePromptHash(systemPrompt),
      toolSchemaHash: computeProductionToolSchemaHash(),
      contextHash: computeProductionContextHash(),
      budgetHash: computeProductionBudgetHash(),
    },
    status: "draft",
    statusHistory: [],
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 创建 eval-only prompt 版本（如 Gemini 专属 Prompt 候选）。
 *
 * 与生产快照共享 toolSchemaHash/contextHash/budgetHash（固定维度一致），
 * 只 promptHash 不同。
 */
export function createEvalCandidate(
  slot: PromptSlot,
  version: number,
  label: string,
  modelRoute: string,
  systemPrompt: string,
  writerProfile?: string,
): PromptVersion {
  const now = new Date().toISOString();
  return {
    versionId: `${slot}-v${version}`,
    slot,
    version,
    label,
    modelRoute,
    writerProfile,
    hashes: {
      promptHash: computePromptHash(systemPrompt),
      toolSchemaHash: computeProductionToolSchemaHash(),
      contextHash: computeProductionContextHash(),
      budgetHash: computeProductionBudgetHash(),
    },
    status: "draft",
    statusHistory: [],
    createdAt: now,
    updatedAt: now,
  };
}

// ============================================================================
// Registry 文件 I/O
// ============================================================================

/**
 * 加载 registry JSON 文件。
 *
 * @param registryPath registry 文件路径（默认 config/prompt-registry.json）
 */
export function loadRegistry(registryPath: string): PromptRegistry {
  if (!existsSync(registryPath)) {
    throw new Error(`[prompt-registry] registry 文件不存在：${registryPath}`);
  }
  const content = readFileSync(registryPath, "utf-8");
  const data = JSON.parse(content) as PromptRegistry;
  if (data.schema !== REGISTRY_SCHEMA) {
    throw new Error(
      `[prompt-registry] schema 不匹配：期望 ${REGISTRY_SCHEMA}，实际 ${data.schema}`,
    );
  }
  return data;
}

/**
 * 保存 registry JSON 文件。
 *
 * @param registry registry 数据
 * @param registryPath registry 文件路径
 */
export function saveRegistry(registry: PromptRegistry, registryPath: string): void {
  const dir = dirname(registryPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const data: PromptRegistry = {
    ...registry,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(registryPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

/**
 * 创建空 registry。
 */
export function createEmptyRegistry(): PromptRegistry {
  return {
    schema: REGISTRY_SCHEMA,
    version: REGISTRY_VERSION,
    updatedAt: new Date().toISOString(),
    versions: [],
    productionPointers: [],
  };
}

/**
 * 向 registry 添加版本（同 versionId 不重复添加）。
 */
export function addVersion(registry: PromptRegistry, version: PromptVersion): PromptRegistry {
  if (registry.versions.some((v) => v.versionId === version.versionId)) {
    throw new Error(
      `[prompt-registry] 版本已存在：${version.versionId}`,
    );
  }
  return {
    ...registry,
    versions: [...registry.versions, version],
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 更新版本（替换同 versionId 的版本）。
 */
export function updateVersion(registry: PromptRegistry, version: PromptVersion): PromptRegistry {
  const idx = registry.versions.findIndex((v) => v.versionId === version.versionId);
  if (idx === -1) {
    throw new Error(`[prompt-registry] 版本不存在：${version.versionId}`);
  }
  const versions = [...registry.versions];
  versions[idx] = version;
  return {
    ...registry,
    versions,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 设置生产指针。
 */
export function setProductionPointer(
  registry: PromptRegistry,
  slot: PromptSlot,
  activeVersionId: string,
): PromptRegistry {
  // 验证版本存在且状态为 active
  const version = registry.versions.find((v) => v.versionId === activeVersionId);
  if (!version) {
    throw new Error(`[prompt-registry] 版本不存在：${activeVersionId}`);
  }
  if (version.status !== "active") {
    throw new Error(
      `[prompt-registry] 只能指向 active 版本（当前 ${version.status}）：${activeVersionId}`,
    );
  }

  const pointers = registry.productionPointers.filter((p) => p.slot !== slot);
  pointers.push({
    slot,
    activeVersionId,
    pinnedAt: new Date().toISOString(),
  });
  return {
    ...registry,
    productionPointers: pointers,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 查询 slot 的 active 版本。
 */
export function getActiveVersion(registry: PromptRegistry, slot: PromptSlot): PromptVersion | null {
  const pointer = registry.productionPointers.find((p) => p.slot === slot);
  if (!pointer) return null;
  return registry.versions.find((v) => v.versionId === pointer.activeVersionId) ?? null;
}

/**
 * 查询 slot 的所有版本（按版本号排序）。
 */
export function getVersionsBySlot(registry: PromptRegistry, slot: PromptSlot): PromptVersion[] {
  return registry.versions
    .filter((v) => v.slot === slot)
    .sort((a, b) => a.version - b.version);
}

// ============================================================================
// 生产 Prompt 常量引用（供 registry 快照使用）
// ============================================================================

/** 当前生产 NovelOS Agentic 系统 Prompt */
export const PRODUCTION_NOVELOS_PROMPT = NOVELOS_SYSTEM_PROMPT;
/** 当前生产作者风格优化系统 Prompt */
export const PRODUCTION_STYLE_PROMPT = STYLE_SYSTEM_PROMPT;
/** 当前生产 Writer Adapter 系统 Prompt */
export const PRODUCTION_WRITER_PROMPT = WRITER_ADAPTER_SYSTEM_PROMPT;
/** 评测基线检索 Prompt（eval-only） */
export const EVAL_BASELINE_RETRIEVAL_PROMPT = REAL_SYSTEM_PROMPT_BASE;
/** Phase 8 P-B Gemini 专属检索 Prompt（eval-only，已 rejected） */
export const PB_GEMINI_RETRIEVAL_PROMPT = GEMINI_RETRIEVAL_SYSTEM_PROMPT_BASE;
/** Phase 8 P-B Gemini 专属生成 Prompt（eval-only，已 rejected） */
export const PB_GEMINI_SYSTEM_PROMPT = GEMINI_SYSTEM_PROMPT;
