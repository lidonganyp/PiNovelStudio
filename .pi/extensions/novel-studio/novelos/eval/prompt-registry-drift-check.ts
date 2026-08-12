/**
 * Phase 9 - Prompt Registry Hash Drift 检查（eval-only）
 *
 * CI 和生产发布门禁用：校验生产 Prompt、工具 schema、上下文、预算 hash
 * 是否与 registry 中 active 版本记录的 hash 一致。
 *
 * 发现漂移 -> hard block，不允许静默运行。
 *
 * eval-only：只注册在 tsconfig.eval.json，不进入生产构建。
 * CI 用法：node scripts/prompt-registry-drift-check.mjs
 */

import {
  loadRegistry,
  getActiveVersion,
  computePromptHash,
  computeProductionToolSchemaHash,
  computeProductionContextHash,
  computeProductionBudgetHash,
  PRODUCTION_NOVELOS_PROMPT,
  PRODUCTION_STYLE_PROMPT,
  PRODUCTION_WRITER_PROMPT,
  EVAL_BASELINE_RETRIEVAL_PROMPT,
  type PromptSlot,
  type PromptRegistry,
} from "./prompt-registry.js";
import {
  collectProductionBundleFingerprint,
  getProviderCapability,
} from "./prompt-bundle-fingerprint-collector.js";
import { computeBundleManifest, type PromptBundleManifest } from "./prompt-bundle-manifest.js";

// ============================================================================
// 类型
// ============================================================================

/** 单个 slot 的漂移检查结果 */
export interface SlotDriftResult {
  slot: PromptSlot;
  versionId: string;
  passed: boolean;
  drifts: HashDriftDetail[];
}

/** 单项 hash 漂移详情 */
export interface HashDriftDetail {
  hashName: "promptHash" | "toolSchemaHash" | "contextHash" | "budgetHash";
  expected: string;
  actual: string;
  drift: boolean;
}

/** Bundle 级漂移详情（每个组成 hash 一项） */
export interface BundleHashDriftDetail {
  component: keyof PromptBundleManifest &
    (
      | "systemPromptHash"
      | "userPromptRendererHash"
      | "chapterContractRendererHash"
      | "toolSchemaHash"
      | "toolProtocolHash"
      | "contextCompilerHash"
      | "outputParserHash"
      | "terminationProtocolHash"
      | "providerCapabilityHash"
      | "budgetHash"
    );
  expected: string;
  actual: string;
  drift: boolean;
}

/** Bundle 级漂移检查结果（单 slot） */
export interface SlotBundleDriftResult {
  slot: PromptSlot;
  versionId: string;
  /** 是否存储了 bundle baseline */
  hasBaseline: boolean;
  /** 基线 bundleId vs 当前 bundleId */
  baselineBundleId: string;
  currentBundleId: string;
  passed: boolean;
  drifts: BundleHashDriftDetail[];
}

/** 整体漂移检查结果 */
export interface DriftCheckResult {
  passed: boolean;
  checkedSlots: SlotDriftResult[];
  timestamp: string;
  /** 漂移摘要（人类可读） */
  summary: string;
}

// ============================================================================
// 漂移检查逻辑
// ============================================================================

/** 每个 slot 对应的生产 Prompt 内容 */
const SLOT_PROMPTS: Record<PromptSlot, string> = {
  novelos_agentic: PRODUCTION_NOVELOS_PROMPT,
  style_optimizer: PRODUCTION_STYLE_PROMPT,
  writer_adapter: PRODUCTION_WRITER_PROMPT,
  retrieval_eval: EVAL_BASELINE_RETRIEVAL_PROMPT,
};

/**
 * 检查单个 slot 的 hash 漂移。
 *
 * 从当前生产常量重新计算 4 类 hash，与 registry 中 active 版本的 hash 对比。
 */
export function checkSlotDrift(
  registry: PromptRegistry,
  slot: PromptSlot,
): SlotDriftResult {
  const activeVersion = getActiveVersion(registry, slot);

  if (!activeVersion) {
    return {
      slot,
      versionId: "(none)",
      passed: false,
      drifts: [],
    };
  }

  const promptContent = SLOT_PROMPTS[slot];
  const actualHashes = {
    promptHash: computePromptHash(promptContent),
    toolSchemaHash: computeProductionToolSchemaHash(),
    contextHash: computeProductionContextHash(),
    budgetHash: computeProductionBudgetHash(),
  };

  const drifts: HashDriftDetail[] = [
    {
      hashName: "promptHash",
      expected: activeVersion.hashes.promptHash,
      actual: actualHashes.promptHash,
      drift: activeVersion.hashes.promptHash !== actualHashes.promptHash,
    },
    {
      hashName: "toolSchemaHash",
      expected: activeVersion.hashes.toolSchemaHash,
      actual: actualHashes.toolSchemaHash,
      drift: activeVersion.hashes.toolSchemaHash !== actualHashes.toolSchemaHash,
    },
    {
      hashName: "contextHash",
      expected: activeVersion.hashes.contextHash,
      actual: actualHashes.contextHash,
      drift: activeVersion.hashes.contextHash !== actualHashes.contextHash,
    },
    {
      hashName: "budgetHash",
      expected: activeVersion.hashes.budgetHash,
      actual: actualHashes.budgetHash,
      drift: activeVersion.hashes.budgetHash !== actualHashes.budgetHash,
    },
  ];

  return {
    slot,
    versionId: activeVersion.versionId,
    passed: drifts.every((d) => !d.drift),
    drifts,
  };
}

/**
 * 执行全量 hash 漂移检查。
 *
 * @param registryPath registry JSON 文件路径
 * @returns 漂移检查结果（passed=false 时应阻断发布）
 */
export function runDriftCheck(registryPath: string): DriftCheckResult {
  let registry: PromptRegistry;

  try {
    registry = loadRegistry(registryPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      passed: false,
      checkedSlots: [],
      timestamp: new Date().toISOString(),
      summary: `[drift-check] FAIL: registry 加载失败（fail-closed）：${message}`,
    };
  }

  const slots: PromptSlot[] = [
    "novelos_agentic",
    "style_optimizer",
    "writer_adapter",
    "retrieval_eval",
  ];

  const checkedSlots = slots.map((slot) => checkSlotDrift(registry, slot));
  const allPassed = checkedSlots.every((s) => s.passed);

  const driftedSlots = checkedSlots.filter((s) => !s.passed);
  const summary = allPassed
    ? `[drift-check] PASS: 全部 ${slots.length} 个 slot hash 一致，无漂移`
    : `[drift-check] FAIL: ${driftedSlots.length}/${slots.length} 个 slot 存在 hash 漂移：${driftedSlots.map((s) => s.slot).join(", ")}`;

  return {
    passed: allPassed,
    checkedSlots,
    timestamp: new Date().toISOString(),
    summary,
  };
}

// ============================================================================
// Bundle 级漂移检查（MODEL-PROMPT-EVOLUTION-1 / t2）
// ============================================================================

/** 需要纳入 bundle 漂移对比的组成 hash 组件名 */
const BUNDLE_HASH_COMPONENTS: readonly BundleHashDriftDetail["component"][] = [
  "systemPromptHash",
  "userPromptRendererHash",
  "chapterContractRendererHash",
  "toolSchemaHash",
  "toolProtocolHash",
  "contextCompilerHash",
  "outputParserHash",
  "terminationProtocolHash",
  "providerCapabilityHash",
  "budgetHash",
];

/** 收集到的 Bundle 组成的可读标签 */
const BUNDLE_COMPONENT_LABEL: Record<BundleHashDriftDetail["component"], string> = {
  systemPromptHash: "system_prompt",
  userPromptRendererHash: "user_prompt_renderer",
  chapterContractRendererHash: "chapter_contract_renderer",
  toolSchemaHash: "tool_schema",
  toolProtocolHash: "tool_protocol",
  contextCompilerHash: "context_compiler",
  outputParserHash: "output_parser",
  terminationProtocolHash: "termination_protocol",
  providerCapabilityHash: "provider_capability",
  budgetHash: "budget",
};

/**
 * 计算当前生产 Bundle（按指定 slot 的身份与 workspaceRoot）。
 *
 * 身份参数：route/provider/modelVersion 决定 profile 与能力；temperature/maxTokens
 * 来自 model-routing 的 provider 级 per-route map（调用方传入）。
 */
export function computeCurrentBundle(opts: {
  workspaceRoot: string;
  route: string;
  provider: string;
  modelVersion: string;
  temperature?: number | null;
  maxTokens?: number | null;
  profileId?: string;
}): PromptBundleManifest {
  const content = collectProductionBundleFingerprint({
    workspaceRoot: opts.workspaceRoot,
    identity: {
      modelVersion: opts.modelVersion,
      provider: opts.provider,
      route: opts.route,
      temperature: opts.temperature ?? null,
      maxTokens: opts.maxTokens ?? null,
    },
    profileId: opts.profileId,
  });
  return computeBundleManifest(content, "active");
}

/**
 * 检查单个 slot 的 bundle 级漂移。
 *
 * 将 active 版本存储的 bundleManifest 与当前生产 bundle 对比：
 * - 未存储 baseline（hasBaseline=false）→ passed=false（fail-closed：缺基线即视为未确认）
 * - 任一组成 hash 变化 → passed=false
 */
export function checkSlotBundleDrift(
  registry: PromptRegistry,
  slot: PromptSlot,
  currentBundle: PromptBundleManifest,
): SlotBundleDriftResult {
  const activeVersion = getActiveVersion(registry, slot);
  if (!activeVersion) {
    return {
      slot,
      versionId: "(none)",
      hasBaseline: false,
      baselineBundleId: "",
      currentBundleId: currentBundle.bundleId,
      passed: false,
      drifts: [],
    };
  }

  const baseline = activeVersion.bundleManifest;
  if (!baseline) {
    return {
      slot,
      versionId: activeVersion.versionId,
      hasBaseline: false,
      baselineBundleId: "",
      currentBundleId: currentBundle.bundleId,
      passed: false,
      drifts: [],
    };
  }

  const drifts: BundleHashDriftDetail[] = BUNDLE_HASH_COMPONENTS.map((component) => ({
    component,
    expected: baseline[component],
    actual: currentBundle[component],
    drift: baseline[component] !== currentBundle[component],
  }));

  return {
    slot,
    versionId: activeVersion.versionId,
    hasBaseline: true,
    baselineBundleId: baseline.bundleId,
    currentBundleId: currentBundle.bundleId,
    passed: drifts.every((d) => !d.drift),
    drifts,
  };
}

/**
 * 执行全量 bundle 级漂移检查（opt-in；需要 workspaceRoot 读取实现源码）。
 *
 * @param registryPath registry JSON 文件路径
 * @param opts 身份 + workspaceRoot
 * @returns 各 slot 的 bundle 漂移结果与人类可读摘要
 */
export function runBundleDriftCheck(
  registryPath: string,
  opts: {
    workspaceRoot: string;
    route: string;
    provider: string;
    modelVersion: string;
    temperature?: number | null;
    maxTokens?: number | null;
    profileId?: string;
  },
): {
  passed: boolean;
  checkedSlots: SlotBundleDriftResult[];
  timestamp: string;
  summary: string;
} {
  let registry: PromptRegistry;
  try {
    registry = loadRegistry(registryPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      passed: false,
      checkedSlots: [],
      timestamp: new Date().toISOString(),
      summary: `[bundle-drift-check] FAIL: registry 加载失败（fail-closed）：${message}`,
    };
  }

  const currentBundle = computeCurrentBundle(opts);

  const slots: PromptSlot[] = [
    "novelos_agentic",
    "style_optimizer",
    "writer_adapter",
    "retrieval_eval",
  ];

  const checkedSlots = slots.map((slot) => checkSlotBundleDrift(registry, slot, currentBundle));
  const allPassed = checkedSlots.every((s) => s.passed);

  const details = checkedSlots.map((s) => {
    if (!s.hasBaseline) return `${s.slot}: 无 bundle baseline（未确认）`;
    if (s.passed) return `${s.slot}: OK（bundleId=${s.baselineBundleId}）`;
    const changed = s.drifts.filter((d) => d.drift).map((d) => BUNDLE_COMPONENT_LABEL[d.component]);
    return `${s.slot}: drift=[${changed.join(", ")}] baseline=${s.baselineBundleId} current=${s.currentBundleId}`;
  });

  const summary = allPassed
    ? `[bundle-drift-check] PASS: 全部 ${slots.length} 个 slot bundle 一致（bundleId=${currentBundle.bundleId}）`
    : `[bundle-drift-check] FAIL: ${details.join("；")}`;

  return {
    passed: allPassed,
    checkedSlots,
    timestamp: new Date().toISOString(),
    summary,
  };
}
