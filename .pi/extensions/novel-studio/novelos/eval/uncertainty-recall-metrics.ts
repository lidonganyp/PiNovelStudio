/**
 * uncertainty-recall-metrics.ts — 不确定性驱动检索实验的召回率指标纯函数模块
 *
 * 从 uncertainty-driven-ablation.ts 拆分（主文件已超 800 行限制）。
 *
 * 本模块解决 Step 1 的两个评测指标 bug：
 * 1. INVALID_REFS 黑名单漏掉 voice:profile_only:degraded，导致非 confirmed 证据被误算
 * 2. avgRecall 在 A/B 两组 sourceRefsCount 都为 0 时返回 0，passCriteria 误判为通过
 *
 * 修复策略：
 * - 用 VALID_EVIDENCE_LEVELS 白名单只接受 confirmed/confirmed_state/exact_chapter_span
 * - 按 mustVerify 项逐个计算 confirmed 覆盖率（而非总数比）
 * - recallNotWorse 改三态（pass/fail/unmeasured），无有效证据时标 unmeasured
 *
 * 对齐 tool-protocol.ts EvidenceLevel 定义：
 * confirmed > confirmed_state > exact_chapter_span > inferred > profile_only
 *
 * eval-only 模块，在 tsconfig.eval.json 注册。
 */

import { readFileSync, existsSync } from "node:fs";

// ============================================================================
// 常量
// ============================================================================

/**
 * 有效证据等级白名单（与 tool-protocol.ts EvidenceLevel 对齐）。
 *
 * 只接受有明确原文 span 或状态文件 entry 支持的证据等级。
 * inferred（基于已有证据推导）和 profile_only（风格档案降级）不计入有效证据。
 */
export const VALID_EVIDENCE_LEVELS: ReadonlySet<string> = new Set([
  "confirmed",
  "confirmed_state",
  "exact_chapter_span",
]);

/**
 * 无效 sourceRef 黑名单（正则模式）。
 *
 * 表示"未找到证据"或"降级证据"的 sourceRef 模式。
 * Step 1 修复：原 INVALID_REFS 漏掉 voice:profile_only:degraded。
 */
export const INVALID_REF_PATTERNS: readonly RegExp[] = [
  /^ranked:no-match$/,
  /^character:empty$/,
  /^empty$/,
  /^no-match$/,
  /^voice:profile_only:degraded$/,
  /^voice:.*:degraded$/,
  /:no-match$/,
  /:empty$/,
];

// ============================================================================
// 类型定义
// ============================================================================

/** 从 trajectory 提取的 confirmed 证据 */
export interface ConfirmedEvidence {
  sourceRef: string;
  excerpt: string;
  evidenceLevel: string;
}

/** mustVerify 项的覆盖结果 */
export interface MustVerifyCoverage {
  perItem: Array<{ item: string; covered: boolean; matchedEvidence?: string }>;
  /** 0-1，mustVerifyItems 为空时为 1（无要求即全覆盖） */
  coverageRatio: number;
  uncoveredItems: string[];
}

/** 召回率判定结果三态 */
export type RecallCriterion = "pass" | "fail" | "unmeasured";

/** evaluateRecallCriterion 的轻量输入（避免依赖 ArmMetrics 循环引用） */
export interface RecallMetrics {
  mustVerifyCount: number;
  confirmedEvidenceCount: number;
  mustVerifyCoverage: number;
}

/** 召回率判定返回 */
export interface RecallCriterionResult {
  value: RecallCriterion;
  reason?: string;
}

// ============================================================================
// Trajectory 解析（内部辅助）
// ============================================================================

/** Trajectory JSONL 单行结构（与 trajectory-store.ts TrajectoryEntry 对齐） */
interface TrajectoryEntry {
  type: string;
  timestamp: number;
  data: unknown;
}

/**
 * 读取 trajectory JSONL 文件，解析为 TrajectoryEntry 数组。
 * 文件不存在或解析失败时返回空数组。
 */
function readTrajectory(trajectoryPath: string): TrajectoryEntry[] {
  if (!trajectoryPath || !existsSync(trajectoryPath)) {
    return [];
  }
  try {
    const content = readFileSync(trajectoryPath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    const entries: TrajectoryEntry[] = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line) as TrajectoryEntry);
      } catch {
        // 跳过无法解析的行
      }
    }
    return entries;
  } catch {
    return [];
  }
}

// ============================================================================
// 核心函数实现
// ============================================================================

/**
 * 判断 sourceRef 是否为有效（非 no-match/empty/degraded）。
 *
 * 使用 INVALID_REF_PATTERNS 正则数组过滤所有已知的"未找到/降级"模式。
 */
export function isValidSourceRef(ref: string | undefined): boolean {
  if (typeof ref !== "string" || ref.length === 0) return false;
  for (const pattern of INVALID_REF_PATTERNS) {
    if (pattern.test(ref)) return false;
  }
  return true;
}

/**
 * 从 trajectory JSONL 提取 confirmed 证据（按 VALID_EVIDENCE_LEVELS 过滤）。
 *
 * 两个来源：
 * 1. ranked_evidence 条目的 data.evidences[]（按 evidenceLevel 过滤）
 * 2. tool_execution_end 条目的 data.result.details.evidenceLevel + content[].text
 *
 * 只保留 evidenceLevel ∈ VALID_EVIDENCE_LEVELS 且 sourceRef 有效（非 no-match/empty/degraded）的条目。
 */
export function extractConfirmedEvidenceFromTrajectory(
  trajectoryPath: string,
): ConfirmedEvidence[] {
  const entries = readTrajectory(trajectoryPath);
  const evidences: ConfirmedEvidence[] = [];
  for (const entry of entries) {
    // 来源 1：ranked_evidence 条目
    if (entry.type === "ranked_evidence") {
      const data = entry.data as { evidences?: Array<{ sourceRef?: string; excerpt?: string; evidenceLevel?: string }> } | null;
      if (Array.isArray(data?.evidences)) {
        for (const ev of data.evidences) {
          const level = ev?.evidenceLevel ?? "";
          if (isValidSourceRef(ev?.sourceRef) && VALID_EVIDENCE_LEVELS.has(level)) {
            evidences.push({
              sourceRef: ev.sourceRef!,
              excerpt: ev.excerpt ?? "",
              evidenceLevel: level,
            });
          }
        }
      }
    }
    // 来源 2：tool_execution_end 条目
    if (entry.type === "tool_event") {
      const data = entry.data as {
        type?: string;
        result?: {
          details?: { sourceRef?: string; evidenceLevel?: string };
          content?: Array<{ type?: string; text?: string }>;
        };
      } | null;
      if (data?.type === "tool_execution_end") {
        const ref = data?.result?.details?.sourceRef;
        const level = data?.result?.details?.evidenceLevel ?? "";
        if (isValidSourceRef(ref) && VALID_EVIDENCE_LEVELS.has(level)) {
          const textParts = (data?.result?.content ?? [])
            .filter((c) => c?.type === "text" && typeof c.text === "string")
            .map((c) => c.text as string);
          evidences.push({
            sourceRef: ref!,
            excerpt: textParts.join("\n"),
            evidenceLevel: level,
          });
        }
      }
    }
  }
  return evidences;
}

/**
 * 中文虚词停用词集合（用于 extractKeyPhrases 过滤纯虚词）。
 *
 * Step 1 修复：原 STOP_WORDS 过于激进（过滤了"左臂""伤势"等核心实体词），
 * 现在只保留真正的虚词，避免误过滤实体。
 */
const STOP_WORDS = new Set([
  "的", "了", "是", "有", "在", "和", "与", "及", "或", "也", "都", "就", "还",
  "又", "再", "已", "将", "被", "把", "向", "为", "对", "跟", "从", "到", "于",
  "之", "其", "此", "这", "那", "一", "个", "些", "么", "什", "怎", "哪", "他",
  "她", "它", "我", "你", "们", "第", "章", "确认", "查证", "验证",
]);

/**
 * 从 mustVerify 项文本提取关键短语（2-3 字滑窗，过滤虚词）。
 *
 * Step 1 修复：原用 {2,6} 贪婪匹配切出 6 字片段，导致"确认林默左臂噬魂印伤势当前状态"
 * 被切成"确认林默左臂""噬魂印伤势当"等长片段，无法在证据 excerpt 中匹配。
 * 现改为 2-3 字滑窗，生成更细粒度的子串，更容易在 excerpt 中命中核心实体
 * （如"林默""噬魂""云岚""血玉"）。
 *
 * @returns 去重后的关键短语数组（2-3 字），按出现顺序
 */
function extractKeyPhrases(text: string): string[] {
  const phrases: string[] = [];
  // 提取所有连续中文片段
  const chineseSegments = text.match(/[\u4e00-\u9fa5]+/g) ?? [];
  for (const segment of chineseSegments) {
    // 3 字滑窗
    for (let i = 0; i < segment.length - 2; i++) {
      const phrase = segment.slice(i, i + 3);
      if (!STOP_WORDS.has(phrase)) phrases.push(phrase);
    }
    // 2 字滑窗（补充）
    for (let i = 0; i < segment.length - 1; i++) {
      const phrase = segment.slice(i, i + 2);
      if (!STOP_WORDS.has(phrase)) phrases.push(phrase);
    }
  }
  return [...new Set(phrases)];
}

/**
 * 按 mustVerify 项计算 confirmed 覆盖率。
 *
 * 算法：
 * - mustVerifyItems 为空 → coverageRatio=1（无要求即全覆盖）
 * - 对每项，检查是否在 confirmedEvidences 中至少有一条证据的 excerpt：
 *   a) 精确/子串匹配（item 包含 excerpt 或 excerpt 包含 item）
 *   b) 关键短语匹配（item 的某个关键短语在 excerpt 中出现）
 * - coverageRatio = covered 项数 / 总项数
 *
 * @returns perItem: 每项覆盖状态；coverageRatio: 0-1；uncoveredItems: 未覆盖项
 */
export function computeMustVerifyCoverage(
  mustVerifyItems: string[],
  confirmedEvidences: ConfirmedEvidence[],
): MustVerifyCoverage {
  if (mustVerifyItems.length === 0) {
    return { perItem: [], coverageRatio: 1, uncoveredItems: [] };
  }
  const perItem: MustVerifyCoverage["perItem"] = [];
  const uncovered: string[] = [];
  for (const item of mustVerifyItems) {
    const keyPhrases = extractKeyPhrases(item);
    let matched: string | undefined;
    const covered = confirmedEvidences.some((ev) => {
      // 优先精确/子串匹配
      if (ev.excerpt.includes(item) || item.includes(ev.excerpt)) {
        matched = ev.sourceRef;
        return true;
      }
      // 关键短语匹配（至少 1 个短语在证据 excerpt 中出现）
      const hit = keyPhrases.some((phrase) => ev.excerpt.includes(phrase));
      if (hit) {
        matched = ev.sourceRef;
        return true;
      }
      return false;
    });
    perItem.push({ item, covered, matchedEvidence: matched });
    if (!covered) uncovered.push(item);
  }
  return {
    perItem,
    coverageRatio: perItem.filter((p) => p.covered).length / mustVerifyItems.length,
    uncoveredItems: uncovered,
  };
}

/**
 * 评估 A/B 两组召回率比较结果（三态）。
 *
 * 判定逻辑：
 * - 两组 mustVerifyCount 全 0 → unmeasured（无高风险 case，召回率未测量）
 * - 两组 confirmedEvidenceCount 全 0 → unmeasured（fixture 无正向召回）
 * - 否则用 avgCoverage 比较：avgCovA <= avgCovB → pass，反之 fail
 */
export function evaluateRecallCriterion(
  armA: RecallMetrics[],
  armB: RecallMetrics[],
): RecallCriterionResult {
  const validA = armA.filter((m) => m.mustVerifyCount > 0);
  const validB = armB.filter((m) => m.mustVerifyCount > 0);
  // 两组都无 mustVerify（全低风险 case）→ unmeasured
  if (validA.length === 0 && validB.length === 0) {
    return {
      value: "unmeasured",
      reason: "所有 case 的 mustVerifyCount=0（无高风险 case），召回率未测量",
    };
  }
  // 两组都无 confirmed 证据 → unmeasured
  const totalConfirmedA = validA.reduce((s, m) => s + m.confirmedEvidenceCount, 0);
  const totalConfirmedB = validB.reduce((s, m) => s + m.confirmedEvidenceCount, 0);
  if (totalConfirmedA === 0 && totalConfirmedB === 0) {
    return {
      value: "unmeasured",
      reason: "A/B 两组均无 confirmed 证据（fixture 无正向召回），召回率未测量",
    };
  }
  // 用覆盖率均值比较
  const avgCovA = avgCoverage(validA);
  const avgCovB = avgCoverage(validB);
  if (avgCovA <= avgCovB) {
    return { value: "pass" };
  }
  return { value: "fail" };
}

/** 计算一组 metrics 的平均覆盖率（mustVerifyCount>0 的项） */
function avgCoverage(metrics: RecallMetrics[]): number {
  const valid = metrics.filter((m) => m.mustVerifyCount > 0);
  if (valid.length === 0) return 0;
  return valid.reduce((s, m) => s + m.mustVerifyCoverage, 0) / valid.length;
}
