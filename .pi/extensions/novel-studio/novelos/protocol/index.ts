/**
 * NovelOS Protocol Layer — 公共出口（barrel）
 *
 * 生产代码从此 barrel 导入协议层模块。
 * NativeFunctionCallingAdapter 是 eval-only，不在此 barrel 中导出。
 */

// Phase 2: 统一 ModelTurn 事件模型
export * from "./model-turn.js";

// Phase 1: Capability Registry
export * from "./capability-registry.js";

// Phase 3: 协议适配器接口
export * from "./protocol-adapter.js";

// Phase 3: 适配器注册表
export * from "./adapter-registry.js";

// Phase 3: ReAct Text Adapter（生产默认）
export * from "./adapters/react-text-adapter.js";

// Phase 3: Structured JSON Adapter（预留接口）
export * from "./adapters/structured-json-adapter.js";
