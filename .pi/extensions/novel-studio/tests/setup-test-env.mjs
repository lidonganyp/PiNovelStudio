/**
 * 测试套件环境设置 — 测试/评测基础设施 opt-in
 *
 * LEGACY-LAB-BUILD-DELETE-1 (#10) 后：
 * - 生产入口（index.ts → dist/index.js）只注册 6 个公开工具，无 NOVEL_TEST_TOOLS 门控。
 * - legacy lab 构建（lab/、tsconfig.lab.json、register-lab-tools.ts、lab/lab-entry.ts、
 *   lab/lab-test-modules.ts）已全部删除。
 * - 原 lab barrel 中的测试模块已迁移到 test/test-modules.ts（编译到 dist-test/）；
 *   NovelBench + eval/* 模块由 tsconfig.eval.json 编译到 dist-eval/。
 * - NOVEL_TEST_TOOLS 现仅作为测试基础设施旗标保留（production-tool-registration
 *   回归测试验证生产入口不受其影响），不再门控任何生产工具注册。
 *
 * 生产 PI 加载扩展时走 dist/index.js（或源码 index.ts），不设置此变量，
 * 故测试/评测模块永远不会在生产路径注册。
 */

// 测试环境显式 opt-in 标记。
// 生产路径不设置此变量，故测试/评测模块不会被生产 PI 注册。
process.env.NOVEL_TEST_TOOLS = "1";

// EVOLUTION-RELEASE-GOVERNANCE-G6：测试套件默认进入非生产开发模式。
// 生产入口（v2/core/unified-entry.ts）会在 ContextCompiler 之前调用 production-release-gate；
// 测试不配置 active production release，需通过 PINOVEL_DEV_MODE=1 bypass 门禁。
// 生产路径不设置此变量；G6 专项测试（evolution-release-governance-g6-*.test.mjs）
// 会在用例内显式 clearDevMode() 以验证门禁阻断行为。
process.env.PINOVEL_DEV_MODE = "1";

// 大量历史单元/评测夹具断言 B0-B4 raw/judge 语义，且没有 workspace 作者风格档案。
// 仅测试总套件默认保留旧评测编排；真实生产环境不设置此变量。
// 新生产链路专项测试会显式删除该变量，验证 Agentic + 作者风格正式行为。
process.env.PINOVEL_TEST_LEGACY_PRODUCTION_FLOW = "1";
