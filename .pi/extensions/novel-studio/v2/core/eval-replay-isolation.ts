/**
 * ReplayIsolationGuard — 五级回放隔离层（离线回放与生产验收闭环 P1）
 *
 * 目标：确保离线回放永远不会污染正式生产状态。
 *
 * 隔离策略：
 *  1. 所有回放默认写入 scratch workspace（mkdtemp 隔离根），不写
 *     {projectRoot}/workspaces 正式区；
 *  2. 真实模型回放（dev_real_model / production_like）强制携带
 *     evalOnly=true + releaseId + bundleId + evalProtocolVersion +
 *     traceArchivePath，缺失任一 → fail-closed；
 *  3. 生产面（release pointer / 正式 workspaces）在回放前后做内容快照
 *     对照，任何 hash / 条目变化都构成隔离违规；
 *  4. scratch 根写入标记文件（.eval-scratch-marker.json），用于运行时
 *     识别 scratch 身份，防止把正式 workspace 误当 scratch 使用。
 *
 * 本地确定性，无 LLM 调用。
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  EVAL_PROTOCOL_VERSION,
  REAL_MODEL_REPLAY_MODES,
  type EvalFixtureV1,
  type ReplayMode,
} from "./eval-fixture-contract.js";
import { resolveProductionEvolutionRoot } from "../governance/production-release-gate.js";

// ============================================================================
// 隔离违规类型
// ============================================================================

export type IsolationViolationKind =
  | "missing_isolation_fields"
  | "production_pointer_mutation"
  | "formal_chapter_save"
  | "narrative_state_commit"
  | "strategy_reputation_update"
  | "user_feedback_write"
  | "formal_release"
  | "path_escape"
  | "scratch_marker_missing"
  | "scratch_marker_mismatch"
  /** F1：fixture 声明未知 modelRoute（真实模型回放不得静默回退开发缺省）。 */
  | "model_route_unresolved"
  /** F1：production_like 前置生产 release gate 验证失败（主仓真实治理状态）。 */
  | "production_release_gate_mismatch";

export interface IsolationViolation {
  kind: IsolationViolationKind;
  detail: string;
  /** 证据（路径 / hash 对照等结构化内容）。 */
  evidence?: unknown;
}

// ============================================================================
// 真实模型回放强制隔离字段
// ============================================================================

/**
 * 校验真实模型回放的强制隔离字段（fail-closed）。
 *
 * dev_real_model / production_like 模式必须携带：
 *   - fixture.evalOnly === true（parseEvalFixtureV1 已强制）；
 *   - fixture.provenance.releaseId / bundleId 非空；
 *   - fixture.evalProtocolVersion === EVAL_PROTOCOL_VERSION（同上）；
 *   - fixture.traceArchivePath 非空。
 * stub / recorded / synthetic 模式同样要求这些字段存在（契约层已强制），
 * 本函数额外校验 production_like 的 releaseId 必须指向非 dev 命名空间。
 */
export function validateReplayIsolationPrerequisites(fixture: EvalFixtureV1): {
  ok: boolean;
  violations: IsolationViolation[];
} {
  const violations: IsolationViolation[] = [];

  if (fixture.evalOnly !== true) {
    violations.push({
      kind: "missing_isolation_fields",
      detail: "fixture.evalOnly 必须为字面量 true",
    });
  }
  if (fixture.evalProtocolVersion !== EVAL_PROTOCOL_VERSION) {
    violations.push({
      kind: "missing_isolation_fields",
      detail: `evalProtocolVersion 必须为 ${EVAL_PROTOCOL_VERSION}`,
    });
  }
  if (fixture.provenance.releaseId.trim().length === 0) {
    violations.push({ kind: "missing_isolation_fields", detail: "provenance.releaseId 缺失" });
  }
  if (fixture.provenance.bundleId.trim().length === 0) {
    violations.push({ kind: "missing_isolation_fields", detail: "provenance.bundleId 缺失" });
  }
  if (fixture.traceArchivePath.trim().length === 0) {
    violations.push({ kind: "missing_isolation_fields", detail: "traceArchivePath 缺失" });
  }

  if (fixture.replayMode === "production_like") {
    // production_like 回放的 release 必须是正式 release 命名空间（rel-prod-*），
    // dev release（rel-dev-*）不得用于生产等价回放。
    if (!/^rel-prod-/.test(fixture.provenance.releaseId)) {
      violations.push({
        kind: "missing_isolation_fields",
        detail:
          "production_like 回放的 releaseId 必须指向 rel-prod-* 正式 release 命名空间",
        evidence: { releaseId: fixture.provenance.releaseId },
      });
    }
  }

  return { ok: violations.length === 0, violations };
}

// ============================================================================
// 子进程隔离环境变量契约
// ============================================================================

/** 真实模型回放子进程必须携带的环境变量（P1 强制）。 */
export interface ReplayIsolationEnv {
  PINOVEL_EVAL_ONLY: "1";
  PINOVEL_EVAL_PROTOCOL_VERSION: string;
  PINOVEL_EVAL_RELEASE_ID: string;
  PINOVEL_EVAL_BUNDLE_ID: string;
  PINOVEL_EVAL_TRACE_ARCHIVE_PATH: string;
  PINOVEL_DEV_MODE: "1";
  /**
   * F4-4：确定性回放传输标记（stub/recorded/synthetic 模式强制携带）。
   * - V2_FORCE_STUB=1 兜底：确定性模式下任何传输 env 丢失都不得触网；
   * - PINOVEL_EVAL_REPLAY_TRANSPORT 声明模式，unified-entry 据此做
   *   fail-closed 完整性校验（防传输 env 丢失后静默回退 stub/网络）。
   */
  V2_FORCE_STUB?: "1";
  PINOVEL_EVAL_REPLAY_TRANSPORT?: "stub" | "recorded" | "synthetic";
}

/**
 * 构造回放子进程的隔离 env（合并到 process.env 之上）。
 * 真实模型模式必须包含全部隔离字段，缺失 → 抛错（fail-closed）。
 *
 * scratchDataRoot 非空时设置 PINOVEL_PROJECT_ROOT，使子进程把数据根
 * 解析到 scratch 隔离根（要求 scratch 已物化项目标记，见
 * materializeScratchProjectSkeleton）。
 */
export function buildReplayIsolationEnv(
  fixture: EvalFixtureV1,
  base?: NodeJS.ProcessEnv,
  scratchDataRoot?: string,
): ReplayIsolationEnv & NodeJS.ProcessEnv {
  const prereq = validateReplayIsolationPrerequisites(fixture);
  if (REAL_MODEL_REPLAY_MODES.includes(fixture.replayMode) && !prereq.ok) {
    throw new Error(
      `真实模型回放隔离字段校验失败（fail-closed）：${prereq.violations
        .map((v) => v.detail)
        .join("; ")}`,
    );
  }
  const env: ReplayIsolationEnv & NodeJS.ProcessEnv = {
    ...base,
    PINOVEL_EVAL_ONLY: "1",
    PINOVEL_EVAL_PROTOCOL_VERSION: fixture.evalProtocolVersion,
    PINOVEL_EVAL_RELEASE_ID: fixture.provenance.releaseId,
    PINOVEL_EVAL_BUNDLE_ID: fixture.provenance.bundleId,
    PINOVEL_EVAL_TRACE_ARCHIVE_PATH: fixture.traceArchivePath,
    // F1 语义修正：回放子进程运行在 DEV_MODE（scratch 隔离根没有主仓治理面，
    // 子进程内 release gate 无法在 scratch 复刻；伪造治理数据不可接受）。
    // production_like 的生产 release gate 验证由 Runner 层以主仓真实治理状态
    // 前置承担（verifyProductionLikeReleaseGate），生产模型路由等价性由
    // invoke 脚本的 eval 隔离路由策略（PINOVEL_EVAL_ONLY=1 不缺省注入 GLM）
    // + fixture.provenance.modelRoute 显式参数共同保证。
    PINOVEL_DEV_MODE: "1",
    ...(scratchDataRoot ? { PINOVEL_PROJECT_ROOT: scratchDataRoot } : {}),
  };
  // F4-4：stub/recorded/synthetic 是确定性回放模式，统一携带传输标记。
  // 传输 env 本身（recorded 结果文件 / synthetic 故障计划）由 Runner 物化
  // 后附加到子进程 env（见 full-pipeline-replay-runner）。
  if (
    fixture.replayMode === "stub" ||
    fixture.replayMode === "recorded" ||
    fixture.replayMode === "synthetic"
  ) {
    env.V2_FORCE_STUB = "1";
    env.PINOVEL_EVAL_REPLAY_TRANSPORT = fixture.replayMode;
  }
  return env;
}

/**
 * 校验环境变量是否携带完整隔离字段（供 fail-closed 断言使用）。
 */
export function assertReplayIsolationEnv(
  env: NodeJS.ProcessEnv,
  options?: { requireRealModelFields?: boolean },
): { ok: boolean; violations: IsolationViolation[] } {
  const violations: IsolationViolation[] = [];
  const required: Array<[string, string]> = [
    ["PINOVEL_EVAL_ONLY", "1"],
    ["PINOVEL_EVAL_PROTOCOL_VERSION", EVAL_PROTOCOL_VERSION],
  ];
  if (options?.requireRealModelFields) {
    required.push(
      ["PINOVEL_EVAL_RELEASE_ID", ""],
      ["PINOVEL_EVAL_BUNDLE_ID", ""],
      ["PINOVEL_EVAL_TRACE_ARCHIVE_PATH", ""],
    );
  }
  for (const [key, expected] of required) {
    const actual = env[key];
    if (actual === undefined || (expected !== "" && actual !== expected) || (expected === "" && (actual ?? "").trim().length === 0)) {
      violations.push({
        kind: "missing_isolation_fields",
        detail:
          expected === ""
            ? `环境变量 ${key} 缺失或为空（真实模型回放强制字段）`
            : `环境变量 ${key} 必须为 ${expected}`,
        evidence: { key, actual },
      });
    }
  }
  return { ok: violations.length === 0, violations };
}

// ============================================================================
// Scratch workspace 生命周期
// ============================================================================

export const SCRATCH_MARKER_FILENAME = ".eval-scratch-marker.json";

/** scratch 默认父目录：{projectRoot}/.pi/eval-scratch（可注入覆盖）。 */
export function defaultScratchParentDir(projectRoot: string): string {
  return join(projectRoot, ".pi", "eval-scratch");
}

export interface ScratchWorkspaceLease {
  /** 租约 ID（scratch run 目录名后缀）。 */
  leaseId: string;
  /** 本次回放的 scratch 数据根（子进程的 data projectRoot）。 */
  scratchRoot: string;
  /** scratch 内的 workspace 身份（形如 eval-{mode}-{fixtureId}-{suffix}）。 */
  workspaceId: string;
  /** {scratchRoot}/workspaces/{workspaceId}。 */
  workspacePath: string;
  /** 标记文件路径。 */
  markerPath: string;
  fixtureId: string;
  replayMode: ReplayMode;
  /** 真实项目根（生产面对照用，只读）。 */
  sourceProjectRoot: string;
  createdAt: string;
}

export interface CreateScratchWorkspaceOptions {
  /** 真实项目根（只读，用于生产面快照对照与默认 scratch 父目录解析）。 */
  projectRoot: string;
  /** 已通过 parseEvalFixtureV1 校验的 fixture。 */
  fixture: EvalFixtureV1;
  /** scratch 父目录；默认 {projectRoot}/.pi/eval-scratch。 */
  scratchParentDir?: string;
}

function sanitizeScratchToken(value: string): string {
  // 白名单与工具侧 workspaceId 校验正则 /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/ 对齐：
  // 不允许 "."（fixtureId 常见 "fixture.xxx" 形态会生成非法 workspaceId，
  // 导致子进程 Preflight 拒绝）。
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "fixture";
}

/**
 * 创建 scratch workspace 租约。
 *
 *  1. 在 scratch 父目录下 mkdtemp 隔离 run 目录；
 *  2. 分配 eval- 前缀 workspaceId（与正式 workspace 命名空间隔离）；
 *  3. 写入标记文件，记录 fixture 身份与隔离声明。
 */
export function createScratchWorkspace(
  options: CreateScratchWorkspaceOptions,
): ScratchWorkspaceLease {
  const scratchParent = options.scratchParentDir ?? defaultScratchParentDir(options.projectRoot);
  mkdirSync(scratchParent, { recursive: true });
  const scratchRoot = mkdtempSync(join(scratchParent, "run-"));
  const leaseId = scratchRoot.split(sep).pop() ?? `run-${Date.now()}`;
  const workspaceId = `eval-${sanitizeScratchToken(options.fixture.replayMode)}-${sanitizeScratchToken(
    options.fixture.fixtureId,
  )}-${leaseId}`;
  const workspacePath = join(scratchRoot, "workspaces", workspaceId);
  mkdirSync(workspacePath, { recursive: true });

  const markerPath = join(scratchRoot, SCRATCH_MARKER_FILENAME);
  writeFileSync(
    markerPath,
    JSON.stringify(
      {
        marker: "pinovel.eval-scratch",
        markerVersion: 1,
        evalOnly: true,
        evalProtocolVersion: options.fixture.evalProtocolVersion,
        fixtureId: options.fixture.fixtureId,
        replayMode: options.fixture.replayMode,
        releaseId: options.fixture.provenance.releaseId,
        bundleId: options.fixture.provenance.bundleId,
        traceArchivePath: options.fixture.traceArchivePath,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf-8",
  );

  return {
    leaseId,
    scratchRoot,
    workspaceId,
    workspacePath,
    markerPath,
    fixtureId: options.fixture.fixtureId,
    replayMode: options.fixture.replayMode,
    sourceProjectRoot: options.projectRoot,
    createdAt: new Date().toISOString(),
  };
}

export interface ScratchMarkerContent {
  marker: "pinovel.eval-scratch";
  markerVersion: number;
  evalOnly: boolean;
  evalProtocolVersion: string;
  fixtureId: string;
  replayMode: string;
  releaseId: string;
  bundleId: string;
  traceArchivePath: string;
  createdAt: string;
}

/**
 * 读取并校验 scratch 根的标记文件。
 * 标记缺失 / 内容不符 → 返回违规（调用方必须 fail-closed）。
 */
export function readScratchMarker(
  scratchRoot: string,
  expect?: { fixtureId?: string; releaseId?: string },
): { ok: boolean; marker: ScratchMarkerContent | null; violations: IsolationViolation[] } {
  const violations: IsolationViolation[] = [];
  const markerPath = join(scratchRoot, SCRATCH_MARKER_FILENAME);
  if (!existsSync(markerPath)) {
    return {
      ok: false,
      marker: null,
      violations: [
        { kind: "scratch_marker_missing", detail: `scratch 标记文件缺失：${markerPath}` },
      ],
    };
  }
  let marker: ScratchMarkerContent;
  try {
    marker = JSON.parse(readFileSync(markerPath, "utf-8")) as ScratchMarkerContent;
  } catch (error) {
    return {
      ok: false,
      marker: null,
      violations: [
        {
          kind: "scratch_marker_mismatch",
          detail: `scratch 标记文件无法解析：${String(error)}`,
        },
      ],
    };
  }
  if (marker.marker !== "pinovel.eval-scratch" || marker.evalOnly !== true) {
    violations.push({
      kind: "scratch_marker_mismatch",
      detail: "scratch 标记身份不符（marker/evalOnly 字段非法）",
      evidence: marker,
    });
  }
  if (expect?.fixtureId && marker.fixtureId !== expect.fixtureId) {
    violations.push({
      kind: "scratch_marker_mismatch",
      detail: `scratch 标记 fixtureId 不匹配：期望 ${expect.fixtureId}，实际 ${marker.fixtureId}`,
    });
  }
  if (expect?.releaseId && marker.releaseId !== expect.releaseId) {
    violations.push({
      kind: "scratch_marker_mismatch",
      detail: `scratch 标记 releaseId 不匹配：期望 ${expect.releaseId}，实际 ${marker.releaseId}`,
    });
  }
  return { ok: violations.length === 0, marker, violations };
}

/**
 * 判断目标路径是否位于 scratch 数据根内（路径遏制检查）。
 */
export function isPathInsideScratch(lease: ScratchWorkspaceLease, targetPath: string): boolean {
  const absolute = isAbsolute(targetPath) ? targetPath : resolve(targetPath);
  const rel = relative(resolve(lease.scratchRoot), absolute);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * 断言可写路径在 scratch 内；越界 → 抛 IsolationViolationError（fail-closed）。
 */
export function assertWritablePath(lease: ScratchWorkspaceLease, targetPath: string): void {
  if (!isPathInsideScratch(lease, targetPath)) {
    throw new IsolationViolationError({
      kind: "path_escape",
      detail: `回放试图写入 scratch 之外的路径：${targetPath}`,
      evidence: { scratchRoot: lease.scratchRoot, targetPath },
    });
  }
}

export class IsolationViolationError extends Error {
  readonly violation: IsolationViolation;

  constructor(violation: IsolationViolation) {
    super(`[隔离违规·${violation.kind}] ${violation.detail}`);
    this.name = "IsolationViolationError";
    this.violation = violation;
  }
}

/**
 * 归档 scratch workspace（移动整个 scratch run 根到归档目录）。
 * 返回归档后的路径。目标已存在 → 抛错（不覆盖既有归档）。
 */
export function archiveScratchWorkspace(
  lease: ScratchWorkspaceLease,
  archiveDir: string,
): string {
  mkdirSync(archiveDir, { recursive: true });
  const target = join(archiveDir, lease.leaseId);
  if (existsSync(target)) {
    throw new Error(`归档目标已存在，拒绝覆盖：${target}`);
  }
  renameSync(lease.scratchRoot, target);
  return target;
}

/**
 * 清理 scratch workspace（整根删除）。
 * 仅当标记文件合法时才允许删除，防止误删正式目录。
 */
export function cleanupScratchWorkspace(lease: ScratchWorkspaceLease): void {
  const markerCheck = readScratchMarker(lease.scratchRoot, { fixtureId: lease.fixtureId });
  if (!markerCheck.ok) {
    throw new IsolationViolationError({
      kind: "scratch_marker_missing",
      detail: `scratch 标记校验失败，拒绝清理（可能是正式目录误传）：${markerCheck.violations
        .map((v) => v.detail)
        .join("; ")}`,
    });
  }
  rmSync(lease.scratchRoot, { recursive: true, force: true });
}

// ============================================================================
// Scratch 项目骨架物化（子进程数据根解析前提）
// ============================================================================

/**
 * 从 startDir 起逐级向上（最多 5 级，覆盖 .pi/extensions/novel-studio 到
 * 仓库根的层级距离）探测项目资产（config/model-routing.json、.env）。
 *
 * Runner 传入的 projectRoot 通常是扩展目录（.pi/extensions/novel-studio），
 * 而路由配置与凭据位于仓库根；直接 join 会导致 existsSync 静默 false、
 * 复制被跳过（子进程运行时 fatal：Config file not found）。
 */
function locateProjectAsset(startDir: string, relPath: string): string | null {
  let dir = resolve(startDir);
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, relPath);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return null;
}

/**
 * 在 scratch 根物化项目骨架，使其通过 utils/config.ts 的 isProjectRoot 检查
 * （.pi/extensions/novel-studio + docs/top-tier-chinese-novel-system-development-plan.md）。
 *
 * 子进程通过 PINOVEL_PROJECT_ROOT={scratchRoot} 把数据根解析到 scratch；
 * resolveProjectRoot 对 env 根做 findProjectRoot 校验，标记缺失会静默回退到
 * 仓库根，导致隔离失效，因此标记必须先于子进程启动物化。
 *
 * copyModelRouting / copyDotEnv：真实模型回放需要路由配置与 API 凭据；
 * 源路径经 locateProjectAsset 向上探测（扩展目录 -> 仓库根）。
 * .env 复制仅进入 scratch（临时隔离根），归档时必须由调用方排除。
 */
export function materializeScratchProjectSkeleton(
  scratchRoot: string,
  source: {
    projectRoot: string;
    copyModelRouting?: boolean;
    copyDotEnv?: boolean;
  },
): void {
  mkdirSync(join(scratchRoot, ".pi", "extensions", "novel-studio"), { recursive: true });
  const docsDir = join(scratchRoot, "docs");
  mkdirSync(docsDir, { recursive: true });
  const markerDoc = join(docsDir, "top-tier-chinese-novel-system-development-plan.md");
  if (!existsSync(markerDoc)) {
    writeFileSync(
      markerDoc,
      "# eval-scratch project marker\n\n本文件为离线回放 scratch 隔离根的项目根标记，\n不是真实开发计划文档。\n",
      "utf-8",
    );
  }

  if (source.copyModelRouting) {
    const routingSource = locateProjectAsset(
      source.projectRoot,
      join("config", "model-routing.json"),
    );
    if (routingSource) {
      const configDir = join(scratchRoot, "config");
      mkdirSync(configDir, { recursive: true });
      copyFileSync(routingSource, join(configDir, "model-routing.json"));
    }
  }
  if (source.copyDotEnv) {
    const envSource = locateProjectAsset(source.projectRoot, ".env");
    if (envSource) {
      copyFileSync(envSource, join(scratchRoot, ".env"));
    }
  }
}

/** 归档前必须从 scratch 移除的敏感文件（不进入归档产物）。 */
export function stripSensitiveFilesBeforeArchive(scratchRoot: string): string[] {
  const stripped: string[] = [];
  const envPath = join(scratchRoot, ".env");
  if (existsSync(envPath)) {
    rmSync(envPath, { force: true });
    stripped.push(envPath);
  }
  return stripped;
}

// ============================================================================
// 生产面快照与污染检测
// ============================================================================

export interface ProductionSurfacePaths {
  /** 发行治理根（active-production.json / active-development.json 所在）。 */
  evolutionRoot: string;
  /** 正式 workspaces 根。 */
  workspacesRoot: string;
}

/**
 * 解析默认生产面路径（与 production-release-gate 的 evolutionRoot 约定一致）。
 */
export function resolveDefaultProductionSurfacePaths(projectRoot: string): ProductionSurfacePaths {
  return {
    evolutionRoot: resolveProductionEvolutionRoot(projectRoot),
    workspacesRoot: join(projectRoot, "workspaces"),
  };
}

interface FileDigest {
  path: string;
  hash: string | null;
  size: number;
}

export interface ProductionSurfaceSnapshot {
  takenAt: string;
  paths: ProductionSurfacePaths;
  /** pointer 与治理文件的逐文件内容 hash（不存在则 null）。 */
  governanceFiles: FileDigest[];
  /** 正式 workspaces 目录递归清单（相对路径 + 内容 hash）。 */
  workspaceFiles: FileDigest[];
  /** 快照内文件总数（用于成本观测）。 */
  fileCount: number;
}

function digestFile(absolutePath: string): FileDigest {
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
    return { path: absolutePath, hash: null, size: 0 };
  }
  const content = readFileSync(absolutePath);
  return {
    path: absolutePath,
    hash: createHash("sha256").update(content).digest("hex"),
    size: content.length,
  };
}

function digestDirRecursive(root: string): FileDigest[] {
  if (!existsSync(root)) {
    return [];
  }
  const results: FileDigest[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
      } else if (entry.isFile()) {
        results.push(digestFile(entryPath));
      }
    }
  };
  walk(root);
  return results.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * 捕获生产面快照：release pointer / 治理文件 / 正式 workspaces 全量内容 hash。
 */
export function captureProductionSurface(
  projectRoot: string,
  paths?: Partial<ProductionSurfacePaths>,
): ProductionSurfaceSnapshot {
  const resolved: ProductionSurfacePaths = {
    ...resolveDefaultProductionSurfacePaths(projectRoot),
    ...paths,
  };
  const governanceFiles = [
    join(resolved.evolutionRoot, "active-production.json"),
    join(resolved.evolutionRoot, "active-development.json"),
  ].map(digestFile);
  const workspaceFiles = digestDirRecursive(resolved.workspacesRoot);
  return {
    takenAt: new Date().toISOString(),
    paths: resolved,
    governanceFiles,
    workspaceFiles,
    fileCount: governanceFiles.length + workspaceFiles.length,
  };
}

function diffFileDigests(
  label: string,
  kind: IsolationViolationKind,
  before: FileDigest[],
  after: FileDigest[],
  violations: IsolationViolation[],
): void {
  const beforeMap = new Map(before.map((f) => [f.path, f]));
  const afterMap = new Map(after.map((f) => [f.path, f]));
  for (const [path, beforeFile] of beforeMap) {
    const afterFile = afterMap.get(path);
    if (afterFile === undefined) {
      violations.push({
        kind,
        detail: `${label}生产面文件被删除：${path}`,
        evidence: { path, before: beforeFile.hash },
      });
    } else if (afterFile.hash !== beforeFile.hash) {
      violations.push({
        kind,
        detail: `${label}生产面文件被修改：${path}`,
        evidence: { path, before: beforeFile.hash, after: afterFile.hash },
      });
    }
  }
  for (const path of afterMap.keys()) {
    if (!beforeMap.has(path)) {
      violations.push({
        kind,
        detail: `${label}生产面出现新增文件：${path}`,
        evidence: { path },
      });
    }
  }
}

/**
 * 对照回放前后的生产面快照，产出隔离违规清单。
 *
 * 归因映射：
 *  - pointer 文件变化 → production_pointer_mutation（Eval 修改 production pointer，必须 0）；
 *  - pointer 之外治理文件变化 → formal_release；
 *  - 正式 workspaces 新增/修改章节 → formal_chapter_save；
 *  - 正式 workspaces 中 narrative-state.json 变化 → narrative_state_commit；
 *  - 正式 workspaces 中 strategy-policy.json 变化 → strategy_reputation_update；
 *  - 正式 workspaces 中 feedback.jsonl / chapter-approvals 变化 → user_feedback_write。
 */
export function detectProductionSurfacePollution(
  before: ProductionSurfaceSnapshot,
  after: ProductionSurfaceSnapshot,
): IsolationViolation[] {
  const violations: IsolationViolation[] = [];

  const pointerNames = new Set(["active-production.json", "active-development.json"]);
  const beforePointers = before.governanceFiles.filter((f) =>
    pointerNames.has(f.path.split(sep).pop() ?? ""),
  );
  const afterPointers = after.governanceFiles.filter((f) =>
    pointerNames.has(f.path.split(sep).pop() ?? ""),
  );
  diffFileDigests("", "production_pointer_mutation", beforePointers, afterPointers, violations);

  const beforeOtherGov = before.governanceFiles.filter(
    (f) => !pointerNames.has(f.path.split(sep).pop() ?? ""),
  );
  const afterOtherGov = after.governanceFiles.filter(
    (f) => !pointerNames.has(f.path.split(sep).pop() ?? ""),
  );
  diffFileDigests("", "formal_release", beforeOtherGov, afterOtherGov, violations);

  const classifyWorkspaceFile = (path: string): IsolationViolationKind => {
    const normalized = path.replace(/\\/g, "/");
    if (normalized.endsWith("/strategy-policy.json")) {
      return "strategy_reputation_update";
    }
    if (normalized.includes("/chapter-approvals/") || normalized.endsWith("feedback.jsonl")) {
      return "user_feedback_write";
    }
    if (normalized.endsWith("/narrative-state.json")) {
      return "narrative_state_commit";
    }
    if (normalized.includes("/chapters/")) {
      return "formal_chapter_save";
    }
    return "formal_chapter_save";
  };

  const beforeWorkspaceMap = new Map(before.workspaceFiles.map((f) => [f.path, f]));
  const afterWorkspaceMap = new Map(after.workspaceFiles.map((f) => [f.path, f]));
  for (const [path, beforeFile] of beforeWorkspaceMap) {
    const afterFile = afterWorkspaceMap.get(path);
    if (afterFile === undefined) {
      violations.push({
        kind: classifyWorkspaceFile(path),
        detail: `正式 workspace 文件被删除：${path}`,
        evidence: { path, before: beforeFile.hash },
      });
    } else if (afterFile.hash !== beforeFile.hash) {
      violations.push({
        kind: classifyWorkspaceFile(path),
        detail: `正式 workspace 文件被修改：${path}`,
        evidence: { path, before: beforeFile.hash, after: afterFile.hash },
      });
    }
  }
  for (const path of afterWorkspaceMap.keys()) {
    if (!beforeWorkspaceMap.has(path)) {
      violations.push({
        kind: classifyWorkspaceFile(path),
        detail: `正式 workspace 出现新增文件：${path}`,
        evidence: { path },
      });
    }
  }

  return violations;
}
