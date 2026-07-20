/**
 * PiNovelStudio — Anti-AI Auto Patch
 *
 * 从 anti-ai-detector.ts 提取的纯函数模块（refactor，行为零变化）。
 * 确定性 AI 模式自动修复（非 LLM 调用）：
 *   1. 删除完全重复句（委托 anti-ai-repeated-sentence-cleaner）
 *   2. 删除 AI 结尾套话（欲知后事/一切才刚开始/注定不平静 等）
 *   3. 删除感知确认动词开头（他看到/她听到/他感觉到）
 *   4. 修复"不是X，是/而是Y"否定铺垫（保留 Y）
 *   5. 拆分四字格堆叠（idiom stacking local span patch）
 *
 * 提取原因：这组函数在 anti-ai-detector.ts 内部零调用，仅被外部消费者
 * （orchestrator/quality 模块）通过 re-export 使用。autoPatchAIPatterns
 * 依赖 removeExactRepeatedSentences（已提取到 anti-ai-repeated-sentence-cleaner），
 * 其余函数完全自包含。
 */

import { removeExactRepeatedSentences } from "./anti-ai-repeated-sentence-cleaner.js";

// ============================================================================
// P6-T6: 自动修复 AI 模式 — 用于 Writer's Room 重写循环
//
// 对文本做确定性修复（非 LLM 调用）：
//   1. 删除完全重复句
//   2. 删除 AI 结尾套话（欲知后事/一切才刚开始/注定不平静 等）
//   3. 删除感知确认动词开头（他看到/她听到/他感觉到）
// 返回修复后的文本和修复计数。
// ============================================================================

/** AI 结尾套话模式（与 ENDING_AI_PATTERNS 同步） */
const AUTO_PATCH_ENDING_PATTERNS: readonly RegExp[] = [
  /欲知后事[^。\n]*[。.\n]?/g,
  /一切才刚刚?开始[^。\n]*[。.\n]?/g,
  /注定不平静[^。\n]*[。.\n]?/g,
  /更大的危险[^。\n]*[。.\n]?/g,
  /意想不到的人[^。\n]*[。.\n]?/g,
  /他没有想到[^。\n]*[。.\n]?/g,
  /故事才刚刚[^。\n]*[。.\n]?/g,
  /事情远比[^。\n]*[。。\n]?/g,
  /一个神秘[^。\n]*[。.\n]?/g,
  /而这，?只是开始[^。\n]*[。.\n]?/g,
];

/** 感知确认动词开头模式 */
const AUTO_PATCH_PERCEPTION_PATTERNS: readonly RegExp[] = [
  /他看到了/g,
  /她看到了/g,
  /它看到了/g,
  /他听到了/g,
  /她听到了/g,
  /它听到了/g,
  /他感觉到了/g,
  /她感觉到了/g,
  /它感觉到了/g,
  /他意识到了/g,
  /她意识到了/g,
  /它意识到了/g,
  // [FIX 2026-06-26] 补足"看见了/闻到了/触到了/察觉到了"系列(均带"了"感知完成标记)
  // 这些是感知确认冗余的常见形态;pattern fix 提示"直接写感知对象",删除动词让对象直接呈现
  /他看见了/g,
  /她看见了/g,
  /它看见了/g,
  /他闻到了/g,
  /她闻到了/g,
  /它闻到了/g,
  /他触到了/g,
  /她触到了/g,
  /它触到了/g,
  /他察觉到了/g,
  /她察觉到了/g,
  /它察觉到了/g,
];

export interface AutoPatchResult {
  readonly patchedText: string;
  readonly fixesApplied: number;
  readonly fixDetails: readonly string[];
}

/**
 * P6-T6: 自动修复 AI 模式
 *
 * 对文本做确定性修复，返回修复后的文本和修复计数。
 * 用于 Writer's Room 重写循环中 anti-ai 节点的 output。
 */
export function autoPatchAIPatterns(text: string): AutoPatchResult {
  if (!text) return { patchedText: text, fixesApplied: 0, fixDetails: [] };

  let patched = text;
  const details: string[] = [];
  let totalFixes = 0;

  // 1. 删除完全重复句
  const repeatResult = removeExactRepeatedSentences(patched);
  if (repeatResult.removedCount > 0) {
    patched = repeatResult.text;
    totalFixes += repeatResult.removedCount;
    details.push(`删除重复句 ${repeatResult.removedCount} 处`);
  }

  // 2. 删除 AI 结尾套话
  for (const pattern of AUTO_PATCH_ENDING_PATTERNS) {
    const matches = patched.match(pattern);
    if (matches && matches.length > 0) {
      patched = patched.replace(pattern, "");
      totalFixes += matches.length;
      details.push(`删除结尾套话 ${matches.length} 处: ${matches[0].slice(0, 20)}`);
    }
  }

  // 3. 删除感知确认动词（替换为空，让后续描写直接呈现）
  for (const pattern of AUTO_PATCH_PERCEPTION_PATTERNS) {
    const matches = patched.match(pattern);
    if (matches && matches.length > 0) {
      patched = patched.replace(pattern, "");
      totalFixes += matches.length;
      details.push(`删除感知动词 ${matches.length} 处`);
    }
  }

  // 4. [FIX 2026-06-26] 修复 resource_negative_is_shortcut: 删除"不是X，是/而是Y"否定铺垫,保留 Y
  // 仅修复带修饰语(一次/普通/被等)或长成分(>4字)的 AI 腔叙事否定铺垫;
  // 文学修辞(人名/代词/感官/具体事物/情绪认知对比,通常 ≤4 字)不修改。
  // 例:"不是一次普通的异常，而是住院记录被改写后的现场证据" → "住院记录被改写后的现场证据"
  const NEGATIVE_SHORTCUT_PATTERN = /这?不是([^。！？\n]{2,30})(?:而是|[，,。]是|——是|—是|--是|-是)([^。！？\n]{2,40})/g;
  const MODIFIER_MARKER = /(?:一次|一个|一种|一些|那种|这种|某|某次|某个|普通|真正|所谓|被|的|地|得|着|了|过|已经|曾经|刚刚|正在|似乎|仿佛|犹如|宛如|像是|好比|如同)/;
  // 情绪/认知状态词:短情绪对比(如"不是惊讶，是认得")是文学修辞,不修改
  const EMOTION_COGNITION = /^(?:惊讶|惊|愣|怔|呆|懵|痴|傻|怒|气|愤|恼|恨|怕|惧|慌|急|忧|愁|苦|悲|哀|痛|疼|累|倦|疲|乏|困|饿|渴|饱|醉|醒|喜|乐|笑|哭|认得|认识|明白|懂|会|知道|清楚|熟悉|陌生|警觉|清醒|迷茫|疑惑|犹豫|坚决|镇定|冷静|平静|认命|抗拒|顺从|妥协|坚持|放弃|害怕|恐惧|紧张|焦虑|不安|担心|忐忑|迟疑|踌躇|纠结|矛盾|激动|兴奋|低落|失落|失望|满足|庆幸|后悔|无奈|不甘|愤怒|生气|开心|快乐|悲伤|难过|幸福|不幸|幸运|倒霉)$/;
  let shortcutFixes = 0;
  patched = patched.replace(NEGATIVE_SHORTCUT_PATTERN, (fullMatch, partA: string, partB: string) => {
    const a = partA.replace(/[，,。]+$/, "").trim();
    const b = partB.trim();
    // [FIX 2026-06-26] 短情绪/认知对比(A/B 均 ≤4 字且至少一方是情绪词)是文学修辞,不修改
    if (a.length <= 4 && b.length <= 4 && (EMOTION_COGNITION.test(a) || EMOTION_COGNITION.test(b))) {
      return fullMatch;
    }
    // 仅修复带修饰语或长成分的 AI 腔否定铺垫;短文学修辞(≤4字无修饰)保留
    const aHasModifier = MODIFIER_MARKER.test(a);
    const bHasModifier = MODIFIER_MARKER.test(b);
    const aIsLong = a.length > 4;
    const bIsLong = b.length > 4;
    if (aHasModifier || bHasModifier || aIsLong || bIsLong) {
      shortcutFixes++;
      return b; // 保留 partB,删除"不是X，是"否定铺垫
    }
    return fullMatch; // 文学修辞,不修改
  });
  if (shortcutFixes > 0) {
    totalFixes += shortcutFixes;
    details.push(`修复否定铺垫 ${shortcutFixes} 处: 删除"不是X，是"保留 Y`);
  }

  return {
    patchedText: patched,
    fixesApplied: totalFixes,
    fixDetails: details,
  };
}

// ============================================================================
// P24-续六 Fix5: idiom stacking 本地 span patch
// ============================================================================
//
// 治理方案要求：Stage 8 local_hotspots / idiom stacking 不应长期作为 hard_block，
// 应走本地替换或 span patch，过 PatchQualityComparator。
//
// 策略：idiom stacking 检测要求单句含 >= 3 个四字格（按 。！？\n 分句）。
// 本函数把命中句中连接四字格的 逗号/顿号 替换为 句号，使每个四字格落入独立句子，
// 从而打破"单句 3+ 四字格"的堆叠模式。每个新句子只含 1 个四字格，低于阈值。
//
// 例："风平浪静，云淡风轻，水到渠成。" → "风平浪静。云淡风轻。水到渠成。"
//
// 该 patch 走 PatchQualityComparator 校验：若 craft score 退化或引入新 critical issue，
// comparator 会拒绝，原文不被覆盖。

/** 判断 4 字短语是否"像成语/四字格"（与 analyzeLocalHotspots 内 isLikelyIdiom 同逻辑） */
function isLikelyIdiomPhrase(phrase: string, characterNames: Set<string>): boolean {
  if (/[的了着过]/.test(phrase)) return false;
  if (/[还也都又再才就刚正已将没不无非]/.test(phrase)) return false;
  if (/[一二三四五六七八九十百千万几]/.test(phrase)) return false;
  if (/^(推开|走进|拿起|放下|打开|关上|坐起|站起|转身|抬头|低头|伸手|缩手|迈步|踏上|走出|跑出)/.test(phrase)) return false;
  if (/(脑子|心里|眼前|脸上|手上|脚下|背后|身上|怀里|身边)/.test(phrase)) return false;
  if (/^(引擎|车门|皮鞋|脚步|手机|屏幕|门板|窗帘|灯|光|车|表|钟|镜|锁|钥匙|名片|信|纸|笔|杯|碗|筷|刀|枪|剑|棍|针|线|管|链)/.test(phrase)) return false;
  if (/(在|上|下|里|外|中|间|来|去|出|入|起|开|回|到|着|了|过)$/.test(phrase)) return false;
  if (characterNames.size > 0) {
    for (const name of characterNames) {
      if (phrase.includes(name) || name.includes(phrase)) return false;
    }
  }
  return true;
}

export interface IdiomStackingRepairResult {
  readonly repairedText: string;
  readonly fixesApplied: number;
  readonly fixDetails: readonly string[];
}

/**
 * 本地修复 idiom stacking：把命中句中四字格之间的 逗号/顿号 替换为 句号。
 *
 * @param text 原始正文
 * @param characterNames 角色名集合（用于排除角色名片段被误判为四字格）
 */
export function repairIdiomStackingLocally(
  text: string,
  characterNames: Set<string> = new Set(),
): IdiomStackingRepairResult {
  if (!text) return { repairedText: text, fixesApplied: 0, fixDetails: [] };

  const IDIOM_STACKING_THRESHOLD = 3;
  const fourCharIdiomPattern = /(?:^|[，、,])\s*([\u4e00-\u9fff]{4})[，、,]\s*([\u4e00-\u9fff]{4})[，、,]\s*([\u4e00-\u9fff]{4})(?:[，、,]\s*([\u4e00-\u9fff]{4}))*/g;
  // 连接四字格的分隔符（逗号/顿号 + 可选空白）
  const idiomConnectorPattern = /([\u4e00-\u9fff]{4})[，、,]\s*([\u4e00-\u9fff]{4})/g;

  const details: string[] = [];
  let totalFixes = 0;

  // 按 。！？\n 分句，逐句处理
  const sentenceSplit = text.split(/([。！？\n])/);
  const repairedParts: string[] = [];
  for (let i = 0; i < sentenceSplit.length; i++) {
    const part = sentenceSplit[i];
    // 保留分隔符原样
    if (part === "。" || part === "！" || part === "？" || part === "\n") {
      repairedParts.push(part);
      continue;
    }
    const trimmed = part.trim();
    if (trimmed.length === 0) {
      repairedParts.push(part);
      continue;
    }
    // 排除代词/人称开头的叙事句
    if (/^[他她它我你你们们他们她们]/.test(trimmed)) {
      repairedParts.push(part);
      continue;
    }
    // 排除角色名开头的叙事句
    let startsWithName = false;
    if (characterNames.size > 0) {
      for (const name of characterNames) {
        if (name.length >= 2 && trimmed.startsWith(name)) {
          startsWithName = true;
          break;
        }
      }
    }
    if (startsWithName) {
      repairedParts.push(part);
      continue;
    }

    // 检测该句是否命中 idiom stacking
    let m: RegExpExecArray | null;
    fourCharIdiomPattern.lastIndex = 0;
    let hitCount = 0;
    while ((m = fourCharIdiomPattern.exec(trimmed)) !== null) {
      const matchStr = m[0];
      const phraseCount = matchStr.split(/[，、,]\s*/).filter(p => p.length === 4 && isLikelyIdiomPhrase(p, characterNames)).length;
      if (phraseCount >= IDIOM_STACKING_THRESHOLD) {
        hitCount++;
      }
    }

    if (hitCount === 0) {
      repairedParts.push(part);
      continue;
    }

    // 命中：把四字格之间的 逗号/顿号 替换为 句号，打破堆叠
    let repairedSentence = part;
    idiomConnectorPattern.lastIndex = 0;
    repairedSentence = repairedSentence.replace(idiomConnectorPattern, (fullMatch, p1: string, p2: string) => {
      // 仅当两个四字格都"像成语"时才拆分
      if (isLikelyIdiomPhrase(p1, characterNames) && isLikelyIdiomPhrase(p2, characterNames)) {
        return `${p1}。${p2}`;
      }
      return fullMatch;
    });

    if (repairedSentence !== part) {
      totalFixes += hitCount;
      details.push(`拆分四字格堆叠 ${hitCount} 处: ${trimmed.slice(0, 30)}...`);
    }
    repairedParts.push(repairedSentence);
  }

  return {
    repairedText: repairedParts.join(""),
    fixesApplied: totalFixes,
    fixDetails: details,
  };
}
