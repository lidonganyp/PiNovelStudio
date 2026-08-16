/**
 * BehaviorSnapshot — 生产级行为快照捕获与独立校验（DG-2，数据版本与发布治理 §4/§5）
 *
 * 真相源：docs/data-version-release-governance-development-plan-20260813.md §5 DG-2
 *
 * 目标：形成不依赖 NovelBench 评测模块的生产级可重建指纹。把一次生产运行的
 * 全部行为资产（Prompt Bundle / Model Routing / Tool Contract / ContextCompiler /
 * 质量策略 / 恢复策略 / 知识快照 / 运行时环境）规范化 hash 为 8 个组件 hash，
 * 再经 DG-1 的 computeBehaviorBundleId 确定性派生唯一 bundleId。
 *
 * 与 environment-fingerprint.ts 的分工：
 * - environment-fingerprint 提供"完整环境指纹"（Git/dirty、模型、策略、seed、
 *   budget、env 开关、secret 安全指纹），用于 G6 门禁的 fingerprint 对比；
 * - 本模块提供"行为身份快照"（8 个组件 hash + bundleId），用于 manifest 的
 *   bundleId / 组件 hash 字段填充与独立 verify（DG-2 交付物）。
 *
 * 设计原则：
 * - 任一行为资产变化 → 对应组件 hash 变化 → bundleId 变化
 * - 同输入重复 capture → 完全一致（capturedAt 不计入任何 hash）
 * - 秘密 redaction：只记录文件名 / 是否存在 / 安全 hash，绝不记录文件内容或秘密值
 *
 * 边界（READY_LOCAL）：
 * - 仅 node 内建（crypto/fs/path/child_process）+ sibling behavior-bundle
 * - 不依赖 novelbench / eval / 模型，可被 dist/ 与 dist-test/ 任意闭包消费
 * - 只读用户文件计算 hash，不修改用户 WIP
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, relative, sep, isAbsolute, join } from "node:path";
import { computeBehaviorBundleId } from "./behavior-bundle.js";
import { canonicalize } from "./evolution-release-schema.js";

// ============================================================================
// Schema 常量
// ============================================================================

export const BEHAVIOR_SNAPSHOT_SCHEMA_ID = "pinovel.behavior-snapshot" as const;
export const BEHAVIOR_SNAPSHOT_SCHEMA_VERSION = 1 as const;

// ============================================================================
// 默认行为资产路径（相对 projectRoot，正斜杠）
// ============================================================================

/** Model Routing 配置（生产模型路由唯一真相源，见 CLAUDE.md） */
export const DEFAULT_MODEL_ROUTING_PATHS = ["config/model-routing.json"];

/** Prompt Bundle 配置（prompt registry） */
export const DEFAULT_PROMPT_BUNDLE_PATHS = ["config/prompt-registry.json"];

/** Tool Contract / 工具 schema 源码 */
export const DEFAULT_TOOL_SCHEMA_PATHS = [
  ".pi/extensions/novel-studio/novelos/tools/narrative-tools.ts",
  ".pi/extensions/novel-studio/novelos/tools/tool-capability.ts",
];

/** ContextCompiler 源码 */
export const DEFAULT_CONTEXT_COMPILER_PATHS = [
  ".pi/extensions/novel-studio/v2/core/context-compiler.ts",
];

/** 质量策略（quality gates） */
export const DEFAULT_QUALITY_POLICY_PATHS = ["config/quality-gates.json"];

/**
 * 恢复策略（fallback / retry / disabled_providers 均位于 model-routing.json）。
 * 采用整文件 hash 作为保守上界：任何路由或恢复相关变化都会改变该组件 hash，
 * 不会漏报（满足"任一行为资产变化 → hash 变化"验收口径）。
 */
export const DEFAULT_RECOVERY_POLICY_PATHS = ["config/model-routing.json"];

/** 知识快照：全局默认为空；每工作区由调用方注入 constitution / world canon 等路径 */
export const DEFAULT_KNOWLEDGE_SNAPSHOT_PATHS: string[] = [];

/** 运行时配置文件（tsconfig + lockfile） */
export const DEFAULT_RUNTIME_FILE_PATHS = [
  ".pi/extensions/novel-studio/tsconfig.prod.json",
  ".pi/extensions/novel-studio/tsconfig.eval.json",
  ".pi/extensions/novel-studio/tsconfig.test.json",
  "package-lock.json",
];

/** 构建产物（显式单文件，兜底保证入口产物被 hash） */
export const DEFAULT_BUILD_ARTIFACT_PATHS = [
  ".pi/extensions/novel-studio/dist/index.js",
];

/**
 * 构建产物目录：递归收集目录下所有 .js 纳入 runtimeFingerprint。
 * 保证任一生产源码变化（如 v2/core/final-state-commit.ts → final-state-commit.js）
 * 都改变 runtimeFingerprint 与 bundleId（DG-1「任一行为组成项变化 → 新 bundleId」）。
 * 只收集 .js（运行时代码），排除 .d.ts / .map（类型声明与 sourcemap 非运行时行为）。
 */
export const DEFAULT_BUILD_ARTIFACT_DIRS = [
  ".pi/extensions/novel-studio/dist",
];

// ============================================================================
// 类型
// ============================================================================

export interface SnapshotFileEntry {
  /** 相对 projectRoot 的路径（正斜杠分隔） */
  path: string;
  /** SHA-256 hex；文件不存在时为空字符串 */
  hash: string;
  exists: boolean;
  size: number;
}

export interface SnapshotComponent {
  /** 组件名（与 manifest 组件 hash 字段一一对应） */
  name:
    | "promptBundle"
    | "modelRouting"
    | "toolSchema"
    | "contextCompiler"
    | "qualityPolicy"
    | "recoveryPolicy"
    | "knowledgeSnapshot"
    | "runtimeFingerprint";
  /** 聚合 hash（规范化后 sha256） */
  hash: string;
  /** 参与聚合的文件清单（供审计） */
  files: SnapshotFileEntry[];
}

export interface RuntimeVersions {
  node: string;
  npm: string;
}

export interface RuntimeDataSnapshot {
  schemaId: typeof BEHAVIOR_SNAPSHOT_SCHEMA_ID;
  schemaVersion: typeof BEHAVIOR_SNAPSHOT_SCHEMA_VERSION;
  /** 完整行为 bundleId（DG-1 computeBehaviorBundleId） */
  bundleId: string;
  modelVersion: string;
  promptBundleHash: string;
  modelRoutingHash: string;
  toolSchemaHash: string;
  contextCompilerHash: string;
  qualityPolicyHash: string;
  recoveryPolicyHash: string;
  knowledgeSnapshotHash: string;
  runtimeFingerprint: string;
  /** 冻结能力包集合 hash；当前仓库无包时为规范空集。 */
  capabilityPackageSetHash: string;
  evalProtocolVersion: string;
  /** 组件明细（含文件清单，供审计与 verify） */
  components: SnapshotComponent[];
  /** 运行时版本（计入 runtimeFingerprint） */
  runtimeVersions: RuntimeVersions;
  /** 采集时间（不计入任何 hash） */
  capturedAt: string;
}

export interface SnapshotCaptureInput {
  projectRoot: string;
  modelVersion: string;
  evalProtocolVersion: string;
  modelRoutingPaths?: string[];
  promptBundlePaths?: string[];
  toolSchemaPaths?: string[];
  contextCompilerPaths?: string[];
  qualityPolicyPaths?: string[];
  recoveryPolicyPaths?: string[];
  knowledgeSnapshotPaths?: string[];
  runtimeFilePaths?: string[];
  buildArtifactPaths?: string[];
  /** 构建产物目录：递归收集目录下所有 .js 纳入 runtimeFingerprint */
  buildArtifactDirs?: string[];
  /** 测试注入：绕过真实 node/npm 版本探测 */
  mockRuntimeVersions?: RuntimeVersions;
}

// ============================================================================
// 辅助
// ============================================================================

function computeEmptyCapabilityPackageSetHash(): string {
  return sha256(
    canonicalize({
      schemaVersion: "capability-package-set-v1",
      packages: [],
      payloadHashes: [],
    }),
  );
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

function hashFile(absPath: string): { hash: string; exists: boolean; size: number } {
  if (!existsSync(absPath)) {
    return { hash: "", exists: false, size: 0 };
  }
  const buf = readFileSync(absPath);
  return { hash: sha256(buf.toString("utf-8")), exists: true, size: buf.length };
}

function normalizePath(projectRoot: string, filePath: string): string {
  const abs = isAbsolute(filePath) ? filePath : resolve(projectRoot, filePath);
  const rel = relative(projectRoot, abs);
  return rel.split(sep).join("/");
}

function hashFileList(projectRoot: string, relPaths: string[]): SnapshotFileEntry[] {
  return relPaths.map((relPath) => {
    const abs = resolve(projectRoot, relPath);
    const { hash, exists, size } = hashFile(abs);
    return { path: normalizePath(projectRoot, abs), hash, exists, size };
  });
}

/**
 * 递归收集目录下所有 .js 文件并 hash（按路径排序，确定性）。
 * 目录不存在 → 返回空清单（不抛异常，与显式文件缺失一致）。
 */
function hashDirectoryJs(projectRoot: string, dirRelPath: string): SnapshotFileEntry[] {
  const absDir = resolve(projectRoot, dirRelPath);
  if (!existsSync(absDir)) {
    return [];
  }
  const entries: SnapshotFileEntry[] = [];
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

/** 聚合 hash：按路径排序后拼 path:hash，再 sha256。空清单 → sha256("")（确定性）。 */
function aggregateHash(files: SnapshotFileEntry[]): string {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const concat = sorted.map((f) => `${f.path}:${f.hash}`).join("\n");
  return sha256(concat);
}

function execVersion(cmd: string): string {
  try {
    return execSync(`${cmd} --version`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return "";
  }
}

function captureRuntimeVersions(mock?: RuntimeVersions): RuntimeVersions {
  if (mock) {
    return { node: mock.node, npm: mock.npm };
  }
  return { node: execVersion("node"), npm: execVersion("npm") };
}

// ============================================================================
// captureBehaviorSnapshot
// ============================================================================

/**
 * 采集完整行为快照：8 个组件 hash + bundleId + 文件清单 + 运行时版本。
 *
 * 组件映射：
 * - promptBundleHash      ← promptBundlePaths
 * - modelRoutingHash      ← modelRoutingPaths
 * - toolSchemaHash        ← toolSchemaPaths
 * - contextCompilerHash   ← contextCompilerPaths
 * - qualityPolicyHash     ← qualityPolicyPaths
 * - recoveryPolicyHash    ← recoveryPolicyPaths
 * - knowledgeSnapshotHash ← knowledgeSnapshotPaths
 * - runtimeFingerprint    ← runtimeFilePaths + buildArtifactPaths + buildArtifactDirs + 运行时版本
 *
 * bundleId = computeBehaviorBundleId({ modelVersion, 8 组件 hash, evalProtocolVersion })。
 */
export function captureBehaviorSnapshot(input: SnapshotCaptureInput): RuntimeDataSnapshot {
  const {
    projectRoot,
    modelVersion,
    evalProtocolVersion,
    mockRuntimeVersions,
  } = input;

  const modelRoutingFiles = hashFileList(projectRoot, input.modelRoutingPaths ?? []);
  const promptBundleFiles = hashFileList(projectRoot, input.promptBundlePaths ?? []);
  const toolSchemaFiles = hashFileList(projectRoot, input.toolSchemaPaths ?? []);
  const contextCompilerFiles = hashFileList(projectRoot, input.contextCompilerPaths ?? []);
  const qualityPolicyFiles = hashFileList(projectRoot, input.qualityPolicyPaths ?? []);
  const recoveryPolicyFiles = hashFileList(projectRoot, input.recoveryPolicyPaths ?? []);
  const knowledgeSnapshotFiles = hashFileList(projectRoot, input.knowledgeSnapshotPaths ?? []);
  const runtimeFiles = hashFileList(projectRoot, input.runtimeFilePaths ?? []);
  const buildArtifactFiles = hashFileList(projectRoot, input.buildArtifactPaths ?? []);
  const buildArtifactDirFiles = (input.buildArtifactDirs ?? []).flatMap((dir) =>
    hashDirectoryJs(projectRoot, dir),
  );
  // 去重：目录遍历会重复包含显式路径（如 dist/index.js），按路径去重避免聚合重复计数
  const seenBuildPaths = new Set<string>();
  const allBuildArtifacts = [...buildArtifactFiles, ...buildArtifactDirFiles].filter((f) => {
    if (seenBuildPaths.has(f.path)) return false;
    seenBuildPaths.add(f.path);
    return true;
  });

  const modelRoutingHash = aggregateHash(modelRoutingFiles);
  const promptBundleHash = aggregateHash(promptBundleFiles);
  const toolSchemaHash = aggregateHash(toolSchemaFiles);
  const contextCompilerHash = aggregateHash(contextCompilerFiles);
  const qualityPolicyHash = aggregateHash(qualityPolicyFiles);
  const recoveryPolicyHash = aggregateHash(recoveryPolicyFiles);
  const knowledgeSnapshotHash = aggregateHash(knowledgeSnapshotFiles);

  const runtimeVersions = captureRuntimeVersions(mockRuntimeVersions);

  // runtimeFingerprint：运行时配置文件 + 构建产物 + 运行时版本
  const runtimeAll = [...runtimeFiles, ...allBuildArtifacts];
  const runtimeVersionsTag = `node:${runtimeVersions.node}|npm:${runtimeVersions.npm}`;
  const runtimeFingerprint = sha256(
    aggregateHash(runtimeAll) + "\n" + runtimeVersionsTag,
  );

  const bundleId = computeBehaviorBundleId({
    modelVersion,
    promptBundleHash,
    modelRoutingHash,
    toolSchemaHash,
    contextCompilerHash,
    qualityPolicyHash,
    recoveryPolicyHash,
    knowledgeSnapshotHash,
    runtimeFingerprint,
    evalProtocolVersion,
  });

  const components: SnapshotComponent[] = [
    { name: "promptBundle", hash: promptBundleHash, files: promptBundleFiles },
    { name: "modelRouting", hash: modelRoutingHash, files: modelRoutingFiles },
    { name: "toolSchema", hash: toolSchemaHash, files: toolSchemaFiles },
    { name: "contextCompiler", hash: contextCompilerHash, files: contextCompilerFiles },
    { name: "qualityPolicy", hash: qualityPolicyHash, files: qualityPolicyFiles },
    { name: "recoveryPolicy", hash: recoveryPolicyHash, files: recoveryPolicyFiles },
    { name: "knowledgeSnapshot", hash: knowledgeSnapshotHash, files: knowledgeSnapshotFiles },
    {
      name: "runtimeFingerprint",
      hash: runtimeFingerprint,
      files: [...runtimeFiles, ...allBuildArtifacts],
    },
  ];

  return {
    schemaId: BEHAVIOR_SNAPSHOT_SCHEMA_ID,
    schemaVersion: BEHAVIOR_SNAPSHOT_SCHEMA_VERSION,
    bundleId,
    modelVersion,
    promptBundleHash,
    modelRoutingHash,
    toolSchemaHash,
    contextCompilerHash,
    qualityPolicyHash,
    recoveryPolicyHash,
    knowledgeSnapshotHash,
    runtimeFingerprint,
    capabilityPackageSetHash: computeEmptyCapabilityPackageSetHash(),
    evalProtocolVersion,
    components,
    runtimeVersions,
    capturedAt: new Date().toISOString(),
  };
}

/**
 * 用默认行为资产路径采集快照（生产入口默认使用）。
 * modelVersion / evalProtocolVersion 由调用方传入。
 */
export function captureDefaultBehaviorSnapshot(
  projectRoot: string,
  modelVersion: string,
  evalProtocolVersion: string,
): RuntimeDataSnapshot {
  return captureBehaviorSnapshot({
    projectRoot,
    modelVersion,
    evalProtocolVersion,
    modelRoutingPaths: DEFAULT_MODEL_ROUTING_PATHS,
    promptBundlePaths: DEFAULT_PROMPT_BUNDLE_PATHS,
    toolSchemaPaths: DEFAULT_TOOL_SCHEMA_PATHS,
    contextCompilerPaths: DEFAULT_CONTEXT_COMPILER_PATHS,
    qualityPolicyPaths: DEFAULT_QUALITY_POLICY_PATHS,
    recoveryPolicyPaths: DEFAULT_RECOVERY_POLICY_PATHS,
    knowledgeSnapshotPaths: DEFAULT_KNOWLEDGE_SNAPSHOT_PATHS,
    runtimeFilePaths: DEFAULT_RUNTIME_FILE_PATHS,
    buildArtifactPaths: DEFAULT_BUILD_ARTIFACT_PATHS,
    buildArtifactDirs: DEFAULT_BUILD_ARTIFACT_DIRS,
  });
}

// ============================================================================
// verifyBehaviorSnapshot
// ============================================================================

export interface SnapshotVerificationCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface SnapshotVerificationResult {
  reproducible: boolean;
  checks: SnapshotVerificationCheck[];
}

/**
 * 独立校验两个快照在行为层面是否可复现。
 *
 * 校验口径（计划 §5 DG-2 验收）：
 * - bundleId 一致
 * - 8 个组件 hash 一致
 * - 运行时版本一致
 *
 * capturedAt 不参与比较（时间戳非行为）。
 */
export function verifyBehaviorSnapshot(
  recorded: RuntimeDataSnapshot,
  actual: RuntimeDataSnapshot,
): SnapshotVerificationResult {
  const checks: SnapshotVerificationCheck[] = [];

  const bundleMatch = recorded.bundleId === actual.bundleId && actual.bundleId !== "";
  checks.push({
    name: "bundleId 一致",
    passed: bundleMatch,
    detail: bundleMatch
      ? `bundleId=${actual.bundleId.slice(0, 16)}…`
      : `recorded=${recorded.bundleId.slice(0, 16)}…, actual=${actual.bundleId.slice(0, 16)}…`,
  });

  const componentNames: Array<{
    field: "promptBundleHash" | "modelRoutingHash" | "toolSchemaHash" | "contextCompilerHash" |
      "qualityPolicyHash" | "recoveryPolicyHash" | "knowledgeSnapshotHash" | "runtimeFingerprint";
    label: string;
  }> = [
    { field: "promptBundleHash", label: "promptBundleHash" },
    { field: "modelRoutingHash", label: "modelRoutingHash" },
    { field: "toolSchemaHash", label: "toolSchemaHash" },
    { field: "contextCompilerHash", label: "contextCompilerHash" },
    { field: "qualityPolicyHash", label: "qualityPolicyHash" },
    { field: "recoveryPolicyHash", label: "recoveryPolicyHash" },
    { field: "knowledgeSnapshotHash", label: "knowledgeSnapshotHash" },
    { field: "runtimeFingerprint", label: "runtimeFingerprint" },
  ];
  for (const { field, label } of componentNames) {
    const match = recorded[field] === actual[field];
    checks.push({
      name: `${label} 一致`,
      passed: match,
      detail: match ? "一致" : `recorded=${recorded[field].slice(0, 16)}…, actual=${actual[field].slice(0, 16)}…`,
    });
  }

  const nodeMatch = recorded.runtimeVersions.node === actual.runtimeVersions.node;
  const npmMatch = recorded.runtimeVersions.npm === actual.runtimeVersions.npm;
  checks.push({
    name: "runtimeVersions 一致",
    passed: nodeMatch && npmMatch,
    detail: nodeMatch && npmMatch
      ? `node=${actual.runtimeVersions.node} npm=${actual.runtimeVersions.npm}`
      : `recorded node=${recorded.runtimeVersions.node} npm=${recorded.runtimeVersions.npm}, actual node=${actual.runtimeVersions.node} npm=${actual.runtimeVersions.npm}`,
  });

  const reproducible = checks.every((c) => c.passed);
  return { reproducible, checks };
}
