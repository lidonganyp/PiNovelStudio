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

export function loadChapterSeed(
  bundle: WorkspaceBundle,
  chapterNumber: number,
  chapterId?: string
): ChapterSeedBuilderResult {
  const options: ChapterSeedBuilderOptions = {
    workspacePath: bundle.workspacePath,
    workspaceId: bundle.workspaceId,
    chapterId: chapterId ?? String(chapterNumber),
    chapterNumber,
  };
  return buildChapterSeed(options);
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
  if (!styleProfileName) return null;
  const candidatePaths = [
    join(projectRoot, "styles", "profiles", `${styleProfileName}.json`),
    join(bundle.workspacePath, "styles", `${styleProfileName}.json`),
  ];
  for (const p of candidatePaths) {
    const raw = readJsonFile<any>(p);
    if (raw) {
      return {
        id: `style:${styleProfileName}`,
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
