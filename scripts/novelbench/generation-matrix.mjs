#!/usr/bin/env node
/**
 * NB-4 Generation Matrix B0-B4 CLI
 *
 * 读取 NovelBench continuation-cases，对每个 case 执行五层能力叠加生成
 * （B0 直接基线 → B1 上下文增强 → B2 意图增强 → B3 编辑改写 → B4 Judge 裁判），
 * 每层输出永久保留到 generation-matrix/<caseId>/，result.json 含完整 trace。
 *
 * 用法：
 *   node scripts/novelbench/generation-matrix.mjs [options]
 *
 * 选项：
 *   --cases <FILE>     continuation-cases JSONL 路径（默认 data/novelbench/datasets/continuation-cases.jsonl）
 *   --inputs <DIR>     generation-inputs 目录（默认 data/novelbench/datasets/generation-inputs/）
 *   --out <DIR>        输出目录（默认 data/novelbench/generation-matrix/）
 *   --model glm|doubao 选择模型（默认 doubao；决定 B0-B4 路由）
 *   --limit N          只处理前 N 个 case（默认全部）
 *   --seed N           随机种子（B4 匿名映射，可复现；默认 0）
 *   --timeout <MS>     单次模型调用超时（默认 600000）
 *   --words N          目标字数（默认 2500）
 *   --skip-existing    跳过已有 result.json 的 case（断点续跑）
 *   --help             显示帮助
 *
 * 环境变量（必须）：
  PINOVEL_BENCHMARK_COST_PROFILE=package_screening  强制 GLM/Doubao 路由隔离
  PINOVEL_DISABLE_FALLBACK=1                        禁用 fallback（失败即失败）
  GLM_API_KEY / ARK_API_KEY                         模型 API key（GLM 和 Doubao 共用 Volces ARK key）
 *
 * 产物：
 *   <out>/<caseId>/B0.md ... B4.md    五层正文（含失败层的空文件）
 *   <out>/<caseId>/result.json        完整 GenerationMatrixResult（含 trace）
 *   <out>/manifest.jsonl              所有 case 的结果索引
 *   <out>/summary.json                聚合统计
 *
 * 规则：
 * - generator 进程：只读 generation-inputs/<caseId>.txt（prefix），不访问 reference
 * - B3/B4 失败回退前层，raw 输出永久保留
 * - 同模型/同 case/同 seed 对比，证明能力层叠加的边际贡献
 */

import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(__filename, "..", "..", "..");
const EXTENSION_ROOT = join(PROJECT_ROOT, ".pi", "extensions", "novel-studio");
const DIST_EVAL_ROOT = join(EXTENSION_ROOT, "dist-eval");

const { values } = parseArgs({
  options: {
    cases: { type: "string" },
    inputs: { type: "string" },
    out: { type: "string" },
    model: { type: "string", default: "doubao" },
    limit: { type: "string" },
    seed: { type: "string", default: "0" },
    timeout: { type: "string", default: "600000" },
    words: { type: "string", default: "2500" },
    characters: { type: "string" },
    "skip-existing": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  process.stdout.write(`NB-4 Generation Matrix B0-B4 CLI

用法：
  node scripts/novelbench/generation-matrix.mjs [options]

选项：
  --cases <FILE>        continuation-cases JSONL 路径（默认 data/novelbench/datasets/continuation-cases.jsonl）
  --inputs <DIR>        generation-inputs 目录（默认 data/novelbench/datasets/generation-inputs/）
  --out <DIR>           输出目录（默认 data/novelbench/generation-matrix/）
  --model glm|doubao    选择模型（默认 doubao；决定 B0-B4 路由）
  --limit N             只处理前 N 个 case（默认全部）
  --seed N              随机种子（B4 匿名映射，可复现；默认 0）
  --timeout <MS>        单次模型调用超时（默认 600000）
  --words N             目标字数（默认 2500）
  --characters <FILE>   角色名映射 JSON（caseId → string[]），传入 StoryPreservationGate
  --skip-existing       跳过已有 result.json 的 case（断点续跑）
  --help                显示帮助

环境变量（必须）：
  PINOVEL_BENCHMARK_COST_PROFILE=package_screening
  PINOVEL_DISABLE_FALLBACK=1
  GLM_API_KEY / DOUBAO_API_KEY

产物：
  <out>/<caseId>/B0.md ... B4.md    五层正文
  <out>/<caseId>/result.json        完整结果 + trace
  <out>/manifest.jsonl              结果索引
  <out>/summary.json                聚合统计
`);
  process.exit(0);
}

// ── 参数解析 ────────────────────────────────────────────────────────────────

const casesPath = resolve(
  PROJECT_ROOT,
  values.cases || "data/novelbench/datasets/continuation-cases.jsonl",
);
const inputsDir = resolve(
  PROJECT_ROOT,
  values.inputs || "data/novelbench/datasets/generation-inputs/",
);
const outDir = resolve(PROJECT_ROOT, values.out || "data/novelbench/generation-matrix/");
const model = values.model === "glm" ? "glm" : "doubao";
const limit = values.limit ? Number.parseInt(values.limit, 10) : undefined;
const seed = Number.parseInt(values.seed, 10) || 0;
const timeoutMs = Number.parseInt(values.timeout, 10) || 600000;
const targetWordCount = Number.parseInt(values.words, 10) || 2500;
const skipExisting = values["skip-existing"];

// DEMO-3-R2.4：可选的角色名映射表（caseId → string[]），传入 StoryPreservationGate 的 knownEntities
// 文件格式：{ "<caseId>": ["角色1", "角色2", ...], ... }
let charactersByCaseId = {};
if (values.characters) {
  const charactersPath = resolve(PROJECT_ROOT, values.characters);
  if (!existsSync(charactersPath)) {
    process.stderr.write(`错误：--characters 文件不存在：${charactersPath}\n`);
    process.exit(1);
  }
  try {
    charactersByCaseId = JSON.parse(readFileSync(charactersPath, "utf-8"));
    const caseCount = Object.keys(charactersByCaseId).length;
    process.stderr.write(`[NB-4] 角色名映射已加载：${charactersPath}（${caseCount} cases）\n`);
  } catch (err) {
    process.stderr.write(`错误：--characters 文件解析失败：${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
  process.stderr.write(`错误：--limit 必须为正整数\n`);
  process.exit(1);
}

// ── 环境守卫 ────────────────────────────────────────────────────────────────

const profile = process.env.PINOVEL_BENCHMARK_COST_PROFILE;
if (profile !== "package_screening" && profile !== "production_validation") {
  process.stderr.write(
    `⚠️  PINOVEL_BENCHMARK_COST_PROFILE 未设置为 package_screening/production_validation。\n` +
    `   临时/批量测试必须设置 PINOVEL_BENCHMARK_COST_PROFILE=package_screening + PINOVEL_DISABLE_FALLBACK=1\n` +
    `   继续执行但无路由隔离守卫（不推荐）。\n\n`,
  );
}
if (process.env.PINOVEL_DISABLE_FALLBACK !== "1" && profile === "package_screening") {
  process.stderr.write(
    `⚠️  package_screening 模式建议同时设置 PINOVEL_DISABLE_FALLBACK=1 防止 fallback 污染。\n\n`,
  );
}

// ── 路由映射 ────────────────────────────────────────────────────────────────

const ROUTES_BY_MODEL = {
  glm: {
    b0: "nb4_generate_glm",
    b1: "nb4_generate_glm",
    b2: "nb4_generate_glm",
    b3: "nb4_generate_glm",
    b4: "nb4_judge_glm",
  },
  doubao: {
    b0: "nb4_generate_doubao",
    b1: "nb4_generate_doubao",
    b2: "nb4_generate_doubao",
    b3: "nb4_generate_doubao",
    b4: "nb4_judge_doubao",
  },
};
const routes = ROUTES_BY_MODEL[model];

// ── 加载模块 ────────────────────────────────────────────────────────────────

const novelbenchUrl = new URL(
  `file://${join(DIST_EVAL_ROOT, "novelbench", "index.js").replace(/\\/g, "/")}`,
).href;
const { runGenerationMatrix, collectRuntimeProvenance } = await import(novelbenchUrl);

const adapterUrl = new URL(
  `file://${join(DIST_EVAL_ROOT, "v2", "adapters", "legacy-model-route-adapter.js").replace(/\\/g, "/")}`,
).href;
const { createLegacyModelGenerateFn } = await import(adapterUrl);

// ── DEMO-3-R2.5：运行时代码 provenance 采集 ──────────────────────────────────
// runtimeFilePaths 覆盖生成实际依赖的 R2.4 源码 + 编译产物 + CLI 脚本。
// 这些文件的 hash 证明运行的实际代码版本，不仅依赖 Git HEAD。
// 若 dirty worktree 参与运行，这里记录的 hash 含未提交修改。
const RUNTIME_FILE_PATHS = [
  // CLI 脚本
  "scripts/novelbench/generation-matrix.mjs",
  // R2.4/R2.5 源码（novelbench）
  ".pi/extensions/novel-studio/novelbench/eval-pipeline-adapter.ts",
  ".pi/extensions/novel-studio/novelbench/generation-matrix-runner.ts",
  ".pi/extensions/novel-studio/novelbench/runtime-provenance-collector.ts",
  // R2.4 源码（v2/core）
  ".pi/extensions/novel-studio/v2/core/editorial-story-preservation-gate.ts",
  ".pi/extensions/novel-studio/v2/core/replay-provenance-guard.ts",
  ".pi/extensions/novel-studio/v2/core/unified-entry.ts",
  ".pi/extensions/novel-studio/v2/core/unified-orchestrator.ts",
  // 编译产物（实际运行的文件）
  ".pi/extensions/novel-studio/dist-eval/novelbench/index.js",
  ".pi/extensions/novel-studio/dist-eval/novelbench/generation-matrix-runner.js",
  ".pi/extensions/novel-studio/dist-eval/novelbench/eval-pipeline-adapter.js",
  ".pi/extensions/novel-studio/dist-eval/novelbench/runtime-provenance-collector.js",
  ".pi/extensions/novel-studio/dist-eval/v2/core/unified-entry.js",
  ".pi/extensions/novel-studio/dist-eval/v2/core/unified-orchestrator.js",
  ".pi/extensions/novel-studio/dist-eval/v2/core/editorial-story-preservation-gate.js",
  // replay-provenance-guard 被 tsconfig.eval.json 编译到 dist-eval/（validate-r3/r4.mjs 从 dist-eval/ import）。
  ".pi/extensions/novel-studio/dist-eval/v2/core/replay-provenance-guard.js",
  ".pi/extensions/novel-studio/dist-eval/v2/adapters/legacy-model-route-adapter.js",
];

// buildArtifactPaths：编译产物入口点，证明构建可复现
const BUILD_ARTIFACT_PATHS = [
  ".pi/extensions/novel-studio/dist-eval/novelbench/index.js",
];

// 模型版本映射
const MODEL_VERSIONS = {
  glm: "glm-5.2",
  doubao: "doubao-seed-2-1-pro-260628",
};

const runtimeProvenance = collectRuntimeProvenance({
  projectRoot: PROJECT_ROOT,
  model,
  modelVersion: MODEL_VERSIONS[model] ?? "unknown",
  seed,
  costProfile: process.env.PINOVEL_BENCHMARK_COST_PROFILE ?? "",
  envSwitchNames: [
    "PINOVEL_BENCHMARK_COST_PROFILE",
    "PINOVEL_DISABLE_FALLBACK",
    "GLM_API_KEY",
    "ARK_API_KEY",
    "DOUBAO_API_KEY",
  ],
  runtimeFilePaths: RUNTIME_FILE_PATHS,
  buildArtifactPaths: BUILD_ARTIFACT_PATHS,
});

process.stderr.write(
  `[NB-4] runtime provenance: commit=${runtimeProvenance.codeCommit.slice(0, 12)}, ` +
    `dirty=${runtimeProvenance.worktreeDirty}, ` +
    `runtimeFilesHash=${runtimeProvenance.runtimeFilesHash.slice(0, 16)}…, ` +
    `buildArtifactHash=${runtimeProvenance.buildArtifactHash.slice(0, 16)}…\n`,
);


// ── 加载 cases ──────────────────────────────────────────────────────────────

if (!existsSync(casesPath)) {
  process.stderr.write(
    `错误：cases 文件不存在：${casesPath}\n请先运行 build-datasets.mjs\n`,
  );
  process.exit(1);
}

const caseLines = readFileSync(casesPath, "utf-8")
  .split("\n")
  .filter((l) => l.trim());
const allCases = caseLines.map((l) => JSON.parse(l));
const effectiveCases = limit ? allCases.slice(0, limit) : allCases;

process.stderr.write(
  `[NB-4] ${effectiveCases.length} cases，model=${model}，seed=${seed}，` +
    `timeout=${timeoutMs}ms，words=${targetWordCount}\n`,
);
process.stderr.write(`[NB-4] 路由：B0-B3=${routes.b0}，B4=${routes.b4}\n`);
process.stderr.write(`[NB-4] 输入目录：${inputsDir}\n`);
process.stderr.write(`[NB-4] 输出目录：${outDir}\n\n`);

mkdirSync(outDir, { recursive: true });

// ── 模型调用函数 ────────────────────────────────────────────────────────────

const modelGenerate = createLegacyModelGenerateFn();

// ── 主循环 ──────────────────────────────────────────────────────────────────

const stats = {
  total: effectiveCases.length,
  succeeded: 0,
  failed: 0,
  skipped: 0,
  noInput: 0,
  layerSuccess: { B0: 0, B1: 0, B2: 0, B3: 0, B4: 0 },
  fallbackCount: { B3: 0, B4: 0 },
  judgeWinner: { B2: 0, B3: 0 },
  failures: [],
};

const manifestLines = [];
const manifestPath = join(outDir, "manifest.jsonl");

for (let idx = 0; idx < effectiveCases.length; idx++) {
  const c = effectiveCases[idx];
  const caseId = c.caseId;

  if (!caseId) {
    stats.skipped++;
    stats.failures.push(`(idx ${idx}): 缺少 caseId`);
    continue;
  }

  // 断点续跑
  const caseOutDir = join(outDir, caseId);
  const resultPath = join(caseOutDir, "result.json");
  if (skipExisting && existsSync(resultPath)) {
    stats.skipped++;
    process.stderr.write(`[NB-4] [${idx + 1}/${effectiveCases.length}] ↷ ${caseId} (已存在，跳过)\n`);
    continue;
  }

  // 读 prefix（generation-input）
  const inputPath = join(inputsDir, `${caseId}.txt`);
  if (!existsSync(inputPath)) {
    stats.noInput++;
    stats.failures.push(`${caseId}: generation-input 不存在（${inputPath}）`);
    process.stderr.write(
      `[NB-4] [${idx + 1}/${effectiveCases.length}] ⊘ ${caseId}: 无 generation-input，跳过\n`,
    );
    continue;
  }
  const prefix = readFileSync(inputPath, "utf-8");

  // 构造 GeneratorCase（sanitized，generator 进程可见）
  const generatorCase = {
    caseId,
    bookId: c.bookId,
    authorId: c.authorId,
    genre: c.genre,
    mode: c.mode || "continuation",
    targetChapter: c.targetChapter,
    generationInputPath: `${caseId}.txt`,
    generationInputHash: "",
    split: c.split || "test",
    referenceLocator: c.referenceLocator,
    splitConfidence: c.splitConfidence ?? 0,
  };

  process.stderr.write(
    `[NB-4] [${idx + 1}/${effectiveCases.length}] ▶ ${caseId} (${c.genre}, ch${c.targetChapter})\n`,
  );

  try {
    // DEMO-3-R2.4：传入已知角色名，使 StoryPreservationGate 的 knownEntities 非空
    const characterNames = charactersByCaseId[caseId] ?? [];
    if (characterNames.length > 0) {
      process.stderr.write(`[NB-4]   角色名：${characterNames.length} 个（传入 StoryPreservationGate）\n`);
    } else {
      process.stderr.write(`[NB-4]   ⚠ 角色名为空（StoryPreservationGate 将返回 unverifiable）\n`);
    }
    const result = await runGenerationMatrix({
      case: generatorCase,
      prefix,
      modelGenerate,
      routes,
      seed,
      timeoutMs,
      targetWordCount,
      characterNames,
      runtimeProvenance,
    });

    // 落盘：五层正文 + result.json
    mkdirSync(caseOutDir, { recursive: true });
    for (const layerName of ["B0", "B1", "B2", "B3", "B4"]) {
      const layer = result.layers[layerName];
      const layerPath = join(caseOutDir, `${layerName}.md`);
      const header = [
        `<!-- layer: ${layerName} -->`,
        `<!-- caseId: ${caseId} -->`,
        `<!-- model: ${layer.model} -->`,
        `<!-- route: ${layer.route} -->`,
        `<!-- durationMs: ${layer.durationMs} -->`,
        `<!-- success: ${layer.success} -->`,
        layer.fallbackFrom ? `<!-- fallbackFrom: ${layer.fallbackFrom} -->` : null,
        layer.fallbackReason ? `<!-- fallbackReason: ${layer.fallbackReason} -->` : null,
        ``,
      ].filter(Boolean).join("\n");
      writeFileSync(layerPath, header + layer.text + "\n", "utf-8");
    }

    // DEMO-3-R2.4：落盘 B4 完整候选产物到 b4-artifacts/ 目录
    // result.json 只引用路径/hash，完整正文保存到独立文件，provenance 守卫据此校验。
    const b4Artifacts = result.layers.B4?.b4Artifacts;
    if (b4Artifacts) {
      const artifactsDir = join(caseOutDir, "b4-artifacts");
      mkdirSync(artifactsDir, { recursive: true });

      // run.json：含 orchestratorRunId 和所有候选文件元数据（路径+hash，不含正文）
      const runMeta = {
        orchestratorRunId: b4Artifacts.orchestratorRunId,
        caseId: b4Artifacts.caseId,
        layer: b4Artifacts.layer,
        generatedAt: b4Artifacts.generatedAt,
        rawCandidate: {
          candidateId: b4Artifacts.rawCandidate.candidateId,
          candidateKind: b4Artifacts.rawCandidate.candidateKind,
          rawCandidateId: b4Artifacts.rawCandidate.rawCandidateId,
          sourcePath: `b4-artifacts/raw-${b4Artifacts.rawCandidate.candidateId.replace(/[:/\\]/g, "_")}.md`,
          contentHash: b4Artifacts.rawCandidate.contentHash,
          textLength: b4Artifacts.rawCandidate.textLength,
          hypothesisId: b4Artifacts.rawCandidate.hypothesisId ?? null,
          editorialStrategy: b4Artifacts.rawCandidate.editorialStrategy ?? null,
        },
        editorialCandidates: b4Artifacts.editorialCandidates.map((c) => ({
          candidateId: c.candidateId,
          candidateKind: c.candidateKind,
          rawCandidateId: c.rawCandidateId,
          sourcePath: `b4-artifacts/editorial-${c.candidateId.replace(/[:/\\]/g, "_")}.md`,
          contentHash: c.contentHash,
          textLength: c.textLength,
          hypothesisId: c.hypothesisId ?? null,
          editorialStrategy: c.editorialStrategy ?? null,
        })),
        hypotheses: b4Artifacts.hypotheses,
        editorialFactGuard: b4Artifacts.editorialFactGuard,
        judgeArbitration: b4Artifacts.judgeArbitration,
        allArbitrationResults: b4Artifacts.allArbitrationResults,
        selectedCandidateId: b4Artifacts.selectedCandidateId,
        selectedSource: b4Artifacts.selectedSource,
        finalSource: b4Artifacts.finalSource,
        fallbacked: b4Artifacts.fallbacked,
        outcomeType: b4Artifacts.outcomeType,
        warnings: b4Artifacts.warnings,
        // DEMO-3-R2.5：运行时代码 provenance（code/build/env 指纹）
        runtimeProvenance: b4Artifacts.runtimeProvenance ?? null,
      };
      writeFileSync(
        join(artifactsDir, "run.json"),
        JSON.stringify(runMeta, null, 2) + "\n",
        "utf-8",
      );

      // raw-{candidateId}.md：raw 候选完整正文
      // 注意：不加 trailing "\n"——contentHash 基于 text 原文计算，provenance 守卫
      // 从磁盘读取整个文件内容后重算 SHA-256，文件内容必须与 hash 计算时的文本完全一致。
      const rawFileName = `raw-${b4Artifacts.rawCandidate.candidateId.replace(/[:/\\]/g, "_")}.md`;
      writeFileSync(
        join(artifactsDir, rawFileName),
        b4Artifacts.rawCandidate.text,
        "utf-8",
      );

      // editorial-{candidateId}.md：每个 editorial 候选完整正文（同上，不加 trailing "\n"）
      for (const edCand of b4Artifacts.editorialCandidates) {
        const edFileName = `editorial-${edCand.candidateId.replace(/[:/\\]/g, "_")}.md`;
        writeFileSync(
          join(artifactsDir, edFileName),
          edCand.text,
          "utf-8",
        );
      }

      // story-preservation.json：StoryPreservationGate 完整报告
      writeFileSync(
        join(artifactsDir, "story-preservation.json"),
        JSON.stringify(b4Artifacts.editorialStoryPreservation, null, 2) + "\n",
        "utf-8",
      );

      process.stderr.write(
        `[NB-4]   b4-artifacts: ${b4Artifacts.editorialCandidates.length} editorial + 1 raw, ` +
          `runId=${b4Artifacts.orchestratorRunId.slice(0, 16)}…\n`,
      );
    }

    writeFileSync(resultPath, JSON.stringify(result, null, 2) + "\n", "utf-8");

    // 统计
    stats.succeeded++;
    for (const ln of ["B0", "B1", "B2", "B3", "B4"]) {
      if (result.layers[ln].success) stats.layerSuccess[ln]++;
      if (result.layers[ln].fallbackFrom) stats.fallbackCount[ln]++;
    }
    stats.judgeWinner[result.judgeDecision.winner]++;

    // manifest 行
    manifestLines.push(JSON.stringify({
      caseId,
      model,
      seed,
      finalSource: result.finalSource,
      finalTextLength: result.finalText.length,
      layerSuccess: {
        B0: result.layers.B0.success,
        B1: result.layers.B1.success,
        B2: result.layers.B2.success,
        B3: result.layers.B3.success,
        B4: result.layers.B4.success,
      },
      fallback: {
        B3: result.layers.B3.fallbackFrom || null,
        B4: result.layers.B4.fallbackFrom || null,
      },
      judgeWinner: result.judgeDecision.winner,
      judgeFallbacked: result.judgeDecision.fallbacked,
      totalDurationMs: result.totalDurationMs,
      totalModelCalls: result.totalModelCalls,
    }));
    // 增量写 manifest（防中断丢失）
    writeFileSync(manifestPath, manifestLines.join("\n") + "\n", "utf-8");

    process.stderr.write(
      `[NB-4] ✓ ${caseId}: winner=${result.finalSource} ` +
        `(${result.finalText.length}字) calls=${result.totalModelCalls} ` +
        `${result.totalDurationMs}ms\n`,
    );
  } catch (err) {
    stats.failed++;
    stats.failures.push(`${caseId}: ${err?.message || String(err)}`);
    process.stderr.write(`[NB-4] ✗ ${caseId}: ${err?.message || err}\n`);
    // 失败也记录 manifest
    manifestLines.push(JSON.stringify({
      caseId,
      model,
      seed,
      error: err?.message || String(err),
    }));
    writeFileSync(manifestPath, manifestLines.join("\n") + "\n", "utf-8");
  }
}

// ── 聚合统计 ────────────────────────────────────────────────────────────────

const summary = {
  model,
  seed,
  targetWordCount,
  timeoutMs,
  totalCases: stats.total,
  succeeded: stats.succeeded,
  failed: stats.failed,
  skipped: stats.skipped,
  noInput: stats.noInput,
  layerSuccessRate: {
    B0: stats.total > 0 ? stats.layerSuccess.B0 / stats.total : 0,
    B1: stats.total > 0 ? stats.layerSuccess.B1 / stats.total : 0,
    B2: stats.total > 0 ? stats.layerSuccess.B2 / stats.total : 0,
    B3: stats.total > 0 ? stats.layerSuccess.B3 / stats.total : 0,
    B4: stats.total > 0 ? stats.layerSuccess.B4 / stats.total : 0,
  },
  fallbackRate: {
    B3: stats.succeeded > 0 ? stats.fallbackCount.B3 / stats.succeeded : 0,
    B4: stats.succeeded > 0 ? stats.fallbackCount.B4 / stats.succeeded : 0,
  },
  judgeDistribution: {
    B2: stats.judgeWinner.B2,
    B3: stats.judgeWinner.B3,
    B2Rate: stats.succeeded > 0 ? stats.judgeWinner.B2 / stats.succeeded : 0,
    B3Rate: stats.succeeded > 0 ? stats.judgeWinner.B3 / stats.succeeded : 0,
  },
  failures: stats.failures.slice(0, 20),
  generatedAt: new Date().toISOString(),
};
writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf-8");

process.stderr.write(
  `\n[NB-4] 完成：${stats.succeeded}/${stats.total} 成功，${stats.failed} 失败，` +
    `${stats.skipped} 跳过，${stats.noInput} 无输入\n`,
);
process.stderr.write(
  `[NB-4] 各层成功率：B0=${stats.layerSuccess.B0}/${stats.total} ` +
    `B1=${stats.layerSuccess.B1}/${stats.total} ` +
    `B2=${stats.layerSuccess.B2}/${stats.total} ` +
    `B3=${stats.layerSuccess.B3}/${stats.total} ` +
    `B4=${stats.layerSuccess.B4}/${stats.total}\n`,
);
process.stderr.write(
  `[NB-4] Judge 分布：B2 胜=${stats.judgeWinner.B2}，B3 胜=${stats.judgeWinner.B3}\n`,
);
if (stats.failures.length > 0) {
  process.stderr.write(`[NB-4] 失败明细（前 10 条）：\n`);
  for (const f of stats.failures.slice(0, 10)) {
    process.stderr.write(`  - ${f}\n`);
  }
}

if (stats.noInput > 0 && stats.succeeded === 0) {
  process.stderr.write(
    `\n⚠️  所有 case 都缺少 generation-input。请先运行：\n` +
      `  node scripts/novelbench/build-datasets.mjs --corpus <语料根> --out data/novelbench/datasets\n` +
      `以生成 generation-inputs/<caseId>.txt 前文文件。\n`,
  );
}

if (stats.failed > 0 && stats.succeeded === 0) {
  process.exit(1);
}
