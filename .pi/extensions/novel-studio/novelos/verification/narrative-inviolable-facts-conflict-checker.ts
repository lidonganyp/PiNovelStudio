/**
 * NovelOS Inviolable Facts Conflict Checker（inc-4 新增）
 *
 * 检测 inviolableFacts 数组内部的直接矛盾。
 *
 * 设计原则：
 * - 只检测明确的直接否定冲突（保守策略，避免误报）
 * - 不做语义推理（"受伤" vs "健康"需要语义理解，超出范围）
 * - 检测模式：
 *   1. 直接否定：factA="X在场" + factB="X不在场" / "X未在场" / "X没有在场"
 *   2. 互斥属性：factA="X是A" + factB="X是B"（A ≠ B，且 A/B 是短属性词）
 *   3. 必须/禁止冲突：factA="必须X" + factB="禁止X" / "不能X"
 *
 * 发现的冲突标记为：
 * - failureType: "author_input_conflict"
 * - certainty: "deterministic"（输入本身的矛盾，非启发式）
 * - severity: "hard"（作者输入矛盾导致章节不可生成）
 * - coverageStatus: "missing"（不适用覆盖语义，但默认值）
 * - sourceRef: 指向 ChapterSeed/inviolableFacts（让 orchestrator 分类为 author_input_conflict）
 *
 * 文件拆分目的：满足 simplicity-gate 800 行限制；纯函数，可独立测试。
 */

import type { VerificationFinding } from "./narrative-verifier-types.js";
import type { NarrativeVerifierInput } from "./narrative-verifier-types.js";

// ============================================================================
// 内部辅助：提取否定标记与核心内容
// ============================================================================

/** 中文否定前缀标记 */
const NEGATION_PREFIXES = ["不", "未", "没有", "无", "非"] as const;

/** 中文禁止/必须互斥标记对 */
const MUTUAL_EXCLUSION_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["必须", "禁止"],
  ["必须", "不能"],
  ["必须", "不得"],
  ["应该", "不应"],
  ["需要", "不能"],
];

/**
 * 尝试从事实字符串中提取"主体+属性"结构。
 * 返回 { subject, predicate } 或 null（无法提取）。
 *
 * 例：
 * - "李一凡在场" → { subject: "李一凡", predicate: "在场" }
 * - "李一凡不在场" → { subject: "李一凡", predicate: "不在场" }
 * - "时间是白天" → { subject: "时间", predicate: "是白天" }
 * - "必须单独行动" → { subject: "", predicate: "必须单独行动" }
 */
function extractSubjectPredicate(fact: string): { subject: string; predicate: string } | null {
  const trimmed = fact.trim();
  if (trimmed.length < 2) return null;

  // 模式1：[主体][是/在/有/为/到][属性] — 提取主体和属性
  // 匹配常见的中文主谓结构
  // 排除否定标记（不/未/没/无/非）不进入主体，使"李一凡不在场"正确解析为 subject=李一凡, predicate=不在场
  const copulaMatch = trimmed.match(/^([^\s，。、；：是在有为到不未没无非]{1,8})(是|在|有|为|到)(.+)$/u);
  if (copulaMatch) {
    return {
      subject: copulaMatch[1],
      predicate: copulaMatch[2] + copulaMatch[3],
    };
  }

  // 模式1b：[主体][否定标记][是/在/有/为/到][属性]
  // 处理"李一凡不在场"：主体="李一凡", 否定="不", 系词="在", 属性="场" → predicate="不在场"
  const negCopulaMatch = trimmed.match(/^([^\s，。、；：是在有为到不未没无非]{1,8})(不|未|没|无|非)(是|在|有|为|到)(.+)$/u);
  if (negCopulaMatch) {
    return {
      subject: negCopulaMatch[1],
      predicate: negCopulaMatch[2] + negCopulaMatch[3] + negCopulaMatch[4],
    };
  }

  // 模式2：[主体][动词短语]（无系词）
  // 匹配"李一凡受伤"、"赵明远死亡"等
  const subjectActionMatch = trimmed.match(/^([\u4e00-\u9fff]{2,4})([\u4e00-\u9fff]{2,})$/u);
  if (subjectActionMatch) {
    return {
      subject: subjectActionMatch[1],
      predicate: subjectActionMatch[2],
    };
  }

  // 无法提取结构化主体
  return { subject: "", predicate: trimmed };
}

/**
 * 检查 factB 是否是 factA 的直接否定。
 * 规则：factB 去掉否定前缀后等于 factA（或反之）。
 */
function isDirectNegation(factA: string, factB: string): boolean {
  const a = factA.trim();
  const b = factB.trim();

  for (const neg of NEGATION_PREFIXES) {
    // b = neg + a → b 是 a 的否定
    if (b === neg + a) return true;
    // a = neg + b → a 是 b 的否定
    if (a === neg + b) return true;
    // b = "没有" + a 且 a 不以"没有"开头
    if (neg === "没有" && b.startsWith(neg) && b.slice(neg.length) === a) return true;
    if (neg === "没有" && a.startsWith(neg) && a.slice(neg.length) === b) return true;
  }

  return false;
}

/**
 * 检查两个事实是否共享相同主体但谓词互斥。
 * 例：factA="李一凡在场" + factB="李一凡不在场"
 */
function hasSameSubjectConflictingPredicate(
  factA: string,
  factB: string,
): { conflict: boolean; subject: string; predA: string; predB: string } {
  const spA = extractSubjectPredicate(factA);
  const spB = extractSubjectPredicate(factB);

  if (!spA || !spB) return { conflict: false, subject: "", predA: "", predB: "" };
  if (!spA.subject || !spB.subject) return { conflict: false, subject: "", predA: "", predB: "" };
  if (spA.subject !== spB.subject) return { conflict: false, subject: "", predA: "", predB: "" };

  // 相同主体，检查谓词是否互为否定
  if (spA.predicate === spB.predicate) {
    return { conflict: false, subject: spA.subject, predA: spA.predicate, predB: spB.predicate };
  }

  // 检查直接否定：predA = "在场", predB = "不在场"
  if (isDirectNegation(spA.predicate, spB.predicate)) {
    return { conflict: true, subject: spA.subject, predA: spA.predicate, predB: spB.predicate };
  }

  // 检查"是X" vs "是Y"（X ≠ Y，且都是短属性 ≤6 字符）
  const attrA = spA.predicate.match(/^是(.+)$/u);
  const attrB = spB.predicate.match(/^是(.+)$/u);
  if (attrA && attrB && attrA[1] !== attrB[1]) {
    const valA = attrA[1].trim();
    const valB = attrB[1].trim();
    // 只在短属性值时触发（避免"是昨天下午到的" vs "是今天到的"这类长句误报）
    if (valA.length <= 6 && valB.length <= 6) {
      return { conflict: true, subject: spA.subject, predA: spA.predicate, predB: spB.predicate };
    }
  }

  return { conflict: false, subject: spA.subject, predA: spA.predicate, predB: spB.predicate };
}

/**
 * 检查必须/禁止互斥对。
 * 例：factA="必须单独行动" + factB="禁止单独行动"
 */
function hasMustForbidConflict(factA: string, factB: string): boolean {
  const a = factA.trim();
  const b = factB.trim();

  for (const [markerA, markerB] of MUTUAL_EXCLUSION_PAIRS) {
    // a 以 markerA 开头，b 以 markerB 开头，且去掉标记后内容相同
    if (a.startsWith(markerA) && b.startsWith(markerB)) {
      const restA = a.slice(markerA.length);
      const restB = b.slice(markerB.length);
      if (restA === restB && restA.length > 0) return true;
    }
    // 反向：a 以 markerB 开头，b 以 markerA 开头
    if (a.startsWith(markerB) && b.startsWith(markerA)) {
      const restA = a.slice(markerB.length);
      const restB = b.slice(markerA.length);
      if (restA === restB && restA.length > 0) return true;
    }
  }

  return false;
}

// ============================================================================
// 公开入口
// ============================================================================

export function checkInviolableFactsConflict(
  input: NarrativeVerifierInput,
): VerificationFinding[] {
  const findings: VerificationFinding[] = [];
  const facts = input.inviolableFacts ?? [];

  if (facts.length < 2) return findings;

  // 逐对检查
  for (let i = 0; i < facts.length; i++) {
    for (let j = i + 1; j < facts.length; j++) {
      const factA = facts[i];
      const factB = facts[j];

      // 1. 检查相同主体+冲突谓词
      const subjectConflict = hasSameSubjectConflictingPredicate(factA, factB);
      if (subjectConflict.conflict) {
        findings.push({
          id: `verifier:author_input_conflict:${i}-${j}`,
          source: "inviolable_facts_conflict_checker",
          failureType: "author_input_conflict",
          severity: "hard",
          span: { start: 0, end: 0, excerpt: "" },
          conflictFact: `inviolableFacts 内部矛盾：事实[${i}]「${factA}」与事实[${j}]「${factB}」对主体「${subjectConflict.subject}」给出冲突属性（${subjectConflict.predA} vs ${subjectConflict.predB}）`,
          sourceRef: `chapter-seed:inviolableFacts[${i}],chapter-seed:inviolableFacts[${j}]`,
          confidence: 1,
          allowedRepairRange: { start: 0, end: 0, excerpt: "" },
          description: `作者输入自相矛盾：主体「${subjectConflict.subject}」同时被赋予冲突属性`,
          certainty: "deterministic",
          coverageStatus: "missing",
        });
        continue; // 同一对只报一次
      }

      // 2. 检查必须/禁止互斥
      if (hasMustForbidConflict(factA, factB)) {
        findings.push({
          id: `verifier:author_input_conflict:${i}-${j}`,
          source: "inviolable_facts_conflict_checker",
          failureType: "author_input_conflict",
          severity: "hard",
          span: { start: 0, end: 0, excerpt: "" },
          conflictFact: `inviolableFacts 内部矛盾：事实[${i}]「${factA}」与事实[${j}]「${factB}」构成必须/禁止互斥`,
          sourceRef: `chapter-seed:inviolableFacts[${i}],chapter-seed:inviolableFacts[${j}]`,
          confidence: 1,
          allowedRepairRange: { start: 0, end: 0, excerpt: "" },
          description: `作者输入自相矛盾：同一行为同时被要求与被禁止`,
          certainty: "deterministic",
          coverageStatus: "missing",
        });
        continue;
      }

      // 3. 检查直接否定（整句级别）
      if (isDirectNegation(factA, factB)) {
        findings.push({
          id: `verifier:author_input_conflict:${i}-${j}`,
          source: "inviolable_facts_conflict_checker",
          failureType: "author_input_conflict",
          severity: "hard",
          span: { start: 0, end: 0, excerpt: "" },
          conflictFact: `inviolableFacts 内部矛盾：事实[${i}]「${factA}」与事实[${j}]「${factB}」互为直接否定`,
          sourceRef: `chapter-seed:inviolableFacts[${i}],chapter-seed:inviolableFacts[${j}]`,
          confidence: 1,
          allowedRepairRange: { start: 0, end: 0, excerpt: "" },
          description: `作者输入自相矛盾：一条事实直接否定另一条`,
          certainty: "deterministic",
          coverageStatus: "missing",
        });
      }
    }
  }

  return findings;
}
