/**
 * NovelOS Native FC Eval Entry（Phase 4 — Eval-only）
 *
 * 仅在 eval 环境导入此模块，注册 NativeFunctionCallingAdapter 和 eval-only route。
 * 生产构建（tsconfig.prod.json）不包含此文件。
 *
 * 使用方式：
 * ```ts
 * import "novelos/protocol/native-fc-eval-entry.js";
 * // 现在默认 registry 中已注册 Native FC adapter 和 eval route
 * ```
 *
 * 安全约束：
 * - 生产默认路由不得启用该 adapter
 * - Native 失败后禁止静默降级为 raw 正文
 */

import { createNativeFunctionCallingAdapter } from "./adapters/native-fc-adapter.js";
import { defaultAdapterRegistry } from "./adapter-registry.js";
import { defaultCapabilityRegistry } from "./capability-registry.js";
import type { RouteAdapterConfig } from "./adapter-registry.js";

// ============================================================================
// 注册 Native FC Adapter
// ============================================================================

const nativeAdapter = createNativeFunctionCallingAdapter();
defaultAdapterRegistry.registerAdapter(nativeAdapter);

// ============================================================================
// 注册 Eval-only Native FC Route
// ============================================================================

/**
 * Eval-only Native FC route 配置。
 * 使用与 ReAct 完全一致的模型和 endpoint，仅切换协议。
 * isProduction = false，确保生产隔离检查通过。
 */
const EVAL_NATIVE_ROUTES: RouteAdapterConfig[] = [
  {
    route: "eval_native_fc_gemini31",
    protocol: "native-function-calling",
    adapterVersion: "native-fc-v1",
    capabilityKey: {
      provider: "gemini",
      endpoint: "google-ai-native",
      model: "gemini-3.1-pro",
      protocol: "native-function-calling",
      adapterVersion: "native-fc-v1",
    },
  },
  {
    route: "eval_native_fc_claude",
    protocol: "native-function-calling",
    adapterVersion: "native-fc-v1",
    capabilityKey: {
      provider: "claude",
      endpoint: "anthropic-native",
      model: "claude-opus-4-6",
      protocol: "native-function-calling",
      adapterVersion: "native-fc-v1",
    },
  },
];

for (const config of EVAL_NATIVE_ROUTES) {
  defaultAdapterRegistry.registerRoute(config, false); // isProduction = false
}

// ============================================================================
// 导出 eval-only 工具函数
// ============================================================================

/**
 * 检查 Native FC adapter 是否已注册。
 */
export function isNativeFcRegistered(): boolean {
  const adapter = defaultAdapterRegistry.getAdapter("eval_native_fc_gemini31");
  return adapter.protocol === "native-function-calling";
}

/**
 * 列出所有 eval-only Native FC route。
 */
export function listEvalNativeFcRoutes(): string[] {
  return EVAL_NATIVE_ROUTES.map((r) => r.route);
}

/**
 * 验证 Native FC 的 endpoint 级能力声明。
 * 返回缺失能力列表（空 = 全部通过）。
 */
export function validateNativeFcCapabilities(): string[] {
  const failures: string[] = [];
  for (const config of EVAL_NATIVE_ROUTES) {
    const cap = defaultCapabilityRegistry.lookup(config.capabilityKey);
    if (!cap.nativeFunctionCalling) {
      failures.push(
        `route "${config.route}" 的 endpoint ${config.capabilityKey.endpoint} 未声明 nativeFunctionCalling=true`,
      );
    }
    if (!cap.structuredToolCallParser) {
      failures.push(
        `route "${config.route}" 的 endpoint ${config.capabilityKey.endpoint} 未声明 structuredToolCallParser=true`,
      );
    }
  }
  return failures;
}

export { createNativeFunctionCallingAdapter } from "./adapters/native-fc-adapter.js";
