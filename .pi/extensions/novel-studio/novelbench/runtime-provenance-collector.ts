/**
 * DEMO-3-R2.5：运行时代码 provenance 收集器。
 *
 * 在 B4 生成运行时采集代码/构建/环境指纹，写入 run.json，使产物可复现。
 * 指纹覆盖：
 * - codeCommit：Git HEAD commit hash
 * - worktreeDirty：工作区是否有未提交修改
 * - runtimeFilesHash：运行时实际依赖文件（源码 + 编译产物）的聚合 SHA-256
 * - runtimeFileList：参与聚合的文件清单 + 单文件 hash
 * - buildArtifactHash：编译产物的聚合 hash
 * - model / modelVersion / seed / costProfile：运行配置
 * - envSwitches：关键环境开关名称（仅记录是否设置，不记录值）
 *
 * 设计原则：
 * - runtimeFilesHash 必须覆盖生成实际依赖的 R2.4 文件及编译产物，不能只记录 Git HEAD
 * - 若 dirty worktree 参与运行，runtimeFileList 记录实际文件 hash（含未提交修改）
 * - 正式验收优先使用干净隔离环境（clean worktree），此时 worktreeDirty=false
 * - 不记录任何密钥值，只记录环境变量名 + 是否设置
 *
 * 本模块为 eval-only，由 tsconfig.eval.json 编译到 dist-eval/，不进 dist/。
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, relative, sep, normalize, isAbsolute } from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────────────────────

/** 单个运行时文件的 hash 记录。 */
export interface RuntimeFileHash {
  /** 相对项目根的路径（正斜杠分隔） */
  path: string;
  /** SHA-256 hex；文件不存在时为空字符串 */
  hash: string;
  /** 文件是否存在 */
  exists: boolean;
  /** 文件大小（字节）；不存在时为 0 */
  size: number;
}

/** 环境开关状态（仅记录是否设置，不记录值）。 */
export interface EnvSwitchState {
  /** 环境变量名 */
  name: string;
  /** 是否设置（process.env[name] !== undefined） */
  set: boolean;
}

/** 运行时代码 provenance 指纹。 */
export interface RuntimeProvenance {
  /** Git HEAD commit hash */
  codeCommit: string;
  /** 工作区是否有未提交修改（git status --porcelain 非空） */
  worktreeDirty: boolean;
  /** 运行时依赖文件的聚合 SHA-256（SHA-256(concat(各文件 hash 按路径排序))） */
  runtimeFilesHash: string;
  /** 参与 runtimeFilesHash 计算的文件清单 */
  runtimeFileList: RuntimeFileHash[];
  /** 编译产物的聚合 SHA-256 */
  buildArtifactHash: string;
  /** 使用的模型（glm / doubao） */
  model: string;
  /** 模型版本（如 glm-5.2 / doubao-seed-2-1-pro-260628） */
  modelVersion: string;
  /** 随机种子 */
  seed: number;
  /** 成本配置 profile 名称（package_screening / production_validation） */
  costProfile: string;
  /** 关键环境开关状态（不含值） */
  envSwitches: EnvSwitchState[];
  /** 采集时间 ISO */
  collectedAt: string;
}

/** collectRuntimeProvenance 的输入参数。 */
export interface CollectRuntimeProvenanceInput {
  /** 项目根目录（绝对路径） */
  projectRoot: string;
  /** 模型名（glm / doubao） */
  model: string;
  /** 模型版本（如 glm-5.2） */
  modelVersion: string;
  /** 随机种子 */
  seed: number;
  /** 成本配置 profile 名称 */
  costProfile: string;
  /** 要记录状态的环境变量名列表（不记录值） */
  envSwitchNames: string[];
  /** 要 hash 的运行时文件相对路径列表（相对 projectRoot） */
  runtimeFilePaths: string[];
  /** 要 hash 的构建产物相对路径列表（相对 projectRoot） */
  buildArtifactPaths: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// 核心实现
// ─────────────────────────────────────────────────────────────────────────────

/** 计算字符串的 SHA-256 hex。 */
function sha256(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

/** 计算文件内容的 SHA-256 hex；文件不存在返回空字符串。 */
function hashFile(filePath: string): { hash: string; exists: boolean; size: number } {
  if (!existsSync(filePath)) {
    return { hash: "", exists: false, size: 0 };
  }
  const buf = readFileSync(filePath);
  return {
    hash: createHash("sha256").update(buf).digest("hex"),
    exists: true,
    size: buf.length,
  };
}

/** 获取 Git HEAD commit hash。 */
function getGitHead(projectRoot: string): string {
  try {
    return execSync("git rev-parse HEAD", {
      cwd: projectRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return "";
  }
}

/** 检查 Git 工作区是否有未提交修改。 */
function getWorktreeDirty(projectRoot: string): boolean {
  try {
    const status = execSync("git status --porcelain", {
      cwd: projectRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return status.length > 0;
  } catch {
    return false;
  }
}

/** 将路径规范化为相对项目根的正斜杠路径。 */
function normalizePath(projectRoot: string, filePath: string): string {
  const abs = isAbsolute(filePath) ? filePath : resolve(projectRoot, filePath);
  const rel = relative(projectRoot, abs);
  return rel.split(sep).join("/");
}

/** 计算多个文件 hash 的聚合 hash（按路径排序后拼接各 hash，再 SHA-256）。 */
function aggregateHash(fileHashes: RuntimeFileHash[]): string {
  const sorted = [...fileHashes].sort((a, b) => a.path.localeCompare(b.path));
  const concat = sorted.map((f) => `${f.path}:${f.hash}`).join("\n");
  return sha256(concat);
}

/**
 * 采集运行时代码 provenance 指纹。
 *
 * @param input 采集参数
 * @returns RuntimeProvenance 指纹对象
 */
export function collectRuntimeProvenance(input: CollectRuntimeProvenanceInput): RuntimeProvenance {
  const { projectRoot, model, modelVersion, seed, costProfile, envSwitchNames, runtimeFilePaths, buildArtifactPaths } =
    input;

  // ── Git 指纹 ────────────────────────────────────────────────────────────
  const codeCommit = getGitHead(projectRoot);
  const worktreeDirty = getWorktreeDirty(projectRoot);

  // ── 运行时文件 hash ─────────────────────────────────────────────────────
  // runtimeFileList 覆盖源码 + 编译产物，证明运行的实际代码版本。
  // 若 dirty worktree 参与运行，这里记录的 hash 含未提交修改。
  const runtimeFileList: RuntimeFileHash[] = runtimeFilePaths.map((relPath) => {
    const absPath = resolve(projectRoot, relPath);
    const { hash, exists, size } = hashFile(absPath);
    return {
      path: normalizePath(projectRoot, absPath),
      hash,
      exists,
      size,
    };
  });
  const runtimeFilesHash = aggregateHash(runtimeFileList);

  // ── 构建产物 hash ───────────────────────────────────────────────────────
  const buildFileHashes: RuntimeFileHash[] = buildArtifactPaths.map((relPath) => {
    const absPath = resolve(projectRoot, relPath);
    const { hash, exists, size } = hashFile(absPath);
    return {
      path: normalizePath(projectRoot, absPath),
      hash,
      exists,
      size,
    };
  });
  const buildArtifactHash = aggregateHash(buildFileHashes);

  // ── 环境开关状态（不含值）──────────────────────────────────────────────
  const envSwitches: EnvSwitchState[] = envSwitchNames.map((name) => ({
    name,
    set: process.env[name] !== undefined && process.env[name] !== "",
  }));

  return {
    codeCommit,
    worktreeDirty,
    runtimeFilesHash,
    runtimeFileList,
    buildArtifactHash,
    model,
    modelVersion,
    seed,
    costProfile,
    envSwitches,
    collectedAt: new Date().toISOString(),
  };
}

/**
 * 校验两个 RuntimeProvenance 是否在代码/构建层面可复现。
 *
 * 用于 R4 验收：比较 clean worktree 运行时的 provenance 与 run.json 记录的 provenance。
 * - codeCommit 必须一致
 * - worktreeDirty 在 clean worktree 中必须为 false
 * - runtimeFilesHash 必须一致（证明运行的实际代码版本相同）
 * - buildArtifactHash 必须一致（证明构建产物相同）
 *
 * @param recorded run.json 中记录的 RuntimeProvenance
 * @param actual 实际采集的 RuntimeProvenance
 * @returns 校验结果
 */
export function verifyRuntimeProvenance(
  recorded: RuntimeProvenance,
  actual: RuntimeProvenance,
): {
  reproducible: boolean;
  checks: Array<{ name: string; passed: boolean; detail: string }>;
} {
  const checks: Array<{ name: string; passed: boolean; detail: string }> = [];

  // codeCommit 一致
  const codeCommitMatch = recorded.codeCommit === actual.codeCommit && actual.codeCommit !== "";
  checks.push({
    name: "codeCommit 一致",
    passed: codeCommitMatch,
    detail: codeCommitMatch
      ? `commit=${actual.codeCommit.slice(0, 12)}`
      : `recorded=${recorded.codeCommit.slice(0, 12)}, actual=${actual.codeCommit.slice(0, 12)}`,
  });

  // clean worktree（actual 必须非 dirty）
  const cleanWorktree = !actual.worktreeDirty;
  checks.push({
    name: "worktreeDirty=false（clean worktree）",
    passed: cleanWorktree,
    detail: cleanWorktree ? "工作区干净" : "工作区有未提交修改",
  });

  // runtimeFilesHash 一致
  const runtimeHashMatch = recorded.runtimeFilesHash === actual.runtimeFilesHash && actual.runtimeFilesHash !== "";
  checks.push({
    name: "runtimeFilesHash 一致",
    passed: runtimeHashMatch,
    detail: runtimeHashMatch
      ? `hash=${actual.runtimeFilesHash.slice(0, 16)}`
      : `recorded=${recorded.runtimeFilesHash.slice(0, 16)}, actual=${actual.runtimeFilesHash.slice(0, 16)}`,
  });

  // buildArtifactHash 一致
  const buildHashMatch = recorded.buildArtifactHash === actual.buildArtifactHash && actual.buildArtifactHash !== "";
  checks.push({
    name: "buildArtifactHash 一致",
    passed: buildHashMatch,
    detail: buildHashMatch
      ? `hash=${actual.buildArtifactHash.slice(0, 16)}`
      : `recorded=${recorded.buildArtifactHash.slice(0, 16)}, actual=${actual.buildArtifactHash.slice(0, 16)}`,
  });

  // 所有运行时文件都存在
  const allFilesExist = actual.runtimeFileList.every((f) => f.exists);
  checks.push({
    name: "runtimeFileList 全部存在",
    passed: allFilesExist,
    detail: allFilesExist
      ? `${actual.runtimeFileList.length} 个文件全部存在`
      : `${actual.runtimeFileList.filter((f) => !f.exists).map((f) => f.path).join(", ")} 不存在`,
  });

  const reproducible = checks.every((c) => c.passed);
  return { reproducible, checks };
}
