/**
 * PiNovelStudio — 配置管理
 *
 * 读取和管理项目配置文件
 */

import { readFile, writeFile, access, constants } from "fs/promises";
import { resolve, join, dirname } from "path";
import { existsSync, readFileSync } from "fs";
import { validateWorkspaceId } from "./fs.js";

export interface ModelRoutingConfig {
  providers: Record<string, ProviderConfig>;
  disabled_providers?: string[];
  stage_routing?: Record<string, AgentRoutingEntry>;
  agent_routing: Record<string, string | AgentRoutingEntry>;
  fallback: Record<string, string[]>;
  retry: {
    max_retries: number;
    retry_delay_ms: number;
  };
}

export interface AgentRoutingEntry {
  provider: string;
  model: string;
  note?: string;
  /**
   * MODEL-ROUTING-CLAUDE46-1A: route-level fallback chain.
   *
   * When present, takes precedence over the provider-level `fallback[provider]` chain.
   * - `[]` = hard block on failure (no provider-level fallback applied).
   * - `["gpt"]` = only fall back to "gpt" (overrides provider-level chain).
   * - undefined = inherit provider-level `fallback[provider]` (legacy behavior).
   *
   * Required for all production v2 routes (v2_rawstage2 / v2_amplified /
   * v2_chinese_calibration / v2_opportunity_judge / v2_literary_judge)
   * to make routing explicit and auditable.
   */
  fallback?: string[];
  base_url_env?: string;
  api_key_env?: string;
  model_env?: string;
  temperature?: number;
  max_tokens?: number;
}

export type ProviderProtocol = "openai" | "anthropic" | "claude" | "chat";

export interface ProviderRequestOptions {
  thinking?: {
    type: "enabled" | "disabled";
    reasoning_effort?: "high" | "mid" | "low";
  };
}

export interface ProviderConfig {
  name: string;
  base_url: string;
  api_key_env: string;
  protocol?: ProviderProtocol;
  model?: string;
  request_options?: ProviderRequestOptions;
  temperature: Record<string, number>;
  max_tokens: Record<string, number>;
  /** 支持嵌套模型结构的 provider（如 deepseek） */
  models?: Record<string, { id: string; display_name?: string; best_for?: string[] }>;
}

export interface ResolvedProviderConfig {
  provider: string;
  base_url: string;
  model: string;
  protocol: ProviderProtocol;
  apiKey: string;
  request_options?: ProviderRequestOptions;
}

export interface QualityGatesConfig {
  quad_gates: {
    [key: string]: QuadGateConfig;
  };
  emotion_metronome: EmotionConfig;
  anti_ai: AntiAIConfig;
  brainhole: BrainholeConfig;
  style: StyleConfig;
}

export interface QuadGateConfig {
  description: string;
  checks: string[];
  pass_threshold: number;
  blocker_on_fail: boolean;
}

export interface EmotionConfig {
  default_satisfaction_interval: number;
  default_max_oppression: number;
  default_hook_interval: number;
  min_emotion_diversity: number;
  climax_position_range: [number, number];
  require_cliffhanger_ending: boolean;
}

export interface AntiAIConfig {
  green_threshold: number;
  yellow_threshold: number;
  max_rewrite_rounds: number;
  enabled_patterns: string;
}

export interface BrainholeConfig {
  default_aggressiveness: number;
  default_auto_threshold: number;
  max_per_chapter: number;
}

export interface StyleConfig {
  max_reshape_rounds: number;
  min_style_match: number;
}

export interface WorkspaceConfig {
  workspaceId: string;
  novelName: string;
  genre: string;
  subGenres: string[];
  styleProfile: string;
  styleOverrides: Record<string, unknown>;
  brainholePreferences: {
    enabledPatterns: string[];
    aggressiveness: number;
    autoApplyThreshold: number;
    maxInjectionsPerChapter: number;
  };
  qualityGates: {
    antiAiThreshold: number;
    emotionMetronome: string;
    dependencyCheck: string;
    minSatisfactionDensity: number;
    maxOppressionLength: number;
  };
  targetWordCount: {
    perChapter: { min: number; max: number };
    total: number;
  };
  chapterProgress: {
    completed: number;
    current: number;
  };
}

export interface GlobalConfig {
  projectRoot: string;
  workspacesPath: string;
  stylesPath: string;
  brainholesPath: string;
  dataPath: string;
  scriptsPath: string;
  modelRouting: ModelRoutingConfig;
  qualityGates: QualityGatesConfig;
}

let cachedConfig: GlobalConfig | null = null;

let _projectRoot: string | null = null;
let dotenvLoadedForRoot: string | null = null;

const DEFAULT_DISABLED_PROVIDERS = new Set(["qwen", "ernie"]);

export function isProviderDisabled(providerKey: string): boolean {
  const normalized = providerKey.trim().toLowerCase();
  if (DEFAULT_DISABLED_PROVIDERS.has(normalized)) {
    return true;
  }
  const configured = loadModelRoutingSync().disabled_providers || [];
  return configured.some((provider) => provider.trim().toLowerCase() === normalized);
}

// 历史：曾在此处硬编码 DEFAULT_DEPLOYMENT_ROOT="D:\\CODE\\PiNovelStudio" 并在
// resolveProjectRoot 中以高于 candidate/cwd 的优先级检查它，导致干净 clone 在别处
// 运行时跨检出污染原始仓库 workspace。已在生产内核瘦身（Step 1a）中移除。
// 项目根解析顺序现为：env PINOVEL_PROJECT_ROOT → candidate → _projectRoot 缓存 → cwd。

function isProjectRoot(root: string): boolean {
  return (
    existsSync(join(root, ".pi", "extensions", "novel-studio")) &&
    existsSync(join(root, "docs", "top-tier-chinese-novel-system-development-plan.md"))
  );
}

function findProjectRoot(candidate: string): string | null {
  let current = resolve(candidate);
  while (true) {
    if (isProjectRoot(current)) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function resolveProjectRoot(candidate?: string | null): string {
  const envRoot = process.env.PINOVEL_PROJECT_ROOT;
  if (envRoot) {
    const resolvedEnvRoot = findProjectRoot(envRoot);
    if (resolvedEnvRoot) {
      return resolvedEnvRoot;
    }
  }

  if (candidate) {
    const resolvedCandidate = findProjectRoot(candidate);
    if (resolvedCandidate) {
      return resolvedCandidate;
    }
  }

  if (_projectRoot) {
    const resolvedCachedRoot = findProjectRoot(_projectRoot);
    if (resolvedCachedRoot) {
      return resolvedCachedRoot;
    }
  }

  const cwdRoot = findProjectRoot(process.cwd());
  return cwdRoot || resolve(process.cwd());
}

/** 由扩展初始化时设置, 因 PI 中 process.cwd() 指向安装目录 */
export function setProjectRoot(root: string): void {
  _projectRoot = resolveProjectRoot(root);
  cachedConfig = null;
}

/** 获取项目根目录 */
export function getProjectRoot(): string {
  _projectRoot = resolveProjectRoot(_projectRoot);
  return _projectRoot;
}

/**
 * 配置文件路径
 */
function getConfigPath(filename: string): string {
  return join(getProjectRoot(), "config", filename);
}

function getExtensionPath(subpath: string = ""): string {
  return join(getProjectRoot(), ".pi", "extensions", "novel-studio", subpath);
}

/**
 * 检查文件是否存在
 */
export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 加载 JSON 配置文件
 */
export async function loadJsonConfig<T>(path: string): Promise<T> {
  loadProjectDotEnv();
  if (!existsSync(path)) {
    throw new Error(`Config file not found: ${path}`);
  }
  const content = await readFile(path, "utf-8");
  return JSON.parse(content) as T;
}

/**
 * 保存 JSON 配置文件
 */
export async function saveJsonConfig<T>(path: string, data: T): Promise<void> {
  const content = JSON.stringify(data, null, 2);
  await writeFile(path, content, "utf-8");
}

/**
 * 加载模型路由配置
 */
export async function loadModelRouting(): Promise<ModelRoutingConfig> {
  const path = getConfigPath("model-routing.json");
  return loadJsonConfig<ModelRoutingConfig>(path);
}

export function loadModelRoutingSync(): ModelRoutingConfig {
  loadProjectDotEnv();
  const path = getConfigPath("model-routing.json");
  if (!existsSync(path)) {
    throw new Error(`Config file not found: ${path}`);
  }
  return JSON.parse(readFileSync(path, "utf-8")) as ModelRoutingConfig;
}

/**
 * 加载质量门控配置
 */
export async function loadQualityGates(): Promise<QualityGatesConfig> {
  const path = getConfigPath("quality-gates.json");
  return loadJsonConfig<QualityGatesConfig>(path);
}

/**
 * 加载 Workspace 配置
 */
export async function loadWorkspaceConfig(workspaceId: string): Promise<WorkspaceConfig> {
  validateWorkspaceId(workspaceId);
  const path = join(getProjectRoot(), "workspaces", workspaceId, "config.json");
  return loadJsonConfig<WorkspaceConfig>(path);
}

/**
 * 保存 Workspace 配置
 */
export async function saveWorkspaceConfig(
  workspaceId: string,
  config: WorkspaceConfig
): Promise<void> {
  validateWorkspaceId(workspaceId);
  const dir = join(getProjectRoot(), "workspaces", workspaceId);
  const path = join(dir, "config.json");
  await saveJsonConfig(path, config);
}

/**
 * 加载全局配置（带缓存）
 */
export async function loadGlobalConfig(): Promise<GlobalConfig> {
  loadProjectDotEnv();
  if (cachedConfig) {
    return cachedConfig;
  }

  const projectRoot = getProjectRoot();

  const [modelRouting, qualityGates] = await Promise.all([
    loadModelRouting(),
    loadQualityGates(),
  ]);

  cachedConfig = {
    projectRoot,
    workspacesPath: join(projectRoot, "workspaces"),
    stylesPath: join(projectRoot, "styles"),
    brainholesPath: join(projectRoot, "brainholes"),
    dataPath: join(projectRoot, "data"),
    scriptsPath: join(projectRoot, "scripts"),
    modelRouting,
    qualityGates,
  };

  return cachedConfig;
}

/**
 * 清除配置缓存。
 *
 * P28: 同时清除 dotenvLoadedForRoot 标记，让下次 loadProjectDotEnv() 能重读 .env。
 * 之前只清 cachedConfig 不清 dotenvLoadedForRoot，导致 .env 修改后旧值一直驻留。
 */
export function clearConfigCache(): void {
  cachedConfig = null;
  dotenvLoadedForRoot = null;
}

/**
 * 解析 .env 文件并写入 process.env。
 *
 * P28: 抽取共享解析逻辑，供 loadProjectDotEnv（不覆盖）和 reloadProjectEnv（覆盖）复用。
 * overrideExisting=false 时只填 process.env 中不存在的 key（保留既有行为）；
 * overrideExisting=true 时无条件覆盖（解决旧值驻留问题）。
 */
function parseDotEnvFile(envPath: string, overrideExisting: boolean): void {
  if (!existsSync(envPath)) {
    return;
  }

  const envContent = readFileSync(envPath, "utf-8");
  for (const rawLine of envContent.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) {
      continue;
    }

    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key && (overrideExisting || !process.env[key])) {
      process.env[key] = value;
    }
  }
}

function loadProjectDotEnv(): void {
  const projectRoot = getProjectRoot();
  if (dotenvLoadedForRoot === projectRoot) {
    return;
  }

  dotenvLoadedForRoot = projectRoot;
  const envPath = join(projectRoot, ".env");
  parseDotEnvFile(envPath, false);
}

/**
 * P28: 强制重新读取项目 .env，可覆盖 process.env 中已存在的旧值。
 *
 * 用途：用户修改 .env（如切换 DOUBAO_MODEL 从 Turbo 到 Pro）后，
 * novel_generate_chapter 在入口调用此函数确保读到最新配置，
 * 不被 dotenvLoadedForRoot 缓存或 `!process.env[key]` 不覆盖逻辑阻挡。
 *
 * 不修改 .env 文件本身，只重读并覆盖 process.env。
 *
 * @param overrideExisting true 时覆盖已存在的 process.env 值（默认，用于 .env 修改后重读）
 */
export function reloadProjectEnv(overrideExisting: boolean = true): void {
  clearConfigCache();
  const projectRoot = getProjectRoot();
  dotenvLoadedForRoot = projectRoot;
  const envPath = join(projectRoot, ".env");
  parseDotEnvFile(envPath, overrideExisting);
}

/**
 * 获取特定 Agent 的模型配置
 */
export async function getAgentModelConfig(
  agentName: string
): Promise<{
  provider: string;
  base_url: string;
  model: string;
  protocol: ProviderProtocol;
  temperature: number;
  max_tokens: number;
  request_options?: ProviderRequestOptions;
} | null> {
  const config = await loadGlobalConfig();
  const routing = config.modelRouting.agent_routing[agentName];

  if (!routing) {
    return null;
  }

  let providerKey: string;
  let modelOverride: string | undefined;

  // P34-T09: 矩阵评测用 env override。若 PINOVEL_NODE_PROVIDER_OVERRIDE 设置为有效 provider key，
  // 且当前 agentName 属于"可覆盖 gate 节点"集合（非 narrator_primary/style_shaper 等已有 per-call 机制的节点），
  // 则用该 provider 覆盖。仅用于 A/B 矩阵评测，不改变生产路由。
  const GATE_OVERRIDABLE_NODES = new Set([
    "architect", "skeleton_extractor", "detail_ledger", "emotion_metronome",
    "anti_ai_detector", "dependency_checker", "type_contract_engine", "drama_coach",
    "reader_expectation_preplan", "world_scan", "info_release_detector",
    "supporting_check", "ending_craft", "mid_chapter_checker", "reader_expectation_post",
    "worldbuilder", "world_preplan", "brainhole_injector",
  ]);
  const envOverride = process.env.PINOVEL_NODE_PROVIDER_OVERRIDE;
  if (envOverride && GATE_OVERRIDABLE_NODES.has(agentName) && config.modelRouting.providers[envOverride]) {
    providerKey = envOverride;
    modelOverride = undefined; // 用 provider 默认 model
  } else if (typeof routing === "string") {
    if (routing === "pi_default") {
      return null;
    }
    providerKey = routing;
  } else {
    providerKey = routing.provider;
    modelOverride = routing.model;
  }

  const provider = config.modelRouting.providers[providerKey];
  if (!provider) {
    return null;
  }
  if (isProviderDisabled(providerKey)) {
    throw new Error(`Provider is disabled or unavailable: ${providerKey}`);
  }

  // 获取模型：优先使用 routing 指定的 model，其次尝试 provider 顶层 model，
  // 最后处理 deepseek 等使用嵌套 models 结构的 provider
  let resolvedModel = modelOverride || provider.model;
  if (!resolvedModel && provider.models) {
    const firstModelKey = Object.keys(provider.models)[0];
    resolvedModel = provider.models[firstModelKey]?.id || firstModelKey;
  }

  resolvedModel = getModelOverride(providerKey, resolvedModel);

  return {
    provider: providerKey,
    base_url: getBaseUrl(providerKey, provider.base_url),
    model: resolvedModel || "unknown",
    protocol: provider.protocol || inferProviderProtocol(providerKey),
    temperature: provider.temperature?.[agentName] ?? 0.7,
    max_tokens: provider.max_tokens?.[agentName] ?? 4096,
    request_options: provider.request_options,
  };
}

export function getProviderDefaultConfig(
  providerKey: string
): ResolvedProviderConfig {
  if (isProviderDisabled(providerKey)) {
    throw new Error(`Provider is disabled or unavailable: ${providerKey}`);
  }
  const routing = loadModelRoutingSync();
  const provider = routing.providers[providerKey];
  if (!provider) {
    throw new Error(`No provider config found for provider: ${providerKey}`);
  }

  let resolvedModel = provider.model;
  if (!resolvedModel && provider.models) {
    const firstModelKey = Object.keys(provider.models)[0];
    resolvedModel = provider.models[firstModelKey]?.id || firstModelKey;
  }

  resolvedModel = getModelOverride(providerKey, resolvedModel);

  return {
    provider: providerKey,
    base_url: getBaseUrl(providerKey, provider.base_url),
    model: resolvedModel || "unknown",
    protocol: provider.protocol || inferProviderProtocol(providerKey),
    apiKey: getApiKey(providerKey) || "",
    request_options: provider.request_options,
  };
}

/**
 * 获取 API Key（从环境变量）
 */
export function getApiKey(providerKey: string): string | null {
  loadProjectDotEnv();
  const envKey = resolveProviderApiKeyEnv(providerKey);
  return envKey ? process.env[envKey] || null : null;
}

function resolveProviderApiKeyEnv(providerKey: string): string | undefined {
  try {
    return loadModelRoutingSync().providers[providerKey]?.api_key_env ||
      configMap[providerKey]?.apiKeyEnv;
  } catch {
    return configMap[providerKey]?.apiKeyEnv;
  }
}

export function getBaseUrl(providerKey: string, defaultBaseUrl: string): string {
  loadProjectDotEnv();
  const envKey = configMap[providerKey]?.baseUrlEnv;
  return (envKey && process.env[envKey]) || defaultBaseUrl;
}

export function getModelOverride(
  providerKey: string,
  defaultModel?: string
): string | undefined {
  loadProjectDotEnv();
  const envKeys = getModelOverrideEnvKeys(providerKey, defaultModel);
  for (const envKey of envKeys) {
    const value = process.env[envKey];
    if (value) {
      return value;
    }
  }
  return defaultModel;
}

function getModelOverrideEnvKeys(providerKey: string, defaultModel?: string): string[] {
  if (providerKey !== "deepseek") {
    return modelOverrideEnvMap[providerKey] || [];
  }

  const lowerDefaultModel = defaultModel?.toLowerCase() ?? "";
  if (lowerDefaultModel.includes("flash")) {
    return ["DEEPSEEK_MODEL_FLASH", "DEEPSEEK_MODEL"];
  }
  if (lowerDefaultModel.includes("pro")) {
    return ["DEEPSEEK_MODEL_PRO", "DEEPSEEK_MODEL"];
  }
  return modelOverrideEnvMap.deepseek;
}

function inferProviderProtocol(providerKey: string): ProviderProtocol {
  return providerKey === "claude" ? "anthropic" : "openai";
}

const configMap: Record<
  string,
  { apiKeyEnv: string; baseUrlEnv?: string }
> = {
  glm: {
    apiKeyEnv: "GLM_API_KEY",
    baseUrlEnv: "GLM_BASE_URL",
  },
  doubao: {
    apiKeyEnv: "ARK_API_KEY",
    baseUrlEnv: "ARK_BASE_URL",
  },
  deepseek: {
    apiKeyEnv: "DEEPSEEK_API_KEY",
    baseUrlEnv: "DEEPSEEK_BASE_URL",
  },
  qwen: {
    apiKeyEnv: "QWEN_API_KEY",
    baseUrlEnv: "QWEN_BASE_URL",
  },
  claude: {
    apiKeyEnv: "CLAUDE_API_KEY",
    baseUrlEnv: "CLAUDE_BASE_URL",
  },
  gpt: {
    apiKeyEnv: "GPT_API_KEY",
    baseUrlEnv: "GPT_BASE_URL",
  },
  ernie: {
    apiKeyEnv: "ERNIE_API_KEY",
    baseUrlEnv: "ERNIE_BASE_URL",
  },
};

const modelOverrideEnvMap: Record<string, string[]> = {
  glm: ["GLM_MODEL"],
  doubao: ["DOUBAO_MODEL", "ARK_MODEL"],
  deepseek: ["DEEPSEEK_MODEL", "DEEPSEEK_MODEL_FLASH", "DEEPSEEK_MODEL_PRO"],
  qwen: ["QWEN_MODEL"],
  claude: ["CLAUDE_MODEL"],
  gpt: ["GPT_MODEL"],
  ernie: ["ERNIE_MODEL"],
};

export { getExtensionPath };

// ============================================================================
// Rhythm Adapter（从 legacy craft/event-writing-contract 迁移，Phase 7 解耦）
// ============================================================================

export type RhythmAdapter = "default" | "doubao";

/**
 * 解析当前 rhythm adapter 策略。
 * - env PINOVEL_RHYTHM_ADAPTER=doubao|default 时优先返回 env override
 * - 否则按 model-routing.json 中 narrator_primary.provider 判断：
 *   doubao → "doubao"，其余 → "default"
 */
export function resolveRhythmAdapter(): RhythmAdapter {
  const envOverride = process.env.PINOVEL_RHYTHM_ADAPTER;
  if (envOverride === "doubao" || envOverride === "default") {
    return envOverride;
  }
  try {
    const routing = loadModelRoutingSync();
    const narratorPrimary = routing.agent_routing?.narrator_primary;
    const providerKey = typeof narratorPrimary === "string"
      ? narratorPrimary
      : narratorPrimary?.provider;
    return providerKey === "doubao" ? "doubao" : "default";
  } catch {
    return "default";
  }
}
