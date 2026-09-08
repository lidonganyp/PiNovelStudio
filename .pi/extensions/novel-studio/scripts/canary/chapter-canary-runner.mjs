/**
 * chapter-canary-runner — Phase 5A Canary 批量章节生成 + 指标收集
 *
 * 用法（默认 stub 模式，不调用真实模型）:
 *   node scripts/canary/chapter-canary-runner.mjs --workspace xinmo --start 17 --end 19 --seed 1
 *
 * 真实模型模式（需 .env 配置 Sub2API 网关 + API key）:
 *   node scripts/canary/chapter-canary-runner.mjs --workspace xinmo --start 17 --end 19 --real-model --seed 1
 *
 * 多 workspace 多 seed:
 *   node scripts/canary/chapter-canary-runner.mjs \
 *     --workspace xinmo --workspace fuben \
 *     --start 1 --end 10 \
 *     --seeds 1,42,100
 *
 * 输出（写入 d:/CODE/PiNovelStudio/reports/chapter-canary/{runId}/）:
 *   - per-chapter/{ws}-ch{N}-seed{S}.json     — 单章归一化结果（CanaryChapterResult）
 *   - per-chapter/{ws}-ch{N}-seed{S}-trace.json — trace 副本（避免被覆盖）
 *   - results.json                              — 全部 CanaryChapterResult[]
 *   - metrics.json                              — CanaryMetrics
 *   - report.md                                 — Markdown 仪表盘报告
 *   - anonymized-results.json                   — 去标识化结果（供分享）
 *   - blind-eval-pairs.json                     — raw vs final 盲评对照对
 *   - run-metadata.json                         — 运行元信息
 *
 * 不在代码改动轮宣称小说质量提升；canary 结果单独回报。
 */

import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  copyFileSync,
  statSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import {
  normalizeChapterResult,
  computeCanaryMetrics,
  anonymizeChapterResult,
  buildBlindEvalPairs,
  generateCanaryReport,
  SINGLE_CHAPTER_HARD_BUDGET,
} from "./canary-metrics.mjs";

// Phase 5.1：Bounded-canary 完成态 trace 适配器。
// 把真实运行结果（CanaryChapterResult[] + toolMode）适配为可被
// `evolution-cli canary --complete` 消费的完成态 CanaryRunTrace，
// 补齐 toolMode / 模型指纹 / 失败指标三项证据。
import { buildCompletionTrace } from "./completion-trace-adapter.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCRIPT_DIR = __dirname;
const EXT_ROOT = resolve(SCRIPT_DIR, "..", "..");
const REPO_ROOT = resolve(EXT_ROOT, "..", "..", "..");
const REPORT_DIR = join(REPO_ROOT, "reports", "chapter-canary");

// ============================================================================
// CLI 解析
// ============================================================================

function parseArgs(argv) {
  const args = {
    workspaces: [],
    start: 1,
    end: 5,
    seeds: [1],
    realModel: false,
    writerModel: undefined,         // "claude" | "gpt6astra" | undefined（默认 → gpt-6-astra）
    candidateTimeoutMs: 600000,
    stopOnFailure: false,
    recoverBlockedRaw: false,
    outputDir: null,
    jobId: null,
    // Phase 5.1 bounded-canary：受控接入工具模式与完成态 trace 绑定证据。
    toolMode: "auto",          // "auto" | "standard" | "facade"
    releaseId: null,
    sourceRunId: null,
    authorizationId: null,
    environmentFingerprint: null,
    approvalRef: null,
    changeClass: "R2",
    strategy: "bounded_canary",
    complete: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith("--")) continue;
    const next = argv[i + 1];
    switch (tok) {
      case "--workspace":
        args.workspaces.push(next);
        i++;
        break;
      case "--start":
        args.start = parseInt(next, 10);
        i++;
        break;
      case "--end":
        args.end = parseInt(next, 10);
        i++;
        break;
      case "--seed":
        args.seeds = [parseInt(next, 10)];
        i++;
        break;
      case "--seeds":
        args.seeds = next.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
        i++;
        break;
      case "--real-model":
        args.realModel = true;
        break;
      case "--stub":
        args.realModel = false;
        break;
      case "--writer-model":
        args.writerModel = next;
        i++;
        break;
      case "--candidate-timeout-ms":
        args.candidateTimeoutMs = parseInt(next, 10);
        i++;
        break;
      case "--stop-on-failure":
        args.stopOnFailure = true;
        break;
      case "--recover-blocked-raw":
        args.recoverBlockedRaw = true;
        break;
      case "--output-dir":
        args.outputDir = next;
        i++;
        break;
      case "--job-id":
        args.jobId = next;
        i++;
        break;
      // Phase 5.1 bounded-canary 标志
      case "--tool-mode":
        args.toolMode = next;
        i++;
        break;
      case "--release-id":
        args.releaseId = next;
        i++;
        break;
      case "--source-run-id":
        args.sourceRunId = next;
        i++;
        break;
      case "--authorization-id":
        args.authorizationId = next;
        i++;
        break;
      case "--environment-fingerprint":
        args.environmentFingerprint = next;
        i++;
        break;
      case "--approval-ref":
        args.approvalRef = next;
        i++;
        break;
      case "--change-class":
        args.changeClass = next;
        i++;
        break;
      case "--strategy":
        args.strategy = next;
        i++;
        break;
      case "--complete":
        args.complete = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
    }
  }
  if (args.workspaces.length === 0) {
    args.workspaces = ["xinmo"];
  }
  if (args.end < args.start) {
    args.end = args.start;
  }
  if (!["auto", "standard", "facade"].includes(args.toolMode)) {
    throw new Error(`--tool-mode 非法：${args.toolMode}（仅允许 auto|standard|facade）`);
  }
  if (!["bounded_canary", "shadow_required"].includes(args.strategy)) {
    throw new Error(`--strategy 非法：${args.strategy}（仅允许 bounded_canary|shadow_required）`);
  }
  if (!["R1", "R2", "R3"].includes(args.changeClass)) {
    throw new Error(`--change-class 非法：${args.changeClass}（仅允许 R1|R2|R3）`);
  }
  return args;
}

function printHelp() {
  process.stdout.write(`Phase 5 Canary Runner — 批量章节生成 + 指标收集

用法:
  node scripts/canary/chapter-canary-runner.mjs [options]

选项:
  --workspace <id>            workspace id（可重复指定多 workspace；默认 xinmo）
  --start <n>                 起始章节号（默认 1）
  --end <n>                   结束章节号（默认 5）
  --seed <n>                  单个 Thompson/judge 复现种子（默认 1）
  --seeds <a,b,c>             多个种子（每个 workspace × 章节 × seed 全组合）
  --real-model                启用真实模型调用（默认 stub 模式）
  --stub                      强制 stub 模式（默认）
  --writer-model <id>         "claude" | "gpt6astra"（默认 undefined → gpt-6-astra）
  --candidate-timeout-ms <n>  单候选超时（默认 600000）
  --stop-on-failure           首章失败即终止（默认 false）
  --recover-blocked-raw       启用 blocked raw 恢复路径（默认 false）
  --output-dir <path>         自定义输出目录（默认 reports/chapter-canary/{runId}）
  --job-id <id>               自定义 runId（默认 canary-YYYYMMDD-HHMMSS）
  --help, -h                  显示本帮助

Phase 5.1 bounded-canary 选项（受控接入）:
  --tool-mode <mode>          "auto" | "standard" | "facade"（默认 auto）
                              auto：按 workspace canary 授权解析（facade 授权才启用）
                              facade：强制受控 under facade（fail-closed，未授权即拒绝运行）
                              standard：强制 9 专用工具（非全量切换）
  --release-id <id>           目标 release ID（--complete 用）
  --source-run-id <id>        先前 canary_started/shadow trace runId（--complete 绑定）
  --authorization-id <id>     workspace canary 授权 ID（--complete 绑定校验）
  --environment-fingerprint   release 环境指纹（--complete 绑定）
  --approval-ref <ref>        审批 artifact 引用（--complete 绑定）
  --change-class <cls>        R1|R2|R3（默认 R2）
  --strategy <s>              bounded_canary|shadow_required（默认 bounded_canary）
  --complete                  产出 completion-trace.json（补齐 toolMode/模型指纹/失败指标证据）

示例:
  # stub 模式快速验证（不调用真实模型）
  node scripts/canary/chapter-canary-runner.mjs --workspace xinmo --start 17 --end 19 --seed 1

  # 隔离 workspace bounded canary（facade 受控，产出完成态 trace）
  node scripts/canary/chapter-canary-runner.mjs \\
    --workspace <ws> --start 1 --end 2 --seed 1 \\
    --tool-mode facade --complete --release-id rel-1 --source-run-id shadow-1 --authorization-id auth-1

  # 真实模型 20-30 章 canary
  node scripts/canary/chapter-canary-runner.mjs \\
    --workspace xinmo --start 17 --end 36 \\
    --seeds 1,42 --real-model --candidate-timeout-ms 600000

输出:
  reports/chapter-canary/{runId}/
    ├── per-chapter/{ws}-ch{N}-seed{S}.json
    ├── per-chapter/{ws}-ch{N}-seed{S}-trace.json
    ├── results.json
    ├── metrics.json
    ├── report.md
    ├── anonymized-results.json
    ├── blind-eval-pairs.json
    ├── run-metadata.json
    └── completion-trace.json           （--complete 时产出）
`);
}

// ============================================================================
// 主流程
// ============================================================================

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // 环境检查
  if (args.realModel) {
    if (!process.env.V2_FORCE_STUB) {
      // 真实模型模式不设 V2_FORCE_STUB
    } else {
      process.stderr.write(`[Canary] --real-model 与 V2_FORCE_STUB=1 冲突，请清除环境变量后重试\n`);
      process.exit(2);
    }
  } else {
    // stub 模式：强制设置 V2_FORCE_STUB=1（避免误调用真实模型）
    process.env.V2_FORCE_STUB = "1";
  }

  // 生成 runId
  const runId = args.jobId || `canary-${new Date().toISOString().replace(/[:.]/g, "").slice(0, 15)}`;
  const outputDir = args.outputDir || join(REPORT_DIR, runId);
  const perChapterDir = join(outputDir, "per-chapter");
  mkdirSync(perChapterDir, { recursive: true });
  // Phase 5.1：bounded-canary 授权解析需要项目根目录。
  args.projectRoot = REPO_ROOT;

  // 收集 git HEAD
  let gitHead = null;
  try {
    const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf-8" });
    if (result.status === 0) {
      gitHead = result.stdout.trim();
    }
  } catch {
    // 忽略
  }

  // P0 第七轮 P1 修复：收集工作树内容哈希，证明 canary 运行的确切工作树状态。
  //
  // 用户验收（第七轮）P1 反例：上一轮 canary 记录 gitHead=54b0d8b，但当前提交是 3405dde，
  // 且运行发生在提交前、脏工作树中，没有记录工作树内容哈希。因此只能证明某个临时工作树
  // 运行成功，不能证明当前提交可复现通过。
  //
  // 本修复记录三项工作树指纹：
  //   - worktreeDirty: 是否有未提交改动（git status --porcelain 非空）
  //   - worktreeStatusHash: git status --porcelain 输出的 SHA-256（标识改动文件清单）
  //   - worktreeDiffHash: git diff（含暂存与未暂存）的 SHA-256（标识改动内容）
  //
  // 复现条件：相同 gitHead + 相同 worktreeDiffHash 即可证明工作树完全一致。
  // 若 worktreeDirty=true，gitHead 单独不足以证明复现性，必须配合 worktreeDiffHash。
  let worktreeDirty = false;
  let worktreeStatusHash = null;
  let worktreeDiffHash = null;
  let worktreeStatusPreview = null;
  try {
    const statusResult = spawnSync("git", ["status", "--porcelain"], { cwd: REPO_ROOT, encoding: "utf-8" });
    if (statusResult.status === 0) {
      const statusText = statusResult.stdout;
      worktreeDirty = statusText.trim().length > 0;
      worktreeStatusHash = createHash("sha256").update(statusText).digest("hex");
      // 保留前 20 行预览（截断，避免元信息过大）
      const statusLines = statusText.split(/\r?\n/).filter((l) => l.length > 0);
      worktreeStatusPreview = statusLines.slice(0, 20).join("\n") + (statusLines.length > 20 ? `\n... (${statusLines.length - 20} more)` : "");
    }
    // 收集暂存 + 未暂存 diff（不包含二进制内容，只做指纹）
    const diffResult = spawnSync("git", ["diff", "HEAD"], { cwd: REPO_ROOT, encoding: "utf-8" });
    if (diffResult.status === 0) {
      worktreeDiffHash = createHash("sha256").update(diffResult.stdout).digest("hex");
    }
  } catch {
    // 忽略——非 git 环境或 git 不可用
  }

  const startedAt = new Date().toISOString();
  console.log(`[Canary] Run ID: ${runId}`);
  console.log(`[Canary] Output: ${outputDir}`);
  console.log(`[Canary] Workspaces: ${args.workspaces.join(", ")}`);
  console.log(`[Canary] Chapters: ${args.start}-${args.end} × seeds ${args.seeds.join(",")}`);
  console.log(`[Canary] Real model: ${args.realModel}`);
  console.log(`[Canary] Git HEAD: ${gitHead ?? "unknown"}`);
  console.log(`[Canary] Worktree dirty: ${worktreeDirty} (diffHash=${worktreeDiffHash?.slice(0, 12) ?? "unknown"})`);
  console.log("");

  // 加载工具
  const extPath = join(EXT_ROOT, "dist", "index.js");
  if (!existsSync(extPath)) {
    process.stderr.write(`[Canary] dist/index.js 不存在，请先 npm run build\n`);
    process.exit(2);
  }

  const fakePi = {
    tools: new Map(),
    api: {
      registerTool(t) { fakePi.tools.set(t.name, t); },
      registerCommand() {},
      on() {},
    },
  };
  const novelStudioExtension = (await import(pathToFileURL(extPath).href)).default;
  novelStudioExtension(fakePi.api);
  const chapterTool = fakePi.tools.get("novel_generate_chapter");
  if (!chapterTool) {
    process.stderr.write(`[Canary] novel_generate_chapter 工具未注册\n`);
    process.exit(2);
  }

  // Phase 5.1 bounded-canary：
  // 动态加载生产闭包中的 fail-closed 授权解析器（与 unified-entry 同源），
  // 用于把请求的 toolMode 解析为实际暴露模式，并做 bounded 保证。
  // 解析器不可用（dist 未含该模块）时视为无法确认 facade 授权 → fail-closed 走 standard。
  let resolveToolModeFromCanaryAuthorization = null;
  try {
    const resolverMod = await import(
      pathToFileURL(
        resolve(EXT_ROOT, "dist/v2/governance/resolve-tool-mode-from-canary-authorization.js"),
      ).href,
    );
    resolveToolModeFromCanaryAuthorization =
      resolverMod.resolveToolModeFromCanaryAuthorization ?? null;
  } catch {
    resolveToolModeFromCanaryAuthorization = null;
  }

  // 解析每个 workspace 的有效 toolMode（fail-closed）。
  // 关键：--complete 是单 workspace bounded canary，强制单 workspace。
  if (args.complete && args.workspaces.length !== 1) {
    process.stderr.write(
      `[Canary] --complete 仅支持单 workspace bounded canary（当前 ${args.workspaces.length} 个）\n`,
    );
    process.exit(2);
  }
  /** @type {Record<string, "standard"|"facade">} */
  const effectiveToolModes = {};
  for (const workspaceId of args.workspaces) {
    effectiveToolModes[workspaceId] = resolveEffectiveToolMode(
      workspaceId,
      args.toolMode,
      args,
      resolveToolModeFromCanaryAuthorization,
    );
    console.log(
      `[Canary] toolMode(${workspaceId}) = ${effectiveToolModes[workspaceId]}${args.toolMode === "facade" ? "（bounded 受控，fail-closed 已确认授权）" : ""}`,
    );
  }

  // 运行所有 (workspace × chapter × seed) 组合
  /** @type {import("./canary-metrics.mjs").CanaryChapterResult[]} */
  const results = [];
  let skipped = 0;
  let total = 0;

  for (const workspaceId of args.workspaces) {
    // 校验 workspace 存在
    const workspacePath = join(REPO_ROOT, "workspaces", workspaceId);
    if (!existsSync(workspacePath)) {
      console.warn(`[Canary] ⚠️  workspace 不存在: ${workspacePath}，跳过`);
      continue;
    }

    for (const seed of args.seeds) {
      for (let ch = args.start; ch <= args.end; ch++) {
        total++;
        const label = `${workspaceId}/ch${ch}/seed${seed}`;
        console.log(`[Canary] [${total}] ${label}`);

        const started = Date.now();
        try {
          const result = await runSingleChapter({
            chapterTool,
            workspaceId,
            chapterNumber: ch,
            seed,
            writerModel: args.writerModel,
            candidateTimeoutMs: args.candidateTimeoutMs,
            recoverBlockedRaw: args.recoverBlockedRaw,
            realModel: args.realModel,
            workspacePath,
            projectRoot: REPO_ROOT,
          });
          const durationMs = Date.now() - started;
          // 回填实际耗时（normalizeChapterResult 内部无法测量）
          result.durationMs = durationMs;

          // 持久化 per-chapter 结果
          const resultFile = join(perChapterDir, `${workspaceId}-ch${ch}-seed${seed}.json`);
          writeFileSync(resultFile, JSON.stringify(result, null, 2), "utf8");

          // 复制 trace 副本（避免多次采样覆盖）
          // P1-2 修复：校验 trace 的 mtime 不早于本章开始时间，防止复制旧 trace
          // P1 第四轮修复：trace 复制失败不再静默吞掉，记录 warning 供审计
          if (result.tracePath && existsSync(result.tracePath)) {
            const traceCopy = join(perChapterDir, `${workspaceId}-ch${ch}-seed${seed}-trace.json`);
            try {
              const stat = statSync(result.tracePath);
              // 本章生成开始于 `started`（ms），trace 文件 mtime 应 >= started - 5000（5s 容差）
              // 若 trace mtime 早于本章开始，说明是旧 trace 被错误引用
              if (stat.mtimeMs < started - 5000) {
                console.warn(
                  `[Canary] ⚠️  ch${ch} seed${seed} trace mtime ${new Date(stat.mtimeMs).toISOString()} 早于本章开始 ${new Date(started).toISOString()}，跳过复制（疑似旧 trace）`,
                );
                result.warnings.push(`trace mtime 早于本章开始，跳过复制（疑似旧 trace）`);
              } else {
                copyFileSync(result.tracePath, traceCopy);
              }
            } catch (copyErr) {
              // P1 第四轮：trace 复制失败不再静默吞掉
              const errMsg = copyErr instanceof Error ? copyErr.message : String(copyErr);
              console.warn(
                `[Canary] ⚠️  ch${ch} seed${seed} trace 复制失败：${errMsg}`,
              );
              result.warnings.push(`trace 复制失败：${errMsg}`);
            }
          }

          results.push(result);
          // Phase 5.1：记录本章实际暴露的叙事工具模式（bounded canary 证据）。
          result.toolMode = effectiveToolModes[workspaceId];
          const icon = result.status === "ok" ? "✅" : result.status === "blocked" ? "🚫" : "❌";
          console.log(`[Canary]   ${icon} ${result.status} / ${result.outcomeType} / ${result.modelCalls.length} calls / ${durationMs}ms`);

          if (args.stopOnFailure && result.status !== "ok") {
            console.warn(`[Canary] ⚠️  --stop-on-failure 触发，终止后续章节`);
            break;
          }
        } catch (e) {
          const durationMs = Date.now() - started;
          const errMsg = e instanceof Error ? e.message : String(e);
          console.error(`[Canary]   ❌ exception: ${errMsg}`);
          // 异常也记录为 error 结果
          const errorResult = {
            workspaceId,
            chapterId: String(ch),
            chapterNumber: ch,
            seed,
            status: "error",
            selectedSource: null,
            selectedCandidateId: undefined,
            outcomeType: "unknown",
            chapterFilePath: null,
            textHash: null,
            textLength: 0,
            durationMs,
            failureEnvelope: {
              stage: "canary_runner",
              severity: "fatal",
              reason: `Runner exception: ${errMsg}`,
              recoverable: false,
            },
            modelCalls: [],
            tracePath: null,
            recoveryAttempted: false,
            recoverySucceeded: false,
            warnings: [],
            modelVersion: "unknown",
            toolMode: effectiveToolModes[workspaceId],
          };
          results.push(errorResult);
          const resultFile = join(perChapterDir, `${workspaceId}-ch${ch}-seed${seed}.json`);
          writeFileSync(resultFile, JSON.stringify(errorResult, null, 2), "utf8");

          if (args.stopOnFailure) {
            console.warn(`[Canary] ⚠️  --stop-on-failure 触发，终止后续章节`);
            break;
          }
        }
      }
      if (args.stopOnFailure && results.length > 0 && results[results.length - 1].status !== "ok") {
        break;
      }
    }
  }

  const finishedAt = new Date().toISOString();

  // 计算聚合指标
  const metrics = computeCanaryMetrics(results);

  // 匿名化
  const anonIdMap = new Map();
  const anonymized = results.map((r) => anonymizeChapterResult(r, anonIdMap));

  // 盲评对照对
  const blindPairs = buildBlindEvalPairs(results, { readFileSync });
  // P1-6: 报告盲评跳过原因（双方非空才导出，否则跳过并记录原因）
  const blindSkipped = blindPairs.skipped ?? [];
  const okCount = results.filter((r) => r.status === "ok").length;

  // 运行元信息
  const metadata = {
    runId,
    startedAt,
    finishedAt,
    gitHead,
    // P0 第七轮 P1 修复：工作树内容指纹，证明 canary 运行的确切工作树状态。
    // 复现条件：相同 gitHead + 相同 worktreeDiffHash。worktreeDirty=true 时
    // gitHead 单独不足以证明复现性，必须配合 worktreeDiffHash。
    worktreeDirty,
    worktreeStatusHash,
    worktreeDiffHash,
    worktreeStatusPreview,
    workspaces: args.workspaces,
    chapterRange: `${args.start}-${args.end}`,
    seeds: args.seeds,
    realModel: args.realModel,
    writerModel: args.writerModel ?? "default",
    candidateTimeoutMs: args.candidateTimeoutMs,
    totalPlanned: total,
    totalCompleted: results.length,
    totalSkipped: skipped,
    modelVersion: results[0]?.modelVersion ?? "unknown",
    singleChapterSoftBudget: SINGLE_CHAPTER_HARD_BUDGET,
    // Phase 5.1：每个 workspace 实际暴露的叙事工具模式（bounded canary 证据）。
    toolModes: effectiveToolModes,
    blindEval: {
      pairs: blindPairs.length,
      okChapters: okCount,
      skipped: blindSkipped.length,
      skippedReasons: blindSkipped,
    },
  };

  // Phase 5.1：完成态 trace 证据（--complete 时产出）。
  // 用 completion-trace-adapter 把真实运行结果适配为可被 evolution-cli canary --complete
  // 消费的完成态 CanaryRunTrace，补齐 toolMode / 模型指纹 / 失败指标三项证据。
  let completionTrace = null;
  if (args.complete) {
    const wsId = args.workspaces[0];
    const wsPath = join(REPO_ROOT, "workspaces", wsId);
    completionTrace = buildCompletionTrace({
      runId: `${runId}-complete`,
      sourceRunId: args.sourceRunId ?? runId,
      releaseId: args.releaseId ?? `phase5-${wsId}-${runId}`,
      previousReleaseId: null,
      workspaceId: wsId,
      workspacePath: wsPath,
      toolMode: effectiveToolModes[wsId],
      authorizationId: args.authorizationId ?? `auth-${wsId}`,
      environmentFingerprint: args.environmentFingerprint ?? "unknown",
      approvalRef: args.approvalRef ?? `approval-${runId}`,
      startedAt,
      completedAt: finishedAt,
      changeClass: args.changeClass,
      currentStatus: "evaluated",
      strategy: args.strategy,
      results,
      healthSnapshot: {
        status: args.strategy === "bounded_canary" ? "healthy" : "warning",
        alignmentRate: 0,
        sampleCount: results.length,
        rollbackRate: 0,
        consecutiveNegative: 0,
      },
    });
    writeFileSync(
      join(outputDir, "completion-trace.json"),
      JSON.stringify(completionTrace, null, 2),
      "utf8",
    );
  }

  // 生成报告
  const report = generateCanaryReport({
    metrics,
    results,
    metadata,
  });

  // 写入所有产物
  writeFileSync(join(outputDir, "results.json"), JSON.stringify(results, null, 2), "utf8");
  writeFileSync(join(outputDir, "metrics.json"), JSON.stringify(metrics, null, 2), "utf8");
  writeFileSync(join(outputDir, "anonymized-results.json"), JSON.stringify(anonymized, null, 2), "utf8");
  writeFileSync(join(outputDir, "blind-eval-pairs.json"), JSON.stringify(blindPairs, null, 2), "utf8");
  writeFileSync(join(outputDir, "run-metadata.json"), JSON.stringify(metadata, null, 2), "utf8");
  writeFileSync(join(outputDir, "report.md"), report, "utf8");

  console.log("");
  console.log(`[Canary] === Summary ===`);
  console.log(`[Canary] Total: ${metrics.total} / OK: ${metrics.ok} / Blocked: ${metrics.blocked} / Error: ${metrics.error}`);
  console.log(`[Canary] Block rate: ${(metrics.blockRate * 100).toFixed(2)}%`);
  console.log(`[Canary] First-pass success: ${(metrics.firstPassSuccessRate * 100).toFixed(2)}%`);
  console.log(`[Canary] Recovery success: ${metrics.recoverySuccessRate === null ? "N/A" : `${(metrics.recoverySuccessRate * 100).toFixed(2)}%`} (${metrics.recoverySucceededCount}/${metrics.recoveryAttemptedCount})`);
  console.log(`[Canary] Model calls: ${metrics.modelCalls.total} (avg ${metrics.modelCalls.averagePerChapter}/chapter)`);
  console.log(`[Canary] Over hard budget: ${metrics.modelCalls.overHardBudgetCount} chapters`);
  console.log(`[Canary] Blind eval pairs: ${blindPairs.length}${blindSkipped.length > 0 ? ` (skipped ${blindSkipped.length}/${okCount})` : ""}`);
  console.log(`[Canary] Output: ${outputDir}`);
  console.log(`[Canary] Report: ${join(outputDir, "report.md")}`);
  if (args.complete && completionTrace) {
    console.log(`[Canary] Completion trace: ${join(outputDir, "completion-trace.json")}`);
    console.log(`[Canary]   toolMode=${completionTrace.evidence.toolMode} verdict=${completionTrace.evidence.verdict} observedChapters=${completionTrace.evidence.observedChapters} observedCalls=${completionTrace.evidence.observedCalls}`);
    console.log(`[Canary]   modelFingerprint.detectedModel=${completionTrace.evidence.modelFingerprint?.detectedModel} modelCalls=${completionTrace.evidence.modelFingerprint?.modelCalls}`);
    console.log(`[Canary]   failureMetrics: empty=${completionTrace.evidence.failureMetrics?.empty} truncated=${completionTrace.evidence.failureMetrics?.truncated} error=${completionTrace.evidence.failureMetrics?.error} timeout=${completionTrace.evidence.failureMetrics?.timeout} blockRate=${completionTrace.evidence.failureMetrics?.blockRate}`);
  }

  // 退出码：多维度验收门槛（P1-2 修复：不仅检查阻断率，还检查恢复率、trace 留存率、未知失败）
  // 0. 零结果 → 失败（P1 第四轮：canary 未产生任何结果时不能通过验收）
  // 1. 阻断率 > 50% → 失败（避免在系统不稳定时宣称 canary 通过）
  // 2. trace 留存率 < 100% → 失败（每条结果必须有 tracePath 且文件存在）
  // 3. 未知失败 (outcomeType=unknown) > 0 → 失败（所有失败必须可分类）
  // 4. 恢复成功率 < 85%（当有恢复尝试时）→ 失败（自动恢复后成功率应 ≥ 85%）
  let exitCode = 0;
  const failureReasons = [];

  // P1 第四轮：零结果不能通过
  if (metrics.total === 0) {
    failureReasons.push(`零结果（0/0 成功）：canary 未产生任何结果，不能通过验收`);
  }

  if (metrics.total > 0 && metrics.blockRate > 0.5) {
    failureReasons.push(`阻断率 ${(metrics.blockRate * 100).toFixed(1)}% > 50%`);
  }

  // trace 留存率检查
  const resultsWithTrace = results.filter(
    (r) => r.tracePath && existsSync(r.tracePath),
  );
  const traceRetentionRate = results.length > 0 ? resultsWithTrace.length / results.length : 1;
  if (results.length > 0 && traceRetentionRate < 1) {
    failureReasons.push(
      `trace 留存率 ${(traceRetentionRate * 100).toFixed(1)}% < 100% (${resultsWithTrace.length}/${results.length})`,
    );
  }

  // 未知失败检查
  const unknownFailures = results.filter(
    (r) => r.status !== "ok" && r.outcomeType === "unknown",
  );
  if (unknownFailures.length > 0) {
    failureReasons.push(
      `未知失败 ${unknownFailures.length} 条 (outcomeType=unknown)，所有失败必须可分类`,
    );
  }

  // 恢复成功率检查（仅当有恢复尝试时）
  if (
    metrics.recoveryAttemptedCount > 0 &&
    metrics.recoverySuccessRate !== null &&
    metrics.recoverySuccessRate < 0.85
  ) {
    failureReasons.push(
      `恢复成功率 ${(metrics.recoverySuccessRate * 100).toFixed(1)}% < 85% (${metrics.recoverySucceededCount}/${metrics.recoveryAttemptedCount})`,
    );
  }

  if (failureReasons.length > 0) {
    console.warn(`[Canary] ⚠️  canary 失败：`);
    for (const reason of failureReasons) {
      console.warn(`[Canary]   - ${reason}`);
    }
    exitCode = 1;
  } else {
    console.log(`[Canary] ✅ canary 验收通过：阻断率 ≤ 50%、trace 留存 100%、未知失败 0、恢复率 ≥ 85%`);
  }
  process.exit(exitCode);
}

// ============================================================================
// Phase 5.1 bounded-canary toolMode 解析
// ============================================================================

/**
 * 解析 workspace 的有效叙事工具暴露模式（bounded canary 受控接入）。
 *
 * fail-closed 语义：
 *   - requestedMode="standard"        → 恒返回 "standard"（9 专用工具，非全量切换）。
 *   - requestedMode="facade"          → 仅当生产解析器确认该 workspace canary 授权
 *     明确授予 "facade"（存在、未过期、schema 有效）才返回 "facade"；
 *     否则抛错拒绝运行（bounded 保证：绝不在地图外跑 facade）。
 *   - requestedMode="auto"（缺省）    → 按生产解析器决定：授权 facade 则 facade，否则 standard。
 *   - 解析器不可用（dist 未含该模块）  → 视为无法确认 facade，一律 standard（fail-closed）。
 *
 * @param {string} workspaceId
 * @param {"auto"|"standard"|"facade"} requestedMode
 * @param {{ projectRoot: string, sourceRunId: string|null, releaseId: string|null, authorizationId: string|null }} args
 * @param {Function|null} resolver — resolveToolModeFromCanaryAuthorization(projectRoot, workspaceId)
 * @returns {"standard"|"facade"}
 */
function resolveEffectiveToolMode(workspaceId, requestedMode, args, resolver) {
  if (requestedMode === "standard") return "standard";

  // 生产解析器评估授权（解析器缺失 → 视为未授权 → fail-closed）
  let granted = "standard";
  if (resolver) {
    granted = resolver(args.projectRoot, workspaceId) === "facade" ? "facade" : "standard";
  }

  if (requestedMode === "facade" && granted !== "facade") {
    throw new Error(
      `bounded canary fail-closed: workspace=${workspaceId} 请求 toolMode=facade，` +
        `但 canary 授权未授予 facade（缺失/未声明/过期/损坏/schema 无效），拒绝在不受控暴露面下运行。`,
    );
  }
  return granted;
}

// ============================================================================
// 单章运行
// ============================================================================

/**
 * 调用 novel_generate_chapter 工具生成单章，并归一化为 CanaryChapterResult。
 *
 * @param {Object} params
 * @returns {Promise<import("./canary-metrics.mjs").CanaryChapterResult>}
 */
async function runSingleChapter(params) {
  const {
    chapterTool,
    workspaceId,
    chapterNumber,
    seed,
    writerModel,
    candidateTimeoutMs,
    recoverBlockedRaw,
    realModel,
    workspacePath,
    projectRoot,
  } = params;

  const toolCallId = `canary-${workspaceId}-ch${chapterNumber}-seed${seed}-${Date.now()}`;
  const toolInput = {
    workspaceId,
    chapterId: String(chapterNumber),
    chapterNumber,
    seed,
    candidateTimeoutMs,
    recoverBlockedRaw: recoverBlockedRaw || undefined,
    writerModel: writerModel || undefined,
  };

  // 工具上下文
  const toolContext = {
    cwd: projectRoot,
    ui: {
      notify(msg, level) {
        // 静默进度通知（避免日志爆炸）
      },
    },
  };

  let output;
  try {
    const rawResult = await chapterTool.execute(
      toolCallId,
      toolInput,
      undefined,             // previousToolResponse
      undefined,             // onUpdate
      toolContext,
    );
    output = unwrapToolResult(rawResult);
  } catch (e) {
    // 工具执行异常 → 包装为 error 输出
    output = {
      status: "error",
      workspaceId,
      chapterId: String(chapterNumber),
      chapterNumber,
      failureEnvelope: {
        stage: "tool_execute",
        severity: "fatal",
        reason: e instanceof Error ? e.message : String(e),
        recoverable: false,
      },
      stageResults: { modelCalls: [] },
    };
  }

  // 定位 chapterFilePath
  let chapterFilePath = output.stageResults?.chapterFilePath ?? null;
  if (!chapterFilePath && output.status === "ok") {
    // 兜底：根据 workspace 约定解析
    const candidate = resolveCanonicalChapterPath(workspacePath, chapterNumber);
    if (candidate) chapterFilePath = candidate;
  }

  // 定位 tracePath
  const tracePath = output.stageResults?.tracePath ?? null;

  // 检测恢复
  // P1-6: 识别两类恢复路径
  //   1. 旧 blockedRawRecovery（legacy stage-level raw 恢复）
  //   2. 新 modelTimeoutRetry（Phase 1 工具层 chapter_level_retry）
  // 旧 canary 只识别 (1)，导致 Phase 1 工具层重试不计入恢复率指标。
  const blockedRawRecovery = !!(output.stageResults?.blockedRawRecovery);
  const modelTimeoutRetry = output.stageResults?.modelTimeoutRetry;
  const toolLayerRetryAttempted = !!(modelTimeoutRetry?.attempted);
  const recoveryAttempted = blockedRawRecovery || toolLayerRetryAttempted;
  const recoverySucceeded = recoveryAttempted && output.status === "ok";

  return normalizeChapterResult({
    workspaceId,
    chapterId: String(chapterNumber),
    chapterNumber,
    seed,
    durationMs: 0, // 由调用方填充
    recoveryAttempted,
    recoverySucceeded,
    run: {
      output,
      chapterFilePath,
      tracePath,
      recoverySucceeded,
    },
    fs: { readFileSync },
  });
}

/**
 * 解包 tool.execute 返回的结果（可能是 { content: [{ text }] } 或直接对象）。
 */
function unwrapToolResult(raw) {
  if (!raw) return {};
  // PI 工具协议：{ content: [{ type: "text", text: "..." }], details?: ... }
  if (raw.content && Array.isArray(raw.content) && raw.content.length > 0) {
    const textEntry = raw.content.find((c) => c?.type === "text");
    if (textEntry?.text) {
      try {
        return JSON.parse(textEntry.text);
      } catch {
        // text 不是 JSON → 用 details 字段
      }
    }
  }
  // 直接返回对象（handler 直接返回 V2Output 的情况）
  if (raw.details) return raw.details;
  return raw;
}

/**
 * 兜底解析章节文件路径（当 stageResults.chapterFilePath 缺失时）。
 * 优先 chapters/chapter-{N}/main.md，其次 chapters/ch{N}.md。
 */
function resolveCanonicalChapterPath(workspacePath, chapterNumber) {
  const candidates = [
    join(workspacePath, "chapters", `chapter-${chapterNumber}`, "main.md"),
    join(workspacePath, "chapters", `chapter-${chapterNumber}`, "text.md"),
    join(workspacePath, "chapters", `chapter-${chapterNumber}.md`),
    join(workspacePath, "chapters", `ch${chapterNumber}.md`),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

// ============================================================================
// 入口
// ============================================================================

main().catch((e) => {
  process.stderr.write(`[Canary] 未捕获异常: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
