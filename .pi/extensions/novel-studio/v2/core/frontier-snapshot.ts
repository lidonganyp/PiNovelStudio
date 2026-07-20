/**
 * FRONTIER-SNAPSHOT-1 — accepted frontier 截取的干净工作区快照
 *
 * 任务卡 P0-2：为模型比较建立"截至上一接受章节"的干净上下文，
 * 而不是直接复制当前 workspace（会带入 ch17+ 派生状态污染比较）。
 *
 * 设计原则：
 * - 仅保留截至 throughChapter 已接受的正文 + 状态（过滤 ch>N 的 entries）
 * - 输出到 sibling 目录（与源 workspace 并列），结构上禁止反向写入源
 * - manifest 记录 sourceWorkspace / throughChapter / fileHashes / excludedContent / stateStats
 * - manifestHash = SHA-256(排序后的 fileHashes)，用于一致性比较（同输入 → 同输出）
 * - 源 workspace 中任何不可解析 sourceChapter 的状态条目 → 直接阻断，不猜测
 *
 * 路径：dist-eval/v2/core/frontier-snapshot.js（eval/benchmarking 基础设施，
 * 不进入生产闭包，不依赖 dist/）
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  copyFileSync,
} from "node:fs";
import { join, dirname, relative, sep, basename } from "node:path";

import { loadStateStore } from "./final-state-commit.js";
import type {
  NarrativeStateStore,
  NarrativeStateEntry,
} from "./final-state-commit.js";

// ============================================================================
// 公开 API
// ============================================================================

export interface FrontierSnapshotInput {
  workspaceId: string;
  throughChapter: number;
  projectRoot: string;
  /** 输出目录；默认 `${projectRoot}/workspaces/${workspaceId}-snapshot-ch${throughChapter}` */
  outputDir?: string;
}

export interface FrontierFileHash {
  path: string; // 相对快照根目录的路径（POSIX 形式）
  sha256: string;
  bytes: number;
}

export interface FrontierExcludedEntry {
  path: string; // 相对源 workspace 根目录的路径（POSIX 形式）
  reason: string;
}

export interface FrontierStateStats {
  canon: number;
  character: number;
  promise: number;
  pattern: number;
  expectation: number;
  excludedFutureEntries: number;
  excludedUnparseableEntries: number;
  blocked: boolean;
}

export interface FrontierSnapshotManifest {
  schemaVersion: 1;
  sourceWorkspace: string;
  throughChapter: number;
  createdAt: string;
  fileHashes: FrontierFileHash[];
  excludedContent: FrontierExcludedEntry[];
  stateStats: FrontierStateStats;
  /** SHA-256(排序后的 fileHashes)，用于一致性比较 */
  manifestHash: string;
  /** 源 workspace 所有文件的 SHA-256（前后对比证明源未被修改） */
  sourceWorkspaceHash: string;
}

export interface FrontierSnapshotResult {
  manifest: FrontierSnapshotManifest;
  outputDir: string;
  blocked: boolean;
  blockReason?: string;
}

// ============================================================================
// 常量：必须复制 / 必须排除的文件清单
// ============================================================================

/** 不可变基础文件（直接复制） */
const IMMUTABLE_FILES = [
  "config.json",
  "creative-constitution.json",
  "CORE-WRITING-PRINCIPLES.md",
  "WORLDBUILDING-CANON.md",
  "USER-REVISION-LEARNINGS.md",
  "type-profile.json",
  "SCENE-RULE-DECISION-MATRIX.md",
  "chapter-hooks-ledger.md",
];

/** 不可变目录（直接递归复制） */
const IMMUTABLE_DIRS = [
  "characters",
  "styles",
  "worldbuilding",
];

/** session 产物目录（一律排除） */
const SESSION_DIRS = [
  "traces",
  "comparisons",
  "reports",
  "drafts",
  "v2-candidates",
  "_archive",
  "runtime",
  "craft-lessons",
  "scripts",
];

/** 必须排除的 session 产物文件后缀 */
const SESSION_FILE_SUFFIXES = [".rq3.md", ".rq3.json"];

/** series/ 中只保留 outline.md；其余显式排除或按章节过滤 */
const SERIES_KEEP_FILES = ["outline.md"];

// ============================================================================
// 入口函数
// ============================================================================

export async function createFrontierSnapshot(
  input: FrontierSnapshotInput
): Promise<FrontierSnapshotResult> {
  const sourceWsDir = join(input.projectRoot, "workspaces", input.workspaceId);
  if (!existsSync(sourceWsDir)) {
    return blocked(input, `源工作区不存在：${sourceWsDir}`);
  }

  // 源工作区 hash（在快照生成前计算，用于后续前后对比证明源未被修改）
  const sourceWorkspaceHash = hashDirectory(sourceWsDir);

  const outputDir =
    input.outputDir ??
    join(input.projectRoot, "workspaces", `${input.workspaceId}-snapshot-ch${input.throughChapter}`);
  const targetWorkspaceId = basename(outputDir);

  // 准备输出目录（清空已有内容会破坏幂等性；改为允许覆盖相同文件）
  mkdirSync(outputDir, { recursive: true });

  const fileHashes: FrontierFileHash[] = [];
  const excludedContent: FrontierExcludedEntry[] = [];

  // 1. 复制不可变基础文件
  for (const relPath of IMMUTABLE_FILES) {
    const src = join(sourceWsDir, relPath);
    if (existsSync(src)) {
      const dst = join(outputDir, relPath);
      mkdirSync(dirname(dst), { recursive: true });
      if (relPath === "config.json") {
        const config = JSON.parse(readFileSync(src, "utf8")) as Record<string, unknown>;
        writeFileSync(dst, JSON.stringify({
          ...config,
          workspaceId: targetWorkspaceId,
          chapterProgress: {
            completed: input.throughChapter,
            current: input.throughChapter + 1,
          },
        }, null, 2), "utf8");
      } else {
        copyFileSync(src, dst);
      }
      fileHashes.push(hashFile(dst, relPath));
    }
  }

  // 2. 递归复制不可变目录
  for (const dirName of IMMUTABLE_DIRS) {
    const srcDir = join(sourceWsDir, dirName);
    if (existsSync(srcDir) && statSync(srcDir).isDirectory()) {
      const dstDir = join(outputDir, dirName);
      copyDirectoryRecursive(srcDir, dstDir, fileHashes);
    }
  }

  // 3. 复制 chapters/，仅保留 <= throughChapter 的 canonical chapter 文件
  const chaptersDir = join(sourceWsDir, "chapters");
  if (existsSync(chaptersDir)) {
    const dstChaptersDir = join(outputDir, "chapters");
    mkdirSync(dstChaptersDir, { recursive: true });
    for (const entry of readdirSync(chaptersDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const name = entry.name;

      // session 产物后缀一律排除
      if (SESSION_FILE_SUFFIXES.some((sfx) => name.endsWith(sfx))) {
        excludedContent.push({ path: `chapters/${name}`, reason: "session_artifact_suffix" });
        continue;
      }

      const chapterNum = parseChapterFileName(name);
      if (chapterNum === null) {
        // 非 canonical 章节文件（无法解析章节号）→ 排除
        excludedContent.push({ path: `chapters/${name}`, reason: "non_canonical_chapter_file" });
        continue;
      }
      if (chapterNum > input.throughChapter) {
        excludedContent.push({
          path: `chapters/${name}`,
          reason: `chapter_after_frontier(${chapterNum}>${input.throughChapter})`,
        });
        continue;
      }
      // 复制
      const src = join(chaptersDir, name);
      const dst = join(dstChaptersDir, name);
      copyFileSync(src, dst);
      fileHashes.push(hashFile(dst, `chapters/${name}`));
    }
  }

  // 4. 复制 series/，仅保留高层 outline.md（其余显式排除或按章节过滤）
  const seriesDir = join(sourceWsDir, "series");
  if (existsSync(seriesDir)) {
    const dstSeriesDir = join(outputDir, "series");
    mkdirSync(dstSeriesDir, { recursive: true });
    for (const entry of readdirSync(seriesDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const name = entry.name;

      // outline.md：高层背景，直接复制
      if (SERIES_KEEP_FILES.includes(name)) {
        const src = join(seriesDir, name);
        const dst = join(dstSeriesDir, name);
        copyFileSync(src, dst);
        fileHashes.push(hashFile(dst, `series/${name}`));
        continue;
      }

      if (name === "skeleton.json") {
        const src = join(seriesDir, name);
        const parsed = JSON.parse(readFileSync(src, "utf8")) as {
          chapterSkeletons?: Record<string, unknown>;
          lastUpdated?: unknown;
        };
        const chapterSkeletons = Object.fromEntries(
          Object.entries(parsed.chapterSkeletons ?? {}).filter(([key]) => {
            const chapterNumber = parseChapterKey(key);
            return chapterNumber !== null && chapterNumber <= input.throughChapter;
          }),
        );
        const dst = join(dstSeriesDir, name);
        writeFileSync(dst, JSON.stringify({
          chapterSkeletons,
          ...(typeof parsed.lastUpdated === "string" ? { lastUpdated: parsed.lastUpdated } : {}),
        }, null, 2), "utf8");
        fileHashes.push(hashFile(dst, `series/${name}`));
        continue;
      }

      if (name === "narrative-state.json") {
        const src = join(seriesDir, name);
        const parsed = JSON.parse(readFileSync(src, "utf8")) as {
          currentChapter?: unknown;
          chapterProgress?: { completed?: unknown };
        };
        const currentChapter = typeof parsed.currentChapter === "number"
          ? parsed.currentChapter
          : typeof parsed.chapterProgress?.completed === "number"
            ? parsed.chapterProgress.completed
            : null;
        if (currentChapter !== null && currentChapter <= input.throughChapter) {
          const dst = join(dstSeriesDir, name);
          copyFileSync(src, dst);
          fileHashes.push(hashFile(dst, `series/${name}`));
        } else {
          excludedContent.push({
            path: `series/${name}`,
            reason: "narrative_state_after_or_without_frontier",
          });
        }
        continue;
      }

      // ch{N}-outline-explicit.md：post-write 章纲；仅保留 N <= frontier
      const explicitMatch = name.match(/^ch(\d+)-outline-explicit\.md$/);
      if (explicitMatch) {
        const n = Number(explicitMatch[1]);
        if (n <= input.throughChapter) {
          const src = join(seriesDir, name);
          const dst = join(dstSeriesDir, name);
          copyFileSync(src, dst);
          fileHashes.push(hashFile(dst, `series/${name}`));
        } else {
          excludedContent.push({
            path: `series/${name}`,
            reason: `chapter_after_frontier(${n}>${input.throughChapter})`,
          });
        }
        continue;
      }

      // 其余 series/ 文件（fatigue-state.json、narrative-state.json、full-outline-v*.md 等）
      // 均为可变或与具体章节强耦合，无法按 frontier 安全截取 → 排除
      excludedContent.push({
        path: `series/${name}`,
        reason: "non_immutable_series_file",
      });
    }
  }

  // 5. 处理 narrative-state-store.json：按 sourceChapter 严格过滤
  const stateStorePath = join(sourceWsDir, "narrative-state-store.json");
  let stateStats: FrontierStateStats = {
    canon: 0,
    character: 0,
    promise: 0,
    pattern: 0,
    expectation: 0,
    excludedFutureEntries: 0,
    excludedUnparseableEntries: 0,
    blocked: false,
  };

  if (existsSync(stateStorePath)) {
    // loadStateStore 调 normalizeStore 会把 updatedAt 改成 new Date()，
    // 破坏幂等性。这里直接读原始 JSON 取 updatedAt。
    const rawStoreText = readFileSync(stateStorePath, "utf8");
    const rawStoreJson = JSON.parse(rawStoreText) as Partial<NarrativeStateStore>;
    const originalUpdatedAt = rawStoreJson.updatedAt ?? "1970-01-01T00:00:00.000Z";

    const store = loadStateStore(input.workspaceId, input.projectRoot);
    const prunedResult = pruneStateStoreByChapter(store, input.throughChapter);

    if (prunedResult.blocked) {
      // 不可解析 sourceChapter → 直接阻断，不写入快照
      return blocked(input, prunedResult.blockReason!, sourceWorkspaceHash);
    }

    // 写入过滤后的 store 到快照目录（直接写文件，不走 saveStateStore，
    // 因为 saveStateStore 的路径解析假设了 source workspace 结构）
    const snapStatePath = join(outputDir, "narrative-state-store.json");
    // 保持源 store 的 updatedAt（快照是 source 截至 frontier 的镜像，
    // 不应生成新的 updatedAt；否则连续两次快照 hash 不一致，破坏幂等性）
    const prunedStore: NarrativeStateStore = {
      ...prunedResult.store,
      workspaceId: targetWorkspaceId,
      compactionReport: undefined,
      updatedAt: originalUpdatedAt,
    };

    stateStats = {
      ...prunedResult.stats,
      blocked: false,
    };
    const acceptedStateCount = stateStats.canon + stateStats.character + stateStats.promise
      + stateStats.pattern + stateStats.expectation;
    if (acceptedStateCount > 0) {
      writeFileSync(snapStatePath, JSON.stringify(prunedStore, null, 2), "utf8");
      fileHashes.push(hashFile(snapStatePath, "narrative-state-store.json"));
    } else {
      excludedContent.push({
        path: "narrative-state-store.json",
        reason: "no_accepted_entries_at_frontier",
      });
    }
  }

  // 6. 记录 session 产物目录的排除（即使源不存在也记录意图）
  for (const dirName of SESSION_DIRS) {
    const dir = join(sourceWsDir, dirName);
    if (existsSync(dir)) {
      excludedContent.push({ path: `${dirName}/`, reason: "session_artifact_dir" });
    }
  }

  // 7. 写 manifest
  const manifest: FrontierSnapshotManifest = {
    schemaVersion: 1,
    sourceWorkspace: input.workspaceId,
    throughChapter: input.throughChapter,
    createdAt: new Date().toISOString(),
    fileHashes: [...fileHashes].sort((a, b) => a.path.localeCompare(b.path)),
    excludedContent: [...excludedContent].sort((a, b) => a.path.localeCompare(b.path)),
    stateStats,
    manifestHash: computeManifestHash(fileHashes),
    sourceWorkspaceHash,
  };

  writeFileSync(
    join(outputDir, "frontier-manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf8"
  );

  return { manifest, outputDir, blocked: false };
}

// ============================================================================
// 内部：状态过滤（按 sourceChapter 严格回溯）
// ============================================================================

interface PrunedStateResult {
  store: NarrativeStateStore;
  stats: Omit<FrontierStateStats, "blocked">;
  blocked: boolean;
  blockReason?: string;
}

function pruneStateStoreByChapter(
  store: NarrativeStateStore,
  throughChapter: number
): PrunedStateResult {
  const allEntries: NarrativeStateEntry[] = [
    ...store.canon,
    ...store.character,
    ...store.promise,
    ...store.pattern,
    ...(store.expectation ?? []),
  ];

  const accepted: NarrativeStateEntry[] = [];
  let excludedFutureEntries = 0;
  let excludedUnparseableEntries = 0;
  const unparseableExamples: string[] = [];

  for (const entry of allEntries) {
    const parsed = parseChapterNumber(entry.sourceChapter);
    if (parsed === null) {
      excludedUnparseableEntries++;
      unparseableExamples.push(`${entry.id}(${entry.sourceChapter})`);
      continue;
    }
    if (parsed > throughChapter) {
      excludedFutureEntries++;
      continue;
    }
    accepted.push(entry);
  }

  if (unparseableExamples.length > 0) {
    return {
      store,
      stats: {
        canon: 0, character: 0, promise: 0, pattern: 0, expectation: 0,
        excludedFutureEntries,
        excludedUnparseableEntries,
      },
      blocked: true,
      blockReason: `状态条目 sourceChapter 不可解析（无法按章节回溯，不猜测）：${unparseableExamples.slice(0, 5).join("; ")}${unparseableExamples.length > 5 ? ` ... (+${unparseableExamples.length - 5} more)` : ""}`,
    };
  }

  // 重新分桶
  const canon = accepted.filter((e): e is Extract<typeof e, { kind: "canon" }> => e.kind === "canon");
  const character = accepted.filter((e): e is Extract<typeof e, { kind: "character" }> => e.kind === "character");
  const promise = accepted.filter((e): e is Extract<typeof e, { kind: "promise" }> => e.kind === "promise");
  const pattern = accepted.filter((e): e is Extract<typeof e, { kind: "pattern" }> => e.kind === "pattern");
  const expectation = accepted.filter((e): e is Extract<typeof e, { kind: "expectation" }> => e.kind === "expectation");

  const prunedStore: NarrativeStateStore = {
    ...store,
    canon,
    character,
    promise,
    pattern,
    expectation,
    lastCommittedChapter: throughChapter > 0 ? `ch${throughChapter}` : store.lastCommittedChapter,
  };

  return {
    store: prunedStore,
    stats: {
      canon: canon.length,
      character: character.length,
      promise: promise.length,
      pattern: pattern.length,
      expectation: expectation.length,
      excludedFutureEntries,
      excludedUnparseableEntries,
    },
    blocked: false,
  };
}

// ============================================================================
// 内部：文件/目录工具
// ============================================================================

function parseChapterNumber(value: string | undefined | null): number | null {
  if (!value) return null;
  const match = value.match(/^ch(\d+)$/);
  return match ? Number(match[1]) : null;
}

function parseChapterKey(value: string): number | null {
  const match = value.match(/^(?:ch|chapter-)?(\d+)$/i);
  return match ? Number(match[1]) : null;
}

/** 从章节文件名解析章节号；仅接受 `{N}.md` / `chapter-{NN}.md` 形式 */
function parseChapterFileName(name: string): number | null {
  const m1 = name.match(/^(\d+)\.md$/);
  if (m1) return Number(m1[1]);
  const m2 = name.match(/^chapter-(\d+)\.md$/i);
  if (m2) return Number(m2[1]);
  return null;
}

function hashFile(absPath: string, relPath: string): FrontierFileHash {
  const content = readFileSync(absPath);
  return {
    path: relPath.replace(/\\/g, "/"),
    sha256: createHash("sha256").update(content).digest("hex"),
    bytes: content.length,
  };
}

function hashDirectory(dir: string): string {
  const hashes: string[] = [];
  walk(dir, (full) => {
    const rel = relative(dir, full).replace(/\\/g, "/");
    const content = readFileSync(full);
    const h = createHash("sha256").update(content).digest("hex");
    hashes.push(`${rel}:${h}`);
  });
  hashes.sort();
  return createHash("sha256").update(hashes.join("\n")).digest("hex");
}

function walk(dir: string, cb: (full: string) => void): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, cb);
    else if (entry.isFile()) cb(full);
  }
}

function copyDirectoryRecursive(src: string, dst: string, fileHashes: FrontierFileHash[]): void {
  mkdirSync(dst, { recursive: true });
  walk(src, (full) => {
    const rel = relative(src, full);
    const target = join(dst, rel);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(full, target);
    fileHashes.push(hashFile(target, rel));
  });
}

function computeManifestHash(fileHashes: FrontierFileHash[]): string {
  const sorted = [...fileHashes].sort((a, b) => a.path.localeCompare(b.path));
  const payload = sorted.map((f) => `${f.path}:${f.sha256}:${f.bytes}`).join("\n");
  return createHash("sha256").update(payload).digest("hex");
}

function blocked(
  input: FrontierSnapshotInput,
  reason: string,
  sourceWorkspaceHash?: string
): FrontierSnapshotResult {
  // 阻断时仍输出 manifest（记录阻断原因），但 outputDir 不创建
  const outputDir =
    input.outputDir ??
    join(input.projectRoot, "workspaces", `${input.workspaceId}-snapshot-ch${input.throughChapter}`);

  const manifest: FrontierSnapshotManifest = {
    schemaVersion: 1,
    sourceWorkspace: input.workspaceId,
    throughChapter: input.throughChapter,
    createdAt: new Date().toISOString(),
    fileHashes: [],
    excludedContent: [],
    stateStats: {
      canon: 0,
      character: 0,
      promise: 0,
      pattern: 0,
      expectation: 0,
      excludedFutureEntries: 0,
      excludedUnparseableEntries: 0,
      blocked: true,
    },
    manifestHash: "",
    sourceWorkspaceHash: sourceWorkspaceHash ?? "",
  };

  return {
    manifest,
    outputDir,
    blocked: true,
    blockReason: reason,
  };
}
