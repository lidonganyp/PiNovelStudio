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

// ============================================================================
// 生产 Prompt：固定五要素结构（【角色】【指令】【约束】【示例】【输出格式】）
// ============================================================================

/** 项目规定的五要素顺序；system 与 user 消息都必须按此顺序组织。 */
export const OUTLINE_PROMPT_SECTIONS = ["角色", "指令", "约束", "示例", "输出格式"] as const;

export interface OutlinePromptPair {
  systemPrompt: string;
  userPrompt: string;
}

export interface FullOutlinePromptParams {
  idea: string;
  totalChapters: number;
  configSummary: string;
}

export function buildFullOutlinePrompts(params: FullOutlinePromptParams): OutlinePromptPair {
  const { idea, totalChapters, configSummary } = params;

  const systemPrompt = [
    "【角色】你是 PiNovelStudio 的长篇网文总纲规划师，负责把作者创意扩展成可拆章的系列总纲，只输出策划文档。",
    "【指令】先读懂作者创意与工作区配置，再规划全书核心卖点、主线、主要角色功能、卷/阶段推进，并逐章给出剧情目标；缺失信息按作者创意合理延展。",
    "【约束】只输出策划内容；不得写章节正文、场景正文、对白或可直接发布的段落。作者在配置中声明的类型与读者承诺是唯一类型来源，不得用推断覆盖，也不得臆造未声明的世界观硬设定。",
    "【示例】正例：“## 第1章：受托之日——主角被迫接下委托，冲突起于报酬与隐瞒，章末悬念：委托人为何隐瞒目标身份。”反例：直接写出一段人物对白与场景描写。",
    "【输出格式】仅输出一份 Markdown 总纲正文，不附加分析、清单、解释或前后言。",
  ].join("\n");

  const userPrompt = [
    "【角色】你是本作品的总纲规划师，本轮产出总纲文档，不是正文。",
    [
      "【指令】",
      `1. 把作者创意扩展为 ${totalChapters} 章的完整小说总纲。`,
      "2. 总纲包含：全书核心卖点、主线走向、主要角色功能、卷/阶段推进。",
      "3. 逐章列出章节概要，标题使用 “## 第N章：标题” 的形式。",
      "4. 每章概要覆盖剧情目标、冲突、转折、伏笔与情绪功能，并能被后续拆成事件级章纲。",
      "",
      "作者创意：",
      idea || "（作者未提供创意）",
      "",
      "工作区配置（作者声明的类型、角色与读者承诺，以此为准）：",
      configSummary || "（未提供配置摘要）",
    ].join("\n"),
    [
      "【约束】",
      "- 不写正文、不写对白、不写可直接发布的段落。",
      "- 作者创意与工作区配置中已声明的类型、角色、读者承诺优先，不得改写或覆盖。",
      `- 章节数量固定为 ${totalChapters} 章，不为凑数编造与主线无关的支线。`,
    ].join("\n"),
    [
      "【示例】",
      "- 正例：每章概要 = 剧情目标一句话 + 冲突一句话 + 转折一句话 + 章末悬念一句话。",
      "- 反例：用整段小说正文、对白或场景描写代替概要。",
    ].join("\n"),
    [
      "【输出格式】",
      "只输出 Markdown 总纲：先给全书概览，再按 “## 第N章：标题” 逐章列出；最后一章之后不再追加任何内容。",
    ].join("\n"),
  ].join("\n");

  return { systemPrompt, userPrompt };
}

export interface ChapterOutlinePromptParams {
  chapterNumber: number;
  eventCount: number;
  chapterSection: string;
  configSummary: string;
}

export function buildChapterOutlinePrompts(params: ChapterOutlinePromptParams): OutlinePromptPair {
  const { chapterNumber, eventCount, chapterSection, configSummary } = params;

  const systemPrompt = [
    "【角色】你是 PiNovelStudio 的章节概要拆分器，负责把总纲中的单章段落拆成事件级显式章纲，只输出章纲。",
    "【指令】先读单章总纲段落，再划分事件块：每个事件块给出类型、内容摘要、冲突等级、情绪弧、感知锚点、参与角色与伏笔，并标注字数目标。",
    "【约束】不得写章节正文、场景正文、对白正文或可直接发布的段落；事件必须出自并服从单章总纲段落，不得虚构与该段落矛盾的事件或人物。",
    "【示例】正例：“#### 事件1：初次冲突——类型：冲突；内容：主角在交付现场发现委托人隐瞒关键信息；冲突等级：3；情绪弧：警觉 -> 戒备。”反例：把事件写成一段带对白的场景正文。",
    "【输出格式】仅输出一份章纲 Markdown，不附加分析、清单、解释或前后言。",
  ].join("\n");

  const userPrompt = [
    "【角色】你是本章的概要拆分器，本轮产出章纲，不是正文。",
    [
      "【指令】",
      `按第 ${chapterNumber} 章总纲段落规划事件块，事件编号从 1 连续编号。`,
      `事件规模由单章总纲的实际内容决定；参考规模约 ${eventCount} 个，可按叙事需要增减。`,
      "",
      "单章总纲段落：",
      chapterSection || "（未提供单章段落）",
      "",
      "工作区配置（作者声明的类型、角色与读者承诺，以此为准）：",
      configSummary || "（未提供配置摘要）",
    ].join("\n"),
    [
      "【约束】",
      "- 不写正文、不写对白、不写场景描写。",
      "- 每个事件的类型、冲突等级与情绪弧必须与该事件的实际功能一致，不堆砌并列事件。",
      "- 事件数量与顺序服务于本章节奏，不为凑满固定数量而附加无关事件。",
      "- 参与角色只能是配置与总纲段落中出现过的角色，不新增人物。",
    ].join("\n"),
    [
      "【示例】",
      "- 正例：事件标题 + 可定位的具体事件摘要（写清谁在何处因何做什么、结果如何）+ 冲突等级数字 + 情绪弧起点与终点。",
      "- 反例：写成小说正文段落，或用“…”占位代替具体事件摘要。",
    ].join("\n"),
    [
      "【输出格式】",
      `# 第${chapterNumber}章：标题`,
      "",
      "## 本章功能",
      "说明本章在整本书中承担的功能（一两句话即可，不强制句数）。",
      "",
      "#### 事件1：事件标题",
      "- **类型**：开场/冲突/转折/揭秘/收束",
      "- **内容**：具体事件摘要，只写摘要，不写正文。",
      "- **冲突等级**：1-5 的数字",
      "- **情绪弧**：起点 -> 终点",
      "- **感知锚点**：可见/可听/可触的具体场景锚点",
      "- **参与角色**：角色名列表",
      "- **伏笔埋设**：本事件新增或推进的伏笔",
      "- **字数目标**：数字",
      "",
      "按同一模板输出本章全部事件块，字段名与上面的模板保持一致，便于程序解析；事件数量以本章总纲的实际内容为准。",
    ].join("\n"),
  ].join("\n");

  return { systemPrompt, userPrompt };
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

      // 旧批量拆章模式仍下线。作者可直接维护 ch{N}-outline-explicit.md，
      // 其叙事内容契约由 ChapterSeedBuilder 读取；本工具不自动编造章节契约。
      if (mode === "outline_to_chapter_outlines" || mode === "full_pipeline") {
        return {
          status: "error",
          mode,
          message:
            "模式 " + mode + " 已下线：系统不自动批量拆分章节契约。" +
            "作者可维护 ch{N}-outline-explicit.md 的章节功能、事件内容、状态变化、伏笔、因果与章末目标；唯一正文入口仍是 novel_generate_chapter。",
          fullOutline: null,
          chapterOutlines: [],
          llmUsed: false,
          errorCode: "MODE_DEPRECATED",
          suggestion:
            "如需生成整体剧情方向，请使用 mode=idea_to_outline。" +
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

    const { systemPrompt, userPrompt } = buildFullOutlinePrompts({
      idea,
      totalChapters,
      configSummary,
    });

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

    const { systemPrompt, userPrompt } = buildChapterOutlinePrompts({
      chapterNumber,
      eventCount,
      chapterSection,
      configSummary,
    });

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
