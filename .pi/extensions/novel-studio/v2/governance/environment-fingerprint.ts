/**
 * EnvironmentFingerprint — 系统进化环境指纹（EVOLUTION-RELEASE-GOVERNANCE-1A）
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §2.2 / §3 / Phase G2
 *
 * 从 NovelBench runtime-provenance-collector.ts 抽取的共享、无 eval 依赖的环境指纹能力。
 * 本模块自包含（不 import novelbench/ 或 eval/），可被生产闭包与 eval 闭包同时消费，
 * 避免生产代码依赖 eval 模块（任务卡硬约束）。
 *
 * 指纹覆盖（计划 §2.2）：
 * - Git commit + dirty worktree
 * - 实际运行文件 + 构建产物 hash
 * - lockfile / tsconfig / model-routing / prompt bundle / tool schema hash
 * - 生成模型 / 裁判模型 / 代理审批模型及精确版本
 * - active 策略集合 + evidence hash
 * - CreativeConstitution hash
 * - 数据集 / 评测集 / seed / 预算 / 超时 / fallback
 * - 秘密不得明文落盘（只记录变量名 / 是否存在 / 安全指纹）
 *
 * 设计原则：
 * - 同输入 → 同 fingerprintHash（稳定性）
 * - 任一行为资产变化 → 不同 fingerprintHash（敏感性）
 * - collectedAt 不计入 hash（时间戳非行为）
 * - 秘密值不计入 hash，但秘密名 + 是否存在计入（secret 轮换不改变行为指纹）
 *
 * 边界（READY_LOCAL）：
 * - 不调用模型、不保存章节、不提交长期状态
 * - 只读用户文件计算 hash，不修改用户 WIP
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, relative, sep, isAbsolute, join } from "node:path";

// ============================================================================
// Schema 常量
// ============================================================================

export const ENVIRONMENT_FINGERPRINT_SCHEMA_ID = "pinovel.environment-fingerprint" as const;
export const ENVIRONMENT_FINGERPRINT_SCHEMA_VERSION = 1 as const;

// ============================================================================
// 类型
// ============================================================================

export interface RuntimeFileHash {
  /** 相对 projectRoot 的路径（正斜杠分隔） */
  path: string;
  /** SHA-256 hex；文件不存在时为空字符串 */
  hash: string;
  exists: boolean;
  size: number;
}

export interface EnvSwitchState {
  name: string;
  /** 是否设置（process.env[name] !== undefined && !== ""） */
  set: boolean;
}

export interface SecretEnvState {
  name: string;
  /** 是否设置 */
  set: boolean;
  /** 安全指纹：sha256(value) 前 16 字符（不存原值，仅用于检测轮换） */
  fingerprint: string;
}

export interface EnvironmentFingerprint {
  schemaId: typeof ENVIRONMENT_FINGERPRINT_SCHEMA_ID;
  schemaVersion: typeof ENVIRONMENT_FINGERPRINT_SCHEMA_VERSION;
  /** 行为指纹总 hash（canonicalize 行为字段后 sha256） */
  fingerprintHash: string;
  /** Git HEAD commit hash */
  codeCommit: string;
  /** 工作区是否有未提交修改 */
  worktreeDirty: boolean;
  /** 运行时依赖文件聚合 hash */
  runtimeFilesHash: string;
  /** 参与聚合的文件清单 */
  runtimeFileList: RuntimeFileHash[];
  /** 编译产物聚合 hash */
  buildArtifactHash: string;
  /** model-routing.json hash */
  modelRoutingHash: string;
  /** prompt bundle 聚合 hash */
  promptBundleHash: string;
  /** tool schema 聚合 hash */
  toolSchemaHash: string;
  /** 生成模型标识（如 glm-5.2） */
  generationModel: string;
  /** 裁判模型标识 */
  judgeModel: string;
  /** 代理审批模型标识（gpt5.6-sol） */
  proxyApprovalModel: string;
  /** active 策略 ID 集合（排序后参与 hash） */
  activeStrategyIds: string[];
  /** CreativeConstitution hash */
  constitutionHash: string;
  /** 数据集 hash */
  datasetHash: string;
  /** 评测协议 hash */
  evalProtocolHash: string;
  /** 随机种子 */
  seed: number;
  /** 单章最大调用预算 */
  budgetMaxCalls: number;
  /** 单次请求超时（ms） */
  timeoutMs: number;
  /** fallback 策略（disabled / enabled） */
  fallbackPolicy: string;
  /** 非秘密环境开关状态 */
  envSwitches: EnvSwitchState[];
  /** 秘密环境变量状态（不含原值） */
  secretEnvStates: SecretEnvState[];
  /** 采集时间（不计入 fingerprintHash） */
  collectedAt: string;
}

/** mockGit：测试时绕过真实 Git 调用。 */
export interface MockGit {
  codeCommit: string;
  worktreeDirty: boolean;
}

export interface CollectEnvironmentFingerprintInput {
  projectRoot: string;
  /** model-routing.json 相对路径（相对 projectRoot） */
  modelRoutingPath: string;
  /** prompt bundle 文件相对路径列表 */
  promptBundlePaths: string[];
  /** tool schema 文件相对路径列表 */
  toolSchemaPaths: string[];
  /** 运行时依赖文件相对路径列表（源码 + 编译产物） */
  runtimeFilePaths?: string[];
  /** 构建产物相对路径列表 */
  buildArtifactPaths?: string[];
  /** 构建产物目录：递归收集目录下所有 .js 纳入 buildArtifactHash（覆盖 dist 全树） */
  buildArtifactDirs?: string[];
  /** active 策略 ID 列表 */
  activeStrategyIds: string[];
  /** CreativeConstitution hash（由调用方预先计算） */
  constitutionHash: string;
  /** 数据集 hash */
  datasetHash: string;
  /** 评测协议 hash */
  evalProtocolHash: string;
  seed: number;
  budgetMaxCalls: number;
  timeoutMs: number;
  fallbackPolicy: string;
  generationModel: string;
  judgeModel: string;
  proxyApprovalModel: string;
  /** 非秘密环境开关变量名列表 */
  envSwitchNames: string[];
  /** 秘密环境变量名列表（只记录 name/set/fingerprint，不记录值） */
  secretEnvNames: string[];
  /** 测试用：绕过真实 Git 调用 */
  mockGit?: MockGit;
}

// ============================================================================
// 辅助
// ============================================================================

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

function sha256Buf(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function hashFile(absPath: string): { hash: string; exists: boolean; size: number } {
  if (!existsSync(absPath)) {
    return { hash: "", exists: false, size: 0 };
  }
  const buf = readFileSync(absPath);
  return { hash: sha256Buf(buf), exists: true, size: buf.length };
}

function normalizePath(projectRoot: string, filePath: string): string {
  const abs = isAbsolute(filePath) ? filePath : resolve(projectRoot, filePath);
  const rel = relative(projectRoot, abs);
  return rel.split(sep).join("/");
}

function aggregateHash(fileHashes: RuntimeFileHash[]): string {
  const sorted = [...fileHashes].sort((a, b) => a.path.localeCompare(b.path));
  const concat = sorted.map((f) => `${f.path}:${f.hash}`).join("\n");
  return sha256(concat);
}

let cachedGitBinaryAvailable: boolean | null = null;

/**
 * 探测 git 二进制是否可用（当前会话 PATH 可解析）。
 *
 * FP-GIT-1（rel-prod-110 事故修复）：capture 会话 PATH 无 git 时，getGitHead/getWorktreeDirty
 * 会静默退化为 ""/false，导致 codeCommit 丢失身份、退化指纹被冻结进 manifest（recorded
 * fpHash 808378f4 vs 带 commit 身份的 d24a5faf），verify 在同样缺 git 的会话中产生假阳性 YES。
 *
 * 模块本体刻意保持静默退化语义，以兼容：
 * 1) 测试 fixture 在临时目录（非 git 仓库）上直接调用 collectEnvironmentFingerprint；
 * 2) 生产 gate（captureDefaultEnvironmentFingerprint）的 fail-closed 比对（退化 hash 与
 *    完整 hash 必然不等，只会保守阻断，不会假阳性）。
 *
 * 阻断收口在 CLI 咽喉：evolution-cli.mjs 的 captureFingerprint() 在 capture/verify/freeze/
 * drill 前调用本函数，git 不可用即 exit 9 响亮失败，禁止把退化指纹冻结进 release manifest。
 */
export function isGitBinaryAvailable(): boolean {
  if (cachedGitBinaryAvailable === null) {
    try {
      execSync("git --version", {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      cachedGitBinaryAvailable = true;
    } catch {
      cachedGitBinaryAvailable = false;
    }
  }
  return cachedGitBinaryAvailable;
}

function getGitHead(projectRoot: string): string {
  try {
    return execSync("git rev-parse HEAD", {
      cwd: projectRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    // FP-GIT-1：git 二进制缺失与"非 git 仓库"在此无法区分，均退化为空串。
    // 严格阻断由 CLI 咽喉（captureFingerprint 的 isGitBinaryAvailable 守卫）负责。
    return "";
  }
}

function getWorktreeDirty(projectRoot: string): boolean {
  try {
    const status = execSync("git status --porcelain", {
      cwd: projectRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return status.length > 0;
  } catch {
    // FP-GIT-1：同上，静默退化；CLI 咽喉守卫负责拒绝退化指纹进入 release 生命周期。
    return false;
  }
}

/**
 * 计算单文件 hash（用于 prompt bundle / tool schema / model-routing 等单文件指纹）。
 * 文件不存在返回空字符串。
 */
function hashSingleFile(projectRoot: string, relPath: string): string {
  const abs = resolve(projectRoot, relPath);
  const { hash } = hashFile(abs);
  return hash;
}

/** 计算多文件聚合 hash（按路径排序）。 */
function hashFileList(projectRoot: string, relPaths: string[]): { hash: string; list: RuntimeFileHash[] } {
  const list: RuntimeFileHash[] = relPaths.map((relPath) => {
    const abs = resolve(projectRoot, relPath);
    const { hash, exists, size } = hashFile(abs);
    return { path: normalizePath(projectRoot, abs), hash, exists, size };
  });
  return { hash: aggregateHash(list), list };
}

/**
 * 递归收集目录下所有 .js 文件并 hash（按路径排序，确定性）。
 * 目录不存在 → 返回空清单（不抛异常，与显式文件缺失一致）。
 * 只收集 .js（运行时代码），排除 .d.ts / .map（类型声明与 sourcemap 非运行时行为）。
 */
function hashDirectoryJs(projectRoot: string, dirRelPath: string): RuntimeFileHash[] {
  const absDir = resolve(projectRoot, dirRelPath);
  if (!existsSync(absDir)) {
    return [];
  }
  const entries: RuntimeFileHash[] = [];
  const walk = (dir: string): void => {
    for (const dirent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, dirent.name);
      if (dirent.isDirectory()) {
        walk(full);
      } else if (dirent.isFile() && dirent.name.endsWith(".js")) {
        const { hash, exists, size } = hashFile(full);
        entries.push({ path: normalizePath(projectRoot, full), hash, exists, size });
      }
    }
  };
  walk(absDir);
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries;
}

// ============================================================================
// collectEnvironmentFingerprint
// ============================================================================

export function collectEnvironmentFingerprint(
  input: CollectEnvironmentFingerprintInput,
): EnvironmentFingerprint {
  const {
    projectRoot,
    modelRoutingPath,
    promptBundlePaths,
    toolSchemaPaths,
    activeStrategyIds,
    constitutionHash,
    datasetHash,
    evalProtocolHash,
    seed,
    budgetMaxCalls,
    timeoutMs,
    fallbackPolicy,
    generationModel,
    judgeModel,
    proxyApprovalModel,
    envSwitchNames,
    secretEnvNames,
    mockGit,
  } = input;

  // ── Git ────────────────────────────────────────────────────────────────
  const codeCommit = mockGit ? mockGit.codeCommit : getGitHead(projectRoot);
  const worktreeDirty = mockGit ? mockGit.worktreeDirty : getWorktreeDirty(projectRoot);

  // ── 运行时文件 hash ────────────────────────────────────────────────────
  const runtimeFilePaths = input.runtimeFilePaths ?? [];
  const { hash: runtimeFilesHash, list: runtimeFileList } = hashFileList(projectRoot, runtimeFilePaths);

  // ── 构建产物 hash ──────────────────────────────────────────────────────
  const buildArtifactPaths = input.buildArtifactPaths ?? [];
  const { list: buildArtifactPathFiles } = hashFileList(projectRoot, buildArtifactPaths);
  const buildArtifactDirFiles = (input.buildArtifactDirs ?? []).flatMap((dir) =>
    hashDirectoryJs(projectRoot, dir),
  );
  // 去重：目录遍历会重复包含显式路径（如 dist/index.js），按路径去重避免聚合重复计数
  const seenBuildPaths = new Set<string>();
  const allBuildArtifacts = [...buildArtifactPathFiles, ...buildArtifactDirFiles].filter((f) => {
    if (seenBuildPaths.has(f.path)) return false;
    seenBuildPaths.add(f.path);
    return true;
  });
  const buildArtifactHash = aggregateHash(allBuildArtifacts);

  // ── 单文件 hash ────────────────────────────────────────────────────────
  const modelRoutingHash = hashSingleFile(projectRoot, modelRoutingPath);
  const { hash: promptBundleHash } = hashFileList(projectRoot, promptBundlePaths);
  const { hash: toolSchemaHash } = hashFileList(projectRoot, toolSchemaPaths);

  // ── 环境开关（不含值） ──────────────────────────────────────────────────
  const envSwitches: EnvSwitchState[] = envSwitchNames.map((name) => ({
    name,
    set: process.env[name] !== undefined && process.env[name] !== "",
  }));

  // ── 秘密环境变量（只记录 name/set/fingerprint，不记录值） ────────────────
  const secretEnvStates: SecretEnvState[] = secretEnvNames.map((name) => {
    const v = process.env[name];
    const set = v !== undefined && v !== "";
    // 安全指纹：sha256(value) 前 16 字符；未设置时为空
    const fingerprint = set ? sha256(v!).slice(0, 16) : "";
    return { name, set, fingerprint };
  });

  // ── 构造 fingerprint 对象（fingerprintHash 暂空，后续计算） ──────────────
  const fp: EnvironmentFingerprint = {
    schemaId: ENVIRONMENT_FINGERPRINT_SCHEMA_ID,
    schemaVersion: ENVIRONMENT_FINGERPRINT_SCHEMA_VERSION,
    fingerprintHash: "", // 占位，下方计算
    codeCommit,
    worktreeDirty,
    runtimeFilesHash,
    runtimeFileList,
    buildArtifactHash,
    modelRoutingHash,
    promptBundleHash,
    toolSchemaHash,
    generationModel,
    judgeModel,
    proxyApprovalModel,
    activeStrategyIds: [...activeStrategyIds].sort(),
    constitutionHash,
    datasetHash,
    evalProtocolHash,
    seed,
    budgetMaxCalls,
    timeoutMs,
    fallbackPolicy,
    envSwitches,
    secretEnvStates,
    collectedAt: new Date().toISOString(),
  };

  fp.fingerprintHash = computeFingerprintHash(fp);
  return fp;
}

// ============================================================================
// computeFingerprintHash
// ============================================================================

/**
 * 计算 fingerprint 的行为 hash。
 *
 * 排除字段（非行为或会自然变化）：
 * - collectedAt（采集时间）
 * - fingerprintHash（自身）
 * - secretEnvStates[].fingerprint（秘密值指纹；秘密轮换不改变行为）
 *
 * 包含字段（行为）：
 * - codeCommit / worktreeDirty
 * - runtimeFilesHash / buildArtifactHash / modelRoutingHash / promptBundleHash / toolSchemaHash
 * - generationModel / judgeModel / proxyApprovalModel
 * - activeStrategyIds（排序后）
 * - constitutionHash / datasetHash / evalProtocolHash
 * - seed / budgetMaxCalls / timeoutMs / fallbackPolicy
 * - envSwitches（name + set）
 * - secretEnvStates（name + set，不含 fingerprint）
 *
 * 注意：runtimeFileList 不直接计入 hash（其聚合 runtimeFilesHash 已计入），
 * 避免清单顺序影响 hash。
 */
export function computeFingerprintHash(fp: EnvironmentFingerprint): string {
  const behavioralFields = {
    codeCommit: fp.codeCommit,
    worktreeDirty: fp.worktreeDirty,
    runtimeFilesHash: fp.runtimeFilesHash,
    buildArtifactHash: fp.buildArtifactHash,
    modelRoutingHash: fp.modelRoutingHash,
    promptBundleHash: fp.promptBundleHash,
    toolSchemaHash: fp.toolSchemaHash,
    generationModel: fp.generationModel,
    judgeModel: fp.judgeModel,
    proxyApprovalModel: fp.proxyApprovalModel,
    activeStrategyIds: [...fp.activeStrategyIds].sort(),
    constitutionHash: fp.constitutionHash,
    datasetHash: fp.datasetHash,
    evalProtocolHash: fp.evalProtocolHash,
    seed: fp.seed,
    budgetMaxCalls: fp.budgetMaxCalls,
    timeoutMs: fp.timeoutMs,
    fallbackPolicy: fp.fallbackPolicy,
    envSwitches: [...fp.envSwitches].sort((a, b) => a.name.localeCompare(b.name)),
    // 秘密：只取 name + set，不含 fingerprint（轮换不改变行为）
    secretEnvStates: fp.secretEnvStates
      .map((s) => ({ name: s.name, set: s.set }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
  return sha256(canonicalize(behavioralFields));
}

/** 递归规范化对象：按 key 排序，保证字段顺序不影响 hash。 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
}

// ============================================================================
// verifyEnvironmentFingerprint
// ============================================================================

export interface FingerprintVerificationCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface FingerprintVerificationResult {
  reproducible: boolean;
  checks: FingerprintVerificationCheck[];
}

/**
 * 校验两个 fingerprint 是否在行为层面可复现。
 *
 * 验收口径（计划 §G2 / 任务卡"必须测试"）：
 * - fingerprintHash 一致
 * - codeCommit 一致
 * - worktreeDirty：actual 必须为 false（clean worktree 才算可复现）
 * - 行为字段一致
 */
export function verifyEnvironmentFingerprint(
  recorded: EnvironmentFingerprint,
  actual: EnvironmentFingerprint,
): FingerprintVerificationResult {
  const checks: FingerprintVerificationCheck[] = [];

  // fingerprintHash 一致
  const hashMatch = recorded.fingerprintHash === actual.fingerprintHash && actual.fingerprintHash !== "";
  checks.push({
    name: "fingerprintHash 一致",
    passed: hashMatch,
    detail: hashMatch
      ? `hash=${actual.fingerprintHash.slice(0, 16)}`
      : `recorded=${recorded.fingerprintHash.slice(0, 16)}, actual=${actual.fingerprintHash.slice(0, 16)}`,
  });

  // codeCommit 一致
  const commitMatch = recorded.codeCommit === actual.codeCommit && actual.codeCommit !== "";
  checks.push({
    name: "codeCommit 一致",
    passed: commitMatch,
    detail: commitMatch
      ? `commit=${actual.codeCommit.slice(0, 12)}`
      : `recorded=${recorded.codeCommit.slice(0, 12)}, actual=${actual.codeCommit.slice(0, 12)}`,
  });

  // worktreeDirty：actual 必须为 false（clean worktree 才算可复现）
  const cleanWorktree = !actual.worktreeDirty;
  checks.push({
    name: "worktreeDirty=false（clean worktree）",
    passed: cleanWorktree,
    detail: cleanWorktree ? "工作区干净" : "工作区有未提交修改",
  });

  // runtimeFilesHash 一致
  const runtimeMatch = recorded.runtimeFilesHash === actual.runtimeFilesHash;
  checks.push({
    name: "runtimeFilesHash 一致",
    passed: runtimeMatch,
    detail: runtimeMatch ? "一致" : "运行时文件 hash 不一致",
  });

  // generationModel 一致
  const modelMatch = recorded.generationModel === actual.generationModel;
  checks.push({
    name: "generationModel 一致",
    passed: modelMatch,
    detail: modelMatch
      ? `model=${actual.generationModel}`
      : `recorded=${recorded.generationModel}, actual=${actual.generationModel}`,
  });

  // seed 一致
  const seedMatch = recorded.seed === actual.seed;
  checks.push({
    name: "seed 一致",
    passed: seedMatch,
    detail: seedMatch ? `seed=${actual.seed}` : `recorded=${recorded.seed}, actual=${actual.seed}`,
  });

  const reproducible = checks.every((c) => c.passed);
  return { reproducible, checks };
}
