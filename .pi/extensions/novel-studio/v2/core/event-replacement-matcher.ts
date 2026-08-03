/**
 * EventReplacementMatcher — 事件替换匹配器（从 event-ledger-comparator.ts 抽取，simplicity-gate 拆分）
 *
 * 负责 raw → editorial 的事件级匹配与替换检测：
 * - 主客体反转预检测（subject/object 交换 + 同动作）
 * - 结构+相似度+位置综合评分找最佳匹配
 * - 关键事件缺失检测（raw 关键动作在 editorial 全文未出现）
 * - 动作→非动作替换检测
 * - 主客体反转、否定语义反转、未遂→实际语义反转检测
 * - 同主体同动作的客体替换/客体删除/未知实体替换检测
 * - 动作反转（反义词对）检测
 * - 关键动作替换、低相似度替换、advisory 降级
 *
 * 设计原则（project_memory 约束）：
 * - 阻断必须有至少一个可解释的事件级证据，不基于词项计数
 * - 动作反转（反义词对）是事件级硬证据，单个即阻断
 * - 关键动作替换是硬证据，单个即阻断
 * - 低相似度替换需达到系统性数量才阻断（避免误杀同义改写）
 * - state_description 不可作为动作反转证据（无动作，反义词对不适用）
 * - 同角色不同事件（不共享显著内容）降为 advisory，不阻断
 *
 * 纯函数模块，本地确定性，无 LLM 调用。
 */

import {
  areActionsSynonymous,
  detectActionReversal,
  detectCriticalReplacement,
  detectNearMissReversal,
  detectNegationReversal,
  detectSubjectObjectSwap,
  extractSignificantChars,
  hasSharedSignificantBigram,
  isCriticalAction,
  jaccardSimilarity,
  type ExtractedEvent,
} from "./event-extractor.js";
import { findSubjectObjectSwapPreMatch } from "./event-comparator-helpers.js";
import type {
  ReplacedEventEvidence,
  AdvisorySimilarityEvidence,
} from "./event-ledger-types.js";

// ============================================================================
// 类型定义
// ============================================================================

/** 替换匹配参数。 */
export interface ReplacementMatchParams {
  rawExtractable: ExtractedEvent[];
  editorialExtractable: ExtractedEvent[];
  knownEntities: string[];
  knownEntitySet: Set<string>;
  editorialText: string;
  replacedSimilarityThreshold: number;
}

/** 替换匹配结果。 */
export interface ReplacementMatchResult {
  replacedEvents: ReplacedEventEvidence[];
  advisorySimilarities: AdvisorySimilarityEvidence[];
  /** 已被 forward pass 匹配的 editorial 事件 ID（供后续 editorial-only 检测使用） */
  matchedEditorialIds: Set<string>;
}

// ============================================================================
// 最佳匹配候选类型
// ============================================================================

interface BestMatchCandidate {
  event: ExtractedEvent;
  similarity: number;
  structureScore: number;
  totalScore: number;
  subjectMatch: boolean;
  actionMatch: boolean;
  objectMatch: boolean;
}

// ============================================================================
// 核心匹配函数
// ============================================================================

/**
 * 比对 raw 与 editorial 事件，检测替换、反转、关键事件缺失等漂移信号。
 *
 * 算法（每个 raw 事件）：
 * 1. 跳过实体未保留且无关键动作的事件（缺失事件由 missingEvents 单独处理）
 * 2. 主客体反转预检测：raw (S→O) vs editorial (O→S) 同动作 → 直接阻断
 * 3. 按 subject/action/object/位置综合评分找 editorial 最佳匹配
 * 4. 关键事件缺失检测：raw 关键动作（作用于已知实体客体）在 editorial 全文未出现 → 阻断
 * 5. 无匹配 + 关键动作 + 已知实体主体 → 关键事件删除（阻断）
 * 6. 动作→非动作、主客体反转、否定反转、未遂反转、客体替换/删除/未知替换等检测
 * 7. 动作反转（反义词对）、关键动作替换、低相似度替换或 advisory 降级
 *
 * 主体绑定规则（P0-1 第三轮，防跨主体误匹配）：
 * - raw 有显式 subject → editorial 必须同 subject
 * - raw 无 subject 但 editorial 有 subject → 跳过（主体不明，不应跨绑定）
 * - 两者都无 subject → 仅位置相同或相邻时匹配（防远位误匹配）
 */
export function matchAndDetectReplacements(
  params: ReplacementMatchParams,
): ReplacementMatchResult {
  const {
    rawExtractable,
    editorialExtractable,
    knownEntities,
    knownEntitySet,
    editorialText,
    replacedSimilarityThreshold,
  } = params;

  const replacedEvents: ReplacedEventEvidence[] = [];
  const advisorySimilarities: AdvisorySimilarityEvidence[] = [];
  // P0-1：跟踪已被匹配的 editorial 事件，避免多个 raw 事件争抢同一 editorial 事件
  // （例如 raw "放行" 不应匹配已被 raw "交出玉玺" 占用的 editorial "看玉玺"，
  //   而应回退到下一个未匹配的 editorial "扣留"，从而触发 antonym 反转检测）
  const matchedEditorialIds = new Set<string>();
  const maxLen = Math.max(rawExtractable.length, editorialExtractable.length, 1);

  for (let rawIdx = 0; rawIdx < rawExtractable.length; rawIdx++) {
    const rawEvent = rawExtractable[rawIdx]!;
    // 只检查实体在 editorial 仍存在的事件（缺失的在 missingEvents 处理）
    // P0-1：如果 rawEvent 有 subject（来自代词绑定或隐式绑定），即使 sentence 中
    // 无已知实体（如 "放行" 子句），也应检查 subject 是否在 editorial 中存在
    //
    // P0-1 第三轮：含关键动作的隐式主体事件（无实体、无 subject）不应被跳过。
    // 用户验收反例："攻击"→"看一眼"、"拿起"→"放下" 等短文本因 retainedEntities=0
    // 且 subjectRetained=false 被跳过，导致 0 个替换事件 → 放过剧情反转。
    // 修复：raw 事件含关键动作时，即使无实体/subject 也进入匹配（按位置匹配 editorial 事件）。
    const retainedEntities = rawEvent.entities.filter((e) => editorialText.includes(e));
    const subjectRetained =
      rawEvent.subject !== "" && editorialText.includes(rawEvent.subject);
    const rawHasCriticalAction = isCriticalAction(rawEvent.action);
    if (retainedEntities.length === 0 && !subjectRetained && !rawHasCriticalAction) continue;

    // P0 第四轮：主客体反转预检测（委托 findSubjectObjectSwapPreMatch）
    // 严格主体匹配会跳过 editorial 中 subject 不同的 event，导致 "叶尘攻击林默"→"林默攻击叶尘"
    // 无法进入 detectSubjectObjectSwap 分支（bestMatch=null → 误判为关键事件删除）。
    // 修复：在主体严格匹配前预检测 subject/object 交换 + 同动作的事件，直接标记为反转。
    // 防误报（由 helper 内部处理）：subject !== object + 内容共享（hasSharedSignificantBigram）。
    const swapPreMatch = findSubjectObjectSwapPreMatch(
      rawEvent,
      editorialExtractable,
      matchedEditorialIds,
      knownEntities,
    );
    if (swapPreMatch.detected && swapPreMatch.evidence && swapPreMatch.matchedEditorialId) {
      matchedEditorialIds.add(swapPreMatch.matchedEditorialId);
      replacedEvents.push(swapPreMatch.evidence);
      continue;
    }

    // 找 editorial 中含相同实体的可提取事件，按结构+相似度+位置综合评分
    let bestMatch: BestMatchCandidate | null = null;

    for (let edIdx = 0; edIdx < editorialExtractable.length; edIdx++) {
      const edEvent = editorialExtractable[edIdx]!;
      // P0-1 第三轮：严格主体绑定，防止跨主体事件互相匹配
      //
      // 用户验收反例："交给玉玺并放行"→"看玉玺并留下" 等四组均返回 preserved=true，
      // 根因是匹配器允许仅共享实体、主体不同的事件互相匹配。
      //
      // 新规则（按优先级）：
      // 1. raw 有显式 subject（非空）→ editorial 必须同 subject 才能匹配
      //    （防止 "李天行攻击" 匹配到 "王五防御"）
      // 2. raw 无 subject（隐式/空）但 editorial 有 subject → 跳过（主体不明不应跨绑定）
      // 3. 两者都无 subject（都是隐式 bare verb）→ 按 0.5 概率的位置匹配，
      //    只在位置相同或相邻时匹配（防止 "攻击" 匹配到无关的 "看一眼" 之外的远位事件）
      // 4. 共享实体只有在以上主体规则通过后才作为加分项
      const hasCommonSubject =
        rawEvent.subject !== "" && rawEvent.subject === edEvent.subject;

      if (rawEvent.subject !== "") {
        // raw 有显式主体：要求 editorial 同主体（不允许仅共享实体跨主体匹配）
        if (!hasCommonSubject) continue;
      } else if (edEvent.subject !== "") {
        // raw 无主体但 editorial 有主体：跳过（主体不明，不应绑定到其他主体）
        continue;
      } else {
        // 两者都无主体（隐式 bare verb）：只在位置相同或相邻时匹配
        // 防止短文本中 "攻击" 匹配到远位的无关事件
        const positionDiff = Math.abs(rawIdx - edIdx);
        if (positionDiff > 1) continue;
      }

      // 结构匹配
      const subjectMatch =
        rawEvent.subject !== "" && rawEvent.subject === edEvent.subject;
      // P0 第四轮：空 action 不再被当作通配符
      // 旧逻辑：rawEvent.action !== "" && rawEvent.action.includes(edEvent.action)
      //         当 edEvent.action === "" 时，"".includes("") = true → actionMatch=true（BUG）
      // 新逻辑：要求双方 action 都非空，且使用同义动作族检测
      const actionMatch =
        rawEvent.action !== "" &&
        edEvent.action !== "" &&
        (rawEvent.action === edEvent.action ||
          rawEvent.action.includes(edEvent.action) ||
          edEvent.action.includes(rawEvent.action) ||
          areActionsSynonymous(rawEvent.action, edEvent.action));
      const objectMatch =
        rawEvent.object !== "" &&
        edEvent.object !== "" &&
        (rawEvent.object === edEvent.object ||
          rawEvent.object.includes(edEvent.object) ||
          edEvent.object.includes(rawEvent.object));

      const rawChars = extractSignificantChars(rawEvent.sentence);
      const edChars = extractSignificantChars(edEvent.sentence);
      const sim = jaccardSimilarity(rawChars, edChars);
      const structureScore =
        (subjectMatch ? 0.3 : 0) + (actionMatch ? 0.2 : 0) + (objectMatch ? 0.2 : 0);

      // P0-1：位置加分 —— 当结构+相似度接近时，偏好同位置的 editorial 事件
      // 例如 raw[1]="放行" 应匹配 editorial[1]="扣留"，而非 editorial[0]="看玉玺"
      const positionDiff = Math.abs(rawIdx - edIdx);
      const positionBonus = (1 - positionDiff / maxLen) * 0.05;
      // P0 第四轮：一对一匹配 —— 已被其他 raw 事件占用的 editorial 事件硬跳过
      // 旧逻辑仅 -0.04 降权，导致一条 editorial 事件可重复匹配多条 raw 事件，
      // 使"两次攻击删除其中一次"无法被检测（两次 raw 攻击都匹配到同一条 editorial 攻击）。
      // 新逻辑：硬跳过已匹配的 editorial 事件，确保一对一匹配。
      if (matchedEditorialIds.has(edEvent.id)) continue;

      const totalScore = structureScore + sim * 0.3 + positionBonus;

      if (bestMatch === null || totalScore > bestMatch.totalScore) {
        bestMatch = {
          event: edEvent,
          similarity: sim,
          structureScore,
          totalScore,
          subjectMatch,
          actionMatch,
          objectMatch,
        };
      }
    }

    // P0 第七轮：raw 关键事件不允许被无关事件强行匹配后降级 advisory
    //
    // 用户验收反例（第七轮，生产 gate 实测）：
    //   "叶尘杀死林默" → "叶尘端起茶杯。林默站在一旁" → preserved=true（应阻断）
    //   "叶尘攻击林默" → "叶尘转身离开。林默站在一旁" → preserved=true（应阻断）
    //   "叶尘封印魔物" → "叶尘走出洞穴。魔物仍在洞中" → preserved=true（应阻断）
    //
    // 第六轮 P1-3 修复把"同主体不共享显著内容"统一降为 advisory，导致关键事件被
    // 无关事件替换后通过。第七轮修复（符合用户指令"允许 raw 关键事件不匹配，
    // 对未匹配关键事件直接阻断"）：
    //
    // 当 raw 含关键动作且 bestMatch 不共享 action/object/content 时：
    // 1. 检查关键动作（或同义动作）是否在 editorial 全文出现
    //    - 未出现 → 关键事件被删除/替换为无关事件 → 直接阻断（不消耗 editorial 事件）
    //    - 出现 → 事件可能在其他位置，当前匹配为配对错误 → 降级 advisory（不阻断）
    //      （canary 场景：长文本中 "李强回来" 被配到 "李强看"，但 "回来" 在 editorial
    //       其他位置存在 → 匹配配错，advisory）
    //
    // P0 第七轮 P1 调和：仅当 raw 关键动作作用在"已知实体客体"上时才启用此阻断。
    // 用户验收第六轮反例19："李一凡拿起筷子" → "李一凡吃了"（拿起是关键动作，但筷子
    // 不是已知实体）是同角色不同事件的 canary 正常改写，不应阻断。
    // 用户验收第七轮 P0 反例："叶尘杀死林默"→"叶尘端起茶杯"（林默是已知实体）、
    // "叶尘封印魔物"→"叶尘走出洞穴"（魔物是已知实体）是真正影响故事状态的关键事件
    // 被无关事件替换，必须阻断。
    // 区分维度：raw 关键动作是否有"已知实体客体"——有则事件影响故事实体，缺失即阻断；
    // 无（客体为空或非已知实体）则降为同角色不同事件，交由下方 detectCriticalReplacement
    // 路径处理（bare-verb 关键动作如 "攻击"→"看一眼" 仍由该路径阻断）。
    if (
      bestMatch !== null &&
      isCriticalAction(rawEvent.action) &&
      rawEvent.object !== "" &&
      rawEvent.object.length >= 2 &&
      knownEntitySet.has(rawEvent.object) &&
      !bestMatch.actionMatch &&
      !bestMatch.objectMatch &&
      !hasSharedSignificantBigram(rawEvent.sentence, bestMatch.event.sentence, knownEntities)
    ) {
      // 检查关键动作（或同义动作）是否在 editorial 全文或 editorial 事件 action 中出现
      const actionInEditorialText = editorialText.includes(rawEvent.action);
      const actionInEditorialEvents = editorialExtractable.some(
        (e) => e.action !== "" && areActionsSynonymous(rawEvent.action, e.action),
      );
      if (!actionInEditorialText && !actionInEditorialEvents) {
        // 关键事件缺失：raw 关键动作在 editorial 全文未出现 → 直接阻断
        replacedEvents.push({
          rawEventId: rawEvent.id,
          editorialEventId: bestMatch.event.id,
          subject: rawEvent.subject,
          rawAction: rawEvent.action,
          editorialAction: bestMatch.event.action,
          rawSentence: rawEvent.sentence,
          rawSpan: rawEvent.evidenceSpan,
          editorialSentence: bestMatch.event.sentence,
          editorialSpan: bestMatch.event.evidenceSpan,
          similarity: bestMatch.similarity,
          reversal: false,
          antonymPair: null,
          critical: true,
          rawCriticalAction: rawEvent.action,
          reason: `关键事件缺失：raw 动作 '${rawEvent.action}' 是关键动作，但在 editorial 全文未出现（被删除或替换为无关事件 '${bestMatch.event.action}'），单个关键事件缺失即阻断`,
        });
        continue;
      }
      // 关键动作在 editorial 其他位置存在 → 当前匹配为配对错误 → advisory
      advisorySimilarities.push({
        rawEventId: rawEvent.id,
        editorialEventId: bestMatch.event.id,
        similarity: bestMatch.similarity,
        sharesBigram: false,
        note: `raw 关键动作 '${rawEvent.action}' 在 editorial 其他位置存在，当前匹配 '${bestMatch.event.action}' 为配对错误（advisory，不阻断）`,
      });
      continue;
    }

    if (bestMatch === null) {
      // P0-1 第三轮：raw 事件是关键动作事件但无任何匹配 → 关键事件被删除
      // 这种情况比替换更严重（事件完全消失），应记录为 critical replacement
      // 用户验收反例：短文本中 raw "攻击" 因主体规则未匹配到 editorial 事件时，
      // 若 raw 动作是关键动作，单个删除即阻断
      if (rawEvent.eventType === "action" || rawEvent.eventType === "state_change") {
        const criticalCheck = isCriticalAction(rawEvent.action);
        // P0 第七轮 canary 修复：要求 subject 是已知实体，过滤非角色主体的误提取。
        // canary 实测："任何异能的释放" subject="异能者"（非角色）误触发关键事件删除。
        const subjectIsKnownEntity =
          rawEvent.subject !== "" && knownEntitySet.has(rawEvent.subject);
        if (criticalCheck && subjectIsKnownEntity) {
          replacedEvents.push({
            rawEventId: rawEvent.id,
            editorialEventId: null,
            subject: rawEvent.subject,
            rawAction: rawEvent.action,
            editorialAction: "",
            rawSentence: rawEvent.sentence,
            rawSpan: rawEvent.evidenceSpan,
            editorialSentence: "",
            editorialSpan: { start: 0, end: 0, excerpt: "" },
            similarity: 0,
            reversal: false,
            antonymPair: null,
            critical: true,
            rawCriticalAction: rawEvent.action,
            reason: `关键事件删除：raw 动作 '${rawEvent.action}' 是关键动作，但在 editorial 中无匹配事件（主体 '${rawEvent.subject || "(隐式)"}' 的关键事件被删除），单个关键事件删除即阻断`,
          });
        }
      }
      continue;
    }

    // P0-1：标记该 editorial 事件已被匹配
    matchedEditorialIds.add(bestMatch.event.id);

    // P0 第四轮：动作→非动作检测
    // raw 有明确动作（action/state_change），但 editorial 匹配事件无动作（state_description/action=""）
    // 例如 "攻击" → "沉默不语"：动作被替换为非动作，属于关键事件替换
    if ((rawEvent.eventType === "action" || rawEvent.eventType === "state_change") &&
        rawEvent.action !== "" &&
        (bestMatch.event.eventType === "state_description" || bestMatch.event.action === "")) {
      const criticalCheck = isCriticalAction(rawEvent.action);
      // P0 第七轮 canary 修复：要求内容共享，防止不相关事件配对误报。
      // canary 实测：raw "接过" 匹配到 editorial "摩挲手表"（无动作事件），
      // 但两句不共享显著内容，配对是虚假的。
      const actionToNonActionSharesContent = hasSharedSignificantBigram(
        rawEvent.sentence,
        bestMatch.event.sentence,
        knownEntities,
      );
      if (criticalCheck && actionToNonActionSharesContent) {
        replacedEvents.push({
          rawEventId: rawEvent.id,
          editorialEventId: bestMatch.event.id,
          subject: rawEvent.subject,
          rawAction: rawEvent.action,
          editorialAction: bestMatch.event.action || "(无动作)",
          rawSentence: rawEvent.sentence,
          rawSpan: rawEvent.evidenceSpan,
          editorialSentence: bestMatch.event.sentence,
          editorialSpan: bestMatch.event.evidenceSpan,
          similarity: bestMatch.similarity,
          reversal: false,
          antonymPair: null,
          critical: true,
          rawCriticalAction: rawEvent.action,
          reason: `动作→非动作：raw 关键动作 '${rawEvent.action}' 被 editorial 无动作事件替换（'${bestMatch.event.sentence}'），关键事件被删除或替换为非动作`,
        });
        continue;
      }
    }

    // P0 第四轮：主客体反转检测
    // "叶尘攻击林默" → "林默攻击叶尘"：同一动作，但主体和客体交换（攻击方向反转）
    const subjectObjectSwap = detectSubjectObjectSwap(
      rawEvent.subject, rawEvent.object,
      bestMatch.event.subject, bestMatch.event.object,
    );
    if (subjectObjectSwap) {
      replacedEvents.push({
        rawEventId: rawEvent.id,
        editorialEventId: bestMatch.event.id,
        subject: rawEvent.subject,
        rawAction: rawEvent.action,
        editorialAction: bestMatch.event.action,
        rawSentence: rawEvent.sentence,
        rawSpan: rawEvent.evidenceSpan,
        editorialSentence: bestMatch.event.sentence,
        editorialSpan: bestMatch.event.evidenceSpan,
        similarity: bestMatch.similarity,
        reversal: true,
        antonymPair: null,
        critical: true,
        rawCriticalAction: rawEvent.action,
        reason: `主客体反转：raw '${rawEvent.subject}→${rawEvent.object}' vs editorial '${bestMatch.event.subject}→${bestMatch.event.object}'（动作 '${rawEvent.action}' 的方向被反转，单个即阻断）`,
      });
      continue;
    }

    // P0 第四轮：否定语义反转检测
    // "没有攻击" → "攻击"：否定被移除 = 语义反转
    //
    // P0 第六轮 P1 修复：增加动作一致性校验。
    // 用户验收反例（canary trace）：无关事件被贪心配对后判为"否定语义反转"——
    // 如 raw "没有再说"（action=说, negated=true）与 editorial "肩站在天台上"
    // （action=站, negated=false）配对，旧逻辑只看 negated 标志差异即判反转，
    // 导致硬门禁误阻断。新规则：只有 raw 与 editorial 动作相同或同义时，否定状态
    // 反转才是真正的语义反转；动作不同则是无关事件配对，不得判为否定反转。
    const negationReversal = detectNegationReversal(rawEvent.negated, bestMatch.event.negated);
    const negationActionConsistent =
      rawEvent.action !== "" &&
      bestMatch.event.action !== "" &&
      (rawEvent.action === bestMatch.event.action ||
        areActionsSynonymous(rawEvent.action, bestMatch.event.action));
    // P0 第七轮 canary 修复：增加内容共享校验。
    // canary 实测：raw "牵着走"（action=走, negated）与 editorial "走到"（action=走）
    // 通过动作一致性但实为不同动词短语，仅共享 "走" 字。要求共享显著双字片段。
    const negationSharesContent = hasSharedSignificantBigram(
      rawEvent.sentence,
      bestMatch.event.sentence,
      knownEntities,
    );
    if (negationReversal && negationActionConsistent && negationSharesContent) {
      replacedEvents.push({
        rawEventId: rawEvent.id,
        editorialEventId: bestMatch.event.id,
        subject: rawEvent.subject,
        rawAction: rawEvent.action,
        editorialAction: bestMatch.event.action,
        rawSentence: rawEvent.sentence,
        rawSpan: rawEvent.evidenceSpan,
        editorialSentence: bestMatch.event.sentence,
        editorialSpan: bestMatch.event.evidenceSpan,
        similarity: bestMatch.similarity,
        reversal: true,
        antonymPair: null,
        critical: true,
        rawCriticalAction: rawEvent.action,
        reason: `否定语义反转：raw ${rawEvent.negated ? "否定" : "肯定"} → editorial ${bestMatch.event.negated ? "否定" : "肯定"}（动作 '${rawEvent.action}' 的否定状态被反转，单个即阻断）`,
      });
      continue;
    }

    // P0 第四轮：未遂→实际语义反转检测
    // "差点杀死" → "杀死"：未遂变成实际发生 = 语义反转
    const nearMissReversal = detectNearMissReversal(rawEvent.nearMiss, bestMatch.event.nearMiss);
    if (nearMissReversal && negationSharesContent) {
      replacedEvents.push({
        rawEventId: rawEvent.id,
        editorialEventId: bestMatch.event.id,
        subject: rawEvent.subject,
        rawAction: rawEvent.action,
        editorialAction: bestMatch.event.action,
        rawSentence: rawEvent.sentence,
        rawSpan: rawEvent.evidenceSpan,
        editorialSentence: bestMatch.event.sentence,
        editorialSpan: bestMatch.event.evidenceSpan,
        similarity: bestMatch.similarity,
        reversal: true,
        antonymPair: null,
        critical: true,
        rawCriticalAction: rawEvent.action,
        reason: `未遂语义反转：raw ${rawEvent.nearMiss ? "未遂" : "实际"} → editorial ${bestMatch.event.nearMiss ? "未遂" : "实际"}（动作 '${rawEvent.action}' 的发生状态被反转，单个即阻断）`,
      });
      continue;
    }

    // P0 第五轮：同主体同动作替换客体检测
    // "叶尘攻击林默" → "叶尘攻击王五"：同一主体同一动作，但客体被替换
    // 这改变了关键动作的承受者（谁被攻击/谁收到物品），是故事关键事件替换，单个即阻断
    //
    // 条件：
    // - subjectMatch=true（同一主体）
    // - actionMatch=true（同一动作或同义动作）
    // - objectMatch=false（客体不同）
    // - raw 和 editorial 都有非空客体（≥2字符，过滤代词/单字残留）
    // - 主客体不相同（防止 "梦堂→梦堂" 类自指事件误报）
    // - 双方客体都必须是已知实体（knownEntitySet）
    //   理由：客体替换针对"关键事件承受者（角色/物品实体）被换"的情形，
    //   不针对动词补语片段差异（如 "开始松动" vs "松动了" 是风格改写，非实体替换）。
    //   用户验收反例（"林默"→"王五"、"林默玉玺"→"王五玉玺"）的客体均为已知实体。
    //
    // 注意：alias 级别的客体差异（如 "林默"→"林墨"）在此处也会触发阻断，
    // alias 规范化属于 P1 范畴（unified-entry.ts canonical entity ID），
    // 修复 P1 后同 ID 的 alias 替换会在事件抽取阶段归一化，不再到达此检查。
    if (
      bestMatch.subjectMatch &&
      bestMatch.actionMatch &&
      !bestMatch.objectMatch &&
      rawEvent.object !== "" &&
      rawEvent.object.length >= 2 &&
      bestMatch.event.object !== "" &&
      bestMatch.event.object.length >= 2 &&
      rawEvent.subject !== rawEvent.object &&
      bestMatch.event.subject !== bestMatch.event.object &&
      knownEntitySet.has(rawEvent.object) &&
      knownEntitySet.has(bestMatch.event.object)
    ) {
      replacedEvents.push({
        rawEventId: rawEvent.id,
        editorialEventId: bestMatch.event.id,
        subject: rawEvent.subject,
        rawAction: rawEvent.action,
        editorialAction: bestMatch.event.action,
        rawSentence: rawEvent.sentence,
        rawSpan: rawEvent.evidenceSpan,
        editorialSentence: bestMatch.event.sentence,
        editorialSpan: bestMatch.event.evidenceSpan,
        similarity: bestMatch.similarity,
        reversal: false,
        antonymPair: null,
        critical: true,
        rawCriticalAction: rawEvent.action,
        reason: `客体替换：raw '${rawEvent.subject}→${rawEvent.action}→${rawEvent.object}' vs editorial '${bestMatch.event.subject}→${bestMatch.event.action}→${bestMatch.event.object}'（同一主体同一动作，但客体被替换，关键事件承受者被改变，单个即阻断）`,
      });
      continue;
    }

    // P0 第六轮：客体删除 / 未知实体替换检测
    //
    // 用户验收反例（第六轮，生产 gate 实测）：
    //   - "叶尘攻击林默" → "叶尘攻击。林默站在一旁"（客体被删除）：preserved=true（应阻断）
    //   - "叶尘攻击林默" → "叶尘攻击赵六"（赵六不在实体表）：preserved=true（应阻断）
    //
    // 第五轮的客体替换检测要求"双方客体均非空且都在 knownEntitySet"，遗漏了：
    //   (a) 客体删除：editorial 客体为空（关键事件承受者被删）
    //   (b) 未知实体替换：editorial 客体非空但不在实体表（承受者被换成未知实体）
    //
    // 新规则（结构化客体完整性检测）：
    //   - subjectMatch=true, actionMatch=true, objectMatch=false
    //   - raw.object 是已知实体（关键事件承受者，≥2 字符）
    //   - raw.object 不在 editorial 匹配事件的 entities 中
    //     （确认承受者真的从该事件丢失，而非仅抽取差异/同义改写）
    //   - editorial 客体为空（删除）或非已知实体（未知替换）
    //   → critical 阻断（单个即阻断）
    //
    // 防误报：
    //   - "叶尘攻击林默" → "叶尘向林默发起攻击"：editorial 事件 entities 仍含 "林默"
    //     → 不阻断（承受者仍在事件中，只是抽取器未捕获为 object）
    //   - alias 改写："叶尘攻击林默" → "小尘攻击林默"：subject 经 alias 规范化后匹配，
    //     object 仍为 "林默"（objectMatch=true）→ 不会到达此检查
    if (
      bestMatch.subjectMatch &&
      bestMatch.actionMatch &&
      !bestMatch.objectMatch &&
      rawEvent.object !== "" &&
      rawEvent.object.length >= 2 &&
      rawEvent.subject !== rawEvent.object &&
      knownEntitySet.has(rawEvent.object) &&
      !bestMatch.event.entities.includes(rawEvent.object) &&
      // P0 第七轮 canary 修复：要求内容共享，防止 actionMatch 子串匹配误报。
      // canary 实测：raw "看" 通过 includes() 匹配 editorial "看到"，但两句
      // 不共享显著内容，object 差异来自不同事件而非客体替换。
      hasSharedSignificantBigram(rawEvent.sentence, bestMatch.event.sentence, knownEntities)
    ) {
      const edObj = bestMatch.event.object;
      const edObjEmpty = edObj === "" || edObj.length < 2;
      const edObjUnknown = !edObjEmpty && !knownEntitySet.has(edObj);
      if (edObjEmpty || edObjUnknown) {
        const lossType = edObjEmpty ? "客体删除" : "客体替换为未知实体";
        const edObjDesc = edObjEmpty ? "(空)" : edObj;
        replacedEvents.push({
          rawEventId: rawEvent.id,
          editorialEventId: bestMatch.event.id,
          subject: rawEvent.subject,
          rawAction: rawEvent.action,
          editorialAction: bestMatch.event.action,
          rawSentence: rawEvent.sentence,
          rawSpan: rawEvent.evidenceSpan,
          editorialSentence: bestMatch.event.sentence,
          editorialSpan: bestMatch.event.evidenceSpan,
          similarity: bestMatch.similarity,
          reversal: false,
          antonymPair: null,
          critical: true,
          rawCriticalAction: rawEvent.action,
          reason: `${lossType}：raw '${rawEvent.subject}→${rawEvent.action}→${rawEvent.object}' vs editorial '${bestMatch.event.subject}→${bestMatch.event.action}→${edObjDesc}'（同一主体同一动作，但关键事件承受者 "${rawEvent.object}" 在 editorial 事件中丢失，单个即阻断）`,
        });
        continue;
      }
    }

    // 动作反转检测（state_description 不参与）
    const canReverse =
      rawEvent.eventType === "action" || rawEvent.eventType === "state_change";
    const reversal = canReverse
      ? detectActionReversal(rawEvent.sentence, bestMatch.event.sentence)
      : { reversed: false, pair: null as readonly [string, string] | null };

    // P0-1：当 subject 匹配但 action 和 object 都不匹配时：
    // - 若检测到反义词对 → 记录为替换事件（硬证据，单个即阻断）
    // - 若两事件共享显著内容 且 raw 动作是关键动作 → 记录为关键替换事件（单个即阻断）
    // - 若两事件共享显著内容 → 记录为低相似度替换事件（累计阈值阻断）
    // - 若不共享显著内容 → 记录为 advisory（同角色不同事件，不阻断）
    //
    // P0 第六轮 P1-3 修复（canary 真实误阻断治理，符合用户"主体/客体结构化关系绑定"指令）：
    // 旧逻辑在 !actionMatch && !objectMatch 时，只要 raw 动作是关键动作就判为关键替换，
    // 不检查两事件是否共享显著内容。canary 实测反例：
    //   raw "李强回来" → editorial "李强看"（同角色不同事件，不共享实体名以外的显著片段）
    //   因 "回来" 在 CRITICAL_ACTIONS 中被误判为关键动作替换，单个即阻断。
    //   raw "李一凡拿起筷子" → editorial "李一凡吃" 同理误阻断。
    //
    // 新规则（结构化内容绑定）：
    //   action/object 均不匹配时，内容共享是"同一事件被改写"的必要前提。
    //   不共享显著内容 = 同角色不同事件 → advisory，无论 raw 动作是否"关键"。
    //   真正的关键替换（如 "叶尘攻击林默"→"叶尘防御林默"）因 objectMatch=true 走下方
    //   isReplaced 路径，不受此约束影响。
    //
    // P0 第四轮：state_description 事件（无动作）不触发替换检测。
    // 例如 raw "长乘呢？"（纯描述）因一对一匹配占用了 editorial "长乘未归"（有动作），
    // 不应因 action/object 不同而触发"事件结构替换"。描述性事件没有动作可被"替换"。
    if (
      !bestMatch.actionMatch &&
      !bestMatch.objectMatch &&
      !reversal.reversed &&
      (rawEvent.eventType === "action" || rawEvent.eventType === "state_change")
    ) {
      // P0 第六轮 P1-3：先计算内容共享，作为替换判定的前提
      const hasSubjectMatch = bestMatch.subjectMatch;
      const rawHasObject = rawEvent.object !== "" && rawEvent.object.length >= 2;
      const sharesContentBeyondEntity = hasSharedSignificantBigram(
        rawEvent.sentence,
        bestMatch.event.sentence,
        knownEntities,
      );
      // P0-1 第二轮：检测关键动作替换（如"交出"→"看"，非反义词对但关键动作被替换）
      //
      // P0 第六轮 P1-3 修复（canary 真实误阻断治理）：
      // 当 hasSubjectMatch=true（同角色匹配）时，要求共享显著内容才判关键替换——
      // 防止同角色做不同事的正常改写被误判（canary 反例：raw "李强回来" → editorial "李强看"）。
      // 当 hasSubjectMatch=false（隐式 bare verb，如 "攻击"→"看一眼"）时，匹配按位置进行，
      // 不存在"同角色不同事件"歧义，关键替换不需要共享内容（保留 round3 验收反例行为）。
      const criticalReplacement =
        (!hasSubjectMatch || sharesContentBeyondEntity)
          ? detectCriticalReplacement(rawEvent.action, bestMatch.event.action)
          : { critical: false, rawCriticalAction: null };
      if (criticalReplacement.critical) {
        // P0-1 第二轮：关键动作被替换 → 单个即阻断（不降级为 advisory）
        replacedEvents.push({
          rawEventId: rawEvent.id,
          editorialEventId: bestMatch.event.id,
          subject: rawEvent.subject,
          rawAction: rawEvent.action,
          editorialAction: bestMatch.event.action,
          rawSentence: rawEvent.sentence,
          rawSpan: rawEvent.evidenceSpan,
          editorialSentence: bestMatch.event.sentence,
          editorialSpan: bestMatch.event.evidenceSpan,
          similarity: bestMatch.similarity,
          reversal: false,
          antonymPair: null,
          critical: true,
          rawCriticalAction: criticalReplacement.rawCriticalAction,
          reason: `关键动作替换：raw 动作 '${criticalReplacement.rawCriticalAction}' 是关键动作（改变故事状态），editorial 替换为 '${bestMatch.event.action}'（主体 '${rawEvent.subject}'，对象 '${rawEvent.object}' → '${bestMatch.event.object}'），单个关键事件替换即阻断`,
        });
      } else if (
        (!hasSubjectMatch && rawHasObject) ||
        (hasSubjectMatch && rawHasObject && sharesContentBeyondEntity)
      ) {
        // 低相似度替换（累计阈值阻断）：
        // - bare verb + 有 object → 按位置匹配可靠，记为低相似度替换
        // - 同角色 + 有 object + 共享显著内容 → 同一事件被改写，记为低相似度替换
        replacedEvents.push({
          rawEventId: rawEvent.id,
          editorialEventId: bestMatch.event.id,
          subject: rawEvent.subject,
          rawAction: rawEvent.action,
          editorialAction: bestMatch.event.action,
          rawSentence: rawEvent.sentence,
          rawSpan: rawEvent.evidenceSpan,
          editorialSentence: bestMatch.event.sentence,
          editorialSpan: bestMatch.event.evidenceSpan,
          similarity: bestMatch.similarity,
          reversal: false,
          antonymPair: null,
          critical: false,
          rawCriticalAction: null,
          reason: `事件结构替换：subject '${rawEvent.subject}' 相同但 action/object 完全不同（raw action='${rawEvent.action}' object='${rawEvent.object}' → editorial action='${bestMatch.event.action}' object='${bestMatch.event.object}'），疑似事件被改写`,
        });
      } else {
        // 同角色但不共享显著内容（同角色不同事件）→ advisory，不阻断
        advisorySimilarities.push({
          rawEventId: rawEvent.id,
          editorialEventId: bestMatch.event.id,
          similarity: bestMatch.similarity,
          sharesBigram: sharesContentBeyondEntity,
          note: `subject '${rawEvent.subject}' 相同但不共享显著内容，action/object 完全不同（同角色不同事件，非事件替换）`,
        });
      }
      continue;
    }

    // 替换判定：
    // - 动作反转（反义词对）→ 替换事件（硬证据，单个即阻断）
    // - 关键动作替换（P0-1 第二轮）→ 替换事件（硬证据，单个即阻断）
    // - 低相似度 且 不共享关键双字片段 → 替换事件（需累积到阈值）
    //
    // P0 第四轮：state_description 事件（无动作）不触发替换判定。
    // 描述性事件没有动作可被"替换"，低相似度只记 advisory。
    const rawHasAction = rawEvent.eventType === "action" || rawEvent.eventType === "state_change";
    const lowSimilarity = bestMatch.similarity < replacedSimilarityThreshold;
    const sharesBigram = hasSharedSignificantBigram(
      rawEvent.sentence,
      bestMatch.event.sentence,
      knownEntities,
    );
    // P0-1 第二轮：即使 action/object 有部分匹配，若 raw 动作是关键动作且 editorial 动作显著不同，仍视为替换
    const criticalReplacement = detectCriticalReplacement(
      rawEvent.action,
      bestMatch.event.action,
    );
    // 关键动作替换优先：即使 sharesBigram=true，关键动作被不同动作替换也应阻断
    // P0 第七轮 canary 修复：低相似度替换路径从 isReplaced 移除，全部降为 advisory。
    // canary 实测反例：
    // - similarity=0：raw "以前他看不见" -> editorial "能看到盐粒"（"看" 是 "看到" 子串
    //   导致 actionMatch=true，但两句无任何共享显著字符）
    // - similarity=0.2：raw "冷静地看着目标逼近" -> editorial 另一句（similarity>0
    //   但 !sharesBigram，actionMatch 来自 "看" 子串匹配）
    // 根因：actionMatch 使用 includes() 子串匹配，"看" 匹配 "看到"/"看不见" 等不同
    // 动词。当 !sharesBigram 时，匹配很可能是虚假的，不应作为替换证据。
    // 保留 reversal/critical 路径：它们是结构性证据，不依赖文本相似度。
    // 低相似度替换仍由 !actionMatch && !objectMatch 路径（line 961-984）处理。
    const isReplaced = rawHasAction && (
      reversal.reversed
      || criticalReplacement.critical
    );

    if (isReplaced) {
      replacedEvents.push({
        rawEventId: rawEvent.id,
        editorialEventId: bestMatch.event.id,
        subject: rawEvent.subject,
        rawAction: rawEvent.action,
        editorialAction: bestMatch.event.action,
        rawSentence: rawEvent.sentence,
        rawSpan: rawEvent.evidenceSpan,
        editorialSentence: bestMatch.event.sentence,
        editorialSpan: bestMatch.event.evidenceSpan,
        similarity: bestMatch.similarity,
        reversal: reversal.reversed,
        antonymPair: reversal.pair,
        critical: criticalReplacement.critical,
        rawCriticalAction: criticalReplacement.rawCriticalAction,
        reason: reversal.reversed
          ? `动作反转：raw 句含 '${reversal.pair![0]}'，editorial 句含 '${reversal.pair![1]}'（主体 '${rawEvent.subject}' 的事件被反转）`
          : criticalReplacement.critical
            ? `关键动作替换：raw 动作 '${criticalReplacement.rawCriticalAction}' 是关键动作，editorial 替换为 '${bestMatch.event.action}'（主体 '${rawEvent.subject}'），单个关键事件替换即阻断`
            : `事件结构替换：raw 句与 editorial 最佳匹配句相似度 ${bestMatch.similarity.toFixed(3)} < ${replacedSimilarityThreshold}，且不共享关键双字片段（主体 '${rawEvent.subject}' 的事件被改写）`,
      });
    } else if (lowSimilarity) {
      // 低相似度但共享双字片段 → advisory（可能为同义改写）
      // 注意：sharesBigram 在原实现中计算但未直接使用，保留计算以维持语义等价
      advisorySimilarities.push({
        rawEventId: rawEvent.id,
        editorialEventId: bestMatch.event.id,
        similarity: bestMatch.similarity,
        sharesBigram: true,
        note: `低相似度但共享关键双字片段，可能为同义改写`,
      });
    }
  }

  return { replacedEvents, advisorySimilarities, matchedEditorialIds };
}
