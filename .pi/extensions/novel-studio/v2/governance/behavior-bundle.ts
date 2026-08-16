/**
 * BehaviorBundle — 统一行为身份与 bundleId 派生（DG-1，数据版本与发布治理 §4）
 *
 * 真相源：docs/data-version-release-governance-development-plan-20260813.md §2 / §4
 *
 * 版本化对象是"完整行为集合"，不是单个 Prompt。本模块把一次生产运行的
 * 行为身份（Prompt Bundle / Model Routing / Tool Contract / ContextCompiler /
 * 质量策略 / 恢复策略 / 知识快照 / 运行时指纹 / 模型版本 / 评测协议）规范化后
 * 确定性派生为一个 bundleId。
 *
 * 设计原则（计划 §2）：
 * - 任一影响行为的组成项变化，都必须产生新的 bundleId
 * - bundleId 由全部行为组成项按字段名排序规范化后 SHA-256 派生
 * - 同输入重复 capture 的 hash 完全一致（无时间/顺序/随机性）
 *
 * 边界（READY_LOCAL）：
 * - 纯函数，无 fs / 无模型 / 无副作用
 * - 不依赖 eval 模块，可被 dist/ 与 dist-test/ 任意闭包消费
 */

import { createHash } from "node:crypto";
import { canonicalize } from "./evolution-release-schema.js";
import type {
  EvolutionReleaseManifest,
  StrategyEvidencePartition,
} from "./evolution-release-types.js";

// ============================================================================
// 常量
// ============================================================================

/**
 * 行为组成项 hash 字段（计划 §4 的组件 hash 集合）。
 * bundleId 由这些字段 + modelVersion + evalProtocolVersion 派生。
 */
export const BEHAVIOR_COMPONENT_FIELDS = [
  "promptBundleHash",
  "modelRoutingHash",
  "toolSchemaHash",
  "contextCompilerHash",
  "qualityPolicyHash",
  "recoveryPolicyHash",
  "knowledgeSnapshotHash",
  "runtimeFingerprint",
  "capabilityPackageSetHash",
] as const;

export type BehaviorComponentField = (typeof BEHAVIOR_COMPONENT_FIELDS)[number];

/**
 * 完整行为身份必需字段（DG-3 生产入口 fail-closed 使用）。
 * 新冻结的 release 必须全部非空；旧 manifest（v1 未捕获）不满足时不得作为
 * 默认生产输入（DG-6 完成迁移后强制执行）。
 */
export const BEHAVIOR_IDENTITY_REQUIRED_FIELDS = [
  "bundleId",
  "modelVersion",
  ...BEHAVIOR_COMPONENT_FIELDS,
  "evalProtocolVersion",
  "strategyEvidencePartition",
] as const;

// ============================================================================
// 类型
// ============================================================================

/** 派生 bundleId 所需的全部行为组成项（全部必填）。 */
export interface BehaviorBundleComponents {
  modelVersion: string;
  promptBundleHash: string;
  modelRoutingHash: string;
  toolSchemaHash: string;
  contextCompilerHash: string;
  qualityPolicyHash: string;
  recoveryPolicyHash: string;
  knowledgeSnapshotHash: string;
  runtimeFingerprint: string;
  capabilityPackageSetHash: string;
  evalProtocolVersion: string;
}

export interface BehaviorIdentityCompleteness {
  ok: boolean;
  /** 缺失或为空的必填字段名 */
  missingFields: string[];
}

export interface BundleIdConsistencyResult {
  ok: boolean;
  /** 由组件 hash 重新派生的 bundleId */
  recomputed: string | null;
  /** manifest 上记录的 bundleId（缺失时为 null） */
  recorded: string | null;
}

// ============================================================================
// bundleId 派生
// ============================================================================

/**
 * 由全部行为组成项确定性派生 bundleId。
 *
 * 规范化规则：组件对象按字段名排序后递归 JSON 序列化（与 evolution-release-schema
 * 的 canonicalize 一致），再 SHA-256 取完整 hex。
 *
 * 任一组成项变化 → canonical 串变化 → bundleId 变化。
 */
export function computeBehaviorBundleId(components: BehaviorBundleComponents): string {
  const canonical = canonicalize(components);
  return createHash("sha256").update(canonical, "utf-8").digest("hex");
}

/**
 * 从 manifest 提取派生 bundleId 所需的行为组成项。
 * 任一组成项缺失或为空 → 返回 null（无法派生完整 bundleId）。
 */
export function extractBehaviorComponents(
  manifest: EvolutionReleaseManifest,
): BehaviorBundleComponents | null {
  const requiredStrings: Array<keyof BehaviorBundleComponents> = [
    "modelVersion",
    "promptBundleHash",
    "modelRoutingHash",
    "toolSchemaHash",
    "contextCompilerHash",
    "qualityPolicyHash",
    "recoveryPolicyHash",
    "knowledgeSnapshotHash",
    "runtimeFingerprint",
    "capabilityPackageSetHash",
    "evalProtocolVersion",
  ];
  const components: Partial<BehaviorBundleComponents> = {};
  for (const field of requiredStrings) {
    const value = (manifest as unknown as Record<string, unknown>)[field];
    if (typeof value !== "string" || value.length === 0) {
      return null;
    }
    (components as Record<string, unknown>)[field] = value;
  }
  return components as BehaviorBundleComponents;
}

// ============================================================================
// 行为身份完整性校验（DG-3 fail-closed 使用）
// ============================================================================

/**
 * 校验 manifest 是否携带完整行为身份。
 *
 * 所有 BEHAVIOR_IDENTITY_REQUIRED_FIELDS 必须存在且非空（数组须为数组）。
 * 旧 manifest（v1 未捕获）返回 ok=false + 缺失字段列表。
 */
export function assertBehaviorIdentityComplete(
  manifest: EvolutionReleaseManifest,
): BehaviorIdentityCompleteness {
  const missingFields: string[] = [];
  const obj = manifest as unknown as Record<string, unknown>;
  for (const field of BEHAVIOR_IDENTITY_REQUIRED_FIELDS) {
    const value = obj[field];
    if (field === "strategyEvidencePartition") {
      if (!Array.isArray(value)) {
        missingFields.push(field);
      }
      continue;
    }
    if (typeof value !== "string" || value.length === 0) {
      missingFields.push(field);
    }
  }
  return { ok: missingFields.length === 0, missingFields };
}

// ============================================================================
// bundleId 一致性校验
// ============================================================================

/**
 * 校验 manifest 记录的 bundleId 与由组件 hash 重新派生的 bundleId 是否一致。
 *
 * - 任一组件缺失 → recomputed=null，ok=false（无法校验，视作不一致）。
 * - 组件完整但 bundleId 缺失 → recorded=null，ok=false。
 * - 组件完整且 bundleId 存在但不等于重新派生值 → ok=false（hash 漂移）。
 * - 一致 → ok=true。
 */
export function validateBundleIdConsistency(
  manifest: EvolutionReleaseManifest,
): BundleIdConsistencyResult {
  const recorded = typeof manifest.bundleId === "string" && manifest.bundleId.length > 0
    ? manifest.bundleId
    : null;
  const components = extractBehaviorComponents(manifest);
  if (components === null) {
    return { ok: false, recomputed: null, recorded };
  }
  const recomputed = computeBehaviorBundleId(components);
  return { ok: recorded === recomputed, recomputed, recorded };
}

// ============================================================================
// 组件 hash 漂移对比（DG-3 生产入口 fail-closed 使用）
// ============================================================================

export interface ComponentHashComparison {
  ok: boolean;
  /** 与当前运行快照不一致的组件 hash 字段名 */
  mismatchedFields: string[];
}

/**
 * 对比 manifest 记录的组件 hash 与当前运行环境捕获的组件 hash。
 *
 * - 逐字段比较行为组件 hash（BEHAVIOR_COMPONENT_FIELDS）。
 * - manifest 侧某字段缺失/为空 → 跳过（旧 manifest 未捕获该组件，DG-6 迁移后强制）。
 * - 任一已捕获字段与当前快照不一致 → ok=false + 列出漂移字段。
 *
 * modelVersion / evalProtocolVersion 不在此比较（它们是 release 声明的身份，
 * 由 bundleId 派生锁定；其与路由配置的交叉核对属 DG-6 收敛范畴）。
 */
export function compareManifestComponentHashes(
  manifest: EvolutionReleaseManifest,
  actual: BehaviorBundleComponents,
): ComponentHashComparison {
  const mismatchedFields: string[] = [];
  const obj = manifest as unknown as Record<string, unknown>;
  for (const field of BEHAVIOR_COMPONENT_FIELDS) {
    const recorded = obj[field];
    if (typeof recorded !== "string" || recorded.length === 0) {
      continue;
    }
    if (recorded !== actual[field]) {
      mismatchedFields.push(field);
    }
  }
  return { ok: mismatchedFields.length === 0, mismatchedFields };
}

// ============================================================================
// 策略证据分区校验（DG-4 使用）
// ============================================================================

export interface StrategyEvidencePartitionValidation {
  ok: boolean;
  errors: string[];
}

/**
 * 校验 strategyEvidencePartition 列表的形状。
 *
 * 每项必须含非空 modelVersion / bundleId / strategyId / evalProtocolVersion。
 * 重复项（同四元组）视为非法。
 */
export function validateStrategyEvidencePartitions(
  partitions: StrategyEvidencePartition[] | undefined,
): StrategyEvidencePartitionValidation {
  const errors: string[] = [];
  if (partitions === undefined) {
    return { ok: true, errors };
  }
  if (!Array.isArray(partitions)) {
    return { ok: false, errors: ["strategyEvidencePartition 必须为数组"] };
  }
  const seen = new Set<string>();
  for (let i = 0; i < partitions.length; i++) {
    const p = partitions[i] as Partial<StrategyEvidencePartition>;
    const required: Array<keyof StrategyEvidencePartition> = [
      "modelVersion",
      "bundleId",
      "strategyId",
      "evalProtocolVersion",
    ];
    for (const field of required) {
      if (typeof p[field] !== "string" || (p[field] as string).length === 0) {
        errors.push(`strategyEvidencePartition[${i}].${field} 必须为非空字符串`);
      }
    }
    if (
      typeof p.modelVersion === "string" &&
      typeof p.bundleId === "string" &&
      typeof p.strategyId === "string" &&
      typeof p.evalProtocolVersion === "string"
    ) {
      const key = `${p.modelVersion} ${p.bundleId} ${p.strategyId} ${p.evalProtocolVersion}`;
      if (seen.has(key)) {
        errors.push(`strategyEvidencePartition 重复项：${key}`);
      }
      seen.add(key);
    }
  }
  return { ok: errors.length === 0, errors };
}
