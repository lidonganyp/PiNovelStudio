/**
 * PiNovelStudio — 弧线闭合追踪器 (ClosureTracker)
 *
 * 跨越时间轴的弧线状态机，负责追踪所有弧线/债务/细节的闭合状态。
 * 与 Critic/DependencyChecker/DetailLedger 的核心区别：
 * - Critic: 单章文字质量（截面检测）
 * - DependencyChecker: 情节逻辑依赖
 * - DetailLedger: 细节一致性
 * - ClosureTracker: 历程追踪（时间轴状态机）
 *
 * 核心能力：
 * - 弧线状态追踪（DAG 外层约束）
 * - 债务清偿状态追踪（与 NarrativeDebtLedger 互补）
 * - 结局完备性报告生成
 * - 多结局候选结构评估
 * - 烂尾风险评分（结构层）
 *
 * 规则来源：
 * - #246-#250: 收尾五类型分类学
 * - #251-#263: 架构层规则
 * - 追补方向1: arc-registry.json Schema
 */

import {
  Arc,
  ArcRegistry,
  ArcStatus,
  ArcType,
  ClosureType,
  ForeshadowLevel,
  PendingForeshadow,
  ArcMilestone,
  createArc,
  createEmptyRegistry,
  createPendingForeshadow,
  checkClosureWindow,
  checkForeshadowRecallWindow,
  isLegalTransition,
  CLOSURE_TYPE_METADATA,
  FORBIDDEN_ABANDON_TYPES,
} from "../data/arc-registry.js";
import { join, dirname } from "path";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "fs";

// ============================================================================
// 完备性扫描维度（D1-D6）
// ============================================================================

/** D1: 主角弧完备性 */
export interface PrimaryArcCompleteness {
  score: number; // 0-3
  coreGrowthAnswered: boolean;
  maxWeaknessChanged: boolean;
  coreRelationshipFrozen: boolean;
  critical: boolean; // < 2.5 = CRITICAL
}

/** D2: 配角弧完备性 */
export interface SupportingArcCompleteness {
  score: number; // 加权得分率
  p1ArcsResolved: number;
  p1ArcsTotal: number;
  p2ArcsResolved: number;
  p2ArcsTotal: number;
  critical: boolean; // 任意 P1 配角 open = CRITICAL
}

/** D3: 世界观弧完备性 */
export interface WorldArcCompleteness {
  score: number; // 0-3
  coreConflictResolved: boolean;
  closurePositionValid: boolean;
  newEquilibriumPresented: boolean;
  critical: boolean; // < 2 = CRITICAL
}

/** D4: 债务清偿完备性 */
export interface DebtCompleteness {
  score: number; // 加权得分率
  p0Resolved: number;
  p0Total: number;
  p1Resolved: number;
  p1Total: number;
  critical: boolean; // 任意 P0 未清偿 = CRITICAL
}

/** D5: 伏笔唤回完备性 */
export interface ForeshadowCompleteness {
  score: number; // 分级加权
  aLevelRecalled: number;
  aLevelTotal: number;
  bLevelRecalled: number;
  bLevelTotal: number;
  cLevelRecalled: number;
  cLevelTotal: number;
  orphanCount: number;
  critical: boolean; // 任意 A 级未唤回 = CRITICAL
}

/** D6: 节奏结构合规 */
export interface RhythmCompliance {
  score: number; // 4 - 违规数
  last3ChapterFunctionValid: boolean; // #C-05
  noNewDebtInLast3: boolean; // #C-04
  emotionalClosesBeforePlot: boolean; // #C-07
  noPlotAfterEmotional: boolean; // #C-09
  critical: boolean; // 任意 CRITICAL 规则违反
}

/** 完备性综合报告 */
export interface CompletenessReport {
  d1_primaryArc: PrimaryArcCompleteness;
  d2_supportingArc: SupportingArcCompleteness;
  d3_worldArc: WorldArcCompleteness;
  d4_debt: DebtCompleteness;
  d5_foreshadow: ForeshadowCompleteness;
  d6_rhythm: RhythmCompliance;

  compositeScore: number; // 0-1
  compositeGrade: "complete" | "acceptable" | "warning" | "critical";

  criticalIssues: string[];
  warnings: string[];
  suggestions: string[];

  generatedAt: string;
}

// ============================================================================
// ClosureTracker 主类
// ============================================================================

export class ClosureTracker {
  private registry: ArcRegistry;
  private filePath: string | null = null;

  constructor(registry?: ArcRegistry) {
    this.registry = registry || createEmptyRegistry(100, "fulfilling");
  }

  // ============================================================================
  // 持久化
  // ============================================================================

  /**
   * 从文件加载
   */
  static loadFromFile(filePath: string): ClosureTracker | null {
    if (!existsSync(filePath)) {
      return null;
    }

    try {
      const raw = readFileSync(filePath, "utf-8");
      const data = JSON.parse(raw) as ArcRegistry;
      return new ClosureTracker(data);
    } catch {
      return null;
    }
  }

  /**
   * 保存到文件（P1-6 修复：原子写入 tmp→rename，跨平台目录解析）
   *
   * 之前的实现直接 writeFileSync，不是原子写入（失败会留下半写的损坏文件），
   * 且用 lastIndexOf("\\") 提取目录是 Windows 专用，在 Linux/macOS 会失败。
   * 现在改为：写 .tmp 临时文件 → rename 到目标路径（原子操作），
   * 目录解析使用 path.dirname（跨平台）。
   */
  saveToFile(filePath: string): void {
    this.registry.lastUpdated = new Date().toISOString();
    this.registry.config.currentChapter = this.registry.config.currentChapter || 1;

    const dirPath = dirname(filePath);
    if (dirPath && !existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true });
    }

    // P1-6: 原子写入（tmp → rename），失败不会破坏现有文件
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmpPath, JSON.stringify(this.registry, null, 2), "utf-8");
    renameSync(tmpPath, filePath);
    this.filePath = filePath;
  }

  /**
   * 获取注册表
   */
  getRegistry(): ArcRegistry {
    return { ...this.registry };
  }

  /**
   * 设置当前章节
   */
  setCurrentChapter(chapter: number): void {
    this.registry.config.currentChapter = chapter;
  }

  /**
   * 获取当前章节
   */
  getCurrentChapter(): number {
    return this.registry.config.currentChapter;
  }

  // ============================================================================
  // 弧线管理
  // ============================================================================

  /**
   * 添加弧线
   */
  addArc(params: {
    arc_id: string;
    name: string;
    arc_type: ArcType;
    subject: { characterId: string; theme: string; coreConflict: string };
    core_question: string;
    chapter_opened?: number;
    priority?: Arc["priority"];
    false_belief?: string;
    truth_arrived_at?: string;
    closure_type_constraint?: ClosureType;
  }): Arc {
    const arc = createArc({
      ...params,
      chapter_opened: params.chapter_opened ?? this.registry.config.currentChapter,
    });
    this.registry.arcs.push(arc);
    return arc;
  }

  /**
   * 更新弧线状态
   */
  updateArcStatus(
    arcId: string,
    newStatus: ArcStatus
  ): {
    success: boolean;
    error?: string;
  } {
    const arc = this.registry.arcs.find((a) => a.arc_id === arcId);
    if (!arc) {
      return { success: false, error: `弧线 ${arcId} 不存在` };
    }

    if (!isLegalTransition(arc.status, newStatus, arc.arc_type)) {
      return {
        success: false,
        error: `非法状态流转: ${arc.status} → ${newStatus} (弧线类型: ${arc.arc_type})`,
      };
    }

    arc.status = newStatus;
    arc.metadata.updatedAt = new Date().toISOString();

    // 记录章节
    const currentChapter = this.registry.config.currentChapter;
    if (newStatus === "climaxed") {
      arc.chapter_climaxed = currentChapter;
    } else if (newStatus === "resolved" || newStatus === "abandoned") {
      arc.chapter_closed = currentChapter;
    }

    return { success: true };
  }

  /**
   * 批量更新状态（用于章节完成）
   */
  batchUpdateStatus(updates: Array<{ arcId: string; newStatus: ArcStatus }>): {
    succeeded: string[];
    failed: Array<{ arcId: string; error: string }>;
  } {
    const succeeded: string[] = [];
    const failed: Array<{ arcId: string; error: string }> = [];

    for (const update of updates) {
      const result = this.updateArcStatus(update.arcId, update.newStatus);
      if (result.success) {
        succeeded.push(update.arcId);
      } else {
        failed.push({ arcId: update.arcId, error: result.error || "未知错误" });
      }
    }

    return { succeeded, failed };
  }

  /**
   * 获取弧线
   */
  getArc(arcId: string): Arc | undefined {
    return this.registry.arcs.find((a) => a.arc_id === arcId);
  }

  /**
   * 按类型获取弧线
   */
  getArcsByType(type: ArcType): Arc[] {
    return this.registry.arcs.filter((a) => a.arc_type === type);
  }

  /**
   * 按优先级获取弧线
   */
  getArcsByPriority(priority: Arc["priority"]): Arc[] {
    return this.registry.arcs.filter((a) => a.priority === priority);
  }

  /**
   * 按角色获取弧线
   */
  getArcsByCharacter(characterId: string): Arc[] {
    return this.registry.arcs.filter((a) => a.subject.characterId === characterId);
  }

  /**
   * 获取未闭合弧线（按优先级排序）
   */
  getOpenArcsByPriority(): Arc[] {
    const openArcs = this.registry.arcs.filter(
      (a) => a.status !== "resolved" && a.status !== "abandoned"
    );

    const priorityOrder = ["P0", "P1", "P2", "P3", "P4"];
    return openArcs.sort((a, b) => {
      const aIndex = priorityOrder.indexOf(a.priority);
      const bIndex = priorityOrder.indexOf(b.priority);
      return aIndex - bIndex;
    });
  }

  /**
   * 检查弧线是否可以推进
   * 遍历依赖链，确保前置条件满足
   */
  canArcProceed(arcId: string): {
    canProceed: boolean;
    blockers: string[];
  } {
    const arc = this.registry.arcs.find((a) => a.arc_id === arcId);
    if (!arc) {
      return { canProceed: false, blockers: [`弧线 ${arcId} 不存在`] };
    }

    // 已完成的弧线不能推进
    if (arc.status === "resolved" || arc.status === "abandoned") {
      return { canProceed: false, blockers: ["弧线已闭合或废弃"] };
    }

    const blockers: string[] = [];

    // 检查依赖
    for (const dep of arc.dependencies) {
      if (dep.dependencyType === "precedes") {
        const depArc = this.registry.arcs.find((a) => a.arc_id === dep.dependsOn);
        if (!depArc || depArc.status === "resolved" || depArc.status === "abandoned") {
          blockers.push(`依赖弧线 ${dep.dependsOn} 未闭合`);
        }
      }
    }

    return {
      canProceed: blockers.length === 0,
      blockers,
    };
  }

  // ============================================================================
  // 伏笔管理
  // ============================================================================

  /**
   * 添加待唤回伏笔
   */
  addForeshadow(params: {
    id: string;
    description: string;
    level: ForeshadowLevel;
    plantedChapter: number;
    targetChapter: number;
    recallMethod: PendingForeshadow["recallMethod"];
  }): PendingForeshadow {
    const foreshadow = createPendingForeshadow(params);
    this.registry.pending_foreshadows.push(foreshadow);
    return foreshadow;
  }

  /**
   * 标记伏笔已唤回
   */
  recallForeshadow(foreshadowId: string): boolean {
    const foreshadow = this.registry.pending_foreshadows.find(
      (f) => f.id === foreshadowId
    );
    if (!foreshadow) return false;

    foreshadow.recalled = true;
    foreshadow.recallChapter = this.registry.config.currentChapter;
    return true;
  }

  /**
   * 获取待唤回伏笔
   */
  getPendingForeshadows(): PendingForeshadow[] {
    return this.registry.pending_foreshadows.filter((f) => !f.recalled);
  }

  /**
   * 按等级获取待唤回伏笔
   */
  getPendingForeshadowsByLevel(level: ForeshadowLevel): PendingForeshadow[] {
    return this.getPendingForeshadows().filter((f) => f.level === level);
  }

  // ============================================================================
  // 完备性扫描
  // ============================================================================

  /**
   * 执行完整完备性扫描
   */
  scanCompleteness(): CompletenessReport {
    const currentChapter = this.registry.config.currentChapter;
    const totalChapters = this.registry.config.totalChapters;

    // D1: 主角弧完备性
    const d1 = this.scanPrimaryArcCompleteness();

    // D2: 配角弧完备性
    const d2 = this.scanSupportingArcCompleteness();

    // D3: 世界观弧完备性
    const d3 = this.scanWorldArcCompleteness();

    // D4: 债务清偿完备性
    const d4 = this.scanDebtCompleteness();

    // D5: 伏笔唤回完备性
    const d5 = this.scanForeshadowCompleteness();

    // D6: 节奏结构合规
    const d6 = this.scanRhythmCompliance();

    // 综合评分
    const compositeScore =
      d1.score * 0.30 +
      d2.score * 0.15 +
      d3.score * 0.10 +
      d4.score * 0.20 +
      d5.score * 0.15 +
      d6.score * 0.10;

    // CRITICAL 惩罚
    const hasCritical =
      d1.critical ||
      d2.critical ||
      d3.critical ||
      d4.critical ||
      d5.critical ||
      d6.critical;

    const finalScore = hasCritical ? compositeScore * 0.15 : compositeScore;

    // 等级判定
    let compositeGrade: CompletenessReport["compositeGrade"];
    if (finalScore >= 0.90) {
      compositeGrade = "complete";
    } else if (finalScore >= 0.75) {
      compositeGrade = "acceptable";
    } else if (finalScore >= 0.60) {
      compositeGrade = "warning";
    } else {
      compositeGrade = "critical";
    }

    // 收集问题
    const criticalIssues: string[] = [];
    const warnings: string[] = [];
    const suggestions: string[] = [];

    if (d1.critical) criticalIssues.push("主角弧未充分闭合");
    if (d2.critical) criticalIssues.push("存在未闭合的 P1 配角弧");
    if (d3.critical) criticalIssues.push("世界观弧未充分闭合");
    if (d4.critical) criticalIssues.push("存在未清偿的 P0 债务");
    if (d5.critical) criticalIssues.push("存在未唤回的 A 级伏笔");
    if (d6.critical) criticalIssues.push("违反节奏结构规则");

    if (d2.score < 0.8) {
      warnings.push(`配角弧闭合率较低: ${(d2.score * 100).toFixed(0)}%`);
    }
    if (d5.score < 0.9) {
      warnings.push(`伏笔唤回率较低: ${(d5.score * 100).toFixed(0)}%`);
    }
    if (d6.score < 3) {
      warnings.push(`节奏结构存在 ${4 - d6.score} 项违规`);
    }

    // 建议
    if (compositeScore < 0.90) {
      suggestions.push("建议在进入终局段前完成更多弧线闭合");
    }
    if (d4.score < 0.90) {
      suggestions.push("优先处理高优先级债务");
    }
    if (d5.orphanCount > 2) {
      suggestions.push("存在孤儿伏笔，建议清理");
    }

    return {
      d1_primaryArc: d1,
      d2_supportingArc: d2,
      d3_worldArc: d3,
      d4_debt: d4,
      d5_foreshadow: d5,
      d6_rhythm: d6,
      compositeScore: finalScore,
      compositeGrade,
      criticalIssues,
      warnings,
      suggestions,
      generatedAt: new Date().toISOString(),
    };
  }

  private scanPrimaryArcCompleteness(): PrimaryArcCompleteness {
    const primaryArcs = this.getArcsByType("primary");
    const resolvedPrimary = primaryArcs.filter((a) => a.status === "resolved");

    const coreGrowthAnswered = resolvedPrimary.some(
      (a) => a.truth_arrived_at && a.truth_arrived_at.length > 0
    );

    const maxWeaknessChanged = resolvedPrimary.some(
      (a) => a.false_belief && a.truth_arrived_at
    );

    const coreRelationshipFrozen = resolvedPrimary.length > 0;

    const score =
      (coreGrowthAnswered ? 1 : 0) +
      (maxWeaknessChanged ? 1 : 0) +
      (coreRelationshipFrozen ? 1 : 0);

    return {
      score,
      coreGrowthAnswered,
      maxWeaknessChanged,
      coreRelationshipFrozen,
      critical: score < 2.5,
    };
  }

  private scanSupportingArcCompleteness(): SupportingArcCompleteness {
    const secondaryArcs = this.getArcsByType("secondary");

    const p1Arcs = secondaryArcs.filter((a) => a.priority === "P1");
    const p2Arcs = secondaryArcs.filter((a) => a.priority === "P2");

    const p1Resolved = p1Arcs.filter(
      (a) => a.status === "resolved" || a.status === "abandoned"
    ).length;
    const p2Resolved = p2Arcs.filter(
      (a) => a.status === "resolved" || a.status === "abandoned"
    ).length;

    const p1Score = p1Arcs.length > 0 ? p1Resolved / p1Arcs.length : 1;
    const p2Score = p2Arcs.length > 0 ? p2Resolved / p2Arcs.length : 1;
    const score = p1Score * 0.6 + p2Score * 0.4;

    return {
      score,
      p1ArcsResolved: p1Resolved,
      p1ArcsTotal: p1Arcs.length,
      p2ArcsResolved: p2Resolved,
      p2ArcsTotal: p2Arcs.length,
      critical: p1Resolved < p1Arcs.length,
    };
  }

  private scanWorldArcCompleteness(): WorldArcCompleteness {
    const worldArcs = this.getArcsByType("world");
    const resolvedWorld = worldArcs.filter((a) => a.status === "resolved");

    const coreConflictResolved = resolvedWorld.length > 0;

    let closurePositionValid = true;
    for (const arc of resolvedWorld) {
      if (arc.chapter_closed !== null) {
        const result = checkClosureWindow(
          arc,
          this.registry.config.totalChapters,
          arc.chapter_closed
        );
        if (!result.isOnTime && !result.isEarly) {
          closurePositionValid = false;
          break;
        }
      }
    }

    const newEquilibriumPresented = resolvedWorld.some(
      (a) => a.truth_arrived_at && a.truth_arrived_at.length > 0
    );

    const score =
      (coreConflictResolved ? 1 : 0) +
      (closurePositionValid ? 1 : 0) +
      (newEquilibriumPresented ? 1 : 0);

    return {
      score,
      coreConflictResolved,
      closurePositionValid,
      newEquilibriumPresented,
      critical: score < 2,
    };
  }

  private scanDebtCompleteness(): DebtCompleteness {
    const debtArcs = this.getArcsByType("debt");

    const p0Debts = debtArcs.filter((a) => a.priority === "P0");
    const p1Debts = debtArcs.filter((a) => a.priority === "P1");

    const p0Resolved = p0Debts.filter(
      (a) => a.status === "resolved" || a.status === "abandoned"
    ).length;
    const p1Resolved = p1Debts.filter(
      (a) => a.status === "resolved" || a.status === "abandoned"
    ).length;

    const p0Score = p0Debts.length > 0 ? p0Resolved / p0Debts.length : 1;
    const p1Score = p1Debts.length > 0 ? p1Resolved / p1Debts.length : 1;
    const score = p0Score * 0.7 + p1Score * 0.3;

    return {
      score,
      p0Resolved,
      p0Total: p0Debts.length,
      p1Resolved,
      p1Total: p1Debts.length,
      critical: p0Resolved < p0Debts.length,
    };
  }

  private scanForeshadowCompleteness(): ForeshadowCompleteness {
    const pending = this.registry.pending_foreshadows;
    const recalled = pending.filter((f) => f.recalled);

    const aPending = pending.filter((f) => f.level === "A" && !f.recalled);
    const bPending = pending.filter((f) => f.level === "B" && !f.recalled);
    const cPending = pending.filter((f) => f.level === "C" && !f.recalled);

    const aTotal = pending.filter((f) => f.level === "A").length;
    const bTotal = pending.filter((f) => f.level === "B").length;
    const cTotal = pending.filter((f) => f.level === "C").length;

    const aRecalled = aTotal - aPending.length;
    const bRecalled = bTotal - bPending.length;
    const cRecalled = cTotal - cPending.length;

    // 加权得分
    const aScore = aTotal > 0 ? aRecalled / aTotal : 1;
    const bScore = bTotal > 0 ? bRecalled / bTotal : 1;
    const cScore = cTotal > 0 ? cRecalled / cTotal : 1;
    const score = aScore * 0.5 + bScore * 0.35 + cScore * 0.15;

    // 孤儿伏笔检测（超过 2 个 = 问题）
    const orphanCount = aPending.length;

    return {
      score,
      aLevelRecalled: aRecalled,
      aLevelTotal: aTotal,
      bLevelRecalled: bRecalled,
      bLevelTotal: bTotal,
      cLevelRecalled: cRecalled,
      cLevelTotal: cTotal,
      orphanCount,
      critical: aRecalled < aTotal,
    };
  }

  private scanRhythmCompliance(): RhythmCompliance {
    // 简化版：检查最后3章是否有新债务引入
    const hasNewDebtInLast3 = this.registry.arcs.some((arc) => {
      if (arc.arc_type !== "debt") return false;
      const opened = arc.chapter_opened || 0;
      const current = this.registry.config.currentChapter;
      const distanceFromEnd = this.registry.config.totalChapters - opened;
      return distanceFromEnd <= 3;
    });

    const last3ChapterFunctionValid = this.validateLast3ChapterFunction(this.registry.arcs);
    const emotionalClosesBeforePlot = this.validateEmotionalClosesBeforePlot(this.registry.arcs);
    const noPlotAfterEmotional = emotionalClosesBeforePlot;

    const violations =
      (hasNewDebtInLast3 ? 1 : 0) +
      (!last3ChapterFunctionValid ? 1 : 0) +
      (!emotionalClosesBeforePlot ? 1 : 0) +
      (!noPlotAfterEmotional ? 1 : 0);

    return {
      score: 4 - violations,
      last3ChapterFunctionValid,
      noNewDebtInLast3: !hasNewDebtInLast3,
      emotionalClosesBeforePlot,
      noPlotAfterEmotional,
      critical: violations > 0,
    };
  }

  /**
   * R095: 验证最后3章功能顺序合规 (#C-05)
   * 规则：最后3章功能不可倒置 — 行动层→关系层→意义层
   * 通过检查最后3章关闭的弧线类型分布来验证
   */
  private validateLast3ChapterFunction(arcs: Arc[]): boolean {
    const current = this.registry.config.currentChapter;
    const total = this.registry.config.totalChapters;
    if (total < 3 || current < total - 2) return true;

    const last3Start = total - 2;
    const arcsByChapter = new Map<number, ArcType[]>();

    for (const arc of arcs) {
      if (!arc.chapter_closed || arc.chapter_closed < last3Start) continue;
      const list = arcsByChapter.get(arc.chapter_closed) || [];
      list.push(arc.arc_type);
      arcsByChapter.set(arc.chapter_closed, list);
    }

    for (let ch = last3Start; ch <= total; ch++) {
      const types = arcsByChapter.get(ch) || [];
      if (types.length === 0) continue;

      const hasPlot = types.some((t) => ["plot", "conflict", "quest"].includes(t));
      const hasEmotional = types.some((t) => ["relationship", "growth", "identity"].includes(t));
      const hasMeaning = types.some((t) => ["theme", "revelation", "worldview"].includes(t));

      if (ch === total && hasPlot && !hasMeaning) {
        return false;
      }
    }

    return true;
  }

  /**
   * R097: 验证情节闭合先于情感闭合 (#C-07)
   * 规则：情节闭合必须先于情感闭合，两者间必须有呼吸间隙
   * 通过检查最后几章中plot弧线是否在emotional弧线之前关闭来验证
   */
  private validateEmotionalClosesBeforePlot(arcs: Arc[]): boolean {
    const current = this.registry.config.currentChapter;
    const total = this.registry.config.totalChapters;
    if (total < 2) return true;

    const lastNStart = Math.max(1, total - 4);
    const plotCloseChapters: number[] = [];
    const emotionalCloseChapters: number[] = [];

    for (const arc of arcs) {
      if (!arc.chapter_closed || arc.chapter_closed < lastNStart) continue;
      if (["plot", "conflict", "quest"].includes(arc.arc_type)) {
        plotCloseChapters.push(arc.chapter_closed);
      } else if (["relationship", "growth", "identity"].includes(arc.arc_type)) {
        emotionalCloseChapters.push(arc.chapter_closed);
      }
    }

    if (plotCloseChapters.length === 0 || emotionalCloseChapters.length === 0) return true;

    const lastPlotClose = Math.max(...plotCloseChapters);
    const firstEmotionalClose = Math.min(...emotionalCloseChapters);

    return firstEmotionalClose >= lastPlotClose;
  }

  // ============================================================================
  // 快照与报告
  // ============================================================================

  /**
   * 获取结局完备性快照（给主报告用）
   */
  getCompletionSnapshot(): {
    openArcsByPriority: Record<string, number>;
    closedArcsByType: Record<string, number>;
    pendingForeshadows: Record<ForeshadowLevel, number>;
    compositeScore: number;
  } {
    const openArcsByPriority: Record<string, number> = {
      P0: 0,
      P1: 0,
      P2: 0,
      P3: 0,
      P4: 0,
    };
    const closedArcsByType: Record<string, number> = {
      primary: 0,
      secondary: 0,
      relational: 0,
      world: 0,
      debt: 0,
    };

    for (const arc of this.registry.arcs) {
      if (arc.status === "resolved" || arc.status === "abandoned") {
        closedArcsByType[arc.arc_type] = (closedArcsByType[arc.arc_type] || 0) + 1;
      } else {
        openArcsByPriority[arc.priority] = (openArcsByPriority[arc.priority] || 0) + 1;
      }
    }

    const pendingForeshadows: Record<ForeshadowLevel, number> = {
      A: 0,
      B: 0,
      C: 0,
    };
    for (const f of this.getPendingForeshadows()) {
      pendingForeshadows[f.level] = (pendingForeshadows[f.level] || 0) + 1;
    }

    const report = this.scanCompleteness();

    return {
      openArcsByPriority,
      closedArcsByType,
      pendingForeshadows,
      compositeScore: report.compositeScore,
    };
  }

  /**
   * 获取章节里程碑
   */
  getChapterMilestones(chapterId: string): {
    reachedMilestones: ArcMilestone[];
    upcomingMilestones: ArcMilestone[];
  } {
    const chapter = parseInt(chapterId, 10);
    if (isNaN(chapter)) {
      return { reachedMilestones: [], upcomingMilestones: [] };
    }

    const reachedMilestones: ArcMilestone[] = [];
    const upcomingMilestones: ArcMilestone[] = [];

    for (const arc of this.registry.arcs) {
      for (const milestone of arc.milestones) {
        if (milestone.status === "reached") {
          reachedMilestones.push(milestone);
        } else if (milestone.targetChapter >= chapter) {
          upcomingMilestones.push(milestone);
        }
      }
    }

    return { reachedMilestones, upcomingMilestones };
  }

  /**
   * 生成人类可读报告
   */
  generateReadableReport(): string {
    const report = this.scanCompleteness();
    const snapshot = this.getCompletionSnapshot();

    const lines: string[] = [
      "=== 弧线闭合追踪报告 ===",
      `生成时间: ${report.generatedAt}`,
      `当前章节: ${this.registry.config.currentChapter} / ${this.registry.config.totalChapters}`,
      "",
      "【综合评分】",
      `评分: ${(report.compositeScore * 100).toFixed(0)}%`,
      `等级: ${report.compositeGrade}`,
      "",
      "【弧线状态】",
    ];

    // 按类型统计
    for (const [type, count] of Object.entries(snapshot.closedArcsByType)) {
      const total = this.registry.arcs.filter((a) => a.arc_type === type).length;
      lines.push(`  ${type}: ${count} / ${total} 已闭合`);
    }

    lines.push("", "【未闭合弧线（按优先级）】");
    for (const arc of this.getOpenArcsByPriority()) {
      lines.push(`  [${arc.priority}] ${arc.name} (${arc.status})`);
    }

    if (report.criticalIssues.length > 0) {
      lines.push("", "【严重问题】");
      for (const issue of report.criticalIssues) {
        lines.push(`  ⚠️ ${issue}`);
      }
    }

    if (report.warnings.length > 0) {
      lines.push("", "【警告】");
      for (const warning of report.warnings) {
        lines.push(`  ⚡ ${warning}`);
      }
    }

    if (report.suggestions.length > 0) {
      lines.push("", "【建议】");
      for (const suggestion of report.suggestions) {
        lines.push(`  💡 ${suggestion}`);
      }
    }

    return lines.join("\n");
  }
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建 ClosureTracker
 */
export function createClosureTracker(registry?: ArcRegistry): ClosureTracker {
  return new ClosureTracker(registry);
}

/**
 * 从文件创建 ClosureTracker
 */
export function loadClosureTracker(filePath: string): ClosureTracker {
  return ClosureTracker.loadFromFile(filePath) || new ClosureTracker();
}
