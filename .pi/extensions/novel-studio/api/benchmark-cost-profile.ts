/**
 * NB-4.0 测试成本配置（BenchmarkCostProfile）— 路由隔离守卫
 *
 * 目标：在 NovelBench 评测期间强制隔离 provider，防止套餐模型测试意外调用
 * 按量计费的生产模型（GPT/Claude/ERNIE），或生产验证测试意外调用套餐模型。
 *
 * 两个 profile：
 * - package_screening：只允许 GLM / Doubao，禁止 fallback，禁止 GPT/Claude/ERNIE
 * - production_validation：只允许 GPT / Claude，使用生产级路由
 *
 * 激活方式：env PINOVEL_BENCHMARK_COST_PROFILE=package_screening|production_validation
 * 未设置 env 时不强制（向后兼容，生产 novel_generate_chapter 默认路由不受影响）。
 *
 * 违规时立即 hard block（throw），不静默降级。
 *
 * trace 标准：所有 LLM 调用 trace 必须记录 requestedRoute / actualProvider / actualModel。
 * 本模块不直接写 trace，但通过 assertProviderAuthorized 在调用前拦截未授权 provider。
 */

// ─────────────────────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────────────────────

export type BenchmarkCostProfile = "package_screening" | "production_validation";

// ─────────────────────────────────────────────────────────────────────────────
// Provider 授权表
// ─────────────────────────────────────────────────────────────────────────────

/** package_screening 允许的 provider（套餐模型，低成本） */
const PACKAGE_SCREENING_ALLOWED: ReadonlySet<string> = new Set(["glm", "doubao"]);

/** production_validation 允许的 provider（生产模型，按量计费） */
const PRODUCTION_VALIDATION_ALLOWED: ReadonlySet<string> = new Set(["gpt", "claude"]);

// ─────────────────────────────────────────────────────────────────────────────
// 公开 API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 从 env 读取当前 benchmark cost profile。
 * 未设置或非法值返回 null（不强制）。
 */
export function getBenchmarkCostProfile(): BenchmarkCostProfile | null {
  const raw = process.env.PINOVEL_BENCHMARK_COST_PROFILE;
  if (raw === "package_screening" || raw === "production_validation") {
    return raw;
  }
  return null;
}

/**
 * 返回指定 profile 下授权的 provider 集合（小写）。
 */
export function getAuthorizedProviders(profile: BenchmarkCostProfile): ReadonlySet<string> {
  return profile === "package_screening"
    ? PACKAGE_SCREENING_ALLOWED
    : PRODUCTION_VALIDATION_ALLOWED;
}

/**
 * 判断 provider 是否在指定 profile 下授权。
 */
export function isProviderAuthorized(
  provider: string,
  profile: BenchmarkCostProfile,
): boolean {
  return getAuthorizedProviders(profile).has(provider.toLowerCase());
}

/**
 * 在 LLM 调用前断言 provider 被授权。
 *
 * - 未设置 profile → 直接返回（不强制，向后兼容）
 * - provider 未授权 → throw Error（hard block）
 *
 * 调用点：createRoutedChatAPI / APIFallbackManager.callWithFallback
 */
export function assertProviderAuthorized(provider: string, agentName: string): void {
  const profile = getBenchmarkCostProfile();
  if (profile === null) {
    return; // 未激活 cost profile，不强制
  }
  if (!isProviderAuthorized(provider, profile)) {
    const allowed = [...getAuthorizedProviders(profile)].join(", ");
    throw new BenchmarkCostProfileViolation(
      provider,
      agentName,
      profile,
      `HARD BLOCK: provider "${provider}" not authorized for benchmarkCostProfile="${profile}"` +
        ` (agent=${agentName}). Authorized providers: [${allowed}].` +
        ` Unset PINOVEL_BENCHMARK_COST_PROFILE to disable enforcement.`,
    );
  }
}

/**
 * 判断当前是否应禁用 fallback。
 *
 * package_screening 模式下强制禁用 fallback（只允许 GLM/Doubao，失败即失败）。
 * production_validation 模式下不禁用 fallback（生产级路由有自己的 fallback 策略）。
 * 未设置 profile 时返回 false（向后兼容）。
 */
export function shouldDisableFallbackForProfile(): boolean {
  const profile = getBenchmarkCostProfile();
  if (profile === null) return false;
  return profile === "package_screening";
}

/**
 * 过滤 fallback chain，只保留当前 profile 授权的 provider。
 * 未设置 profile 时返回原 chain（向后兼容）。
 */
export function filterFallbackChainByProfile(
  chain: readonly string[],
  agentName: string,
): string[] {
  const profile = getBenchmarkCostProfile();
  if (profile === null) {
    return [...chain];
  }
  const authorized = getAuthorizedProviders(profile);
  const filtered = chain.filter((p) => authorized.has(p.toLowerCase()));
  if (filtered.length === 0 && chain.length > 0) {
    throw new BenchmarkCostProfileViolation(
      chain[0],
      agentName,
      profile,
      `HARD BLOCK: fallback chain [${chain.join(", ")}] contains no provider` +
        ` authorized for benchmarkCostProfile="${profile}" (agent=${agentName}).` +
        ` Authorized: [${[...authorized].join(", ")}].`,
    );
  }
  return filtered;
}

// ─────────────────────────────────────────────────────────────────────────────
// 错误类型
// ─────────────────────────────────────────────────────────────────────────────

/**
 * BenchmarkCostProfile 违规错误。
 * 测试可捕获此类型验证 hard block 行为。
 */
export class BenchmarkCostProfileViolation extends Error {
  readonly provider: string;
  readonly agentName: string;
  readonly profile: BenchmarkCostProfile;

  constructor(
    provider: string,
    agentName: string,
    profile: BenchmarkCostProfile,
    message: string,
  ) {
    super(message);
    this.name = "BenchmarkCostProfileViolation";
    this.provider = provider;
    this.agentName = agentName;
    this.profile = profile;
  }
}
