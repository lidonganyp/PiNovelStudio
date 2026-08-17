/**
 * NovelOS M1 Step 5 — 架构边界测试
 *
 * 验证 NovelOS 接入统一主链路后的硬性架构边界（计划 §Step 5.6）：
 *
 * 静态边界（产物级）：
 *   1. novel_generate_chapter 仍是唯一公开正文入口（6 公开工具，无 narrator/critic 公开）
 *   2. 不增加新产品生成模式（无 generationMode 代码路径）
 *   3. dist/index.js 不含 __forceLegacyChain 运行时旗标
 *   4. dist/index.js 不含 PINOVEL_UNIFIED_PIPELINE 生产回滚分支
 *   5. NovelOS 核心不 import PI UI 类型（pi-coding-agent.d.ts）
 *
 * 行为边界（编排器级）：
 *   6. NovelOS session 失败 → one_shot_raw fallback，不 hard block
 *      （agenticCandidateSource 抛异常/返回 null → status="ok", selectedSource="raw"）
 *   7. agentic_raw 候选不参与 selection（selectedSource 只能是 "raw" | "editorial"）
 *   8. Shadow 默认 OFF（无 PINOVEL_NOVELOS_SHADOW 环境变量 → shadowEnabled=false）
 *   9. Shadow ON + agentic 成功 → agentic_raw 候选进入 candidates（供 trace 审计）但不被选中
 *  10. 未设 productionFlow 的遗留 raw/shadow 路径不得提交状态或写章节；
 *      交付正文仍是 raw，agentic_raw 不得被选中或单独触发 commit
 *
 * 设计说明：
 *   - 静态断言与 dependency-boundary.test.mjs 同模式（readFileSync + 字符串/正则断言）
 *   - 行为断言用 stub modelGenerate + stub agenticCandidateSource，复用 phase5 测试夹具模式
 *   - 与 phase5-unified-orchestrator.test.mjs 互补：phase5 验证主链路正确性，
 *     本文件验证 NovelOS 接入后的架构边界不被破坏
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  readFileSync,
  readdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { createUnifiedOrchestrator } from "../dist/v2/core/unified-orchestrator.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXT_ROOT = join(__dirname, "..");
const DIST_DIR = join(EXT_ROOT, "dist");
const DIST_INDEX = join(DIST_DIR, "index.js");
const DIST_PUBLIC_HANDLERS = join(DIST_DIR, "handlers", "public-handlers.js");
const DIST_NOVELOS_DIR = join(DIST_DIR, "novelos");

// ============================================================================
// 辅助：过滤注释行后检查字符串
// ============================================================================

/**
 * 把源码按行拆分，过滤掉注释行（// ... / * ... / *）/ 空行，
 * 返回非注释代码行数组。用于检查 generationMode 等关键字是否在真实代码中出现。
 */
function nonCommentLines(src) {
  return src.split(/\r?\n/).filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (trimmed.startsWith("//")) return false;
    if (trimmed.startsWith("*")) return false;
    if (trimmed.startsWith("/*")) return false;
    return true;
  });
}

/** 递归收集目录下所有 .js 文件（绝对路径） */
function collectJsPaths(dir) {
  if (!existsSync(dir)) return [];
  const result = [];
  function walk(current) {
    for (const e of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith(".js")) result.push(full);
    }
  }
  walk(dir);
  return result;
}

// ============================================================================
// 辅助：构造 intent / context / 候选正文（与 phase5 测试同模式）
// ============================================================================

function makeIntent(overrides = {}) {
  return {
    chapterFunction: "推进核心冲突",
    readerExperience: ["紧张", "期待"],
    currentPressure: ["水下救援压力"],
    meaningfulChoices: [],
    promisesToAdvance: [],
    possibleEndPressure: [],
    relevantCharacters: ["林川", "苏婉"],
    inviolableFacts: ["水下暗流不可消除"],
    sourceRefs: ["chapter-seed"],
    ...overrides,
  };
}

function makeContext(overrides = {}) {
  return {
    facts: [
      { id: "fact:1", content: "青鱼嘴水域有暗流", sourceIds: ["skeleton"], kind: "fact" },
    ],
    characterStates: [
      {
        characterId: "林川",
        name: "林川",
        state: { role: "主角", mentality: "冷静", pendingTension: "救人vs自保" },
        sourceIds: ["character:林川"],
      },
    ],
    openLoops: [],
    worldRules: [],
    // Phase 1 整改：orchestrator 入口要求 context.styleReferences 中存在 kind=fingerprint
    // 的档案，否则在模型调用前 hard block。本测试验证 shadow 模式行为，不是 preflight 行为，
    // 因此提供最小可消费风格指纹以通过前置检查。
    styleReferences: [{
      id: "style:arch-boundary-test",
      kind: "fingerprint",
      content: JSON.stringify({
        id: "arch-boundary-test",
        usagePolicy: { rawPrompt: "excluded", fullChapterOptimization: "required" },
        editorialGuidance: [
          "保持叙事节奏紧凑。",
          "对白自然口语化。",
          "章末留有钩子。",
        ],
        characterVoiceGuidance: {},
      }),
    }],
    sourceMap: [],
    constitution: null,
    longTermState: null,
    ...overrides,
  };
}

/** 高质量 raw：章末有钩子，不触发编辑机会（直接交付 raw） */
const HIGH_QUALITY_RAW = [
  "林川推开舱门，冲进浑浊的水里。",
  "他抓住苏婉的手臂，把她往水面拉。",
  "暗流拉扯着他的腿，他用力蹬水，转身挡住一块漂来的木板。",
  "他把苏婉推到浅滩，又一次跳进水里去找老周。",
  "浑浊的水下，一个黑影正缓缓游向老周。",
  "林川心里一紧：那东西的形状，不像鱼。他到底看到了什么？",
].join("\n");

// ============================================================================
// 辅助：stub 模型（raw 返回高质量正文，无 editorial 调用）
// ============================================================================

function makeStubModel(rawText) {
  return async (input) => {
    if (input.kind === "raw_chapter") {
      return { text: rawText, model: "stub-raw", route: input.route, durationMs: 10 };
    }
    // 其他 kind（editorial_amplified / literary_judge）不应被调用（高质量 raw 无编辑机会）
    return { text: "", model: "stub-other", route: input.route, durationMs: 10 };
  };
}

// ============================================================================
// 辅助：stub agenticCandidateSource
// ============================================================================

/** 构造一个"总是失败"的 agenticCandidateSource（模拟 NovelOS session 失败，返回 null candidate） */
function makeFailingAgenticSource() {
  return {
    async generate(_input) {
      return {
        candidate: null,
        sessionId: "test-failing-session",
        trajectoryPath: "/tmp/test-trajectory.jsonl",
        budgetSnapshot: { turns: 0, toolCalls: 0, exhausted: false },
        stopReason: "not_run",
        failureReason: "stub-failure-for-test",
        sourceRefs: [],
        toolCalls: 0,
      };
    },
  };
}

/** 构造一个"总是抛异常"的 agenticCandidateSource（模拟 NovelOS session 崩溃） */
function makeThrowingAgenticSource() {
  return {
    async generate(_input) {
      throw new Error("stub-throw-for-test");
    },
  };
}

/** 构造一个"总是成功"的 agenticCandidateSource（模拟 agentic_raw 候选生成成功） */
function makeSucceedingAgenticSource(candidateText) {
  return {
    async generate(input) {
      return {
        candidate: {
          id: `candidate:agentic_raw:${input.chapterId}`,
          text: candidateText,
          kind: "agentic_raw",
          route: "novelos_agentic",
          contextHash: "stub-agentic-hash",
          input: {
            workspaceId: input.workspaceId,
            chapterId: input.chapterId,
            chapterNumber: input.chapterNumber,
          },
        },
        sessionId: "test-succeeding-session",
        trajectoryPath: "/tmp/test-trajectory.jsonl",
        budgetSnapshot: { turns: 3, toolCalls: 5, exhausted: false },
        stopReason: "evidence_sufficient",
        failureReason: undefined,
        sourceRefs: ["chapter:ch1", "canon:fact:0"],
        toolCalls: 5,
      };
    },
  };
}

// ============================================================================
// 辅助：临时 project + orchestrator input
// ============================================================================

function makeTempProject() {
  const dir = mkdtempSync(join(tmpdir(), "novelos-arch-"));
  return { dir, projectRoot: dir };
}

function makeOrchestratorInput(overrides = {}) {
  const { dir } = makeTempProject();
  return {
    workspaceId: "test-ws",
    chapterId: "ch-test",
    chapterNumber: 1,
    projectRoot: dir,
    intent: makeIntent(),
    context: makeContext(),
    constitution: null,
    characterNames: ["林川", "苏婉", "老周"],
    modelGenerate: makeStubModel(HIGH_QUALITY_RAW),
    ...overrides,
  };
}

// ============================================================================
// 静态边界测试
// ============================================================================

describe("NovelOS Step 5.6 静态架构边界（产物级）", () => {
  it("dist/index.js 存在（前置条件）", () => {
    assert.ok(existsSync(DIST_INDEX), "dist/index.js 应存在（需先 npm run build）");
  });

  it("novel_generate_chapter 是唯一公开正文入口（不公开 narrator/critic）", () => {
    assert.ok(existsSync(DIST_INDEX), "dist/index.js 应存在");
    const src = readFileSync(DIST_INDEX, "utf-8");
    // 必须含 novel_generate_chapter 工具注册
    assert.ok(
      src.includes("novel_generate_chapter"),
      "dist/index.js 必须注册 novel_generate_chapter 工具",
    );
    // 不得通过 pi.registerTool 公开内部阶段 Agent（narrator/critic）
    // 内部 Agent 由编排器内部调用，不通过 pi.registerTool 暴露
    assert.ok(
      !/pi\.registerTool\s*\(\s*[^)]*novel_narrator/.test(src),
      "dist/index.js 不得通过 pi.registerTool 公开 novel_narrator",
    );
    assert.ok(
      !/pi\.registerTool\s*\(\s*[^)]*novel_critic/.test(src),
      "dist/index.js 不得通过 pi.registerTool 公开 novel_critic",
    );
  });

  it("不增加新产品生成模式（无 generationMode 代码路径）", () => {
    assert.ok(existsSync(DIST_PUBLIC_HANDLERS), "dist/handlers/public-handlers.js 应存在");
    const handlerSrc = readFileSync(DIST_PUBLIC_HANDLERS, "utf-8");
    // 过滤注释后检查：不应有 generationMode 作为实际代码属性
    const codeLines = nonCommentLines(handlerSrc);
    const generationModeLines = codeLines.filter((line) =>
      /\.generationMode\b|generationMode\s*[?:=]|\bgenerationMode\s*[,:)]/.test(line),
    );
    assert.deepEqual(
      generationModeLines,
      [],
      "public-handlers.js 不得含 generationMode 代码路径（无 legacy/v2 双模式切换）",
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

  it("dist/index.js 不含 PINOVEL_UNIFIED_PIPELINE 生产回滚分支", () => {
    assert.ok(existsSync(DIST_INDEX), "dist/index.js 应存在");
    const src = readFileSync(DIST_INDEX, "utf-8");
    // PINOVEL_UNIFIED_PIPELINE 已从生产路径移除（Phase 7）
    // 生产入口不应有 process.env.PINOVEL_UNIFIED_PIPELINE 检查（非注释行）
    const codeLines = nonCommentLines(src);
    const unifiedPipelineLines = codeLines.filter((line) =>
      /PINOVEL_UNIFIED_PIPELINE/.test(line),
    );
    assert.deepEqual(
      unifiedPipelineLines,
      [],
      "dist/index.js 不得含 PINOVEL_UNIFIED_PIPELINE 生产回滚分支（Phase 7 已移除）",
    );
  });

  it("NovelOS 核心不 import PI UI 类型（pi-coding-agent.d.ts）", () => {
    assert.ok(existsSync(DIST_NOVELOS_DIR), "dist/novelos/ 应存在");
    const novelosFiles = collectJsPaths(DIST_NOVELOS_DIR);
    assert.ok(novelosFiles.length > 0, "dist/novelos/ 应含至少 1 个 .js 产物");
    const violations = [];
    for (const f of novelosFiles) {
      const content = readFileSync(f, "utf-8");
      if (content.includes("pi-coding-agent") || content.includes("PICodingAgent")) {
        violations.push(relative(DIST_NOVELOS_DIR, f).split(sep).join("/"));
      }
    }
    assert.deepEqual(
      violations,
      [],
      `dist/novelos/ 不得 import PI UI 类型（pi-coding-agent.d.ts）；NovelOS 核心不依赖 PI UI 类型。违规文件：${violations.join(", ")}`,
    );
  });
});

// ============================================================================
// 行为边界测试：NovelOS shadow 模式
// ============================================================================

describe("NovelOS Step 5.6 行为边界（shadow 模式）", () => {
  // 保存/恢复环境变量，避免测试间污染
  let originalShadow;
  before(() => {
    originalShadow = process.env.PINOVEL_NOVELOS_SHADOW;
  });
  after(() => {
    if (originalShadow === undefined) delete process.env.PINOVEL_NOVELOS_SHADOW;
    else process.env.PINOVEL_NOVELOS_SHADOW = originalShadow;
  });

  it("Shadow 默认 OFF（无 PINOVEL_NOVELOS_SHADOW → shadowEnabled=false）", async () => {
    delete process.env.PINOVEL_NOVELOS_SHADOW;
    const input = makeOrchestratorInput();
    try {
      const orch = createUnifiedOrchestrator();
      const result = await orch.orchestrate(input);
      assert.equal(result.status, "ok", "无 shadow 时应正常交付");
      assert.equal(result.selectedSource, "raw", "高质量 raw 无编辑机会 → 交付 raw");
      const novelosData = result.stageResults.novelos;
      assert.ok(novelosData, "stageResults.novelos 应存在");
      assert.equal(
        novelosData.shadowEnabled,
        false,
        "无 PINOVEL_NOVELOS_SHADOW 环境变量时 shadowEnabled 必须为 false",
      );
    } finally {
      rmSync(input.projectRoot, { recursive: true, force: true });
    }
  });

  it("Shadow ON + agentic 失败 → one_shot_raw fallback（不 hard block）", async () => {
    process.env.PINOVEL_NOVELOS_SHADOW = "1";
    const input = makeOrchestratorInput({
      agenticCandidateSource: makeFailingAgenticSource(),
    });
    try {
      const orch = createUnifiedOrchestrator();
      const result = await orch.orchestrate(input);
      // 关键断言：agentic 失败不阻断生成
      assert.equal(result.status, "ok", "agentic 失败时仍应 status=ok（回退 one_shot_raw）");
      assert.notEqual(result.status, "blocked", "agentic 失败不得 hard block");
      assert.equal(result.selectedSource, "raw", "agentic 失败 → 回退 one_shot_raw");
      assert.ok(result.text.length > 0, "agentic 失败时仍应交付正文（raw）");
      // 验证 trace 记录了 failure
      const novelosData = result.stageResults.novelos;
      assert.ok(novelosData, "stageResults.novelos 应记录 agentic 失败");
      assert.equal(novelosData.shadowEnabled, true, "shadow 应启用");
      assert.equal(novelosData.candidateId, null, "agentic 失败 → candidateId 为 null");
      assert.ok(
        novelosData.failureReason || result.warnings.some((w) => w.includes("NovelOS")),
        "应记录 agentic 失败原因或 warning",
      );
    } finally {
      rmSync(input.projectRoot, { recursive: true, force: true });
    }
  });

  it("Shadow ON + agentic 抛异常 → 仍不 hard block（异常被捕获）", async () => {
    process.env.PINOVEL_NOVELOS_SHADOW = "1";
    const input = makeOrchestratorInput({
      agenticCandidateSource: makeThrowingAgenticSource(),
    });
    try {
      const orch = createUnifiedOrchestrator();
      const result = await orch.orchestrate(input);
      // 关键断言：agentic 异常被捕获，不传播
      assert.equal(result.status, "ok", "agentic 抛异常时仍应 status=ok（异常不传播）");
      assert.equal(result.selectedSource, "raw", "agentic 异常 → 回退 one_shot_raw");
      assert.ok(
        result.warnings.some((w) => w.includes("NovelOS") && w.includes("异常")),
        "应记录 agentic 异常 warning",
      );
    } finally {
      rmSync(input.projectRoot, { recursive: true, force: true });
    }
  });

  it("Shadow ON + agentic 成功 → agentic_raw 候选进入 candidates 但不被选中", async () => {
    process.env.PINOVEL_NOVELOS_SHADOW = "1";
    const agenticText = "这是 NovelOS agentic 生成的候选正文（仅供 trace 对照，不参与选择）。";
    const input = makeOrchestratorInput({
      agenticCandidateSource: makeSucceedingAgenticSource(agenticText),
    });
    try {
      const orch = createUnifiedOrchestrator();
      const result = await orch.orchestrate(input);
      assert.equal(result.status, "ok", "agentic 成功 + 高质量 raw → 正常交付");
      // 关键断言：selectedSource 只能是 "raw" 或 "editorial"，绝不可能是 "agentic_raw"
      assert.ok(
        result.selectedSource === "raw" || result.selectedSource === "editorial",
        `selectedSource 必须是 "raw" 或 "editorial"，实际：${result.selectedSource}（agentic_raw 不得被选中）`,
      );
      assert.equal(result.selectedSource, "raw", "高质量 raw 无编辑机会 → 交付 raw");
      // agentic_raw 候选应进入 candidates（供 trace 审计）
      const agenticCandidate = result.candidates.find((c) => c.kind === "agentic_raw");
      assert.ok(agenticCandidate, "agentic_raw 候选应进入 candidates 数组（供 trace 审计）");
      assert.equal(agenticCandidate.text, agenticText, "agentic_raw 候选正文应匹配");
      // 但选中的不是 agentic_raw
      assert.notEqual(
        result.selectedCandidateId,
        agenticCandidate.id,
        "agentic_raw 候选不得被选中（shadow 模式下不影响正式交付）",
      );
      // trace 记录 agentic 成功
      const novelosData = result.stageResults.novelos;
      assert.ok(novelosData, "stageResults.novelos 应记录 agentic 成功");
      assert.equal(novelosData.shadowEnabled, true, "shadow 应启用");
      assert.equal(novelosData.candidateId, agenticCandidate.id, "trace 应记录 agentic 候选 id");
      assert.ok(novelosData.toolCalls > 0, "trace 应记录 agentic 工具调用次数");
    } finally {
      rmSync(input.projectRoot, { recursive: true, force: true });
    }
  });

  it("未设 productionFlow 的 raw/shadow 路径不得提交状态；交付正文仍是 raw", async () => {
    process.env.PINOVEL_NOVELOS_SHADOW = "1";
    const agenticText = "NovelOS agentic 正文（不应触发 FinalStateCommit，不应被交付）。";
    const input = makeOrchestratorInput({
      agenticCandidateSource: makeSucceedingAgenticSource(agenticText),
    });
    try {
      const orch = createUnifiedOrchestrator();
      const result = await orch.orchestrate(input);
      assert.equal(result.status, "ok");
      assert.equal(result.selectedSource, "raw");
      // PRODUCTION-ROLLOUT-AUDIT-1：遗留 raw/judge 分支未设 productionFlow 时
      // 不得提交状态或写章节。agentic_raw 仍不得被选中。
      assert.equal(result.stateCommit, null, "未设 productionFlow 不得提交状态");
      assert.equal(result.chapterFilePath, null, "未设 productionFlow 不得写章节文件");
      assert.equal(
        result.stageResults?.commitAndSave?.reason,
        "production_raw_commit_forbidden",
        "commit 跳过原因必须是 production_raw_commit_forbidden",
      );
      assert.equal(result.text, HIGH_QUALITY_RAW, "交付正文应是 raw，不是 agentic_raw");
      assert.notEqual(result.text, agenticText, "交付正文不得是 agentic_raw");
    } finally {
      rmSync(input.projectRoot, { recursive: true, force: true });
    }
  });
});
