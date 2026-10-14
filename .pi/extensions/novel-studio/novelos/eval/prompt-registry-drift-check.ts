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

import { resolveRoutingEnvironment } from "../../utils/config.js";
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
} from "./prompt-bundle-fingerprint-collector.js";
import { computeBundleManifest, type PromptBundleManifest } from "./prompt-bundle-manifest.js";
import { readFileSync } from "node:fs";

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

/** Bundle 身份漂移详情（模型/路由/采样身份，REGISTRY-DRIFT-IDENTITY-1） */
export interface BundleIdentityDriftDetail {
  field:
    | "modelVersion"
    | "provider"
    | "route"
    | "profileId"
    | "temperature"
    | "maxTokens"
    | "bundleId";
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
  /** slot 对应的生产 route 是否能从 model-routing 解析（未知路由 → false，阻断） */
  unknownRoute: boolean;
  passed: boolean;
  drifts: BundleHashDriftDetail[];
  identityDrifts: BundleIdentityDriftDetail[];
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
 * slot → 生产 route 声明（REGISTRY-DRIFT-IDENTITY-1）。
 *
 * 每个 prompt slot 对应 model-routing.json agent_routing 中该阶段实际使用的
 * 生产 route；漂移检查按 slot 从真实运行配置解析身份，不再接受调用方
 * 随意传入单一身份覆盖（否则身份漂移无法被检出）。
 */
export const SLOT_PRODUCTION_ROUTES: Record<PromptSlot, string> = {
  novelos_agentic: "v2_rawstage2_gemini31",
  style_optimizer: "v2_amplified_gemini31",
  writer_adapter: "v2_rawstage2_gemini31",
  retrieval_eval: "narrator_primary",
};

/** 从 model-routing.json 解析出的 slot 身份 */
export interface SlotRouteIdentity {
  route: string;
  provider: string;
  modelVersion: string;
  temperature: number | null;
  maxTokens: number | null;
}

/** model-routing provider 键 → 能力/profile 用的标准 provider 名 */
const ROUTING_PROVIDER_ALIASES: Record<string, string> = {
  gemini31: "gemini",
};

interface ModelRoutingConfig {
  providers?: Record<string, {
    model?: string;
    temperature?: Record<string, number>;
    max_tokens?: Record<string, number>;
  }>;
  agent_routing?: Record<string, {
    provider?: string;
    model?: string;
  }>;
}

/**
 * 按 slot 从 model-routing.json（真实运行配置）解析生产身份。
 *
 * - route 不在 agent_routing / provider 不存在 / provider 缺 model → 返回 null
 *   （未知路由，fail-closed：调用方必须把该 slot 判为失败）
 * - temperature / maxTokens 取 provider 级 per-route map（与 getAgentModelConfig
 *   生效位置一致）；缺条目 → null（如实记录）
 */
export function resolveSlotIdentityFromRouting(
  routingPath: string,
  slot: PromptSlot,
): SlotRouteIdentity | null {
  let routing: ModelRoutingConfig;
  try {
    routing = resolveRoutingEnvironment(JSON.parse(readFileSync(routingPath, "utf-8")) as ModelRoutingConfig);
  } catch {
    return null;
  }

  const route = SLOT_PRODUCTION_ROUTES[slot];
  const routeDef = routing.agent_routing?.[route];
  if (!routeDef?.provider || !routeDef.model) return null;

  const providerDef = routing.providers?.[routeDef.provider];
  if (!providerDef?.model) return null;

  return {
    route,
    provider: ROUTING_PROVIDER_ALIASES[routeDef.provider] ?? routeDef.provider,
    modelVersion: routeDef.model,
    temperature: providerDef.temperature?.[route] ?? null,
    maxTokens: providerDef.max_tokens?.[route] ?? null,
  };
}

/**
 * 计算指定 slot 的当前生产 Bundle（身份从 model-routing.json 按 slot 解析）。
 */
export function computeCurrentBundle(opts: {
  workspaceRoot: string;
  routingPath: string;
  slot: PromptSlot;
}): { identity: SlotRouteIdentity; manifest: PromptBundleManifest } | null {
  const identity = resolveSlotIdentityFromRouting(opts.routingPath, opts.slot);
  if (!identity) return null;

  const content = collectProductionBundleFingerprint({
    workspaceRoot: opts.workspaceRoot,
    slot: opts.slot,
    identity: {
      modelVersion: identity.modelVersion,
      provider: identity.provider,
      route: identity.route,
      temperature: identity.temperature,
      maxTokens: identity.maxTokens,
    },
  });
  return { identity, manifest: computeBundleManifest(content, "active") };
}

/**
 * 检查单个 slot 的 bundle 级漂移（完整行为身份，REGISTRY-DRIFT-IDENTITY-1）。
 *
 * 将 active 版本存储的 bundleManifest 与当前生产 bundle 对比：
 * - 未存储 baseline（hasBaseline=false）→ passed=false（fail-closed：缺基线即视为未确认）
 * - 任一组成 hash 变化 → passed=false
 * - 模型版本 / provider / route / profileId / temperature / maxTokens / bundleId
 *   任一身份字段变化 → passed=false
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
      unknownRoute: false,
      passed: false,
      drifts: [],
      identityDrifts: [],
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
      unknownRoute: false,
      passed: false,
      drifts: [],
      identityDrifts: [],
    };
  }

  const drifts: BundleHashDriftDetail[] = BUNDLE_HASH_COMPONENTS.map((component) => ({
    component,
    expected: baseline[component],
    actual: currentBundle[component],
    drift: baseline[component] !== currentBundle[component],
  }));

  const identityPairs: BundleIdentityDriftDetail["field"][] = [
    "modelVersion",
    "provider",
    "route",
    "profileId",
    "temperature",
    "maxTokens",
    "bundleId",
  ];
  const identityDrifts: BundleIdentityDriftDetail[] = identityPairs.map((field) => ({
    field,
    expected: String(baseline[field]),
    actual: String(currentBundle[field]),
    drift: baseline[field] !== currentBundle[field],
  }));

  return {
    slot,
    versionId: activeVersion.versionId,
    hasBaseline: true,
    baselineBundleId: baseline.bundleId,
    currentBundleId: currentBundle.bundleId,
    unknownRoute: false,
    passed:
      drifts.every((d) => !d.drift) && identityDrifts.every((d) => !d.drift),
    drifts,
    identityDrifts,
  };
}

/**
 * 执行全量 bundle 级漂移检查（fail-closed）。
 *
 * 身份按 slot 从 model-routing.json 解析（不接受调用方身份覆盖）；
 * 未知路由、缺基线、组件 hash 漂移、身份漂移均判失败。
 *
 * @param registryPath registry JSON 文件路径
 * @param opts workspaceRoot（读取实现源码）+ routingPath（model-routing.json）
 */
export function runBundleDriftCheck(
  registryPath: string,
  opts: {
    workspaceRoot: string;
    routingPath: string;
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

  const slots: PromptSlot[] = [
    "novelos_agentic",
    "style_optimizer",
    "writer_adapter",
    "retrieval_eval",
  ];

  const checkedSlots = slots.map((slot) => {
    const current = computeCurrentBundle({
      workspaceRoot: opts.workspaceRoot,
      routingPath: opts.routingPath,
      slot,
    });

    if (!current) {
      return {
        slot,
        versionId: "(unknown-route)",
        hasBaseline: false,
        baselineBundleId: "",
        currentBundleId: "",
        unknownRoute: true,
        passed: false,
        drifts: [],
        identityDrifts: [],
      } satisfies SlotBundleDriftResult;
    }

    return checkSlotBundleDrift(registry, slot, current.manifest);
  });

  const allPassed = checkedSlots.every((s) => s.passed);

  const details = checkedSlots.map((s) => {
    if (s.unknownRoute) {
      return `${s.slot}: 未知生产路由（model-routing 缺 ${SLOT_PRODUCTION_ROUTES[s.slot]}，fail-closed）`;
    }
    if (!s.hasBaseline) return `${s.slot}: 无 bundle baseline（未确认）`;
    if (s.passed) return `${s.slot}: OK（bundleId=${s.baselineBundleId}）`;
    const changed = [
      ...s.drifts.filter((d) => d.drift).map((d) => BUNDLE_COMPONENT_LABEL[d.component]),
      ...s.identityDrifts.filter((d) => d.drift).map((d) => d.field),
    ];
    return `${s.slot}: drift=[${changed.join(", ")}] baseline=${s.baselineBundleId} current=${s.currentBundleId}`;
  });

  const summary = allPassed
    ? `[bundle-drift-check] PASS: 全部 ${slots.length} 个 slot bundle 一致（含模型/路由/采样身份）`
    : `[bundle-drift-check] FAIL: ${details.join("；")}`;

  return {
    passed: allPassed,
    checkedSlots,
    timestamp: new Date().toISOString(),
    summary,
  };
}
