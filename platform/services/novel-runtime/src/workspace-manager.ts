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
 *          chapters/chapter-{N-1}.md    ← 前章正文（可选，承接连贯性）
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

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, renameSync, readdirSync } from "node:fs";
import { join, resolve, isAbsolute, dirname } from "node:path";
import type * as pino from "pino";

/** Workspace 文档输入（来自 platform-api 项目文档库） */
export interface WorkspaceDocument {
  /** 文档类型（与 platform-api NovelDocument 类型对齐） */
  type:
    | "creative_constitution"
    | "worldbuilding"
    | "character_profile"
    | "story_outline"
    /** 大纲全文副本，仅供 FactGuard 术语授权；不进提示词，避免裁剪导致误判未授权新设定 */
    | "story_outline_full"
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
  /**
   * @deprecated 生产路径禁止传全文。若仍传入，只会抽取续接摘要，不会落盘章节正文。
   */
  previousChapterText?: string;
  /** 前一章序号（与 continuation 配合） */
  previousChapterNumber?: number;
  /** 前章续接（正式生成路径）；不得含全文 */
  previousChapterContinuation?: PreviousChapterContinuation;
  /** 编译清单，写入 traces，不进入正文模型 */
  contextManifest?: unknown;
}

export interface PreviousChapterContinuation {
  chapterNumber: number;
  endingState: string;
  lastSceneSummary: string;
  changedCharacters: string[];
  unresolvedPromises: string[];
  tailExcerpt?: string;
  sourceChapterHash: string;
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
  /**
   * 失败归档根目录（来自 config.workspaceArchiveRoot；空串时 derive 为
   * tempWorkspaceRoot 同级的 `novel-runtime-archive`）。
   */
  workspaceArchiveRoot?: string;
  /**
   * Release-bound source for immutable runtime assets such as the frozen
   * capability package set. Missing assets intentionally remain missing so
   * the production extension fails closed instead of silently using defaults.
   */
  capabilityPackageSourceRoot?: string;
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
  const capabilityPackageSourceRoot = deps.capabilityPackageSourceRoot
    ? (isAbsolute(deps.capabilityPackageSourceRoot)
        ? deps.capabilityPackageSourceRoot
        : resolve(process.cwd(), deps.capabilityPackageSourceRoot))
    : undefined;
  const absRoot = isAbsolute(tempWorkspaceRoot)
    ? tempWorkspaceRoot
    : resolve(process.cwd(), tempWorkspaceRoot);
  const absArchiveRoot = deps.workspaceArchiveRoot && deps.workspaceArchiveRoot.trim() !== ""
    ? (isAbsolute(deps.workspaceArchiveRoot)
        ? deps.workspaceArchiveRoot
        : resolve(process.cwd(), deps.workspaceArchiveRoot))
    : join(dirname(absRoot), "novel-runtime-archive");

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
        mkdirSync(join(workspacePath, "chapter-continuity"), { recursive: true });

        // The extension resolves the frozen capability package set relative
        // to the per-job project root. Copy the release-bound asset into that
        // root; do not synthesize it when the source is absent, preserving the
        // production fail-closed contract.
        const capabilityPackageSource = capabilityPackageSourceRoot
          ? join(capabilityPackageSourceRoot, "data", "runtime", "capability-package-set.json")
          : undefined;
        if (capabilityPackageSource && existsSync(capabilityPackageSource)) {
          const capabilityPackageTarget = join(
            tempProjectRoot,
            "data",
            "runtime",
            "capability-package-set.json",
          );
          mkdirSync(dirname(capabilityPackageTarget), { recursive: true });
          copyFileSync(capabilityPackageSource, capabilityPackageTarget);
        }

        // 写入 config.json（项目级配置）
        atomicWriteJson(
          join(workspacePath, "config.json"),
          {
            genre: (input.projectConfig.genre ?? "").trim(),
            subGenres: input.projectConfig.subGenres ?? [],
            worldKeyTerms: input.projectConfig.worldKeyTerms ?? [],
            characters: input.projectConfig.characters ?? [],
            ...input.projectConfig.extra,
          },
        );

        // 写入各类型文档
        for (const doc of input.documents) {
          writeDocumentByType(workspacePath, doc, input.chapterNumber);
        }
        const continuation = resolveContinuation(input);
        if (continuation) {
          writeChapterContinuitySnapshot(workspacePath, continuation);
        }
        if (input.contextManifest) {
          atomicWriteJson(join(workspacePath, "traces", "context-manifest.json"), input.contextManifest);
        }

        logger?.info(
          {
            jobId: input.jobId,
            workspaceId: input.workspaceId,
            workspacePath,
            documentCount: input.documents.length,
            hasPreviousChapterContinuation: Boolean(continuation),
            wrotePreviousChapterText: false,
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
     * 归档临时 workspace（生成失败时调用）：把 {tempWorkspaceRoot}/{jobId}/
     * rename 到 {archiveRoot}/{jobId}/，保留 traces/ 等失败证据。
     * 成功返回归档路径；失败（如 rename 不支持跨盘）返回 undefined，
     * 调用方应回退到 cleanupWorkspace。
     */
    archiveWorkspace(jobId: string): string | undefined {
      assertSafeName(jobId, "jobId");
      const tempProjectRoot = join(absRoot, jobId);
      if (!existsSync(tempProjectRoot)) {
        logger?.debug({ jobId }, "temp workspace already gone; nothing to archive");
        return undefined;
      }
      const archivePath = join(absArchiveRoot, jobId);
      try {
        mkdirSync(absArchiveRoot, { recursive: true });
        // 同 jobId 重复失败时覆盖旧归档
        if (existsSync(archivePath)) {
          rmSync(archivePath, { recursive: true, force: true });
        }
        renameSync(tempProjectRoot, archivePath);
        logger?.info({ jobId, archivePath }, "failed workspace archived (traces preserved)");
        return archivePath;
      } catch (err) {
        logger?.warn(
          { jobId, archivePath, err: err instanceof Error ? err.message : String(err) },
          "workspace archive failed; caller should fall back to cleanup",
        );
        return undefined;
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

    /** Persist post-call usage alongside the input context manifest. */
    updateContextManifest(jobId: string, manifest: unknown): void {
      assertSafeName(jobId, "jobId");
      const manifestPath = join(absRoot, jobId, "workspaces");
      if (!existsSync(manifestPath)) return;
      const workspaceEntries = readdirSync(manifestPath, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
      for (const workspaceId of workspaceEntries) {
        const traceDir = join(manifestPath, workspaceId, "traces");
        if (existsSync(traceDir)) {
          atomicWriteJson(join(traceDir, "context-manifest.json"), manifest);
          return;
        }
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
 *   - story_outline_full    → series/outline-full.md（仅 FactGuard 授权读取）
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
    case "story_outline_full":
      atomicWriteText(join(workspacePath, "series", "outline-full.md"), doc.content);
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

function resolveContinuation(input: MaterializeWorkspaceInput): PreviousChapterContinuation | null {
  if (input.previousChapterContinuation && input.previousChapterContinuation.chapterNumber > 0) {
    return input.previousChapterContinuation;
  }
  if (input.previousChapterText && input.previousChapterNumber && input.previousChapterNumber > 0) {
    const tail = excerptLastSentences(input.previousChapterText);
    return {
      chapterNumber: input.previousChapterNumber,
      endingState: tail,
      lastSceneSummary: tail,
      changedCharacters: [],
      unresolvedPromises: [],
      tailExcerpt: tail,
      sourceChapterHash: createHash("sha256").update(input.previousChapterText, "utf8").digest("hex").slice(0, 12),
    };
  }
  return null;
}

function excerptLastSentences(text: string, maxChars = 160): string {
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  if (!trimmed) return "";
  const sentences = trimmed
    .split(/(?<=[。！？!?])\s*/)
    .map((item) => item.trim())
    .filter(Boolean);
  const tail: string[] = [];
  let used = 0;
  for (let index = sentences.length - 1; index >= 0; index -= 1) {
    const sentence = sentences[index];
    if (used > 0 && used + sentence.length > maxChars) break;
    tail.unshift(sentence);
    used += sentence.length;
    if (tail.length >= 2) break;
  }
  return tail.join("");
}

function writeChapterContinuitySnapshot(
  workspacePath: string,
  continuation: PreviousChapterContinuation,
): void {
  const statePath = join(workspacePath, "narrative-state-store.json");
  const openHooks = [...continuation.unresolvedPromises];
  const introducedCharacters = [...continuation.changedCharacters];
  if (existsSync(statePath) && openHooks.length === 0) {
    try {
      const parsed = JSON.parse(readFileSync(statePath, "utf-8")) as {
        promise?: Array<{ description?: string; status?: string }>;
        character?: Array<{ characterId?: string }>;
      };
      for (const item of parsed.promise ?? []) {
        if (!item?.description?.trim()) continue;
        const status = item.status ?? "open";
        if (status === "open" || status === "advancing" || status === "delayed") {
          openHooks.push(item.description.trim());
        }
      }
      for (const item of parsed.character ?? []) {
        if (item.characterId) introducedCharacters.push(item.characterId);
      }
    } catch {
      /* 快照是 advisory，解析失败不阻断 */
    }
  }
  atomicWriteJson(join(workspacePath, "chapter-continuity", `${continuation.chapterNumber}.json`), {
    chapterNumber: continuation.chapterNumber,
    openHooks: [...new Set(openHooks)].slice(0, 12),
    introducedCharacters: [...new Set(introducedCharacters)],
    unresolvedTensions: [...new Set(openHooks)].slice(0, 12),
    lastEventSummary: continuation.lastSceneSummary || continuation.tailExcerpt || continuation.endingState,
    finalTextHash: continuation.sourceChapterHash,
    sourceRefs: [`chapter-continuity/${continuation.chapterNumber}.json`],
    createdAt: new Date().toISOString(),
  });
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
