/**
 * NovelOS Canon/Promise Conflict Checker（OPT-9.6 拆分自 narrative-verifier-suite.ts）
 *
 * 检查正文是否与 canon 事实或 promise 冲突。
 *
 * P0-2 修复：promise 冲突必须识别明确的兑现声明，不得仅凭关键词附近出现"完成/结束"判定。
 * - 必须出现 "X 已解决/已完结/已了结/已结束" 或 "解决了/完结了/了结了 X" 等明确兑现声明
 * - "完成了记录" 中的 "完成" 修饰 "记录"（非 promise）→ 不触发
 * - "暗流来源已解决" 中的 "解决" 直接修饰 "暗流来源"（promise）→ 触发
 *
 * M1 启发式：
 * - facts 中 kind="canon" 的事实，若 content 含"不能"/"禁止"/"必须不"约束，
 *   检查正文是否违反（简单关键词反转匹配）。
 * - openLoops 中已标记 resolved=false 的 promise，若正文声称已解决，
 *   标记为 promise_conflict。
 */

import type { VerificationFinding } from "./narrative-verifier-types.js";
import type { NarrativeVerifierInput } from "./narrative-verifier-types.js";

// ============================================================================
// 公开入口
// ============================================================================

export function checkCanonPromiseConflicts(
  input: NarrativeVerifierInput,
): VerificationFinding[] {
  const findings: VerificationFinding[] = [];

  // canon 事实约束检查（M1：所有 kind="fact" 的事实都视为 canon 约束候选）
  for (const fact of input.context.facts) {
    if (fact.kind !== "fact") continue;
    const constraintMatch = fact.content.match(/(?:不能|禁止|必须不|不得)([^，。；！？\s]+)/);
    if (!constraintMatch) continue;

    const forbiddenTerm = constraintMatch[1];
    if (forbiddenTerm && forbiddenTerm.length >= 2) {
      const pos = input.text.indexOf(forbiddenTerm);
      if (pos >= 0) {
        findings.push({
          id: `verifier:canon_conflict:${fact.id}:${forbiddenTerm}`,
          source: "canon_conflict_checker",
          failureType: "canon_conflict",
          severity: "hard",
          span: {
            start: pos,
            end: pos + forbiddenTerm.length,
            excerpt: input.text.slice(pos, pos + forbiddenTerm.length),
          },
          conflictFact: `canon 约束「${fact.content}」被违反：正文出现「${forbiddenTerm}」`,
          sourceRef: `fact:${fact.id}`,
          confidence: 0.9,
          allowedRepairRange: {
            start: pos,
            end: Math.min(input.text.length, pos + forbiddenTerm.length + 20),
            excerpt: input.text.slice(pos, pos + Math.min(forbiddenTerm.length + 20, 40)),
          },
          description: `canon 冲突：${fact.content}`,
          certainty: "corroborated",
          coverageStatus: "missing",
        });
      }
    }
  }

  // promise 冲突检查（openLoops 中的都是未解决的 promise，若正文声称解决则冲突）
  // P0-2：必须识别明确的兑现声明，不得仅凭关键词附近出现"完成/结束"判定
  for (const loop of input.context.openLoops) {
    // P0-2：keyword 提取兼容中英文标点（英文逗号/句号/分号/冒号）
    const descKeywords = loop.description
      .split(/[\s,，。；;：:、!?！？]+/)
      .map((k) => k.trim())
      .filter((k) => k.length >= 2);
    let loopAlreadyReported = false;
    for (const keyword of descKeywords) {
      let pos = input.text.indexOf(keyword);
      while (pos >= 0 && !loopAlreadyReported) {
        // P0-2：必须识别明确的兑现声明
        if (isExplicitPromiseFulfillment(input.text, pos, keyword)) {
          findings.push({
            id: `verifier:promise_conflict:${loop.id}:${keyword}:${pos}`,
            source: "promise_conflict_checker",
            failureType: "promise_conflict",
            severity: "hard",
            span: {
              start: pos,
              end: pos + keyword.length,
              excerpt: input.text.slice(pos, pos + keyword.length),
            },
            conflictFact: `未兑现 promise「${loop.description}」被正文声称解决`,
            sourceRef: `openLoop:${loop.id}`,
            confidence: 0.85,
            allowedRepairRange: {
              start: pos,
              end: Math.min(input.text.length, pos + keyword.length + 20),
              excerpt: input.text.slice(pos, pos + Math.min(keyword.length + 20, 60)),
            },
            description: `promise 冲突：${loop.description}`,
            certainty: "corroborated",
            coverageStatus: "missing",
          });
          loopAlreadyReported = true;
        }
        pos = input.text.indexOf(keyword, pos + keyword.length);
      }
      if (loopAlreadyReported) break;
    }
  }

  return findings;
}

// ============================================================================
// 内部：promise 兑现声明识别
// ============================================================================

/**
 * P0-2：识别明确的 promise 兑现声明。
 *
 * 必须满足以下之一才算"明确兑现声明"：
 * 1. keyword 后紧跟 "已解决/已完结/已了结/已结束/已破/已消散/已破除/被解决/被完结"
 *    例："暗流来源已解决"
 * 2. keyword 前紧跟 "解决了/完结了/了结了/结束了/破除了/消散了" + keyword
 *    例："解决了暗流来源"
 * 3. keyword 后 30 字符内出现 "X 已解决/已完结/已了结/已结束" 且 X 是 keyword 本身
 *    （处理 "暗流来源，这个问题已解决" 等带插入语的形式）
 *
 * 不算"明确兑现声明"：
 * - "完成了记录"（"完成" 修饰 "记录"，不是 keyword）
 * - "解决了另一个问题"（"解决" 修饰其他对象）
 * - "他完成了任务"（无 keyword 上下文）
 */
function isExplicitPromiseFulfillment(
  text: string,
  keywordPos: number,
  keyword: string,
): boolean {
  const keywordEnd = keywordPos + keyword.length;

  // 模式 1：keyword 后紧跟 "已解决/已完结/已了结/已结束/已破/已消散/已破除/被解决/被完结"
  const afterKeyword = text.slice(keywordEnd, Math.min(text.length, keywordEnd + 20));
  const afterPattern = /^(?:[，,。；;]?\s*(?:已|已经|被)?(?:解决|完结|了结|结束|破除|消散|破|散))/u;
  if (afterPattern.test(afterKeyword)) return true;

  // 模式 2：keyword 前紧跟 "解决了/完结了/了结了/结束了/破除了/消散了" + keyword
  const beforeKeyword = text.slice(Math.max(0, keywordPos - 20), keywordPos);
  const beforePattern = /(?:解决|完结|了结|结束|破除|消散|破|散)了$/u;
  if (beforePattern.test(beforeKeyword)) return true;

  // 模式 3：keyword 后 30 字符内出现 "X 已解决/已完结/已了结/已结束" 且 X 指代 keyword
  // 仅当上下文明确指代 keyword 时触发（保守判断：紧邻指代词"这/此/该"）
  const extendedAfter = text.slice(keywordEnd, Math.min(text.length, keywordEnd + 40));
  const extendedPattern = /(?:[，,。；;]\s*(?:这|此|该|那个|这个)(?:问题|事|事情|隐患|危机|谜团)?(?:已|已经|被)?(?:解决|完结|了结|结束|破除|消散))/u;
  if (extendedPattern.test(extendedAfter)) return true;

  return false;
}
