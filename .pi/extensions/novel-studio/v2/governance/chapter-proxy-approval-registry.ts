/**
 * ChapterProxyApprovalRegistry — 章节代理审批 artifact fs 持久化（EVOLUTION-RELEASE-GOVERNANCE-G7）
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §6.3 / §7 / Phase G7
 *
 * fs 持久化层，委托 schema 校验给纯函数（chapter-proxy-approval-schema.ts）。提供：
 * - writeArtifact：schema 校验 + append-only 守护（同 approvalId 拒绝覆盖）+ 原子写入
 * - loadArtifact：损坏 JSON / 未知 schemaId 明确抛错
 * - listArtifactsByChapter：按 (workspaceId, chapterId) 查询所有审批（按写入顺序）
 * - listArtifactsByRelease：按 releaseId 查询所有审批（用于 release 健康度归集）
 * - loadAppendOnlyIndex：append-only 索引（jsonl）
 *
 * 目录布局：
 *   {approvalsDir}/{approvalId}.json       —— 单个 artifact
 *   {approvalsDir}/approvals-index.jsonl   —— append-only 索引
 *
 * 设计原则：
 * - append-only：同 approvalId 重复写入拒绝，不可覆盖（防止事后篡改审批结果）
 * - 只写 approvalsDir，不触碰正式章节文件、不写长期状态、不推进 frontier
 * - 原子写入（temp → rename），不残留 .tmp
 * - 损坏 JSON / 未知 schemaId 明确抛错，不静默返回 null
 *
 * 与 ReleaseProxyApprovalRegistry 的隔离：
 * - 不复用 release 级 approvalsDir / index 文件；
 * - 章节级审批 artifact 与 release 级审批 artifact 物理隔离，便于独立审计与回滚。
 *
 * 边界（READY_LOCAL；真实模型调用 REQUIRES_AUTH）：
 * - 不调用模型、不保存章节、不提交长期状态
 * - 不进入生产闭包（仅 dist-test/，未来 G7 后续切片才接入正式编排器）
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
} from "node:fs";
import { join, resolve, relative } from "node:path";

import {
  validateChapterApprovalArtifact,
} from "./chapter-proxy-approval-schema.js";
import {
  CHAPTER_PROXY_APPROVAL_SCHEMA_ID,
} from "./chapter-proxy-approval-types.js";
import type { ChapterProxyApprovalArtifact } from "./chapter-proxy-approval-types.js";

// ============================================================================
// 类型
// ============================================================================

export interface ChapterProxyApprovalRegistryOptions {
  /** approvals 根目录（workspaces/{id}/chapter-approvals/ 或测试临时目录） */
  approvalsDir: string;
}

export interface ChapterProxyApprovalRegistry {
  /** 写入 artifact；schema 校验失败 / 同 approvalId 已存在 抛错 */
  writeArtifact(artifact: ChapterProxyApprovalArtifact): void;
  /** 读取 artifact；不存在返回 null；损坏 JSON / 未知 schemaId 抛错 */
  loadArtifact(approvalId: string): ChapterProxyApprovalArtifact | null;
  /** 按 (workspaceId, chapterId) 查询所有审批（按写入顺序） */
  listArtifactsByChapter(workspaceId: string, chapterId: string): ChapterProxyApprovalArtifact[];
  /** 按 releaseId 查询所有审批（按写入顺序，用于 release 健康度归集） */
  listArtifactsByRelease(releaseId: string): ChapterProxyApprovalArtifact[];
  /** 读取 append-only 索引（jsonl） */
  loadAppendOnlyIndex(): Array<{
    approvalId: string;
    workspaceId: string;
    chapterId: string;
    releaseId: string;
    finalStatus: string;
    timestamp: string;
  }>;
}

// ============================================================================
// 辅助
// ============================================================================

/** P0: approvalId 安全字符集（仅字母数字、dash、underscore；禁止路径分隔符、点、空格） */
const SAFE_APPROVAL_ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * P0 防目录穿越（G7-P0-ARTIFACT-INTEGRITY-1）：校验 approvalId 字符集，
 * 并确保 resolve 后路径仍位于 approvalsDir 内。
 * 防止 approvalId='../escaped' 等在 approvalsDir 外创建/读取文件。
 */
function assertSafeApprovalId(approvalsDir: string, approvalId: string): void {
  if (typeof approvalId !== "string" || approvalId.length === 0 || !SAFE_APPROVAL_ID_RE.test(approvalId)) {
    throw new Error(`approvalId 含非法字符或为空（仅允许字母数字、dash、underscore）：${JSON.stringify(approvalId)}`);
  }
  const resolved = resolve(approvalsDir, `${approvalId}.json`);
  const rel = relative(approvalsDir, resolved);
  if (rel.startsWith("..") || resolve(approvalsDir, rel) !== resolved) {
    throw new Error(`approvalId 路径穿越检测：resolve 后路径 ${resolved} 不在 ${approvalsDir} 内`);
  }
}

function artifactPath(approvalsDir: string, approvalId: string): string {
  assertSafeApprovalId(approvalsDir, approvalId);
  return join(approvalsDir, `${approvalId}.json`);
}

function indexPath(approvalsDir: string): string {
  return join(approvalsDir, "chapter-approvals-index.jsonl");
}

/** 原子写入：temp → rename。 */
function atomicWrite(filePath: string, content: string): void {
  const tmpPath = filePath + ".tmp";
  writeFileSync(tmpPath, content, "utf-8");
  renameSync(tmpPath, filePath);
}

// ============================================================================
// createChapterProxyApprovalRegistry
// ============================================================================

export function createChapterProxyApprovalRegistry(
  options: ChapterProxyApprovalRegistryOptions,
): ChapterProxyApprovalRegistry {
  const { approvalsDir } = options;

  function ensureDir(): void {
    if (!existsSync(approvalsDir)) {
      mkdirSync(approvalsDir, { recursive: true });
    }
  }

  function appendIndex(entry: {
    approvalId: string;
    workspaceId: string;
    chapterId: string;
    releaseId: string;
    finalStatus: string;
    timestamp: string;
  }): void {
    ensureDir();
    const ixPath = indexPath(approvalsDir);
    const line = JSON.stringify(entry) + "\n";
    // append-only：直接追加
    writeFileSync(ixPath, line, { flag: "a", encoding: "utf-8" });
  }

  function writeArtifact(artifact: ChapterProxyApprovalArtifact): void {
    // schema 校验
    const validation = validateChapterApprovalArtifact(artifact);
    if (!validation.ok) {
      throw new Error(`章节审批 artifact schema 校验失败：${validation.error.message}`);
    }

    ensureDir();
    const path = artifactPath(approvalsDir, artifact.approvalId);

    // append-only：同 approvalId 已存在拒绝（防止事后篡改审批结果）
    if (existsSync(path)) {
      throw new Error(
        `章节审批 artifact 已存在（append-only）：approvalId=${artifact.approvalId} already exists，重复写入被拒绝`,
      );
    }

    // 原子写入
    atomicWrite(path, JSON.stringify(artifact, null, 2));

    // 追加索引
    appendIndex({
      approvalId: artifact.approvalId,
      workspaceId: artifact.workspaceId,
      chapterId: artifact.chapterId,
      releaseId: artifact.releaseId,
      finalStatus: artifact.finalStatus,
      timestamp: artifact.decidedAt,
    });
  }

  function loadArtifact(approvalId: string): ChapterProxyApprovalArtifact | null {
    const path = artifactPath(approvalsDir, approvalId);
    if (!existsSync(path)) {
      return null;
    }
    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
    } catch (e) {
      throw new Error(`读取章节审批 artifact 失败：approvalId=${approvalId}，${(e as Error).message}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(`章节审批 artifact JSON 解析失败：approvalId=${approvalId}，${(e as Error).message}`);
    }
    // schema 校验（损坏数据明确抛错）
    const validation = validateChapterApprovalArtifact(parsed);
    if (!validation.ok) {
      // 未知 schemaId 单独抛错信息含 schema
      if (validation.error.code === "unknown_schema") {
        throw new Error(
          `章节审批 artifact schemaId 未知：approvalId=${approvalId}，expected=${CHAPTER_PROXY_APPROVAL_SCHEMA_ID}，${validation.error.message}`,
        );
      }
      throw new Error(
        `章节审批 artifact schema 校验失败：approvalId=${approvalId}，${validation.error.message}`,
      );
    }
    return validation.artifact;
  }

  function loadAppendOnlyIndex(): Array<{
    approvalId: string;
    workspaceId: string;
    chapterId: string;
    releaseId: string;
    finalStatus: string;
    timestamp: string;
  }> {
    const ixPath = indexPath(approvalsDir);
    if (!existsSync(ixPath)) {
      return [];
    }
    const raw = readFileSync(ixPath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    const result: Array<{
      approvalId: string;
      workspaceId: string;
      chapterId: string;
      releaseId: string;
      finalStatus: string;
      timestamp: string;
    }> = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (e) {
        throw new Error(`chapter-approvals-index.jsonl 第 ${i + 1} 行 JSON 解析失败：${(e as Error).message}`);
      }
      const obj = parsed as Record<string, unknown>;
      if (
        typeof obj.approvalId !== "string" ||
        typeof obj.workspaceId !== "string" ||
        typeof obj.chapterId !== "string" ||
        typeof obj.releaseId !== "string" ||
        typeof obj.finalStatus !== "string" ||
        typeof obj.timestamp !== "string"
      ) {
        throw new Error(`chapter-approvals-index.jsonl 第 ${i + 1} 行字段缺失或类型错误`);
      }
      result.push({
        approvalId: obj.approvalId,
        workspaceId: obj.workspaceId,
        chapterId: obj.chapterId,
        releaseId: obj.releaseId,
        finalStatus: obj.finalStatus,
        timestamp: obj.timestamp,
      });
    }
    return result;
  }

  function listArtifactsByChapter(
    workspaceId: string,
    chapterId: string,
  ): ChapterProxyApprovalArtifact[] {
    if (!existsSync(approvalsDir)) {
      return [];
    }
    // 通过索引顺序加载，保持写入顺序
    const index = loadAppendOnlyIndex();
    const result: ChapterProxyApprovalArtifact[] = [];
    for (const entry of index) {
      if (entry.workspaceId === workspaceId && entry.chapterId === chapterId) {
        const a = loadArtifact(entry.approvalId);
        if (a) result.push(a);
      }
    }
    return result;
  }

  function listArtifactsByRelease(
    releaseId: string,
  ): ChapterProxyApprovalArtifact[] {
    if (!existsSync(approvalsDir)) {
      return [];
    }
    const index = loadAppendOnlyIndex();
    const result: ChapterProxyApprovalArtifact[] = [];
    for (const entry of index) {
      if (entry.releaseId === releaseId) {
        const a = loadArtifact(entry.approvalId);
        if (a) result.push(a);
      }
    }
    return result;
  }

  return {
    writeArtifact,
    loadArtifact,
    listArtifactsByChapter,
    listArtifactsByRelease,
    loadAppendOnlyIndex,
  };
}
