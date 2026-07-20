/**
 * PiNovelStudio - Story Outline Planner
 *
 * Turns a user idea into a full series outline, then splits that outline into
 * explicit chapter-level event outlines that can pass the local readiness gate.
 * This module only produces planning artifacts. It never generates chapter body
 * prose; body generation remains owned by novel_generate_chapter.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { createRoutedChatAPI } from "../api/routed-chat.js";
import {
  createOutlineReadinessChecker,
  loadOutlineReadinessConfigFromJson,
  type OutlineReadinessReport,
} from "./outline-readiness-checker.js";

export type StoryOutlinePlanMode =
  | "idea_to_outline"
  | "outline_to_chapter_outlines"
  | "full_pipeline";

export type StoryOutlinePlanStatus = "success" | "blocked" | "error";

export interface StoryOutlinePlannerInput {
  workspaceId: string;
  mode?: StoryOutlinePlanMode;
  idea?: string;
  fullOutlineText?: string;
  startChapter?: number;
  endChapter?: number;
  totalChapters?: number;
  eventCount?: number;
  writeFiles?: boolean;
}

export interface StoryOutlineFileResult {
  path: string;
  content: string;
  written: boolean;
}

export interface ChapterOutlinePlanResult extends StoryOutlineFileResult {
  chapterNumber: number;
  sectionFound: boolean;
  readiness: OutlineReadinessReport;
}

export interface StoryOutlinePlannerResult {
  status: StoryOutlinePlanStatus;
  mode: StoryOutlinePlanMode;
  message: string;
  fullOutline: StoryOutlineFileResult | null;
  chapterOutlines: ChapterOutlinePlanResult[];
  llmUsed: boolean;
  errorCode?: string;
  suggestion?: string;
}

export interface StoryOutlinePlannerOptions {
  projectRoot: string;
}

interface WorkspaceContext {
  workspacePath: string;
  seriesPath: string;
  config: Record<string, unknown>;
}

interface ChapterSection {
  found: boolean;
  title: string;
  sectionText: string;
}

class StoryOutlinePlannerError extends Error {
  readonly code: string;
  readonly suggestion?: string;

  constructor(code: string, message: string, suggestion?: string) {
    super(message);
    this.code = code;
    this.suggestion = suggestion;
  }
}

export class StoryOutlinePlanner {
  private readonly projectRoot: string;

  constructor(options: StoryOutlinePlannerOptions) {
    this.projectRoot = options.projectRoot;
  }

  async plan(input: StoryOutlinePlannerInput): Promise<StoryOutlinePlannerResult> {
    const mode = input.mode || "idea_to_outline";

    try {
      this.assertSupportedMode(mode);

      // P22: 旧模式 outline_to_chapter_outlines / full_pipeline 已下线。
      // 显式章纲已废止，章节生成写前输入改为 ChapterSeed + 感知锚点。
      // 保留类型联合仅为向后兼容已序列化输入；运行时硬拒绝，引导用户使用新链路。
      if (mode === "outline_to_chapter_outlines" || mode === "full_pipeline") {
        return {
          status: "error",
          mode,
          message:
            "模式 " + mode + " 已在 P22 下线：显式章纲已废止，不再生成 ch*-outline-explicit.md。" +
            "章节生成写前输入改为 ChapterSeed + 感知锚点，唯一入口是 novel_generate_chapter。",
          fullOutline: null,
          chapterOutlines: [],
          llmUsed: false,
          errorCode: "MODE_DEPRECATED",
          suggestion:
            "如需生成高层背景参考文件，请使用 mode=idea_to_outline。" +
            "如需生成章节正文，请调用 novel_generate_chapter。",
        };
      }

      const workspace = this.loadWorkspace(input.workspaceId);
      const writeFiles = input.writeFiles !== false;
      const eventCount = this.toPositiveInteger(input.eventCount, 4);
      const totalChapters = this.resolveTotalChapters(input, workspace.config);

      let fullOutlineText = (input.fullOutlineText || "").trim();
      let fullOutline: StoryOutlineFileResult | null = null;
      const chapterOutlines: ChapterOutlinePlanResult[] = [];

      // P22: 仅 idea_to_outline 可达此处（旧模式已在上方被硬拒绝）。
      // outline.md 只作为高层背景参考文件，不再拆成 ch*-outline-explicit.md。
      const idea = (input.idea || "").trim();
      if (!idea) {
        throw new StoryOutlinePlannerError(
          "IDEA_REQUIRED",
          "idea_to_outline mode requires a user idea.",
          "Provide idea to generate series/outline.md as high-level background reference."
        );
      }

      fullOutlineText = this.normalizeMarkdown(
        await this.generateFullOutline({ idea, totalChapters, workspace })
      );

      fullOutline = this.persistFullOutline(workspace, fullOutlineText, writeFiles);

      return {
        status: "success",
        mode,
        message: "Full outline generated successfully.",
        fullOutline,
        chapterOutlines,
        llmUsed: true,
      };
    } catch (error) {
      if (error instanceof StoryOutlinePlannerError) {
        return {
          status: "error",
          mode,
          message: error.message,
          fullOutline: null,
          chapterOutlines: [],
          llmUsed: false,
          errorCode: error.code,
          suggestion: error.suggestion,
        };
      }

      const message = error instanceof Error ? error.message : String(error);
      return {
        status: "error",
        mode,
        message,
        fullOutline: null,
        chapterOutlines: [],
        llmUsed: false,
        errorCode: "STORY_OUTLINE_PLANNER_FAILED",
      };
    }
  }

  private assertSupportedMode(mode: string): asserts mode is StoryOutlinePlanMode {
    if (
      mode !== "idea_to_outline" &&
      mode !== "outline_to_chapter_outlines" &&
      mode !== "full_pipeline"
    ) {
      throw new StoryOutlinePlannerError(
        "INVALID_MODE",
        `Unsupported story outline planning mode: ${mode}`,
        "Use idea_to_outline, outline_to_chapter_outlines, or full_pipeline."
      );
    }
  }

  private loadWorkspace(workspaceId: string): WorkspaceContext {
    const workspacePath = join(this.projectRoot, "workspaces", workspaceId);
    const seriesPath = join(workspacePath, "series");
    const configPath = join(workspacePath, "config.json");

    if (!existsSync(configPath)) {
      throw new StoryOutlinePlannerError(
        "WORKSPACE_CONFIG_MISSING",
        `Workspace ${workspaceId} does not exist or config.json is missing.`,
        "Create the workspace and complete config.json before planning outlines."
      );
    }

    mkdirSync(seriesPath, { recursive: true });

    return {
      workspacePath,
      seriesPath,
      config: JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>,
    };
  }

  private resolveTotalChapters(
    input: StoryOutlinePlannerInput,
    config: Record<string, unknown>
  ): number {
    return this.toPositiveInteger(input.totalChapters, this.toPositiveInteger(config.totalChapters, 100));
  }

  private resolveChapterRange(
    input: StoryOutlinePlannerInput,
    mode: StoryOutlinePlanMode,
    totalChapters: number
  ): { start: number; end: number } {
    const start = this.toPositiveInteger(input.startChapter, 1);
    const fallbackEnd = mode === "full_pipeline" ? totalChapters : start;
    const end = this.toPositiveInteger(input.endChapter ?? input.totalChapters, fallbackEnd);

    if (end < start) {
      throw new StoryOutlinePlannerError(
        "INVALID_CHAPTER_RANGE",
        `Invalid chapter range: ${start}-${end}.`,
        "Set endChapter greater than or equal to startChapter."
      );
    }

    return { start, end };
  }

  private readExistingFullOutline(workspace: WorkspaceContext): string {
    const outlinePath = join(workspace.seriesPath, "outline.md");
    if (!existsSync(outlinePath)) {
      throw new StoryOutlinePlannerError(
        "FULL_OUTLINE_NOT_FOUND",
        "series/outline.md is missing.",
        "Run idea_to_outline first, provide fullOutlineText, or create series/outline.md."
      );
    }

    const outline = readFileSync(outlinePath, "utf-8").trim();
    if (!outline) {
      throw new StoryOutlinePlannerError(
        "FULL_OUTLINE_EMPTY",
        "series/outline.md is empty.",
        "Provide a complete outline before splitting chapter outlines."
      );
    }

    return outline;
  }

  private persistFullOutline(
    workspace: WorkspaceContext,
    fullOutlineText: string,
    writeFiles: boolean
  ): StoryOutlineFileResult {
    const outlinePath = join(workspace.seriesPath, "outline.md");

    if (writeFiles) {
      writeFileSync(outlinePath, fullOutlineText, "utf-8");
    }

    return {
      path: outlinePath,
      content: fullOutlineText,
      written: writeFiles,
    };
  }

  private async generateAndPersistChapterOutline(params: {
    workspace: WorkspaceContext;
    fullOutlineText: string;
    chapterNumber: number;
    eventCount: number;
    writeFiles: boolean;
  }): Promise<ChapterOutlinePlanResult> {
    const { workspace, fullOutlineText, chapterNumber, eventCount, writeFiles } = params;
    const section = this.extractChapterSection(fullOutlineText, chapterNumber);

    if (!section.found) {
      throw new StoryOutlinePlannerError(
        "CHAPTER_OUTLINE_SECTION_NOT_FOUND",
        `Full outline does not contain a section for chapter ${chapterNumber}.`,
        `请在 series/outline.md 中添加形如 "## 第${chapterNumber}章：标题" 的小节标题。`
      );
    }

    const outlineText = this.normalizeMarkdown(
      await this.generateChapterOutline({
        workspace,
        chapterNumber,
        eventCount,
        chapterSection: section.sectionText,
      })
    );

    const outputPath = join(workspace.seriesPath, `ch${chapterNumber}-outline-explicit.md`);
    if (writeFiles) {
      writeFileSync(outputPath, outlineText, "utf-8");
    }

    const readinessChecker = createOutlineReadinessChecker(
      loadOutlineReadinessConfigFromJson(workspace.config)
    );
    const readiness = readinessChecker.check({
      workspacePath: workspace.workspacePath,
      chapterNumber,
      outlineText,
      chapterOutlineFound: true,
      explicitOutlineExists: writeFiles,
    });

    return {
      chapterNumber,
      path: outputPath,
      content: outlineText,
      written: writeFiles,
      sectionFound: section.found,
      readiness,
    };
  }

  private async generateFullOutline(params: {
    idea: string;
    totalChapters: number;
    workspace: WorkspaceContext;
  }): Promise<string> {
    const { idea, totalChapters, workspace } = params;
    const api = await createRoutedChatAPI("outline_planner");
    const configSummary = this.formatWorkspaceConfig(workspace.config);

    const systemPrompt = [
      "你是 PiNovelStudio 的长篇网文总纲规划师。",
      "你的任务是把用户创意扩展为可拆章的总纲文档，只输出策划内容。",
      "严禁写章节正文、成段小说正文或可直接发布的章节内容。",
    ].join("\n");

    const userPrompt = [
      "# 任务",
      `把用户创意扩展为 ${totalChapters} 章的完整小说总纲。`,
      "",
      "# 用户创意",
      idea,
      "",
      "# Workspace 配置",
      configSummary,
      "",
      "# 输出要求",
      "- 使用 Markdown。",
      "- 必须包含全书核心卖点、主线、主要角色功能、卷/阶段推进。",
      "- 必须逐章列出章节概要，章节标题使用 \"## 第1章：标题\"。",
      "- 每章概要只写剧情目标、冲突、转折、伏笔和情绪功能；不要写正文。",
      "- 每章至少 2 句，且能被后续拆成事件级章纲。",
    ].join("\n");

    try {
      const response = await api.generate(systemPrompt, userPrompt, {
        temperature: 0.65,
        max_tokens: 8192,
      });
      return this.requireNonEmptyLLMResponse(response, "FULL_OUTLINE_EMPTY_RESPONSE");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new StoryOutlinePlannerError(
        "LLM_GENERATION_FAILED",
        `Full outline generation failed: ${message}`,
        "Check GLM API configuration and retry. No template fallback was used."
      );
    }
  }

  private async generateChapterOutline(params: {
    workspace: WorkspaceContext;
    chapterNumber: number;
    eventCount: number;
    chapterSection: string;
  }): Promise<string> {
    const { workspace, chapterNumber, eventCount, chapterSection } = params;
    const api = await createRoutedChatAPI("chapter_outline_generator");
    const configSummary = this.formatWorkspaceConfig(workspace.config);

    const systemPrompt = [
      "你是 PiNovelStudio 的章节概要拆分器。",
      "你的任务是把总纲中的单章段落拆成事件级显式章纲，只输出章纲。",
      "严禁写章节正文、场景正文、对白正文或可直接发布的章节内容。",
    ].join("\n");

    const userPrompt = [
      "# 任务",
      `为第 ${chapterNumber} 章生成 ${eventCount} 个事件块的显式章纲。`,
      "",
      "# 单章总纲段落",
      chapterSection,
      "",
      "# Workspace 配置",
      configSummary,
      "",
      "# 严格输出格式",
      `# 第${chapterNumber}章：标题`,
      "",
      "## 本章功能",
      "用 1-3 句说明本章在整本书中的功能。",
      "",
      "#### 事件1：事件标题",
      "- **类型**：开场/冲突/转折/揭秘/收束",
      "- **内容**：不少于30字的具体事件摘要，只写摘要，不写正文。",
      "- **冲突等级**：1-5 的数字",
      "- **情绪弧**：起点 -> 终点",
      "- **感知锚点**：可见/可听/可触的具体场景锚点",
      "- **参与角色**：角色名列表",
      "- **伏笔埋设**：本事件新增或推进的伏笔",
      "- **字数目标**：数字",
      "",
      `连续输出 ${eventCount} 个事件块，编号从 1 到 ${eventCount}。`,
    ].join("\n");

    try {
      const response = await api.generate(systemPrompt, userPrompt, {
        temperature: 0.55,
        max_tokens: 4096,
      });
      return this.requireNonEmptyLLMResponse(response, "CHAPTER_OUTLINE_EMPTY_RESPONSE");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new StoryOutlinePlannerError(
        "LLM_GENERATION_FAILED",
        `Chapter outline generation failed: ${message}`,
        "Check GLM API configuration and retry. No template fallback was used."
      );
    }
  }

  private requireNonEmptyLLMResponse(response: string, code: string): string {
    const content = response.trim();
    if (!content) {
      throw new StoryOutlinePlannerError(
        code,
        "LLM returned empty planning content.",
        "Retry generation or adjust the idea/outline input."
      );
    }
    return content;
  }

  private normalizeMarkdown(content: string): string {
    const trimmed = content.trim();
    const fenceMatch = trimmed.match(/^```(?:markdown|md)?\s*([\s\S]*?)\s*```$/i);
    return (fenceMatch ? fenceMatch[1] : trimmed).trim();
  }

  private extractChapterSection(fullOutlineText: string, chapterNumber: number): ChapterSection {
    const lines = fullOutlineText.split(/\r?\n/);
    const headingIndex = lines.findIndex((line) =>
      this.isChapterHeading(line, chapterNumber)
    );

    if (headingIndex === -1) {
      return {
        found: false,
        title: "",
        sectionText: "",
      };
    }

    let endIndex = lines.length;
    for (let index = headingIndex + 1; index < lines.length; index++) {
      if (this.isAnyChapterHeading(lines[index])) {
        endIndex = index;
        break;
      }
    }

    const sectionLines = lines.slice(headingIndex, endIndex);
    return {
      found: true,
      title: sectionLines[0]?.trim() || `Chapter ${chapterNumber}`,
      sectionText: sectionLines.join("\n").trim(),
    };
  }

  private isChapterHeading(line: string, chapterNumber: number): boolean {
    const normalized = line.trim();
    const patterns = [
      new RegExp(`^#{1,3}\\s*第\\s*${chapterNumber}\\s*章(?:\\s*[：:].*)?$`, "i"),
      new RegExp(`^#{1,3}\\s*Chapter\\s+${chapterNumber}\\b.*$`, "i"),
    ];
    return patterns.some((pattern) => pattern.test(normalized));
  }

  private isAnyChapterHeading(line: string): boolean {
    const normalized = line.trim();
    return (
      /^#{1,3}\s*第\s*\d+\s*章(?:\s*[：:].*)?$/i.test(normalized) ||
      /^#{1,3}\s*Chapter\s+\d+\b.*$/i.test(normalized)
    );
  }

  private formatWorkspaceConfig(config: Record<string, unknown>): string {
    const genre = String(config.genre || "未配置");
    const subGenres = Array.isArray(config.subGenres)
      ? config.subGenres.map((item) => String(item)).join(", ")
      : "未配置";
    const totalChapters = String(config.totalChapters || "未配置");
    const characters = this.formatCharacters(config.characters);

    return [
      `- 类型：${genre}`,
      `- 子类型：${subGenres || "未配置"}`,
      `- 目标章节数：${totalChapters}`,
      `- 角色：${characters}`,
    ].join("\n");
  }

  private formatCharacters(value: unknown): string {
    if (!Array.isArray(value) || value.length === 0) {
      return "未配置";
    }

    return value
      .map((character) => {
        if (!this.isRecord(character)) {
          return String(character);
        }
        const name = String(character.name || character.id || "未命名角色");
        const role = character.role ? `(${String(character.role)})` : "";
        return `${name}${role}`;
      })
      .join(", ");
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }

  private toPositiveInteger(value: unknown, fallback: number): number {
    const numberValue = Number(value);
    if (!Number.isInteger(numberValue) || numberValue <= 0) {
      return fallback;
    }
    return numberValue;
  }
}

export function createStoryOutlinePlanner(options: StoryOutlinePlannerOptions): StoryOutlinePlanner {
  return new StoryOutlinePlanner(options);
}
