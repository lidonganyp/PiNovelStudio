/**
 * 多租户临时 Workspace 管理器（plan §4 T4-1 / P0-4）
 *
 * 解决审计问题：
 *   - "临时 Workspace 配置未被消费"：tempWorkspaceRoot 此前仅声明不使用
 *   - "工具仍使用共享项目根目录"：所有 job 共享 NOVEL_STUDIO_PROJECT_ROOT
 *   - "未完成数据库快照物化、成功提交和失败清理"：缺三阶段生命周期
 *
 * 生命周期：
 *   1. materializeWorkspace(jobCtx, docs)
 *      - 创建 {tempWorkspaceRoot}/{jobId}/workspaces/{workspaceId}/
 *      - 按 PiNovelStudio 期望的文件结构写入输入文档：
 *          CORE-WRITING-PRINCIPLES.md   ← creative_constitution
 *          WORLDBUILDING-CANON.md       ← worldbuilding
 *          config.json                  ← project config（genre/characters/worldKeyTerms）
 *          series/outline.md            ← story_outline（可选）
 *          styles/profile.json          ← style_profile（可选）
 *          narrative-state-store.json   ← narrative_state（可选，承接前章状态）
 *          chapters/ch{N-1}.md          ← 前章正文（可选，承接连贯性）
 *      - 返回 tempProjectRoot = {tempWorkspaceRoot}/{jobId}
 *   2. 调用方（invoke.ts）将 _projectRoot 设为 tempProjectRoot
 *   3. PiNovelStudio 在 tempProjectRoot/workspaces/{workspaceId}/ 下写入章节/状态/trace
 *   4. cleanupWorkspace(jobCtx) 删除 {tempWorkspaceRoot}/{jobId}/
 *      - 成功：result 已含章节正文，调用方据此 SaveChapter；删除 temp 目录
 *      - 失败：直接删除 temp 目录，不污染正式 workspace
 *
 * 安全约束：
 *   - jobId 必须为合法路径段（^[a-zA-Z0-9-]+$），防止路径穿越
 *   - workspaceId 同样校验，且由调用方从 (userId, projectId) 派生
 *   - 所有写入使用 mkdir -p + atomicSave（tmp → rename）
 *   - 文档内容直接来自 platform-api DB（经内部 API 传入），不经客户端
 */

import { existsSync, mkdirSync, writeFileSync, rmSync, renameSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import type * as pino from "pino";

/** Workspace 文档输入（来自 platform-api 项目文档库） */
export interface WorkspaceDocument {
  /** 文档类型（与 platform-api NovelDocument 类型对齐） */
  type:
    | "creative_constitution"
    | "worldbuilding"
    | "character_profile"
    | "story_outline"
    | "style_profile"
    | "chapter_seed"
    | "explicit_outline"
    | "narrative_state";
  /** 文档内容（Markdown / JSON 字符串） */
  content: string;
}

/** 项目配置（写入 config.json） */
export interface WorkspaceProjectConfig {
  /** 题材（如 "都市玄幻"） */
  genre: string;
  /** 子题材列表 */
  subGenres?: string[];
  /** 关键术语 */
  worldKeyTerms?: string[];
  /** 角色列表（PiNovelStudio 内部使用） */
  characters?: Array<{
    name: string;
    role?: string;
    description?: string;
  }>;
  /** 任意额外字段（直接写入 config.json） */
  extra?: Record<string, unknown>;
}

/** materializeWorkspace 输入 */
export interface MaterializeWorkspaceInput {
  /** 任务 ID（用作 temp 目录名，必须为合法路径段） */
  jobId: string;
  /** workspaceId（必须为合法路径段，建议从 userId+projectId 派生） */
  workspaceId: string;
  /** 项目配置（写入 workspaces/{id}/config.json） */
  projectConfig: WorkspaceProjectConfig;
  /** 输入文档列表 */
  documents: WorkspaceDocument[];
  /** 当前章节号（用于 explicit_outline 写入 ch{N}-outline-explicit.md） */
  chapterNumber?: number;
  /** 前一章正文（可选，写入 chapters/ch{N-1}.md 用于连贯性） */
  previousChapterText?: string;
  /** 前一章序号（与 previousChapterText 配合） */
  previousChapterNumber?: number;
}

/** materializeWorkspace 输出 */
export interface MaterializedWorkspace {
  /** 写入完成的临时 projectRoot，应作为 PiNovelStudio 的 _projectRoot */
  tempProjectRoot: string;
  /** PiNovelStudio 实际使用的 workspace 目录 */
  workspacePath: string;
}

/** WorkspaceManager 构造参数 */
export interface WorkspaceManagerDeps {
  /** 临时 workspace 根目录（来自 config.tempWorkspaceRoot） */
  tempWorkspaceRoot: string;
  logger?: pino.Logger;
}

export class WorkspaceManagerError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "INVALID_JOB_ID"
      | "INVALID_WORKSPACE_ID"
      | "MATERIALIZE_FAILED"
      | "CLEANUP_FAILED",
  ) {
    super(message);
    this.name = "WorkspaceManagerError";
  }
}

/** 合法 jobId / workspaceId 校验（防路径穿越） */
const SAFE_NAME_REGEX = /^[a-zA-Z0-9_-]+$/;

function assertSafeName(name: string, field: "jobId" | "workspaceId"): void {
  if (!name || !SAFE_NAME_REGEX.test(name)) {
    throw new WorkspaceManagerError(
      `INVALID_${field.toUpperCase()}: ${field} must match [a-zA-Z0-9_-]+, got: ${name}`,
      field === "jobId" ? "INVALID_JOB_ID" : "INVALID_WORKSPACE_ID",
    );
  }
  if (name.includes("..") || name.startsWith("-")) {
    throw new WorkspaceManagerError(
      `INVALID_${field.toUpperCase()}: ${field} contains forbidden sequence`,
      field === "jobId" ? "INVALID_JOB_ID" : "INVALID_WORKSPACE_ID",
    );
  }
}

/**
 * 创建 WorkspaceManager 实例。
 *
 * 用法：
 *   const wm = createWorkspaceManager({ tempWorkspaceRoot: config.tempWorkspaceRoot });
 *   const ws = await wm.materializeWorkspace(input);
 *   try { await tool.invoke({ ...input, _projectRoot: ws.tempProjectRoot }); }
 *   finally { await wm.cleanupWorkspace(jobId); }
 */
export function createWorkspaceManager(deps: WorkspaceManagerDeps) {
  const { tempWorkspaceRoot, logger } = deps;
  const absRoot = isAbsolute(tempWorkspaceRoot)
    ? tempWorkspaceRoot
    : resolve(process.cwd(), tempWorkspaceRoot);

  return {
    /**
     * 物化临时 workspace：创建目录结构 + 写入输入文档。
     * 失败时抛 WorkspaceManagerError，调用方应据此让任务失败。
     */
    materializeWorkspace(input: MaterializeWorkspaceInput): MaterializedWorkspace {
      assertSafeName(input.jobId, "jobId");
      assertSafeName(input.workspaceId, "workspaceId");

      const tempProjectRoot = join(absRoot, input.jobId);
      const workspacePath = join(tempProjectRoot, "workspaces", input.workspaceId);

      // 防御：如果 tempProjectRoot 已存在，说明 jobId 重复或异常重试
      if (existsSync(tempProjectRoot)) {
        logger?.warn(
          { jobId: input.jobId, tempProjectRoot },
          "temp workspace already exists; possible retry — overwriting",
        );
        // 不直接删除：可能是上次失败的残留，先清理
        try {
          rmSync(tempProjectRoot, { recursive: true, force: true });
        } catch (err) {
          throw new WorkspaceManagerError(
            `MATERIALIZE_FAILED: cannot clear stale temp workspace: ${
              err instanceof Error ? err.message : String(err)
            }`,
            "MATERIALIZE_FAILED",
          );
        }
      }

      try {
        // 创建目录结构
        mkdirSync(workspacePath, { recursive: true });
        mkdirSync(join(workspacePath, "chapters"), { recursive: true });
        mkdirSync(join(workspacePath, "series"), { recursive: true });
        mkdirSync(join(workspacePath, "styles"), { recursive: true });
        mkdirSync(join(workspacePath, "traces"), { recursive: true });

        // 写入 config.json（项目级配置）
        atomicWriteJson(
          join(workspacePath, "config.json"),
          {
            genre: input.projectConfig.genre,
            subGenres: input.projectConfig.subGenres ?? [],
            worldKeyTerms: input.projectConfig.worldKeyTerms ?? [],
            characters: input.projectConfig.characters ?? [],
            ...input.projectConfig.extra,
          },
        );

        // 写入前一章正文（可选，承接连贯性）
        if (input.previousChapterText && input.previousChapterNumber && input.previousChapterNumber > 0) {
          const prevChapterPath = join(
            workspacePath,
            "chapters",
            `ch${input.previousChapterNumber}.md`,
          );
          atomicWriteText(prevChapterPath, input.previousChapterText);
        }

        // 写入各类型文档
        for (const doc of input.documents) {
          writeDocumentByType(workspacePath, doc, input.chapterNumber);
        }

        logger?.info(
          {
            jobId: input.jobId,
            workspaceId: input.workspaceId,
            workspacePath,
            documentCount: input.documents.length,
            hasPreviousChapter: !!input.previousChapterText,
          },
          "temp workspace materialized",
        );

        return { tempProjectRoot, workspacePath };
      } catch (err) {
        // 物化失败：清理已创建的部分
        try {
          rmSync(tempProjectRoot, { recursive: true, force: true });
        } catch {
          // ignore cleanup error
        }
        throw new WorkspaceManagerError(
          `MATERIALIZE_FAILED: ${
            err instanceof Error ? err.message : String(err)
          }`,
          "MATERIALIZE_FAILED",
        );
      }
    },

    /**
     * 清理临时 workspace（成功后 / 失败后均调用）。
     * 不抛错：cleanup 失败只记录日志，不阻断交付。
     */
    cleanupWorkspace(jobId: string): void {
      assertSafeName(jobId, "jobId");
      const tempProjectRoot = join(absRoot, jobId);
      if (!existsSync(tempProjectRoot)) {
        logger?.debug({ jobId }, "temp workspace already cleaned up");
        return;
      }
      try {
        rmSync(tempProjectRoot, { recursive: true, force: true });
        logger?.info({ jobId }, "temp workspace cleaned up");
      } catch (err) {
        // 不抛错——cleanup 失败不能阻断用户拿到章节
        logger?.error(
          { jobId, err: err instanceof Error ? err.message : String(err) },
          "temp workspace cleanup failed (orphan directory left; ops should sweep)",
        );
      }
    },

    /**
     * 派生安全的 workspaceId（从 userId + projectId 生成确定性 ID）。
     * 同一 (userId, projectId) 总是映射到同一 workspaceId，便于连续章节承接。
     */
    deriveWorkspaceId(userId: string | number, projectId: string | number): string {
      return `u${userId}_p${projectId}`;
    },

    /** 仅供测试：返回根目录路径 */
    _rootPath(): string {
      return absRoot;
    },
  };
}

export type WorkspaceManager = ReturnType<typeof createWorkspaceManager>;

/**
 * 按文档类型写入对应文件。
 * 与 PiNovelStudio 期望的文件结构对齐：
 *   - creative_constitution → CORE-WRITING-PRINCIPLES.md
 *   - worldbuilding         → WORLDBUILDING-CANON.md
 *   - character_profile     → characters/{name}.md（拆分；或 characters/index.md 兜底）
 *   - story_outline         → series/outline.md
 *   - style_profile         → styles/profile.json
 *   - chapter_seed          → series/chapter-seed.json
 *   - narrative_state       → narrative-state-store.json
 */
function writeDocumentByType(workspacePath: string, doc: WorkspaceDocument, chapterNumber?: number): void {
  switch (doc.type) {
    case "creative_constitution":
      atomicWriteText(join(workspacePath, "CORE-WRITING-PRINCIPLES.md"), doc.content);
      break;
    case "worldbuilding":
      atomicWriteText(join(workspacePath, "WORLDBUILDING-CANON.md"), doc.content);
      break;
    case "character_profile":
      // 单文件兜底；PiNovelStudio 内部支持单文件 characters/index.md
      mkdirSync(join(workspacePath, "characters"), { recursive: true });
      atomicWriteText(join(workspacePath, "characters", "index.md"), doc.content);
      break;
    case "story_outline":
      atomicWriteText(join(workspacePath, "series", "outline.md"), doc.content);
      break;
    case "style_profile":
      // style_profile 可能是 JSON 或 Markdown；尝试 JSON 解析失败则原样写入 styles/profile.md
      try {
        const parsed = JSON.parse(doc.content);
        atomicWriteJson(join(workspacePath, "styles", "profile.json"), parsed);
      } catch {
        atomicWriteText(join(workspacePath, "styles", "profile.md"), doc.content);
      }
      break;
    case "explicit_outline":
      // PiNovelStudio 的 loadAuthorChapterContract 从 series/ch{N}-outline-explicit.md 加载
      if (chapterNumber && chapterNumber > 0) {
        atomicWriteText(
          join(workspacePath, "series", `ch${chapterNumber}-outline-explicit.md`),
          doc.content,
        );
      } else {
        // 兜底：无章节号时写为通用文件名
        atomicWriteText(
          join(workspacePath, "series", "ch-outline-explicit.md"),
          doc.content,
        );
      }
      break;
    case "chapter_seed":
      // chapter_seed 可能是 JSON
      try {
        const parsed = JSON.parse(doc.content);
        atomicWriteJson(join(workspacePath, "series", "chapter-seed.json"), parsed);
      } catch {
        atomicWriteText(join(workspacePath, "series", "chapter-seed.md"), doc.content);
      }
      break;
    case "narrative_state":
      // narrative-state-store.json 必须是合法 JSON
      try {
        const parsed = JSON.parse(doc.content);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("narrative state must be a JSON object");
        }
        atomicWriteJson(join(workspacePath, "narrative-state-store.json"), parsed);
      } catch (error: unknown) {
        throw new Error(
          `narrative state must be valid JSON object: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      break;
  }
}

/** 原子写文本：先写 .tmp 再 rename */
function atomicWriteText(filePath: string, content: string): void {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, filePath);
}

/** 原子写 JSON */
function atomicWriteJson(filePath: string, data: unknown): void {
  atomicWriteText(filePath, JSON.stringify(data, null, 2));
}
