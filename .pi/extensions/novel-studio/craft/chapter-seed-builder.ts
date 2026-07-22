/**
 * PiNovelStudio — ChapterSeedBuilder
 *
 * 统一主链路：作者权威叙事契约优先
 *
 * 从多个种子源构造本章 ChapterSeed：
 *  - config.json（世界观、类型、角色列表、字数预算）
 *  - 角色档案（characters/*.md）
 *  - 前章 skeleton.json（第 1 章例外）
 *  - narrative-state.json
 *  - detail ledger / unsettled-details.json
 *  - foreshadowing / closure tracker（arc-registry.json）
 *  - series/outline.md 整体剧情方向
 *  - 可选 ch{N}-outline-explicit.md 作者章节契约
 *
 * 感知锚点只保留为历史诊断数据，不作为事实、阻断条件或正文写法指令。
 */

import { join } from "path";
import { existsSync, readFileSync, readdirSync } from "fs";
import { parseExplicitOutline, parseMandatoryElementTag } from "./explicit-outline-parser.js";
// P1-F：章节连续性快照（commitAndSave 写入，前章承接加载）
import { loadChapterContinuitySnapshot } from "./chapter-continuity-snapshot.js";
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
  AuthorChapterContract,
  CharacterNarrativeProfile,
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
interface LoadedCharacterProfile {
  id: string;
  name: string;
  content: string;
  sourceId?: string;
  role?: string;
  aliases?: string[];
}

function loadCharacterProfiles(workspacePath: string): LoadedCharacterProfile[] {
  const charsDir = join(workspacePath, "characters");
  if (!existsSync(charsDir)) {
    return [];
  }

  const roster: LoadedCharacterProfile[] = [];
  for (const entry of readdirSync(charsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }
    const id = entry.name.replace(/\.md$/i, "");
    try {
      const content = readFileSync(join(charsDir, entry.name), "utf-8");
      const name = extractFirstCharacterName(content) || id;
      const ensembleSections = [...content.matchAll(/^##\s+([\u4e00-\u9fa5·]{2,12})\s*[（(]([^）)]+)[）)]\s*$/gmu)]
        .filter((match) => /(?:protagonist|supporting|deceased|antagonist|mentor|family|love-interest|supporting-future|monster)/iu.test(match[2]));
      if (ensembleSections.length >= 2) {
        for (let index = 0; index < ensembleSections.length; index += 1) {
          const match = ensembleSections[index];
          const start = (match.index ?? 0) + match[0].length;
          const end = ensembleSections[index + 1]?.index ?? content.length;
          roster.push({
            id,
            name: match[1].trim(),
            role: match[2].trim(),
            content: `# ${match[1].trim()}\n${content.slice(start, end).trim()}`,
            sourceId: `characters/${entry.name}`,
          });
        }
      } else {
        roster.push({ id, name, content, sourceId: `characters/${entry.name}` });
      }
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

const MECHANICAL_PROFILE_FIELD = /(?:频率|比例|占比|字数|句数|段落|句式|视角|镜头|写作约束|叙述人称|全书.{0,10}(?:切|唯一)|每.{0,4}(?:句|段|章)|内心独白.{0,4}(?:高|低|次)|对白.{0,4}(?:多|少|%))/u;

function cleanProfileEntry(line: string): { label: string; value: string } | null {
  const trimmed = line.trim();
  const tableCells = trimmed.startsWith("|")
    ? trimmed.split("|").slice(1, -1).map((cell) => cell.trim())
    : [];
  if (tableCells.length > 0 && (tableCells.every((cell) => /^[-:]+$/u.test(cell))
    || /^(?:层次|字段|项目)$/u.test(tableCells[0])
    || /^(?:内容|说明|描述)$/u.test(tableCells[1] ?? ""))) {
    return null;
  }
  const source = tableCells.length >= 2
    ? `${tableCells[0]}：${tableCells.slice(1).join("；")}`
    : line;
  const cleaned = source
    .replace(/^\s*[-*+]\s*/u, "")
    .replace(/^\s*\d+[.)、]\s*/u, "")
    .trim();
  if (!cleaned || MECHANICAL_PROFILE_FIELD.test(cleaned)) return null;
  const match = cleaned.match(/^(?:\*\*)?([^：:*]{1,24})(?:\*\*)?\s*[：:]\s*(.+)$/u);
  if (!match) return { label: "", value: cleaned.replace(/\*\*/gu, "").trim() };
  return {
    label: match[1].replace(/\*\*/gu, "").trim(),
    value: match[2].replace(/\*\*/gu, "").trim(),
  };
}

function extractCharacterNarrativeProfile(
  profile: LoadedCharacterProfile,
): CharacterNarrativeProfile | undefined {
  const result: CharacterNarrativeProfile = {
    personality: [],
    desires: [],
    fears: [],
    decisionLogic: [],
    voice: [],
    relationships: [],
    knowledgeBoundaries: [],
    capabilityCosts: [],
    unfinishedChoices: [],
    establishedHistory: [],
    boundaries: [],
    sourceId: profile.sourceId ?? `characters/${profile.id}.md`,
  };
  let section = "";
  const push = (field: keyof Omit<CharacterNarrativeProfile, "sourceId">, value: string): void => {
    const normalized = value.trim();
    if (normalized && !result[field].includes(normalized)) result[field].push(normalized);
  };

  for (const rawLine of profile.content.split(/\r?\n/u)) {
    const heading = rawLine.match(/^#{2,4}\s+(.+)$/u);
    if (heading) {
      section = heading[1].replace(/\*\*/gu, "").trim();
      continue;
    }
    const entry = cleanProfileEntry(rawLine);
    if (!entry) continue;
    const labeledValue = entry.label ? `${entry.label}：${entry.value}` : entry.value;

    if (/(?:决策逻辑|行为逻辑|深层逻辑|decision)/iu.test(entry.label)) {
      push("decisionLogic", entry.value);
    } else if (/(?:性格|人设|行为模式|personality|底色)/iu.test(section) || /(?:底色|性格|人设)/u.test(entry.label)) {
      push("personality", entry.value);
    } else if (/(?:欲望|诉求|长期目标|desire)/iu.test(section)) {
      push("desires", labeledValue);
    } else if (/(?:恐惧|害怕|fear)/iu.test(section)) {
      push("fears", labeledValue);
    } else if (/(?:决策逻辑|行为逻辑|行动逻辑|decision)/iu.test(section)) {
      push("decisionLogic", entry.value);
    } else if (/(?:语言风格|语言特征|说话方式|表达特征|声音指纹|voice)/iu.test(section)) {
      push("voice", entry.value);
    } else if (/(?:关键关系|人物关系|关系网络|与.{1,12}的?关系|关系演进|relationship)/iu.test(section)
      || /(?:关键关系|人物关系)/u.test(entry.label)) {
      push("relationships", labeledValue);
    } else if (/(?:知识边界|认知边界|知道与不知道|knowledge)/iu.test(section)) {
      push("knowledgeBoundaries", labeledValue);
    } else if (/(?:能力限制|能力代价|能力与限制|限制与代价|capabilit|cost)/iu.test(section)) {
      push("capabilityCosts", labeledValue);
    } else if (/(?:未完成选择|未决选择|待决两难|unfinished)/iu.test(section)) {
      push("unfinishedChoices", labeledValue);
    } else if (/(?:已发生事件|既往经历|已知经历|关键经历|history)/iu.test(section)) {
      push("establishedHistory", labeledValue);
    } else if (/(?:行为边界|人物底线|不可违背|主世界禁令|boundary)/iu.test(section)) {
      push("boundaries", labeledValue);
    }
  }

  const hasContent = Object.entries(result).some(([key, value]) => key !== "sourceId" && Array.isArray(value) && value.length > 0);
  return hasContent ? result : undefined;
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
 * 加载 arc-registry-derived.json（closure tracker）
 *
 * P0-1: 优先读 arc-registry-derived.json（派生缓存，由 NarrativeStateBridge +
 * ClosureTracker 接入模块写入），fallback 到 arc-registry.json（旧名/手写权威文件）。
 * 权威状态是 narrative-state-store.json；arc-registry-derived.json 是 advisory cache。
 */
function loadClosureTrackerData(workspacePath: string) {
  const seriesDir = join(workspacePath, "series");
  const derivedPath = join(seriesDir, "arc-registry-derived.json");
  const legacyPath = join(seriesDir, "arc-registry.json");
  const registryPath = existsSync(derivedPath) ? derivedPath : legacyPath;
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

function extractMarkdownField(text: string, labels: string[]): string | undefined {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const pattern = new RegExp(`^\\s*[-*]?\\s*(?:\\*\\*)?${escaped}(?:\\*\\*)?\\s*[：:]\\s*(.+)$`, "mu");
    const match = text.match(pattern);
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return undefined;
}

/** Load work-level direction and the current chapter's explicit direction without prose recipes. */
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
    const backgroundNotes: string[] = [];
    const immutableFacts: string[] = [];

    // P22修复：过滤系统元数据关键词，防止 outline.md 文档头等系统信息污染 backgroundNotes。
    // 这些关键词若进入 backgroundNotes，可能被 Architect 误用为事件 location 或被
    // Narrator 事件覆盖自检提取为关键词，导致语义覆盖率过低而阻断生成。
    const SYSTEM_METADATA_KEYWORDS = ["PiNovelStudio", "Workspace", "本文档为系统", "系统使用的卷级骨架"];
    const isSystemMetadata = (text: string): boolean =>
      SYSTEM_METADATA_KEYWORDS.some(kw => text.includes(kw));

    // Keep complete plot-bearing sections. ContextSafety performs source-aware
    // budgeting later; this loader must not silently cut every section to 200
    // characters or discard the current chapter's direction.
    const lines = text.split(/\r?\n/);
    let currentSection: string | null = null;
    let buffer: string[] = [];

    const flushBuffer = () => {
      if (currentSection && buffer.length > 0) {
        const joined = buffer.join(" ").trim();
        const plotBearing = /总纲|核心|主线|故事弧|剧情|阶段|全书|主题|人物|世界观/u.test(currentSection)
          || new RegExp(`第\\s*${chapterNumber}\\s*章`, "u").test(currentSection);
        if (plotBearing && joined && !isSystemMetadata(joined) && !isSystemMetadata(currentSection)) {
          backgroundNotes.push(`[${currentSection}] ${joined}`);
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

    const explicitPath = join(workspacePath, "series", `ch${chapterNumber}-outline-explicit.md`);
    const currentChapterPattern = new RegExp(`(?:第\\s*0*${chapterNumber}\\s*章|ch(?:apter)?\\s*0*${chapterNumber}\\b)`, "iu");
    const globalPattern = /^\[(?:(?:[一二三四五六七八九十]+|\d+)[、.．-])?(?:作品|全书|故事)?(?:总纲|核心(?:设计理念|思想命题|设定|冲突|主题)?|主线|主题|作品定位|故事梗概|全书阶段规划)/u;
    const currentNotes = backgroundNotes.filter((note) => currentChapterPattern.test(note));
    const globalNotes = backgroundNotes.filter((note) => globalPattern.test(note));
    const candidates = existsSync(explicitPath)
      ? [...currentNotes, ...globalNotes]
      : (currentNotes.length > 0 || globalNotes.length > 0 ? [...currentNotes, ...globalNotes] : backgroundNotes);
    const selectedBackgroundNotes: string[] = [];
    let remainingBudget = 3600;
    for (const note of Array.from(new Set(candidates))) {
      if (remainingBudget <= 0) break;
      const clipped = note.slice(0, Math.min(1200, remainingBudget)).trim();
      if (!clipped) continue;
      selectedBackgroundNotes.push(clipped);
      remainingBudget -= clipped.length;
    }

    // Extract explicit factual prohibitions. Prose/style instructions are not
    // facts and are filtered by expression terminology.
    const constraintPattern = /(?:必须|不可|不能|禁止|务必)[^\n。，；！？]{4,80}/g;
    let match: RegExpExecArray | null;
    const selectedOutlineText = selectedBackgroundNotes.join("\n");
    while ((match = constraintPattern.exec(selectedOutlineText)) !== null) {
      if (/句式|段落|对白|感官|修辞|字数|节奏|开头|描写|语言|短句|长句/u.test(match[0])) continue;
      immutableFacts.push(match[0]);
    }

    let chapterThemeHint: string | undefined;
    if (existsSync(explicitPath)) {
      try {
        const explicitText = readFileSync(explicitPath, "utf-8");
        chapterThemeHint = extractMarkdownField(explicitText, ["本章功能", "章节功能"]);
      } catch {
        chapterThemeHint = undefined;
      }
    }

    return {
      available: true,
      backgroundNotes: selectedBackgroundNotes,
      chapterThemeHint,
      immutableFacts: Array.from(new Set(immutableFacts)),
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
  profiles: LoadedCharacterProfile[],
  narrativeState: NarrativeState
): CharacterStateSummary[] {
  const summaries: CharacterStateSummary[] = [];
  const seen = new Set<string>();
  const profilesByName = new Map(profiles.map((profile) => [profile.name, profile]));
  const profilesById = new Map(profiles.map((profile) => [profile.id, profile]));

  // 1. 从 config.characters 提取
  if (Array.isArray(config.characters)) {
    for (const raw of config.characters) {
      if (!raw || typeof raw !== "object") continue;
      const name = typeof raw.name === "string" ? raw.name : (typeof raw.id === "string" ? raw.id : "");
      if (!name || seen.has(name)) continue;
      seen.add(name);

      const relationship = narrativeState.relationshipTemperature[name];
      const profile = profilesByName.get(name) ?? profilesById.get(typeof raw.id === "string" ? raw.id : "");
      summaries.push({
        name,
        role: typeof raw.role === "string" ? raw.role : undefined,
        mentality: relationship?.pendingTension ? `pendingTension: ${relationship.pendingTension}` : undefined,
        pendingTension: relationship?.pendingTension ?? undefined,
        aliases: Array.isArray(raw.aliases) ? raw.aliases : undefined,
        narrativeProfile: profile ? extractCharacterNarrativeProfile(profile) : undefined,
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
      narrativeProfile: extractCharacterNarrativeProfile(profile),
    });
  }

  return summaries;
}

function loadPreviousChapterTextContinuation(
  workspacePath: string,
  chapterNumber: number
): PreviousChapterContinuation | null {
  const previousNumber = chapterNumber - 1;

  // P1-F：优先加载连续性快照——上一章 commitAndSave 时写入，含带 finalText span
  // 证据的 openHooks / introducedCharacters / unresolvedTensions。快照缺失或损坏时
  // 回退到仅正文尾部（保持旧行为），不阻断主链路。
  const snapshot = loadChapterContinuitySnapshot(workspacePath, previousNumber);

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

      // P1-F：若快照存在，用快照的 lastEventSummary 覆盖（与正文尾部同源但带 hash 标记），
      // 并把快照的结构化 hooks/characters/tensions 合入返回。快照的 openHooks 已经过
      // finalText span 证据过滤，可安全进入下一章模型上下文。
      // 若快照不存在，openHooks / introducedCharacters 维持空数组（旧行为），并用
      // endsAtCompletedBoundary 推断 unresolvedTensions。
      const sourceIds = [`chapters/${fileName}`];
      if (snapshot) {
        sourceIds.push(`chapter-continuity/${previousNumber}.json`);
      }
      return {
        available: true,
        lastEventId: `chapter-text-tail:${previousNumber}`,
        lastEventSummary: snapshot?.lastEventSummary ?? excerpt,
        openHooks: snapshot?.openHooks ?? [],
        introducedCharacters: snapshot?.introducedCharacters ?? [],
        unresolvedTensions: snapshot
          ? snapshot.unresolvedTensions
          : (endsAtCompletedBoundary
            ? []
            : ["前章正文在进行中的事件处结束，必须先明确其结果再推进新时间/场景"]),
        sourceIds,
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

  // 已接受正文是连续性的权威来源；skeleton 只是正文缺失时的派生回退。
  const acceptedText = loadPreviousChapterTextContinuation(workspacePath, chapterNumber);
  if (acceptedText) return acceptedText;

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

    const hasUsableSkeletonContent = facts.some((fact) => String(fact).trim())
      || activeDilemmas.some((dilemma) => String(dilemma).trim())
      || stateChanges.some((change) => change && typeof change === "object");
    if (!hasUsableSkeletonContent) {
      const textFallback = loadPreviousChapterTextContinuation(workspacePath, chapterNumber);
      if (textFallback) return textFallback;
    }

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
      openHooks: Array.isArray(prevChapterSkeleton.openHooks)
        ? prevChapterSkeleton.openHooks.map((hook: unknown) => String(hook))
        : activeDilemmas.map((dilemma) => String(dilemma)),
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

function uniqueStrings(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))));
}

function normalizeMandatoryElement(value: string): string {
  const parsed = parseMandatoryElementTag(value.trim());
  if (!parsed.content) return "";
  if (parsed.tag !== "verbatim") return parsed.content;
  const quote = parsed.content.replace(/^[「『“"]|[」』”"]$/gu, "").trim();
  return quote ? `原句：「${quote}」` : "";
}

function extractAllMarkdownFieldValues(text: string, labels: string[]): string[] {
  const labelSet = new Set(labels);
  const values: string[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const match = line.match(/^\s*[-*]?\s*(?:\*\*)?([^*：:]{1,24})(?:\*\*)?\s*[：:]\s*(.+)$/u);
    if (!match || !labelSet.has(match[1].trim())) continue;
    const value = match[2].trim();
    if (value) values.push(value);
  }
  return uniqueStrings(values);
}

function splitNarrativeContractItems(values: string[]): string[] {
  return uniqueStrings(values.flatMap((value) => value.split(/[；;]+/u).map((item) => item.trim())));
}

function parseFocusCharacterGoals(values: string[]): Array<{ character: string; goal: string }> {
  const goals: Array<{ character: string; goal: string }> = [];
  for (const item of splitNarrativeContractItems(values)) {
    const match = item.match(/^([^：:]{1,20})[：:]\s*(.+)$/u);
    if (!match) continue;
    goals.push({ character: match[1].trim(), goal: match[2].trim() });
  }
  return goals.filter((entry, index, all) =>
    all.findIndex((candidate) => candidate.character === entry.character && candidate.goal === entry.goal) === index);
}

function parseChoicesAndCosts(values: string[]): Array<{ choice: string; cost: string }> {
  const result: Array<{ choice: string; cost: string }> = [];
  for (const value of values) {
    const match = value.match(/^(?:选择\s*[：:=]\s*)?(.+?)(?:[｜|]|，|,)\s*(?:代价|成本)\s*[：:=]\s*(.+)$/u);
    if (!match) continue;
    result.push({ choice: match[1].trim(), cost: match[2].trim() });
  }
  return result.filter((entry, index, all) =>
    all.findIndex((candidate) => candidate.choice === entry.choice && candidate.cost === entry.cost) === index);
}

function loadAuthorChapterContract(workspacePath: string, chapterNumber: number): AuthorChapterContract {
  const sourceId = `series/ch${chapterNumber}-outline-explicit.md`;
  const outlinePath = join(workspacePath, sourceId);
  if (!existsSync(outlinePath)) {
    return {
      available: false,
      readerExperience: [],
      currentPressure: [],
      focusCharacterGoals: [],
      resistance: [],
      choicesAndCosts: [],
      expectedIrreversibleChange: [],
      causalEndPressure: [],
      eventSummaries: [],
      mustInclude: [],
      stateChanges: [],
      foreshadowing: [],
      causalRelations: [],
      relevantCharacters: [],
      characterMotivations: [],
      sourceIds: [],
    };
  }

  try {
    const text = readFileSync(outlinePath, "utf-8");
    const parsed = parseExplicitOutline(text);
    if (parsed.parseError) {
      return {
        available: false,
        readerExperience: [],
        currentPressure: [],
        focusCharacterGoals: [],
        resistance: [],
        choicesAndCosts: [],
        expectedIrreversibleChange: [],
        causalEndPressure: [],
        eventSummaries: [],
        mustInclude: [],
        stateChanges: [],
        foreshadowing: [],
        causalRelations: [],
        relevantCharacters: [],
        characterMotivations: [],
        sourceIds: [sourceId],
      };
    }

    const relevantCharacters = uniqueStrings(parsed.events.flatMap((event) => event.characters));
    const motivationEntries: AuthorChapterContract["characterMotivations"] = [];
    for (const event of parsed.events) {
      for (const motivation of event.characterMotivations ?? []) {
        const character = event.characters.find((name) => motivation.startsWith(name))
          ?? (event.characters.length === 1 ? event.characters[0] : undefined);
        if (!character) continue;
        motivationEntries.push({ character, motivation });
      }
    }

    const reversedEvents = [...parsed.events].reverse();
    const readerExperience = splitNarrativeContractItems(extractAllMarkdownFieldValues(text, ["目标读者体验", "读者体验"]));
    const currentPressure = splitNarrativeContractItems(extractAllMarkdownFieldValues(text, ["当前压力", "开场压力"]));
    const focusCharacterGoals = parseFocusCharacterGoals(extractAllMarkdownFieldValues(text, ["焦点角色目标", "角色目标"]));
    const resistance = splitNarrativeContractItems(extractAllMarkdownFieldValues(text, ["本章阻力", "阻力"]));
    const choicesAndCosts = parseChoicesAndCosts(extractAllMarkdownFieldValues(text, ["选择与代价", "选择代价"]));
    const expectedIrreversibleChange = splitNarrativeContractItems(extractAllMarkdownFieldValues(text, ["不可逆变化", "预期不可逆变化"]));
    const causalEndPressure = splitNarrativeContractItems(extractAllMarkdownFieldValues(text, ["因果章末压力", "章末因果压力"]));
    const endingTarget = extractMarkdownField(text, ["章末目标", "章末落点"])
      ?? reversedEvents.find((event) => event.endingTarget)?.endingTarget
      ?? reversedEvents.find((event) => event.stateDeltas?.length)?.stateDeltas?.at(-1)
      ?? reversedEvents.find((event) => event.summary)?.summary;
    return {
      available: parsed.events.length > 0,
      chapterFunction: extractMarkdownField(text, ["本章功能", "章节功能"]),
      readerExperience,
      currentPressure,
      focusCharacterGoals,
      resistance,
      choicesAndCosts,
      expectedIrreversibleChange,
      causalEndPressure,
      eventSummaries: uniqueStrings(parsed.events.map((event) => event.summary)),
      mustInclude: uniqueStrings(parsed.events.flatMap((event) => event.mandatoryElements).map(normalizeMandatoryElement)),
      stateChanges: uniqueStrings(parsed.events.flatMap((event) => [
        ...(event.stateDeltas ?? []),
        ...(event.relationshipDeltas ?? []),
      ])),
      foreshadowing: uniqueStrings(parsed.events.map((event) => event.foreshadowing)),
      causalRelations: uniqueStrings(parsed.events.flatMap((event) => event.causalRelations ?? [])),
      endingTarget,
      relevantCharacters,
      characterMotivations: motivationEntries.filter((entry, index, all) =>
        all.findIndex((candidate) => candidate.character === entry.character && candidate.motivation === entry.motivation) === index),
      sourceIds: [sourceId],
    };
  } catch {
    return {
      available: false,
      readerExperience: [],
      currentPressure: [],
      focusCharacterGoals: [],
      resistance: [],
      choicesAndCosts: [],
      expectedIrreversibleChange: [],
      causalEndPressure: [],
      eventSummaries: [],
      mustInclude: [],
      stateChanges: [],
      foreshadowing: [],
      causalRelations: [],
      relevantCharacters: [],
      characterMotivations: [],
      sourceIds: [sourceId],
    };
  }
}

/** Load active author-maintained hooks without interpreting hook type as prose instructions. */
function loadHookLedgerForeshadows(workspacePath: string): Array<{
  id: string;
  description: string;
  level?: string;
}> {
  const ledgerPath = join(workspacePath, "chapter-hooks-ledger.md");
  if (!existsSync(ledgerPath)) return [];
  let text = "";
  try {
    text = readFileSync(ledgerPath, "utf-8");
  } catch {
    return [];
  }

  const entries: Array<{ id: string; description: string; level?: string }> = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 2 || cells.every((cell) => /^[-:]+$/u.test(cell))) continue;
    const statusCell = cells.find((cell) => /\b(?:opened|in_progress|climaxed)\b/iu.test(cell));
    if (!statusCell || /\bresolved\b/iu.test(statusCell)) continue;
    const id = cells[0].replace(/\*\*/gu, "").trim();
    const description = cells[1].replace(/\*\*/gu, "").trim();
    if (!id || !description || /^(?:编号|序号|章节)$/u.test(id)) continue;
    const key = `${id}:${description}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ id, description, level: "author-ledger" });
  }
  return entries;
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
  const ledgerForeshadows = loadHookLedgerForeshadows(workspacePath);
  currentPressure.pendingForeshadowing = [
    ...currentPressure.pendingForeshadowing,
    ...ledgerForeshadows,
  ].filter((entry, index, all) => all.findIndex((candidate) => candidate.id === entry.id) === index);
  // Compatibility-only diagnostic anchors may still be derived from prior state.
  // Author/config prose recipes are deliberately excluded from the production seed.
  const nativeAnchors = buildCandidateAnchors(previousContinuation, currentPressure, unsettledDetails, characters);
  const candidateAnchors = nativeAnchors;
  // [FIX D 2026-06-25] 加载章纲每事件显式声明的参与角色，
  // 替代 extractEventCharactersFromSeed 的"按事件索引切片全章角色"fallback。
  const explicitEventCharacters = loadExplicitOutlineEventCharacters(workspacePath, chapterNumber);
  if (explicitEventCharacters.length > 0) {
    warnings.push(`series/ch${chapterNumber}-outline-explicit.md 提供 ${explicitEventCharacters.length} 个事件的显式参与角色，已作为 eventCharacters 权威来源。`);
  }
  const authorChapterContract = loadAuthorChapterContract(workspacePath, chapterNumber);
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
    authorChapterContract,
    intent,
    wordCountTarget,
    builtAt: new Date().toISOString(),
  };

  return { seed, warnings };
}
