/**
 * V2 Legacy Workspace Adapter
 *
 * 包装 legacy novel-studio 的 workspace/ChapterSeed/角色档案/风格资料/runtime rules，
 * 暴露给 V2 ContextCompiler。旧模块只能通过本 adapter 被 V2 调用。
 *
 * 设计原则（规格 P0/P11）：
 * - 旧模块只能通过 adapter 被 V2 调用，不能反向控制 V2 主流程
 * - 只读加载，不触发任何重写/门禁
 * - 每条加载的数据带来源信息，供 CompiledContext.sourceMap 追溯
 */

import { join } from "path";
import { existsSync, readFileSync, readdirSync } from "fs";
import { buildChapterSeed } from "../../craft/chapter-seed-builder.js";
import type {
  ChapterSeedBuilderResult,
  ChapterSeedBuilderOptions,
} from "../../craft/chapter-seed-builder.js";
import type { ChapterSeed } from "../../craft/chapter-seed-types.js";

// ============================================================================
// WorkspaceBundle — workspace 加载结果
// ============================================================================

export interface WorkspaceBundle {
  workspaceId: string;
  workspacePath: string;
  projectRoot: string;
  config: Record<string, unknown>;
}

export interface CharacterProfile {
  id: string;
  name: string;
  content: string;
  role?: string;
  aliases?: string[];
}

export interface StyleProfileEntry {
  id: string;
  kind: "fingerprint";
  content: string;
  sourcePath: string;
}

export interface RuntimeRuleEntry {
  id: string;
  ruleId: string;
  status: string;
  content: unknown;
  sourcePath: string;
}

// ============================================================================
// 加载函数
// ============================================================================

function readJsonFile<T = any>(filePath: string): T | null {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

export function loadWorkspace(workspaceId: string, projectRoot: string): WorkspaceBundle {
  const workspacePath = join(projectRoot, "workspaces", workspaceId);
  const config = readJsonFile<Record<string, unknown>>(join(workspacePath, "config.json")) || {};
  return { workspaceId, workspacePath, projectRoot, config };
}

/**
 * EVAL-REPLAY-ACCEPTANCE-LOOP F4：冻结 ChapterSeed 文件名。
 *
 * 该文件仅由 eval 回放 Runner 在 scratch workspace 物化
 * （来源 fixture.chapterSeed.frozenFullSeed）；生产 workspace 不存在此文件，
 * 行为不变。存在时 loadChapterSeed 优先返回冻结 seed（重写 workspaceId
 * 为当前 workspace 身份），保证回放与采集时 seed 逐字段一致，
 * 而不是从 scratch workspace 重新推导。
 */
export const FROZEN_CHAPTER_SEED_FILENAME = "chapter-seed-frozen.json";

export function loadChapterSeed(
  bundle: WorkspaceBundle,
  chapterNumber: number,
  chapterId?: string
): ChapterSeedBuilderResult {
  const effectiveChapterId = chapterId ?? String(chapterNumber);
  const frozenPath = join(
    bundle.workspacePath,
    "series",
    FROZEN_CHAPTER_SEED_FILENAME,
  );
  const frozen = readJsonFile<ChapterSeed>(frozenPath);
  if (frozen && typeof frozen === "object") {
    // 身份字段重写为当前 workspace（scratch 回放身份），其余字段原样冻结。
    // chapterId/chapterNumber 不一致说明冻结 seed 与请求章节不匹配：
    // 视为损坏（返回 null 走重新推导会在回放中静默漂移，不可接受）。
    if (
      String(frozen.chapterId) === effectiveChapterId &&
      frozen.chapterNumber === chapterNumber
    ) {
      return {
        seed: { ...frozen, workspaceId: bundle.workspaceId },
        warnings: [
          `loadChapterSeed 消费冻结 ChapterSeed（${FROZEN_CHAPTER_SEED_FILENAME}，eval 回放注入；非冻结推导路径）`,
        ],
      };
    }
    return buildChapterSeedWithWarning(
      bundle,
      chapterNumber,
      effectiveChapterId,
      `冻结 ChapterSeed 身份不匹配（frozen chapterId=${String(frozen.chapterId)}/chapterNumber=${frozen.chapterNumber}，请求 ${effectiveChapterId}/${chapterNumber}），已回退重新推导`,
    );
  }
  const options: ChapterSeedBuilderOptions = {
    workspacePath: bundle.workspacePath,
    workspaceId: bundle.workspaceId,
    chapterId: effectiveChapterId,
    chapterNumber,
  };
  return buildChapterSeed(options);
}

function buildChapterSeedWithWarning(
  bundle: WorkspaceBundle,
  chapterNumber: number,
  chapterId: string,
  warning: string,
): ChapterSeedBuilderResult {
  const result = buildChapterSeed({
    workspacePath: bundle.workspacePath,
    workspaceId: bundle.workspaceId,
    chapterId,
    chapterNumber,
  });
  return { ...result, warnings: [...result.warnings, warning] };
}

export function loadCharacterProfiles(bundle: WorkspaceBundle): CharacterProfile[] {
  const charsDir = join(bundle.workspacePath, "characters");
  if (!existsSync(charsDir)) return [];
  const roster: CharacterProfile[] = [];
  for (const entry of readdirSync(charsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const id = entry.name.replace(/\.md$/i, "");
    try {
      const content = readFileSync(join(charsDir, entry.name), "utf-8");
      const h1 = content.match(/^#\s+(.+)$/m);
      const name = h1 ? h1[1].trim() : id;
      roster.push({ id, name, content });
    } catch {
      // ignore unreadable file
    }
  }
  return roster;
}

export function loadStyleProfile(
  bundle: WorkspaceBundle,
  projectRoot: string
): StyleProfileEntry | null {
  const styleProfileName = (bundle.config.styleProfile as string) || (bundle.config.styleProfileName as string);
  const candidatePaths = [
    // Workspace-local author fingerprints are work-specific and take precedence
    // over a shared profile with the same configured name.
    join(bundle.workspacePath, "styles", "profile.json"),
    ...(styleProfileName
      ? [
          join(projectRoot, "styles", "profiles", `${styleProfileName}.json`),
          join(bundle.workspacePath, "styles", `${styleProfileName}.json`),
        ]
      : []),
  ];
  for (const p of candidatePaths) {
    const raw = readJsonFile<any>(p);
    if (raw) {
      return {
        id: `style:${styleProfileName || bundle.workspaceId}`,
        kind: "fingerprint",
        content: JSON.stringify(raw),
        sourcePath: p,
      };
    }
  }
  return null;
}

export function loadRuntimeRules(projectRoot: string): RuntimeRuleEntry[] {
  const rulesPath = join(projectRoot, "data", "runtime", "validated-craft-rules.json");
  const raw = readJsonFile<any>(rulesPath);
  if (!raw) return [];
  // 兼容数组或 { rules: [...] } 两种结构
  const rules: any[] = Array.isArray(raw) ? raw : Array.isArray(raw?.rules) ? raw.rules : [];
  return rules.map((r, i) => ({
    id: `runtime_rule:${r.id ?? r.ruleId ?? i}`,
    ruleId: r.id ?? r.ruleId ?? String(i),
    status: r.status ?? "candidate",
    content: r,
    sourcePath: rulesPath,
  }));
}

export type { ChapterSeed, ChapterSeedBuilderResult };
