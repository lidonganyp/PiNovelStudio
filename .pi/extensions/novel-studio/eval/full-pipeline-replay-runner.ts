/**
 * FullPipelineReplayRunner — 完整公共入口离线回放 Runner（P2）
 *
 * 目标：回放必须调用完整的 `novel_generate_chapter` 统一主链路
 * （Preflight → ContextCompiler → ChapterIntent → NovelOS Agentic →
 * FactGuard → 作者风格优化 → StoryPreservation → FinalFactRecheck →
 * Completeness → FinalStateCommit → AtomicSave + Trace），
 * 而不是只调用局部 AgenticRaw 模块。
 *
 * 与 eval/replay-runner.ts 的关系：
 *  - 旧 runner 以 ReplayCase（外部小说抽取）为输入、直接写
 *    {projectRoot}/workspaces 正式区，无隔离契约；
 *  - 本 runner 以 EvalFixtureV1 契约为输入（fail-closed 校验），
 *    通过 ReplayIsolationGuard 写入 scratch 隔离根，逐样本归档
 *    fixture/invocation/trace/FailureEnvelope/状态投影/成本延迟，
 *    并经 P4 归因分类器产出结构化失败归因；
 *  - 子进程通过 scripts/invoke-generate-chapter.mjs --project-root={scratch}
 *    调用 dist/index.js 的 novel_generate_chapter（代码根仍为仓库根）。
 *
 * 最小场景（通过 fixture + 可注入 invoke 覆盖）：
 * 正常生成 / 模型超时 / schema 错误 / coverage 不足 / checkpoint-resume /
 * 并发冲突 / budget exhausted / stale release / approval / commit 边界崩溃 /
 * corrupted trace tail / 重复 replay。
 *
 * 本地确定性编排；不调用机器文学裁判；不写正式状态。
 */

import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";

import {
  computeEvalFixtureHash,
  parseEvalFixtureV1,
  type EvalFixtureV1,
  type ReplayRunManifestV1,
  type ReplayRunSampleEntry,
} from "../v2/core/eval-fixture-contract.js";
import {
  archiveScratchWorkspace,
  buildReplayIsolationEnv,
  captureProductionSurface,
  cleanupScratchWorkspace,
  createScratchWorkspace,
  detectProductionSurfacePollution,
  materializeScratchProjectSkeleton,
  readScratchMarker,
  stripSensitiveFilesBeforeArchive,
  validateReplayIsolationPrerequisites,
  type IsolationViolation,
  type ScratchWorkspaceLease,
} from "../v2/core/eval-replay-isolation.js";
import {
  classifyFailureAttribution,
  summarizeAttributions,
  type AttributionSummary,
  type FailureAttributionResult,
} from "../v2/core/eval-failure-attribution.js";

// ============================================================================
// 类型定义
// ============================================================================

/** 回放调用命令（与 eval/replay-types.ts 的 ReplayInvokeCommand 对齐的子集）。 */
export interface FullPipelineInvokeCommand {
  toolName: "novel_generate_chapter";
  executable: string;
  args: string[];
  cwd: string;
  workspaceId: string;
  chapterId: string;
  chapterNumber: number;
  mockAgent: boolean;
  resultPath: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface FullPipelineInvokeResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  durationMs: number;
}

export type FullPipelineInvoke = (
  command: FullPipelineInvokeCommand,
) => Promise<FullPipelineInvokeResult>;

export interface RunFullPipelineReplayOptions {
  /** 仓库根（scripts/ 与 dist/ 所在；也是生产面对照的真实项目根）。 */
  projectRoot: string;
  /** 原始 fixture JSON 对象数组（逐个 fail-closed 校验）。 */
  fixtures: unknown[];
  runId?: string;
  /** 归档根；默认 {projectRoot}/.pi/eval-replay-archives。 */
  archiveRoot?: string;
  /** scratch 父目录；默认 {projectRoot}/.pi/eval-scratch。 */
  scratchParentDir?: string;
  /** 可注入调用器（测试 / 故障注入）；缺省为真实子进程调用。 */
  invoke?: FullPipelineInvoke;
  /** 单样本调用 timeout 覆盖；缺省取 fixture.modelPolicy.totalTimeoutMs。 */
  invokeTimeoutMs?: number;
  /**
   * stub / synthetic 模式默认 mockAgent=true（不调用真实模型）；
   * 显式传 false 可覆盖（如 recorded 模式接 recorded 适配器时）。
   */
  mockAgent?: boolean;
  /** 归档策略：archive（默认，保留 scratch 供审计）/ cleanup（校验后删除）。 */
  scratchDisposition?: "archive" | "cleanup";
}

export interface FullPipelineSampleReport {
  entry: ReplayRunSampleEntry;
  /** 样本归档目录（manifest + 产物同根）。 */
  sampleArchivePath: string | null;
  attribution: FailureAttributionResult | null;
  /** 归因分类器输入快照（供重复回放稳定性比对）。 */
  invoke: FullPipelineInvokeResult | null;
  isolationViolations: IsolationViolation[];
}

export interface FullPipelineReplayRunReport {
  runId: string;
  runPath: string;
  manifest: ReplayRunManifestV1;
  samples: FullPipelineSampleReport[];
  attributionSummary: AttributionSummary;
  /** 全 run 隔离违规总数（必须为 0 才允许进入结果统计）。 */
  isolationViolationCount: number;
}

// ============================================================================
// 内部工具
// ============================================================================

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), "utf-8");
}

function sha256File(path: string): string | null {
  if (!existsSync(path)) {
    return null;
  }
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** 把 fixture workspace 快照物化到 scratch workspace（含内容 hash 校验）。 */
function materializeWorkspace(
  lease: ScratchWorkspaceLease,
  fixture: EvalFixtureV1,
): { violations: IsolationViolation[] } {
  const violations: IsolationViolation[] = [];
  const workspacePath = lease.workspacePath;
  const seriesPath = join(workspacePath, "series");
  const charactersPath = join(workspacePath, "characters");
  const chaptersPath = join(workspacePath, "chapters");
  mkdirSync(seriesPath, { recursive: true });
  mkdirSync(charactersPath, { recursive: true });
  mkdirSync(chaptersPath, { recursive: true });

  const config = {
    ...(fixture.workspace.config as Record<string, unknown>),
    // 回放身份声明：任何下游读 config 的阶段都能识别 eval 身份。
    evalOnly: true,
    evalProtocolVersion: fixture.evalProtocolVersion,
    replayRunWorkspace: true,
  };
  writeJson(join(workspacePath, "config.json"), config);

  if (typeof fixture.workspace.outline === "string") {
    writeFileSync(join(seriesPath, "outline.md"), fixture.workspace.outline + "\n", "utf-8");
  }
  for (const [characterId, profile] of Object.entries(fixture.workspace.characterProfiles)) {
    writeFileSync(join(charactersPath, `${characterId}.md`), profile + "\n", "utf-8");
  }
  if (fixture.workspace.worldItems) {
    writeJson(join(seriesPath, "world-items.json"), {
      items: fixture.workspace.worldItems,
      lastUpdated: new Date().toISOString(),
    });
  }
  if (fixture.workspace.skeleton) {
    writeJson(join(seriesPath, "skeleton.json"), fixture.workspace.skeleton);
  }
  writeJson(
    join(seriesPath, "narrative-state.json"),
    fixture.priorNarrativeState ?? {
      schemaVersion: 1,
      canon: {},
      characters: {},
      promises: {},
      patterns: {},
      createdAt: new Date().toISOString(),
    },
  );

  for (const chapter of fixture.workspace.historicalChapters) {
    const chapterDir = join(chaptersPath, `chapter-${chapter.chapterId}`);
    mkdirSync(chapterDir, { recursive: true });
    if (typeof chapter.content === "string") {
      const finalPath = join(chapterDir, "final.md");
      writeFileSync(finalPath, chapter.content, "utf-8");
      const actualHash = createHash("sha256")
        .update(chapter.content, "utf-8")
        .digest("hex");
      if (actualHash !== chapter.contentHash) {
        violations.push({
          kind: "path_escape",
          detail:
            `前章快照 contentHash 与正文不一致（chapter ${chapter.chapterNumber}）：` +
            `期望 ${chapter.contentHash}，实际 ${actualHash}`,
          evidence: { chapterId: chapter.chapterId },
        });
      }
    }
  }

  return { violations };
}

/** 从 scratch workspace 收集 FailureEnvelope 摘要（traces + generate-result）。 */
function collectFailureEnvelopes(
  lease: ScratchWorkspaceLease,
  chapterId: string,
): Array<{ stage: string; gate?: string; severity?: string; reason: string; raw: unknown }> {
  const envelopes: Array<{
    stage: string;
    gate?: string;
    severity?: string;
    reason: string;
    raw: unknown;
  }> = [];
  const tracesDir = join(lease.workspacePath, "traces");
  if (existsSync(tracesDir)) {
    for (const name of readdirSync(tracesDir)) {
      if (!name.endsWith(".json")) {
        continue;
      }
      try {
        const trace = JSON.parse(readFileSync(join(tracesDir, name), "utf-8")) as Record<
          string,
          unknown
        >;
        const collected = trace.failureEnvelopes;
        if (Array.isArray(collected)) {
          for (const raw of collected) {
            const env = raw as Record<string, unknown>;
            if (typeof env?.stage === "string" && typeof env?.reason === "string") {
              envelopes.push({
                stage: env.stage,
                gate: typeof env.gate === "string" ? env.gate : undefined,
                severity: typeof env.severity === "string" ? env.severity : undefined,
                reason: env.reason,
                raw,
              });
            }
          }
        }
      } catch {
        // corrupted trace tail：无法解析的 trace 记为 replay_environment 失败证据
        envelopes.push({
          stage: "trace-archive",
          gate: "corrupted_trace_tail",
          severity: "hard",
          reason: `trace 文件无法解析：${name}`,
          raw: { file: name },
        });
      }
    }
  }
  const resultPath = join(
    lease.workspacePath,
    "chapters",
    `chapter-${chapterId}`,
    "generate-result.json",
  );
  if (existsSync(resultPath)) {
    try {
      const result = JSON.parse(readFileSync(resultPath, "utf-8")) as Record<string, unknown>;
      if (Array.isArray(result.failureEnvelopes)) {
        for (const raw of result.failureEnvelopes) {
          const env = raw as Record<string, unknown>;
          if (typeof env?.stage === "string" && typeof env?.reason === "string") {
            envelopes.push({
              stage: env.stage,
              gate: typeof env.gate === "string" ? env.gate : undefined,
              severity: typeof env.severity === "string" ? env.severity : undefined,
              reason: env.reason,
              raw,
            });
          }
        }
      }
    } catch {
      envelopes.push({
        stage: "generate-result",
        gate: "corrupted_result",
        severity: "hard",
        reason: "generate-result.json 无法解析",
        raw: { file: resultPath },
      });
    }
  }
  return envelopes;
}

/** 统计 scratch 内模型调用次数（quality-trace 的 modelCalls 数组长度）。 */
function countModelCalls(lease: ScratchWorkspaceLease): number {
  const tracesDir = join(lease.workspacePath, "traces");
  if (!existsSync(tracesDir)) {
    return 0;
  }
  let total = 0;
  for (const name of readdirSync(tracesDir)) {
    if (!name.endsWith(".json")) {
      continue;
    }
    try {
      const trace = JSON.parse(readFileSync(join(tracesDir, name), "utf-8")) as Record<
        string,
        unknown
      >;
      const modelCalls = trace.modelCalls;
      if (Array.isArray(modelCalls)) {
        total += modelCalls.length;
      }
    } catch {
      // trace 损坏已在 failure envelope 收集处记录，此处跳过计数
    }
  }
  return total;
}

function hasTraceArchive(lease: ScratchWorkspaceLease): boolean {
  const tracesDir = join(lease.workspacePath, "traces");
  return existsSync(tracesDir) && readdirSync(tracesDir).some((n) => n.endsWith(".json"));
}

// ============================================================================
// 默认调用器（真实子进程）
// ============================================================================

/**
 * 默认调用器：spawn node scripts/invoke-generate-chapter.mjs，
 * 携带隔离 env 与 --project-root={scratchRoot}。
 */
export function defaultFullPipelineInvoke(
  command: FullPipelineInvokeCommand,
): Promise<FullPipelineInvokeResult> {
  const startedAt = Date.now();
  return new Promise((resolveInvoke) => {
    const child = spawn(command.executable, command.args, {
      cwd: command.cwd,
      env: command.env ?? process.env,
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const finish = (result: Omit<FullPipelineInvokeResult, "durationMs">): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      resolveInvoke({ ...result, durationMs: Date.now() - startedAt });
    };

    if (command.timeoutMs && command.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        stderr += `${
          stderr ? "\n" : ""
        }novel_generate_chapter timed out after ${command.timeoutMs}ms; child process was terminated.`;
        if (!child.killed) {
          child.kill("SIGTERM");
        }
        forceKillTimer = setTimeout(() => {
          if (!settled && !child.killed) {
            child.kill("SIGKILL");
          }
        }, 5000);
      }, command.timeoutMs);
    }

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", (error) => {
      finish({ exitCode: null, stdout, stderr: `${stderr}\n${String(error)}`, timedOut });
    });
    child.on("close", (code) => {
      finish({ exitCode: code, stdout, stderr, timedOut });
    });
  });
}

// ============================================================================
// 主入口
// ============================================================================

/**
 * 运行完整公共入口离线回放。
 *
 * 证据链：fixture 校验（fail-closed）→ 生产面前置快照 → scratch 物化 →
 * 完整 novel_generate_chapter 子进程调用 → 产物归档（trace / result /
 * invocation）→ 生产面后置快照污染检测 → 失败归因 → ReplayRunManifest。
 */
export async function runFullPipelineReplay(
  options: RunFullPipelineReplayOptions,
): Promise<FullPipelineReplayRunReport> {
  const projectRoot = resolve(options.projectRoot);
  const runId =
    options.runId ??
    `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const archiveRoot = resolve(
    options.archiveRoot ?? join(projectRoot, ".pi", "eval-replay-archives"),
  );
  const runPath = join(archiveRoot, runId);
  mkdirSync(runPath, { recursive: true });

  const invoke = options.invoke ?? defaultFullPipelineInvoke;
  const startedAt = new Date().toISOString();

  // 生产面前置快照（整 run 一次）
  const surfaceBefore = captureProductionSurface(projectRoot);

  const samples: FullPipelineSampleReport[] = [];
  /** 首个通过校验的 fixture：manifest 的 release/bundle/mode 来源。 */
  let anchorFixture: EvalFixtureV1 | null = null;

  for (const rawFixture of options.fixtures) {
    const parsed = parseEvalFixtureV1(rawFixture);
    if (!parsed.ok) {
      const attribution = classifyFailureAttribution({
        stage: "fixture-validation",
        gate: "eval_fixture_contract",
        reason: parsed.errors.map((e) => `${e.field}:${e.rule}`).join("; "),
        perspective: "replay",
      });
      const entry: ReplayRunSampleEntry = {
        fixtureId:
          typeof (rawFixture as Record<string, unknown>)?.fixtureId === "string"
            ? ((rawFixture as Record<string, unknown>).fixtureId as string)
            : "unknown-fixture",
        fixtureHash: "0".repeat(64),
        // fixture 未通过校验，无法信任其 replayMode；以 stub 占位（样本已被 skip）。
        replayMode: "stub",
        scratchWorkspaceId: "(not-created)",
        status: "skipped_invalid_fixture",
        failureAttribution: attribution.attribution,
        failureEnvelopes: parsed.errors.slice(0, 20).map((e) => ({
          stage: "fixture-validation",
          gate: e.rule,
          severity: "preflight",
          reason: e.message,
        })),
        traceArchived: false,
        traceArchivePath: null,
        isolationViolations: [],
        modelCalls: 0,
        durationMs: 0,
      };
      samples.push({
        entry,
        sampleArchivePath: null,
        attribution,
        invoke: null,
        isolationViolations: [],
      });
      writeJson(
        join(runPath, "fixtures", `${entry.fixtureId}.invalid.json`),
        { errors: parsed.errors },
      );
      continue;
    }

    const fixture = parsed.fixture;
    const fixtureHash = computeEvalFixtureHash(fixture);
    if (anchorFixture === null) {
      anchorFixture = fixture;
    }

    // 隔离前置校验（fail-closed）
    const prereq = validateReplayIsolationPrerequisites(fixture);
    if (!prereq.ok) {
      const attribution = classifyFailureAttribution({
        stage: "replay-isolation",
        gate: "isolation_prerequisites",
        reason: prereq.violations.map((v) => v.detail).join("; "),
        perspective: "replay",
      });
      const entry: ReplayRunSampleEntry = {
        fixtureId: fixture.fixtureId,
        fixtureHash,
        replayMode: fixture.replayMode,
        scratchWorkspaceId: "(not-created)",
        status: "skipped_isolation_violation",
        failureAttribution: attribution.attribution,
        failureEnvelopes: prereq.violations.map((v) => ({
          stage: "replay-isolation",
          gate: v.kind,
          severity: "preflight",
          reason: v.detail,
        })),
        traceArchived: false,
        traceArchivePath: null,
        isolationViolations: prereq.violations,
        modelCalls: 0,
        durationMs: 0,
      };
      samples.push({
        entry,
        sampleArchivePath: null,
        attribution,
        invoke: null,
        isolationViolations: prereq.violations,
      });
      continue;
    }

    // scratch 创建 + 项目骨架物化 + workspace 物化
    const lease = createScratchWorkspace({
      projectRoot,
      fixture,
      scratchParentDir: options.scratchParentDir,
    });
    const isRealModel = fixture.replayMode === "dev_real_model" || fixture.replayMode === "production_like";
    materializeScratchProjectSkeleton(lease.scratchRoot, {
      projectRoot,
      copyModelRouting: isRealModel,
      copyDotEnv: isRealModel,
    });
    const materializeResult = materializeWorkspace(lease, fixture);

    const invokeEnv = buildReplayIsolationEnv(fixture, process.env, lease.scratchRoot);
    const mockAgent =
      options.mockAgent ?? (fixture.replayMode === "stub" || fixture.replayMode === "synthetic");
    const resultPath = join(
      lease.workspacePath,
      "chapters",
      `chapter-${fixture.chapterSeed.chapterId}`,
      "generate-result.json",
    );
    const command: FullPipelineInvokeCommand = {
      toolName: "novel_generate_chapter",
      executable: process.execPath,
      args: [
        join(projectRoot, "scripts", "invoke-generate-chapter.mjs"),
        lease.workspaceId,
        fixture.chapterSeed.chapterId,
        String(fixture.chapterSeed.chapterNumber),
        ...(mockAgent ? ["mock"] : []),
        `--project-root=${lease.scratchRoot}`,
      ],
      cwd: projectRoot,
      workspaceId: lease.workspaceId,
      chapterId: fixture.chapterSeed.chapterId,
      chapterNumber: fixture.chapterSeed.chapterNumber,
      mockAgent,
      resultPath,
      timeoutMs: options.invokeTimeoutMs ?? fixture.modelPolicy.totalTimeoutMs,
      env: invokeEnv,
    };

    const sampleStartedAt = Date.now();
    let invokeResult: FullPipelineInvokeResult;
    try {
      invokeResult = await invoke(command);
    } catch (error) {
      invokeResult = {
        exitCode: null,
        stdout: "",
        stderr: String(error),
        timedOut: false,
        durationMs: Date.now() - sampleStartedAt,
      };
    }
    const durationMs = Date.now() - sampleStartedAt;

    // scratch 标记复核（子进程运行后 scratch 身份仍合法）
    const markerCheck = readScratchMarker(lease.scratchRoot, {
      fixtureId: fixture.fixtureId,
      releaseId: fixture.provenance.releaseId,
    });

    // 收集失败 envelope 与模型调用统计
    const envelopes = collectFailureEnvelopes(lease, fixture.chapterSeed.chapterId);
    const modelCalls = countModelCalls(lease);
    const traceArchived = hasTraceArchive(lease);

    // 归因：优先用 trace 内 envelope；invoke 层失败（超时/退出码）兜底
    let attribution: FailureAttributionResult;
    if (envelopes.length > 0) {
      const worst =
        envelopes.find((e) => e.severity === "hard" || e.severity === "fatal") ??
        envelopes[envelopes.length - 1];
      attribution = classifyFailureAttribution({
        stage: worst.stage,
        gate: worst.gate,
        severity: worst.severity,
        reason: worst.reason,
      });
    } else if (invokeResult.timedOut) {
      attribution = classifyFailureAttribution({
        stage: "invoke",
        gate: "model_timeout",
        severity: "recoverable",
        reason: `invoke timed out after ${command.timeoutMs}ms`,
        randomnessDeclared: false,
      });
    } else if (invokeResult.exitCode !== 0) {
      attribution = classifyFailureAttribution({
        stage: "invoke",
        gate: "invoke_failed",
        severity: "hard",
        reason: invokeResult.stderr.slice(0, 400) || `exit code ${invokeResult.exitCode}`,
      });
    } else {
      attribution = classifyFailureAttribution({
        stage: "invoke",
        gate: "invoke_ok",
        severity: "recoverable",
        reason: "invoke completed",
      });
    }

    // 样本归档：manifest + invocation + fixture + trace/result 副本
    const sampleArchivePath = join(runPath, "samples", fixture.fixtureId);
    mkdirSync(sampleArchivePath, { recursive: true });
    writeJson(join(sampleArchivePath, "fixture.json"), fixture);
    writeJson(join(sampleArchivePath, "invocation.json"), {
      command: { ...command, env: "(omitted)" },
      result: invokeResult,
    });
    if (traceArchived) {
      cpSync(
        join(lease.workspacePath, "traces"),
        join(sampleArchivePath, "traces"),
        { recursive: true },
      );
    }
    if (existsSync(resultPath)) {
      copyFileSync(resultPath, join(sampleArchivePath, "generate-result.json"));
    }
    writeJson(
      join(sampleArchivePath, "state-projection.json"),
      {
        workspacePath: lease.workspacePath,
        narrativeStatePath: join(lease.workspacePath, "series", "narrative-state.json"),
        narrativeStateHash: sha256File(
          join(lease.workspacePath, "series", "narrative-state.json"),
        ),
        chaptersDir: join(lease.workspacePath, "chapters"),
      },
    );

    // scratch 处置：剥离敏感文件后归档或清理
    const markerViolations: IsolationViolation[] = markerCheck.ok
      ? []
      : markerCheck.violations;
    const allViolations: IsolationViolation[] = [
      ...materializeResult.violations,
      ...markerViolations,
    ];
    stripSensitiveFilesBeforeArchive(lease.scratchRoot);
    if (options.scratchDisposition === "cleanup") {
      // cleanup 模式：无违规才允许清理（有违规则保留供审计）
      if (allViolations.length === 0) {
        cleanupScratchWorkspace(lease);
      }
    } else {
      archiveScratchWorkspace(lease, join(runPath, "samples", fixture.fixtureId, "scratch"));
    }

    const failed =
      envelopes.some((e) => e.severity === "hard" || e.severity === "fatal") ||
      invokeResult.exitCode !== 0 ||
      invokeResult.timedOut;

    const entry: ReplayRunSampleEntry = {
      fixtureId: fixture.fixtureId,
      fixtureHash,
      replayMode: fixture.replayMode,
      scratchWorkspaceId: lease.workspaceId,
      status: failed ? "failed" : "completed",
      failureAttribution: failed ? attribution.attribution : null,
      failureEnvelopes: envelopes.map((e) => ({
        stage: e.stage,
        gate: e.gate,
        severity: e.severity,
        reason: e.reason,
      })),
      traceArchived,
      traceArchivePath: traceArchived
        ? join(sampleArchivePath, "traces")
        : null,
      isolationViolations: allViolations.map((v) => ({ kind: v.kind, detail: v.detail })),
      modelCalls,
      durationMs,
    };
    samples.push({
      entry,
      sampleArchivePath,
      attribution,
      invoke: invokeResult,
      isolationViolations: allViolations,
    });
  }

  // 生产面后置快照 + 污染检测
  const surfaceAfter = captureProductionSurface(projectRoot);
  const pollution = detectProductionSurfacePollution(surfaceBefore, surfaceAfter);
  for (const violation of pollution) {
    // 污染违规提升到所有已完成样本（run 级阻断）
    for (const sample of samples) {
      if (
        sample.entry.status === "completed" ||
        sample.entry.status === "failed"
      ) {
        sample.entry.isolationViolations.push({
          kind: violation.kind,
          detail: violation.detail,
        });
        sample.isolationViolations.push(violation);
      }
    }
  }

  const finishedAt = new Date().toISOString();
  const counted = samples.filter(
    (s) =>
      (s.entry.status === "completed" || s.entry.status === "failed") &&
      s.entry.isolationViolations.length === 0,
  );
  const manifest: ReplayRunManifestV1 = {
    schemaId: "pinovel.eval-replay-run-manifest",
    schemaVersion: 1,
    runId,
    evalProtocolVersion: "pinovel.eval-protocol/1",
    replayMode: anchorFixture?.replayMode ?? "stub",
    releaseId: anchorFixture?.provenance.releaseId ?? "",
    bundleId: anchorFixture?.provenance.bundleId ?? "",
    runRoot: runPath,
    startedAt,
    finishedAt,
    samples: samples.map((s) => s.entry),
    summary: {
      totalSamples: samples.length,
      countedSamples: counted.length,
      completed: samples.filter((s) => s.entry.status === "completed").length,
      failed: samples.filter((s) => s.entry.status === "failed").length,
      skipped: samples.filter((s) => s.entry.status.startsWith("skipped")).length,
      traceRetentionRate:
        counted.length === 0
          ? 0
          : counted.filter((s) => s.entry.traceArchived).length / counted.length,
      isolationViolationCount: samples.reduce(
        (acc, s) => acc + s.entry.isolationViolations.length,
        0,
      ),
    },
  };

  writeJson(join(runPath, "manifest.json"), manifest);

  const attributionSummary = summarizeAttributions(
    samples
      .map((s) => s.attribution)
      .filter((a): a is FailureAttributionResult => a !== null),
  );

  return {
    runId,
    runPath,
    manifest,
    samples,
    attributionSummary,
    isolationViolationCount: manifest.summary.isolationViolationCount,
  };
}
