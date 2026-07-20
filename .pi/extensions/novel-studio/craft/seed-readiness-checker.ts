/**
 * PiNovelStudio — SeedReadinessChecker
 *
 * P22：细节锚点先行生成链路
 *
 * 检查 ChapterSeed 是否有足够"可生长种子"以进入感知锚点搜索与 DAG 生长。
 *
 * 阻断条件围绕：
 *  - 世界观（worldConstraint）
 *  - 角色状态（characterState）
 *  - 前章承接（previousContinuation，第 2 章及以后必需）
 *  - 当前压力（currentPressure）
 *  - 候选感知锚点（candidateAnchors）
 *
 * 错误提示不得再要求"补章纲"。应提示补：
 *  - 角色状态 / 当前压力 / 未结账细节 / 世界约束 / 候选感知锚点
 */

import type {
  ChapterSeed,
  SeedReadinessReport,
  SeedReadinessDimensionReport,
  SeedReadinessStatus,
} from "./chapter-seed-types.js";

export interface SeedReadinessConfig {
  /** 综合评分阈值：>= ready 阈值则 ready，>= warning 阈值则 warning，否则 blocked */
  readyThreshold?: number;
  warningThreshold?: number;
  /** 各维度的最小充足数量 */
  minCharacters?: number;
  minCandidateAnchors?: number;
  minPendingPressureItems?: number;
}

const DEFAULT_CONFIG: Required<SeedReadinessConfig> = {
  readyThreshold: 70,
  warningThreshold: 50,
  minCharacters: 1,
  minCandidateAnchors: 2,
  minPendingPressureItems: 0, // 第 1 章允许没有压力项
};

export class SeedReadinessChecker {
  private readonly config: Required<SeedReadinessConfig>;

  constructor(config?: SeedReadinessConfig) {
    this.config = {
      readyThreshold: config?.readyThreshold ?? DEFAULT_CONFIG.readyThreshold,
      warningThreshold: config?.warningThreshold ?? DEFAULT_CONFIG.warningThreshold,
      minCharacters: config?.minCharacters ?? DEFAULT_CONFIG.minCharacters,
      minCandidateAnchors: config?.minCandidateAnchors ?? DEFAULT_CONFIG.minCandidateAnchors,
      minPendingPressureItems: config?.minPendingPressureItems ?? DEFAULT_CONFIG.minPendingPressureItems,
    };
  }

  /**
   * 检查 ChapterSeed 是否足够
   */
  check(seed: ChapterSeed): SeedReadinessReport {
    const dimensions: SeedReadinessDimensionReport[] = [];
    const warnings: string[] = [];
    const blockingReasons: string[] = [];

    // 维度1：世界约束
    dimensions.push(this.checkWorldConstraint(seed));

    // 维度2：角色状态
    dimensions.push(this.checkCharacterState(seed));

    // 维度3：前章承接（第 2 章及以后必需）
    dimensions.push(this.checkPreviousContinuation(seed));

    // 维度4：当前压力
    dimensions.push(this.checkCurrentPressure(seed));

    // 维度5：候选感知锚点
    dimensions.push(this.checkCandidateAnchors(seed));

    // 收集阻断原因
    for (const dim of dimensions) {
      if (!dim.sufficient) {
        blockingReasons.push(`【种子不足·${dim.dimension}】${dim.missing.join("; ")}`);
      }
    }

    // 收集警告
    for (const dim of dimensions) {
      for (const suggestion of dim.suggestions) {
        warnings.push(`【${dim.dimension}】${suggestion}`);
      }
    }

    // 综合评分
    const score = this.calculateScore(dimensions);

    // 状态判定
    let status: SeedReadinessStatus;
    const hasBlocking = blockingReasons.length > 0;

    if (hasBlocking) {
      status = "blocked";
    } else if (score >= this.config.readyThreshold) {
      status = "ready";
    } else if (score >= this.config.warningThreshold) {
      status = "warning";
    } else {
      status = "blocked";
    }

    const shouldBlockGeneration = status === "blocked";

    return {
      status,
      score,
      shouldBlockGeneration,
      dimensions,
      warnings,
      blockingReasons,
      source: "chapterSeed",
    };
  }

  private checkWorldConstraint(seed: ChapterSeed): SeedReadinessDimensionReport {
    const observed: string[] = [];
    const missing: string[] = [];
    const suggestions: string[] = [];

    const genre = seed.worldConstraint.genre;
    if (genre) {
      observed.push(`genre=${genre}`);
    } else {
      missing.push("缺少 genre 字段");
      suggestions.push("在 config.json 中添加 genre 字段（如 \"玄幻\"、\"都市\"、\"仙侠\" 等）");
    }

    if (seed.worldConstraint.subGenres.length > 0) {
      observed.push(`subGenres=${seed.worldConstraint.subGenres.join("/")}`);
    } else {
      // subGenres 缺失只警告，不阻断
      suggestions.push("建议在 config.json 中添加 subGenres 字段以丰富世界观");
    }

    const sufficient = Boolean(genre);
    return {
      dimension: "worldConstraint",
      sufficient,
      observed,
      missing,
      suggestions: sufficient ? [] : suggestions,
    };
  }

  private checkCharacterState(seed: ChapterSeed): SeedReadinessDimensionReport {
    const observed: string[] = [];
    const missing: string[] = [];
    const suggestions: string[] = [];

    const count = seed.characters.length;
    if (count >= this.config.minCharacters) {
      observed.push(`characters=${count}（${seed.characters.slice(0, 3).map(c => c.name).join(", ")}）`);
    } else {
      missing.push(`角色状态不足（${count} < ${this.config.minCharacters}）`);
      suggestions.push("补充角色档案：在 characters/ 目录下创建角色 .md 文件，或在 config.json.characters 中注册角色");
    }

    const sufficient = count >= this.config.minCharacters;
    return {
      dimension: "characterState",
      sufficient,
      observed,
      missing,
      suggestions: sufficient ? [] : suggestions,
    };
  }

  private checkPreviousContinuation(seed: ChapterSeed): SeedReadinessDimensionReport {
    const observed: string[] = [];
    const missing: string[] = [];
    const suggestions: string[] = [];

    if (seed.chapterNumber === 1) {
      // 第 1 章不需要前章承接
      observed.push("第1章无需前章承接");
      return {
        dimension: "previousContinuation",
        sufficient: true,
        observed,
        missing,
        suggestions: [],
      };
    }

    if (seed.previousChapterContinuation.available) {
      observed.push("前章 skeleton 已加载");
      if (seed.previousChapterContinuation.lastEventSummary) {
        observed.push(`lastEvent=${seed.previousChapterContinuation.lastEventSummary.slice(0, 30)}`);
      }
      if (seed.previousChapterContinuation.endingEmotion) {
        observed.push(`endingEmotion=${seed.previousChapterContinuation.endingEmotion}`);
      }
      return {
        dimension: "previousContinuation",
        sufficient: true,
        observed,
        missing,
        suggestions: [],
      };
    }

    missing.push(`第${seed.chapterNumber}章缺少前章 skeleton.json`);
    suggestions.push(`先生成章节 ${seed.chapterNumber - 1}，或从其他工作区复制 skeleton.json 到 series/skeleton.json`);
    return {
      dimension: "previousContinuation",
      sufficient: false,
      observed,
      missing,
      suggestions,
    };
  }

  private checkCurrentPressure(seed: ChapterSeed): SeedReadinessDimensionReport {
    const observed: string[] = [];
    const missing: string[] = [];
    const suggestions: string[] = [];

    const pendingItems =
      seed.currentPressure.pendingForeshadowing.length +
      seed.currentPressure.openArcs.length +
      seed.currentPressure.pendingCosts.length;

    if (pendingItems > 0) {
      observed.push(
        `pendingForeshadowing=${seed.currentPressure.pendingForeshadowing.length}`,
        `openArcs=${seed.currentPressure.openArcs.length}`,
        `pendingCosts=${seed.currentPressure.pendingCosts.length}`
      );
    } else {
      // 第 1 章允许没有压力项；第 2 章及以后若完全没有压力项，只警告不阻断
      if (seed.chapterNumber > 1) {
        suggestions.push("当前压力为空，建议补充未结账细节、待回收伏笔或未解张力以驱动本章推进");
      } else {
        observed.push("第1章允许无历史压力项");
      }
    }

    // 当前压力维度不作为硬阻断条件（除非配置了 minPendingPressureItems > 0）
    const sufficient = pendingItems >= this.config.minPendingPressureItems;
    return {
      dimension: "currentPressure",
      sufficient,
      observed,
      missing,
      suggestions: sufficient ? [] : suggestions,
    };
  }

  private checkCandidateAnchors(seed: ChapterSeed): SeedReadinessDimensionReport {
    const observed: string[] = [];
    const missing: string[] = [];
    const suggestions: string[] = [];

    // P22修复：第1章（setup 开端）没有前章上下文，候选锚点天然为空是正常的。
    // 第1章自身创建锚点，不应因候选锚点不足而阻断生成。
    if (seed.chapterNumber === 1) {
      observed.push("第1章无需历史候选锚点（本章自建锚点）");
      return {
        dimension: "candidateAnchors",
        sufficient: true,
        observed,
        missing,
        suggestions: [],
      };
    }

    const count = seed.candidateAnchors.length;
    if (count >= this.config.minCandidateAnchors) {
      observed.push(`candidateAnchors=${count}`);
      if (count > 0) {
        observed.push(`topAnchor=${seed.candidateAnchors[0].description.slice(0, 30)}`);
      }
    } else {
      missing.push(`候选感知锚点不足（${count} < ${this.config.minCandidateAnchors}）`);
      suggestions.push("补充候选感知锚点：检查未结账细节（unsettled-details.json）、待回收伏笔（arc-registry.json）、前章未解张力或角色状态");
    }

    const sufficient = count >= this.config.minCandidateAnchors;
    return {
      dimension: "candidateAnchors",
      sufficient,
      observed,
      missing,
      suggestions: sufficient ? [] : suggestions,
    };
  }

  private calculateScore(dimensions: SeedReadinessDimensionReport[]): number {
    // 各维度权重
    const weights: Record<string, number> = {
      worldConstraint: 25,
      characterState: 20,
      previousContinuation: 25,
      currentPressure: 15,
      candidateAnchors: 15,
    };

    let score = 0;
    for (const dim of dimensions) {
      const weight = weights[dim.dimension] ?? 0;
      if (dim.sufficient) {
        score += weight;
      } else {
        // 不充足时给部分分（基于 observed 数量）
        const partial = Math.min(weight * 0.3, weight * (dim.observed.length / 3));
        score += partial;
      }
    }

    return Math.round(Math.min(100, Math.max(0, score)));
  }
}

/**
 * 创建 SeedReadinessChecker 实例
 */
export function createSeedReadinessChecker(config?: SeedReadinessConfig): SeedReadinessChecker {
  return new SeedReadinessChecker(config);
}

/**
 * 格式化 SeedReadiness 阻断消息
 *
 * 注意：错误提示不得再要求"补章纲"。应提示补：
 *  - 角色状态 / 当前压力 / 未结账细节 / 世界约束 / 候选感知锚点
 */
export function formatSeedReadinessBlockMessage(report: SeedReadinessReport): string {
  const lines: string[] = [];
  lines.push("【阶段0生产阻断】ChapterSeed 种子不足，无法进入感知锚点搜索与 DAG 生长。");
  lines.push(`综合评分：${report.score}/100（${report.status}）`);
  lines.push("");
  lines.push("阻断原因：");
  for (const reason of report.blockingReasons) {
    lines.push(`  - ${reason}`);
  }
  lines.push("");
  lines.push("请补充以下种子源（不要补章纲，章纲已不再是写前蓝图）：");

  const suggestionMap: Record<string, string> = {
    worldConstraint: "世界约束：在 config.json 中补充 genre / subGenres / immutableFacts",
    characterState: "角色状态：在 characters/ 下创建角色档案，或在 config.json.characters 中注册角色",
    previousContinuation: "前章承接：先生成前一章，或将前章 skeleton.json 复制到 series/skeleton.json",
    currentPressure: "当前压力：补充未结账细节（unsettled-details.json）、待回收伏笔（arc-registry.json）或角色未解张力",
    candidateAnchors: "候选感知锚点：补充未结账细节、待回收伏笔、前章未解张力或角色状态以生成锚点",
  };

  for (const dim of report.dimensions) {
    if (!dim.sufficient) {
      const hint = suggestionMap[dim.dimension] || dim.suggestions.join("; ");
      lines.push(`  - ${hint}`);
    }
  }

  if (report.warnings.length > 0) {
    lines.push("");
    lines.push("警告：");
    for (const w of report.warnings) {
      lines.push(`  - ${w}`);
    }
  }

  return lines.join("\n");
}
