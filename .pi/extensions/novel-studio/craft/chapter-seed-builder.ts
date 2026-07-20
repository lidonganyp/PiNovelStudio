/**
 * PiNovelStudio — ChapterSeedBuilder
 *
 * P22：细节锚点先行生成链路
 *
 * 从多个种子源构造本章 ChapterSeed：
 *  - config.json（世界观、类型、角色列表、字数预算）
 *  - 角色档案（characters/*.md）
 *  - 前章 skeleton.json（第 1 章例外）
 *  - narrative-state.json
 *  - detail ledger / unsettled-details.json
 *  - foreshadowing / closure tracker（arc-registry.json）
 *  - 可选 series/outline.md 高层方向（仅作为背景参考）
 *
 * 注意：series/outline.md 若存在，只能作为高层背景/主题/不可违背事实参考；
 * 不能再被编译为事件蓝图，也不能作为生成前置条件。
 */

import { join } from "path";
import { existsSync, readFileSync, readdirSync } from "fs";
import { parseExplicitOutline } from "./explicit-outline-parser.js";
import type {
  ChapterSeed,
  CharacterStateSummary,
  PreviousChapterContinuation,
  CurrentPressure,
  UnsettledDetailSummary,
  WorldConstraintSummary,
  CandidateAnchor,
  HighLevelDirection,
  ChapterIntent,
} from "./chapter-seed-types.js";
import {
  createDefaultNarrativeState,
  normalizeNarrativeState,
} from "./narrative-state-store.js";
import type { NarrativeState } from "../dag/types.js";
import { loadClosureTracker } from "./closure-tracker.js";

export interface ChapterSeedBuilderOptions {
  workspacePath: string;
  workspaceId: string;
  chapterId: string;
  chapterNumber: number;
}

export interface ChapterSeedBuilderResult {
  seed: ChapterSeed;
  /** 加载过程中的警告（非阻断） */
  warnings: string[];
}

/**
 * 确定章节功能类型
 * 与 Architect.determineChapterFunction 保持一致
 */
function determineChapterFunction(chapterNumber: number): "setup" | "escalation" | "payoff" | "climax" {
  const position = chapterNumber % 20;
  if (position <= 3) return "setup";
  if (position <= 15) return "escalation";
  if (position <= 18) return "payoff";
  return "climax";
}

/**
 * 安全读取 JSON 文件
 */
function readJsonFile<T = any>(filePath: string): T | null {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

/**
 * 加载 config.json
 */
function loadWorkspaceConfig(workspacePath: string): any {
  return readJsonFile<any>(join(workspacePath, "config.json")) || {};
}

/**
 * 加载角色档案目录
 */
function loadCharacterProfiles(workspacePath: string): Array<{ id: string; name: string; content: string; role?: string; aliases?: string[] }> {
  const charsDir = join(workspacePath, "characters");
  if (!existsSync(charsDir)) {
    return [];
  }

  const roster: Array<{ id: string; name: string; content: string; role?: string; aliases?: string[] }> = [];
  for (const entry of readdirSync(charsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }
    const id = entry.name.replace(/\.md$/i, "");
    try {
      const content = readFileSync(join(charsDir, entry.name), "utf-8");
      const name = extractFirstCharacterName(content) || id;
      roster.push({ id, name, content });
    } catch {
      // ignore
    }
  }
  return roster;
}

/**
 * 从角色档案文本中提取第一个角色名（简化版）
 */
function extractFirstCharacterName(text: string): string | null {
  // 尝试匹配 markdown 一级标题
  const h1Match = text.match(/^#\s+(.+)$/m);
  if (h1Match) {
    const title = h1Match[1].trim();
    // 去掉"基本信息"等通用后缀
    const nameMatch = title.match(/^([\u4e00-\u9fa5]{2,4}|[A-Za-z]{2,30})/);
    if (nameMatch) {
      return nameMatch[1];
    }
  }

  // 尝试匹配"姓名：X"
  const nameFieldMatch = text.match(/姓名[：:]\s*([^\s,，。]+)/);
  if (nameFieldMatch) {
    return nameFieldMatch[1];
  }

  return null;
}

/**
 * 加载前章 skeleton.json
 */
function loadPreviousSkeleton(workspacePath: string, chapterNumber: number): any | null {
  if (chapterNumber <= 1) {
    return null;
  }
  return readJsonFile<any>(join(workspacePath, "series", "skeleton.json"));
}

/**
 * 加载 narrative-state.json
 */
function loadNarrativeState(workspacePath: string, chapterNumber: number): NarrativeState {
  const statePath = join(workspacePath, "series", "narrative-state.json");
  if (!existsSync(statePath)) {
    return createDefaultNarrativeState(chapterNumber);
  }
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf-8"));
    return normalizeNarrativeState(parsed, chapterNumber);
  } catch {
    return createDefaultNarrativeState(chapterNumber);
  }
}

/**
 * 加载 unsettled-details.json
 */
function loadUnsettledDetails(workspacePath: string, chapterNumber: number): UnsettledDetailSummary[] {
  const detailsPath = join(workspacePath, "series", "unsettled-details.json");
  const data = readJsonFile<any>(detailsPath);
  if (!data) {
    return [];
  }

  const rawDetails: any[] = Array.isArray(data)
    ? data
    : (Array.isArray(data.trackedDetails)
        ? data.trackedDetails
        : (Array.isArray(data.details) ? data.details : []));
  const result: UnsettledDetailSummary[] = [];

  for (const entry of rawDetails) {
    if (!entry || typeof entry !== "object") continue;
    const status = typeof entry.status === "string" ? entry.status : "open";
    if (status !== "open") continue;

    const entryChapter = parseInt(String(entry.chapterId ?? ""), 10);
    if (!isNaN(entryChapter) && entryChapter >= chapterNumber) {
      // 只关心本章之前未结账的细节
      continue;
    }

    result.push({
      id: String(entry.id ?? ""),
      type: String(entry.type ?? "unknown"),
      description: String(entry.description ?? entry.content ?? ""),
      chapterId: String(entry.chapterId ?? ""),
    });
  }

  return result;
}

/**
 * 加载 arc-registry.json（closure tracker）
 */
function loadClosureTrackerData(workspacePath: string) {
  const registryPath = join(workspacePath, "series", "arc-registry.json");
  const tracker = loadClosureTracker(registryPath);
  if (!tracker) {
    return { openArcs: [], pendingForeshadows: [] };
  }
  return {
    openArcs: tracker.getOpenArcsByPriority().map(arc => ({
      arcId: arc.arc_id,
      name: arc.name,
      priority: arc.priority,
      coreQuestion: arc.core_question,
    })),
    pendingForeshadows: tracker.getPendingForeshadows().map(f => ({
      id: f.id,
      description: f.description,
      level: f.level,
    })),
  };
}

/**
 * 加载可选的 series/outline.md 高层方向（仅背景参考）
 */
function loadHighLevelDirection(workspacePath: string, chapterNumber: number): HighLevelDirection {
  const outlinePath = join(workspacePath, "series", "outline.md");
  if (!existsSync(outlinePath)) {
    return {
      available: false,
      backgroundNotes: [],
      immutableFacts: [],
    };
  }

  try {
    const text = readFileSync(outlinePath, "utf-8");
    // 仅提取高层背景/主题/不可违背事实，不提取事件蓝图
    const backgroundNotes: string[] = [];
    const immutableFacts: string[] = [];

    // P22修复：过滤系统元数据关键词，防止 outline.md 文档头等系统信息污染 backgroundNotes。
    // 这些关键词若进入 backgroundNotes，可能被 Architect 误用为事件 location 或被
    // Narrator 事件覆盖自检提取为关键词，导致语义覆盖率过低而阻断生成。
    const SYSTEM_METADATA_KEYWORDS = ["PiNovelStudio", "Workspace", "本文档为系统", "系统使用的卷级骨架"];
    const isSystemMetadata = (text: string): boolean =>
      SYSTEM_METADATA_KEYWORDS.some(kw => text.includes(kw));

    // 提取顶层标题段落作为背景笔记
    const lines = text.split(/\r?\n/);
    let currentSection: string | null = null;
    let buffer: string[] = [];

    const flushBuffer = () => {
      if (currentSection && buffer.length > 0) {
        const joined = buffer.join(" ").trim();
        if (joined && !isSystemMetadata(joined) && !isSystemMetadata(currentSection)) {
          backgroundNotes.push(`[${currentSection}] ${joined.slice(0, 200)}`);
        }
      }
      buffer = [];
    };

    for (const line of lines) {
      const headerMatch = line.match(/^(#{1,2})\s+(.+)$/);
      if (headerMatch) {
        flushBuffer();
        currentSection = headerMatch[2].trim();
        continue;
      }
      if (currentSection) {
        const trimmed = line.trim();
        if (trimmed) {
          buffer.push(trimmed);
        }
      }
    }
    flushBuffer();

    // 提取不可违背事实（如"必须"、"不可"、"禁止"等约束语句）
    const constraintPattern = /(?:必须|不可|不能|禁止|务必)[^\n。，；！？]{4,80}/g;
    let match: RegExpExecArray | null;
    while ((match = constraintPattern.exec(text)) !== null) {
      if (immutableFacts.length < 10) {
        immutableFacts.push(match[0]);
      }
    }

    return {
      available: true,
      backgroundNotes: backgroundNotes.slice(0, 20),
      chapterThemeHint: undefined, // 不从 outline 提取章节主题提示，避免变相依赖章纲
      immutableFacts,
    };
  } catch {
    return {
      available: false,
      backgroundNotes: [],
      immutableFacts: [],
    };
  }
}

/**
 * 构建角色状态摘要
 */
function buildCharacterStateSummaries(
  config: any,
  profiles: Array<{ id: string; name: string; content: string; role?: string; aliases?: string[] }>,
  narrativeState: NarrativeState
): CharacterStateSummary[] {
  const summaries: CharacterStateSummary[] = [];
  const seen = new Set<string>();

  // 1. 从 config.characters 提取
  if (Array.isArray(config.characters)) {
    for (const raw of config.characters) {
      if (!raw || typeof raw !== "object") continue;
      const name = typeof raw.name === "string" ? raw.name : (typeof raw.id === "string" ? raw.id : "");
      if (!name || seen.has(name)) continue;
      seen.add(name);

      const relationship = narrativeState.relationshipTemperature[name];
      summaries.push({
        name,
        role: typeof raw.role === "string" ? raw.role : undefined,
        mentality: relationship?.pendingTension ? `pendingTension: ${relationship.pendingTension}` : undefined,
        pendingTension: relationship?.pendingTension ?? undefined,
        aliases: Array.isArray(raw.aliases) ? raw.aliases : undefined,
      });
    }
  }

  // 2. 从角色档案补充
  for (const profile of profiles) {
    if (seen.has(profile.name)) continue;
    seen.add(profile.name);
    const relationship = narrativeState.relationshipTemperature[profile.name];
    summaries.push({
      name: profile.name,
      role: profile.role,
      mentality: relationship?.pendingTension ? `pendingTension: ${relationship.pendingTension}` : undefined,
      pendingTension: relationship?.pendingTension ?? undefined,
      aliases: profile.aliases,
    });
  }

  return summaries;
}

function loadPreviousChapterTextContinuation(
  workspacePath: string,
  chapterNumber: number
): PreviousChapterContinuation | null {
  const previousNumber = chapterNumber - 1;
  const fileNames = [...new Set([
    `${previousNumber}.md`,
    `chapter-${previousNumber}.md`,
    `chapter-${String(previousNumber).padStart(2, "0")}.md`,
  ])];
  for (const fileName of fileNames) {
    const filePath = join(workspacePath, "chapters", fileName);
    if (!existsSync(filePath)) continue;
    try {
      const text = readFileSync(filePath, "utf8").replace(/^\uFEFF/, "").trim();
      if (!text) continue;
      const maxChars = 1200;
      let excerpt = text.length > maxChars ? text.slice(-maxChars) : text;
      if (text.length > maxChars) {
        const paragraphBreak = excerpt.indexOf("\n\n");
        if (paragraphBreak >= 0 && paragraphBreak < 320) excerpt = excerpt.slice(paragraphBreak + 2);
      }
      const endsAtCompletedBoundary = /[。！？!?…）)”’」』】》]\s*$/u.test(text);
      return {
        available: true,
        lastEventId: `chapter-text-tail:${previousNumber}`,
        lastEventSummary: excerpt,
        openHooks: [],
        introducedCharacters: [],
        unresolvedTensions: endsAtCompletedBoundary
          ? []
          : ["前章正文在进行中的事件处结束，必须先明确其结果再推进新时间/场景"],
        sourceIds: [`chapters/${fileName}`],
      };
    } catch {
      // Try the next accepted chapter-file convention.
    }
  }
  return null;
}

/**
 * 构建前章承接
 *
 * 支持两种 skeleton.json 格式：
 * 1. 旧格式（顶层 events/openHooks/unresolvedTensions）
 * 2. 新格式（chapterSkeletons[chapterId] 包含 facts/stateChanges/activeDilemmas）
 */
function buildPreviousChapterContinuation(
  chapterNumber: number,
  skeleton: any | null,
  workspacePath: string
): PreviousChapterContinuation {
  if (chapterNumber <= 1) {
    return {
      available: false,
      openHooks: [],
      introducedCharacters: [],
      unresolvedTensions: [],
    };
  }

  // 尝试从 chapterSkeletons 中提取前章（chapterNumber - 1）的骨架
  const prevChapterKey = String(chapterNumber - 1);
  const directSkeletonMatchesPreviousChapter =
    String(skeleton?.chapterId ?? "") === prevChapterKey &&
    (
      Array.isArray(skeleton?.facts) ||
      Array.isArray(skeleton?.stateChanges) ||
      Array.isArray(skeleton?.activeDilemmas)
    );
  const prevChapterSkeleton =
    skeleton?.chapterSkeletons?.[prevChapterKey] ??
    skeleton?.chapterSkeletons?.[chapterNumber - 1] ??
    (directSkeletonMatchesPreviousChapter ? skeleton : null) ??
    null;

  // --- 新格式：chapterSkeletons[prevChapterKey] ---
  if (prevChapterSkeleton) {
    const facts: string[] = Array.isArray(prevChapterSkeleton.facts) ? prevChapterSkeleton.facts : [];
    const activeDilemmas: string[] = Array.isArray(prevChapterSkeleton.activeDilemmas)
      ? prevChapterSkeleton.activeDilemmas
      : [];
    const stateChanges: any[] = Array.isArray(prevChapterSkeleton.stateChanges)
      ? prevChapterSkeleton.stateChanges
      : [];

    // 最后一条 fact 作为前章最后事件摘要
    const lastFact = facts.length > 0 ? String(facts[facts.length - 1]) : undefined;
    const lastEventSummary = lastFact ?? prevChapterSkeleton.title ?? undefined;

    // 从 stateChanges 推断离场情绪（简化：取最后一条 after 作为情绪线索）
    let endingEmotion: string | undefined;
    if (stateChanges.length > 0) {
      const lastChange = stateChanges[stateChanges.length - 1];
      endingEmotion = typeof lastChange?.after === "string" ? lastChange.after : undefined;
    }

    // activeDilemmas 作为未解张力
    let unresolvedTensions = activeDilemmas.map(d => String(d));

    // [FIX 2026-06-26] P9 验收修复：activeDilemmas 为空时，用可逆 stateChanges 兜底。
    // 原因：extractActiveDilemmas 依赖正则匹配困境句式（"但...？""不知道...？"），
    // 但章节钩子常为陈述句（如 "那不是调度表"），不匹配正则 → activeDilemmas 空
    // → unresolvedTensions 空 → 下一章 candidateAnchors 不足 → seedReadiness 阻断。
    // 修复：activeDilemmas 为空时，取 isReversible=true 的 stateChanges 的 after 值
    // 作为未解张力（可逆状态变化天然是未结账的悬念锚点）。
    if (unresolvedTensions.length === 0) {
      for (const sc of stateChanges) {
        if (sc?.isReversible && typeof sc?.after === "string" && sc.after.trim().length > 0) {
          const tension = `${sc.after}`;
          if (!unresolvedTensions.includes(tension)) {
            unresolvedTensions.push(tension);
          }
          if (unresolvedTensions.length >= 2) break;
        }
      }
    }

    // 从 stateChanges 提取涉及的角色
    const introducedCharacters: string[] = [];
    for (const sc of stateChanges) {
      if (typeof sc?.subject === "string" && !introducedCharacters.includes(sc.subject)) {
        introducedCharacters.push(sc.subject);
      }
    }

    return {
      available: true,
      lastEventSummary,
      endingEmotion,
      openHooks: [], // 新格式无 openHooks 字段，由 activeDilemmas 替代
      introducedCharacters,
      unresolvedTensions,
      sourceIds: ["series/skeleton.json"],
    };
  }

  // --- 旧格式：顶层 events/openHooks/unresolvedTensions ---
  const events: any[] = Array.isArray(skeleton?.events) ? skeleton.events : [];
  const lastEvent = events[events.length - 1];
  if (lastEvent) {
    return {
      available: true,
      lastEventId: lastEvent.id ?? undefined,
      lastEventSummary: lastEvent.summary ?? lastEvent.name ?? undefined,
      endingEmotion: lastEvent.endingEmotion ?? lastEvent.emotion ?? undefined,
      openHooks: Array.isArray(skeleton?.openHooks) ? skeleton.openHooks : [],
      introducedCharacters: Array.isArray(skeleton?.introducedCharacters) ? skeleton.introducedCharacters : [],
      unresolvedTensions: Array.isArray(skeleton?.unresolvedTensions) ? skeleton.unresolvedTensions : [],
      sourceIds: ["series/skeleton.json"],
    };
  }

  const textFallback = loadPreviousChapterTextContinuation(workspacePath, chapterNumber);
  if (textFallback) return textFallback;

  return {
    available: false,
    openHooks: [],
    introducedCharacters: [],
    unresolvedTensions: [],
  };
}

/**
 * 构建当前压力
 */
function buildCurrentPressure(
  narrativeState: NarrativeState,
  closureData: { openArcs: any[]; pendingForeshadows: any[] }
): CurrentPressure {
  return {
    pendingForeshadowing: closureData.pendingForeshadows.map(f => ({
      id: String(f.id ?? ""),
      description: String(f.description ?? ""),
      level: typeof f.level === "string" ? f.level : undefined,
    })),
    openArcs: closureData.openArcs.map(arc => ({
      arcId: String(arc.arcId ?? ""),
      name: String(arc.name ?? ""),
      priority: typeof arc.priority === "string" ? arc.priority : undefined,
      coreQuestion: typeof arc.coreQuestion === "string" ? arc.coreQuestion : undefined,
    })),
    pendingCosts: narrativeState.protagonistCostLedger.pendingCosts
      .filter(c => !c.resolved)
      .map(c => ({
        action: c.action,
        cost: c.cost,
        chapterIncurred: c.chapterIncurred,
      })),
    readerExpectation: {
      unresolvedCount: narrativeState.readerExpectation.unresolvedCount,
      chaptersSinceLastPeak: narrativeState.readerExpectation.chaptersSinceLastPeak,
    },
  };
}

/**
 * 构建候选感知锚点
 */
function buildCandidateAnchors(
  previousContinuation: PreviousChapterContinuation,
  currentPressure: CurrentPressure,
  unsettledDetails: UnsettledDetailSummary[],
  characters: CharacterStateSummary[]
): CandidateAnchor[] {
  const anchors: CandidateAnchor[] = [];
  let idx = 1;

  // 1. 来自前章承接的锚点
  if (previousContinuation.available) {
    if (previousContinuation.endingEmotion) {
      anchors.push({
        id: `A${idx++}`,
        description: `前章离场情绪：${previousContinuation.endingEmotion}`,
        channel: "emotional",
        weight: 0.8,
        source: "previousSkeleton",
      });
    }
    for (const hook of previousContinuation.openHooks.slice(0, 3)) {
      anchors.push({
        id: `A${idx++}`,
        description: `前章未结钩子：${hook}`,
        channel: "cognitive",
        weight: 0.75,
        source: "previousSkeleton",
      });
    }
    for (const tension of previousContinuation.unresolvedTensions.slice(0, 2)) {
      anchors.push({
        id: `A${idx++}`,
        description: `前章未解张力：${tension}`,
        channel: "emotional",
        weight: 0.7,
        source: "previousSkeleton",
      });
    }
  }

  // 2. 来自待回收伏笔的锚点
  for (const f of currentPressure.pendingForeshadowing.slice(0, 3)) {
    anchors.push({
      id: `A${idx++}`,
      description: `待回收伏笔：${f.description}`,
      channel: "cognitive",
      weight: 0.7,
      source: "pendingForeshadowing",
    });
  }

  // 3. 来自未结账细节的锚点
  for (const d of unsettledDetails.slice(0, 3)) {
    anchors.push({
      id: `A${idx++}`,
      description: `未结账细节（${d.type}）：${d.description}`,
      channel: "visual",
      weight: 0.65,
      source: "unsettledDetail",
    });
  }

  // 4. 来自角色状态的锚点
  for (const c of characters.slice(0, 3)) {
    if (c.pendingTension) {
      anchors.push({
        id: `A${idx++}`,
        description: `${c.name} 的待解张力：${c.pendingTension}`,
        channel: "emotional",
        weight: 0.6,
        source: "characterState",
      });
    }
  }

  return anchors;
}

/**
 * 加载 series/ch{N}-outline-explicit.md 中每个事件块下的"感知锚点：a、b、c"行，
 * 逐事件构建一个 candidateAnchor（description 为去前缀后的整行内容）。
 *
 * 这些锚点是章纲作者为每个事件显式指定的具体感知细节，质量远高于
 * searchStep1~4 的硬编码 fallback，应作为 candidateAnchors 的首要来源。
 *
 * 注意：仅解析感知锚点行，不解析事件蓝图，不违反 P22 "章纲不作为事件蓝图" 约束。
 */
function loadExplicitOutlineSensoryAnchors(
  workspacePath: string,
  chapterNumber: number
): CandidateAnchor[] {
  const outlinePath = join(workspacePath, "series", `ch${chapterNumber}-outline-explicit.md`);
  if (!existsSync(outlinePath)) {
    return [];
  }

  let text: string;
  try {
    text = readFileSync(outlinePath, "utf-8");
  } catch {
    return [];
  }

  const anchors: CandidateAnchor[] = [];
  let idx = 1;

  // P26: 委托统一 parser（支持 ##/###/#### 事件 1/事件1/事件 E1/事件E1 四种变体）
  const parsed = parseExplicitOutline(text);
  const scanBlocks: Array<{ eventIndex: number; section: string }> = [];

  // 若无事件头，则在全文中扫描感知锚点行（兼容简化的章纲格式）
  if (parsed.events.length === 0) {
    scanBlocks.push({ eventIndex: 1, section: text });
  } else {
    for (const ev of parsed.events) {
      scanBlocks.push({ eventIndex: ev.index, section: ev.section });
    }
  }

  // 每个事件块内提取 "- **感知锚点**：xxx、yyy、zzz" 或 "感知锚点：xxx、yyy、zzz" 行
  const anchorLinePattern = /感知锚点\*{0,2}\s*[：:]\s*(.+)$/m;
  for (const block of scanBlocks) {
    const match = block.section.match(anchorLinePattern);
    if (!match) continue;
    const rawDescription = match[1].trim();
    if (!rawDescription) continue;

    anchors.push({
      id: `EA${idx++}`,
      description: rawDescription,
      channel: "visual",
      weight: 0.85,
      source: "explicitOutline",
    });
  }

  return anchors;
}

/**
 * [FIX D 2026-06-25] 加载 series/ch{N}-outline-explicit.md 中每个事件块下的
 * "参与角色：a、b、c" 行，逐事件构建 { eventIndex, characters } 列表。
 *
 * 章纲作者为每个事件显式声明的出场角色是权威来源。原 extractEventCharactersFromSeed
 * 走的是"按事件索引切片全章角色"（E1 取第 1 个，E2 取前 2 个...）的硬编码 fallback，
 * 与章纲意图完全错位（如 E1 早餐场景缺配角A、E2 训练馆却把配角A带上、E4 夜里祭炼
 * 还残留配角A和配角B），导致 Narrator 按章纲 contentPoints 写出配角A/配角B/配角C 时
 * 被 character_boundary_violation 硬阻断。
 *
 * 注意：仅解析角色名单，不解析事件蓝图，不违反 P22 "章纲不作为事件蓝图" 约束。
 */
function loadExplicitOutlineEventCharacters(
  workspacePath: string,
  chapterNumber: number
): Array<{ eventIndex: number; characters: string[] }> {
  const outlinePath = join(workspacePath, "series", `ch${chapterNumber}-outline-explicit.md`);
  if (!existsSync(outlinePath)) {
    return [];
  }

  let text: string;
  try {
    text = readFileSync(outlinePath, "utf-8");
  } catch {
    return [];
  }

  // P26: 委托统一 parser（支持 ##/###/#### 事件 1/事件1/事件 E1/事件E1 四种变体）
  const parsed = parseExplicitOutline(text);
  if (parsed.events.length === 0) {
    return [];
  }

  const result: Array<{ eventIndex: number; characters: string[] }> = [];
  for (const ev of parsed.events) {
    if (ev.characters.length > 0) {
      result.push({ eventIndex: ev.index, characters: ev.characters });
    }
  }

  return result;
}

/**
 * 推断章节意图（从种子源推断，不依赖章纲）
 */
function inferChapterIntent(
  chapterFunction: "setup" | "escalation" | "payoff" | "climax",
  currentPressure: CurrentPressure,
  previousContinuation: PreviousChapterContinuation,
  highLevelDirection: HighLevelDirection
): ChapterIntent {
  let primary = "character";
  const secondary: string[] = [];
  const keywords: string[] = [];
  const targetEmotions: string[] = [];

  // 根据章节功能类型推断主要意图
  switch (chapterFunction) {
    case "setup":
      primary = "setting";
      secondary.push("character", "foreshadow");
      targetEmotions.push("好奇", "温馨");
      break;
    case "escalation":
      primary = currentPressure.openArcs.length > 0 ? "reversal" : "character";
      secondary.push("combat", "foreshadow");
      targetEmotions.push("紧张", "压抑");
      break;
    case "payoff":
      primary = "reversal";
      secondary.push("character", "romance");
      targetEmotions.push("爽", "释然");
      break;
    case "climax":
      primary = "combat";
      secondary.push("reversal", "character");
      targetEmotions.push("燃", "爽");
      break;
  }

  // 从待回收伏笔补充关键词
  for (const f of currentPressure.pendingForeshadowing.slice(0, 3)) {
    if (f.description) {
      const kw = f.description.slice(0, 8);
      if (kw && !keywords.includes(kw)) {
        keywords.push(kw);
      }
    }
  }

  // 从前章承接补充关键词
  if (previousContinuation.lastEventSummary) {
    keywords.push(previousContinuation.lastEventSummary.slice(0, 8));
  }

  // 章节主题
  let chapterTheme = `第${chapterFunction === "setup" ? "开端" : chapterFunction === "escalation" ? "推进" : chapterFunction === "payoff" ? "回报" : "高潮"}阶段`;
  if (highLevelDirection.available && highLevelDirection.chapterThemeHint) {
    chapterTheme = highLevelDirection.chapterThemeHint;
  }

  return {
    primary,
    secondary,
    keywords: keywords.slice(0, 6),
    chapterTheme,
    targetEmotions,
    _source: "chapterSeed",
  };
}

/**
 * 构建世界约束摘要
 */
function buildWorldConstraintSummary(config: any, workspacePath: string): WorldConstraintSummary {
  const genre = typeof config.genre === "string" ? config.genre : "";
  const subGenres = Array.isArray(config.subGenres) ? config.subGenres.filter((s: unknown) => typeof s === "string") : [];

  let powerSystem: string | undefined;
  const powerSystemPath = join(workspacePath, "worldbuilding", "power-system.md");
  if (existsSync(powerSystemPath)) {
    try {
      powerSystem = readFileSync(powerSystemPath, "utf-8");
    } catch {
      // ignore
    }
  }

  const immutableFacts: string[] = [];
  if (Array.isArray(config.immutableFacts)) {
    for (const fact of config.immutableFacts) {
      if (typeof fact === "string") {
        immutableFacts.push(fact);
      }
    }
  }

  return {
    genre,
    subGenres,
    powerSystem,
    immutableFacts,
  };
}

/**
 * ChapterSeedBuilder 主入口
 */
export function buildChapterSeed(options: ChapterSeedBuilderOptions): ChapterSeedBuilderResult {
  const { workspacePath, workspaceId, chapterId, chapterNumber } = options;
  const warnings: string[] = [];

  // 1. 加载 config.json
  const config = loadWorkspaceConfig(workspacePath);

  // 2. 加载角色档案
  const profiles = loadCharacterProfiles(workspacePath);

  // 3. 加载前章 skeleton（第 1 章例外）
  const previousSkeleton = loadPreviousSkeleton(workspacePath, chapterNumber);

  // 4. 加载 narrative-state.json
  const narrativeState = loadNarrativeState(workspacePath, chapterNumber);

  // 5. 加载 unsettled-details.json
  const unsettledDetails = loadUnsettledDetails(workspacePath, chapterNumber);

  // 6. 加载 closure tracker（arc-registry.json）
  const closureData = loadClosureTrackerData(workspacePath);

  // 7. 加载可选的 series/outline.md 高层方向（仅背景参考）
  const highLevelDirection = loadHighLevelDirection(workspacePath, chapterNumber);
  if (highLevelDirection.available) {
    warnings.push("series/outline.md 已作为高层背景参考加载，但不作为生成前置条件或事件蓝图。");
  }

  // 构建各摘要
  const chapterFunction = determineChapterFunction(chapterNumber);
  const worldConstraint = buildWorldConstraintSummary(config, workspacePath);
  const characters = buildCharacterStateSummaries(config, profiles, narrativeState);
  const previousContinuation = buildPreviousChapterContinuation(chapterNumber, previousSkeleton, workspacePath);
  const currentPressure = buildCurrentPressure(narrativeState, closureData);
  // 显式章纲感知锚点优先于原生 fallback 锚点（previousSkeleton/pendingForeshadowing 等），
  // 因为它们是章纲作者为每个事件显式指定的具体感知细节，质量更高。
  const explicitAnchors = loadExplicitOutlineSensoryAnchors(workspacePath, chapterNumber);
  const nativeAnchors = buildCandidateAnchors(previousContinuation, currentPressure, unsettledDetails, characters);
  const candidateAnchors = [...explicitAnchors, ...nativeAnchors];
  if (explicitAnchors.length > 0) {
    warnings.push(`series/ch${chapterNumber}-outline-explicit.md 提供 ${explicitAnchors.length} 个显式感知锚点，已作为 candidateAnchors 首要来源。`);
  }
  // [FIX D 2026-06-25] 加载章纲每事件显式声明的参与角色，
  // 替代 extractEventCharactersFromSeed 的"按事件索引切片全章角色"fallback。
  const explicitEventCharacters = loadExplicitOutlineEventCharacters(workspacePath, chapterNumber);
  if (explicitEventCharacters.length > 0) {
    warnings.push(`series/ch${chapterNumber}-outline-explicit.md 提供 ${explicitEventCharacters.length} 个事件的显式参与角色，已作为 eventCharacters 权威来源。`);
  }
  const intent = inferChapterIntent(chapterFunction, currentPressure, previousContinuation, highLevelDirection);

  // 字数预算
  const wordCountTarget = config.targetWordCount?.perChapter
    ? {
        min: typeof config.targetWordCount.perChapter.min === "number" ? config.targetWordCount.perChapter.min : 2000,
        max: typeof config.targetWordCount.perChapter.max === "number" ? config.targetWordCount.perChapter.max : 3000,
      }
    : undefined;

  const seed: ChapterSeed = {
    workspaceId,
    chapterId,
    chapterNumber,
    chapterFunction,
    worldConstraint,
    characters,
    previousChapterContinuation: previousContinuation,
    currentPressure,
    unsettledDetails,
    candidateAnchors,
    explicitEventCharacters,
    highLevelDirection,
    intent,
    wordCountTarget,
    builtAt: new Date().toISOString(),
  };

  return { seed, warnings };
}
