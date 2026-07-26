/**
 * NovelOS Intent Coverage Helpers（OPT-9.6 拆分自 narrative-verifier-suite.ts）
 *
 * 章纲意图覆盖检测的纯函数与常量：
 * - 同义词归一化（INTENT_SYNONYM_GROUPS / INTENT_TOKEN_CANONICALS）
 * - 章纲要求解析（parseIntentRequirements / parseAuthorEventSummaries）
 * - 覆盖判定（intentAnchorCovered / intentEventCovered / intentVerbatimCovered）
 *
 * 拆分目的：满足 simplicity-gate 800 行限制；这些函数无 `this` 依赖，可独立测试。
 */

// ============================================================================
// 类型
// ============================================================================

export type IntentRequirementMode = "anchor" | "verbatim";

export interface IntentRequirement {
  raw: string;
  text: string;
  mode: IntentRequirementMode;
}

// ============================================================================
// 同义词归一化词表
// ============================================================================

const INTENT_SYNONYM_GROUPS: Array<{ canonical: string; variants: string[] }> = [
  { canonical: "三队", variants: ["三队", "三支队伍", "三支队", "三队伍"] },
  { canonical: "首次", variants: ["首次", "第一次", "初次", "头一次"] },
  { canonical: "配合", variants: ["配合", "协同作战", "协同", "协作", "合作"] },
  { canonical: "采样", variants: ["采样", "采集", "取样"] },
  { canonical: "反常", variants: ["状态反常", "状态不对劲", "状态不对", "反常", "破天荒", "比平时更收敛", "明显收敛"] },
  { canonical: "妖兽群", variants: ["妖兽群", "兽群", "一群低阶灰甲兽", "灰甲兽群"] },
  { canonical: "异常", variants: ["异常", "不对劲", "异样", "不寻常", "排斥感"] },
  { canonical: "未开口", variants: ["未说出口", "没有说出口", "没说出口", "没有开口", "没开口"] },
  { canonical: "突袭", variants: ["突袭", "袭击", "突然袭来", "破水而出"] },
  { canonical: "拖入水底", variants: ["拖入水底", "拖入深水", "拖入水下", "拽入深水", "拉入水底"] },
  { canonical: "开枪", variants: ["开枪", "开火", "机枪火舌", "子弹打进"] },
  { canonical: "无效", variants: ["无效", "没效果", "没有效果", "没带出来", "皮甲极厚", "连皮都没能擦破", "连皮都没擦破", "没能擦破", "没擦破"] },
  { canonical: "多只", variants: ["多只", "至少有三只", "两只以上", "不止一只", "一群"] },
  { canonical: "围攻", variants: ["围攻", "集群攻击", "群体攻击", "多只攻击", "快速穿梭", "从四面逼近", "从四面围上来"] },
  { canonical: "战力一成", variants: ["十不存一", "只剩一成", "战力只剩一成", "战力大降"] },
  { canonical: "击杀", variants: ["一击斩杀", "斩杀", "击杀", "毙命", "切开"] },
  { canonical: "干脆", variants: ["干脆", "利落", "直接"] },
  { canonical: "评估", variants: ["评估局势", "判断局势", "快速判断", "看着挣扎的队友"] },
  { canonical: "出手", variants: ["决定出手", "主动出手", "意念一动", "鳞片从空间中滑出"] },
  { canonical: "暗金", variants: ["暗金", "暗金色"] },
  { canonical: "双眸", variants: ["双眸", "竖瞳"] },
  { canonical: "救回", variants: ["救回", "救出", "拖回", "带回水面", "带着他向上游"] },
  { canonical: "震惊", variants: ["震惊", "愣住", "瞪大眼睛", "忘了踩水", "从未见过"] },
  { canonical: "关心", variants: ["关心", "担心", "询问伤势", "没受伤吧", "你没事吧", "没事吧", "递过来一条干毛巾", "递给他一条毛巾"] },
  { canonical: "微亮", variants: ["微亮", "微微亮", "亮了一丝", "亮起一丝"] },
  { canonical: "未醒", variants: ["未醒", "没有醒", "没有苏醒", "仍未苏醒", "没醒"] },
  { canonical: "重新评估", variants: ["重新评估", "重新审视", "重新正视", "重新看待"] },
  { canonical: "定位改变", variants: ["定位将变", "定位会变", "位置会变", "重新定位"] },
  { canonical: "改变", variants: ["改变", "回不到从前", "变了", "要变", "将变", "彻底变"] },
  { canonical: "倒计时压力", variants: ["倒计时型压力", "倒计时压力", "氧气有限", "氧气在快速消耗", "氧气在消耗", "氧气消耗", "体力有限"] },
];

const INTENT_TOKEN_CANONICALS = [
  "战狼领队", "黑玫瑰领队", "赵明远", "李一凡", "王研究员", "水样", "虫卵", "水怪", "研究员", "水下", "水面", "能见度", "极低",
  "多只", "鳞片", "第二只", "小妖", "震惊", "墨老", "木心", "反常", "冷淡", "客气", "妖兽群",
  "暗金双眸", "暗金", "双眸", "梦魇", "战力", "评估", "出手", "直觉", "采样", "反常", "妖兽群", "异常", "未开口", "突袭", "拖入水底", "开枪", "无效",
  "围攻", "战力一成", "倒计时压力", "击杀", "干脆", "救回", "关心", "微亮", "未醒", "重新评估", "定位改变", "定位", "改变",
  "回程", "下令救人", "救援", "三队", "首次", "配合",
];

const INTENT_SYNONYM_CANONICALS = new Map<string, string>();
for (const group of INTENT_SYNONYM_GROUPS) {
  for (const variant of group.variants) {
    if (!INTENT_SYNONYM_CANONICALS.has(variant)) {
      INTENT_SYNONYM_CANONICALS.set(variant, group.canonical);
    }
  }
}

const INTENT_SYNONYM_PATTERN = new RegExp(
  Array.from(INTENT_SYNONYM_CANONICALS.keys())
    .sort((a, b) => b.length - a.length)
    .map((variant) => variant.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("|"),
  "gu",
);

// ============================================================================
// 章纲解析
// ============================================================================

export function normalizeIntentPhrase(value: string): string {
  let normalized = value
    .replace(/^\s*\[(?:anchor|verbatim)\]\s*/iu, "")
    .replace(/^\s*(?:原句|原文)\s*[：:]\s*/u, "")
    .replace(/[「『“"”』」]/gu, "")
    .replace(/[\s，。、；：:！!？?（）()【】\[\]→+]+/gu, "")
    .replace(/[的地得]/gu, "")
    .trim();
  return normalized.replace(
    INTENT_SYNONYM_PATTERN,
    (variant) => INTENT_SYNONYM_CANONICALS.get(variant) ?? variant,
  );
}

export function parseIntentRequirements(chapterIntent: string): IntentRequirement[] {
  const line = chapterIntent.match(/^作者章纲必须包含：(.+)$/mu)?.[1] ?? "";
  if (!line) return [];
  return line
    .split(/[；;]/u)
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw) => {
      const verbatim = /^\s*\[(?:verbatim)\]/iu.test(raw) || /^\s*(?:原句|原文)\s*[：:]/u.test(raw);
      return { raw, text: raw, mode: verbatim ? "verbatim" : "anchor" };
    });
}

export function parseAuthorEventSummaries(chapterIntent: string): Array<{ index: number; summary: string }> {
  const lines = chapterIntent.split(/\r?\n/u);
  const events: Array<{ index: number; summary: string }> = [];
  let inSection = false;
  for (const line of lines) {
    if (/^作者章纲事件顺序：\s*$/u.test(line.trim())) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (/^作者章纲/u.test(line.trim())) break;
    const match = line.match(/^\s*(\d+)[.、]\s*(.+)$/u);
    if (match) events.push({ index: Number(match[1]), summary: match[2].trim() });
  }
  return events;
}

// ============================================================================
// 覆盖判定
// ============================================================================

export function intentAnchorCovered(text: string, requirement: string): boolean {
  if (text.includes(requirement)) return true;
  const normalizedText = normalizeIntentPhrase(text);
  const normalizedRequirement = normalizeIntentPhrase(requirement);
  if (!normalizedRequirement || normalizedText.includes(normalizedRequirement)) return true;

  const tokens = INTENT_TOKEN_CANONICALS
    .filter((token) => normalizedRequirement.includes(token))
    .sort((a, b) => b.length - a.length);
  if (tokens.length === 0) return false;
  const matched = tokens.filter((token) => normalizedText.includes(token)).length;
  const threshold = tokens.length <= 2 ? tokens.length : Math.max(2, Math.ceil(tokens.length * 0.6));
  return matched >= threshold;
}

export function intentEventCovered(text: string, summary: string): boolean {
  const normalizedText = normalizeIntentPhrase(text);
  const normalizedSummary = normalizeIntentPhrase(summary);
  if (!normalizedSummary || normalizedText.includes(normalizedSummary)) return true;
  const tokens = Array.from(new Set(
    INTENT_TOKEN_CANONICALS.filter((token) => normalizedSummary.includes(token)),
  ));
  if (tokens.length < 2) return intentAnchorCovered(text, summary);
  const matched = tokens.filter((token) => normalizedText.includes(token)).length;
  return matched >= Math.max(2, Math.ceil(tokens.length * 0.35));
}

export function intentVerbatimCovered(text: string, requirement: string): boolean {
  const quote = requirement.match(/^(?:\s*\[(?:verbatim)\]\s*)?(?:原句|原文)\s*[：:]\s*[「『“"”](.*?)[」』”"]\s*$/u)?.[1];
  return text.includes((quote ?? requirement).trim());
}
