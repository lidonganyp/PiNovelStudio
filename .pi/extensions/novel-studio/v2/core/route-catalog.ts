/**
 * ROUTE-CATALOG — 生产/评测/开发/校准路由物理隔离（WP-02）
 *
 * 为每条 route 提供 routeClass / productionEligible / allowedCallers / fallbackPolicy。
 * 三层保护：
 * 1. 配置层校验（validateRouteCatalog）
 * 2. 运行时调用方校验（assertCallerAllowed）
 * 3. 静态审计脚本（scripts/audit-route-isolation.mjs）
 */

import { loadModelRoutingSync, type AgentRoutingEntry } from "../../utils/config.js";

export type RouteClass = "production" | "evaluation" | "development" | "calibration";

export type RouteFallbackPolicy = "none" | "provider_inherit" | "explicit_chain";

export interface RouteMetadata {
  route: string;
  routeClass: RouteClass;
  productionEligible: boolean;
  allowedCallers: string[];
  fallbackPolicy: RouteFallbackPolicy;
  provider?: string;
  model?: string;
  modelVersion?: string;
  labTesting?: boolean;
  note?: string;
}

/** 生产章节生成允许的调用方 */
export const PRODUCTION_CHAPTER_CALLERS = [
  "novel_generate_chapter",
  "unified_entry",
  "unified_orchestrator",
] as const;

/** 明确生产写路由（默认 Gemini + 显式 Claude） */
const PRODUCTION_WRITER_ROUTES = new Set([
  "v2_rawstage2_gemini31",
  "v2_amplified_gemini31",
  "v2_rawstage2",
  "v2_amplified",
  "narrator_primary",
]);

/** 评测 / NovelBench / 文学裁判 */
const EVALUATION_ROUTE_PREFIXES = [
  "nb4_",
  "nb5_",
  "reference_analyzer",
  "v2_literary_judge",
  "v2_opportunity_judge",
  "v2_editorial_planner",
  "v2_reader_experience_judge",
  "novel_quality_judge",
  "paradigm_judge",
  "chinese_editor_judge",
];

/** 校准 */
const CALIBRATION_ROUTES = new Set([
  "v2_chinese_calibration",
  "chinese_naturalizer",
  "chinese_naturalizer_glm",
  "chinese_naturalizer_gpt",
  "chinese_naturalizer_deepseek",
  "chinese_naturalizer_qwen",
  "chinese_naturalizer_ernie",
]);

/** 开发 / 测试 */
const DEVELOPMENT_ROUTE_MARKERS = [
  "_testing",
  "narrator_testing",
  "style_shaper_testing",
  "modelTestRoute",
];

function fallbackPolicyOf(entry: AgentRoutingEntry | string | undefined): RouteFallbackPolicy {
  if (!entry || typeof entry === "string") return "provider_inherit";
  if (!("fallback" in entry) || entry.fallback === undefined) return "provider_inherit";
  if (Array.isArray(entry.fallback) && entry.fallback.length === 0) return "none";
  return "explicit_chain";
}

function matchPrefix(route: string, prefixes: string[]): boolean {
  return prefixes.some((p) => route === p || route.startsWith(p));
}

/**
 * 对单条 route 做确定性分类（不依赖外部服务）。
 */
export function classifyRoute(route: string, entry?: AgentRoutingEntry | string): RouteMetadata {
  const resolved = entry;
  const provider = typeof resolved === "string" ? resolved : resolved?.provider;
  const model = typeof resolved === "string" ? undefined : resolved?.model;
  const labTesting =
    typeof resolved === "object" && resolved !== null
      ? Boolean((resolved as { lab_testing?: boolean }).lab_testing)
      : false;
  const note =
    typeof resolved === "object" && resolved !== null
      ? (resolved as { note?: string }).note
      : undefined;

  if (PRODUCTION_WRITER_ROUTES.has(route)) {
    return {
      route,
      routeClass: "production",
      productionEligible: true,
      allowedCallers: [...PRODUCTION_CHAPTER_CALLERS],
      fallbackPolicy: fallbackPolicyOf(resolved),
      provider,
      model,
      modelVersion: model,
      labTesting: false,
      note,
    };
  }

  if (CALIBRATION_ROUTES.has(route) || route.includes("calibration")) {
    return {
      route,
      routeClass: "calibration",
      productionEligible: false,
      allowedCallers: ["calibration_runner", "novelbench", "eval"],
      fallbackPolicy: fallbackPolicyOf(resolved),
      provider,
      model,
      modelVersion: model,
      labTesting: labTesting || true,
      note,
    };
  }

  if (matchPrefix(route, EVALUATION_ROUTE_PREFIXES) || labTesting) {
    const isJudge = route.includes("judge");
    return {
      route,
      routeClass: "evaluation",
      productionEligible: false,
      allowedCallers: isJudge
        ? ["novelbench", "eval", "pairwise_judge", "reference_aware_judge"]
        : ["novelbench", "eval", "generation_matrix"],
      fallbackPolicy: fallbackPolicyOf(resolved),
      provider,
      model,
      modelVersion: model,
      labTesting: true,
      note,
    };
  }

  if (DEVELOPMENT_ROUTE_MARKERS.some((m) => route.includes(m))) {
    return {
      route,
      routeClass: "development",
      productionEligible: false,
      allowedCallers: ["modelTestRoute", "dev_script", "ab_matrix"],
      fallbackPolicy: fallbackPolicyOf(resolved),
      provider,
      model,
      modelVersion: model,
      labTesting: true,
      note,
    };
  }

  // 其余历史结构化节点：默认不作为生产正文路由，但可被内部 stage 使用
  return {
    route,
    routeClass: "production",
    productionEligible: false,
    allowedCallers: ["internal_stage", "legacy_compat"],
    fallbackPolicy: fallbackPolicyOf(resolved),
    provider,
    model,
    modelVersion: model,
    labTesting: false,
    note,
  };
}

export function listRouteCatalog(): RouteMetadata[] {
  const config = loadModelRoutingSync();
  return Object.keys(config.agent_routing).map((route) =>
    classifyRoute(route, config.agent_routing[route]),
  );
}

export interface RouteCatalogValidationIssue {
  level: "error" | "warning";
  route: string;
  message: string;
}

/**
 * 配置层校验：生产写路由必须 fallback=[]；评测路由 productionEligible=false。
 */
export function validateRouteCatalog(catalog?: RouteMetadata[]): RouteCatalogValidationIssue[] {
  const items = catalog ?? listRouteCatalog();
  const issues: RouteCatalogValidationIssue[] = [];

  for (const item of items) {
    if (PRODUCTION_WRITER_ROUTES.has(item.route)) {
      if (item.fallbackPolicy !== "none") {
        issues.push({
          level: "error",
          route: item.route,
          message: "生产写路由必须 fallbackPolicy=none（fallback=[]）",
        });
      }
      if (!item.productionEligible) {
        issues.push({
          level: "error",
          route: item.route,
          message: "生产写路由必须 productionEligible=true",
        });
      }
      if (!item.provider || !item.model) {
        issues.push({
          level: "error",
          route: item.route,
          message: "生产写路由必须声明 provider/model",
        });
      }
    }

    if (item.routeClass === "evaluation" && item.productionEligible) {
      issues.push({
        level: "error",
        route: item.route,
        message: "评测路由不得 productionEligible=true",
      });
    }

    // GPT 文学裁判不得进入生产 eligible
    if (
      (item.route === "v2_literary_judge" || item.route === "v2_opportunity_judge") &&
      item.productionEligible
    ) {
      issues.push({
        level: "error",
        route: item.route,
        message: "文学评测 judge 不得 productionEligible",
      });
    }

    // GLM/Doubao 默认不得生产 eligible（除显式校准且仍 false）
    if (
      item.productionEligible &&
      (item.provider === "glm" || item.provider === "doubao")
    ) {
      issues.push({
        level: "error",
        route: item.route,
        message: "GLM/Doubao 不得进入默认生产 eligible 路由",
      });
    }
  }

  return issues;
}

export interface CallerAssertionResult {
  ok: boolean;
  reason?: string;
}

/**
 * 运行时调用方校验。
 */
export function assertCallerAllowed(
  route: string,
  caller: string,
  catalogEntry?: RouteMetadata,
): CallerAssertionResult {
  const meta = catalogEntry ?? classifyRoute(route);
  if (!meta.allowedCallers.includes(caller) && !meta.allowedCallers.includes("*")) {
    // 生产章节调用方调用 productionEligible 写路由是允许的
    if (
      meta.productionEligible &&
      (PRODUCTION_CHAPTER_CALLERS as readonly string[]).includes(caller)
    ) {
      return { ok: true };
    }
    return {
      ok: false,
      reason: `caller ${caller} not allowed for route ${route} (class=${meta.routeClass})`,
    };
  }
  return { ok: true };
}

/**
 * 生产路径禁止评测模型：若 routeClass=evaluation 且 caller 属于生产章节入口 → 阻断。
 */
export function assertProductionCallerIsolation(
  route: string,
  caller: string,
): CallerAssertionResult {
  const meta = classifyRoute(route);
  const isProductionCaller = (PRODUCTION_CHAPTER_CALLERS as readonly string[]).includes(caller);
  if (isProductionCaller && !meta.productionEligible && meta.routeClass !== "production") {
    // 允许 production class 但 non-eligible 的内部结构化节点；禁止 evaluation/development/calibration
    if (meta.routeClass === "evaluation" || meta.routeClass === "development" || meta.routeClass === "calibration") {
      return {
        ok: false,
        reason: `production caller cannot use ${meta.routeClass} route ${route}`,
      };
    }
  }
  return { ok: true };
}

/** 模型版本隔离键：provider + modelVersion，禁止跨版本混统计 */
export function modelVersionIsolationKey(provider: string, modelVersion: string): string {
  return `${provider}::${modelVersion}`;
}

export function isSameModelVersionBucket(
  a: { provider: string; modelVersion: string },
  b: { provider: string; modelVersion: string },
): boolean {
  return modelVersionIsolationKey(a.provider, a.modelVersion) ===
    modelVersionIsolationKey(b.provider, b.modelVersion);
}
