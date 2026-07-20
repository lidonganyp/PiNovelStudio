/**
 * ReleaseProxyApprovalRegistry — 审批 artifact fs 持久化（EVOLUTION-RELEASE-GOVERNANCE-1B）
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §6 / Phase G4
 *
 * fs 持久化层，委托 schema 校验给纯函数（release-proxy-approval-schema.ts）。提供：
 * - writeArtifact：schema 校验 + append-only 守护（同 approvalId 拒绝覆盖）+ 原子写入
 * - loadArtifact：损坏 JSON / 未知 schemaId 明确抛错
 * - listByReleaseId：按 releaseId 查询所有审批
 * - loadAppendOnlyIndex：append-only 索引（jsonl）
 * - getLatestApprovalForRelease：取最新审批（按写入顺序）
 *
 * 目录布局：
 *   {approvalsDir}/{approvalId}.json       —— 单个 artifact
 *   {approvalsDir}/approvals-index.jsonl   —— append-only 索引
 *
 * 设计原则：
 * - append-only：同 approvalId 重复写入拒绝，不可覆盖（防止事后篡改审批结果）
 * - 只写 approvalsDir，不触碰外部文件（不修改用户 WIP）
 * - 原子写入（temp → rename），不残留 .tmp
 * - 损坏 JSON / 未知 schemaId 明确抛错，不静默返回 null
 *
 * 边界（READY_LOCAL；真实模型调用 REQUIRES_AUTH）：
 * - 不调用模型、不保存章节、不提交长期状态
 * - 不进入生产闭包（仅 dist-test/，未来 Phase G6 才接入生产）
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";

import {
  validateApprovalArtifact,
} from "./release-proxy-approval-schema.js";
import {
  PROXY_APPROVAL_SCHEMA_ID,
} from "./release-proxy-approval-types.js";
import type { ReleaseProxyApprovalArtifact } from "./release-proxy-approval-types.js";

// ============================================================================
// 类型
// ============================================================================

export interface ProxyApprovalRegistryOptions {
  /** approvals 根目录（reports/evolution-releases/{releaseId}/approvals/ 或测试临时目录） */
  approvalsDir: string;
}

export interface ProxyApprovalRegistry {
  /** 写入 artifact；schema 校验失败 / 同 approvalId 已存在 抛错 */
  writeArtifact(artifact: ReleaseProxyApprovalArtifact): void;
  /** 读取 artifact；不存在返回 null；损坏 JSON / 未知 schemaId 抛错 */
  loadArtifact(approvalId: string): ReleaseProxyApprovalArtifact | null;
  /** 按 releaseId 查询所有审批（按写入顺序） */
  listByReleaseId(releaseId: string): ReleaseProxyApprovalArtifact[];
  /** 读取 append-only 索引（jsonl） */
  loadAppendOnlyIndex(): Array<{ approvalId: string; releaseId: string; finalVerdict: string; timestamp: string }>;
  /** 取该 release 的最新审批（按写入顺序最后一条） */
  getLatestApprovalForRelease(releaseId: string): ReleaseProxyApprovalArtifact | null;
}

// ============================================================================
// 辅助
// ============================================================================

/**
 * approvalId 安全字符集（P1-2 路径穿越守护）。
 * 只允许 [a-zA-Z0-9_-]，禁止 / ..\ 等可逃逸 approvalsDir 的字符。
 */
const APPROVAL_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * 校验 approvalId 字符集，防止路径穿越。
 * 在所有接受外部 approvalId 的公开函数入口调用。
 */
function assertSafeApprovalId(approvalId: string): void {
  if (typeof approvalId !== "string" || approvalId.length === 0) {
    throw new Error(`approvalId 非法：必须为非空字符串`);
  }
  if (!APPROVAL_ID_PATTERN.test(approvalId)) {
    throw new Error(
      `approvalId 非法：包含不允许的字符（仅允许 [a-zA-Z0-9_-]）：${JSON.stringify(approvalId)}`,
    );
  }
}

function artifactPath(approvalsDir: string, approvalId: string): string {
  return join(approvalsDir, `${approvalId}.json`);
}

function indexPath(approvalsDir: string): string {
  return join(approvalsDir, "approvals-index.jsonl");
}

/** 原子写入：temp → rename。 */
function atomicWrite(filePath: string, content: string): void {
  const tmpPath = filePath + ".tmp";
  writeFileSync(tmpPath, content, "utf-8");
  renameSync(tmpPath, filePath);
}

// ============================================================================
// createProxyApprovalRegistry
// ============================================================================

export function createProxyApprovalRegistry(
  options: ProxyApprovalRegistryOptions,
): ProxyApprovalRegistry {
  const { approvalsDir } = options;

  function ensureDir(): void {
    if (!existsSync(approvalsDir)) {
      mkdirSync(approvalsDir, { recursive: true });
    }
  }

  function appendIndex(entry: {
    approvalId: string;
    releaseId: string;
    finalVerdict: string;
    timestamp: string;
  }): void {
    ensureDir();
    const ixPath = indexPath(approvalsDir);
    const line = JSON.stringify(entry) + "\n";
    // append-only：直接追加
    writeFileSync(ixPath, line, { flag: "a", encoding: "utf-8" });
  }

  function writeArtifact(artifact: ReleaseProxyApprovalArtifact): void {
    // P1-2 路径穿越守护
    assertSafeApprovalId(artifact.approvalId);
    // schema 校验
    const validation = validateApprovalArtifact(artifact);
    if (!validation.ok) {
      throw new Error(`审批 artifact schema 校验失败：${validation.error.message}`);
    }

    ensureDir();
    const path = artifactPath(approvalsDir, artifact.approvalId);

    // append-only：同 approvalId 已存在拒绝
    if (existsSync(path)) {
      throw new Error(
        `审批 artifact 已存在（append-only，不可覆盖）：approvalId=${artifact.approvalId}`,
      );
    }

    // 原子写入
    atomicWrite(path, JSON.stringify(artifact, null, 2));

    // 追加索引
    appendIndex({
      approvalId: artifact.approvalId,
      releaseId: artifact.releaseId,
      finalVerdict: artifact.finalVerdict,
      timestamp: artifact.decidedAt,
    });
  }

  function loadArtifact(approvalId: string): ReleaseProxyApprovalArtifact | null {
    // P1-2 路径穿越守护
    assertSafeApprovalId(approvalId);
    const path = artifactPath(approvalsDir, approvalId);
    if (!existsSync(path)) {
      return null;
    }
    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
    } catch (e) {
      throw new Error(`读取审批 artifact 失败：approvalId=${approvalId}，${(e as Error).message}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(`审批 artifact JSON 解析失败：approvalId=${approvalId}，${(e as Error).message}`);
    }
    // schema 校验（损坏数据明确抛错）
    const validation = validateApprovalArtifact(parsed);
    if (!validation.ok) {
      // 未知 schemaId 单独抛错信息含 schema
      throw new Error(
        `审批 artifact schema 校验失败：approvalId=${approvalId}，${validation.error.message}`,
      );
    }
    return validation.artifact;
  }

  function loadAppendOnlyIndex(): Array<{
    approvalId: string;
    releaseId: string;
    finalVerdict: string;
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
      releaseId: string;
      finalVerdict: string;
      timestamp: string;
    }> = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (e) {
        throw new Error(`approvals-index.jsonl 第 ${i + 1} 行 JSON 解析失败：${(e as Error).message}`);
      }
      const obj = parsed as Record<string, unknown>;
      if (
        typeof obj.approvalId !== "string" ||
        typeof obj.releaseId !== "string" ||
        typeof obj.finalVerdict !== "string" ||
        typeof obj.timestamp !== "string"
      ) {
        throw new Error(`approvals-index.jsonl 第 ${i + 1} 行字段缺失或类型错误`);
      }
      result.push({
        approvalId: obj.approvalId,
        releaseId: obj.releaseId,
        finalVerdict: obj.finalVerdict,
        timestamp: obj.timestamp,
      });
    }
    return result;
  }

  function listByReleaseId(releaseId: string): ReleaseProxyApprovalArtifact[] {
    if (!existsSync(approvalsDir)) {
      return [];
    }
    // 通过索引顺序加载，保持写入顺序
    const index = loadAppendOnlyIndex();
    const result: ReleaseProxyApprovalArtifact[] = [];
    for (const entry of index) {
      if (entry.releaseId === releaseId) {
        const a = loadArtifact(entry.approvalId);
        if (a) result.push(a);
      }
    }
    return result;
  }

  function getLatestApprovalForRelease(
    releaseId: string,
  ): ReleaseProxyApprovalArtifact | null {
    const list = listByReleaseId(releaseId);
    if (list.length === 0) return null;
    return list[list.length - 1];
  }

  return {
    writeArtifact,
    loadArtifact,
    listByReleaseId,
    loadAppendOnlyIndex,
    getLatestApprovalForRelease,
  };
}
