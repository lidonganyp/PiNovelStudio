/**
 * PiNovelStudio — Workspace 管理器
 *
 * 负责创建、切换、管理多小说 workspace
 */

import { join, resolve } from "path";
import {
  ensureDir,
  pathExists,
  readJsonFile,
  writeJsonFile,
  writeJsonAtomic,
  copyDir,
  listDir,
  deleteDir,
  validateWorkspaceId,
  resolveWorkspacePath,
} from "../utils/fs.js";
import {
  getProjectRoot,
  loadGlobalConfig,
  loadWorkspaceConfig,
  saveWorkspaceConfig,
  type WorkspaceConfig,
} from "../utils/config.js";
import type { NarrativeState, StateChangeResult } from "../dag/types.js";
import { createDefaultNarrativeState, applyStateChanges, normalizeNarrativeState } from "../craft/narrative-state-store.js";
import { existsSync, readdirSync, readFileSync } from "fs";
// P30: 章节身份与路径 canonical resolver
import { parseChapterNumber } from "../utils/chapter-path.js";

export interface WorkspaceInfo {
  workspaceId: string;
  novelName: string;
  genre: string;
  chapterProgress: {
    completed: number;
    current: number;
  };
  exists: boolean;
  path: string;
}

export interface InitOptions {
  workspaceId: string;
  novelName: string;
  genre: string;
  subGenres?: string[];
  styleProfile?: string;
  targetWordCount?: {
    perChapter: { min: number; max: number };
    total: number;
  };
}

export interface ChapterInfo {
  chapterNumber: number;
  title: string;
  status: "draft" | "approved" | "in_progress" | "completed";
  wordCount?: number;
  createdAt?: string;
  completedAt?: string;
}

/**
 * Workspace 管理器
 */
export class WorkspaceManager {
  private workspacesPath: string;
  private templatePath: string;
  private currentWorkspace: string | null = null;
  private configCache: Map<string, WorkspaceConfig> = new Map();

  constructor(workspacesPath?: string) {
    this.workspacesPath = workspacesPath || join(getProjectRoot(), "workspaces");
    this.templatePath = join(this.workspacesPath, "_template");
  }

  /** 安全解析 workspace 子路径（含 format 校验 + path traversal 二次防线） */
  private wsPath(workspaceId: string, ...segments: string[]): string {
    return join(resolveWorkspacePath(this.workspacesPath, workspaceId), ...segments);
  }

  /**
   * 初始化 Workspace 管理器（加载全局配置）
   */
  static async create(): Promise<WorkspaceManager> {
    const config = await loadGlobalConfig();
    return new WorkspaceManager(config.workspacesPath);
  }

  /**
   * 创建新小说 workspace
   */
  async init(options: InitOptions): Promise<WorkspaceConfig> {
    const { workspaceId, novelName, genre, subGenres = [], styleProfile = "default", targetWordCount } = options;

    const workspacePath = resolveWorkspacePath(this.workspacesPath, workspaceId);

    if (existsSync(workspacePath)) {
      throw new Error(`Workspace "${workspaceId}" already exists`);
    }

    await ensureDir(workspacePath);

    const templateFiles = [
      "config.json",
      "series",
      "worldbuilding",
      "characters",
      "chapters",
    ];

    for (const item of templateFiles) {
      const src = join(this.templatePath, item);
      const dest = join(workspacePath, item);
      if (existsSync(src)) {
        if ((await import("fs")).existsSync(src)) {
          await copyDir(src, dest);
        }
      }
    }

    // 模板可能不包含 characters 目录；先确保目录结构完整，再扫描角色文件，
    // 否则 readdirSync 在无模板 characters 目录时稳定抛 ENOENT。
    await this.ensureDirectories(workspaceId);

    const config: WorkspaceConfig & { characters: string[] } = {
      workspaceId,
      novelName,
      genre,
      subGenres,
      // Preflight requires an explicit character inventory. Populate it from
      // copied character profiles so a freshly initialized workspace is
      // immediately generatable instead of failing its first preflight.
      characters: readdirSync(join(workspacePath, "characters"), { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map((entry) => entry.name.replace(/\.md$/i, "")),
      styleProfile,
      styleOverrides: {},
      brainholePreferences: {
        enabledPatterns: ["identity-reversal", "iceberg", "mirror-enemy", "mask-layer"],
        aggressiveness: 0.7,
        autoApplyThreshold: 0.6,
        maxInjectionsPerChapter: 2,
      },
      qualityGates: {
        antiAiThreshold: 0.15,
        emotionMetronome: "strict",
        dependencyCheck: "strict",
        minSatisfactionDensity: 0.0002,
        maxOppressionLength: 3000,
      },
      targetWordCount: targetWordCount || {
        perChapter: { min: 3000, max: 5000 },
        total: 2000000,
      },
      chapterProgress: {
        completed: 0,
        current: 1,
      },
    };

    await saveWorkspaceConfig(workspaceId, config);
    this.configCache.set(workspaceId, config);

    return config;
  }

  /**
   * 确保工作目录结构完整
   */
  private async ensureDirectories(workspaceId: string): Promise<void> {
    const basePath = this.wsPath(workspaceId);
    const dirs = [
      "series",
      "worldbuilding",
      "characters",
      "chapters",
      "styles",
    ];

    for (const dir of dirs) {
      await ensureDir(join(basePath, dir));
    }
    const stylePath = join(basePath, "styles", "profile.json");
    if (!(await pathExists(stylePath))) {
      await writeJsonAtomic(stylePath, {
        id: "default",
        name: "默认作者风格",
        editorialGuidance: ["保持中文表达自然，动作和因果清晰，保留作者自己的叙事声音。"],
        usagePolicy: "qualitative_only",
      });
    }
  }

  /**
   * 获取当前 workspace
   */
  async getCurrent(): Promise<WorkspaceConfig | null> {
    if (!this.currentWorkspace) {
      return null;
    }
    return this.getWorkspace(this.currentWorkspace);
  }

  /**
   * 获取 workspace 配置
   */
  async getWorkspace(workspaceId: string): Promise<WorkspaceConfig | null> {
    if (this.configCache.has(workspaceId)) {
      return this.configCache.get(workspaceId)!;
    }

    const workspacePath = this.wsPath(workspaceId, "config.json");
    if (!existsSync(workspacePath)) {
      return null;
    }

    const config = await loadWorkspaceConfig(workspaceId);
    this.configCache.set(workspaceId, config);
    return config;
  }

  /**
   * 切换当前 workspace
   */
  async switch(workspaceId: string): Promise<WorkspaceConfig> {
    const config = await this.getWorkspace(workspaceId);
    if (!config) {
      throw new Error(`Workspace "${workspaceId}" not found`);
    }

    this.currentWorkspace = workspaceId;
    return config;
  }

  /**
   * 列出所有 workspace
   */
  async listWorkspaces(): Promise<WorkspaceInfo[]> {
    const workspaces: WorkspaceInfo[] = [];

    if (!existsSync(this.workspacesPath)) {
      return workspaces;
    }

    const entries = readdirSync(this.workspacesPath, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== "_template") {
        const workspaceId = entry.name;
        const configPath = this.wsPath(workspaceId, "config.json");

        if (existsSync(configPath)) {
          try {
            const config = await loadWorkspaceConfig(workspaceId);
            workspaces.push({
              workspaceId,
              novelName: config.novelName,
              genre: config.genre,
              chapterProgress: config.chapterProgress,
              exists: true,
              path: this.wsPath(workspaceId),
            });
          } catch {
            workspaces.push({
              workspaceId,
              novelName: "Unknown",
              genre: "Unknown",
              chapterProgress: { completed: 0, current: 1 },
              exists: false,
              path: this.wsPath(workspaceId),
            });
          }
        }
      }
    }

    return workspaces;
  }

  /**
   * 删除 workspace
   */
  async delete(workspaceId: string): Promise<void> {
    if (workspaceId === "_template") {
      throw new Error("Cannot delete template workspace");
    }

    const workspacePath = this.wsPath(workspaceId);
    if (!existsSync(workspacePath)) {
      throw new Error(`Workspace "${workspaceId}" not found`);
    }

    if (this.currentWorkspace === workspaceId) {
      this.currentWorkspace = null;
    }

    this.configCache.delete(workspaceId);
    await deleteDir(workspacePath);
  }

  /**
   * 更新 workspace 配置
   */
  async updateConfig(
    workspaceId: string,
    updates: Partial<WorkspaceConfig>
  ): Promise<WorkspaceConfig> {
    const config = await this.getWorkspace(workspaceId);
    if (!config) {
      throw new Error(`Workspace "${workspaceId}" not found`);
    }

    const updated = { ...config, ...updates };
    await saveWorkspaceConfig(workspaceId, updated);
    this.configCache.set(workspaceId, updated);

    return updated;
  }

  /**
   * 更新章节进度
   */
  async updateChapterProgress(
    workspaceId: string,
    completed: number,
    current: number
  ): Promise<void> {
    await this.updateConfig(workspaceId, {
      chapterProgress: { completed, current },
    } as Partial<WorkspaceConfig>);
  }

  /**
   * 获取章节列表
   */
  async getChapterList(workspaceId: string): Promise<ChapterInfo[]> {
    const chaptersPath = this.wsPath(workspaceId, "chapters");

    if (!existsSync(chaptersPath)) {
      return [];
    }

    const chapters: ChapterInfo[] = [];
    const entries = readdirSync(chaptersPath, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith("chapter-")) {
        // P30: 用 parseChapterNumber 归一化（chapter-02/chapter-2 → 2），替代 replace+parseInt
        const chapterNumber = parseChapterNumber(entry.name);
        const chapterDir = join(chaptersPath, entry.name);
        const blueprintPath = join(chapterDir, "blueprint.json");
        const finalPath = join(chapterDir, "final.md");

        let status: ChapterInfo["status"] = "draft";
        let title = `第${chapterNumber}章`;

        if (existsSync(blueprintPath)) {
          try {
            const blueprint = JSON.parse(readFileSync(blueprintPath, "utf-8"));
            title = blueprint.title || title;
            status = blueprint.metadata?.status || "draft";
          } catch {
            status = "draft";
          }
        }

        if (existsSync(finalPath)) {
          status = "completed";
        }

        chapters.push({
          chapterNumber,
          title,
          status,
        });
      }
    }

    return chapters.sort((a, b) => a.chapterNumber - b.chapterNumber);
  }

  /**
   * 获取下一章编号
   */
  async getNextChapterNumber(workspaceId: string): Promise<number> {
    const chapters = await this.getChapterList(workspaceId);
    if (chapters.length === 0) {
      return 1;
    }
    return Math.max(...chapters.map((c) => c.chapterNumber)) + 1;
  }

  /**
   * 获取角色列表
   */
  async getCharacterList(workspaceId: string): Promise<string[]> {
    const charactersPath = this.wsPath(workspaceId, "characters");

    if (!existsSync(charactersPath)) {
      return [];
    }

    const entries = readdirSync(charactersPath, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => e.name.replace(".md", ""));
  }

  /**
   * 加载角色档案
   */
  async loadCharacter(workspaceId: string, characterId: string): Promise<string | null> {
    const charPath = this.wsPath(workspaceId, "characters", `${characterId}.md`);
    if (!existsSync(charPath)) {
      return null;
    }
    return readFileSync(charPath, "utf-8");
  }

  /**
   * 获取大纲内容
   */
  async getOutline(workspaceId: string): Promise<string | null> {
    const outlinePath = this.wsPath(workspaceId, "series", "outline.md");
    if (!existsSync(outlinePath)) {
      return null;
    }
    return readFileSync(outlinePath, "utf-8");
  }

  /**
   * 获取伏笔追踪器
   */
  async getForeshadowingTracker(workspaceId: string): Promise<{
    planted: Array<{ id: string; hook: string; plantedAt: string }>;
    pending: string[];
    resolved: string[];
  } | null> {
    const trackerPath = this.wsPath(workspaceId, "series", "foreshadowing-tracker.json");
    if (!existsSync(trackerPath)) {
      return null;
    }
    try {
      return JSON.parse(readFileSync(trackerPath, "utf-8"));
    } catch {
      return null;
    }
  }

  /**
   * 保存伏笔追踪器
   */
  async saveForeshadowingTracker(
    workspaceId: string,
    tracker: {
      planted: Array<{ id: string; hook: string; plantedAt: string }>;
      pending: string[];
      resolved: string[];
    }
  ): Promise<void> {
    const trackerPath = this.wsPath(workspaceId, "series", "foreshadowing-tracker.json");
    await writeJsonAtomic(trackerPath, tracker);
  }

  /**
   * 获取世界规则
   */
  async getWorldRules(workspaceId: string): Promise<string | null> {
    const rulesPath = this.wsPath(workspaceId, "worldbuilding", "world-rules.md");
    if (!existsSync(rulesPath)) {
      return null;
    }
    return readFileSync(rulesPath, "utf-8");
  }

  /**
   * 获取战斗力体系
   */
  async getPowerSystem(workspaceId: string): Promise<string | null> {
    const powerPath = this.wsPath(workspaceId, "worldbuilding", "power-system.md");
    if (!existsSync(powerPath)) {
      return null;
    }
    return readFileSync(powerPath, "utf-8");
  }

  async getNarrativeState(workspaceId: string): Promise<NarrativeState> {
    const statePath = this.wsPath(workspaceId, "series", "narrative-state.json");
    if (!existsSync(statePath)) {
      return createDefaultNarrativeState(1);
    }
    try {
      const parsed = JSON.parse(readFileSync(statePath, "utf-8"));
      const savedChapter =
        parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        typeof (parsed as { currentChapter?: unknown }).currentChapter === "number"
          ? (parsed as { currentChapter: number }).currentChapter
          : 1;
      return normalizeNarrativeState(parsed, savedChapter);
    } catch {
      return createDefaultNarrativeState(1);
    }
  }

  async saveNarrativeState(workspaceId: string, state: NarrativeState): Promise<void> {
    const statePath = this.wsPath(workspaceId, "series", "narrative-state.json");
    await writeJsonAtomic(statePath, state);
  }

  async updateNarrativeState(
    workspaceId: string,
    changes: StateChangeResult[],
    chapterNumber: number
  ): Promise<NarrativeState> {
    const currentState = await this.getNarrativeState(workspaceId);
    const updatedState = applyStateChanges(currentState, changes, chapterNumber);
    await this.saveNarrativeState(workspaceId, updatedState);
    return updatedState;
  }
}

/**
 * 创建 Workspace 管理器实例
 */
export async function createWorkspaceManager(): Promise<WorkspaceManager> {
  return WorkspaceManager.create();
}
