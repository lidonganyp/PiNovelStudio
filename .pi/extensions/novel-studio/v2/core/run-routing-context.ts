/**
 * RUN-ROUTING-CONTEXT — 任务级路由契约与运行锁（WP-01）
 *
 * 一次运行开始时解析并冻结路由身份；运行期间禁止因质量/延迟/单次失败/临时网络异常换模。
 * 跨模型恢复语义：
 *   Run A 失败 → blocked
 *   Run B 获得显式授权后使用另一 writerModel 重新生成
 *
 * 本模块统一既有 ModelLock / writerRouteLock，不另建第二套路由系统。
 */

import { getGeminiWriterModel } from "../../utils/config.js";
import { createHash, randomBytes } from "node:crypto";
import { loadModelRoutingSync, type AgentRoutingEntry } from "../../utils/config.js";
import type { ModelLock } from "./control-plane.js";
import {
  classifyRoute,
  type RouteClass,
  type RouteFallbackPolicy,
} from "./route-catalog.js";

export type WriterModelChoice = "claude" | "gemini31";

export type BudgetProfileName = "production_default" | "recovery_tight" | "eval_lab" | "preview";

export interface RunRoutingContext {
  schema: "pinovel.run-routing-context";
  version: "1.0";
  orchestratorRunId: string;
  generationRoute: string;
  editorialRoute: string;
  judgeRoute: string;
  provider: string;
  model: string;
  modelVersion: string;
  promptBundleHash: string;
  contextHash: string;
  temperature: number;
  maxTokens: number;
  timeout: number;
  toolSchemaHash: string;
  parser: string;
  terminationRule: string;
  budgetProfile: BudgetProfileName;
  routeClass: RouteClass;
  fallbackPolicy: RouteFallbackPolicy;
  /** 用户是否显式选择 writerModel（可追溯） */
  explicitWriterSelection: boolean;
  writerModel: WriterModelChoice;
  generationLock: ModelLock;
  editorialLock: ModelLock;
  judgeLock: ModelLock;
  createdAt: string;
}

export interface ResolveRunRoutingInput {
  orchestratorRunId?: string;
  writerModel?: WriterModelChoice;
  modelTestRoute?: string;
  promptBundleHash?: string;
  contextHash?: string;
  toolSchemaHash?: string;
  parser?: string;
  terminationRule?: string;
  budgetProfile?: BudgetProfileName;
  timeoutMs?: number;
  /** eval / lab 调用方标识；生产默认 novel_generate_chapter */
  caller?: string;
}

export interface ModelCallLockAssertionInput {
  routing: RunRoutingContext;
  stage: string;
  route: string;
  provider?: string;
  model?: string;
  modelVersion?: string;
  temperature?: number;
  maxTokens?: number;
  timeout?: number;
  promptBundleHash?: string;
  contextHash?: string;
  toolSchemaHash?: string;
  /** generation | editorial | judge | other */
  role?: "generation" | "editorial" | "judge" | "other";
}

export interface ModelCallLockAssertionResult {
  ok: boolean;
  errors: string[];
}

const DEFAULT_TIMEOUT_MS = 300_000;

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function newRunId(): string {
  return `run_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}

function readRouteEntry(routeName: string): AgentRoutingEntry | null {
  const routing = loadModelRoutingSync();
  const entry = routing.agent_routing[routeName];
  if (!entry) return null;
  if (typeof entry === "string") {
    return { provider: entry, model: "unknown" };
  }
  return entry;
}

function resolveSampling(routeName: string, provider: string): { temperature: number; maxTokens: number } {
  const routing = loadModelRoutingSync();
  const routeEntry = readRouteEntry(routeName);
  const providerCfg = routing.providers[provider];
  const temperature =
    routeEntry?.temperature ??
    providerCfg?.temperature?.[routeName] ??
    0.72;
  const maxTokens =
    routeEntry?.max_tokens ??
    providerCfg?.max_tokens?.[routeName] ??
    8192;
  return { temperature, maxTokens };
}

/**
 * 解析生产 writer 路由锁（与 unified-entry.resolveWriterModelRouteLock 对齐）。
 * modelTestRoute 与 writerModel 互斥；测试锁走 lab routeClass。
 */
export function resolveWriterRoutes(
  writerModel: WriterModelChoice | undefined,
): {
  rawRoute: string;
  amplifiedRoute: string;
  judgeRoute: string;
  provider: string;
  model: string;
  explicit: boolean;
  writerModel: WriterModelChoice;
} {
  if (writerModel === "claude") {
    return {
      rawRoute: "v2_rawstage2",
      amplifiedRoute: "v2_amplified",
      judgeRoute: "v2_opportunity_judge",
      provider: "claude",
      model: "claude-opus-4-6",
      explicit: true,
      writerModel: "claude",
    };
  }
  // 默认 Gemini 生产（含显式 gemini31）。
  // GEMINI38-FLASH-PRODUCTION-RESTORE-1：旧 gpt6astra writerModel 选项已按版本收敛原则移除，
  // 不保留并行回退；gpt provider 仅服务结构化节点。
  return {
    rawRoute: "v2_rawstage2_gemini31",
    amplifiedRoute: "v2_amplified_gemini31",
    judgeRoute: "v2_opportunity_judge",
    provider: "gemini31",
    model: getGeminiWriterModel(),
    explicit: writerModel === "gemini31",
    writerModel: "gemini31",
  };
}

/**
 * 在运行开始前解析一次并冻结。
 * 禁止在运行中因质量/延迟/策略失败重新调用本函数换模。
 */
export function resolveRunRouting(input: ResolveRunRoutingInput): RunRoutingContext {
  if (input.writerModel && input.modelTestRoute) {
    throw new Error("writerModel 与 modelTestRoute 不能同时设置；生产写作模型与实验路由必须显式分离");
  }

  let generationRoute: string;
  let editorialRoute: string;
  let judgeRoute: string;
  let provider: string;
  let model: string;
  let explicitWriterSelection = false;
  let writerModel: WriterModelChoice = "gemini31";
  let routeClass: RouteClass = "production";
  let budgetProfile: BudgetProfileName = input.budgetProfile ?? "production_default";

  if (input.modelTestRoute) {
    // 开发/实验锁：不改变生产默认解析表，仅锁定当次 lab 路由
    const testMap: Record<string, { generate: string; provider: string; model: string }> = {
      glm: { generate: "nb4_generate_glm", provider: "glm", model: "glm-5.2" },
      doubao: { generate: "nb4_generate_doubao", provider: "doubao", model: "doubao-seed-2-1-pro-260628" },
      gpt: { generate: "nb4_generate_gpt56", provider: "gpt", model: "gpt-5.6-sol" },
      claude: { generate: "v2_rawstage2", provider: "claude", model: "claude-opus-4-6" },
      gemini31: { generate: "nb4_generate_gemini31", provider: "gemini31", model: getGeminiWriterModel() },
      deepseek: { generate: "narrator_testing_deepseek", provider: "deepseek", model: "deepseek-v4-flash" },
    };
    const locked = testMap[input.modelTestRoute];
    if (!locked) {
      throw new Error(`未知 modelTestRoute: ${input.modelTestRoute}`);
    }
    generationRoute = locked.generate;
    editorialRoute = locked.generate;
    judgeRoute = "v2_opportunity_judge";
    provider = locked.provider;
    model = locked.model;
    routeClass = classifyRoute(generationRoute).routeClass;
    budgetProfile = input.budgetProfile ?? "eval_lab";
  } else {
    const writer = resolveWriterRoutes(input.writerModel);
    generationRoute = writer.rawRoute;
    editorialRoute = writer.amplifiedRoute;
    judgeRoute = writer.judgeRoute;
    provider = writer.provider;
    model = writer.model;
    explicitWriterSelection = writer.explicit;
    writerModel = writer.writerModel;
    routeClass = "production";
  }

  const generationMeta = classifyRoute(generationRoute);
  if (routeClass === "production" && !generationMeta.productionEligible) {
    throw new Error(`生产运行不得锁定非生产路由: ${generationRoute}`);
  }

  const sampling = resolveSampling(generationRoute, provider);
  const routeEntry = readRouteEntry(generationRoute);
  const fallbackPolicy: RouteFallbackPolicy =
    Array.isArray(routeEntry?.fallback) && routeEntry!.fallback!.length === 0
      ? "none"
      : generationMeta.fallbackPolicy;

  const generationLock: ModelLock = {
    route: generationRoute,
    provider,
    model,
  };
  const editorialLock: ModelLock = {
    route: editorialRoute,
    provider,
    model,
  };
  const judgeLock: ModelLock = {
    route: judgeRoute,
    provider: "gpt",
    model: "gpt-5.6-sol",
  };

  return Object.freeze({
    schema: "pinovel.run-routing-context",
    version: "1.0",
    orchestratorRunId: input.orchestratorRunId ?? newRunId(),
    generationRoute,
    editorialRoute,
    judgeRoute,
    provider,
    model,
    modelVersion: model,
    promptBundleHash: input.promptBundleHash ?? "bundle:unset",
    contextHash: input.contextHash ?? "context:unset",
    temperature: sampling.temperature,
    maxTokens: sampling.maxTokens,
    timeout: input.timeoutMs ?? (Number(process.env.PINOVEL_MODEL_REQUEST_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS),
    toolSchemaHash: input.toolSchemaHash ?? "toolschema:unset",
    parser: input.parser ?? "chapter_prose_only",
    terminationRule: input.terminationRule ?? "stage_complete_or_failure_envelope",
    budgetProfile,
    routeClass,
    fallbackPolicy,
    explicitWriterSelection,
    writerModel,
    generationLock,
    editorialLock,
    judgeLock,
    createdAt: new Date().toISOString(),
  });
}

/** 生产写链路允许的语义路由别名（Agentic 内部 route 名 ≠ config 写路由名） */
const GENERATION_ROUTE_ALIASES = new Set([
  "novelos_agentic",
  "agentic_raw",
  "narrator_primary",
  "v2_rawstage2",
  "v2_rawstage2_gemini31",
  "v2_amplified",
  "v2_amplified_gemini31",
]);

/**
 * 每次模型调用前校验：provider/model 身份与关键参数必须匹配锁。
 * route 允许生产写别名（Agentic 语义路由）；评测/开发路由在生产 run 中硬阻断。
 */
export function assertModelCallMatchesLock(
  input: ModelCallLockAssertionInput,
): ModelCallLockAssertionResult {
  const errors: string[] = [];
  const { routing } = input;
  const role = input.role ?? "generation";

  const expectedProvider =
    role === "judge" ? routing.judgeLock.provider : routing.provider;
  const expectedModel =
    role === "judge" ? routing.judgeLock.model : routing.model;

  // 身份锁：provider/model 是不可漂移的硬约束
  if (input.provider !== undefined && input.provider !== expectedProvider) {
    errors.push(`provider expected=${expectedProvider} actual=${input.provider}`);
  }
  if (input.model !== undefined && input.model !== expectedModel) {
    errors.push(`model expected=${expectedModel} actual=${input.model}`);
  }
  if (
    input.modelVersion !== undefined &&
    role !== "judge" &&
    input.modelVersion !== routing.modelVersion
  ) {
    errors.push(`modelVersion expected=${routing.modelVersion} actual=${input.modelVersion}`);
  }

  // 路由约束：允许 generation/editorial 锁路由 + 生产写别名；禁止跨 class 污染
  const routeMeta = classifyRoute(input.route);
  const allowedGenerationRoutes = new Set([
    routing.generationRoute,
    routing.editorialRoute,
    ...GENERATION_ROUTE_ALIASES,
  ]);

  if (role === "judge") {
    if (routing.routeClass === "production") {
      // 生产主链路不得调用文学裁判（计划 WP-02 / 发布门槛）
      errors.push("production literary judge calls are forbidden");
    } else if (input.route !== routing.judgeRoute && !input.route.includes("judge")) {
      errors.push(`judge route expected=${routing.judgeRoute} actual=${input.route}`);
    }
  } else if (role === "editorial") {
    if (
      input.route !== routing.editorialRoute &&
      !allowedGenerationRoutes.has(input.route)
    ) {
      errors.push(`editorial route expected=${routing.editorialRoute} actual=${input.route}`);
    }
  } else {
    // generation / other
    if (!allowedGenerationRoutes.has(input.route) && input.route !== routing.generationRoute) {
      // modelTestRoute / lab run：允许锁定的 generationRoute 本身
      if (input.route !== routing.generationRoute) {
        // 若 route class 与 run 不一致则硬阻断
        if (
          routing.routeClass === "production" &&
          (routeMeta.routeClass === "evaluation" ||
            routeMeta.routeClass === "development" ||
            routeMeta.routeClass === "calibration")
        ) {
          errors.push(
            `production run cannot call ${routeMeta.routeClass} route: ${input.route}`,
          );
        } else if (
          routing.routeClass === "production" &&
          !routeMeta.productionEligible &&
          !GENERATION_ROUTE_ALIASES.has(input.route)
        ) {
          // 非写路由的内部结构化调用：仅当 provider/model 已匹配时放行（本地/无 provider 跳过）
          if (input.provider !== undefined || input.model !== undefined) {
            errors.push(
              `unexpected generation route under production lock: ${input.route}`,
            );
          }
        }
      }
    }
  }

  // 采样参数：仅在调用方显式传入时校验（否则由 model-routing 侧生效）
  if (
    input.temperature !== undefined &&
    role !== "judge" &&
    input.temperature !== routing.temperature
  ) {
    errors.push(`temperature expected=${routing.temperature} actual=${input.temperature}`);
  }
  if (
    input.maxTokens !== undefined &&
    role !== "judge" &&
    input.maxTokens !== routing.maxTokens
  ) {
    errors.push(`maxTokens expected=${routing.maxTokens} actual=${input.maxTokens}`);
  }
  if (input.timeout !== undefined && input.timeout > routing.timeout) {
    errors.push(`timeout ${input.timeout} exceeds lock timeout ${routing.timeout}`);
  }
  if (
    input.promptBundleHash !== undefined &&
    input.promptBundleHash !== "bundle:unset" &&
    routing.promptBundleHash !== "bundle:unset" &&
    input.promptBundleHash !== routing.promptBundleHash
  ) {
    errors.push("promptBundleHash mismatch");
  }
  if (
    input.contextHash !== undefined &&
    input.contextHash !== "context:unset" &&
    routing.contextHash !== "context:unset" &&
    input.contextHash !== routing.contextHash
  ) {
    errors.push("contextHash mismatch");
  }
  if (
    input.toolSchemaHash !== undefined &&
    input.toolSchemaHash !== "toolschema:unset" &&
    routing.toolSchemaHash !== "toolschema:unset" &&
    input.toolSchemaHash !== routing.toolSchemaHash
  ) {
    errors.push("toolSchemaHash mismatch");
  }

  return { ok: errors.length === 0, errors };
}

/** 便捷：不匹配时抛错（fail-closed） */
export function assertModelCallMatchesLockOrThrow(input: ModelCallLockAssertionInput): void {
  const result = assertModelCallMatchesLock(input);
  if (!result.ok) {
    throw new Error(`model lock conflict: ${result.errors.join("; ")}`);
  }
}

/** 从 RunRoutingContext 导出 control-plane ModelLock */
export function toGenerationModelLock(routing: RunRoutingContext): ModelLock {
  return { ...routing.generationLock };
}

export function toJudgeModelLock(routing: RunRoutingContext): ModelLock {
  return { ...routing.judgeLock };
}

export function fingerprintRunRouting(routing: RunRoutingContext): string {
  return stableHash(
    [
      routing.orchestratorRunId,
      routing.generationRoute,
      routing.editorialRoute,
      routing.provider,
      routing.model,
      routing.modelVersion,
      routing.promptBundleHash,
      routing.contextHash,
      String(routing.temperature),
      String(routing.maxTokens),
      String(routing.timeout),
      routing.toolSchemaHash,
      routing.budgetProfile,
      routing.routeClass,
      routing.fallbackPolicy,
    ].join("|"),
  );
}
