/**
 * MEMORY-RECORD 统一 barrel（MEMORY-INDEX-1）
 *
 * 对外暴露长期记忆层的高层 API：协议类型、校验、压缩/回源、事务/冲突、TTL/分层、
 * 权威检索、工厂转换。生产集成点（final-state-commit / orchestrator-commit-save）
 * 与测试统一从此入口消费，保持契约一致。
 */

// 协议与类型
export * from "./memory-record.js";
// 压缩策略与可回源
export * from "./memory-compression.js";
// 事务化提交 + 冲突检测 + receipt
export * from "./memory-transaction.js";
// TTL / 分层 / 版本化 / FailureEnvelope
export * from "./memory-lifecycle.js";
// 权威感知检索
export * from "./memory-retrieval.js";
// 状态条目 → MemoryRecord 工厂
export * from "./memory-factory.js";
// 共享 hash
export * from "./memory-hash.js";
