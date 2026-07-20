/**
 * PiNovelStudio — DialogueCraftGate (P7-T2)
 *
 * 历史依据：PiNovelStudio-Agentic创作流水线升级方案 P7-T2（文档已删除）；当前架构见 docs/top-tier-chinese-novel-system-development-plan.md
 * 目标：3 轮纯对白必证增量 / 标签删除归属清楚 / 动作标签有信息量
 *
 * 阻断规则：
 *   - 规则 1：连续 3 轮纯对白（无动作/心理/环境）必须有信息增量
 *   - 规则 2：删除对话标签后，归属应仍可辨识（≥1 字符化线索）
 *   - 规则 3：动作标签必须有信息量（非"他笑了""她点头"等空标签）
 *
 * 接入点：Stage 5（draft 修订前）+ Stage 8（最终打磨）
 */

// ============================================================================
// 输入类型
// ============================================================================

export interface DialogueLine {
  /** 说话者 ID */
  readonly speaker: string;
  /** 对话内容（不含标签） */
  readonly content: string;
  /** 原始行（含标签，如 `张三说："..."` 或 `张三拿起茶杯："..."`） */
  readonly rawLine: string;
  /** 动作标签（如"拿起茶杯"，可为空） */
  readonly actionTag?: string;
}

export interface DialogueCraftGateInput {
  readonly lines: readonly DialogueLine[];
  /** 上下文：场景描述、人物关系（可选） */
  readonly context?: string;
}

// ============================================================================
// 输出类型
// ============================================================================

export interface DialogueCraftGateResult {
  readonly passed: boolean;
  readonly violations: readonly DialogueCraftViolation[];
  readonly report: string;
}

export interface DialogueCraftViolation {
  readonly rule: 1 | 2 | 3;
  readonly ruleName: string;
  readonly lineIndex: number;
  readonly evidence: string;
  readonly severity: "warning" | "critical";
}

// ============================================================================
// 规则 1：3 轮纯对白必证增量
// ============================================================================

/**
 * 规则 1：连续 3 轮纯对白（无 actionTag）必须有信息增量。
 * 增量判定：
 *   - 引入新名词/新概念
 *   - 关系/状态发生变化（出现变化动词：决定/离开/答应/拒绝/揭露）
 *   - 信息层面推进（出现"但是/然而/实际上/原来"等转折/揭密词）
 */
export function checkRule1Increment(
  lines: readonly DialogueLine[]
): DialogueCraftViolation[] {
  const violations: DialogueCraftViolation[] = [];

  // 滑动窗口找连续 3 行纯对白
  for (let i = 0; i <= lines.length - 3; i++) {
    const window = lines.slice(i, i + 3);
    const allPure = window.every((l) => !l.actionTag || l.actionTag.trim() === "");
    if (!allPure) continue;

    const combined = window.map((l) => l.content).join("");
    if (!hasIncrement(combined)) {
      violations.push({
        rule: 1,
        ruleName: "3 轮纯对白必证增量",
        lineIndex: i,
        evidence: `连续 3 轮纯对白无信息增量：${window
          .map((l) => `「${l.content}」`)
          .join("")}`,
        severity: "critical",
      });
    }
  }

  return violations;
}

/** 判断 3 轮合并文本是否有信息增量 */
function hasIncrement(combined: string): boolean {
  // 1. 出现新名词/新概念（长度 > 2 的非通用名词）
  const properNounPattern = /[甲乙丙丁戊己庚辛壬癸]|[一二三四五六七八九十]{2,}|[\u4e00-\u9fff]{3,}/;
  // 2. 变化动词
  const changeVerbs = /(决定|离开|答应|拒绝|揭露|坦白|认罪|屈服|背叛|投靠|放弃|承担)/;
  // 3. 转折/揭密词
  const turnWords = /(但是|然而|实际上|原来|其实|不料|谁知|岂料|倒不如)/;
  // 4. 数字/时间/数量变化
  const numberPattern = /\d+|[一两三四五六七八九十百千万亿]+(?:年|天|日|时|人|两|次|遍)/;

  return (
    (properNounPattern.test(combined) && changeVerbs.test(combined)) ||
    turnWords.test(combined) ||
    (numberPattern.test(combined) && changeVerbs.test(combined))
  );
}

// ============================================================================
// 规则 2：标签删除归属清楚
// ============================================================================

/** 动作标签正则：剥离后判断内容是否含说话者线索 */
const DIALOGUE_TAG_PATTERNS = [
  /^[^：：「」""''「」]+(说|道|问|答|笑|骂|喝|喊)：/,
  /^[^：：「」""''「」]+(说|道|问|答|笑|骂|喝|喊)「/,
  /^[^：：「」""''「」]+(说|道|问|答|笑|骂|喝|喊)"/,
];

/**
 * 规则 2：删除对话标签后，归属应仍可辨识。
 * 判定：剥离标签后的 content 必须含至少 1 个角色化线索（自称/专属口癖/称呼他人）。
 */
export function checkRule2Attribution(
  lines: readonly DialogueLine[]
): DialogueCraftViolation[] {
  const violations: DialogueCraftViolation[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const stripped = stripDialogueTags(line.rawLine);

    // 称呼/自称线索
    const hasSelfClaim = /(本座|在下|弟子|老夫|晚辈|鄙人|本王|本宫|我)/.test(stripped);
    const hasAddress = /(兄台|道友|大人|师尊|前辈|阁下|小子|丫头)/.test(stripped);
    const hasSignature = checkSignaturePhrase(stripped);

    if (!hasSelfClaim && !hasAddress && !hasSignature) {
      violations.push({
        rule: 2,
        ruleName: "标签删除归属清楚",
        lineIndex: i,
        evidence: `剥离标签后无法辨识说话者：「${stripped.slice(0, 30)}...」缺少自称/称呼/口癖线索`,
        severity: "critical",
      });
    }
  }

  return violations;
}

function stripDialogueTags(rawLine: string): string {
  let stripped = rawLine;
  for (const pattern of DIALOGUE_TAG_PATTERNS) {
    stripped = stripped.replace(pattern, "");
  }
  // 去除引号
  stripped = stripped.replace(/^[「""']/, "").replace(/[」""']$/, "");
  return stripped.trim();
}

/** 简化口癖检测：句尾语气词 / 倒装 / 特殊标点习惯 */
function checkSignaturePhrase(content: string): boolean {
  // 古风人物常以"...也/...矣/...乎"结尾
  if (/[也矣乎]$/.test(content)) return true;
  // 现代口语常以"...嘛/...呗/...哈"结尾
  if (/[嘛呗哈]$/.test(content)) return true;
  // 武侠/江湖风：常以"...便是/...如何"结尾
  if (/(便是|如何)$/.test(content)) return true;
  return false;
}

// ============================================================================
// 规则 3：动作标签有信息量
// ============================================================================

/** 空动作标签黑名单 */
const EMPTY_ACTION_PATTERNS = [
  /^(他|她|它)(笑了|笑了一笑|笑了笑|点头|点了点头|摇了摇头|摇头|叹气|叹了口气|皱眉|皱了皱眉)$/,
  /^(他|她|它)(看着|望着|盯着)(我|你|他|她)$/,
  /^(他|她|它)(站起来|坐下来|走过来|转过身)$/,
];

/**
 * 规则 3：动作标签必须有信息量，不允许空标签。
 * 空标签示例：他笑了 / 她点头 / 他摇头 / 他看着我
 * 有信息量示例：他攥紧了拳头 / 她指尖发白 / 他退后半步
 */
export function checkRule3ActionTagInfo(
  lines: readonly DialogueLine[]
): DialogueCraftViolation[] {
  const violations: DialogueCraftViolation[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.actionTag || line.actionTag.trim() === "") continue;

    if (EMPTY_ACTION_PATTERNS.some((p) => p.test(line.actionTag!.trim()))) {
      violations.push({
        rule: 3,
        ruleName: "动作标签有信息量",
        lineIndex: i,
        evidence: `空动作标签："${line.actionTag}"（应为带情绪/状态/物品的具体动作）`,
        severity: "warning",
      });
    }
  }

  return violations;
}

// ============================================================================
// 主入口：DialogueCraftGate
// ============================================================================

export function runDialogueCraftGate(
  input: DialogueCraftGateInput
): DialogueCraftGateResult {
  const violations: DialogueCraftViolation[] = [
    ...checkRule1Increment(input.lines),
    ...checkRule2Attribution(input.lines),
    ...checkRule3ActionTagInfo(input.lines),
  ];

  const passed = violations.filter((v) => v.severity === "critical").length === 0;

  const report = violations.length === 0
    ? "DialogueCraftGate 通过：3 规则全绿"
    : `DialogueCraftGate ${passed ? "通过（仅 warning）" : "不通过"}：${violations.length} 处违规（${violations.filter((v) => v.severity === "critical").length} critical, ${violations.filter((v) => v.severity === "warning").length} warning）`;

  return { passed, violations, report };
}

// ============================================================================
// P7-T6: 文本解析 + 主链路 advisory 接入
//
// 从段落文本提取 DialogueLine[]，供 narrator 主链路 advisory 检测使用。
// 解析规则（保守，避免误判）：
//   - 匹配 "说话者：内容" 或 "说话者说：内容" 或 "说话者动作：内容" 格式
//   - 中文冒号 / 英文冒号 / 引号均可
//   - 仅提取有明确说话者的行
// ============================================================================

/** 从段落文本提取 DialogueLine[] */
export function parseDialogueLinesFromText(text: string): DialogueLine[] {
  const lines: DialogueLine[] = [];
  if (!text) return lines;

  // 匹配模式：说话者 + (可选动作) + 冒号 + 引号内容
  // 例：张三说："..." / 张三："..." / 张三拿起茶杯："..."
  const pattern = /([^\s，。！？\n]{1,10})([^：:\n]{0,20}?)[：:]\s*["""']([^"""']+)["""']/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const speaker = match[1].trim();
    const actionPart = match[2].trim();
    const content = match[3].trim();
    if (!speaker || !content) continue;

    // 过滤非对话说话者（如"提示"、"系统"等常见误判）
    if (["提示", "系统", "注", "说明"].includes(speaker)) continue;

    lines.push({
      speaker,
      content,
      rawLine: match[0],
      actionTag: actionPart || undefined,
    });
  }

  return lines;
}

/**
 * P7-T6: 对段落文本运行 DialogueCraftGate advisory 检测
 *
 * 由 narrator 主链路在事件生成后调用。失败不阻断主流程，仅返回 result 供 trace 记录。
 */
export function runDialogueCraftGateAdvisory(text: string): DialogueCraftGateResult {
  const lines = parseDialogueLinesFromText(text);
  if (lines.length === 0) {
    return {
      passed: true,
      violations: [],
      report: "DialogueCraftGate advisory 跳过：未检测到对话行",
    };
  }
  return runDialogueCraftGate({ lines });
}
