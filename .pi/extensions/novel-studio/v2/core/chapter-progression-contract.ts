/**
 * chapter-progression-contract — 持久化章节推进契约（PROGRESSION-CONTRACT-1）
 *
 * 职责：在最终正文选定 + 状态提交 + 桥接完成后，把本章的"预期推进轴"和
 * "实际推进轴"持久化到 workspaces/{id}/series/chapter-progression-contracts.json，
 * 供下游诊断层（MethodologyDiagnosticState）读取跨章推进 delta。
 *
 * 设计原则（计划 §4.2 + advisory-only）：
 * - 只读 advisory：不进入 raw prompt，不阻断生成，不决定文学胜负
 * - 从 ChapterIntent + StructuralEvidence 派生，不机器生成新字段
 * - 与 narrative-state-store.json 同事务（在 FinalStateCommit + 桥接后写入）
 * - 失败不阻断主链路（只 warning + trace）
 *
 * 5 维推进轴（与 structural-evidence-scanner.ts 的 five_axis_progression 对齐）：
 * - plot：情节推进（intent.primary=reversal 或 chapterFunction=payoff）
 * - info：信息释放（intent.primary=foreshadow 或 secondary 含 revelation）
 * - character：角色发展（intent.primary=character 或 chapterFunction=setup）
 * - world：世界观推进（intent.primary=setting）
 * - causal：因果推进（intent.causalEndPressure 非空）
 *
 * 跨章 delta（与前一章 contract 对比）：
 * - newOpenArcs：本章新开的弧线 id（来自 stagedStateUpdate.expectation.relatedArcIds）
 * - advancedArcs：本章推进的弧线 id（来自 stagedStateUpdate.expectation，status=advanced）
 * - closedArcs：本章关闭的弧线 id（来自 stagedStateUpdate.expectation，status=fulfilled）
 *
 * 复核信号（advisory）：
 * - expected=true 但 actual=false 的维度（预期推进但实际未推进）
 * - StructuralEvidence.status=risk 的维度
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import type { ChapterIntent } from "./chapter-intent-builder.js";
import type { StructuralEvidence } from "./chapter-quality-evidence.js";
import type { StagedStateUpdate, ExpectationEntry } from "./final-state-commit.js";

// ============================================================================
// 数据契约
// ============================================================================

export interface ProgressionAxes {
  plot: boolean;
  info: boolean;
  character: boolean;
  world: boolean;
  causal: boolean;
}

export interface CrossChapterDelta {
  /** 本章新开的弧线 id（expectation.relatedArcIds 中前一章 contract 未出现的） */
  newOpenArcs: string[];
  /** 本章推进的弧线 id（expectation.status=advanced/delayed/escalated） */
  advancedArcs: string[];
  /** 本章关闭的弧线 id（expectation.status=fulfilled） */
  closedArcs: string[];
}

export interface ReviewSignal {
  dimension: string;
  reason: string;
  sourceRef?: string;
}

export interface ChapterProgressionContract {
  chapterNumber: number;
  chapterId: string;
  /** 预期推进轴（从 ChapterIntent + chapterFunction 派生） */
  expectedAxes: ProgressionAxes;
  /** 实际推进轴（从 StructuralEvidence.five_axis_progression 派生） */
  actualAxes: ProgressionAxes;
  /** 跨章 delta（与前一章 contract 对比） */
  crossChapterDelta: CrossChapterDelta;
  /** 复核信号（advisory，预期但未推进 / risk 维度） */
  reviewSignals: ReviewSignal[];
  /** finalText SHA-256 前 12 位（可追溯） */
  finalTextHash: string;
  sourceChapter: string;
  lastUpdated: string;
}

export interface ChapterProgressionContractStore {
  schemaVersion: number;
  workspaceId: string;
  contracts: ChapterProgressionContract[];
  lastUpdated: string;
}

// ============================================================================
// 派生函数
// ============================================================================

/**
 * 从 ChapterIntent 派生预期推进轴。
 *
 * ChapterIntent（chapter-intent-builder.ts）字段映射：
 * - chapterFunction：setup/escalation/payoff/climax → 派生 plot/character 维度
 * - readerExperience：目标读者体验（含情绪/信息释放等） → 派生 info/character 维度
 * - causalEndPressure：因果章末压力 → 派生 causal 维度
 * - selectedPromisesToAdvance：本章推进的承诺 → 派生 plot/info 维度
 * - expectedIrreversibleChange：不可逆变化 → 派生 character/plot 维度
 *
 * 保守策略（advisory，不阻断）：
 * - plot=true 当 chapterFunction=payoff/climax 或有 selectedPromisesToAdvance
 * - info=true 当 chapterFunction=escalation 或有 causalEndPressure 含"揭露/真相/发现"
 * - character=true 当 chapterFunction=setup 或有 expectedIrreversibleChange
 * - world=true 当 readerExperience 含"世界观/规则/势力"
 * - causal=true 当 causalEndPressure 非空
 */
export function deriveExpectedAxes(
  intent: ChapterIntent,
): ProgressionAxes {
  const chapterFunction = (intent.chapterFunction ?? "").toLowerCase();
  const readerExperience = (intent.readerExperience ?? []).join(" ").toLowerCase();
  const causalEndPressure = intent.causalEndPressure ?? [];
  const selectedPromises = intent.selectedPromisesToAdvance ?? [];
  const irreversibleChanges = intent.expectedIrreversibleChange ?? [];

  const hasInfoKeywords = /揭露|真相|发现|明白|意识|秘密|revealed|disclosed/.test(readerExperience);
  const hasWorldKeywords = /世界观|规则|势力|门派|家族|境界|world|rule/.test(readerExperience);

  return {
    plot: chapterFunction === "payoff" || chapterFunction === "climax" || selectedPromises.length > 0,
    info: chapterFunction === "escalation" || hasInfoKeywords,
    character: chapterFunction === "setup" || irreversibleChanges.length > 0,
    world: hasWorldKeywords,
    causal: causalEndPressure.length > 0,
  };
}

/**
 * 从 StructuralEvidence 列表派生实际推进轴。
 *
 * 查找 dimension=five_axis_progression 的 evidence，从其 observation 解析轴名。
 * 保守策略：只识别明确有 span 证据的轴（status=partial/satisfied）。
 */
export function deriveActualAxes(
  structuralEvidence: StructuralEvidence[],
): ProgressionAxes {
  const axes: ProgressionAxes = {
    plot: false,
    info: false,
    character: false,
    world: false,
    causal: false,
  };

  for (const e of structuralEvidence) {
    if (e.dimension !== "five_axis_progression") continue;
    if (e.status !== "partial" && e.status !== "satisfied") continue;
    // observation 中可能包含轴名（如 "情节推进"、"信息释放"）
    const obs = e.observation ?? "";
    if (obs.includes("情节") || obs.includes("plot")) axes.plot = true;
    if (obs.includes("信息") || obs.includes("info")) axes.info = true;
    if (obs.includes("角色") || obs.includes("character")) axes.character = true;
    if (obs.includes("世界") || obs.includes("world")) axes.world = true;
    if (obs.includes("因果") || obs.includes("causal")) axes.causal = true;
  }

  return axes;
}

/**
 * 计算跨章 delta（与前一章 contract 对比）。
 *
 * - newOpenArcs：本章 expectation.relatedArcIds 中前一章 contract 未出现的
 * - advancedArcs：本章 expectation.status=advanced/delayed/escalated 的 relatedArcIds
 * - closedArcs：本章 expectation.status=fulfilled 的 relatedArcIds
 */
export function computeCrossChapterDelta(
  staged: StagedStateUpdate,
  previousContract: ChapterProgressionContract | null,
): CrossChapterDelta {
  const expectationEntries = staged.additions.filter(
    (e): e is ExpectationEntry => e.kind === "expectation",
  );

  const allArcIds = new Set<string>();
  const advancedArcs = new Set<string>();
  const closedArcs = new Set<string>();

  for (const exp of expectationEntries) {
    const arcIds = exp.relatedArcIds ?? [];
    for (const arcId of arcIds) {
      allArcIds.add(arcId);
      if (exp.status === "advanced" || exp.status === "delayed" || exp.status === "escalated") {
        advancedArcs.add(arcId);
      }
      if (exp.status === "fulfilled") {
        closedArcs.add(arcId);
      }
    }
  }

  const previousArcIds = new Set<string>(
    (previousContract?.crossChapterDelta.newOpenArcs ?? [])
      .concat(previousContract?.crossChapterDelta.advancedArcs ?? [])
      .concat(previousContract?.crossChapterDelta.closedArcs ?? []),
  );

  const newOpenArcs = Array.from(allArcIds).filter((id) => !previousArcIds.has(id));

  return {
    newOpenArcs,
    advancedArcs: Array.from(advancedArcs),
    closedArcs: Array.from(closedArcs),
  };
}

/**
 * 派生复核信号（advisory）。
 *
 * - 预期但未推进的维度（expected=true, actual=false）
 * - StructuralEvidence.status=risk 的维度
 */
export function deriveReviewSignals(
  expected: ProgressionAxes,
  actual: ProgressionAxes,
  structuralEvidence: StructuralEvidence[],
): ReviewSignal[] {
  const signals: ReviewSignal[] = [];

  const axisNames: Array<keyof ProgressionAxes> = ["plot", "info", "character", "world", "causal"];
  for (const axis of axisNames) {
    if (expected[axis] && !actual[axis]) {
      signals.push({
        dimension: `five_axis_progression.${axis}`,
        reason: `预期推进 ${axis} 轴但正文未找到 span 证据（advisory，需 LLM/人工复核）`,
      });
    }
  }

  for (const e of structuralEvidence) {
    if (e.status === "risk") {
      signals.push({
        dimension: e.dimension,
        reason: e.observation,
        sourceRef: e.sourceSpans[0]
          ? `${e.sourceSpans[0].start}-${e.sourceSpans[0].end}`
          : undefined,
      });
    }
  }

  return signals;
}

// ============================================================================
// 持久化
// ============================================================================

/**
 * 持久化 ChapterProgressionContract 到
 * workspaces/{id}/series/chapter-progression-contracts.json。
 *
 * 事务策略：
 * - 读取 existing store（如有）
 * - 追加或替换本章 contract（按 chapterNumber 索引）
 * - 原子写入（tmp → rename）
 * - 失败不阻断主链路（只 warning + trace）
 *
 * @returns 写入的 contract 与 ok 状态
 */
export function persistChapterProgressionContract(
  workspacePath: string,
  workspaceId: string,
  chapterNumber: number,
  chapterId: string,
  intent: ChapterIntent,
  structuralEvidence: StructuralEvidence[],
  staged: StagedStateUpdate,
  finalTextHash: string,
): { ok: boolean; error?: string; contract: ChapterProgressionContract | null } {
  const contractsPath = join(workspacePath, "series", "chapter-progression-contracts.json");

  // 读取 existing store
  let store: ChapterProgressionContractStore;
  try {
    if (existsSync(contractsPath)) {
      const raw = readFileSync(contractsPath, "utf-8");
      const parsed = JSON.parse(raw) as ChapterProgressionContractStore;
      store = {
        schemaVersion: 1,
        workspaceId,
        contracts: Array.isArray(parsed.contracts) ? parsed.contracts : [],
        lastUpdated: parsed.lastUpdated ?? "",
      };
    } else {
      store = { schemaVersion: 1, workspaceId, contracts: [], lastUpdated: "" };
    }
  } catch {
    store = { schemaVersion: 1, workspaceId, contracts: [], lastUpdated: "" };
  }

  // 找前一章 contract（chapterNumber - 1）
  const previousContract =
    store.contracts.find((c) => c.chapterNumber === chapterNumber - 1) ?? null;

  // 派生本章 contract
  const expectedAxes = deriveExpectedAxes(intent);
  const actualAxes = deriveActualAxes(structuralEvidence);
  const crossChapterDelta = computeCrossChapterDelta(staged, previousContract);
  const reviewSignals = deriveReviewSignals(expectedAxes, actualAxes, structuralEvidence);

  const now = new Date().toISOString();
  const contract: ChapterProgressionContract = {
    chapterNumber,
    chapterId,
    expectedAxes,
    actualAxes,
    crossChapterDelta,
    reviewSignals,
    finalTextHash,
    sourceChapter: `ch${chapterNumber}`,
    lastUpdated: now,
  };

  // 替换或追加本章 contract
  const existingIdx = store.contracts.findIndex((c) => c.chapterNumber === chapterNumber);
  if (existingIdx >= 0) {
    store.contracts[existingIdx] = contract;
  } else {
    store.contracts.push(contract);
  }
  // 按 chapterNumber 排序（便于读取）
  store.contracts.sort((a, b) => a.chapterNumber - b.chapterNumber);
  store.lastUpdated = now;

  // 原子写入
  try {
    const dir = dirname(contractsPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const tmpPath = `${contractsPath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(store, null, 2), "utf-8");
    renameSync(tmpPath, contractsPath);
    return { ok: true, contract };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg, contract };
  }
}
