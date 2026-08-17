/**
 * 不确定性驱动检索消融实验：高风险 case workspace fixture 设置（Step 2 GREEN）
 *
 * 为 high-xuanhuan-1 / high-suspense-1 在临时 projectRoot 中植入真实可检索数据，
 * 使 NarrativeSearchService 的 searchRanked / searchChapterSpan / queryCanon /
 * queryCharacterState / queryPromiseLedger 正向命中 confirmed 证据。
 *
 * 数据布局（对齐 loadStateStore 期望的 narrative-state-store.json 统一格式）：
 * - {projectRoot}/workspaces/{workspaceId}/chapters/chapter-{N}/final.md
 *     ← historicalChapters[].text（被 search_chapter_span 检索，evidenceLevel="exact_chapter_span"）
 * - {projectRoot}/workspaces/{workspaceId}/narrative-state-store.json
 *     ← canonEvents 转换为 canon[]（kind=canon, fact, category=timeline）
 *     ← characterStates 转换为 character[]（kind=character, characterId, field, value）
 *     ← promises 转换为 promise[]（kind=promise, promiseId, description, status, currentHeat）
 *
 * 设计原则：
 * - 临时目录隔离：每个 case × arm 用独立 projectRoot，A/B 互不干扰
 * - fixture 数据对 A/B 相同：避免引入额外变量
 * - try/finally cleanup：runAblationArm 失败也保证清理
 * - 无 fixture 时回退到 parentProjectRoot：低风险 case 行为不变
 *
 * eval-only 模块，需在 tsconfig.eval.json 注册。生产路径不依赖此模块。
 */

import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

// ============================================================================
// AblationWorkspaceFixture 接口（与 r2.json workspaceFixture 字段对齐）
// ============================================================================

/**
 * 高风险 case 的 workspace fixture 数据。
 *
 * 字段语义：
 * - historicalChapters：历史章节正文，被 search_chapter_span 检索
 * - canonEvents：canon 事件，写入 skeleton.json 的 events[]。
 *   fact 字段会被转换为 canon.fact（category=timeline）。
 *   建议 fact 用 authorMustInclude 的核心子串，让 query.includes(fact) 命中。
 * - characterStates：角色状态，写入 narrative-state.json 的 characterUpdates[]。
 *   value 字段会被转换为 character.value（confirmed_state）。
 *   建议 value 用 authorMustInclude 的核心子串，让 query.includes(value) 命中。
 * - promises：伏笔/承诺，写入 arc-registry.json 的 foreshadowings[]。
 */
export interface AblationWorkspaceFixture {
  historicalChapters: Array<{
    number: number;
    title: string;
    text: string;
  }>;
  canonEvents?: Array<{
    id: string;
    fact: string;
    category?: string; // 兼容字段，实际转换后 category=timeline（LegacyStateAdapter 限制）
    sourceChapter?: string; // 兼容字段，实际用 setupAblationWorkspace 的 sourceChapter 参数
    characters?: string[]; // 可选：事件涉及角色，转换为 character presentAt entries
    location?: string; // 可选：事件地点，转换为 canon location entry
  }>;
  characterStates?: Array<{
    characterId: string;
    field: string;
    value: string;
  }>;
  promises?: Array<{
    id: string;
    description: string;
    level?: string; // "high" | "medium" | "low"
    status?: string; // "open" | "advancing" | "fulfilled" | "broken"
  }>;
}

// ============================================================================
// 类型守卫
// ============================================================================

/**
 * 检查未知值是否为合法的 AblationWorkspaceFixture。
 *
 * 用于 loadAblationCases 解析 JSON 时验证 fixture 字段格式。
 */
export function isAblationWorkspaceFixture(value: unknown): value is AblationWorkspaceFixture {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.historicalChapters)) return false;
  for (const ch of v.historicalChapters) {
    if (typeof ch !== "object" || ch === null) return false;
    const c = ch as Record<string, unknown>;
    if (typeof c.number !== "number") return false;
    if (typeof c.title !== "string") return false;
    if (typeof c.text !== "string") return false;
  }
  if (v.canonEvents !== undefined) {
    if (!Array.isArray(v.canonEvents)) return false;
    for (const ev of v.canonEvents) {
      if (typeof ev !== "object" || ev === null) return false;
      const e = ev as Record<string, unknown>;
      if (typeof e.id !== "string") return false;
      if (typeof e.fact !== "string") return false;
    }
  }
  if (v.characterStates !== undefined) {
    if (!Array.isArray(v.characterStates)) return false;
    for (const cs of v.characterStates) {
      if (typeof cs !== "object" || cs === null) return false;
      const c = cs as Record<string, unknown>;
      if (typeof c.characterId !== "string") return false;
      if (typeof c.field !== "string") return false;
      if (typeof c.value !== "string") return false;
    }
  }
  if (v.promises !== undefined) {
    if (!Array.isArray(v.promises)) return false;
    for (const p of v.promises) {
      if (typeof p !== "object" || p === null) return false;
      const pp = p as Record<string, unknown>;
      if (typeof pp.id !== "string") return false;
      if (typeof pp.description !== "string") return false;
    }
  }
  return true;
}

// ============================================================================
// setupAblationWorkspace
// ============================================================================

export interface SetupAblationWorkspaceInput {
  /** case 数据（含 workspaceFixture） */
  caseData: {
    caseId: string;
    targetChapter: number;
    workspaceFixture?: AblationWorkspaceFixture;
  };
  /** 实验臂（A/B），用于隔离 workspaceId */
  arm: "A" | "B";
  /** 父 projectRoot（用于创建临时子目录；无 fixture 时直接返回此值） */
  parentProjectRoot: string;
}

export interface SetupAblationWorkspaceResult {
  /** 实际 projectRoot（临时目录或 parentProjectRoot） */
  projectRoot: string;
  /** workspaceId（含 caseId + arm，A/B 隔离） */
  workspaceId: string;
  /** 是否创建了临时目录（无 fixture 时为 false） */
  createdTempWorkspace: boolean;
}

/**
 * 为高风险 case 创建临时 workspace，植入 fixture 数据。
 *
 * 无 fixture 时直接返回 parentProjectRoot（低风险 case 行为不变）。
 * 有 fixture 时创建 {parentProjectRoot}/.ablation-temp/{caseId}-{arm}-{random}/ 作为 projectRoot，
 * 并按 workspace 布局写入 fixture 数据。
 */
export function setupAblationWorkspace(
  input: SetupAblationWorkspaceInput,
): SetupAblationWorkspaceResult {
  const { caseData, arm, parentProjectRoot } = input;
  const workspaceId = `ablation-${caseData.caseId}-${arm}`;

  // 无 fixture：回退到 parentProjectRoot（行为与低风险 case 一致）
  if (!caseData.workspaceFixture) {
    return {
      projectRoot: parentProjectRoot,
      workspaceId,
      createdTempWorkspace: false,
    };
  }

  // 有 fixture：创建临时 projectRoot
  // 用 mkdtempSync 保证唯一性（避免并发实验冲突）
  const tempDirPrefix = join(
    parentProjectRoot,
    ".ablation-temp",
    `${caseData.caseId}-${arm}-`,
  );
  // 确保父目录存在
  mkdirSync(join(parentProjectRoot, ".ablation-temp"), { recursive: true });
  const tempProjectRoot = mkdtempSync(tempDirPrefix);

  // 写入 fixture 数据
  writeFixtureFiles(
    tempProjectRoot,
    workspaceId,
    caseData.workspaceFixture,
    `ch${caseData.targetChapter}`,
  );

  return {
    projectRoot: tempProjectRoot,
    workspaceId,
    createdTempWorkspace: true,
  };
}

// ============================================================================
// writeFixtureFiles：把 fixture 数据写入 workspace 文件
// ============================================================================

/**
 * 把 fixture 数据写入临时 workspace 目录，对齐 loadStateStore 期望的 narrative-state-store.json 格式。
 *
 * 文件布局：
 * - workspaces/{id}/chapters/chapter-{N}/final.md
 * - workspaces/{id}/narrative-state-store.json
 */
function writeFixtureFiles(
  projectRoot: string,
  workspaceId: string,
  fixture: AblationWorkspaceFixture,
  sourceChapter: string,
): void {
  const workspaceDir = join(projectRoot, "workspaces", workspaceId);
  mkdirSync(workspaceDir, { recursive: true });

  // 1. historicalChapters → chapters/chapter-N/final.md
  for (const ch of fixture.historicalChapters) {
    const chapterDir = join(workspaceDir, "chapters", `chapter-${ch.number}`);
    mkdirSync(chapterDir, { recursive: true });
    writeFileSync(join(chapterDir, "final.md"), ch.text, "utf-8");
  }

  const now = new Date().toISOString();

  // 2. narrative-state-store.json（统一状态存储，替代 legacy skeleton.json + narrative-state.json + arc-registry.json）
  const stateStore = {
    schemaVersion: "narrative-state-store-v1",
    workspaceId,
    canon: (fixture.canonEvents ?? []).map((ev) => ({
      kind: "canon" as const,
      id: ev.id,
      fact: ev.fact,
      category: (ev.category as "timeline" | "location" | "entity" | "ability_rule") ?? "timeline",
      sourceChapter,
      sourceRef: `skeleton:${ev.id}`,
      confidence: 1.0,
      lastUpdated: now,
    })),
    character: (fixture.characterStates ?? []).map((cs) => ({
      kind: "character" as const,
      id: `character:${cs.characterId}:${cs.field}`,
      characterId: cs.characterId,
      field: cs.field,
      value: cs.value,
      sourceChapter,
      sourceRef: `narrative-state:${sourceChapter}`,
      confidence: 1.0,
      lastUpdated: now,
    })),
    promise: (fixture.promises ?? []).map((p) => ({
      kind: "promise" as const,
      id: `promise:${p.id}`,
      promiseId: p.id,
      description: p.description,
      status: (p.status as "open" | "advancing" | "fulfilled" | "broken") ?? "open",
      currentHeat: p.level === "high" ? 0.8 : p.level === "low" ? 0.3 : 0.5,
      sourceChapter,
      sourceRef: `arc-registry:${p.id}`,
      confidence: 1.0,
      lastUpdated: now,
    })),
    pattern: [],
    expectation: [],
    eventLog: [],
    quarantine: [],
    planned: [],
    updatedAt: now,
  };
  writeFileSync(
    join(workspaceDir, "narrative-state-store.json"),
    JSON.stringify(stateStore, null, 2),
    "utf-8",
  );
}

// ============================================================================
// cleanupAblationWorkspace
// ============================================================================

/**
 * 清理临时 projectRoot。
 *
 * 对不存在路径安全跳过（不抛错），便于 try/finally 中无条件调用。
 * 只清理 .ablation-temp 子目录下的临时目录（安全保护，避免误删）。
 */
export function cleanupAblationWorkspace(projectRoot: string): void {
  if (!projectRoot || !existsSync(projectRoot)) return;
  // 安全保护：只清理含 .ablation-temp 的路径，避免误删非临时目录
  if (!projectRoot.includes(".ablation-temp")) {
    return;
  }
  try {
    rmSync(projectRoot, { recursive: true, force: true });
  } catch {
    // 清理失败不抛错（try/finally 中不应抛出二次异常）
  }
}
