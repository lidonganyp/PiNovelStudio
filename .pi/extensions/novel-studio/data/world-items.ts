/**
 * PiNovelStudio — 世界观条目数据访问层
 *
 * 负责 WorldItem 的创建、读取、更新、持久化
 * 规则 #165-#170: 8层字段结构 + 渐进揭示建模
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import type {
  WorldItem,
  WorldItemType,
  EmbeddingTechnique,
  RevealDepth,
  RevealVersion,
  ReleaseStatus,
  ReleaseStyle,
  ReleaseMap,
  ReleaseMapEntry,
  DependencyBreakResult,
} from "../dag/types.js";

// ============================================================================
// 常量定义
// ============================================================================

/** 连续说明段落阈值（规则 #124, #136） */
export const MAX_CONSECUTIVE_EXPOSITION = 150; // 单一说明性段落上限（字）
export const MAX_CONTINUOUS_EXPOSITION = 300;  // 连续说明段落上限（字）

/** 类型化密度容忍度（规则 #125） */
export const GENRE_TOLERANCE: Record<string, { maxRatio: number; description: string }> = {
  POWER_SYSTEM: { maxRatio: 0.25, description: "设定流（修仙/玄幻）" },
  HISTORY: { maxRatio: 0.20, description: "剧情流（悬疑/历史）" },
  CULTURE: { maxRatio: 0.15, description: "情感流（都市/言情）" },
  default: { maxRatio: 0.15, description: "默认" },
};

/** 基础信息容量（规则 #160） */
export const BASE_INFO_CAPACITY = 3; // 条/章

/** 章节类型容量乘数 */
export const CHAPTER_TYPE_MULTIPLIER: Record<string, number> = {
  climax: 0.3,    // 高潮/决战章
  payoff: 0.5,
  escalation: 1.0,
  setup: 1.5,    // 过渡/旅途章
  transition: 1.5,
  exploration: 2.0, // 世界探索章
};

/** 嵌入技法优先级（规则 #130-#135） */
export const TECHNIQUE_PRIORITY: EmbeddingTechnique[] = [
  'conflict_exposure',
  'asymmetric_dialogue',
  'object_scene_hint',
  'character_question',
  'misconception_correction',
  'functional_narration',
];

// ============================================================================
// WorldItem 工厂函数
// ============================================================================

/**
 * 创建新的世界观条目
 */
export function createWorldItem(params: {
  id: string;
  name: string;
  type: WorldItemType;
  summary: string;
  fullDescription: string;
  tags?: string[];
  createdBy?: string;
}): WorldItem {
  const now = new Date().toISOString();
  return {
    id: params.id,
    name: params.name,
    type: params.type,
    tags: params.tags || [],
    summary: params.summary,
    fullDescription: params.fullDescription,
    revealVersions: [
      {
        depth: 'surface',
        content: params.summary,
        chapter: null,
        spoilerProtection: false,
        explainability: 'active',
      },
    ],
    dependencies: {
      hard: [],
      soft: [],
    },
    plotBindings: [],
    releaseStrategy: {
      explainability: 'active',
      preferredTechnique: null,
      forbiddenChapters: [],
      forcedChapter: null,
      styleOverride: null,
      deferability: 0.5,
      manualOverrides: [],
    },
    status: 'unassigned',
    earliestChapter: null,
    optimalChapter: null,
    latestChapter: null,
    actualChapter: null,
    createdBy: params.createdBy || 'system',
    createdAt: now,
    lastModified: now,
    priorityScore: 0,
  };
}

/**
 * 创建揭示版本
 */
export function createRevealVersion(params: {
  depth: RevealDepth;
  content: string;
  chapter?: number | null;
  spoilerProtection?: boolean;
  explainability?: 'active' | 'passive' | 'never';
}): RevealVersion {
  return {
    depth: params.depth,
    content: params.content,
    chapter: params.chapter ?? null,
    spoilerProtection: params.spoilerProtection ?? false,
    explainability: params.explainability ?? 'active',
  };
}

// ============================================================================
// WorldItems 数据管理器
// ============================================================================

export class WorldItemsManager {
  private items: Map<string, WorldItem> = new Map();
  private workspacePath: string;
  private filePath: string;

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
    this.filePath = join(workspacePath, "series", "world-items.json");
  }

  /**
   * P11: 规范化 world item，确保最小结构完整
   * 补齐缺失字段：dependencies (hard: [], soft: [])
   * @returns 规范化后的条目，以及是否发生了实际变化
   */
  private normalizeItem(item: WorldItem): { item: WorldItem; changed: boolean } {
    // 只有当 dependencies 字段缺失时才需要规范化
    if (item.dependencies) {
      return { item, changed: false };
    }
    // 补齐缺失字段
    return {
      item: {
        ...item,
        dependencies: { hard: [], soft: [] },
      },
      changed: true,
    };
  }

  /**
   * 加载已有的世界物件
   */
  load(): void {
    if (existsSync(this.filePath)) {
      try {
        const raw = readFileSync(this.filePath, "utf-8");
        const data = JSON.parse(raw);
        if (data.items && Array.isArray(data.items)) {
          let hasChanges = false;
          for (const item of data.items) {
            // P11: 规范化条目，补齐缺失字段
            const { item: normalized, changed } = this.normalizeItem(item as WorldItem);
            if (changed) {
              hasChanges = true;
            }
            this.items.set(normalized.id, normalized);
          }
          // 如果有变化，自动保存
          if (hasChanges) {
            this.save();
          }
        }
      } catch (e) {
        console.warn("加载 world-items.json 失败:", e);
      }
    }
  }

  /**
   * 保存到文件系统
   */
  save(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(
      this.filePath,
      JSON.stringify(
        {
          items: Array.from(this.items.values()),
          lastUpdated: new Date().toISOString(),
        },
        null,
        2
      ),
      "utf-8"
    );
  }

  /**
   * 添加世界观条目
   */
  add(item: WorldItem): void {
    this.items.set(item.id, item);
  }

  /**
   * 获取条目
   */
  get(id: string): WorldItem | undefined {
    return this.items.get(id);
  }

  /**
   * 获取所有条目
   */
  getAll(): WorldItem[] {
    return Array.from(this.items.values());
  }

  /**
   * 更新条目
   */
  update(id: string, updates: Partial<WorldItem>): void {
    const item = this.items.get(id);
    if (item) {
      const updated = { ...item, ...updates, lastModified: new Date().toISOString() };
      this.items.set(id, updated);
    }
  }

  /**
   * 删除条目
   */
  delete(id: string): void {
    this.items.delete(id);
  }

  /**
   * 获取特定章节的计划条目
   */
  getItemsForChapter(chapter: number): WorldItem[] {
    return this.getAll().filter(
      (item) =>
        item.status === 'planned' &&
        item.optimalChapter === chapter
    );
  }

  /**
   * 获取已到期的条目
   */
  getOverdueItems(currentChapter: number): WorldItem[] {
    return this.getAll().filter(
      (item) =>
        item.status === 'planned' &&
        item.latestChapter !== null &&
        item.latestChapter < currentChapter
    );
  }

  /**
   * 计算依赖链（规则 #166-#168）
   */
  buildDependencyGraph(): {
    roots: string[];
    conceptGroups: string[][];
    itemDepth: Map<string, number>;
  } {
    const roots: string[] = [];
    const visited = new Set<string>();
    const depthMap = new Map<string, number>();
    const conceptGroups: string[][] = [];

    // 检测循环依赖
    const cycleGroups = this.detectCycles();

    // 标记循环依赖组内的条目
    const inCycle = new Set<string>();
    for (const group of cycleGroups) {
      for (const id of group) {
        inCycle.add(id);
      }
      conceptGroups.push(group);
    }

    // 递归计算深度
    const calculateDepth = (itemId: string, currentDepth: number): number => {
      if (depthMap.has(itemId)) {
        return depthMap.get(itemId)!;
      }
      if (visited.has(itemId) && !inCycle.has(itemId)) {
        return 0; // 防止循环
      }
      visited.add(itemId);

      const item = this.items.get(itemId);
      if (!item || item.dependencies?.hard?.length === 0) {
        depthMap.set(itemId, currentDepth);
        return currentDepth;
      }

      let maxDepDepth = currentDepth;
      for (const depId of (item.dependencies?.hard || [])) {
        if (this.items.has(depId)) {
          maxDepDepth = Math.max(maxDepDepth, calculateDepth(depId, currentDepth - 1));
        }
      }
      depthMap.set(itemId, maxDepDepth);
      return maxDepDepth;
    };

    // 找到根节点并计算深度
    for (const [id, item] of this.items) {
      if (item.dependencies?.hard?.length === 0) {
        roots.push(id);
      }
      calculateDepth(id, 0);
    }

    return { roots, conceptGroups, itemDepth: depthMap };
  }

  /**
   * 检测循环依赖并合并为 concept_group
   */
  private detectCycles(): string[][] {
    const cycles: string[][] = [];
    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    const dfs = (itemId: string, path: string[]): void => {
      if (recursionStack.has(itemId)) {
        // 发现循环
        const cycleStart = path.indexOf(itemId);
        if (cycleStart !== -1) {
          const cycle = path.slice(cycleStart);
          // 检查是否已存在相同的循环
          const cycleSet = new Set(cycle);
          const isDuplicate = cycles.some(
            (c) => c.length === cycle.length && c.every((id) => cycleSet.has(id))
          );
          if (!isDuplicate) {
            cycles.push(cycle);
          }
        }
        return;
      }

      if (visited.has(itemId)) return;

      visited.add(itemId);
      recursionStack.add(itemId);
      path.push(itemId);

      const item = this.items.get(itemId);
      if (item) {
        for (const depId of (item.dependencies?.hard || [])) {
          if (this.items.has(depId)) {
            dfs(depId, [...path]);
          }
        }
      }

      recursionStack.delete(itemId);
    };

    for (const [id] of this.items) {
      if (!visited.has(id)) {
        dfs(id, []);
      }
    }

    return cycles;
  }

  /**
   * 验证依赖断裂（规则 #175-#176）
   */
  validateDependencies(movedItemId: string, newChapter: number): DependencyBreakResult {
    const result: DependencyBreakResult = {
      forward: { broken: false, brokenDeps: [], suggestedActions: [] },
      backward: { broken: false, brokenDeps: [] },
      resolution: 'auto',
      options: [],
    };

    const movedItem = this.items.get(movedItemId);
    if (!movedItem) {
      result.resolution = 'manual_required';
      return result;
    }

    // 前向检查：被移动条目的依赖是否满足
    for (const depId of (movedItem.dependencies?.hard || [])) {
      const depItem = this.items.get(depId);
      if (depItem && depItem.actualChapter !== null) {
        if (depItem.actualChapter >= newChapter) {
          result.forward.broken = true;
          result.forward.brokenDeps.push({
            itemId: movedItemId,
            missingDep: depId,
            requiredChapter: depItem.actualChapter + 1,
          });
        }
      }
    }

    // 后向检查：被移动条目依赖的其他条目是否满足
    for (const [id, item] of this.items) {
      if (item.dependencies?.hard?.includes(movedItemId) && id !== movedItemId) {
        // 某条目依赖被移动的条目
        // 检查该条目是否需要调整
      }
    }

    // 生成建议操作
    if (result.forward.broken) {
      result.options.push({
        action: 'cascade_move',
        description: '连带移动依赖链上的所有条目',
        itemIds: result.forward.brokenDeps.map((d) => d.missingDep),
      });
      result.options.push({
        action: 'downgrade_soft',
        description: '将硬依赖降级为软依赖',
        itemIds: [movedItemId],
      });
      result.options.push({
        action: 'cancel',
        description: '取消此次移动',
        itemIds: [movedItemId],
      });
    }

    return result;
  }
}

// ============================================================================
// ReleaseMap 管理器
// ============================================================================

export class ReleaseMapManager {
  private releaseMap: ReleaseMap | null = null;
  private workspacePath: string;
  private filePath: string;

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
    this.filePath = join(workspacePath, "series", "release-map.json");
  }

  /**
   * 加载释放地图
   */
  load(): void {
    if (existsSync(this.filePath)) {
      try {
        const raw = readFileSync(this.filePath, "utf-8");
        this.releaseMap = JSON.parse(raw) as ReleaseMap;
      } catch (e) {
        console.warn("加载 release-map.json 失败:", e);
      }
    }
  }

  /**
   * 保存释放地图
   */
  save(): void {
    if (!this.releaseMap) return;
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.filePath, JSON.stringify(this.releaseMap, null, 2), "utf-8");
  }

  /**
   * 初始化释放地图
   */
  initialize(params: {
    workspaceId: string;
    novelTitle: string;
    totalChapters: number;
  }): void {
    this.releaseMap = {
      workspaceId: params.workspaceId,
      novelTitle: params.novelTitle,
      totalChapters: params.totalChapters,
      entries: [],
      conceptGroups: [],
      overview: {
        totalItems: 0,
        assignedItems: 0,
        overdueItems: 0,
        suppressedItems: 0,
        unassignedItems: 0,
      },
      chapterAssignments: {},
      lastUpdated: new Date().toISOString(),
      status: 'draft',
    };
  }

  /**
   * 获取当前释放地图
   */
  get(): ReleaseMap | null {
    return this.releaseMap;
  }

  /**
   * 添加/更新释放条目
   */
  addEntry(entry: ReleaseMapEntry): void {
    if (!this.releaseMap) return;

    // 检查是否已存在
    const existingIndex = this.releaseMap.entries.findIndex((e) => e.worldItemId === entry.worldItemId);
    if (existingIndex >= 0) {
      this.releaseMap.entries[existingIndex] = entry;
    } else {
      this.releaseMap.entries.push(entry);
    }

    // 更新章节分配
    if (!this.releaseMap.chapterAssignments[entry.targetChapter]) {
      this.releaseMap.chapterAssignments[entry.targetChapter] = [];
    }
    if (!this.releaseMap.chapterAssignments[entry.targetChapter].includes(entry.worldItemId)) {
      this.releaseMap.chapterAssignments[entry.targetChapter].push(entry.worldItemId);
    }

    this.updateOverview();
  }

  /**
   * 移动条目到指定章节
   */
  moveEntry(worldItemId: string, targetChapter: number): void {
    if (!this.releaseMap) return;

    const entry = this.releaseMap.entries.find((e) => e.worldItemId === worldItemId);
    if (entry) {
      // 从原章节移除
      const oldChapter = entry.targetChapter;
      if (this.releaseMap.chapterAssignments[oldChapter]) {
        this.releaseMap.chapterAssignments[oldChapter] = this.releaseMap.chapterAssignments[
          oldChapter
        ].filter((id) => id !== worldItemId);
      }

      // 添加到新章节
      entry.targetChapter = targetChapter;
      if (!this.releaseMap.chapterAssignments[targetChapter]) {
        this.releaseMap.chapterAssignments[targetChapter] = [];
      }
      this.releaseMap.chapterAssignments[targetChapter].push(worldItemId);

      this.updateOverview();
    }
  }

  /**
   * 压制条目
   */
  suppressEntry(worldItemId: string): void {
    if (!this.releaseMap) return;

    const entry = this.releaseMap.entries.find((e) => e.worldItemId === worldItemId);
    if (entry) {
      entry.status = 'suppressed';
      this.updateOverview();
    }
  }

  /**
   * 强制指定章节
   */
  forceChapter(worldItemId: string, chapter: number): void {
    if (!this.releaseMap) return;

    const entry = this.releaseMap.entries.find((e) => e.worldItemId === worldItemId);
    if (entry) {
      entry.targetChapter = chapter;
      entry.status = 'planned';
      this.updateOverview();
    }
  }

  /**
   * 更新概览统计
   */
  private updateOverview(): void {
    if (!this.releaseMap) return;

    this.releaseMap.entries.sort((a, b) => a.targetChapter - b.targetChapter);

    const entries = this.releaseMap.entries;
    this.releaseMap.overview = {
      totalItems: entries.length,
      assignedItems: entries.filter((e) => e.status !== 'unassigned').length,
      overdueItems: entries.filter((e) => e.status === 'overdue').length,
      suppressedItems: entries.filter((e) => e.status === 'suppressed').length,
      unassignedItems: entries.filter((e) => e.status === 'unassigned').length,
    };
    this.releaseMap.lastUpdated = new Date().toISOString();
  }

  /**
   * 标记为已批准
   */
  approve(): void {
    if (this.releaseMap) {
      this.releaseMap.status = 'approved';
      this.save();
    }
  }
}

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 计算条目优先级分数（规则 #158）
 */
export function calculatePriorityScore(params: {
  conflictBindingStrength: number;
  dependencySatisfaction: number;
  readerDemand: number;
  deferability: number;
}): number {
  // Priority Score = 情节绑定强度×0.4 + 前置依赖满足度×0.3 + 读者当前信息需求度×0.2 + (1/可延迟性)×0.1
  const { conflictBindingStrength, dependencySatisfaction, readerDemand, deferability } = params;

  return (
    conflictBindingStrength * 0.4 +
    dependencySatisfaction * 0.3 +
    readerDemand * 0.2 +
    (1 - deferability) * 0.1
  );
}

/**
 * 获取章节容量（规则 #160）
 */
export function getChapterCapacity(
  chapterType: string,
  hasNewcomer: boolean = false
): { min: number; max: number } {
  const multiplier = CHAPTER_TYPE_MULTIPLIER[chapterType] || 1.0;
  const base = BASE_INFO_CAPACITY * multiplier;
  const capacity = hasNewcomer ? base + 1 : base;

  return {
    min: Math.max(1, Math.floor(capacity * 0.5)),
    max: Math.ceil(capacity * 1.5),
  };
}

/**
 * 判断是否为说明句（规则 #155-#156）
 */
export function isExplanatorySentence(text: string): boolean {
  // 三条件判定：
  // 1. 主要功能是传递世界观/背景信息（而非推动情节/展示情绪/描写感官）
  // 2. 信息主体是「世界」而非「角色当下的体验」
  // 3. 去掉这句话，当前场景的情绪/节奏不受影响

  const worldKeywords = ['世界', '体系', '规则', '历史', '势力', '传统', '法则'];
  const worldPattern = new RegExp(worldKeywords.join('|'));

  const experienceKeywords = ['他感到', '他看到', '她觉得', '他听到', '心中', '仿佛'];
  const experiencePattern = new RegExp(experienceKeywords.join('|'));

  const hasWorldInfo = worldPattern.test(text);
  const hasExperience = experiencePattern.test(text);

  return hasWorldInfo && !hasExperience;
}

/**
 * 生成说明句边界判别器提示
 */
export function generateBoundaryHint(text: string): {
  hasAnchor: boolean;
  sentence: string;
  reason: string;
} {
  // 有"当下锚点" = 非说明句
  const anchorPatterns = [
    /他(?:看着|盯着|望着|看着|目光落在)/,
    /她?(?:走进|踏入|穿过|来到)/,
    /他?(?:手中|身上|胸口|额头)/,
    /只见/,
  ];

  const hasAnchor = anchorPatterns.some((p) => p.test(text));

  if (hasAnchor) {
    return {
      hasAnchor: true,
      sentence: '非说明句 - 通过角色感知传递，绑定当下场景',
      reason: '段落包含角色视角锚点',
    };
  }

  return {
    hasAnchor: false,
    sentence: '说明句 - 可能是需要优化的内容',
    reason: '段落缺乏角色感知锚点',
  };
}

/**
 * 导出数据到文件
 */
export function exportToFile(manager: WorldItemsManager, workspacePath: string): void {
  manager.save();
}

/**
 * 从文件导入数据
 */
export function importFromFile(workspacePath: string): WorldItemsManager {
  const manager = new WorldItemsManager(workspacePath);
  manager.load();
  return manager;
}
