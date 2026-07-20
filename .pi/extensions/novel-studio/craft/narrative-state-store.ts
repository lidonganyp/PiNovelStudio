/**
 * PiNovelStudio — 叙事状态存储工具
 *
 * 负责 NarrativeState 的读取、合并、持久化操作
 *
 * P2-G 说明:
 * 叙事状态累积机制设计：
 * - 首次运行：使用默认状态（心智值=80%，未解决悬念=0）
 * - 每章运行后：saveNarrativeState()将状态变化写入文件
 * - 后续章节：loadNarrativeState()加载已有状态并应用变化
 *
 * 限制：第1章无法从状态系统获益，因为还没有历史数据
 * 解决方案：前几章运行后，状态会逐渐累积，第N章可受益于前N-1章的变化
 */

import type {
  NarrativeState,
  ReaderExpectation,
  RelationshipEntry,
  RelationshipState,
  HorrorFatigue,
  HorrorTechnique,
  RuleExposureEntry,
  RuleExposureStatus,
  CostEntry,
  ProtagonistCostLedger,
  StateChangeResult,
  AbilityCostResult,
  MentalityChangeResult,
  HorrorTechniqueResult,
  ForeshadowingUpdateResult,
  WorldRuleExposureResult,
} from "../dag/types.js";

export function createDefaultNarrativeState(chapter: number = 1): NarrativeState {
  return {
    currentChapter: chapter,
    readerExpectation: {
      unresolvedCount: 0,
      lastPayoffChapter: 0,
      lastPeakMoment: "",
      chaptersSinceLastPeak: 0,
    },
    relationshipTemperature: {},
    horrorFatigue: {
      recentTechniques: [],
      consecutiveSameTechnique: 0,
    },
    worldRuleExposure: {},
    protagonistCostLedger: {
      pendingCosts: [],
      mentalityTrend: [80],
    },
    lastAnchorChapter: 0,
    lastAnchorName: "",
  };
}

const RELATIONSHIP_STATES = new Set<RelationshipState>([
  "warming",
  "stable",
  "cooling",
  "broken",
]);

const HORROR_TECHNIQUES = new Set<HorrorTechnique>([
  "spatial_distortion",
  "familiar_becomes_monster",
  "unknown_rule",
  "countdown_pressure",
  "sensory_horror",
  "isolation",
  "body_horror",
]);

const RULE_EXPOSURE_STATUSES = new Set<RuleExposureStatus>([
  "hidden",
  "hinted",
  "revealed",
  "weaponized",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function normalizeMentalityTrend(value: unknown, fallback: number[]): number[] {
  if (!Array.isArray(value)) return [...fallback];
  const trend = value
    .filter((item): item is number => typeof item === "number" && Number.isFinite(item))
    .map((item) => Math.max(0, Math.min(100, item)))
    .slice(-10);
  return trend.length > 0 ? trend : [...fallback];
}

function normalizeCosts(value: unknown): CostEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    if (!record) return [];
    return [{
      action: asString(record.action, ""),
      cost: asString(record.cost, ""),
      chapterIncurred: asNumber(record.chapterIncurred, 0),
      resolved: typeof record.resolved === "boolean" ? record.resolved : false,
    }];
  });
}

function normalizeReaderExpectation(
  value: unknown,
  fallback: ReaderExpectation
): ReaderExpectation {
  const record = asRecord(value);
  if (!record) return { ...fallback };
  return {
    unresolvedCount: asNumber(record.unresolvedCount, fallback.unresolvedCount),
    lastPayoffChapter: asNumber(record.lastPayoffChapter, fallback.lastPayoffChapter),
    lastPeakMoment: asString(record.lastPeakMoment, fallback.lastPeakMoment),
    chaptersSinceLastPeak: asNumber(record.chaptersSinceLastPeak, fallback.chaptersSinceLastPeak),
  };
}

function normalizeRelationshipTemperature(value: unknown): Record<string, RelationshipEntry> {
  const record = asRecord(value);
  if (!record) return {};

  const normalized: Record<string, RelationshipEntry> = {};
  for (const [pair, entryValue] of Object.entries(record)) {
    const entry = asRecord(entryValue);
    if (!entry) continue;
    const state = typeof entry.state === "string" && RELATIONSHIP_STATES.has(entry.state as RelationshipState)
      ? entry.state as RelationshipState
      : "stable";
    normalized[pair] = {
      state,
      lastInteractionChapter: asNumber(entry.lastInteractionChapter, 0),
      pendingTension: typeof entry.pendingTension === "string" ? entry.pendingTension : null,
    };
  }
  return normalized;
}

function normalizeHorrorFatigue(value: unknown, fallback: HorrorFatigue): HorrorFatigue {
  const record = asRecord(value);
  if (!record) return {
    recentTechniques: [...fallback.recentTechniques],
    consecutiveSameTechnique: fallback.consecutiveSameTechnique,
  };

  const recentTechniques = Array.isArray(record.recentTechniques)
    ? record.recentTechniques
        .filter((item): item is HorrorTechnique =>
          typeof item === "string" && HORROR_TECHNIQUES.has(item as HorrorTechnique)
        )
        .slice(-10)
    : [...fallback.recentTechniques];

  return {
    recentTechniques,
    consecutiveSameTechnique: asNumber(
      record.consecutiveSameTechnique,
      fallback.consecutiveSameTechnique
    ),
  };
}

function normalizeWorldRuleExposure(value: unknown): Record<string, RuleExposureEntry> {
  const record = asRecord(value);
  if (!record) return {};

  const normalized: Record<string, RuleExposureEntry> = {};
  for (const [key, entryValue] of Object.entries(record)) {
    const entry = asRecord(entryValue);
    if (!entry) continue;
    const status = typeof entry.status === "string" && RULE_EXPOSURE_STATUSES.has(entry.status as RuleExposureStatus)
      ? entry.status as RuleExposureStatus
      : "hidden";
    normalized[key] = {
      ruleKey: asString(entry.ruleKey, key),
      description: asString(entry.description, key),
      status,
      chaptersSinceRevealed: asNumber(entry.chaptersSinceRevealed, -1),
    };
  }
  return normalized;
}

function normalizeProtagonistCostLedger(
  value: unknown,
  fallback: ProtagonistCostLedger
): ProtagonistCostLedger {
  const record = asRecord(value);
  if (!record) return {
    pendingCosts: [...fallback.pendingCosts],
    mentalityTrend: [...fallback.mentalityTrend],
  };

  return {
    pendingCosts: normalizeCosts(record.pendingCosts),
    mentalityTrend: normalizeMentalityTrend(record.mentalityTrend, fallback.mentalityTrend),
  };
}

export function normalizeNarrativeState(
  value: unknown,
  currentChapter: number = 1
): NarrativeState {
  const fallback = createDefaultNarrativeState(currentChapter);
  const record = asRecord(value);
  if (!record) return fallback;

  return {
    currentChapter,
    readerExpectation: normalizeReaderExpectation(record.readerExpectation, fallback.readerExpectation),
    relationshipTemperature: normalizeRelationshipTemperature(record.relationshipTemperature),
    horrorFatigue: normalizeHorrorFatigue(record.horrorFatigue, fallback.horrorFatigue),
    worldRuleExposure: normalizeWorldRuleExposure(record.worldRuleExposure),
    protagonistCostLedger: normalizeProtagonistCostLedger(
      record.protagonistCostLedger,
      fallback.protagonistCostLedger
    ),
    lastAnchorChapter: asNumber(record.lastAnchorChapter, fallback.lastAnchorChapter),
    lastAnchorName: asString(record.lastAnchorName, fallback.lastAnchorName),
  };
}

export function applyStateChanges(
  state: NarrativeState,
  changes: StateChangeResult[],
  chapterNumber: number
): NarrativeState {
  const updated = normalizeNarrativeState(state, chapterNumber);
  updated.currentChapter = chapterNumber;

  for (const change of changes) {
    if (!change.triggered) continue;

    switch (change.task) {
      case 'ability_cost':
        applyAbilityCost(updated, change);
        break;
      case 'mentality_change':
        applyMentalityChange(updated, change);
        break;
      case 'horror_technique':
        applyHorrorTechnique(updated, change);
        break;
      case 'foreshadowing_update':
        applyForeshadowingUpdate(updated, change, chapterNumber);
        break;
      case 'world_rule_exposure':
        applyWorldRuleExposure(updated, change, chapterNumber);
        break;
    }
  }

  return updated;
}

function applyAbilityCost(state: NarrativeState, change: AbilityCostResult): void {
  for (const entry of change.entries) {
    state.protagonistCostLedger.pendingCosts.push({
      action: entry.action,
      cost: entry.cost,
      chapterIncurred: entry.chapterIncurred,
      resolved: entry.resolved,
    });
  }
}

function applyMentalityChange(state: NarrativeState, change: MentalityChangeResult): void {
  const deltaMatch = change.delta.match(/-?\d+/);
  if (deltaMatch) {
    const delta = parseInt(deltaMatch[0], 10);
    const lastMentality = state.protagonistCostLedger.mentalityTrend[
      state.protagonistCostLedger.mentalityTrend.length - 1
    ] ?? 80;
    const newMentality = Math.max(0, Math.min(100, lastMentality + delta));
    state.protagonistCostLedger.mentalityTrend.push(newMentality);
    if (state.protagonistCostLedger.mentalityTrend.length > 10) {
      state.protagonistCostLedger.mentalityTrend =
        state.protagonistCostLedger.mentalityTrend.slice(-10);
    }
  }
}

function applyHorrorTechnique(state: NarrativeState, change: HorrorTechniqueResult): void {
  const techniques = change.techniques;
  if (techniques.length === 0) return;

  state.horrorFatigue.recentTechniques.push(...techniques);
  if (state.horrorFatigue.recentTechniques.length > 10) {
    state.horrorFatigue.recentTechniques = state.horrorFatigue.recentTechniques.slice(-10);
  }

  const lastRecent = state.horrorFatigue.recentTechniques.slice(-2);
  if (
    lastRecent.length === 2 &&
    lastRecent[0] === lastRecent[1]
  ) {
    state.horrorFatigue.consecutiveSameTechnique++;
  } else {
    state.horrorFatigue.consecutiveSameTechnique = 1;
  }
}

function applyForeshadowingUpdate(
  state: NarrativeState,
  change: ForeshadowingUpdateResult,
  chapterNumber: number
): void {
  for (const entry of change.entries) {
    if (entry.action === 'resolved') {
      state.readerExpectation.unresolvedCount = Math.max(
        0,
        state.readerExpectation.unresolvedCount - 1
      );
      state.readerExpectation.lastPayoffChapter = chapterNumber;
    } else if (entry.action === 'hinted' || entry.action === 'advanced') {
      state.readerExpectation.unresolvedCount++;
    }
  }
}

function applyWorldRuleExposure(
  state: NarrativeState,
  change: WorldRuleExposureResult,
  chapterNumber: number
): void {
  for (const entry of change.entries) {
    const existing = state.worldRuleExposure[entry.rule];
    if (existing) {
      existing.status = entry.newStatus as RuleExposureEntry['status'];
      if (entry.newStatus === 'revealed' || entry.newStatus === 'weaponized') {
        existing.chaptersSinceRevealed = chapterNumber - (existing as { chaptersSinceRevealed: number }).chaptersSinceRevealed;
      }
    } else {
      state.worldRuleExposure[entry.rule] = {
        ruleKey: entry.rule,
        description: entry.rule,
        status: entry.newStatus as RuleExposureEntry['status'],
        chaptersSinceRevealed: entry.newStatus === 'revealed' ? 0 : -1,
      };
    }
  }
}

export function getTrend(trend: number[]): string {
  if (trend.length < 2) return '稳定';
  const last = trend[trend.length - 1];
  const prev = trend[trend.length - 2];
  if (last > prev + 5) return '↗ 上升';
  if (last < prev - 5) return '↘ 下降';
  return '→ 稳定';
}

export function formatCosts(costs: CostEntry[]): string {
  if (costs.length === 0) return '';
  return costs
    .filter((c) => !c.resolved)
    .map((c) => `${c.action}(${c.cost})`)
    .join('、');
}

export function formatRelationshipWarnings(
  temperature: Record<string, RelationshipEntry>,
  currentChapter: number
): string {
  const warnings: string[] = [];
  for (const [pair, entry] of Object.entries(temperature)) {
    if (entry.state === 'cooling' && currentChapter - entry.lastInteractionChapter > 3) {
      warnings.push(`  ⚠️ ${pair}: 关系冷却超过3章，需修复信号或裂变节点`);
    }
    if (entry.state === 'broken') {
      warnings.push(`  ⚠️ ${pair}: 关系已破裂，需处理`);
    }
  }
  return warnings.join('\n');
}

export function getRevealedUnweaponized(
  exposure: Record<string, RuleExposureEntry>
): string[] {
  return Object.values(exposure)
    .filter((e) => e.status === 'revealed')
    .map((e) => e.description);
}

export function hasUrgentRule(
  exposure: Record<string, RuleExposureEntry>
): boolean {
  return Object.values(exposure).some(
    (e) => e.status === 'revealed' && e.chaptersSinceRevealed >= 3
  );
}

export function buildNarrativeStateBlock(
  state: NarrativeState,
  currentChapter: number
): string {
  const mentality = state.protagonistCostLedger.mentalityTrend[
    state.protagonistCostLedger.mentalityTrend.length - 1
  ] ?? 80;

  const lines: string[] = [
    '',
    '【叙事状态·强制锚定】',
    '压力维度:',
    `  主角心智值: ${mentality}%（趋势: ${getTrend(state.protagonistCostLedger.mentalityTrend)}）`,
    `  待偿代价: ${formatCosts(state.protagonistCostLedger.pendingCosts) || '无'}`,
    '',
    '读者期待:',
    `  距上次悬念释放: ${state.readerExpectation.chaptersSinceLastPeak} 章`,
    `  未解决悬念数: ${state.readerExpectation.unresolvedCount}`,
    state.readerExpectation.unresolvedCount > 2
      ? '  ⚠️ 本章必须释放至少一个悬念'
      : '',
    state.readerExpectation.chaptersSinceLastPeak > 3
      ? '  ⚠️ 距上次悬念释放已超3章，读者期待张力需要释放'
      : '',
    '',
    '情感温度:',
    `  上次情感锚点: 第 ${state.lastAnchorChapter} 章（距今 ${currentChapter - state.lastAnchorChapter} 章）`,
    currentChapter - state.lastAnchorChapter > 3
      ? '  ⚠️ 本章必须出现情感锚点'
      : '',
    formatRelationshipWarnings(state.relationshipTemperature, currentChapter),
    '',
    '规则状态:',
    `  已曝光待武器化: ${getRevealedUnweaponized(state.worldRuleExposure).join('、') || '无'}`,
    hasUrgentRule(state.worldRuleExposure)
      ? '  ⚠️ 以下规律曝光超期，本章需 weaponize'
      : '',
  ];

  if (state.horrorFatigue.consecutiveSameTechnique >= 2) {
    lines.push('');
    lines.push('恐怖手法:');
    lines.push(`  ⚠️ 手法重复（${state.horrorFatigue.recentTechniques.slice(-1)[0]}），强制切换`);
  }

  return lines.filter(Boolean).join('\n');
}
