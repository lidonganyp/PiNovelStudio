/**
 * PiNovelStudio — 章纲可生成性预检门禁
 *
 * Outline Readiness Gate：把"生成失败"变成"输入未就绪"
 *
 * 在 novel_generate_chapter 阶段0之后、阶段1 Architect 之前执行纯本地预检，
 * 评估章纲是否足够具体以进入高成本 LLM 生成链路。
 *
 * P20 新增模块
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";

// ============================================================================
// 类型定义
// ============================================================================

/** 大纲来源类型 */
export type OutlineSource = "explicit" | "chapter-section" | "full-outline-fallback" | "missing";

/** 门禁状态 */
export type ReadinessStatus = "ready" | "warning" | "blocked";

/** 事件块检测结果 */
export interface DetectedEvent {
  index: number;
  title: string;
  hasContent: boolean;
  hasType: boolean;
  hasConflictLevel: boolean;
  hasEmotionArc: boolean;
  contentLength: number;
}

/** 章纲可生成性报告 */
export interface OutlineReadinessReport {
  /** 门禁状态 */
  status: ReadinessStatus;
  /** 可生成性评分 (0-100) */
  score: number;
  /** 章节编号 */
  chapterNumber: number;
  /** 大纲来源 */
  source: OutlineSource;
  /** 检测到的事件总数 */
  eventCount: number;
  /** 显式事件块数量 */
  explicitEventCount: number;
  /** 缺失项列表 */
  missing: string[];
  /** 警告列表 */
  warnings: string[];
  /** 建议列表 */
  suggestions: string[];
  /** 是否应该阻断生成 */
  shouldBlockGeneration: boolean;
  /** 检测到的事件详情 */
  detectedEvents: DetectedEvent[];
  /** 是否检测到卷级大纲（而非章级） */
  hasVolumeLevelRange: boolean;
  /** 详细评分项 */
  scoringDetails: {
    outlineSourceBonus: number;
    eventCountBonus: number;
    eventCompletenessBonus: number;
    volumeLevelPenalty: number;
    fullOutlineFallbackPenalty: number;
    eventInsufficiencyPenalty: number;
  };
}

/** 门禁配置 */
export interface OutlineReadinessConfig {
  /** 是否启用门禁 */
  enabled?: boolean;
  /** 阻断阈值（低于此分数阻断） */
  blockBelowScore?: number;
  /** 警告阈值（低于此分数警告） */
  warnBelowScore?: number;
  /** 是否要求显式事件块 */
  requireExplicitEvents?: boolean;
  /** 最小事件数量 */
  minEvents?: number;
  /** 最小事件内容长度 */
  minEventContentLength?: number;
}

// ============================================================================
// 常量定义
// ============================================================================

/** 默认配置 */
export const DEFAULT_CONFIG: Required<OutlineReadinessConfig> = {
  enabled: true,
  blockBelowScore: 70,
  warnBelowScore: 85,
  requireExplicitEvents: true,
  minEvents: 3,
  minEventContentLength: 30,
};

/** 卷级范围正则表达式 */
const VOLUME_LEVEL_PATTERNS = [
  /第\s*\d+\s*[-~至]\s*\d+\s*章/,
  /\d+\s*[-~至]\s*\d+\s*章/,
  /第一卷[（(]\s*第?\s*\d+\s*[-~至]\s*\d+\s*章/,
  /卷\s*\d+\s*[（(]\s*第?\s*\d+\s*[-~至]\s*\d+\s*章/,
];

/** 显式事件块标题模式（#### 事件N 或 ### 事件N 或 ## 事件N） */
const EXPLICIT_EVENT_PATTERNS = [
  /^#{1,4}\s*[时事事件节]*(?:事件?|Event|EVENT)?\s*[:：]?\s*(\d+|[一二三四五六七八九十]+)[：:：]?\s*(.+)?/m,
  /^#{1,4}\s*(?:E\s*)?(\d+)\s*[:：.]?\s*(.+)?/m,
];

/** 事件属性检测正则（支持普通格式和 Markdown 加粗格式） */
const EVENT_FIELD_PATTERNS = {
  // 内容：匹配 "内容：..." 和 "**内容**：..." 格式
  content: [
    /内容摘要[：:]\s*(.+?)(?=\n\s*[^-\s]|$)/s,
    /\*\*内容摘要\*\*[：:]\s*(.+?)(?=\n\s*[^-\s]|$)/s,
    /内容[：:]\s*(.+?)(?=\n\s*[^-\s]|$)/s,
    /\*\*内容\*\*[：:]\s*(.+?)(?=\n\s*[^-\s]|$)/s,
  ],
  // 类型：匹配 "类型：..."、"**类型**：..."、"场景类型：..."、"**场景类型**：..." 格式
  type: [
    /场?景?类型[：:]\s*(.+?)(?=\n|$)/s,
    /\*\*场?景?类型\*\*[：:]\s*(.+?)(?=\n|$)/s,
  ],
  // 冲突等级：匹配 "冲突等级：2" 或 "冲突强度：3" 或 "**冲突等级**：2" 格式
  // 等?级? 表示 "等" 和 "级" 都是可选的，但需要至少匹配其中一个
  conflictLevel: [
    /冲突等?级?[：:]\s*(\d+)/,
    /\*\*冲突等?级?\*\*[：:]\s*(\d+)/,
  ],
  // 情绪弧：匹配 "情绪弧：..." 和 "**情绪弧**：..." 格式
  emotionArc: [
    /情绪弧[：:]\s*(.+?)(?=\n\s*[^-\s]|$)/s,
    /\*\*情绪弧\*\*[：:]\s*(.+?)(?=\n\s*[^-\s]|$)/s,
  ],
};

// ============================================================================
// OutlineReadinessChecker 类
// ============================================================================

/**
 * 章纲可生成性预检器
 *
 * 纯本地判断，不调用 LLM。
 */
export class OutlineReadinessChecker {
  private readonly config: Required<OutlineReadinessConfig>;

  private chapterNumber = 0;

  constructor(config: OutlineReadinessConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 执行章纲可生成性检查
   */
  check(params: {
    workspacePath: string;
    chapterNumber: number;
    outlineText?: string;
    chapterOutlineFound?: boolean;
    explicitOutlineExists?: boolean;
  }): OutlineReadinessReport {
    const {
      workspacePath,
      chapterNumber,
      outlineText = "",
      chapterOutlineFound = false,
      explicitOutlineExists = false,
    } = params;

    // 保存章节编号供其他方法使用
    this.chapterNumber = chapterNumber;

    // 如果门禁未启用，返回 ready
    if (!this.config.enabled) {
      return this.createReport({
        status: "ready",
        score: 100,
        chapterNumber,
        source: "explicit",
        eventCount: 0,
        explicitEventCount: 0,
        missing: [],
        warnings: [],
        suggestions: [],
        shouldBlockGeneration: false,
        detectedEvents: [],
        hasVolumeLevelRange: false,
        scoringDetails: {
          outlineSourceBonus: 0,
          eventCountBonus: 0,
          eventCompletenessBonus: 0,
          volumeLevelPenalty: 0,
          fullOutlineFallbackPenalty: 0,
          eventInsufficiencyPenalty: 0,
        },
      });
    }

    // 1. 检测大纲来源
    const source = this.detectOutlineSource(
      workspacePath,
      chapterNumber,
      outlineText,
      chapterOutlineFound,
      explicitOutlineExists
    );

    // 2. 检测显式事件块
    const detectedEvents = this.detectExplicitEvents(outlineText);

    // 3. 检测卷级范围
    const hasVolumeLevelRange = this.detectVolumeLevelRange(outlineText);

    // 4. 计算评分
    // P20修复：传入 requireExplicitEvents 配置，控制无事件块是否扣分
    const scoringDetails = this.calculateScoringDetails(
      source,
      detectedEvents,
      hasVolumeLevelRange,
      this.config.requireExplicitEvents
    );

    const score = this.calculateScore(scoringDetails);

    // 5. 生成缺失项和警告
    // P20修复：传入 requireExplicitEvents 配置以控制事件要求
    const { missing, warnings, suggestions } = this.generateIssues(
      source,
      detectedEvents,
      hasVolumeLevelRange,
      score,
      this.config.requireExplicitEvents
    );

    // 6. 判断是否阻断
    // P20修复：requireExplicitEvents: false 时，explicit 或 chapter-section 来源（无事件块）只警告不阻断
    // 限制：missing 和 full-outline-fallback 必须继续阻断
    let shouldBlockGeneration = score < this.config.blockBelowScore;
    if (!this.config.requireExplicitEvents && detectedEvents.length === 0 &&
        (source === "explicit" || source === "chapter-section")) {
      // 无显式事件块，但来源是 explicit 或 chapter-section，且配置允许时，改为警告而非阻断
      shouldBlockGeneration = false;
    }

    // 7. 判断状态
    let status: ReadinessStatus;
    if (shouldBlockGeneration) {
      status = "blocked";
    } else if (score < this.config.warnBelowScore) {
      status = "warning";
    } else {
      status = "ready";
    }

    return this.createReport({
      status,
      score,
      chapterNumber,
      source,
      eventCount: detectedEvents.length,
      explicitEventCount: detectedEvents.filter(e => e.hasContent).length,
      missing,
      warnings,
      suggestions,
      shouldBlockGeneration,
      detectedEvents,
      hasVolumeLevelRange,
      scoringDetails,
    });
  }

  /**
   * 检测大纲来源
   * P20修复：优先使用传入的 explicitOutlineExists 参数，避免重新检查文件系统
   */
  private detectOutlineSource(
    workspacePath: string,
    chapterNumber: number,
    outlineText: string,
    chapterOutlineFound: boolean,
    explicitOutlineExists: boolean
  ): OutlineSource {
    // 1. 优先使用传入的 explicitOutlineExists 参数
    // P20修复：优先使用参数而非重新检查文件系统
    if (explicitOutlineExists) {
      return "explicit";
    }

    // 2. 检查主大纲中是否包含本章段落
    if (chapterOutlineFound && outlineText.length > 100) {
      // 检查是否只有卷级范围
      if (this.detectVolumeLevelRange(outlineText)) {
        return "full-outline-fallback";
      }
      return "chapter-section";
    }

    // 3. 检查主大纲文件是否存在
    const mainOutlinePath = join(workspacePath, "series", "outline.md");
    if (existsSync(mainOutlinePath)) {
      return "full-outline-fallback";
    }

    return "missing";
  }

  /**
   * 检测显式事件块
   * 支持多种格式的事件块标题
   */
  private detectExplicitEvents(outlineText: string): DetectedEvent[] {
    const events: DetectedEvent[] = [];

    if (!outlineText) {
      return events;
    }

    // 多种事件标题模式
    const eventPatterns = [
      // #### 事件1：标题 或 #### 事件1
      /^#{1,4}\s*事件\s*(\d+|[一二三四五六七八九十]+)[：:：]?\s*(.*)?$/m,
      // #### E1：标题 或 #### E1
      /^#{1,4}\s*E\s*(\d+)[：:：]?\s*(.*)?$/m,
      // #### 1. 标题
      /^#{1,4}\s*(\d+)[.、][\s]*(.*)?$/m,
    ];

    // 查找所有事件标题
    const lines = outlineText.split('\n');
    let currentEvent: Partial<DetectedEvent> | null = null;
    let currentContent: string[] = [];
    let eventIndex = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let matchedEvent = false;
      let eventNum = 0;
      let eventTitle = "";

      for (const pattern of eventPatterns) {
        const match = line.match(pattern);
        if (match) {
          eventNum = parseInt(match[1]) || (this.chineseToNumber(match[1]) as number) || eventIndex + 1;
          eventTitle = (match[2] || "").trim();
          matchedEvent = true;
          break;
        }
      }

      if (matchedEvent) {
        // 保存前一个事件
        if (currentEvent) {
          events.push(this.createDetectedEvent(currentEvent, currentContent.join('\n')));
        }

        // 开始新事件
        currentEvent = {
          index: eventNum,
          title: eventTitle,
        };
        currentContent = [];
        eventIndex++;
      } else if (currentEvent) {
        // 继续收集当前事件的内容
        currentContent.push(line);
      }
    }

    // 保存最后一个事件
    if (currentEvent) {
      events.push(this.createDetectedEvent(currentEvent, currentContent.join('\n')));
    }

    return events;
  }

  /**
   * 创建检测到的事件对象
   */
  private createDetectedEvent(event: Partial<DetectedEvent>, content: string): DetectedEvent {
    const hasContent = this.checkField(content, EVENT_FIELD_PATTERNS.content);
    const hasType = this.checkField(content, EVENT_FIELD_PATTERNS.type);
    const hasConflictLevel = this.checkField(content, EVENT_FIELD_PATTERNS.conflictLevel);
    const hasEmotionArc = this.checkField(content, EVENT_FIELD_PATTERNS.emotionArc);
    const contentLength = content.trim().length;

    return {
      index: event.index || 0,
      title: event.title || "",
      hasContent,
      hasType,
      hasConflictLevel,
      hasEmotionArc,
      contentLength,
    };
  }

  /**
   * 检测卷级范围
   */
  private detectVolumeLevelRange(outlineText: string): boolean {
    for (const pattern of VOLUME_LEVEL_PATTERNS) {
      if (pattern.test(outlineText)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 计算评分详情
   * P20修复：传入 requireExplicitEvents 配置，控制无事件块是否扣分
   * 当 requireExplicitEvents: false 且有章级段落时，基础分应能通过阻断阈值
   */
  private calculateScoringDetails(
    source: OutlineSource,
    events: DetectedEvent[],
    hasVolumeLevelRange: boolean,
    requireExplicitEvents: boolean
  ) {
    let outlineSourceBonus = 0;
    let eventCountBonus = 0;
    let eventCompletenessBonus = 0;
    let volumeLevelPenalty = 0;
    let fullOutlineFallbackPenalty = 0;
    let eventInsufficiencyPenalty = 0;

    // 大纲来源加分
    switch (source) {
      case "explicit":
        outlineSourceBonus = 35;
        break;
      case "chapter-section":
        outlineSourceBonus = 35; // 提高章级段落分数
        break;
      case "full-outline-fallback":
        outlineSourceBonus = 15;
        fullOutlineFallbackPenalty = 30;
        break;
      case "missing":
        outlineSourceBonus = 0;
        fullOutlineFallbackPenalty = 30;
        break;
    }

    // 卷级范围惩罚（仅对非 explicit 来源生效）
    if (hasVolumeLevelRange && source !== "explicit") {
      volumeLevelPenalty = 20;
    }

    // 事件数量和完整性
    const eventCount = events.length;
    const hasEvents = eventCount > 0;

    if (hasEvents) {
      // 有显式事件块，给基础分
      eventCountBonus = 15;

      // 事件完整性加成（显式来源时降低要求）
      let totalCompleteness = 0;
      let maxPossible = 0;
      for (const event of events) {
        maxPossible += 10;
        if (event.hasContent) totalCompleteness += 4;
        if (event.hasType) totalCompleteness += 2;
        if (event.hasConflictLevel) totalCompleteness += 2;
        if (event.hasEmotionArc) totalCompleteness += 2;
      }

      // 事件完整性加成
      if (maxPossible > 0) {
        eventCompletenessBonus = Math.floor((totalCompleteness / maxPossible) * 20);
      }

      // 事件数量加成（超过 minEvents 额外加分）
      // P20修复：≥minEvents 直接给 25 分，与开发回复描述一致
      if (eventCount >= this.config.minEvents) {
        eventCountBonus = 25;
      }

      // 内容过短惩罚
      for (const event of events) {
        if (event.contentLength > 0 && event.contentLength < this.config.minEventContentLength) {
          eventInsufficiencyPenalty += 5;
        }
      }
    } else {
      // 无显式事件块
      // P20修复：requireExplicitEvents: false 时不扣分，只警告
      if (requireExplicitEvents) {
        eventInsufficiencyPenalty = 20;
      }
    }

    return {
      outlineSourceBonus,
      eventCountBonus,
      eventCompletenessBonus,
      volumeLevelPenalty,
      fullOutlineFallbackPenalty,
      eventInsufficiencyPenalty,
    };
  }

  /**
   * 计算总分
   */
  private calculateScore(details: ReturnType<typeof this.calculateScoringDetails>): number {
    let score = 0;

    score += details.outlineSourceBonus;
    score += details.eventCountBonus;
    score += details.eventCompletenessBonus;
    score -= details.volumeLevelPenalty;
    score -= details.fullOutlineFallbackPenalty;
    score -= details.eventInsufficiencyPenalty;

    return Math.max(0, Math.min(100, score));
  }

  /**
   * 生成缺失项和警告
   * P20修复：传入 requireExplicitEvents 配置以控制事件要求放宽
   */
  private generateIssues(
    source: OutlineSource,
    events: DetectedEvent[],
    hasVolumeLevelRange: boolean,
    score: number,
    requireExplicitEvents: boolean
  ): { missing: string[]; warnings: string[]; suggestions: string[] } {
    const missing: string[] = [];
    const warnings: string[] = [];
    const suggestions: string[] = [];

    // 大纲缺失
    if (source === "missing") {
      missing.push("未找到任何大纲文件（outline.md 或 chX-outline-explicit.md）");
    }

    // 显式大纲缺失
    if (source !== "explicit") {
      // P20修复: 修正提示路径 typo，多了一个点
      missing.push(`未找到 series/ch${this.getChapterNumber()}-outline-explicit.md`);
    }

    // 卷级范围警告
    if (hasVolumeLevelRange && source !== "explicit") {
      warnings.push("检测到卷级大纲范围（如\"第1-10章\"），缺少章级具体大纲");
    }

    // 完整大纲回退警告
    if (source === "full-outline-fallback") {
      warnings.push("主大纲未包含本章段落，使用完整大纲 fallback");
      warnings.push("建议创建章节专属大纲文件以提高生成质量");
    }

    // P20修复：事件数量不足判断考虑 requireExplicitEvents 配置
    // 当 requireExplicitEvents: false 时，无显式事件块只警告不阻断
    const requiresExplicitEvents = requireExplicitEvents && source !== "explicit";
    if (events.length < this.config.minEvents) {
      if (requiresExplicitEvents || events.length > 0) {
        // 有事件但数量不足，或者强制要求显式事件
        missing.push(`显式事件块数量不足（当前${events.length}个，要求${this.config.minEvents}个）`);
      } else if (events.length === 0) {
        // 无显式事件块但不需要强制
        warnings.push(`未检测到显式事件块，建议添加事件描述以提高生成质量`);
      }
    }

    // 事件内容过薄
    const thinEvents = events.filter(e => e.contentLength < this.config.minEventContentLength);
    if (thinEvents.length > 0) {
      warnings.push(`${thinEvents.length}个事件内容过短（<${this.config.minEventContentLength}字）`);
    }

    // 生成建议
    if (source !== "explicit") {
      suggestions.push(`创建 workspaces/{workspaceId}/series/ch${this.getChapterNumber()}-outline-explicit.md`);
    }

    if (events.length < this.config.minEvents) {
      suggestions.push(`至少提供 ${this.config.minEvents} 个"#### 事件X"块`);
    }

    const hasIncompleteEvents = events.some(e => !e.hasContent || !e.hasType);
    if (hasIncompleteEvents) {
      suggestions.push("为每个事件补充：类型 / 内容 / 冲突等级 / 情绪弧");
    }

    if (hasVolumeLevelRange) {
      suggestions.push("将卷级大纲拆分为章级大纲，每个章级大纲包含具体事件");
    }

    return { missing, warnings, suggestions };
  }

  private getChapterNumber(): number {
    return this.chapterNumber;
  }

  /**
   * 检查字段是否存在
   */
  private checkField(content: string, patterns: RegExp[]): boolean {
    for (const pattern of patterns) {
      if (pattern.test(content)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 中文数字转阿拉伯数字
   */
  private chineseToNumber(chinese: string): number | null {
    const map: Record<string, number> = {
      "一": 1, "二": 2, "三": 3, "四": 4, "五": 5,
      "六": 6, "七": 7, "八": 8, "九": 9, "十": 10,
    };
    return map[chinese] ?? null;
  }

  /**
   * 创建报告
   */
  private createReport(data: Omit<OutlineReadinessReport, "status"> & { status: ReadinessStatus }): OutlineReadinessReport {
    return {
      ...data,
      status: data.status,
    };
  }
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建 OutlineReadinessChecker 实例
 */
export function createOutlineReadinessChecker(config?: OutlineReadinessConfig): OutlineReadinessChecker {
  return new OutlineReadinessChecker(config);
}

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 格式化阻断消息
 */
export function formatOutlineReadinessBlockMessage(report: OutlineReadinessReport): string {
  const lines: string[] = [];

  lines.push(`【阶段0生产阻断】第${report.chapterNumber}章章纲可生成性不足，已停止进入 Architect/Narrator。`);
  lines.push("");
  lines.push("原因：");

  for (const item of report.missing) {
    lines.push(`- ${item}`);
  }

  for (const item of report.warnings) {
    lines.push(`- ⚠️ ${item}`);
  }

  lines.push("");
  lines.push(`评分：${report.score}/100`);
  lines.push("");

  if (report.suggestions.length > 0) {
    lines.push("建议：");
    report.suggestions.forEach((s, i) => {
      lines.push(`${i + 1}. ${s}`);
    });
  }

  return lines.join("\n");
}

/**
 * 从 config.json 加载门禁配置
 */
export function loadOutlineReadinessConfigFromJson(configJson: Record<string, any>): OutlineReadinessConfig {
  const readiness = configJson.outlineReadiness;
  if (!readiness || typeof readiness !== "object") {
    return {};
  }

  return {
    enabled: readiness.enabled ?? true,
    blockBelowScore: readiness.blockBelowScore ?? 70,
    warnBelowScore: readiness.warnBelowScore ?? 85,
    requireExplicitEvents: readiness.requireExplicitEvents ?? true,
    minEvents: readiness.minEvents ?? 3,
    minEventContentLength: readiness.minEventContentLength ?? 30,
  };
}
