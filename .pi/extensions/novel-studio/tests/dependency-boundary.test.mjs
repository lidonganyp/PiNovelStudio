/**
 * PiNovelStudio — Step 2c 生产入口依赖边界测试（P1 强化：产物级断言）
 *
 * 验证生产入口（dist/index.js）对 lab 代码的零依赖，防止回归：
 *   1. dist/ 不含 lab/ 目录（tsconfig.prod.json exclude lab 生效）
 *   2. dist/index.js 不含 legacy-index / lab-entry 的 import（静态 + 动态）
 *   3. dist/index.js 不含 registerLabTools( 调用
 *   4. dist/index.js 不含 __forceLegacyChain 运行时旗标
 *
 * LEGACY-SOURCE-DELETE-1 (#9e) 后：legacy-index.ts / register-lab-tools.ts /
 * lab/lab-entry.ts 源码已删除，其原 lab 编译产物也随之消失，故原 5/6 两条
 * "原 lab 构建 legacy-index.js 与 lab-entry.js 存在且非空" 断言已下线。
 *
 * LEGACY-LAB-BUILD-DELETE-1 (#10) 后：lab/ 目录、tsconfig.lab.json 与原 lab 构建输出
 * 已删除。原 lab 内容拆分为 dist-test/（测试专用 craft/agents/v2/utils/tools/dag/workflow
 * 模块，barrel: test/test-modules.ts）与 dist-eval/（NovelBench + eval，tsconfig.eval.json）。
 * 本测试的产物级隔离断言随之收敛为只守护 NovelBench eval-only 产物（novelbench/*）。
 *
 * P1 强化（防 tsconfig.prod.json 退化为通配 include）：
 *   7. dist/ 不含已知 eval-only 产物文件（novelbench/* 等）
 *   8. dist-eval/ 含全部已知 eval-only 产物（确认 eval 构建完整）
 *   9. dist/ 与 dist-eval/ 存在 eval-only 差集（生产闭包严格小于 eval 闭包）
 *  10. dist/ JS 文件数 < 250（旧通配 include 产出 237，生产闭包约 233，含 MEMORY 层 + Protocol Layer）
 *
 * 设计说明：
 *   - 用 import 路径模式（`from "./legacy-index` / `import("./lab/`）而非裸字符串，
 *     避免 index.ts 头注释中提及 legacy-index.ts / lab-entry.ts 的文档性引用误判。
 *   - registerLabTools( 带 `(` 只匹配调用点，不匹配注释中的裸名称。
 *   - 产物级断言直接检查 eval-only 产物是否泄漏到 dist/，
 *     避免"tsconfig 退化为通配 include 但 index.js 源码未变"的假绿。
 *   - 与 p21 / type-contract-engine-dormant-guard 同模式：readFileSync + 字符串断言。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { dirname, join, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXT_ROOT = resolve(__dirname, "..");
const DIST_DIR = join(EXT_ROOT, "dist");
const DIST_EVAL_DIR = join(EXT_ROOT, "dist-eval");
const DIST_INDEX = join(DIST_DIR, "index.js");

/**
 * 已知 eval-only 产物路径（相对于 dist 根）。
 * 这些文件必须存在于 dist-eval/ 但不得存在于 dist/。
 * 若 tsconfig.prod.json 退化为通配 include（所有 .ts 文件），
 * 这些文件会泄漏到 dist/，产物级断言将失败。
 *
 * #10 后范围收敛：原 lab-only 列表中的 craft/agents/v2/eval 测试专用模块已迁往
 * dist-test/（不再由本断言守护），此处只保留 NovelBench 评估专用产物。
 */
const EVAL_ONLY_PRODUCTS = [
  "novelbench/corpus-auditor.js",      // NB-0 语料审计（eval-only）
  "novelbench/index.js",               // NovelBench barrel（eval-only）
  "novelbench/chapter-splitter.js",    // NB-1 章节切分（eval-only）
  "novelbench/chapter-calibrator.js",  // NB-1R 章节切分校准（eval-only）
  "novelbench/leakage-scanner.js",     // NB-2 泄漏扫描（eval-only）
  "novelbench/reference-registry.js",  // NB-2 reference 注册（eval-only）
  "novelbench/partition.js",           // NB-2 按书分区（eval-only）
  "novelbench/dataset-builder.js",     // NB-2 数据集构建（eval-only）
  "novelbench/generator-bundle.js",    // NB-2R 生成器隔离 bundle（eval-only，generator-only）
  "novelbench/generator-schema-validator.js", // NB-2R 生成器 schema 校验（eval-only）
  "novelbench/reference-analyzer.js",  // NB-3 Reference Analyzer（eval-only，evaluator-only）
  "novelbench/span-validator.js",      // NB-3 span 校验工具（eval-only）
  "novelbench/generation-matrix-runner.js", // NB-4 Generation Matrix B0-B4（eval-only，generator-only）
  "novelbench/reference-aware-judge.js", // NB-5 Reference-aware Judge（eval-only，evaluator-only）
  // PROD-BUILD-BOUNDARY-1：v2/core eval-only 模块（replay provenance / 策略证据存储 / 机器评审 schema / 消融预登记 / demo 冻结）
  "v2/core/replay-provenance-guard.js",
  "v2/core/strategy-evidence-store.js",
  "v2/core/machine-review-schema.js",
  "v2/core/editorial-benefit-2a-preregistration.js",
  "v2/core/demo-4a-prep.js",
  // PROD-BUILD-BOUNDARY-1：novelos/eval/* 评估模块（盲测打包 / pairwise judge / 校准 / harness 等）
  "novelos/eval/eval-types.js",
  "novelos/eval/fixtures.js",
  "novelos/eval/eval-harness.js",
  "novelos/eval/stub-agent-model.js",
  "novelos/eval/blind-test-pack.js",
  "novelos/eval/judge-model-adapter.js",
  "novelos/eval/pairwise-judge.js",
  "novelos/eval/judge-calibration.js",
  "novelos/eval/final-decision.js",
];

/**
 * 收集目录下所有 .js 文件的内容（递归）。
 * 返回 [{ relativePath, absolutePath, content }]，relativePath 相对于传入的 dir。
 * 用于扫描 dist/novelos/ 下所有产物是否含禁止 import。
 */
function collectJsFiles(dir) {
  if (!existsSync(dir)) return [];
  const result = [];
  function walk(current) {
    for (const e of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith(".js")) {
        result.push({
          relativePath: relative(dir, full).split(sep).join("/"),
          absolutePath: full,
          content: readFileSync(full, "utf-8"),
        });
      }
    }
  }
  walk(dir);
  return result;
}

/** 收集目录下所有 .js 文件的相对路径（去掉 dist/ / dist-eval/ / dist-test/ 前缀） */
function collectJsRelative(dir) {
  if (!existsSync(dir)) return new Set();
  const result = new Set();
  function walk(current) {
    for (const e of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith(".js")) {
        result.add(relative(EXT_ROOT, full).split(sep).join("/").replace(/^dist-eval\//, "").replace(/^dist-test\//, "").replace(/^dist\//, ""));
      }
    }
  }
  walk(dir);
  return result;
}

/** 递归统计目录下 .js 文件数 */
function countJsFiles(dir) {
  if (!existsSync(dir)) return 0;
  let n = 0;
  function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else if (e.isFile() && e.name.endsWith(".js")) n++;
    }
  }
  walk(dir);
  return n;
}

describe("Step 2c：生产入口依赖边界（dist/index.js 零 lab 依赖）", () => {
  it("dist/index.js 存在", () => {
    assert.ok(existsSync(DIST_INDEX), "dist/index.js 应存在（需先 npm run build）");
  });

  it("dist/ 不含 lab/ 目录（tsconfig.prod.json exclude lab）", () => {
    assert.ok(existsSync(DIST_DIR), "dist/ 应存在");
    const entries = readdirSync(DIST_DIR, { withFileTypes: true });
    const labDir = entries.find((e) => e.isDirectory() && e.name === "lab");
    assert.equal(labDir, undefined, "dist/ 不得含 lab/ 目录（生产构建必须排除 lab 源码）");
  });

  it("dist-lab/ 目录不存在（#10 已删除 lab 构建，防止回归）", () => {
    const distLabDir = join(EXT_ROOT, "dist-lab");
    assert.ok(
      !existsSync(distLabDir),
      "dist-lab/ 应不存在（#10 已删除 lab/ 目录、tsconfig.lab.json 与 lab 构建输出；dist-lab/ 重新出现说明 lab 构建被误恢复）",
    );
  });

  it("dist/index.js 不 import legacy-index 或 lab-entry（静态 + 动态）", () => {
    assert.ok(existsSync(DIST_INDEX), "dist/index.js 应存在");
    const src = readFileSync(DIST_INDEX, "utf-8");
    // 静态 import：from "./legacy-index... 或 from "./lab/...
    assert.ok(
      !src.includes('from "./legacy-index'),
      "dist/index.js 不得静态 import legacy-index（生产入口零 legacy 依赖）",
    );
    assert.ok(
      !src.includes('from "./lab/'),
      "dist/index.js 不得静态 import lab/ 下任何模块（生产入口零 lab 依赖）",
    );
    // 动态 import：import("./legacy-index... 或 import("./lab/...
    assert.ok(
      !src.includes('import("./legacy-index'),
      "dist/index.js 不得动态 import legacy-index（生产入口零 legacy 依赖）",
    );
    assert.ok(
      !src.includes('import("./lab/'),
      "dist/index.js 不得动态 import lab/ 下任何模块（生产入口零 lab 依赖）",
    );
  });

  it("dist/index.js 不调用 registerLabTools(", () => {
    assert.ok(existsSync(DIST_INDEX), "dist/index.js 应存在");
    const src = readFileSync(DIST_INDEX, "utf-8");
    assert.ok(
      !src.includes("registerLabTools("),
      "dist/index.js 不得调用 registerLabTools(（lab 工具注册不得进入生产入口）",
    );
  });

  it("dist/index.js 不含 __forceLegacyChain 运行时旗标", () => {
    assert.ok(existsSync(DIST_INDEX), "dist/index.js 应存在");
    const src = readFileSync(DIST_INDEX, "utf-8");
    assert.ok(
      !src.includes("__forceLegacyChain"),
      "dist/index.js 不得含 __forceLegacyChain（legacy 回退旗标不得进入生产入口）",
    );
  });
});

describe("Step 2c P1：产物级 eval-only 隔离断言（防 tsconfig 退化）", () => {
  it("dist/ 不含已知 eval-only 产物文件", () => {
    assert.ok(existsSync(DIST_DIR), "dist/ 应存在（需先 npm run build）");
    const leaked = EVAL_ONLY_PRODUCTS.filter((p) => existsSync(join(DIST_DIR, p)));
    assert.deepEqual(
      leaked,
      [],
      `dist/ 不得含 eval-only 产物，但以下文件泄漏到 dist/：\n${leaked.map((p) => `  - ${p}`).join("\n")}\n` +
        '这表明 tsconfig.prod.json 可能退化为通配 include；应使用 files: ["index.ts"] + include: []',
    );
  });

  it("dist-eval/ 含全部已知 eval-only 产物（确认 eval 构建完整）", () => {
    assert.ok(existsSync(DIST_EVAL_DIR), "dist-eval/ 应存在（需先 npm run build）");
    const missing = EVAL_ONLY_PRODUCTS.filter((p) => !existsSync(join(DIST_EVAL_DIR, p)));
    assert.deepEqual(
      missing,
      [],
      `dist-eval/ 应含全部 eval-only 产物，但以下缺失：\n${missing.map((p) => `  - ${p}`).join("\n")}`,
    );
  });

  it("dist/ 与 dist-eval/ 存在 eval-only 差集（生产闭包严格小于 eval 闭包）", () => {
    const distFiles = collectJsRelative(DIST_DIR);
    const distEvalFiles = collectJsRelative(DIST_EVAL_DIR);
    const evalOnly = [...distEvalFiles].filter((p) => !distFiles.has(p));
    assert.ok(
      evalOnly.length > 0,
      "dist-eval/ 应有 dist/ 不含的 eval-only 模块，但差集为空——说明 dist/ 包含了全部 eval 代码（tsconfig.prod.json 可能退化为通配 include）",
    );
    // 确认已知 eval-only 产物全部在差集中（在 dist-eval/ 但不在 dist/）
    const knownNotInEvalOnly = EVAL_ONLY_PRODUCTS.filter((p) => !evalOnly.includes(p));
    assert.deepEqual(
      knownNotInEvalOnly,
      [],
      `已知 eval-only 产物应全部在 eval-only 差集中（在 dist-eval/ 但不在 dist/），但以下不在差集：\n${knownNotInEvalOnly.map((p) => `  - ${p}`).join("\n")}`,
    );
  });

  it("dist/ JS 文件数 < 340（防通配 include 退化为全量编译）", () => {
    const distCount = countJsFiles(DIST_DIR);
    assert.ok(distCount > 0, "dist/ JS 文件数应 > 0（需先 npm run build）");
    // 2026-08-12：自主性控制面 + 恢复控制面 + 用户反馈证据管道新增生产模块；阈值曾上调到 290。
    // 2026-08-12 续：模型路由治理 WP-01..07 合法新增 7 个生产模块
    // （run-routing-context / route-catalog / layered-budget / failure-strategy-matrix /
    //  model-call-observability / quality-cost-metrics / routing-governance-runtime）
    // 使闭包约 295。阈值上调到 310，仍远低于通配 include 全量树规模。
    // 2026-08-13 DG-4：strategy-policy-store 引入 strategy-evidence-partition（策略证据分区
    // 纯函数），合法新增 1 个生产模块（策略证据按完整行为环境隔离是生产路径的读写语义）。
    // 闭包 309 → 310。阈值上调到 311。
    // 2026-08-13 DG-5：release-lifecycle-permissions 是纯模块（dist-test），尚未接入生产，非增长来源；
    // 干净 build:prod 确定性产出 311 个 JS。阈值上调到 312。
    // 2026-08-13 DG-6：release-lifecycle-permissions 经 evolution-release-registry.transitionStatus
    // 接入生产闭包（active_prod 单例约束），合法新增 1 个生产模块。闭包 311 → 312。阈值上调到 313。
    // 2026-08-13 P7 Stage B：v2/core/audit/trace-projections 是纯投影模块（rebuildQualityTraceFromEvents
    // / rebuildTrajectoryFromEvents），经 audit/index.ts barrel 接入生产闭包，合法新增 1 个生产模块。
    // 闭包 312 → 313。阈值上调到 314。
    // 2026-08-13 P7 Stage B-Read：v2/core/audit/trace-projection-reader 是纯投影读入口
    // （loadQualityTraceProjection，仅 import trace-projections + audit-event-types + node:fs/path），
    // 经 R1（strategy-feedback-trace-context）/ R2/R3（chapter-cost-snapshot）接入生产闭包，
    // 合法新增 1 个生产模块。闭包 313 → 314。阈值上调到 315。
    // 2026-08-14 P7 Stage C-1：v2/core/audit/trace-write-mode（写路径开关纯函数）+ trace-content-store
    // （明细独立内容库，JSONL 追加写）经 craft/quality-trace-recorder 接入生产闭包，合法新增 2 个
    // 生产模块。闭包 314 → 316。阈值上调到 317。
    // 2026-08-14 P7 Stage C-3：v2/core/audit/trajectory-write-mode（TrajectoryStore 写路径开关纯函数）
    // + trajectory-content-store（轨迹明细独立内容库，原子写）经 novelos/trajectory/trajectory-store
    // 接入生产闭包，合法新增 2 个生产模块。闭包 316 → 318。阈值上调到 319。
    // 2026-08-14 P8 SIGKILL：v2/core/sigkill-fault-injection（真实子进程硬杀注入钩子，env 门控、
    // 生产零开销）经 orchestrator-commit-save + trajectory-content-store 接入生产闭包，
    // 合法新增 1 个生产模块。闭包 318 → 319。阈值上调到 320。
    // 2026-08-15 CONCURRENCY-WAVE1-3：v2/core/fs-atomic（跨进程原子原语：open('wx') 独占创建/
    // rename 接管/短期 guard）+ v2/core/submission-queue（workspace 章节提交队列，chapter_commit
    // 资源跨进程串行）接入生产闭包（batch-generation-lock / batch-generation-job-store /
    // orchestrator-commit-save 消费），合法新增 2 个生产模块。闭包 319 → 321。阈值上调到 322。
    // 2026-08-15 CONCURRENCY-WAVE4：v2/core/commit-stale-guard（提交边界 stale 环境检测：
    // 生成期 baseline 与提交时 activeReleaseId/constitutionHash 比对）经
    // orchestrator-commit-save（0c 门禁）+ unified-orchestrator（baseline 捕获）接入生产闭包，
    // 合法新增 1 个生产模块。闭包 321 → 322。阈值上调到 323。
    // 2026-08-15 BG-01：v2/core/budget-ledger（统一预算账本：真实模型调用前 reserve/调用后 settle）
    // + v2/core/budget-types（账本类型契约层）经 unified-orchestrator wrapModelFn 接入生产闭包，
    // 合法新增 2 个生产模块。闭包 322 → 324。阈值上调到 325。
    // 2026-08-15 BG 真实成本：v2/core/unit-price-schedule（版本化单价表）经 budget-ledger
    // settle + model-call-observability 接入生产闭包，合法新增 1 个生产模块。闭包 324 → 325。
    // 2026-08-16：34537d0 把 capability/evidence 生产模块纳入版本，干净闭包 334。
    // 阈值上调到 340。
    // 守卫仍是绊线：真正「退化」信号是旧通配 include 的全量树（~460）或旧 237，远高于此。
    assert.ok(
      distCount < 340,
      `dist/ JS 文件数（${distCount}）应 < 340（生产闭包约 334，含 capability/evidence 模块；旧通配 include 接近全量）；超过说明 tsconfig.prod.json 退化为全量编译`,
    );
  });
});

describe("Step 5：NovelOS 模块依赖边界（dist/novelos/ 零 lab/legacy/PI UI 依赖）", () => {
  const NOVELOS_DIST_DIR = join(DIST_DIR, "novelos");

  it("dist/novelos/ 目录存在且含 .js 产物", () => {
    assert.ok(existsSync(NOVELOS_DIST_DIR), "dist/novelos/ 应存在（需先 npm run build）");
    const files = collectJsFiles(NOVELOS_DIST_DIR);
    assert.ok(
      files.length > 0,
      "dist/novelos/ 应含至少 1 个 .js 产物（agentic-raw-candidate-source.js 等）",
    );
  });

  it("dist/novelos/ 不 import legacy-index（静态 + 动态）", () => {
    assert.ok(existsSync(NOVELOS_DIST_DIR), "dist/novelos/ 应存在");
    const files = collectJsFiles(NOVELOS_DIST_DIR);
    const violations = [];
    for (const f of files) {
      if (
        f.content.includes('from "') &&
        f.content.match(/from\s+"[^"]*legacy-index/) ||
        f.content.includes('import("') &&
        f.content.match(/import\("[^"]*legacy-index/)
      ) {
        violations.push(f.relativePath);
      }
    }
    assert.deepEqual(
      violations,
      [],
      `dist/novelos/ 不得 import legacy-index（NovelOS 是新主链路组件，不得依赖 lab 编排入口）。违规文件：\n${violations.map((p) => `  - ${p}`).join("\n")}`,
    );
  });

  it("dist/novelos/ 不 import lab/ 下任何模块（静态 + 动态）", () => {
    assert.ok(existsSync(NOVELOS_DIST_DIR), "dist/novelos/ 应存在");
    const files = collectJsFiles(NOVELOS_DIST_DIR);
    const violations = [];
    for (const f of files) {
      // 静态：from "....lab/..." 或 from "../../lab/..."
      // 动态：import("....lab/...")
      const hasStatic = /from\s+"[^"]*(?:^|\/)lab\//.test(f.content);
      const hasDynamic = /import\("[^"]*(?:^|\/)lab\//.test(f.content);
      if (hasStatic || hasDynamic) {
        violations.push(f.relativePath);
      }
    }
    assert.deepEqual(
      violations,
      [],
      `dist/novelos/ 不得 import lab/ 下任何模块（lab 是测试专用，不得进入 NovelOS 生产代码）。违规文件：\n${violations.map((p) => `  - ${p}`).join("\n")}`,
    );
  });

  it("dist/novelos/ 不 import PI UI 类型（pi-coding-agent.d.ts）", () => {
    assert.ok(existsSync(NOVELOS_DIST_DIR), "dist/novelos/ 应存在");
    const files = collectJsFiles(NOVELOS_DIST_DIR);
    const violations = [];
    for (const f of files) {
      // NovelOS 核心不得依赖 PI UI 类型（pi-coding-agent.d.ts 中定义的 UI 类型）
      // 允许：通过注入的 pi 对象调用 ctx.ui.notify（运行时接口，不是类型依赖）
      // 禁止：import type { SomeUIType } from "...pi-coding-agent"
      if (
        f.content.includes("pi-coding-agent") ||
        f.content.includes("PICodingAgent")
      ) {
        violations.push(f.relativePath);
      }
    }
    assert.deepEqual(
      violations,
      [],
      `dist/novelos/ 不得 import PI UI 类型（pi-coding-agent.d.ts）；NovelOS 核心不依赖 PI UI 类型，仅通过注入的运行时接口交互。违规文件：\n${violations.map((p) => `  - ${p}`).join("\n")}`,
    );
  });

  it("dist/novelos/ 不 import dist-eval/ 或 dist-test/ 产物（避免双模块实例）", () => {
    assert.ok(existsSync(NOVELOS_DIST_DIR), "dist/novelos/ 应存在");
    const files = collectJsFiles(NOVELOS_DIST_DIR);
    const violations = [];
    for (const f of files) {
      // NovelOS 必须从 dist/ 同一闭包 import，不得指向 dist-eval/ 或 dist-test/
      if (f.content.includes("dist-eval/") || f.content.includes("dist-test/")) {
        violations.push(f.relativePath);
      }
    }
    assert.deepEqual(
      violations,
      [],
      `dist/novelos/ 不得 import dist-eval/ 或 dist-test/ 产物（双模块实例会导致 shared 状态不连通）；所有依赖必须从 dist/ 同一闭包解析。违规文件：\n${violations.map((p) => `  - ${p}`).join("\n")}`,
    );
  });

  it("dist/novelos/agent/agentic-raw-candidate-source.js 存在（Step 5 产物）", () => {
    const p = join(NOVELOS_DIST_DIR, "agent", "agentic-raw-candidate-source.js");
    assert.ok(existsSync(p), "dist/novelos/agent/agentic-raw-candidate-source.js 应存在（Step 5 编译产物）");
    const size = statSync(p).size;
    assert.ok(size > 0, `dist/novelos/agent/agentic-raw-candidate-source.js 应非空，实际 ${size} 字节`);
  });
});

/**
 * WORKSPACE-HANDLER-DECOUPLE-1：handleWorkspaceManager 抽离后的生产闭包收敛断言。
 *
 * Phase 2b 把 handleWorkspaceManager 从 tools/workflow-tool-handlers.ts 抽到
 * tools/workspace-manager-handler.ts。原模块顶部 import createArchitectAgent /
 * createCriticAgent / createWorldPresenterAgent，被 public-handlers.ts 经
 * handleWorkspaceManager 拖入生产 dist/。抽离后生产入口只 import 新模块，
 * architect/critic/world-presenter 与整个 workflow/ 目录应退出生产闭包。
 *
 * 本断言锁定这一收敛，防止：
 *   1. 有人把 re-export 改回 from "../tools/workflow-tool-handlers.js"
 *   2. 新增生产代码 import agents/architect / agents/critic / agents/world-presenter
 *   3. workflow-tool-handlers.ts 被误纳回 tsconfig.prod.json files 数组
 */
describe("WORKSPACE-HANDLER-DECOUPLE-1：生产闭包不得含 architect/critic/world-presenter/workflow", () => {
  const FORBIDDEN_PROD_PRODUCTS = [
    // Phase 2b：handleWorkspaceManager 抽离后，原承载 handler 的 workflow-tool-handlers
    // 不再被生产入口 import；它仅由 dist-test/ barrel 供模块边界测试消费。
    "tools/workflow-tool-handlers.js",
    // workflow-tool-handlers.ts 顶部 import 的三个 Agent；handleWorkspaceManager
    // 抽到独立模块后，没有任何生产代码再依赖这三个 Agent。
    "agents/architect.js",
    "agents/critic.js",
    "agents/world-presenter.js",
  ];

  it("dist/ 不含 architect/critic/world-presenter/workflow-tool-handlers", () => {
    assert.ok(existsSync(DIST_DIR), "dist/ 应存在（需先 npm run build）");
    const leaked = FORBIDDEN_PROD_PRODUCTS.filter((p) => existsSync(join(DIST_DIR, p)));
    assert.deepEqual(
      leaked,
      [],
      `dist/ 不得含 WORKSPACE-HANDLER-DECOUPLE-1 收敛产物，但以下文件泄漏到 dist/：\n${leaked.map((p) => `  - ${p}`).join("\n")}\n` +
        "这表明 handleWorkspaceManager 可能被改回从 workflow-tool-handlers.ts re-export，" +
        "或 tsconfig.prod.json files 数组被误改回通配 include。",
    );
  });

  it("dist/ 不含 workflow/ 目录（Stage0-8 workflow 编排退出生产闭包）", () => {
    assert.ok(existsSync(DIST_DIR), "dist/ 应存在");
    const workflowDir = join(DIST_DIR, "workflow");
    assert.ok(
      !existsSync(workflowDir),
      "dist/ 不得含 workflow/ 目录（WORKSPACE-HANDLER-DECOUPLE-1 后 workflow/ 仅由 dist-test/ 消费）",
    );
  });

  it("dist/tools/workspace-manager-handler.js 存在（Phase 2b 抽离产物）", () => {
    const p = join(DIST_DIR, "tools", "workspace-manager-handler.js");
    assert.ok(existsSync(p), "dist/tools/workspace-manager-handler.js 应存在（Phase 2b 抽离后的生产入口模块）");
    const size = statSync(p).size;
    assert.ok(size > 0, `dist/tools/workspace-manager-handler.js 应非空，实际 ${size} 字节`);
  });
});

/**
 * BATCH-P0-01：批量章节生成模块生产闭包断言。
 *
 * 批量能力作为 novel_generate_chapter 的 mode="batch" 分支，不新增第二个正文生成工具。
 * 4 个新模块通过 index.ts → public-handlers.ts → batch-generation-handler.ts →
 * (orchestrator → job-store / lock) 链式 import 进入生产闭包。
 *
 * 本断言锁定：
 *   1. 4 个 batch 模块都在 dist/ 中（证明进入生产闭包）
 *   2. 模块非空（编译成功）
 *   3. dist/index.js 含 mode === "batch" 分支（接线正确）
 *   4. batch 模块不 import dist-eval / NovelBench / lab（零 eval-only 依赖）
 */
describe("BATCH-P0-01：批量章节生成模块进入生产闭包", () => {
  const BATCH_PROD_PRODUCTS = [
    "v2/core/batch-generation-job-store.js",
    "v2/core/batch-generation-lock.js",
    "v2/core/batch-generation-orchestrator.js",
    "handlers/batch-generation-handler.js",
  ];

  it("dist/ 含全部 4 个 batch 生成模块（生产闭包接线正确）", () => {
    assert.ok(existsSync(DIST_DIR), "dist/ 应存在（需先 npm run build）");
    const missing = BATCH_PROD_PRODUCTS.filter((p) => !existsSync(join(DIST_DIR, p)));
    assert.deepEqual(
      missing,
      [],
      `dist/ 应含全部 4 个 batch 生成模块，但以下缺失：\n${missing.map((p) => `  - ${p}`).join("\n")}\n` +
        "这表明 index.ts → public-handlers.ts → batch-generation-handler.ts 接线断裂，" +
        "或 batch-generation-handler.ts 未 import orchestrator/lock/job-store。",
    );
  });

  it("dist/ 中 4 个 batch 模块均非空（编译成功）", () => {
    for (const p of BATCH_PROD_PRODUCTS) {
      const full = join(DIST_DIR, p);
      assert.ok(existsSync(full), `${p} 应存在`);
      const size = statSync(full).size;
      assert.ok(size > 0, `${p} 应非空，实际 ${size} 字节`);
    }
  });

  it("dist/index.js 含 mode === \"batch\" 分支（register-tools 接线正确）", () => {
    assert.ok(existsSync(DIST_INDEX), "dist/index.js 应存在");
    // register-tools.ts 编译后，invoke 顶部应有 mode === "batch" 分支
    // 编译产物中 batch 分支体现为对 handleBatchGeneration 的调用
    const src = readFileSync(DIST_INDEX, "utf-8");
    assert.ok(
      src.includes("handleBatchGeneration"),
      "dist/index.js 应含 handleBatchGeneration 调用（mode === \"batch\" 分支接线）",
    );
  });

  it("dist/ 中 batch 模块不 import dist-eval / NovelBench / lab（零 eval-only 依赖）", () => {
    const batchFiles = BATCH_PROD_PRODUCTS.map((p) => {
      const full = join(DIST_DIR, p);
      return {
        relativePath: p,
        content: existsSync(full) ? readFileSync(full, "utf-8") : "",
      };
    });
    const violations = [];
    for (const f of batchFiles) {
      // 禁止 import dist-eval/ / dist-test/ / novelbench/ / lab/
      if (f.content.includes("dist-eval/") || f.content.includes("dist-test/")) {
        violations.push(`${f.relativePath}: import dist-eval/ 或 dist-test/`);
      }
      if (/from\s+["'][^"']*novelbench\//.test(f.content) || /import\(["'][^"']*novelbench\//.test(f.content)) {
        violations.push(`${f.relativePath}: import novelbench/`);
      }
      if (/from\s+["'][^"']*(?:^|\/)lab\//.test(f.content) || /import\(["'][^"']*(?:^|\/)lab\//.test(f.content)) {
        violations.push(`${f.relativePath}: import lab/`);
      }
    }
    assert.deepEqual(
      violations,
      [],
      `batch 模块不得 import dist-eval / dist-test / NovelBench / lab，违规：\n${violations.map((v) => `  - ${v}`).join("\n")}`,
    );
  });
});

