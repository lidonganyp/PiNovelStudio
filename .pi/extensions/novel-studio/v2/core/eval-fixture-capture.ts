/**
 * EvalFixture 冻结采集器（离线回放与生产验收闭环 P6）
 *
 * 从真实 workspace + Release Governance manifest 冻结生成 EvalFixtureV1：
 *  - workspace 快照：config.json / outline.md / 角色档案 / 历史章节 hash /
 *    前章 NarrativeState（全部只读，不修改源 workspace）；
 *  - provenance：直接读取 EvolutionReleaseManifest 的行为身份字段
 *    （bundleId / modelVersion / promptBundleHash / …），保证 fixture 与
 *    release 身份同源，不建立第二套 hash 体系；
 *  - 采集后立即用 validateEvalFixtureV1 fail-closed 校验，未通过即拒绝落盘。
 *
 * 采集是只读操作：本模块永不写入 workspaces/、config/evolution-release/
 * 或任何生产面路径；唯一输出是显式指定的 fixture 归档目录。
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, basename } from "node:path";
import {
  EVAL_FIXTURE_SCHEMA_ID,
  EVAL_FIXTURE_SCHEMA_VERSION,
  EVAL_PROTOCOL_VERSION,
  computeEvalFixtureHash,
  validateEvalFixtureV1,
  type EvalFixtureV1,
  type ReplayMode,
  type EvalContractError,
} from "./eval-fixture-contract.js";
import type { EvolutionReleaseManifest } from "../governance/evolution-release-types.js";

// ============================================================================
// 类型
// ============================================================================

export interface CaptureFixtureOptions {
  /** 真实项目根（只读）。 */
  projectRoot: string;
  /** 源 workspace ID（workspaces/{workspaceId}）。 */
  workspaceId: string;
  /** 目标章节号（>=1）。 */
  chapterNumber: number;
  /** 目标章节 ID。 */
  chapterId: string;
  /** 章节标题。 */
  chapterTitle: string;
  /** 回放模式（采集时声明，回放时校验一致）。 */
  replayMode: ReplayMode;
  /**
   * Release manifest（行为身份来源）。
   * 必须来自 createEvolutionReleaseRegistry().loadManifest(releaseId)，
   * 且行为身份字段完整（bundleId / promptBundleHash / …）。
   */
  manifest: EvolutionReleaseManifest;
  /** fixture 归档目录（写入 {archiveDir}/{fixtureId}.json + index）。 */
  archiveDir: string;
  /** fixtureId；默认按 workspace/chapter/release 派生。 */
  fixtureId?: string;
  /** 模型路由（默认 Gemini 生产路由）。 */
  modelRoute?: string;
  /** provider 名。 */
  provider?: string;
  /** grader 版本标识。 */
  graderVersion?: string;
  /** budget hash 来源（默认从 modelPolicy 规范化派生）。 */
  budgetHash?: string;
  /** 模型政策；默认与生产 timeout 环境变量对齐。 */
  modelPolicy?: {
    requestTimeoutMs: number;
    totalTimeoutMs: number;
    maxModelCalls: number;
    maxRecoveryModelCalls: number;
  };
  /** ChapterIntent 快照。 */
  intent?: Record<string, unknown>;
  /** 种子来源说明。 */
  seedSource?: string;
}

export interface CaptureFixtureResult {
  ok: boolean;
  fixture?: EvalFixtureV1;
  fixtureHash?: string;
  fixturePath?: string;
  errors: EvalContractError[];
}

// ============================================================================
// 默认值
// ============================================================================

const DEFAULT_MODEL_ROUTE = "v2_rawstage2_gpt6astra";
const DEFAULT_PROVIDER = "gpt";
const DEFAULT_GRADER_VERSION = "deterministic-v1";
const DEFAULT_MODEL_POLICY = {
  requestTimeoutMs: Number(process.env.PINOVEL_MODEL_REQUEST_TIMEOUT_MS) || 120_000,
  totalTimeoutMs: Number(process.env.PINOVEL_MODEL_TOTAL_TIMEOUT_MS) || 900_000,
  maxModelCalls: 40,
  maxRecoveryModelCalls: 4,
};

// ============================================================================
// 辅助
// ============================================================================

function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

function deriveFixtureId(options: CaptureFixtureOptions): string {
  if (options.fixtureId) return options.fixtureId;
  const raw = `${options.workspaceId}-ch${options.chapterNumber}-${options.manifest.releaseId}`;
  const sanitized = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return sanitized || `fixture-${Date.now()}`;
}

function readJsonIfExists(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function readTextIfExists(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  return readFileSync(path, "utf-8");
}

/** 采集角色档案：characters/ 或 profiles/ 目录下全部 .json/.md。 */
function collectCharacterProfiles(
  workspacePath: string,
): Record<string, string> {
  const profiles: Record<string, string> = {};
  for (const dirName of ["characters", "profiles"]) {
    const dir = join(workspacePath, dirName);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      if (!statSync(fullPath).isFile()) continue;
      if (!/\.(json|md)$/i.test(entry)) continue;
      const key = basename(entry).replace(/\.(json|md)$/i, "");
      if (profiles[key] === undefined) {
        profiles[key] = readFileSync(fullPath, "utf-8");
      }
    }
  }
  return profiles;
}

interface HistoricalChapterSnapshot {
  chapterNumber: number;
  chapterId: string;
  contentHash: string;
  content?: string;
}

/** 采集历史章节：chapters/ 目录（第 1 章前无历史，返回空数组）。 */
function collectHistoricalChapters(
  workspacePath: string,
  targetChapterNumber: number,
  includeContent: boolean,
): HistoricalChapterSnapshot[] {
  const chaptersDir = join(workspacePath, "chapters");
  const snapshots: HistoricalChapterSnapshot[] = [];
  if (!existsSync(chaptersDir) || !statSync(chaptersDir).isDirectory()) {
    return snapshots;
  }
  const chapterFiles = readdirSync(chaptersDir)
    .filter((f) => /\.(json|md|txt)$/i.test(f))
    .sort();
  for (const file of chapterFiles) {
    const match = file.match(/chapter[-_]?(\d+)/i);
    const num = match ? Number(match[1]) : Number.NaN;
    if (!Number.isInteger(num) || num < 1 || num >= targetChapterNumber) continue;
    const content = readFileSync(join(chaptersDir, file), "utf-8");
    snapshots.push({
      chapterNumber: num,
      chapterId: `chapter-${String(num).padStart(3, "0")}`,
      contentHash: sha256Hex(content),
      ...(includeContent ? { content } : {}),
    });
  }
  return snapshots.sort((a, b) => a.chapterNumber - b.chapterNumber);
}

// ============================================================================
// manifest 行为身份校验
// ============================================================================

interface ManifestIdentityFields {
  bundleId: string;
  modelVersion: string;
  promptBundleHash: string;
  toolSchemaHash: string;
  contextCompilerHash: string;
}

/**
 * 从 release manifest 提取行为身份字段。
 * 字段缺失（旧 manifest 未捕获行为身份）→ fail-closed：
 * 旧 release 不能作为 fixture provenance 来源（无法保证回放可追溯性）。
 */
export function extractManifestIdentity(
  manifest: EvolutionReleaseManifest,
): { ok: true; identity: ManifestIdentityFields } | { ok: false; missing: string[] } {
  const missing: string[] = [];
  const required: Array<[keyof ManifestIdentityFields, string | undefined]> = [
    ["bundleId", manifest.bundleId],
    ["modelVersion", manifest.modelVersion],
    ["promptBundleHash", manifest.promptBundleHash],
    ["toolSchemaHash", manifest.toolSchemaHash],
    ["contextCompilerHash", manifest.contextCompilerHash],
  ];
  for (const [field, value] of required) {
    if (typeof value !== "string" || value.trim().length === 0) {
      missing.push(field);
    }
  }
  if (missing.length > 0) return { ok: false, missing };
  return {
    ok: true,
    identity: {
      bundleId: manifest.bundleId as string,
      modelVersion: manifest.modelVersion as string,
      promptBundleHash: manifest.promptBundleHash as string,
      toolSchemaHash: manifest.toolSchemaHash as string,
      contextCompilerHash: manifest.contextCompilerHash as string,
    },
  };
}

// ============================================================================
// 主入口：冻结采集
// ============================================================================

/**
 * 从真实 workspace 冻结 EvalFixtureV1 并落盘。
 *
 * 只读采集 + fail-closed 校验：
 *  1. workspace 快照（config/outline/角色/历史章节/前章 NarrativeState）；
 *  2. provenance 从 release manifest 行为身份派生（同源）；
 *  3. validateEvalFixtureV1 校验通过才写入 {archiveDir}/{fixtureId}.json。
 */
export function captureEvalFixture(
  options: CaptureFixtureOptions,
): CaptureFixtureResult {
  const errors: EvalContractError[] = [];
  const workspacePath = join(options.projectRoot, "workspaces", options.workspaceId);

  // -- workspace 存在性（fail-closed） ------------------------------------
  if (!existsSync(workspacePath)) {
    return {
      ok: false,
      errors: [
        {
          field: "/workspace/sourceWorkspaceId",
          rule: "workspace_not_found",
          message: `workspace 不存在：${workspacePath}`,
        },
      ],
    };
  }

  // -- manifest 行为身份（fail-closed） -----------------------------------
  const identity = extractManifestIdentity(options.manifest);
  if (!identity.ok) {
    return {
      ok: false,
      errors: [
        {
          field: "/provenance",
          rule: "manifest_identity_incomplete",
          message: `release ${options.manifest.releaseId} 行为身份字段缺失（${identity.missing.join(", ")}）；旧 manifest 不能作为 fixture provenance 来源`,
        },
      ],
    };
  }

  // -- workspace 快照 ------------------------------------------------------
  const config =
    readJsonIfExists(join(workspacePath, "config.json")) ??
    ({} as Record<string, unknown>);
  const outline = readTextIfExists(join(workspacePath, "series", "outline.md"));
  const characterProfiles = collectCharacterProfiles(workspacePath);
  const styleProfile = readJsonIfExists(join(workspacePath, "styles", "profile.json"));
  const includeContent =
    options.replayMode === "recorded" ||
    options.replayMode === "production_like" ||
    options.replayMode === "candidate_like";
  const historicalChapters = collectHistoricalChapters(
    workspacePath,
    options.chapterNumber,
    includeContent,
  );
  const chapterContinuity =
    options.chapterNumber > 1
      ? readJsonIfExists(
          join(workspacePath, "chapter-continuity", `${options.chapterNumber - 1}.json`),
        )
      : undefined;

  // -- 前章 NarrativeState（第 2 章及以后必需） ---------------------------
  let priorNarrativeState: Record<string, unknown> | null = null;
  if (options.chapterNumber > 1) {
    const priorNum = options.chapterNumber - 1;
    const statePath = join(
      workspacePath,
      "narrative-state",
      `chapter-${String(priorNum).padStart(3, "0")}-narrative-state.json`,
    );
    const fallbackPath = join(workspacePath, "narrative-state.json");
    priorNarrativeState =
      readJsonIfExists(statePath) ?? readJsonIfExists(fallbackPath) ?? null;
    if (priorNarrativeState === null) {
      errors.push({
        field: "/priorNarrativeState",
        rule: "missing_prior_state",
        message: `第 ${options.chapterNumber} 章需要前章 NarrativeState（未找到 ${statePath} 或 ${fallbackPath}）`,
      });
    }
  }

  // -- 采集层校验错误（如 missing_prior_state）→ fail-closed，不落盘 ------
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // -- budget hash：从 modelPolicy 规范化派生（默认） ----------------------
  const modelPolicy = options.modelPolicy ?? DEFAULT_MODEL_POLICY;
  const budgetHash =
    options.budgetHash ??
    sha256Hex(JSON.stringify(modelPolicy));

  const fixtureId = deriveFixtureId(options);

  const fixture: EvalFixtureV1 = {
    schemaId: EVAL_FIXTURE_SCHEMA_ID,
    schemaVersion: EVAL_FIXTURE_SCHEMA_VERSION,
    fixtureId,
    evalProtocolVersion: EVAL_PROTOCOL_VERSION,
    evalOnly: true,
    replayMode: options.replayMode,
    createdAt: new Date().toISOString(),
    provenance: {
      releaseId: options.manifest.releaseId,
      bundleId: identity.identity.bundleId,
      promptBundleHash: identity.identity.promptBundleHash,
      toolSchemaHash: identity.identity.toolSchemaHash,
      contextCompilerHash: identity.identity.contextCompilerHash,
      budgetHash,
      modelVersion: identity.identity.modelVersion,
      modelRoute: options.modelRoute ?? DEFAULT_MODEL_ROUTE,
      provider: options.provider ?? DEFAULT_PROVIDER,
      graderVersion: options.graderVersion ?? DEFAULT_GRADER_VERSION,
    },
    workspace: {
      sourceWorkspaceId: options.workspaceId,
      config,
      ...(outline !== undefined ? { outline } : {}),
      characterProfiles,
      ...(styleProfile !== undefined ? { styleProfile } : {}),
      ...(chapterContinuity !== undefined ? { chapterContinuity } : {}),
      historicalChapters,
    },
    chapterSeed: {
      chapterNumber: options.chapterNumber,
      chapterId: options.chapterId,
      chapterTitle: options.chapterTitle,
      intent: options.intent ?? {},
      seedSource: options.seedSource ?? "capture:workspace+manifest",
    },
    priorNarrativeState,
    modelPolicy,
    expectedInvariants: {
      statePollutionForbidden: true,
      productionPointerMutationForbidden: true,
      formalChapterSaveForbidden:
        options.replayMode !== "production_like" &&
        options.replayMode !== "candidate_like",
      traceArchiveRequired: true,
      scratchNarrativeStateCommitAllowed: true,
    },
    traceArchivePath: `traces/${options.chapterId}-quality-trace.json`,
  };

  // -- fail-closed 校验 ---------------------------------------------------
  const validation = validateEvalFixtureV1(fixture);
  if (!validation.valid) {
    return { ok: false, errors: [...errors, ...validation.errors] };
  }

  // -- 落盘 ---------------------------------------------------------------
  const fixtureHash = computeEvalFixtureHash(fixture);
  mkdirSync(options.archiveDir, { recursive: true });
  const fixturePath = join(options.archiveDir, `${fixtureId}.json`);
  writeFileSync(fixturePath, JSON.stringify(fixture, null, 2), "utf-8");

  // 索引文件（幂等追加：同 fixtureId 同 hash 跳过）
  const indexPath = join(options.archiveDir, "fixture-index.jsonl");
  const indexEntry = `${JSON.stringify({
    fixtureId,
    fixtureHash,
    releaseId: fixture.provenance.releaseId,
    bundleId: fixture.provenance.bundleId,
    replayMode: fixture.replayMode,
    chapterNumber: fixture.chapterSeed.chapterNumber,
    sourceWorkspaceId: fixture.workspace.sourceWorkspaceId,
    createdAt: fixture.createdAt,
  })}\n`;
  const existingIndex = existsSync(indexPath)
    ? readFileSync(indexPath, "utf-8")
    : "";
  const alreadyIndexed = existingIndex
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .some((line) => {
      try {
        const parsed = JSON.parse(line) as { fixtureId?: string; fixtureHash?: string };
        return parsed.fixtureId === fixtureId && parsed.fixtureHash === fixtureHash;
      } catch {
        return false;
      }
    });
  if (!alreadyIndexed) {
    writeFileSync(indexPath, existingIndex + indexEntry, "utf-8");
  }

  return { ok: true, fixture, fixtureHash, fixturePath, errors: [] };
}
