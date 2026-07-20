/**
 * PiNovelStudio — P41 任务2：流水账/平铺直叙本地诊断器（FlatNarrationScanner）
 *
 * 背景：
 *   P33/P35 解决了中文自然感、翻译腔、网文范式评分，但 ch17 trace 显示中文自然感通过，
 *   实际读感仍差。根因不是单句是否中文，而是 Stage 2 缺少"叙事取舍"机制，导致：
 *     - 所有细节平均铺开（过门、铺陈、战斗、钩子使用相近篇幅）
 *     - 大量人物动作罗列，没有主次
 *     - "比平时近半寸/短半截"这类测量式关系描写
 *     - 高冲突事件只有动作没有"压迫→选择→后果"
 *     - 细节写出来但不推动风险/选择/信息/关系
 *
 * 职责：
 *   对每个事件生成的正文做本地启发式扫描，输出 7 类 issue + 综合评分 + verdict。
 *   不调用 LLM、不修改正文、不写文件，只返回诊断结果。
 *
 * 7 类检测维度（与用户 P41 任务单对齐）：
 *   1. action_list             连续 3 段动作/状态罗列，无风险/选择/信息/关系变化
 *   2. nonfunctional_detail    细节无功能归属（不触发动作/不暴露信息/不改变关系/不埋钩子）
 *   3. overlong_bridge         过门段超过 180 字仍未进入冲突/异常/选择/钩子
 *   4. summary_exposition      概述段长篇背景交代，无对话/无动作/无冲突
 *   5. weak_scene_focus        重点场没写透（篇幅不足或缺关键节拍）
 *   6. measurement_relationship "比平时近半寸/短半截"测量式关系描写
 *   7. payoff_underwritten     高冲突事件缺"压迫→选择→后果/代价/反打"
 *
 * 阈值（P41 第一阶段：只写 trace，不 hard block）：
 *   - score >= 75：pass
 *   - 55 <= score < 75：review（写入 trace，作为 Stage 5/8 hints）
 *   - score < 55：block candidate（先触发一次 rewrite_event，仍失败则 needsHumanReview）
 *   - measurementRelationshipCount >= 3：强制 review
 *   - critical action_list >= 2：block candidate
 *
 * 不变量：
 *   - 不修改正文，不调用 LLM。
 *   - verdict=block 不立即硬阻断（由 Stage 2 调用方决定是否 rewrite_event）。
 *   - 所有 issue 必须带 excerpt + suggestion，便于重写提示注入。
 *   - 正常白描/过门短而有效/payoff 写透应 pass（不能误杀）。
 */

/** Phase 7: 从 narrative-weight-compiler 内联，解除 legacy 耦合 */
type NarrativeWeightClass =
  | "coreScene"
  | "payoffScene"
  | "bridgeScene"
  | "summaryScene"
  | "omitCandidate";

// ============================================================================
// 类型定义
// ============================================================================

/** 流水账问题类型（7 类） */
export type FlatNarrationIssueType =
  | "action_list"
  | "nonfunctional_detail"
  | "overlong_bridge"
  | "summary_exposition"
  | "weak_scene_focus"
  | "measurement_relationship"
  | "payoff_underwritten";

/** 严重程度 */
export type FlatNarrationSeverity = "info" | "review" | "critical";

/** 单条流水账问题 */
export interface FlatNarrationIssue {
  type: FlatNarrationIssueType;
  severity: FlatNarrationSeverity;
  /** 命中处上下文片段 */
  excerpt: string;
  /** 修订建议（中文，简短，可注入重写提示） */
  suggestion: string;
  /** 命中在原文中的字符偏移（近似，用于 trace 比对） */
  index?: number;
}

/** 扫描结果 */
export interface FlatNarrationScanResult {
  /** 综合评分 0-100，越高越好 */
  score: number;
  /** 判定：pass / review / block（block 第一阶段不硬阻断） */
  verdict: "pass" | "review" | "block";
  /** 所有命中（按 index 升序） */
  issues: FlatNarrationIssue[];
  /** 流水账命中密度（每千字） */
  densityPerThousand: number;
  /** 无功能细节命中数 */
  functionlessDetailCount: number;
  /** 测量式关系描写命中数 */
  measurementRelationshipCount: number;
  /** 诊断摘要（中文） */
  summary: string;
}

/** 扫描器输入 */
export interface FlatNarrationScannerInput {
  /** 事件生成的正文 */
  text: string;
  /** 事件冲突等级（1-5），用于 payoff_underwritten 判定 */
  conflictLevel?: number;
  /** 事件镜头权重分类，用于 weak_scene_focus / payoff_underwritten 判定 */
  weightClass?: NarrativeWeightClass;
  /** 事件 ID（用于 trace 比对，可选） */
  eventId?: string;
}

// ============================================================================
// 关键词表
// ============================================================================

/**
 * 功能 delta 关键词：段落含这些词视为"有功能"（推动风险/选择/信息/关系）。
 * 用于判定 nonfunctional_detail / action_list。
 */
const FUNCTIONAL_DELTA_PATTERNS: RegExp[] = [
  /风险|危机|威胁|逼迫|绝路|退路|期限|最后通牒/u,
  /选择|决定|抉择|决策|咬咬牙|狠下心|豁出去|赌|拼了|宁可|宁愿|迟疑/u,
  /揭示|真相|线索|证据|发现|暴露|秘密|底牌|原来|其实|早已/u,
  /信任|敌意|合作|背叛|结盟|对峙|冲突|翻脸|倒戈|加码|退缩/u,
  /代价|损失|反打|反扑|反噬|后果|牺牲|受伤|失血|资源损失/u,
  /钩子|悬念|未结|异变|异常|不对劲|变故|突发/u,
];

/**
 * 测量式关系描写 patterns（用户验收标准要求识别）。
 *
 * 命中样例：
 *   - "说话比往常短了半截"
 *   - "肩膀离他比平时近半寸"
 *   - "比平时近了小半臂"
 *   - "比平时近了半寸"
 *   - "比平时短了半截"
 *   - "比平时远了半步"
 *   - "比平时远几寸"
 */
const MEASUREMENT_RELATIONSHIP_PATTERNS: RegExp[] = [
  // 比(平时|往常|平常)...(近|远|短|长|高|低|快|慢|窄|宽|硬|软)...(测量单位)
  /比(?:平时|往常|平常)[^，。；！？\n]{0,12}(?:近|远|短|长|高|低|快|慢|窄|宽|硬|软|冷|热|沉|轻)[了得]?[^，。；！？\n]{0,6}(?:半寸|半步|半臂|半截|几寸|几分|几步|小半臂|小半寸|一寸|一分|一步|一截|半拍|几分)/u,
  // (近|远|短|长)了 + 测量单位（"短了半截/近了半寸"独立出现也算）
  /(?:近|远|短|长|高|低|快|慢)了(?:半寸|半步|半臂|半截|几寸|几分|几步|小半臂|小半寸|一寸|一分|一步|一截|半拍)/u,
  // "比平时近半寸" 简化变体（无"了"）
  /比(?:平时|往常|平常)(?:近|远|短|长|高|低|快|慢)(?:半寸|半步|半臂|半截|几寸|几分|几步|小半臂|小半寸)/u,
];

/**
 * 动作动词（用于 action_list 检测）。必须带 /g 才能用 .match() 计数。
 *
 * P42 Task 2：改为 export，让 GroupCastFocusGate 的 background_action_list 规则可复用
 * 同一份动作动词表，避免两处定义漂移。flat-narration-scanner 内部使用方式不变。
 */
export const ACTION_VERB_REGEX =
  /走|坐下|站起|转身|抬头|低头|回头|抬手|放手|点头|摇头|皱眉|蹙眉|眯眼|睁眼|闭眼|抿唇|咬牙|叹息|咳嗽|清嗓|迈步|退后|上前|靠前|靠近|远离|推开|拉近|握住|松开|抱起|放下|拿起|捡起|翻开|合上|敲击|拍打|拉扯|推搡|整理|擦拭|穿戴|脱下|戴上|摘下/gu;

/** 过门/赶路特征词 */
const BRIDGE_KEYWORDS_REGEX =
  /赶路|前往|到达|离开|转移|集结|集合|出发|返回|回到|进入|走过|穿过|赶来|动身|启程|抵达|走廊|通道|门口|街道|道路|路口|巷子|城门|营门|山门|沿路|一路|途中/u;

/** 背景/概述特征词 */
const SUMMARY_EXPOSITION_KEYWORDS_REGEX =
  /背景|历史|由来|过去|曾经|以往|向来|一直|向来如此|据说|传闻|传说|族中|门中|宗门|家族|师门|底蕴|传承|渊源|前因后果|来龙去脉/u;

/** 概述段视为"无对话/无动作"的标志：段内无引号、无动作动词 */
const DIALOGUE_MARK_REGEX = /[「」『』“”"']/u;

/** 压迫词（payoff_underwritten 检测） */
const OPPRESSION_KEYWORDS_REGEX =
  /逼迫|威胁|压迫|期限|最后|必须|别无选择|退路|绝路|迫在眉睫|逼到|逼得|逼问|盘问|试探|施压|加压|紧逼|步步紧逼|刀尖|刀架|悬在|顶住|抵住/u;

/** 选择词（payoff_underwritten 检测） */
const CHOICE_KEYWORDS_REGEX =
  /选择|决定|抉择|决策|咬咬牙|狠下心|豁出去|赌|拼了|宁可|宁愿|迟疑|犹豫|权衡|斟酌|拿定主意|下定决心|做出决定|做出选择/u;

/** 后果/反打词（payoff_underwritten 检测） */
const CONSEQUENCE_KEYWORDS_REGEX =
  /代价|损失|反打|反扑|反噬|后果|牺牲|受伤|失血|资源损失|震惊|退缩|倒戈|加码|反击|反将一军|反咬|反推|反噬|反扑|翻盘|翻脸/u;

// ============================================================================
// 辅助函数
// ============================================================================

/** 计算中文字符数（排除空白、标点、英文） */
function countChineseChars(text: string): number {
  // 匹配 CJK 统一汉字 + 扩展区
  const matches = text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/gu);
  return matches ? matches.length : 0;
}

/** 段落分割：按双换行或单换行（保留中文段落结构） */
function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n|\r\n\r\n|\n|\r/u)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** 段落是否含功能 delta 关键词 */
function paragraphHasFunctionalDelta(para: string): boolean {
  return FUNCTIONAL_DELTA_PATTERNS.some((p) => p.test(para));
}

/** 段落是否纯动作罗列（含 3+ 动作动词，无功能 delta） */
function isActionListParagraph(para: string): boolean {
  if (paragraphHasFunctionalDelta(para)) return false;
  // 计算动作动词命中数（粗略，按动词表逐字扫描）
  const actionMatches = para.match(ACTION_VERB_REGEX);
  const actionCount = actionMatches ? actionMatches.length : 0;
  return actionCount >= 3;
}

/** 取命中处上下文片段 */
function excerptAround(text: string, index: number, length: number, window = 16): string {
  const start = Math.max(0, index - window);
  const end = Math.min(text.length, index + length + window);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end)}${suffix}`;
}

/** 取段落首句附近的摘要（用于 issue excerpt） */
function paragraphExcerpt(para: string, maxLen = 40): string {
  if (para.length <= maxLen) return para;
  return `${para.slice(0, maxLen)}…`;
}

// ============================================================================
// 检测器：measurement_relationship
// ============================================================================

function detectMeasurementRelationship(text: string): FlatNarrationIssue[] {
  const issues: FlatNarrationIssue[] = [];
  for (const pattern of MEASUREMENT_RELATIONSHIP_PATTERNS) {
    // P41 修复：原 pattern 只有 /u 没有 /g，re.exec 会一直返回首个 match 导致死循环 OOM。
    // 强制补 /g 让 exec 推进 lastIndex。
    const flags = pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g";
    const re = new RegExp(pattern.source, flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m.index === undefined) break;
      issues.push({
        type: "measurement_relationship",
        severity: "info",
        excerpt: excerptAround(text, m.index, m[0].length),
        index: m.index,
        suggestion: `测量式关系描写（"${m[0]}"）——用具体动作/神态/对话体现关系变化，而非距离/时长量化。改为"她没像往常那样避开他的视线"或"语气里多了一道缝"。`,
      });
      if (m.index === re.lastIndex) re.lastIndex += 1;
    }
  }
  return issues;
}

// ============================================================================
// 检测器：action_list（连续 3 段动作罗列 + 单段堆多动作）
// ============================================================================

function detectActionList(
  paragraphs: string[],
  text: string,
): FlatNarrationIssue[] {
  const issues: FlatNarrationIssue[] = [];

  // 1. 连续 3 段都是纯动作罗列 → critical
  let consecutiveCount = 0;
  let runStartParaIdx = -1;
  for (let i = 0; i < paragraphs.length; i++) {
    if (isActionListParagraph(paragraphs[i])) {
      if (consecutiveCount === 0) runStartParaIdx = i;
      consecutiveCount++;
      if (consecutiveCount >= 3) {
        const excerpt = paragraphs
          .slice(runStartParaIdx, runStartParaIdx + 3)
          .map((p) => paragraphExcerpt(p, 30))
          .join(" | ");
        issues.push({
          type: "action_list",
          severity: "critical",
          excerpt: `连续${consecutiveCount}段动作罗列：${excerpt}`,
          index: text.indexOf(paragraphs[runStartParaIdx]),
          suggestion: `连续 3 段只是动作/状态罗列，没有风险/选择/信息/关系变化。把动作压缩为一句过门，让位给主角决策或冲突转向。`,
        });
        break; // 一次 critical 命中即可，避免重复报告
      }
    } else {
      consecutiveCount = 0;
    }
  }

  // 2. 单段堆 5+ 动作动词但无功能 delta → review
  if (issues.length === 0) {
    for (let i = 0; i < paragraphs.length; i++) {
      const para = paragraphs[i];
      if (paragraphHasFunctionalDelta(para)) continue;
      const actionMatches = para.match(ACTION_VERB_REGEX);
      const actionCount = actionMatches ? actionMatches.length : 0;
      if (actionCount >= 5) {
        issues.push({
          type: "action_list",
          severity: "review",
          excerpt: `单段堆${actionCount}个动作：${paragraphExcerpt(para, 40)}`,
          index: text.indexOf(para),
          suggestion: `一段内堆多个角色动作，但没有主角决策或冲突转向。删减到 2-3 个关键动作，把空间留给选择/信息/关系变化。`,
        });
        break; // 一次 review 命中即可
      }
    }
  }

  return issues;
}

// ============================================================================
// 检测器：nonfunctional_detail（细节无功能归属）
// ============================================================================

const NONFUNCTIONAL_DETAIL_KEYWORDS_REGEX =
  /穿着|打扮|装备|路线|站位|陈设|光线|天气|气味|颜色|材质|花纹|样式|款式|配置|分布|布局|方位|身高|体型|发饰|衣料|甲胄|兵器|法器|灵器/u;

function detectNonfunctionalDetail(
  paragraphs: string[],
  text: string,
): FlatNarrationIssue[] {
  const issues: FlatNarrationIssue[] = [];
  for (const para of paragraphs) {
    if (paragraphHasFunctionalDelta(para)) continue;
    if (!NONFUNCTIONAL_DETAIL_KEYWORDS_REGEX.test(para)) continue;
    // 段落含细节描写但无功能 delta → nonfunctional_detail
    issues.push({
      type: "nonfunctional_detail",
      severity: "review",
      excerpt: paragraphExcerpt(para, 40),
      index: text.indexOf(para),
      suggestion: `细节无功能归属：不触发动作、不暴露信息、不改变关系、不埋钩子。要么删掉，要么让细节承担一个功能（如暴露信息/埋钩子/改变关系）。`,
    });
    if (issues.length >= 3) break; // 单事件最多报 3 条，避免噪声
  }
  return issues;
}

// ============================================================================
// 检测器：overlong_bridge（过门段超过 180 字未进入冲突/异常/选择/钩子）
// ============================================================================

function detectOverlongBridge(
  paragraphs: string[],
  text: string,
): FlatNarrationIssue[] {
  const issues: FlatNarrationIssue[] = [];
  const BRIDGE_THRESHOLD = 180;
  for (const para of paragraphs) {
    if (!BRIDGE_KEYWORDS_REGEX.test(para)) continue;
    const charCount = countChineseChars(para);
    if (charCount <= BRIDGE_THRESHOLD) continue;
    // 过门段超 180 字，检查是否进入冲突/异常/选择/钩子
    if (paragraphHasFunctionalDelta(para)) continue; // 已有功能 delta，不算 overlong
    issues.push({
      type: "overlong_bridge",
      severity: "review",
      excerpt: paragraphExcerpt(para, 40),
      index: text.indexOf(para),
      suggestion: `过门段 ${charCount} 字仍未进入冲突/异常/选择/钩子（阈值 ${BRIDGE_THRESHOLD} 字）。压缩到 1-2 句过门，把篇幅让给重点场。`,
    });
    if (issues.length >= 2) break;
  }
  return issues;
}

// ============================================================================
// 检测器：summary_exposition（概述段长篇背景交代）
// ============================================================================

function detectSummaryExposition(
  paragraphs: string[],
  text: string,
): FlatNarrationIssue[] {
  const issues: FlatNarrationIssue[] = [];
  const SUMMARY_THRESHOLD = 200;
  for (const para of paragraphs) {
    if (!SUMMARY_EXPOSITION_KEYWORDS_REGEX.test(para)) continue;
    const charCount = countChineseChars(para);
    if (charCount <= SUMMARY_THRESHOLD) continue;
    // 概述段超 200 字，检查是否有对话/动作/冲突
    if (DIALOGUE_MARK_REGEX.test(para)) continue; // 有对话，不算纯概述
    if (paragraphHasFunctionalDelta(para)) continue; // 有功能 delta，不算纯概述
    issues.push({
      type: "summary_exposition",
      severity: "review",
      excerpt: paragraphExcerpt(para, 40),
      index: text.indexOf(para),
      suggestion: `概述段 ${charCount} 字纯背景交代，无对话/无动作/无冲突。背景拆散到后续场景中通过对话/动作/线索释放，禁止长段铺陈。`,
    });
    if (issues.length >= 2) break;
  }
  return issues;
}

// ============================================================================
// 检测器：weak_scene_focus（重点场没写透）
// ============================================================================

function detectWeakSceneFocus(
  text: string,
  weightClass?: NarrativeWeightClass,
): FlatNarrationIssue[] {
  if (!weightClass) return [];
  const issues: FlatNarrationIssue[] = [];
  const charCount = countChineseChars(text);

  // payoffScene 期望 >= 300 字，coreScene 期望 >= 200 字
  const minWords = weightClass === "payoffScene" ? 300 : weightClass === "coreScene" ? 200 : 0;
  if (minWords > 0 && charCount < minWords) {
    issues.push({
      type: "weak_scene_focus",
      severity: "review",
      excerpt: paragraphExcerpt(text, 40),
      suggestion: `${weightClass === "payoffScene" ? "兑现/反打场" : "重点场"}仅 ${charCount} 字（期望 >= ${minWords}），没写透。补充压迫→选择→后果/反打的具体节拍。`,
    });
  }

  // payoffScene 缺压迫/选择/后果任一节拍 → weak_scene_focus
  if (weightClass === "payoffScene") {
    const hasOppression = OPPRESSION_KEYWORDS_REGEX.test(text);
    const hasChoice = CHOICE_KEYWORDS_REGEX.test(text);
    const hasConsequence = CONSEQUENCE_KEYWORDS_REGEX.test(text);
    const missing: string[] = [];
    if (!hasOppression) missing.push("压迫");
    if (!hasChoice) missing.push("选择");
    if (!hasConsequence) missing.push("后果/反打");
    if (missing.length >= 2) {
      issues.push({
        type: "weak_scene_focus",
        severity: "critical",
        excerpt: paragraphExcerpt(text, 40),
        suggestion: `兑现/反打场缺节拍：${missing.join("、")}。必须写透"压迫→主角选择→后果/代价/反打"完整链路。`,
      });
    }
  }

  return issues;
}

// ============================================================================
// 检测器：payoff_underwritten（高冲突事件缺压迫→选择→后果）
// ============================================================================

function detectPayoffUnderwritten(
  text: string,
  conflictLevel?: number,
  weightClass?: NarrativeWeightClass,
): FlatNarrationIssue[] {
  // 高冲突（>=4）或 payoffScene/coreScene 才检测
  const isHighStakes =
    (conflictLevel !== undefined && conflictLevel >= 4) ||
    weightClass === "payoffScene" ||
    weightClass === "coreScene";
  if (!isHighStakes) return [];

  const hasOppression = OPPRESSION_KEYWORDS_REGEX.test(text);
  const hasChoice = CHOICE_KEYWORDS_REGEX.test(text);
  const hasConsequence = CONSEQUENCE_KEYWORDS_REGEX.test(text);

  const missing: string[] = [];
  if (!hasOppression) missing.push("压迫");
  if (!hasChoice) missing.push("主角选择");
  if (!hasConsequence) missing.push("后果/代价/反打");

  // 缺 2+ 节拍 → payoff_underwritten
  if (missing.length < 2) return [];

  return [
    {
      type: "payoff_underwritten",
      severity: "critical",
      excerpt: paragraphExcerpt(text, 40),
      suggestion: `高冲突事件缺"${missing.join("、")}"。补完"压迫→主角选择→后果/代价/反打"完整链路，旁人反应（震惊/退缩/倒戈/加码）也要落到具体动作或对话。`,
    },
  ];
}

// ============================================================================
// 评分与 verdict
// ============================================================================

/** 评分：起始 100，按 issue severity 扣分 */
function computeScore(issues: FlatNarrationIssue[]): number {
  let score = 100;
  for (const issue of issues) {
    switch (issue.severity) {
      case "critical":
        score -= 15;
        break;
      case "review":
        score -= 8;
        break;
      case "info":
        score -= 3;
        break;
    }
  }
  return Math.max(0, Math.min(100, score));
}

/** 根据 score + 计数规则得出 verdict */
function computeVerdict(
  score: number,
  measurementRelationshipCount: number,
  criticalActionListCount: number,
): "pass" | "review" | "block" {
  // critical action_list >= 2 → block candidate
  if (criticalActionListCount >= 2) return "block";
  // measurement_relationship >= 3 → review
  if (measurementRelationshipCount >= 3) {
    return score >= 75 ? "review" : score >= 55 ? "review" : "block";
  }
  if (score >= 75) return "pass";
  if (score >= 55) return "review";
  return "block";
}

/** 摘要 */
function buildSummary(
  score: number,
  verdict: string,
  issues: FlatNarrationIssue[],
  charCount: number,
  measurementRelationshipCount: number,
  functionlessDetailCount: number,
): string {
  if (issues.length === 0) {
    return `流水账扫描通过：score=${score}，无 issue，${charCount} 字。`;
  }
  const byType: Record<string, number> = {};
  for (const issue of issues) {
    byType[issue.type] = (byType[issue.type] ?? 0) + 1;
  }
  const parts = Object.entries(byType).map(([t, c]) => `${t}=${c}`);
  return `score=${score}（${verdict}），${charCount} 字，命中 ${issues.length} 处：${parts.join("，")}；测量式关系=${measurementRelationshipCount}，无功能细节=${functionlessDetailCount}。`;
}

// ============================================================================
// 主扫描函数
// ============================================================================

/**
 * 扫描事件正文，检测 7 类流水账问题。
 *
 * @param input 扫描器输入
 * @returns 扫描结果（含 score / verdict / issues / 密度 / 计数）
 */
export function scanFlatNarration(input: FlatNarrationScannerInput): FlatNarrationScanResult {
  const { text, conflictLevel, weightClass } = input;

  const charCount = countChineseChars(text);
  const paragraphs = splitParagraphs(text);

  // 1. measurement_relationship（全文扫描，多命中）
  const measurementIssues = detectMeasurementRelationship(text);

  // 2. action_list（段落级，连续 3 段 / 单段堆 5+）
  const actionListIssues = detectActionList(paragraphs, text);

  // 3. nonfunctional_detail（段落级）
  const nonfunctionalIssues = detectNonfunctionalDetail(paragraphs, text);

  // 4. overlong_bridge（段落级）
  const overlongBridgeIssues = detectOverlongBridge(paragraphs, text);

  // 5. summary_exposition（段落级）
  const summaryExpositionIssues = detectSummaryExposition(paragraphs, text);

  // 6. weak_scene_focus（全文级，依赖 weightClass）
  const weakSceneFocusIssues = detectWeakSceneFocus(text, weightClass);

  // 7. payoff_underwritten（全文级，依赖 conflictLevel / weightClass）
  const payoffUnderwrittenIssues = detectPayoffUnderwritten(text, conflictLevel, weightClass);

  // 合并所有 issue，按 index 升序
  const allIssues: FlatNarrationIssue[] = [
    ...measurementIssues,
    ...actionListIssues,
    ...nonfunctionalIssues,
    ...overlongBridgeIssues,
    ...summaryExpositionIssues,
    ...weakSceneFocusIssues,
    ...payoffUnderwrittenIssues,
  ].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

  const measurementRelationshipCount = measurementIssues.length;
  const functionlessDetailCount =
    nonfunctionalIssues.length + summaryExpositionIssues.length;
  const criticalActionListCount = actionListIssues.filter(
    (i) => i.severity === "critical",
  ).length;

  const score = computeScore(allIssues);
  const verdict = computeVerdict(score, measurementRelationshipCount, criticalActionListCount);

  const densityPerThousand =
    charCount >= 200 ? (allIssues.length / charCount) * 1000 : 0;

  const summary = buildSummary(
    score,
    verdict,
    allIssues,
    charCount,
    measurementRelationshipCount,
    functionlessDetailCount,
  );

  return {
    score,
    verdict,
    issues: allIssues,
    densityPerThousand,
    functionlessDetailCount,
    measurementRelationshipCount,
    summary,
  };
}

// ============================================================================
// 工厂函数（与 chinese-narrative-naturalness-scanner 风格对齐）
// ============================================================================

export interface FlatNarrationScanner {
  scan(input: FlatNarrationScannerInput): FlatNarrationScanResult;
}

export function createFlatNarrationScanner(): FlatNarrationScanner {
  return {
    scan(input) {
      return scanFlatNarration(input);
    },
  };
}

/** 类型标签映射（用于 trace 中文展示） */
export function getFlatNarrationIssueTypeLabel(type: string): string {
  const labels: Record<FlatNarrationIssueType, string> = {
    action_list: "动作罗列",
    nonfunctional_detail: "无功能细节",
    overlong_bridge: "过门过长",
    summary_exposition: "概述铺陈",
    weak_scene_focus: "重点场欠写",
    measurement_relationship: "测量式关系描写",
    payoff_underwritten: "兑现场欠写",
  };
  return labels[type as FlatNarrationIssueType] ?? type;
}

/** verdict 标签映射 */
export function getFlatNarrationVerdictLabel(verdict: string): string {
  const labels: Record<FlatNarrationScanResult["verdict"], string> = {
    pass: "通过",
    review: "需复核",
    block: "阻断候选",
  };
  return labels[verdict as FlatNarrationScanResult["verdict"]] ?? verdict;
}

/** 把扫描结果转为 Stage 5/8 hints 用途的简短字符串 */
export function buildFlatNarrationHints(result: FlatNarrationScanResult): string {
  if (result.issues.length === 0) return "";
  const lines = result.issues.map((issue) => {
    const label = getFlatNarrationIssueTypeLabel(issue.type);
    return `【${label}】${issue.suggestion}`;
  });
  return lines.join("\n");
}
