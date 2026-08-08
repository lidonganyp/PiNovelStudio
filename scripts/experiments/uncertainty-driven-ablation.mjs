#!/usr/bin/env node
/**
 * UNCERTAINTY-DRIVEN-ABLATION CLI：不确定性驱动检索决策 A/B 对照实验
 *
 * 第一轮最小实验（不改生产链路，只做 Agentic eval 对照）。
 *
 * A 组（baseline）：当前逻辑——强制跨源检索 prompt（retrievalPromptOverride 不传）
 * B 组（treatment）：不确定性驱动——retrievalPromptOverride 覆盖决策规则
 *
 * 控制变量：同 workspace / chapter / model / budget / timeout
 * 差异变量：retrievalPromptOverride 是否传入（A=undefined, B=决策规则文本）
 *
 * 模式：
 * - --stub：离线 stub 模式（不调用真实 API），用于 CI 与框架验证。
 *           stub ModelGenerateFn 根据 prompt 内容决定行为：
 *           - B 组 prompt 含"检索决策规则" → 直接返回正文（不调工具）
 *           - A 组 prompt 含"请先使用跨源叙事证据检索工具" → 发 tool_call 指令
 *           - 第 2 轮（prompt 含"已检索到的证据"）→ 返回正文
 * - 默认（无 --stub）：真实模式，使用 Gemini 3.1 Pro Preview 路由
 *
 * 用法：
 *   # stub 模式（框架验证）
 *   node scripts/experiments/uncertainty-driven-ablation.mjs --stub
 *
 *   # 真实模式（Gemini 3.1 Pro Preview）
 *   node scripts/experiments/uncertainty-driven-ablation.mjs \
 *     --workspace xinmo --chapter 18 --samples 3
 *
 *   # 自定义 case set
 *   node scripts/experiments/uncertainty-driven-ablation.mjs \
 *     --case-set path/to/cases.json --samples 3
 *
 * 产物：
 *   reports/uncertainty-driven-ablation/{run-id}/
 *   ├── ablation-result.json
 *   ├── comparison-report.md
 *   ├── blind-pack.json
 *   └── {caseId}/{arm-A-text.md, arm-B-text.md, arm-*-v2output.json}
 */

import { parseArgs } from "node:util";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ── 参数解析 ──────────────────────────────────────────────────────────────
const { values } = parseArgs({
  options: {
    "stub": { type: "boolean", default: false },
    "workspace": { type: "string", default: "xinmo" },
    "chapter": { type: "string", default: "18" },
    "chapterId": { type: "string" },
    "case-set": { type: "string" },
    "samples": { type: "string", default: "3" },
    "timeout": { type: "string", default: "600000" },
    "output": { type: "string" },
    "route": { type: "string", default: "v2_rawstage2_gemini31" },
    "help": { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  process.stdout.write(`UNCERTAINTY-DRIVEN-ABLATION CLI：不确定性驱动检索决策 A/B 对照实验

用法：
  node scripts/experiments/uncertainty-driven-ablation.mjs [options]

选项：
  --stub                  离线 stub 模式（不调用真实 API，用于框架验证）
  --workspace <id>        workspace id（默认 xinmo，真实模式用）
  --chapter <n>           章节号（默认 18，真实模式用）
  --chapter-id <id>       chapterId（默认 {chapter}-uncertainty）
  --case-set <path.json>  自定义 case set JSON（覆盖 workspace/chapter）
  --samples <n>           采样数（默认 3，每 case 重复 n 次 A/B 对照）
  --timeout <ms>          单次生成超时（默认 600000）
  --output <dir>          输出目录（默认 reports/uncertainty-driven-ablation/{timestamp}）
  --route <name>          生成路由（默认 v2_rawstage2_gemini31）
  --help                  显示本帮助

模式说明：
  --stub     离线 stub 模式，零 API 调用，验证 A/B 框架跑通
  默认       真实模式，使用 Gemini 3.1 Pro Preview（v2_rawstage2_gemini31）

产物：
  reports/uncertainty-driven-ablation/{timestamp}/
  ├── ablation-result.json     完整结果（含每 case A/B 指标）
  ├── comparison-report.md    对比报告（含最低通过条件判定）
  ├── blind-pack.json         匿名盲测包（X/Y 随机映射）
  └── {caseId}/               每 case 原始输出
      ├── arm-A-text.md
      ├── arm-B-text.md
      ├── arm-A-v2output.json
      └── arm-B-v2output.json
`);
  process.exit(0);
}

// ── 路径常量 ──────────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = resolve(__filename, "..");
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..", "..");
const EXT_ROOT = join(PROJECT_ROOT, ".pi", "extensions", "novel-studio");
const DIST = join(EXT_ROOT, "dist-eval");
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUTPUT_DIR = values.output
  ? resolve(values.output)
  : join(PROJECT_ROOT, "reports", "uncertainty-driven-ablation", `run-${TIMESTAMP}`);

const WORKSPACE_ID = values.workspace;
const CHAPTER_NUMBER = parseInt(values.chapter, 10);
const CHAPTER_ID = values.chapterId ?? `${CHAPTER_NUMBER}-uncertainty`;
const TIMEOUT_MS = parseInt(values.timeout, 10);
const IS_STUB = values.stub;
const GENERATE_ROUTE = values.route;
const SAMPLES = parseInt(values.samples, 10);

// ── 环境变量 ──────────────────────────────────────────────────────────────
// 项目记忆硬约束：临时/批量测试只用 GLM/Doubao，PINOVEL_DISABLE_FALLBACK=1。
// 但本实验真实模式使用 Gemini 3.1 Pro Preview（v2_rawstage2_gemini31），
// 属于正式章节生成路由，需保持 fallback 配置不变（fallback=[]，hard block）。
process.env.PROJECT_ROOT = PROJECT_ROOT;
if (IS_STUB) {
  // stub 模式：不需要真实 API
  process.env.PINOVEL_DISABLE_FALLBACK = "1";
}

mkdirSync(OUTPUT_DIR, { recursive: true });

// ── 日志工具 ──────────────────────────────────────────────────────────────
function log(message) {
  process.stderr.write(`[uncertainty-ablation] ${message}\n`);
}

// ── 动态 import dist-eval 模块 ────────────────────────────────────────────
const importDist = async (relativePath) =>
  import(pathToFileURL(join(DIST, relativePath)).href);

// ── case 加载 ─────────────────────────────────────────────────────────────

/**
 * 加载 case 列表。
 *
 * - --case-set 指定 JSON 文件：直接读取
 * - --stub 模式：使用内联最小 case（3 个虚拟 case，不依赖 workspace）
 * - 默认：从 workspace 加载真实 prefix（前 1-2 章）
 */
async function loadCases() {
  // 优先级 1：--case-set
  if (values["case-set"]) {
    const caseSetPath = resolve(values["case-set"]);
    if (!existsSync(caseSetPath)) {
      process.stderr.write(`错误：case-set 文件不存在：${caseSetPath}\n`);
      process.exit(1);
    }
    const raw = JSON.parse(readFileSync(caseSetPath, "utf-8"));
    const cases = Array.isArray(raw) ? raw : raw.cases;
    if (!Array.isArray(cases) || cases.length === 0) {
      process.stderr.write(`错误：case-set 不含有效 cases 数组\n`);
      process.exit(1);
    }
    log(`从 ${caseSetPath} 加载 ${cases.length} 个 case`);
    return cases;
  }

  // 优先级 2：--stub 模式内联最小 case
  if (IS_STUB) {
    const stubCases = [
      {
        caseId: "stub-case-1",
        genre: "都市悬疑",
        targetChapter: 5,
        prefix:
          "林默站在十字路口，红灯在雨幕中模糊地闪烁。" +
          "他握紧了口袋里的纸条，指节发白。\n\n" +
          "「你只有三天。」电话那头的声音依然在耳边回响。\n\n" +
          "三天。从昨天算起，还剩两天。他必须在天亮前做出选择。",
        characterNames: ["林默"],
      },
      {
        caseId: "stub-case-2",
        genre: "玄幻",
        targetChapter: 12,
        prefix:
          "玉衡星的灵气骤然紊乱，苏远感到丹田一阵刺痛。" +
          "他强行运转功法，压下翻涌的气血，目光锁住对面的黑袍人。\n\n" +
          "「你师父的东西，该交出来了。」黑袍人冷声道。\n\n" +
          "苏远握紧了剑柄，他知道这一战避无可避。",
        characterNames: ["苏远"],
      },
      {
        caseId: "stub-case-3",
        genre: "科幻",
        targetChapter: 3,
        prefix:
          "「检测到异常引力波信号。」飞船 AI 的声音平静得近乎冷漠。" +
          "陈晨盯着全息屏上的红点，那是一个不该存在的质量源。\n\n" +
          "「距离？」她问。\n「0.3 光秒，正在接近。」\n\n" +
          "她深吸一口气，按下了全舰警报。",
        characterNames: ["陈晨"],
      },
    ];
    log(`stub 模式：使用 ${stubCases.length} 个内联最小 case`);
    return stubCases;
  }

  // 优先级 3：从 workspace 加载真实 prefix
  const chapterDir = join(PROJECT_ROOT, "workspaces", WORKSPACE_ID, "chapters");
  const prevChapter = CHAPTER_NUMBER - 1;
  const prevPrevChapter = CHAPTER_NUMBER - 2;

  const prefixParts = [prevPrevChapter, prevChapter]
    .map((n) => {
      const p = join(chapterDir, `chapter-${n}.md`);
      return existsSync(p) ? readFileSync(p, "utf-8") : null;
    })
    .filter(Boolean);

  if (prefixParts.length === 0) {
    process.stderr.write(
      `错误：workspace ${WORKSPACE_ID} 未找到第 ${prevPrevChapter} 或 ${prevChapter} 章文本\n`,
    );
    process.exit(1);
  }

  const prefix = prefixParts.join("\n\n");

  // 从 workspace 配置提取 characterNames
  const configPath = join(
    PROJECT_ROOT,
    "workspaces",
    WORKSPACE_ID,
    "config.json",
  );
  let characterNames = [];
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      characterNames = (config.characters ?? [])
        .map((c) => c.name)
        .filter(Boolean);
    } catch {
      // 忽略解析错误
    }
  }

  // 构造 N 个采样 case（同 prefix，不同 caseId）
  const cases = [];
  for (let i = 1; i <= SAMPLES; i++) {
    cases.push({
      caseId: `${WORKSPACE_ID}-ch${CHAPTER_NUMBER}-s${i}`,
      genre: "都市悬疑", // 从 config 推断会更准确，但最小实验先固定
      targetChapter: CHAPTER_NUMBER,
      prefix,
      characterNames,
    });
  }
  log(
    `workspace=${WORKSPACE_ID} chapter=${CHAPTER_NUMBER} samples=${SAMPLES} characterNames=${characterNames.join(", ") || "(empty)"}`,
  );
  return cases;
}

// ── stub ModelGenerateFn ──────────────────────────────────────────────────

/**
 * 构造 stub ModelGenerateFn。
 *
 * stub 根据 userPrompt 内容判断当前阶段，模拟 ReAct 工具调用 + 正文生成：
 * - B 组 prompt 含"检索决策规则"（retrievalPromptOverride 注入）→ 直接返回正文
 *   （模拟"上下文足够，不调工具"的不确定性驱动决策）
 * - A 组 prompt 含"请先使用跨源叙事证据检索工具"（默认强制检索）→ 发 tool_call 指令
 * - 第 2 轮 prompt 含"已检索到的证据" → 返回正文
 * - patch 阶段 prompt 含"修复范围与方向" → 返回原 draft
 *
 * 注意：stub 不感知 arm 身份（A/B），只根据 prompt 内容决策。
 * 这保证了 A/B 差异完全来自 prompt 决策规则，而非 stub 的硬编码分支。
 */
function createStubModelGenerate() {
  return async (input) => {
    const userPrompt = input.userPrompt ?? "";

    // patch 阶段：返回原 draft
    if (userPrompt.includes("修复范围与方向")) {
      const draftMatch = userPrompt.match(/原始正文：\n?([\s\S]*?)\n\n修复范围与方向/);
      const draft = draftMatch ? draftMatch[1].trim() : "（patch 阶段：返回原 draft）";
      return {
        text: draft,
        model: "stub-patch",
        route: input.route,
        durationMs: 1,
      };
    }

    // B 组：不确定性驱动 prompt → 直接返回正文
    if (userPrompt.includes("检索决策规则")) {
      return {
        text: generateStubChapterText(input),
        model: "stub-uncertainty",
        route: input.route,
        durationMs: 2,
      };
    }

    // 第 2 轮（已有证据）→ 返回正文
    if (userPrompt.includes("已检索到的证据")) {
      return {
        text: generateStubChapterText(input),
        model: "stub-evidence",
        route: input.route,
        durationMs: 3,
      };
    }

    // A 组：强制检索 prompt → 发 tool_call 指令
    if (userPrompt.includes("请先使用跨源叙事证据检索工具")) {
      const toolCall =
        'Action: search_narrative_evidence\n' +
        'Action Input: {"query":"前文角色状态与前章悬念","maxResults":5}\n';
      return {
        text: toolCall,
        model: "stub-retrieval",
        route: input.route,
        durationMs: 1,
      };
    }

    // 默认：直接返回正文（其他阶段）
    return {
      text: generateStubChapterText(input),
      model: "stub-default",
      route: input.route,
      durationMs: 1,
    };
  };
}

/**
 * 生成 stub 章节正文（最小可用，仅用于框架验证）。
 */
function generateStubChapterText(input) {
  const route = input.route ?? "unknown";
  return [
    "第" + CHAPTER_NUMBER + "章（stub 生成，route=" + route + "）",
    "",
    "夜色压下来，街灯把人影拉得很长。",
    "他握紧手中的东西，心跳在耳膜里敲出鼓点。",
    "",
    "「该来的总会来。」他低声说，迈步走向那扇门。",
    "",
    "门后是什么，他不确定。但不走下去，就永远不知道答案。",
    "（stub 正文结束，仅用于框架验证）",
  ].join("\n");
}

// ── 真实 ModelGenerateFn ──────────────────────────────────────────────────

/**
 * 构造真实 ModelGenerateFn（Gemini 3.1 Pro Preview）。
 *
 * 通过 legacy fallback-manager 调用真实 API。
 * route 锁定到 v2_rawstage2_gemini31（Gemini 3.1 Pro Preview）。
 * fallback=[]，失败 hard block，不静默切换其他模型。
 */
async function createRealModelGenerate() {
  const { createLegacyModelGenerateFn } = await importDist(
    join("v2", "adapters", "legacy-model-route-adapter.js"),
  );
  const { loadModelRoutingSync } = await importDist(join("utils", "config.js"));
  loadModelRoutingSync();

  const legacyGenerate = createLegacyModelGenerateFn();

  return async (input) => {
    return legacyGenerate({
      ...input,
      route: input.route ?? GENERATE_ROUTE,
      requestedRoute: input.route ?? GENERATE_ROUTE,
    });
  };
}

// ── 主流程 ────────────────────────────────────────────────────────────────

log("模式：" + (IS_STUB ? "stub（离线框架验证）" : "real（Gemini 3.1 Pro Preview）"));
log("输出目录：" + OUTPUT_DIR);
log("route：" + GENERATE_ROUTE);
log("timeout：" + TIMEOUT_MS + "ms");

const cases = await loadCases();
log("case 数：" + cases.length);

// 写 manifest
const manifest = {
  experimentId: "uncertainty-driven-" + TIMESTAMP,
  hypothesis:
    "不确定性驱动的检索决策能在不增加事实硬伤的前提下减少无效检索，且文学质量不下降",
  isStub: IS_STUB,
  generateRoute: GENERATE_ROUTE,
  timeoutMs: TIMEOUT_MS,
  samples: SAMPLES,
  caseCount: cases.length,
  cases: cases.map((c) => ({
    caseId: c.caseId,
    genre: c.genre,
    targetChapter: c.targetChapter,
  })),
  timestamp: TIMESTAMP,
};
writeFileSync(
  join(OUTPUT_DIR, "manifest.json"),
  JSON.stringify(manifest, null, 2),
  "utf-8",
);

// 构造 modelGenerate
const modelGenerate = IS_STUB
  ? createStubModelGenerate()
  : await createRealModelGenerate();

// 动态 import runAblation
const { runAblation } = await importDist(
  join("novelos", "eval", "uncertainty-driven-ablation.js"),
);

log("开始 A/B 对照实验...");
const result = await runAblation({
  cases,
  modelGenerate,
  generateRoute: GENERATE_ROUTE,
  timeoutMs: TIMEOUT_MS,
  outputDir: OUTPUT_DIR,
});

log("实验完成。");
log("最低通过条件：" + (result.passCriteria.overallPassed ? "PASS" : "FAIL"));
log("报告：" + join(OUTPUT_DIR, "comparison-report.md"));
log("盲测包：" + join(OUTPUT_DIR, "blind-pack.json"));

process.exit(0);