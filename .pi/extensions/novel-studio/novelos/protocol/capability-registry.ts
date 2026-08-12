/**
 * NovelOS Capability Registry（Phase 1）
 *
 * 将 capability key 从 provider 级收敛到 endpoint/route 级。
 * 旧版 ProviderCapability 按 provider 声明能力（如 "gemini" 支持 nativeSystemInstruction），
 * 无法准确反映同一 provider 不同 endpoint/model 的能力差异。
 *
 * 新版 CapabilityKey 粒度：
 *   provider + endpoint + model + protocol + adapterVersion
 *
 * 设计原则：
 * - fail-closed：未声明的能力一律 false
 * - endpoint 隔离：同一 provider 的 OpenAI-compatible endpoint 和原生 endpoint 独立声明
 * - route 能明确选择协议与 adapter
 * - registry 中不存在无法定位 endpoint 的生产能力声明
 *
 * PROTOCOL-LAYER-2（2026-08-12）：provider 级生产回退已限制。
 * - lookupStrict(key)：生产路径专用，只查 endpoint 级，未命中 fail-closed 全 false。
 *   生产 route 必须命中完整 endpoint 条目；未命中 endpoint 时 fail-closed。
 * - lookup(key)：保留为历史兼容查询，可回退到 provider 级默认。
 *   仅用于 eval/历史诊断，不参与生产路由决策。
 * - registerProviderDefault：保留为明确标记的历史兼容查询，不能参与生产路由决策。
 */

import type { ProtocolKind } from "./model-turn.js";

// ============================================================================
// 类型
// ============================================================================

/**
 * Capability Key：精确到 endpoint/model/protocol/adapterVersion 粒度。
 */
export interface CapabilityKey {
  /** provider 名（如 "gemini" / "claude" / "gpt"） */
  provider: string;
  /** endpoint 标识（如 "google-ai-native" / "openai-compat" / "anthropic-native"） */
  endpoint: string;
  /** model 名（如 "gemini-3.1-pro-preview" / "claude-opus-4-6"） */
  model: string;
  /** 协议类型 */
  protocol: ProtocolKind;
  /** 适配器版本（如 "react-text-v1" / "native-fc-v1"） */
  adapterVersion: string;
}

/**
 * Endpoint 级能力声明。
 * 继承旧版 ProviderCapability 的字段，但绑定到具体 endpoint/model/protocol。
 */
export interface EndpointCapability {
  /** 原生 system instruction 支持 */
  nativeSystemInstruction: boolean;
  /** 原生 Function Calling（非 text-only ReAct 解析） */
  nativeFunctionCalling: boolean;
  /** 结构化输出约束（response_schema） */
  responseSchema: boolean;
  /** 思考配置（thinking_config） */
  thinkingConfig: boolean;
  /** 推理努力参数（reasoning_effort） */
  reasoningEffort: boolean;
  /** 推理 token 控制 */
  reasoningTokenControl: boolean;
  /** tool-call parser 的结构化返回保证 */
  structuredToolCallParser: boolean;
  /** 并行工具调用支持 */
  parallelToolCalls: boolean;
  /** 工具结果续传支持（tool result continuation） */
  toolResultContinuation: boolean;
  /** 流式工具调用支持 */
  streamingToolCalls: boolean;
  /** usage 统计支持 */
  usageMetrics: boolean;
  /** finish reason 支持 */
  finishReason: boolean;
}

/**
 * Registry 条目：CapabilityKey + 能力声明 + 元数据。
 */
export interface CapabilityEntry {
  key: CapabilityKey;
  capability: EndpointCapability;
  /** 声明来源（如 "manual-verified" / "probe-detected" / "inherited-provider"） */
  source: string;
  /** 声明时间戳 */
  declaredAt: string;
  /** 备注 */
  notes?: string;
}

// ============================================================================
// fail-closed 工厂
// ============================================================================

/**
 * fail-closed 创建能力声明：只把显式声明为 true 的能力置 true，其余一律 false。
 */
export function createEndpointCapability(
  declared?: Partial<EndpointCapability>,
): EndpointCapability {
  return {
    nativeSystemInstruction: declared?.nativeSystemInstruction === true,
    nativeFunctionCalling: declared?.nativeFunctionCalling === true,
    responseSchema: declared?.responseSchema === true,
    thinkingConfig: declared?.thinkingConfig === true,
    reasoningEffort: declared?.reasoningEffort === true,
    reasoningTokenControl: declared?.reasoningTokenControl === true,
    structuredToolCallParser: declared?.structuredToolCallParser === true,
    parallelToolCalls: declared?.parallelToolCalls === true,
    toolResultContinuation: declared?.toolResultContinuation === true,
    streamingToolCalls: declared?.streamingToolCalls === true,
    usageMetrics: declared?.usageMetrics === true,
    finishReason: declared?.finishReason === true,
  };
}

/**
 * 全 false 的能力声明（未验证 endpoint 的默认值）。
 */
export function emptyEndpointCapability(): EndpointCapability {
  return createEndpointCapability();
}

// ============================================================================
// Capability Registry
// ============================================================================

/**
 * Capability Registry：管理 endpoint/route 级能力声明。
 *
 * 验收标准：
 * - Gemini OpenAI-compatible endpoint 与 Gemini 原生 endpoint 能独立声明
 * - 更换 endpoint 后不会复用错误 capability
 * - route 能明确选择协议与 adapter
 * - registry 中不存在无法定位 endpoint 的生产能力声明
 */
export class CapabilityRegistry {
  private readonly entries = new Map<string, CapabilityEntry>();
  /** provider → 默认能力（向后兼容旧 provider 级声明） */
  private readonly providerDefaults = new Map<string, EndpointCapability>();

  /**
   * 注册一条 endpoint 级能力声明。
   * 若 key 已存在则覆盖。
   */
  register(entry: CapabilityEntry): void {
    const keyStr = this.keyToString(entry.key);
    this.entries.set(keyStr, entry);
  }

  /**
   * 批量注册。
   */
  registerAll(entries: CapabilityEntry[]): void {
    for (const entry of entries) {
      this.register(entry);
    }
  }

  /**
   * 注册 provider 级默认能力（历史兼容）。
   *
   * PROTOCOL-LAYER-2：provider 级默认仅用于历史兼容查询（通过 lookup 方法），
   * 不能参与生产路由决策。生产路径必须使用 lookupStrict，未命中 endpoint 级时 fail-closed。
   */
  registerProviderDefault(provider: string, capability: EndpointCapability): void {
    this.providerDefaults.set(provider, capability);
  }

  /**
   * 查询能力声明（历史兼容，可回退到 provider 级）。
   *
   * 优先查 endpoint 级，回退到 provider 级，最终 fail-closed 全 false。
   *
   * 注意：此方法仅用于 eval/历史诊断，不参与生产路由决策。
   * 生产路径必须使用 lookupStrict，确保 endpoint 隔离。
   */
  lookup(key: CapabilityKey): EndpointCapability {
    const keyStr = this.keyToString(key);
    const entry = this.entries.get(keyStr);
    if (entry) {
      return entry.capability;
    }
    // 回退到 provider 级（历史兼容，仅 eval/诊断用）
    const providerDefault = this.providerDefaults.get(key.provider);
    if (providerDefault) {
      return providerDefault;
    }
    // fail-closed
    return emptyEndpointCapability();
  }

  /**
   * 严格查询能力声明（生产路径专用，不回退到 provider 级）。
   *
   * PROTOCOL-LAYER-2（2026-08-12）：生产 route 必须命中完整 endpoint 条目；
   * 未命中 endpoint 时 fail-closed 返回全 false，不继承 provider 默认能力。
   *
   * 这避免了"endpoint 更换后错误复用 provider 级 capability"的风险，
   * 例如错误继承 nativeSystemInstruction 等能力。
   *
   * @param key 精确到 endpoint/model/protocol/adapterVersion 的 capability key
   * @returns endpoint 级能力声明；未命中时返回 emptyEndpointCapability()
   */
  lookupStrict(key: CapabilityKey): EndpointCapability {
    const keyStr = this.keyToString(key);
    const entry = this.entries.get(keyStr);
    if (entry) {
      return entry.capability;
    }
    // 不回退到 provider 级，直接 fail-closed
    return emptyEndpointCapability();
  }

  /**
   * 检查指定 key 是否已注册 endpoint 级声明。
   * 用于生产路由决策时验证 capability 是否完整登记。
   */
  hasEndpointEntry(key: CapabilityKey): boolean {
    return this.entries.has(this.keyToString(key));
  }

  /**
   * 查询完整条目（含 source/declaredAt 等元数据）。
   */
  lookupEntry(key: CapabilityKey): CapabilityEntry | undefined {
    return this.entries.get(this.keyToString(key));
  }

  /**
   * 列出所有已注册的条目。
   */
  listAll(): CapabilityEntry[] {
    return [...this.entries.values()];
  }

  /**
   * 列出指定 provider 的所有条目。
   */
  listByProvider(provider: string): CapabilityEntry[] {
    return this.listAll().filter((e) => e.key.provider === provider);
  }

  /**
   * 列出指定 provider + endpoint 的所有条目。
   */
  listByEndpoint(provider: string, endpoint: string): CapabilityEntry[] {
    return this.listAll().filter(
      (e) => e.key.provider === provider && e.key.endpoint === endpoint,
    );
  }

  /**
   * 验证：registry 中不存在无法定位 endpoint 的生产能力声明。
   * 返回不一致项列表（空 = 通过）。
   */
  validate(): string[] {
    const failures: string[] = [];
    for (const entry of this.entries.values()) {
      if (!entry.key.endpoint) {
        failures.push(
          `条目 provider=${entry.key.provider} model=${entry.key.model} 缺少 endpoint`,
        );
      }
      if (!entry.key.model) {
        failures.push(
          `条目 provider=${entry.key.provider} endpoint=${entry.key.endpoint} 缺少 model`,
        );
      }
    }
    return failures;
  }

  /**
   * 序列化 key 为字符串（用于 Map 键）。
   */
  private keyToString(key: CapabilityKey): string {
    return [key.provider, key.endpoint, key.model, key.protocol, key.adapterVersion].join("\u0000");
  }
}

// ============================================================================
// 默认 Registry 实例与预设声明
// ============================================================================

/**
 * 全局默认 Registry 实例。
 * 生产代码和 eval 代码共享同一实例。
 */
export const defaultCapabilityRegistry = new CapabilityRegistry();

/**
 * 初始化默认 capability 声明。
 *
 * 当前生产链路为 text-only ReAct，所有 provider 的 nativeFunctionCalling 均为 false。
 * Native Function Calling 仅在 eval-only 环境显式声明为 true。
 */
export function initializeDefaultCapabilities(): void {
  // ---- Provider 级默认（向后兼容）----
  // 所有 provider 当前只声明 nativeSystemInstruction=true（已验证）。
  // nativeFunctionCalling 一律 false（生产使用 ReAct 文本协议）。
  for (const provider of ["gemini", "claude", "gpt", "doubao", "glm", "ernie", "qwen"]) {
    defaultCapabilityRegistry.registerProviderDefault(
      provider,
      createEndpointCapability({ nativeSystemInstruction: true }),
    );
  }

  // ---- Endpoint 级声明：ReAct（生产默认）----
  // Gemini OpenAI-compatible endpoint（当前生产路径）
  defaultCapabilityRegistry.register({
    key: {
      provider: "gemini",
      endpoint: "openai-compat",
      model: "gemini-3.1-pro-preview",
      protocol: "react-text",
      adapterVersion: "react-text-v1",
    },
    capability: createEndpointCapability({
      nativeSystemInstruction: true,
      usageMetrics: true,
      finishReason: true,
    }),
    source: "manual-verified",
    declaredAt: "2026-08-12",
    notes: "生产默认 ReAct 路径：gemini_writer_v2 → openai-compat endpoint",
  });

  // Claude endpoint（显式 writerModel=claude 路径）
  defaultCapabilityRegistry.register({
    key: {
      provider: "claude",
      endpoint: "anthropic-native",
      model: "claude-opus-4-6",
      protocol: "react-text",
      adapterVersion: "react-text-v1",
    },
    capability: createEndpointCapability({
      nativeSystemInstruction: true,
      usageMetrics: true,
      finishReason: true,
    }),
    source: "manual-verified",
    declaredAt: "2026-08-12",
    notes: "显式 writerModel=claude 路径：v2_rawstage2 / v2_amplified",
  });

  // ---- Endpoint 级声明：Native Function Calling（eval-only）----
  // Gemini 原生 endpoint（eval-only，不进生产）
  defaultCapabilityRegistry.register({
    key: {
      provider: "gemini",
      endpoint: "google-ai-native",
      model: "gemini-3.1-pro-preview",
      protocol: "native-function-calling",
      adapterVersion: "native-fc-v1",
    },
    capability: createEndpointCapability({
      nativeSystemInstruction: true,
      nativeFunctionCalling: true,
      responseSchema: true,
      structuredToolCallParser: true,
      parallelToolCalls: true,
      toolResultContinuation: true,
      usageMetrics: true,
      finishReason: true,
    }),
    source: "manual-verified",
    declaredAt: "2026-08-12",
    notes: "Eval-only：Gemini 原生 Function Calling endpoint，不进生产默认路由",
  });

  // Claude 原生 endpoint（eval-only，不进生产）
  defaultCapabilityRegistry.register({
    key: {
      provider: "claude",
      endpoint: "anthropic-native",
      model: "claude-opus-4-6",
      protocol: "native-function-calling",
      adapterVersion: "native-fc-v1",
    },
    capability: createEndpointCapability({
      nativeSystemInstruction: true,
      nativeFunctionCalling: true,
      structuredToolCallParser: true,
      parallelToolCalls: true,
      toolResultContinuation: true,
      usageMetrics: true,
      finishReason: true,
    }),
    source: "manual-verified",
    declaredAt: "2026-08-12",
    notes: "Eval-only：Claude 原生 Function Calling endpoint，不进生产默认路由",
  });
}

// 自动初始化
initializeDefaultCapabilities();
