/**
 * BatchGenerationHandler — 批量章节生成入口 handler
 *
 * 解析 action（start / resume / status / cancel），调用 orchestrator，返回状态结构。
 *
 * 同步执行：start / resume 阻塞直到任务完成 / 暂停 / 取消。
 *
 * action 行为：
 * - start：校验范围 → 获取锁 → 创建 BatchJobState → runBatchGeneration → 释放锁
 * - resume：校验 jobId + status=paused → 获取锁 → runBatchGeneration → 释放锁
 * - status：加载 BatchJobState 返回（不获取锁，不执行生成）
 * - cancel：设置 cancelRequested=true 原子保存（不主动中断运行循环）
 *
 * BATCH-P0-01 / BATCH-P1-01
 */

import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "fs";
import { join } from "node:path";
import { getProjectRoot } from "../utils/config.js";
import {
  generateJobId,
  batchJobPath,
  loadBatchJobStore,
  saveBatchJobStore,
  DEFAULT_MAX_CHAPTERS,
  LARGE_BATCH_MAX_CHAPTERS,
  type BatchJobState,
  type BatchChapterResult,
} from "../v2/core/batch-generation-job-store.js";
// 显式 import 以确保 orchestrator / lock 模块进入生产闭包（dist/）。
import { runBatchGeneration } from "../v2/core/batch-generation-orchestrator.js";
import { acquireBatchLock, releaseBatchLock } from "../v2/core/batch-generation-lock.js";

// ============================================================================
// 类型
// ============================================================================

export type BatchAction = "start" | "resume" | "status" | "cancel";

export interface BatchGenerationInput {
  mode: "batch";
  action: BatchAction;
  workspaceId: string;
  // action="start" 必填
  startChapter?: number;
  endChapter?: number;
  seedSource?: "workspace_or_planner" | "workspace_only";
  stopOnFailure?: boolean;
  confirmLargeBatch?: boolean;
  // action="resume"|"status"|"cancel" 必填
  jobId?: string;
  // 测试注入（不公开）
  _projectRoot?: string;
  _mockGenerateChapter?: (input: {
    workspaceId: string;
    chapterId: string;
    chapterNumber: number;
    _projectRoot?: string;
  }) => Promise<any>;
}

export interface BatchGenerationResult {
  status: "running" | "completed" | "paused" | "cancelled" | "error";
  jobId: string;
  currentChapter: number | null;
  completedChapters: number;
  totalChapters: number;
  failedChapter: number | null;
  checkpointPath: string;
  /** 暂停/失败时的诊断信息 */
  failureEnvelope?: unknown;
  summary?: import("../v2/core/batch-generation-job-store.js").BatchJobSummary;
}

// ============================================================================
// Handler
// ============================================================================

/**
 * 批量章节生成入口 handler。
 *
 * 由 register-tools.ts:invoke() 在 mode === "batch" 时调用。
 * 内部解析 action，委托 batch-generation-orchestrator.ts:runBatchGeneration 执行。
 */
export async function handleBatchGeneration(
  input: BatchGenerationInput,
): Promise<BatchGenerationResult> {
  const projectRoot = input._projectRoot || getProjectRoot();

  switch (input.action) {
    case "start":
      return handleStart(input, projectRoot);
    case "resume":
      return handleResume(input, projectRoot);
    case "status":
      return handleStatus(input, projectRoot);
    case "cancel":
      return handleCancel(input, projectRoot);
    default:
      return errorResult(input, projectRoot, `未知 action: ${input.action}`);
  }
}

// ============================================================================
// action: start
// ============================================================================

async function handleStart(
  input: BatchGenerationInput,
  projectRoot: string,
): Promise<BatchGenerationResult> {
  const { workspaceId } = input;
  const startChapter = input.startChapter!;
  const endChapter = input.endChapter!;

  // 1. 范围校验
  if (!Number.isInteger(startChapter) || !Number.isInteger(endChapter)) {
    return errorResult(input, projectRoot, "startChapter / endChapter 必须为整数");
  }
  if (startChapter < 1) {
    return errorResult(input, projectRoot, "startChapter 必须 ≥ 1");
  }
  if (endChapter < startChapter) {
    return errorResult(input, projectRoot, "endChapter 必须 ≥ startChapter");
  }

  // 2. 上限校验
  const total = endChapter - startChapter + 1;
  if (total > LARGE_BATCH_MAX_CHAPTERS) {
    return errorResult(
      input, projectRoot,
      `批量范围 ${total} 章超过硬上限 ${LARGE_BATCH_MAX_CHAPTERS} 章`,
    );
  }
  if (total > DEFAULT_MAX_CHAPTERS && !input.confirmLargeBatch) {
    return errorResult(
      input, projectRoot,
      `批量范围 ${total} 章超过默认上限 ${DEFAULT_MAX_CHAPTERS} 章，需设置 confirmLargeBatch=true 确认`,
    );
  }

  // 3. 扩展 preflight 检查（BATCH-P1-04：缺世界观/角色档案/前章状态在生成前阻断）
  const prereqCheck = checkBatchPrerequisites(workspaceId, startChapter, projectRoot);
  if (!prereqCheck.ok) {
    return errorResult(input, projectRoot, prereqCheck.reason);
  }

  // 4. ChapterSeed 检查 + 可选规划（BATCH-P1-03：workspace_or_planner 模式可规划种子）
  const seedCheck = checkChapterSeedAvailable(workspaceId, startChapter, projectRoot);
  if (!seedCheck.ok) {
    if ((input.seedSource ?? "workspace_or_planner") === "workspace_or_planner") {
      // P1-03：规划阶段生成结构化种子（不输出正文）
      const planResult = planBatchChapterSeeds(workspaceId, startChapter, endChapter, projectRoot);
      if (!planResult.ok) {
        return errorResult(input, projectRoot, planResult.reason);
      }
    } else {
      // workspace_only 模式：无种子则阻断
      return errorResult(input, projectRoot, seedCheck.reason);
    }
  }

  // 5. 生成 jobId
  const jobId = input.jobId || generateJobId();

  // 6. 获取 workspace 级锁（BATCH-P0-09）
  const lockResult = acquireBatchLock(workspaceId, jobId, projectRoot);
  if (!lockResult.ok) {
    return {
      ...errorResult(input, projectRoot, lockResult.reason, jobId),
      failureEnvelope: {
        stage: "batch_lock",
        severity: "error",
        reason: lockResult.reason,
        recoverable: false,
        existingLock: lockResult.existingLock,
      },
    };
  }

  try {
    // 7. 创建初始 BatchJobState
    const now = new Date().toISOString();
    const chapters: BatchChapterResult[] = [];
    for (let i = 0; i < total; i++) {
      chapters.push({
        chapterNumber: startChapter + i,
        chapterId: String(startChapter + i),
        status: "pending" as const,
      });
    }
    const state: BatchJobState = {
      jobId,
      workspaceId,
      status: "running",
      startChapter,
      endChapter,
      seedSource: input.seedSource ?? "workspace_or_planner",
      stopOnFailure: input.stopOnFailure ?? true,
      confirmLargeBatch: input.confirmLargeBatch ?? false,
      createdAt: now,
      updatedAt: now,
      frontier: startChapter,
      completedChapters: [],
      failedChapter: null,
      chapters,
      cancelRequested: false,
    };
    saveBatchJobStore(state, workspaceId, jobId, projectRoot);

    // 8. 运行批量编排（同步阻塞直到完成/暂停/取消）
    const { state: finalState } = await runBatchGeneration({
      state,
      projectRoot,
      mockGenerateChapter: input._mockGenerateChapter,
    });

    return toResult(finalState, projectRoot);
  } finally {
    // 9. 释放锁（无论成功/失败/暂停）
    releaseBatchLock(workspaceId, projectRoot);
  }
}

// ============================================================================
// action: resume
// ============================================================================

async function handleResume(
  input: BatchGenerationInput,
  projectRoot: string,
): Promise<BatchGenerationResult> {
  const { workspaceId, jobId } = input;
  if (!jobId) {
    return errorResult(input, projectRoot, "resume 需要 jobId 参数");
  }

  // 1. 加载 state
  const store = loadBatchJobStore(workspaceId, jobId, projectRoot);
  if (!store) {
    return errorResult(input, projectRoot, `jobId ${jobId} 不存在`, jobId);
  }
  const state = store.state;

  // 2. 已完成的任务 resume → 幂等返回 completed（不重复调用模型）
  if (state.status === "completed") {
    return toResult(state, projectRoot);
  }

  // 3. 只允许 paused 状态 resume（cancelled/error/running 拒绝）
  if (state.status !== "paused") {
    return errorResult(
      input, projectRoot,
      `任务状态为 ${state.status}，只有 paused 状态才能 resume`,
      jobId,
    );
  }

  // 3. 获取锁
  const lockResult = acquireBatchLock(workspaceId, jobId, projectRoot);
  if (!lockResult.ok) {
    return {
      ...errorResult(input, projectRoot, lockResult.reason, jobId),
      failureEnvelope: {
        stage: "batch_lock",
        severity: "error",
        reason: lockResult.reason,
        recoverable: false,
        existingLock: lockResult.existingLock,
      },
    };
  }

  try {
    // 4. 设置 running，保存
    state.status = "running";
    state.updatedAt = new Date().toISOString();
    saveBatchJobStore(state, workspaceId, jobId, projectRoot);

    // 5. 运行批量编排
    const { state: finalState } = await runBatchGeneration({
      state,
      projectRoot,
      mockGenerateChapter: input._mockGenerateChapter,
    });

    return toResult(finalState, projectRoot);
  } finally {
    releaseBatchLock(workspaceId, projectRoot);
  }
}

// ============================================================================
// action: status
// ============================================================================

function handleStatus(
  input: BatchGenerationInput,
  projectRoot: string,
): BatchGenerationResult {
  const { workspaceId, jobId } = input;
  if (!jobId) {
    return errorResult(input, projectRoot, "status 需要 jobId 参数");
  }

  const store = loadBatchJobStore(workspaceId, jobId, projectRoot);
  if (!store) {
    return errorResult(input, projectRoot, `jobId ${jobId} 不存在`, jobId);
  }
  return toResult(store.state, projectRoot);
}

// ============================================================================
// action: cancel
// ============================================================================

function handleCancel(
  input: BatchGenerationInput,
  projectRoot: string,
): BatchGenerationResult {
  const { workspaceId, jobId } = input;
  if (!jobId) {
    return errorResult(input, projectRoot, "cancel 需要 jobId 参数");
  }

  const store = loadBatchJobStore(workspaceId, jobId, projectRoot);
  if (!store) {
    return errorResult(input, projectRoot, `jobId ${jobId} 不存在`, jobId);
  }
  const state = store.state;

  // 设置 cancelRequested；paused 升级为 cancelled
  state.cancelRequested = true;
  if (state.status === "paused") {
    state.status = "cancelled";
  }
  state.updatedAt = new Date().toISOString();
  saveBatchJobStore(state, workspaceId, jobId, projectRoot);

  // 不删除任何文件（cancel 不破坏已完成章节）
  return toResult(state, projectRoot);
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 将 BatchJobState 映射为 BatchGenerationResult。
 */
function toResult(state: BatchJobState, projectRoot: string): BatchGenerationResult {
  const failedChapterResult = state.failedChapter !== null
    ? state.chapters.find((c) => c?.chapterNumber === state.failedChapter)
    : undefined;
  return {
    status: state.status,
    jobId: state.jobId,
    currentChapter: state.frontier <= state.endChapter ? state.frontier : null,
    completedChapters: state.completedChapters.length,
    totalChapters: state.endChapter - state.startChapter + 1,
    failedChapter: state.failedChapter,
    checkpointPath: batchJobPath(state.workspaceId, state.jobId, projectRoot),
    failureEnvelope: failedChapterResult?.failureEnvelope,
    summary: state.summary,
  };
}

/**
 * 构造校验失败的 BatchGenerationResult。
 */
function errorResult(
  input: BatchGenerationInput,
  projectRoot: string,
  reason: string,
  jobId?: string,
): BatchGenerationResult {
  const total = input.endChapter && input.startChapter
    ? input.endChapter - input.startChapter + 1
    : 0;
  return {
    status: "error",
    jobId: jobId ?? input.jobId ?? "",
    currentChapter: null,
    completedChapters: 0,
    totalChapters: total,
    failedChapter: null,
    checkpointPath: jobId
      ? batchJobPath(input.workspaceId, jobId, projectRoot)
      : "",
    failureEnvelope: {
      stage: "batch_handler",
      severity: "error",
      reason,
      recoverable: false,
    },
  };
}

/**
 * ChapterSeed 阻断检查（BATCH-P1-04）。
 *
 * 检查 workspace 是否有可用的章节种子来源：
 *   1. config.json 含非空 chapterSeeds
 *   2. series/ch{startChapter}-outline-explicit.md 存在
 *
 * 两者都不满足 → 阻断（不调用模型）。
 */
function checkChapterSeedAvailable(
  workspaceId: string,
  startChapter: number,
  projectRoot: string,
): { ok: true } | { ok: false; reason: string } {
  const workspacePath = join(projectRoot, "workspaces", workspaceId);

  // 1. config.json 含 chapterSeeds
  const configPath = join(workspacePath, "config.json");
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      if (
        config?.chapterSeeds &&
        typeof config.chapterSeeds === "object" &&
        Object.keys(config.chapterSeeds).length > 0
      ) {
        return { ok: true };
      }
    } catch {
      // config 损坏 → 落到下一条检查
    }
  }

  // 2. series/ch{startChapter}-outline-explicit.md 存在
  const explicitOutlinePath = join(
    workspacePath, "series", `ch${startChapter}-outline-explicit.md`,
  );
  if (existsSync(explicitOutlinePath)) {
    return { ok: true };
  }

  return {
    ok: false,
    reason: `workspace ${workspaceId} 缺少 ChapterSeed 来源：config.json 无 chapterSeeds 且无 series/ch${startChapter}-outline-explicit.md。请补充种子源（不提示补章纲）。`,
  };
}

// ============================================================================
// P1-04：扩展 preflight 检查
// ============================================================================

/**
 * 扩展 preflight 检查（BATCH-P1-04）。
 *
 * 在批量生成前检查 workspace 必备前置条件：
 *   1. config.json 存在且含 genre（世界观）
 *   2. characters/ 目录存在且非空（角色档案）
 *   3. startChapter > 1 时，narrative-state-store.json 必须存在（前章状态）
 *
 * 任一不满足 → 阻断（不调用模型）。
 *
 * 注意：此检查在 ChapterSeed 检查之前执行——种子可以规划，
 * 但世界观/角色档案/前章状态是不可规划的前置条件。
 */
function checkBatchPrerequisites(
  workspaceId: string,
  startChapter: number,
  projectRoot: string,
): { ok: true } | { ok: false; reason: string } {
  const workspacePath = join(projectRoot, "workspaces", workspaceId);

  // 1. config.json 含 genre（世界观）
  const configPath = join(workspacePath, "config.json");
  if (!existsSync(configPath)) {
    return {
      ok: false,
      reason: `workspace ${workspaceId} 缺少 config.json，无法确认世界观（genre）。请补全 workspace 配置。`,
    };
  }
  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    if (
      !config?.genre ||
      typeof config.genre !== "string" ||
      config.genre.trim().length === 0
    ) {
      return {
        ok: false,
        reason: `workspace ${workspaceId} config.json 缺少 genre（世界观）字段。世界观缺失 = 生产阻断，必须补全后再生成。`,
      };
    }
  } catch {
    return {
      ok: false,
      reason: `workspace ${workspaceId} config.json 解析失败，无法确认世界观（genre）。`,
    };
  }

  // 2. characters/ 目录存在且非空（角色档案）
  const charactersDir = join(workspacePath, "characters");
  if (!existsSync(charactersDir)) {
    return {
      ok: false,
      reason: `workspace ${workspaceId} 缺少 characters/ 角色档案目录。角色档案是生成前必需前置条件。`,
    };
  }
  let characterFiles: string[] = [];
  try {
    characterFiles = readdirSync(charactersDir).filter(
      (f) => f.endsWith(".md") || f.endsWith(".json"),
    );
  } catch {
    // 读取失败视为空
  }
  if (characterFiles.length === 0) {
    return {
      ok: false,
      reason: `workspace ${workspaceId} characters/ 目录为空，缺少角色档案。角色档案是生成前必需前置条件。`,
    };
  }

  // 3. startChapter > 1 时，narrative-state-store.json 必须存在（前章状态）
  if (startChapter > 1) {
    const stateStorePath = join(workspacePath, "narrative-state-store.json");
    if (!existsSync(stateStorePath)) {
      return {
        ok: false,
        reason: `workspace ${workspaceId} startChapter=${startChapter} > 1 但缺少 narrative-state-store.json（前章状态）。请先生成前序章节或补全前章状态。`,
      };
    }
  }

  return { ok: true };
}

// ============================================================================
// P1-03：ChapterSeed 规划阶段
// ============================================================================

/**
 * ChapterSeed 规划阶段（BATCH-P1-03）。
 *
 * 当 seedSource="workspace_or_planner" 且 workspace 无 ChapterSeed 时，
 * 生成结构化种子文件（JSON，非正文）。
 *
 * 种子文件路径：workspaces/{id}/batch-jobs/planned-seeds/ch{N}.json
 *
 * 种子内容（结构化，不含正文）：
 * - chapterNumber / chapterId
 * - chapterFunction（按位置推断：setup / escalation / payoff / climax）
 * - chapterTheme（从 outline.md 提取，无则占位）
 * - characters（从 config.json 提取）
 * - worldConstraint（从 config.json genre/subGenres 构造）
 * - intent（含 _source: "chapterSeed"）
 * - plannedAt
 *
 * 严禁输出正文（prose / text / body 字段）。
 */
function planBatchChapterSeeds(
  workspaceId: string,
  startChapter: number,
  endChapter: number,
  projectRoot: string,
): { ok: true } | { ok: false; reason: string } {
  const workspacePath = join(projectRoot, "workspaces", workspaceId);

  // 读取 config.json（genre/subGenres/characters）
  const configPath = join(workspacePath, "config.json");
  let config: any = {};
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return {
      ok: false,
      reason: `workspace ${workspaceId} config.json 解析失败，无法规划种子。`,
    };
  }

  const genre = config?.genre ?? "未指定";
  const subGenres: string[] = Array.isArray(config?.subGenres)
    ? config.subGenres
    : [];
  const characters: Array<{ id: string; name: string; role?: string }> =
    Array.isArray(config?.characters)
      ? config.characters.map((c: any) => ({
          id: c?.id ?? c?.name ?? "",
          name: c?.name ?? "",
          role: c?.role,
        }))
      : [];

  // 读取 outline.md（提取章节主题）
  const outlinePath = join(workspacePath, "series", "outline.md");
  let outlineThemes: Map<number, string> = new Map();
  if (existsSync(outlinePath)) {
    try {
      const outlineText = readFileSync(outlinePath, "utf-8");
      outlineThemes = extractChapterThemesFromOutline(outlineText);
    } catch {
      // outline 读取失败 → 主题占位
    }
  }

  // 创建 planned-seeds 目录
  const seedsDir = join(workspacePath, "batch-jobs", "planned-seeds");
  try {
    mkdirSync(seedsDir, { recursive: true });
  } catch {
    return {
      ok: false,
      reason: `无法创建 planned-seeds 目录: ${seedsDir}`,
    };
  }

  // 为每章生成结构化种子
  const total = endChapter - startChapter + 1;
  const now = new Date().toISOString();
  for (let i = 0; i < total; i++) {
    const chapterNumber = startChapter + i;
    const chapterId = `ch${chapterNumber}`;
    const chapterFunction = inferChapterFunction(i, total);
    const chapterTheme =
      outlineThemes.get(chapterNumber) ?? `第${chapterNumber}章（待细化）`;
    const seed = {
      chapterNumber,
      chapterId,
      chapterFunction,
      chapterTheme,
      characters,
      worldConstraint: {
        genre,
        subGenres,
      },
      intent: {
        primary: chapterTheme,
        _source: "chapterSeed",
      },
      plannedAt: now,
    };
    const seedPath = join(seedsDir, `${chapterId}.json`);
    try {
      writeFileSync(seedPath, JSON.stringify(seed, null, 2), "utf-8");
    } catch {
      return {
        ok: false,
        reason: `无法写入种子文件: ${seedPath}`,
      };
    }
  }

  return { ok: true };
}

/**
 * 从 outline.md 提取章节主题。
 *
 * 匹配 "## 第N章" 标题，提取该行后的标题文本；
 * 标题行为空时取下一行非空内容作为主题。
 */
function extractChapterThemesFromOutline(
  outlineText: string,
): Map<number, string> {
  const themes = new Map<number, string>();
  const lines = outlineText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^#+\s*第\s*(\d+)\s*章[：:？:]?\s*(.*)$/);
    if (match) {
      const num = parseInt(match[1], 10);
      const title = match[2].trim();
      if (title) {
        themes.set(num, title);
      } else if (i + 1 < lines.length) {
        // 标题行为空 → 取下一行非空内容
        const next = lines[i + 1].trim();
        if (next && !next.startsWith("#")) {
          themes.set(num, next);
        }
      }
    }
  }
  return themes;
}

/**
 * 按章节在批量范围中的位置推断 chapterFunction。
 *
 * - 第 1 章（开头）：setup
 * - 最后一章：climax（总章数 > 1）或 payoff（单章）
 * - 倒数第 2 章：payoff
 * - 其余：escalation
 */
function inferChapterFunction(index: number, total: number): string {
  if (total <= 1) return "payoff";
  if (index === 0) return "setup";
  if (index === total - 1) return "climax";
  if (index === total - 2) return "payoff";
  return "escalation";
}
