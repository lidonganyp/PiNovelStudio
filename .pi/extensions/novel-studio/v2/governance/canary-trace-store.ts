/**
 * CanaryTraceStore — G5 P1 canary run trace 文件 IO（EVOLUTION-RELEASE-GOVERNANCE-G5 P1）
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §G5 line 380-395
 * 计划：.trae/documents/g5-p1-bounded-canary-implementation-plan.md §shadow trace 设计
 *
 * fs 持久化层，承载 canary run 的声明性 trace 记录：
 * - writeCanaryTrace：schema 校验 + append-only 守护（同 runId 拒绝覆盖）+ 原子写入
 * - readCanaryTrace：不存在返回 null；损坏 JSON / 未知 schemaId 抛错
 * - listCanaryTracesByRelease：按 releaseId 过滤（按文件名排序）
 * - listAllCanaryTraces：返回全部（按文件名排序）
 *
 * 目录布局：
 *   {canaryRunsDir}/{runId}.json
 *
 * 模式参照 chapter-proxy-approval-registry.ts（G7）。
 *
 * 设计原则：
 * - append-only：同 runId 重复写入拒绝，不可覆盖
 * - 原子写入（temp → rename），不残留 .tmp
 * - runId 字符集守护（仅字母数字、dash、underscore）防止路径穿越
 * - 损坏 JSON / 未知 schemaId 明确抛错，不静默返回 null
 *
 * 边界（READY_LOCAL）：
 * - 不调模型、不写章节、不提交长期状态
 * - 仅写 canaryRunsDir，不触碰正式章节文件
 * - 不接入统一编排器主流程（G5 P1 是离线/CLI 工具）
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { join, resolve, relative } from "node:path";

import type { ChangeClass, ReleaseStatus } from "./evolution-release-types.js";
import type { ReleaseHealthStatus } from "./release-health-evaluator.js";
import type { CanaryStrategy } from "./canary-policy.js";

// ============================================================================
// Schema 常量
// ============================================================================

export const CANARY_RUN_TRACE_SCHEMA_ID = "pinovel.canary-run-trace" as const;
export const CANARY_RUN_TRACE_SCHEMA_VERSION = 1 as const;

// ============================================================================
// 类型
// ============================================================================

/** canary run 状态 */
export type CanaryRunStatus =
  | "shadow_started"
  | "canary_started"
  | "completed"
  | "blocked"
  | "failed";

/** canary run trace 单条记录 */
export interface CanaryRunTrace {
  schemaId: typeof CANARY_RUN_TRACE_SCHEMA_ID;
  schemaVersion: typeof CANARY_RUN_TRACE_SCHEMA_VERSION;
  /** 运行 ID（字符集 [a-zA-Z0-9_-]） */
  runId: string;
  /** 目标 release ID */
  releaseId: string;
  /** 前序 release ID（用于回滚参考） */
  previousReleaseId: string | null;
  /** workspace ID */
  workspaceId: string;
  /** 开始时间（ISO） */
  startedAt: string;
  /** 完成时间（ISO）；未完成为 null */
  completedAt: string | null;
  /** 决策策略 */
  strategy: CanaryStrategy;
  /** 运行状态 */
  status: CanaryRunStatus;
  /** 健康快照（决策时的健康状态） */
  healthSnapshot: {
    status: ReleaseHealthStatus;
    alignmentRate: number;
    sampleCount: number;
    rollbackRate: number;
    consecutiveNegative: number;
  };
  /** 证据 */
  evidence: {
    changeClass: ChangeClass;
    currentStatus: ReleaseStatus;
    /** 授权 ID（bounded_canary 时填充） */
    authorizationId?: string;
    /** completed trace 对应的 started trace。 */
    sourceRunId?: string;
    /** 完成态证据绑定的环境指纹。 */
    environmentFingerprint?: string;
    /** 完成态证据绑定的审批 artifact。 */
    approvalRef?: string;
    /** 真实 canary 的最终判定。 */
    verdict?: "pass" | "fail";
    /** 真实 canary 实际观察的章节数。 */
    observedChapters?: number;
    /** 真实 canary 实际消耗的模型调用数。 */
    observedCalls?: number;
    /** 冻结的真实结果 artifact 引用。 */
    resultArtifactRefs?: string[];
    /** resultArtifactRefs 对应的 SHA-256，防止完成后篡改。 */
    resultArtifactHashes?: Record<string, string>;
    /**
     * Phase 5.1：canary 实际暴露的叙事工具模式。
     * 必须与 workspace 授权 toolMode 一致（"facade" 或 "standard"）。
     * 用于证明这次 bounded canary 确实在受控暴露面下执行。
     */
    toolMode?: "standard" | "facade";
    /**
     * Phase 5.1：实际使用的模型指纹（模型版本隔离）。
     * 记录检测到的模型版本 + 各 provider 调用分布，证明本次 canary 的模型证据可复现。
     */
    modelFingerprint?: {
      /** 检测到的模型版本（detectModelVersion 结果，如 gemini31 / claude / stub） */
      detectedModel: string;
      /** provider → 调用次数分布 */
      providers: Record<string, number>;
      /** 模型调用总次数 */
      modelCalls: number;
    };
    /**
     * Phase 5.1：失败指标证据（empty/truncated/errors/timeouts 分桶）。
     * 证明 canary 不是"只记录成功"——失败证据被显式捕获并冻结。
     */
    failureMetrics?: {
      total: number;
      /** 空文本失败数 */
      empty: number;
      /** 截断失败数 */
      truncated: number;
      /** 错误/异常数 */
      error: number;
      /** 超时失败数 */
      timeout: number;
      /** 阻断率（blocked+error）/ total */
      blockRate: number;
      /** 首次成功率 */
      firstPassSuccessRate: number;
      /** 恢复成功率（无恢复尝试时为 null） */
      recoverySuccessRate: number | null;
    };
  };
  /** 结果 */
  outcome: {
    promoted: boolean;
    heldByAutoHold: boolean;
    autoHoldEventId?: string;
    errorReason?: string;
  };
  /** P1 READY_LOCAL 标记：声明性 trace，真实双生成推迟 P2 */
  shadowPendingRealRun?: boolean;
}

/** CanaryTraceStore 选项 */
export interface CanaryTraceStoreOptions {
  /** canary runs 根目录（workspaces/{id}/canary-runs/ 或测试临时目录） */
  canaryRunsDir?: string;
  workspacePath?: string;
}

/** CanaryTraceStore API */
export interface CanaryTraceStore {
  /** 写入 trace；schema 校验失败 / 同 runId 已存在 抛错 */
  writeCanaryTrace(trace: CanaryRunTrace): void;
  /** 读取 trace；不存在返回 null；损坏 JSON / 未知 schemaId 抛错 */
  readCanaryTrace(runId: string): CanaryRunTrace | null;
  /** 按 releaseId 查询所有 trace（按文件名排序） */
  listCanaryTracesByRelease(releaseId: string): CanaryRunTrace[];
  /** 返回全部 trace（按文件名排序） */
  listAllCanaryTraces(): CanaryRunTrace[];
}

// ============================================================================
// 辅助
// ============================================================================

/** runId 安全字符集（仅字母数字、dash、underscore；禁止路径分隔符、点、空格） */
const SAFE_RUN_ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * 防目录穿越：校验 runId 字符集，
 * 并确保 resolve 后路径仍位于 canaryRunsDir 内。
 */
function assertSafeRunId(canaryRunsDir: string, runId: string): void {
  if (
    typeof runId !== "string" ||
    runId.length === 0 ||
    !SAFE_RUN_ID_RE.test(runId)
  ) {
    throw new Error(
      `runId 含非法字符或为空（仅允许字母数字、dash、underscore）：${JSON.stringify(runId)}`,
    );
  }
  const resolved = resolve(canaryRunsDir, `${runId}.json`);
  const rel = relative(canaryRunsDir, resolved);
  if (rel.startsWith("..") || resolve(canaryRunsDir, rel) !== resolved) {
    throw new Error(
      `runId 路径穿越检测：resolve 后路径 ${resolved} 不在 ${canaryRunsDir} 内`,
    );
  }
}

function tracePath(canaryRunsDir: string, runId: string): string {
  assertSafeRunId(canaryRunsDir, runId);
  return join(canaryRunsDir, `${runId}.json`);
}

/** 原子写入：temp → rename。 */
function atomicWrite(filePath: string, content: string): void {
  const tmpPath = filePath + ".tmp";
  writeFileSync(tmpPath, content, "utf-8");
  renameSync(tmpPath, filePath);
}

/** 解析 trace JSON + schema 校验。损坏数据明确抛错。 */
function parseTrace(raw: string, filePath: string): CanaryRunTrace {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`canary trace JSON 解析失败（${filePath}）：${(e as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`canary trace 必须是对象（${filePath}）`);
  }
  const trace = parsed as CanaryRunTrace;
  if (
    trace.schemaId !== CANARY_RUN_TRACE_SCHEMA_ID ||
    trace.schemaVersion !== CANARY_RUN_TRACE_SCHEMA_VERSION
  ) {
    throw new Error(
      `canary trace schema 不匹配（${filePath}）：expected schemaId=${CANARY_RUN_TRACE_SCHEMA_ID}, schemaVersion=${CANARY_RUN_TRACE_SCHEMA_VERSION}`,
    );
  }
  return trace;
}

// ============================================================================
// createCanaryTraceStore
// ============================================================================

export function createCanaryTraceStore(
  options: CanaryTraceStoreOptions,
): CanaryTraceStore {
  const canaryRunsDir = options.canaryRunsDir ?? join(options.workspacePath ?? "", "canary-runs");

  function ensureDir(): void {
    if (!existsSync(canaryRunsDir)) {
      mkdirSync(canaryRunsDir, { recursive: true });
    }
  }

  function writeCanaryTrace(trace: CanaryRunTrace): void {
    // runId 安全检查
    assertSafeRunId(canaryRunsDir, trace.runId);

    ensureDir();
    const path = tracePath(canaryRunsDir, trace.runId);

    // append-only：同 runId 已存在拒绝
    if (existsSync(path)) {
      throw new Error(
        `canary trace 已存在（append-only）：runId=${trace.runId} already exists，重复写入被拒绝`,
      );
    }

    // 原子写入
    atomicWrite(path, JSON.stringify(trace, null, 2) + "\n");
  }

  function readCanaryTrace(runId: string): CanaryRunTrace | null {
    const path = tracePath(canaryRunsDir, runId);
    if (!existsSync(path)) {
      return null;
    }
    const raw = readFileSync(path, "utf-8");
    return parseTrace(raw, path);
  }

  function listAllCanaryTraces(): CanaryRunTrace[] {
    if (!existsSync(canaryRunsDir)) {
      return [];
    }
    // 按文件名排序（保持写入顺序的可预测近似）
    const entries = readdirSync(canaryRunsDir)
      .filter((name) => name.endsWith(".json") && !name.endsWith(".tmp.json"))
      .sort();
    const result: CanaryRunTrace[] = [];
    for (const name of entries) {
      const filePath = join(canaryRunsDir, name);
      const raw = readFileSync(filePath, "utf-8");
      result.push(parseTrace(raw, filePath));
    }
    return result;
  }

  function listCanaryTracesByRelease(releaseId: string): CanaryRunTrace[] {
    if (!/^[a-zA-Z0-9_-]+$/.test(releaseId)) {
      throw new Error("releaseId 非法：仅允许 [a-zA-Z0-9_-]");
    }
    return listAllCanaryTraces().filter((t) => t.releaseId === releaseId);
  }

  return {
    writeCanaryTrace,
    readCanaryTrace,
    listCanaryTracesByRelease,
    listAllCanaryTraces,
  };
}
