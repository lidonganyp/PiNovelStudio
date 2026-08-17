/**
 * MODEL-PROMPT-EVOLUTION-1（t2）— Prompt Bundle Manifest（eval-only）
 *
 * 定义「完整 Prompt Bundle」的行为指纹。`PromptProfile` 只是路由身份，
 * `PromptBundleManifest` 才是模型实际看到的完整行为环境的可复现指纹。
 *
 * 设计目标（见 docs/model-version-isolation-prompt-evolution-development-plan.md §4）：
 * - bundleId 必须由「全部组成 hash + 模型版本 + provider + route + profileId + 请求参数」
 *   的规范化序列化结果派生，不能只由 system prompt hash 派生。
 * - 避免错误归因：system prompt 未变，但上下文渲染、工具协议、终止逻辑或 provider
 *   adapter 变化时，Registry 不能再认为 Prompt 没变。
 *
 * 各组成 hash 的输入（content）由调用方提供，本模块只做规范化哈希与 bundleId 派生：
 * - systemPrompt / userPromptRenderer / chapterContractRenderer / toolSchema /
 *   toolProtocol / contextCompiler / outputParser / terminationProtocol /
 *   providerCapability / budget 均为 content 字符串。
 * - content 的来源（生产常量 / 实现文件源码）由
 *   prompt-bundle-fingerprint-collector.ts 负责采集，保证敏感且无手写绕过。
 *
 * Provider capability probe（计划 §6）：任何能力不得假设 provider 一定支持；
 * 未验证 = false（fail-closed），能力探测结果只决定可用能力，不替代 Eval。
 *
 * eval-only：只注册在 tsconfig.eval.json，不进入生产构建。
 */

import { createHash } from "node:crypto";

// ============================================================================
// 类型
// ============================================================================

/** Prompt Bundle 生命周期状态（与 prompt-registry.ts 的 PromptVersionStatus 一致） */
export type BundleStatus =
  | "draft"
  | "eval"
  | "rejected"
  | "held"
  | "canary"
  | "active";

/** 完整 Prompt Bundle 指纹 */
export interface PromptBundleManifest {
  /** 唯一 Bundle ID：由全部组成 hash + 模型版本 + provider + route + profileId + 请求参数派生 */
  bundleId: string;
  /** 模型版本（如 "gemini-3.1-pro"） */
  modelVersion: string;
  /** provider 名（如 "gemini"） */
  provider: string;
  /** 模型 route（如 "gemini_writer_v2" / "v2_rawstage2"） */
  route: string;
  /** PromptProfile 身份（如 "gemini_writer_v2" / "claude_writer_v1"） */
  profileId: string;
  systemPromptHash: string;
  userPromptRendererHash: string;
  chapterContractRendererHash: string;
  toolSchemaHash: string;
  toolProtocolHash: string;
  contextCompilerHash: string;
  outputParserHash: string;
  terminationProtocolHash: string;
  providerCapabilityHash: string;
  budgetHash: string;
  /** 实际请求参数（来自 model-routing 的 provider 级 per-route map） */
  temperature: number | null;
  maxTokens: number | null;
  status: BundleStatus;
}

/**
 * Provider 能力声明（fail-closed 探测结果）。
 *
 * 计划 §6：不得假设 provider 一定支持下列能力。未验证 = false，
 * 能力探测只决定可用能力，不替代 Eval；不把未验证能力标记为可用。
 */
export interface ProviderCapability {
  /** 原生 Function Calling（非 text-only ReAct 解析） */
  nativeFunctionCalling: boolean;
  /** 结构化输出约束（response_schema） */
  responseSchema: boolean;
  /** 思考配置（thinking_config） */
  thinkingConfig: boolean;
  /** 推理努力参数（reasoning_effort） */
  reasoningEffort: boolean;
  /** 原生 system instruction 支持 */
  nativeSystemInstruction: boolean;
  /** 推理 token 控制 */
  reasoningTokenControl: boolean;
  /** tool-call parser 的结构化返回保证 */
  structuredToolCallParser: boolean;
}

/**
 * Bundle 指纹输入：每个组件一段规范化 content 字符串。
 *
 * content 必须能唯一代表对应组件的行为。来源见 collector：
 * - 常量类（systemPrompt / toolSchema / contextCompiler / budget）直接导入生产常量；
 * - 代码类（userPromptRenderer / chapterContractRenderer / toolProtocol /
 *   outputParser / terminationProtocol）取实现文件源码内容；
 * - providerCapability 取能力声明的规范化序列化。
 */
export interface BundleFingerprintContent {
  modelVersion: string;
  provider: string;
  route: string;
  profileId: string;
  systemPrompt: string;
  userPromptRenderer: string;
  chapterContractRenderer: string;
  toolSchema: string;
  toolProtocol: string;
  contextCompiler: string;
  outputParser: string;
  terminationProtocol: string;
  providerCapability: ProviderCapability;
  budget: string;
  temperature: number | null;
  maxTokens: number | null;
}

// ============================================================================
// Provider capability（fail-closed）
// ============================================================================

/** 能力声明键名（用于规范化序列化，固定顺序） */
const CAPABILITY_KEYS: readonly (keyof ProviderCapability)[] = [
  "nativeFunctionCalling",
  "responseSchema",
  "thinkingConfig",
  "reasoningEffort",
  "nativeSystemInstruction",
  "reasoningTokenControl",
  "structuredToolCallParser",
];

/**
 * fail-closed 创建能力声明：只把显式声明为 true 的能力置 true，其余一律 false。
 *
 * 任何未经验证的能力不会被标记为可用。若声明了未知键，直接忽略（视为未验证）。
 *
 * @param declared 显式声明的能力（只读 true 项生效）
 */
export function createProviderCapability(
  declared?: Partial<ProviderCapability>,
): ProviderCapability {
  return {
    nativeFunctionCalling: declared?.nativeFunctionCalling === true,
    responseSchema: declared?.responseSchema === true,
    thinkingConfig: declared?.thinkingConfig === true,
    reasoningEffort: declared?.reasoningEffort === true,
    nativeSystemInstruction: declared?.nativeSystemInstruction === true,
    reasoningTokenControl: declared?.reasoningTokenControl === true,
    structuredToolCallParser: declared?.structuredToolCallParser === true,
  };
}

/**
 * 规范化序列化能力声明（固定键序，保证同一声明可复现 hash）。
 */
export function serializeProviderCapability(capability: ProviderCapability): string {
  return CAPABILITY_KEYS.map((key) => `${key}=${capability[key]}`).join("|");
}

// ============================================================================
// 哈希
// ============================================================================

/** SHA-256 完整 hex（组件指纹用完整哈希，保证唯一性） */
export function hashComponent(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

/** 计算能力指纹 hash */
export function computeProviderCapabilityHash(
  capability: ProviderCapability,
): string {
  return hashComponent(serializeProviderCapability(capability));
}

// ============================================================================
// Bundle Manifest 派生
// ============================================================================

/**
 * 派生 bundleId：由全部组成 hash + 模型版本 + provider + route + profileId +
 * temperature + maxTokens 的规范化序列化结果计算。
 *
 * 注意：bundleId 不包含 status（生命周期状态不属于行为环境）。
 * 任一行为组成变化都会改变 bundleId。
 */
export function deriveBundleId(manifest: PromptBundleManifest): string {
  const canonical = [
    manifest.modelVersion,
    manifest.provider,
    manifest.route,
    manifest.profileId,
    manifest.systemPromptHash,
    manifest.userPromptRendererHash,
    manifest.chapterContractRendererHash,
    manifest.toolSchemaHash,
    manifest.toolProtocolHash,
    manifest.contextCompilerHash,
    manifest.outputParserHash,
    manifest.terminationProtocolHash,
    manifest.providerCapabilityHash,
    manifest.budgetHash,
    String(manifest.temperature ?? ""),
    String(manifest.maxTokens ?? ""),
  ].join("\u0000");
  return hashComponent(canonical);
}

/**
 * 从指纹输入计算完整 PromptBundleManifest。
 *
 * @param content 指纹输入（各组件 content + 身份 + 请求参数）
 * @param status 初始生命周期状态（默认 draft）
 */
export function computeBundleManifest(
  content: BundleFingerprintContent,
  status: BundleStatus = "draft",
): PromptBundleManifest {
  const systemPromptHash = hashComponent(content.systemPrompt);
  const userPromptRendererHash = hashComponent(content.userPromptRenderer);
  const chapterContractRendererHash = hashComponent(content.chapterContractRenderer);
  const toolSchemaHash = hashComponent(content.toolSchema);
  const toolProtocolHash = hashComponent(content.toolProtocol);
  const contextCompilerHash = hashComponent(content.contextCompiler);
  const outputParserHash = hashComponent(content.outputParser);
  const terminationProtocolHash = hashComponent(content.terminationProtocol);
  const providerCapabilityHash = computeProviderCapabilityHash(content.providerCapability);
  const budgetHash = hashComponent(content.budget);

  const base: PromptBundleManifest = {
    bundleId: "",
    modelVersion: content.modelVersion,
    provider: content.provider,
    route: content.route,
    profileId: content.profileId,
    systemPromptHash,
    userPromptRendererHash,
    chapterContractRendererHash,
    toolSchemaHash,
    toolProtocolHash,
    contextCompilerHash,
    outputParserHash,
    terminationProtocolHash,
    providerCapabilityHash,
    budgetHash,
    temperature: content.temperature,
    maxTokens: content.maxTokens,
    status,
  };

  return {
    ...base,
    bundleId: deriveBundleId(base),
  };
}

/**
 * 规范化序列化完整 manifest（用于 trace 记录 / 报告输出，可复现）。
 *
 * 排除 bundleId 自身（避免递归），其余字段固定顺序。
 */
export function serializeBundleManifest(manifest: PromptBundleManifest): string {
  return JSON.stringify({
    modelVersion: manifest.modelVersion,
    provider: manifest.provider,
    route: manifest.route,
    profileId: manifest.profileId,
    systemPromptHash: manifest.systemPromptHash,
    userPromptRendererHash: manifest.userPromptRendererHash,
    chapterContractRendererHash: manifest.chapterContractRendererHash,
    toolSchemaHash: manifest.toolSchemaHash,
    toolProtocolHash: manifest.toolProtocolHash,
    contextCompilerHash: manifest.contextCompilerHash,
    outputParserHash: manifest.outputParserHash,
    terminationProtocolHash: manifest.terminationProtocolHash,
    providerCapabilityHash: manifest.providerCapabilityHash,
    budgetHash: manifest.budgetHash,
    temperature: manifest.temperature,
    maxTokens: manifest.maxTokens,
    status: manifest.status,
  });
}
