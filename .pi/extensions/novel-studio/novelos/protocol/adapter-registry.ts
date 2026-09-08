/**
 * NovelOS 协议适配器注册表（Phase 3）
 *
 * 管理已注册的协议适配器，按 route 配置选择 adapter。
 *
 * 验收标准：
 * - 编排器可通过 route 配置选择 adapter
 * - 默认生产仍使用唯一 ReAct Adapter
 * - Native Adapter 未启用时不会影响生产
 * - 非法调用不能绕过系统安全检查
 *
 * PROTOCOL-LAYER-2（2026-08-12）：生产 route 隔离增强。
 * - validateProductionIsolation 现在使用 lookupStrict 验证 capability
 * - 生产 route 必须命中完整 endpoint 级声明，未命中时 fail-closed
 * - 不再依赖 provider 级回退，避免 endpoint 更换后错误复用 capability
 */

import type { ModelProtocolAdapter } from "./protocol-adapter.js";
import type { ProtocolKind } from "./model-turn.js";
import type { CapabilityKey } from "./capability-registry.js";
import { defaultCapabilityRegistry } from "./capability-registry.js";
import { createReactTextAdapter } from "./adapters/react-text-adapter.js";

// ============================================================================
// 类型
// ============================================================================

/**
 * Route 到 adapter 的映射配置。
 */
export interface RouteAdapterConfig {
  /** route 名（如 "gemini_writer_v2" / "v2_rawstage2"） */
  route: string;
  /** 协议类型 */
  protocol: ProtocolKind;
  /** 适配器版本 */
  adapterVersion: string;
  /** 对应的 CapabilityKey（用于查询 endpoint 级能力） */
  capabilityKey: CapabilityKey;
}

// ============================================================================
// AdapterRegistry
// ============================================================================

/**
 * 协议适配器注册表。
 *
 * 管理已注册的适配器实例和 route 映射。
 * 生产默认注册 ReactTextAdapter，eval 环境额外注册 NativeFunctionCallingAdapter。
 */
export class AdapterRegistry {
  /** 已注册的适配器实例（key = "protocol:version"） */
  private readonly adapters = new Map<string, ModelProtocolAdapter>();
  /** route → adapter 配置 */
  private readonly routeConfigs = new Map<string, RouteAdapterConfig>();
  /** 生产默认 route 列表（只允许 ReAct） */
  private readonly productionRoutes = new Set<string>();

  /**
   * 注册适配器实例。
   */
  registerAdapter(adapter: ModelProtocolAdapter): void {
    const key = `${adapter.protocol}:${adapter.version}`;
    this.adapters.set(key, adapter);
  }

  /**
   * 注册 route → adapter 映射。
   * @param config 路由配置
   * @param isProduction 是否为生产路由（true = 只允许 ReAct）
   */
  registerRoute(config: RouteAdapterConfig, isProduction = false): void {
    this.routeConfigs.set(config.route, config);
    if (isProduction) {
      this.productionRoutes.add(config.route);
    }
  }

  /**
   * 按 route 获取适配器。
   * 未配置的 route 回退到 ReAct 默认适配器。
   */
  getAdapter(route: string): ModelProtocolAdapter {
    const config = this.routeConfigs.get(route);
    if (config) {
      const adapterKey = `${config.protocol}:${config.adapterVersion}`;
      const adapter = this.adapters.get(adapterKey);
      if (adapter) {
        return adapter;
      }
    }
    // 回退到 ReAct 默认
    return this.getOrCreateReactAdapter();
  }

  /**
   * 按 route 获取适配器配置。
   */
  getRouteConfig(route: string): RouteAdapterConfig | undefined {
    return this.routeConfigs.get(route);
  }

  /**
   * 列出所有已注册的 route。
   */
  listRoutes(): RouteAdapterConfig[] {
    return [...this.routeConfigs.values()];
  }

  /**
   * 列出所有生产 route。
   */
  listProductionRoutes(): RouteAdapterConfig[] {
    return this.listRoutes().filter((r) => this.productionRoutes.has(r.route));
  }

  /**
   * 验证：生产 route 不包含 Native Adapter，且所有生产 route 的 capability
   * 必须命中完整 endpoint 级声明（不依赖 provider 级回退）。
   * 返回违规项列表（空 = 通过）。
   *
   * PROTOCOL-LAYER-2：使用 lookupStrict 验证，确保生产 route 的 capability
   * 不依赖 provider 级回退。未命中 endpoint 级声明的生产 route 视为违规。
   */
  validateProductionIsolation(): string[] {
    const failures: string[] = [];
    for (const route of this.productionRoutes) {
      const config = this.routeConfigs.get(route);
      if (!config) {
        failures.push(`生产 route "${route}" 未注册配置`);
        continue;
      }
      // 检查 1：生产 route 必须使用 ReAct 协议
      if (config.protocol !== "react-text") {
        failures.push(
          `生产 route "${route}" 使用了非 ReAct 协议：${config.protocol}`,
        );
      }
      // 检查 2：生产 route 的 capabilityKey 必须命中 endpoint 级声明（lookupStrict）
      if (!defaultCapabilityRegistry.hasEndpointEntry(config.capabilityKey)) {
        failures.push(
          `生产 route "${route}" 的 capabilityKey 未命中 endpoint 级声明（provider=${config.capabilityKey.provider}, endpoint=${config.capabilityKey.endpoint}, model=${config.capabilityKey.model}）；生产 route 不允许依赖 provider 级回退`,
        );
      }
    }
    return failures;
  }

  // ========================================================================
  // 内部
  // ========================================================================

  private reactAdapter?: ModelProtocolAdapter;

  private getOrCreateReactAdapter(): ModelProtocolAdapter {
    if (!this.reactAdapter) {
      this.reactAdapter = createReactTextAdapter();
    }
    return this.reactAdapter;
  }
}

// ============================================================================
// 默认 Registry 实例
// ============================================================================

/**
 * 全局默认 AdapterRegistry 实例。
 */
export const defaultAdapterRegistry = new AdapterRegistry();

// 注册 ReAct 适配器
defaultAdapterRegistry.registerAdapter(createReactTextAdapter());

// 注册生产默认 route（全部使用 ReAct）
// GPT6-ASTRA-PRODUCTION-SWITCH-1：生产 writer family 切换为 gpt-6-astra
// （shunfen6.win OpenAI 兼容端点，单一渠道，无互备）。Claude 仍为显式
// writerModel=claude 备选；旧 Gemini 生产写路由已按版本收敛原则删除。
const PRODUCTION_ROUTES = [
  "gpt_writer_v1",
  "v2_rawstage2_gpt6astra",
  "v2_amplified_gpt6astra",
  "v2_rawstage2",
  "v2_amplified",
  "narrator_primary",
  "stage2_narrator",
];

function productionCapabilityKeyForRoute(route: string): CapabilityKey {
  if (route !== "v2_rawstage2" && route !== "v2_amplified") {
    return {
      provider: "gpt",
      endpoint: "openai-compat",
      model: "gpt-6-astra",
      protocol: "react-text",
      adapterVersion: "react-text-v1",
    };
  }
  return {
    provider: "claude",
    endpoint: "anthropic-native",
    model: "claude-opus-4-6",
    protocol: "react-text",
    adapterVersion: "react-text-v1",
  };
}

for (const route of PRODUCTION_ROUTES) {
  defaultAdapterRegistry.registerRoute(
    {
      route,
      protocol: "react-text",
      adapterVersion: "react-text-v1",
      capabilityKey: productionCapabilityKeyForRoute(route),
    },
    true, // isProduction = true
  );
}
