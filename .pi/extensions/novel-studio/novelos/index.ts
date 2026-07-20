/**
 * NovelOS — M1 纵向切片公共出口（barrel）
 *
 * 临时入口：让 tsconfig.prod.json 编译 novelos/ 到 dist/novelos/，
 * 供测试与 shadow 接线使用。Step 5（任务三）把 agentic-raw-candidate-source
 * 接入 unified-orchestrator.ts 后，novelos/ 通过 import 闭包自然进入 prod build，
 * 此 barrel 可保留为公共 API 出口或移除。
 */

export * from "./runtime/runtime.js";
export * from "./runtime/budget-policy.js";
export * from "./session/novel-session.js";
export * from "./trajectory/trajectory-store.js";
export * from "./adapters/pi-agent-core-adapter.js";
export * from "./tools/tool-protocol.js";
export * from "./security/permission-policy.js";
export * from "./agent/narrative-search-service.js";
export * from "./agent/narrative-tool-registry.js";
export * from "./agent/evidence-plan.js";
export * from "./agent/candidate-workspace.js";
export * from "./agent/narrative-agent-loop.js";
export * from "./verification/narrative-verifier-suite.js";
export * from "./verification/verification-feedback-compiler.js";
export * from "./agent/candidate-patch-service.js";
export * from "./agent/agentic-raw-candidate-source.js";
