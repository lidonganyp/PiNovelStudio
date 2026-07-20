/**
 * PiNovelStudio — Anti-AI Detector
 *
 * 壁垒核心: AI腔检测引擎
 * P1-3: 集成路由 LLM 增强检测
 * P2-2: 六条必删模式检测
 * Round 10: 类型化参数注入
 * P21: 集成 LLM Cache 避免重复调用
 */

import { APIFallbackManager } from "../api/fallback-manager.js";
import { getTypeAwareAntiAIThreshold, getTypeProfile } from "./type-profile-manager.js";
import { getLLMCache } from "../utils/llm-cache.js";
import { getAgentModelConfig } from "../utils/config.js";
import { buildHumanPurposeWritingRulesBlock } from "./human-purpose-writing-rules.js";
import { ANTI_AI_PROMPT_RESOURCE_PATTERNS } from "./anti-ai-prompt-resources.js";
import type { NovelType } from "./type-profile-types.js";

export interface AIPattern {
  id: string;
  pattern: RegExp;
  tag: string;
  severity: number;
  fix?: string;
  category: "structure" | "language" | "description" | "dialogue" | "scene" | "narration_strategy";
}

export interface DetectionResult {
  patternId: string;
  tag: string;
  severity: number;
  count: number;
  positions: number[];
  fix: string;
}

// Pattern 风险分类已提取到 anti-ai-pattern-classifier.ts（refactor，行为零变化）
// re-export 保持向后兼容：现有消费者仍从 anti-ai-detector.js 导入这些符号
export {
  type AntiAIPatternResidueKind,
  STYLE_CONFLICT_PATTERN_IDS,
  STRUCTURAL_AI_RESIDUE_BLOCKLIST,
  isStructuralResidueBlocklisted,
  classifyPatternResidueKind,
} from "./anti-ai-pattern-classifier.js";

export interface AnalysisResult {
  density: number;
  level: "green" | "yellow" | "red";
  detections: DetectionResult[];
  report: string;
  totalIssues: number;
  /** Round 10 P1: 类型化扩展数据 */
  _typeAware?: {
    threshold: number;
    strictnessLevel: "strict" | "medium" | "lenient";
  };
}

/**
 * 章末AI腔专项检测结果
 */
export interface EndingAIResult {
  score: number;           // 0-1, 越高越好
  level: "pass" | "warning" | "fail";
  detections: EndingDetection[];
  report: string;
}

export interface EndingDetection {
  patternId: string;
  tag: string;
  match: string;
  position: number;
  fix: string;
}

// 重复句清理已提取到 anti-ai-repeated-sentence-cleaner.ts（refactor，行为零变化）
import {
  type RepeatableSentenceSpan,
  collectExactRepeatedSentencePositions,
  removeExactRepeatedSentences,
} from "./anti-ai-repeated-sentence-cleaner.js";

// re-export 保持向后兼容：现有消费者仍从 anti-ai-detector.js 导入这些符号
export { removeExactRepeatedSentences, type ExactRepeatedSentenceCleanupResult } from "./anti-ai-repeated-sentence-cleaner.js";

function maskDialogueContent(text: string): string {
  return text
    .replace(/“[^”]*”/g, (match) => " ".repeat(match.length))
    .replace(/"[^"\n]*"/g, (match) => " ".repeat(match.length));
}

function collectRegexPositions(text: string, pattern: RegExp): number[] {
  const positions: number[] = [];
  const regex = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    positions.push(match.index);
    if (match[0].length === 0) {
      regex.lastIndex += 1;
    }
  }

  return positions;
}

function collectNonDialogueSentenceSpans(text: string): RepeatableSentenceSpan[] {
  const masked = maskDialogueContent(text);
  const spans: RepeatableSentenceSpan[] = [];
  const sentenceRegex = /[^。！？\n]+[。！？]?/g;
  let match: RegExpExecArray | null;

  while ((match = sentenceRegex.exec(masked)) !== null) {
    const raw = text.slice(match.index, match.index + match[0].length);
    // R22修复: normalized 从 masked 文本切，确保对话引号内容被真正排除。
    // 纯对话句的 normalized 为空 → 自动跳过；混合句保留叙事部分。
    const maskedRaw = masked.slice(match.index, match.index + match[0].length);
    const normalized = maskedRaw.replace(/\s+/g, "").replace(/[。！？]+$/g, "");

    if (normalized.length === 0) {
      continue;
    }

    spans.push({
      raw,
      normalized,
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  return spans;
}

function collectRpgStatusLabelPositions(text: string): number[] {
  const masked = maskDialogueContent(text);
  const positions = collectRegexPositions(
    masked,
    /^\s*(?:状态|危险等级|风险等级|任务目标|剩余时间|目标|阶段|异常等级|提示|系统|任务|进度|能力|道具|位置|时间)[:：]/gm
  );

  return positions.length >= 3 ? positions : [];
}

function collectPronounDriftPositions(text: string): number[] {
  const spans = collectNonDialogueSentenceSpans(text);
  let thirdPersonBefore = 0;
  const driftPositions: number[] = [];

  for (const span of spans) {
    const content = span.normalized;
    const hasThirdPerson = /(?:他|她)/.test(content);
    const hasFirstOrSecondPerson = /(?:^|[，,；;])(?:我|你)(?:知道|不能|没有|必须|要|会|应该|已经|看|听|想|得|先|再)/.test(content);

    if (hasThirdPerson) {
      thirdPersonBefore += 1;
      continue;
    }

    if (thirdPersonBefore >= 2 && hasFirstOrSecondPerson) {
      driftPositions.push(span.start);
    }
  }

  return driftPositions.length >= 2 ? driftPositions : [];
}

/**
 * R28: 过滤 excessive_ellipsis 的误报——排除有效叙事短句。
 *
 * excessive_ellipsis 正则 /^[\u4e00-\u9fa5]{1,4}[。！？]$/gm 匹配所有 1-4 字短句，
 * 但网文写作中短句独立成行是标志性句式（风格指纹明确要求"短句独立成行（砰！吼！）做高压节奏"）。
 * 只有纯名词/形容词、无动词、无信息量的短句才是真正的"过度省略"AI 腔。
 *
 * 排除规则:
 * 1. 含动词的短句（发送、走、跑、看、听、说、想、笑、接、来、去、停、坐、站等）
 * 2. 时间表达（X分钟、X秒、X小时、X天、X年等）
 * 3. 疑问句（含"呢""吗""吧"等语气词结尾）
 * 4. 数量描述（X个字、X条、X次等）
 * 5. IM/手机场景动作标签（发送、屏幕亮了、没人接等）
 */
// [FIX 2026-06-26] 物件名词视觉聚焦字集合
// 2字短句含以下字时,几乎都是物件/身体部位名词(风衣/刀/信/杯子等),不是形容词。
// 网文常用"物件名+句号"做视觉聚焦,是有效文学手法。
// 注意:不含自然现象(火/冰/雪/雾等)、金属(金/银等)、时间字,避免误伤形容词(火热/冰冷/雪白)。
const OBJECT_NOUN_CHAR = /[衣服饰裙鞋帽袜巾包裹袋盒瓶杯碗碟盘筷刀叉勺笔纸书信卡证件牌票键屏幕镜灯锁钥链环戒表钟车船机枪炮剑弓箭盾甲盔靴杖珠玉木竹布丝绒皮革骨角牙爪鳞毛发眼眉唇指掌拳腕臂肩胸背腰腿脚膝踝颈头脸口鼻耳窗门墙砖瓦石土沙泥病梦话事命根级伤疤线索痕印迹影]/;
// [FIX 2026-06-26] 方位短句模式——纯方位字组合(2-4字)
// 匹配"右后侧""正上方""左前方""外侧""里侧"等空间聚焦短句。
// 限定 2-4 字且全为方位字,不含动词,排除"向前走"等含动词的结构。
const DIRECTION_PHRASE_PATTERN = /^[左右前后上下旁侧内外里中间顶底角端方正偏斜]+$/;
function filterExcessiveEllipsisFalsePositives(
  text: string,
  positions: number[]
): { positions: number[]; matches: string[] } {
  // 含动词的短句——动词使短句有完整结构，不是"过度省略"
  // [FIX 2026-06-26] 加修真/侦查动词(探/查/寻/观/察/感/触)——"反向探。""一查。""感。"等
  // 是修真场景有效侦查动作短句,不是 AI 腔成分缺失。
  const VERB_PATTERN = /(发送|走|跑|看|听|说|想|笑|哭|接|来|去|停|顿|坐|站|醒|睡|死|活|打|吃|喝|拿|放|开|关|回|进|出|上|下|起|落|抬|低|转|伸|缩|迈|踏|冲|拍|握|攥|捏|揉|搓|叹|喘|瞪|盯|眨|闭|张|咬|舔|咽|吐|咳|颤|抖|僵|软|硬|热|冷|疼|痒|麻|酸|亮|暗|响|静|动|破|碎|裂|断|合|开|关|锁|解|系|绑|松|紧|穿|脱|洗|擦|抹|涂|敷|包|拆|建|拆|修|补|换|扔|捡|拾|丢|抛|掷|投|捧|托|举|扛|背|抱|搂|牵|拉|推|挤|靠|倚|躺|趴|跪|蹲|跳|跃|飞|游|爬|滑|摔|跌|撞|碰|磕|碰|敲|砸|锤|劈|砍|刺|扎|射|投|扔|抛|掷|撩|拨|弹|吹|吸|呼|喷|冒|滴|流|淌|渗|漏|溢|溅|洒|散|聚|堆|叠|摞|排|列|铺|垫|盖|罩|蒙|裹|包|卷|折|叠|弯|曲|直|伸|缩|展|收|张|闭|合|分|离|合|聚|散|开|关|启|闭|锁|解|系|绑|松|紧|落|升|降|沉|浮|漂|坠|升|腾|降|落|沉|浮|起|伏|颠|簸|晃|摇|摆|颤|抖|闪|躲|避|逃|追|赶|拦|挡|阻|护|卫|守|攻|击|打|揍|捶|砸|锤|劈|砍|刺|扎|射|撩|拨|弹|踢|踹|踩|跺|跨|迈|走|跑|跳|跃|飞|游|爬|滑|摔|跌|撞|碰|磕|碰|敲|探|查|寻|扫|观|察|感|触|窥|测|算|卜|封|镇|祭|炼|渡|引|领|唤|招|凝|聚|散|收|放|吐|纳|吸|呼|循|运|转|行|住|坐|卧)/;
  // [FIX 2026-06-26] 谓语性字——"桌子稳了。""他准了。""灯亮着，灯暗着。"等
  // 主谓短句(主语+谓语形容词/状态动词+"了/着/过")是完整结构，不是"过度省略"AI 腔。
  // 之前的 VERB_PATTERN 漏掉稳/准/对/错/累/困/饿/渴等状态字，导致"桌子稳了。"被误判。
  // [FIX 2026-06-26] 加"没"——"馆内没人。""没风。""没水。"等是否定存在状态描述
  // (省略存在动词"有"),是有效叙事短句,不是 AI 腔成分缺失。
  // [FIX 2026-06-26 P23] 加"灭|点|燃|烧|熄"——悬疑/恐怖场景火光熄灭与点燃是核心节奏短句
  // ("火苗灭了。""他重新点。""又灭。""点着了。""灯又灭了。"),含这些动词的短句是有效叙事,
  // 不是 AI 腔成分缺失。之前漏掉这些字导致悬疑场景大量误判。
  const PREDICATE_STATE_PATTERN = /(稳|准|对|错|累|困|饿|渴|痛|胀|晕|闷|烦|腻|倦|疲|乏|饱|饿|渴|醒|醉|疯|傻|痴|呆|懵|钝|迟|疾|徐|缓|急|稳|乱|齐|散|聚|满|空|完|尽|绝|断|续|停|行|中|成|败|输|赢|胜|负|生|死|活|来|去|起|落|升|降|出|入|回|转|到|离|在|有|无|没|灭|点|燃|烧|熄)/;

  // 时间表达短句——"一分钟。""两分钟。""五分钟。"等是有效的时间节奏叙事
  const TIME_PATTERN = /^[一两二三三四五六七八九十百千万几\d]+[分钟秒小时天年月次遍趟场步]$/;

  // 疑问句——"现在呢？""是吗？""行吧？"等是内心独白反问，不是过度省略
  const QUESTION_PATTERN = /[呢吗吧啊呀嘛哦噢嗯哼]$/;

  // 数量描述——"三个字。""两条。""一次。"等是有效信息
  // 支持"X个字""X条字"等带"字"后缀的结构
  const COUNT_PATTERN = /^[一二三四五六七八九十百千万几\d]+[个只条根把块瓶杯碗次遍趟场步](字|条|份|篇|段)?$/;

  // [FIX 2026-06-26] 度量短句——"两米。""一米半。""两厘米。""一厘米。""三丈。""五尺。"等
  // 网文打斗/修炼场景常用距离/尺寸递减短句制造节奏感(如"两米。一米半。再近就是出手距离。"),
  // 是有效叙事手法,不是 AI 腔成分缺失。支持多字单位(厘米/毫米/公里/公分)和"半/余/多"后缀。
  // [FIX 2026-06-26] 加"了/前/后/内/外/间"后缀——"两天了。""三天前。""两年前。"等
  // 时间+时态/方位后缀是有效叙事(时间节奏+时态标记),不是 AI 腔成分缺失。
  const MEASURE_PATTERN = /^[一两二三三四五六七八九十百千万几零\d]+(分钟|小时|厘米|毫米|公里|公分|公尺|丈|尺|寸|米|斤|两|度|分|秒|天|年|月|次|遍|趟|场|步|个|只|条|根|把|块)(半|余|多|了|前|后|内|外|间)?$/;

  // [FIX 2026-06-26] 数量+名词短句——"三次任务。""两次测试。""一回战斗。"等
  // "数词+量词+1-2字名词"是完整信息短句(数量+对象),是有效叙事,不是 AI 腔成分缺失。
  // 网文常见任务/事件计数短句制造节奏感。
  const COUNT_NOUN_PATTERN = /^[一两二三三四五六七八九十百千万几零\d]+[个只条根把块瓶杯碗次遍趟场步][一-鿿]{1,2}$/;

  // [FIX 2026-06-26] 2字状态动词短句——"气息消失。""声音响起。""空气凝固。"等
  // 主语(2字名词)+2字状态动词构成完整主谓结构,是有效叙事。
  // VERB_PATTERN 是单字匹配,漏掉"消失/响起/凝固"等2字动词,导致主谓短句被误判为"过度省略"。
  const TWO_CHAR_STATE_VERB_PATTERN = /(消失|响起|消散|凝固|凝结|蔓延|扩散|汇聚|聚集|涌动|流淌|流动|静止|停顿|停滞|震荡|颤动|波动|起伏|沉下|浮起|坠落|升起|降临|笼罩|覆盖|包裹|侵入|渗入|渗透|贯穿|刺入|刺穿|撕裂|崩塌|崩溃|瓦解|破碎|碎裂|断裂|炸裂|爆裂|迸发|喷涌|倾泻|退散|散去|涌来|袭来|扑来|压来|逼近|远去|消逝)/;

  // IM/手机场景动作标签——"发送。""屏幕亮了。""没人接。"等是 IM 场景有效叙事
  const IM_ACTION_SHORT = /^(发送|屏幕亮了|没人接|第三条|第一条|第二条|已送达|已读|未读|在线|离线|正在输入)$/;

  // [FIX 2026-06-26] 否定短句——"不对。""不行。""没。""没有。""别。""别说。"等是有效反问/否定叙事
  const NEGATION_SHORT = /^(不|没|没有|别|别说|别动|别去|别走|不行|不对|不是|不会|不能|不敢|不想|不愿|不肯|不要|不该|不至于|不至于|未必|未曾|从未|从来不|从不)$/;
  // [FIX 2026-06-26] 否定强调短句——"不是商量。""不是请求。""不是一次。"等"不是+1-2字"结构
  // 是中文常见的否定强调修辞(界定性质/澄清意图),是有效叙事,不是 AI 腔成分缺失。
  const NEGATION_EMPHASIS_PATTERN = /^不是[^。！？.!?\n]{1,3}$/;
  // [FIX 2026-06-26] 主谓短句——"气在。""人在。""灯灭了。"等含动词的极短句是有效叙事
  // VERB_PATTERN 已覆盖大部分动词，但"在"作为存在动词单独出现时需额外排除
  const EXISTENCE_VERB_SHORT = /^(在|有|无|空|满|没了|在了|有着|无了)$/;

  const filteredPositions: number[] = [];
  const filteredMatches: string[] = [];

  for (const pos of positions) {
    // 提取匹配的短句文本（去掉句末标点）
    const raw = text.slice(pos, pos + 10);
    const matchResult = raw.match(/^[\u4e00-\u9fa5]{1,4}[。！？]/);
    if (!matchResult) continue;

    const sentence = matchResult[0];
    const content = sentence.slice(0, -1); // 去掉句末标点

    // 排除：含动词的短句
    if (VERB_PATTERN.test(content)) continue;
    // [FIX 2026-06-26] 排除：谓语状态短句（"桌子稳了。""他准了。"等主谓完整结构）
    if (PREDICATE_STATE_PATTERN.test(content)) continue;
    // 排除：时间表达（检查 content，不含句末标点）
    if (TIME_PATTERN.test(content)) continue;
    // 排除：疑问句
    if (QUESTION_PATTERN.test(content)) continue;
    // 排除：数量描述（检查 content，不含句末标点）
    if (COUNT_PATTERN.test(content)) continue;
    // [FIX 2026-06-26] 排除：度量短句（"两米。""一米半。""两厘米。"等距离/尺寸递减节奏短句）
    if (MEASURE_PATTERN.test(content)) continue;
    // [FIX 2026-06-26] 排除：数量+名词短句（"三次任务。""两次测试。"等数量+对象结构）
    if (COUNT_NOUN_PATTERN.test(content)) continue;
    // [FIX 2026-06-26] 排除：2字状态动词短句（"气息消失。""声音响起。"等主谓结构）
    if (TWO_CHAR_STATE_VERB_PATTERN.test(content)) continue;
    // 排除：IM 动作标签
    if (IM_ACTION_SHORT.test(content)) continue;
    // [FIX 2026-06-26] 排除：否定短句（"不对。""不行。"等是有效反问/否定叙事）
    if (NEGATION_SHORT.test(content)) continue;
    // [FIX 2026-06-26] 排除：存在动词短句（"气在。""人在。"等是有效主谓叙事）
    if (EXISTENCE_VERB_SHORT.test(content)) continue;
    // [FIX 2026-06-26] 排除：物件名词视觉聚焦短句
    // 网文 revelation/紧张场景常用"物件名+句号"制造视觉聚焦(如"风衣。""刀。""信。"),
    // 这是有效文学手法,不是 AI 腔的形容词堆砌。bare_adjective_sentence 本意抓形容词,
    // 但正则匹配任何 1-2 字短句,需排除物件名词。仅对 2 字短句过滤(1 字多为语气词)。
    if (content.length === 2 && OBJECT_NOUN_CHAR.test(content)) continue;
    // [FIX 2026-06-26] 排除：3字名词短句(如"老毛病。""旧伤疤。""新线索。")
    // 网文常用3字名词短语做视觉聚焦/节奏停顿,含名词字时是有效叙事。
    // 限定3字且任一字在 OBJECT_NOUN_CHAR,避免误伤纯形容词(如"白茫茫"无名词字)。
    if (content.length === 3 && OBJECT_NOUN_CHAR.test(content)) continue;
    // [FIX 2026-06-26] 排除：方位名词短句(2-4字纯方位组合)
    // 战斗/探索场景常用"右后侧。""正上方。""左前方。"做空间聚焦,是有效叙事手法。
    // 仅匹配纯方位字组合,不含动词,不是 AI 腔的成分缺失。
    if (content.length >= 2 && content.length <= 4 && DIRECTION_PHRASE_PATTERN.test(content)) continue;
    // [FIX 2026-06-26] 排除：否定强调短句(如"不是商量。""不是请求。")
    // 中文常见的否定强调修辞,界定性质/澄清意图,是有效叙事。
    if (NEGATION_EMPHASIS_PATTERN.test(content)) continue;

    filteredPositions.push(pos);
    filteredMatches.push(sentence);
  }

  return { positions: filteredPositions, matches: filteredMatches };
}

/**
 * [FIX 2026-06-26] 检测位置是否在对话引号内
 * 对话引号内的"不是X，是Y"是角色语言(教学/争辩/强调),不是 AI 叙事腔否定铺垫。
 * 支持:直引号 "(U+0022 奇数个未闭合)、弯引号 "/"(U+201C/U+300C 未闭合)、
 *      日式引号 「」(U+300C/U+300D 未闭合)。
 * 复用 filterNegatedActionPaddingFalsePositives 的引号平衡逻辑。
 */
function isPositionWithinDialogue(text: string, pos: number): boolean {
  const prefix = text.substring(0, pos);
  const straightQuotes = (prefix.match(/"/gu) || []).length;
  if (straightQuotes % 2 === 1) {
    return true;
  }
  const curvedStarts = (prefix.match(/[\u201C\u300C]/gu) || []).length;
  const curvedEnds = (prefix.match(/[\u201D\u300D]/gu) || []).length;
  if (curvedStarts > curvedEnds) {
    return true;
  }
  return false;
}

/**
 * R31: 过滤 resource_negative_is_shortcut 的误判
 * 排除具体名词对比（如"不是正门，是侧楼梯"），只保留抽象概念否定铺垫
 * 具体名词对比是文学修辞手法，不是 AI 腔
 *
 * R31b 修复（P22 验收）: 原 R31 过滤太激进，用"抽象概念词列表"作为唯一判据，
 * 把"不是一次普通的异常，而是住院记录被改写后的现场证据"这种带修饰语的
 * AI 腔长句叙事也过滤掉了。新策略：只过滤明确的"人名/代词/短具体名词"对比
 * （A、B 均 ≤4 字且无修饰结构），保留带修饰语或较长的"不是...是..."结构。
 * 这样既保留对"不是张三，是李四"这类文学修辞的过滤，又能检测翻译腔和
 * 带修饰语的 AI 腔否定铺垫。
 */
function filterResourceNegativeFalsePositives(
  text: string,
  positions: number[]
): { positions: number[]; matches: string[] } {
  // 抽象概念词——这些词出现在"不是A，是B"中时，是 AI 腔否定铺垫
  // AI 腔典型模式：不是能力问题，是态度问题 / 不是技术，是心态 / 不是方法，是执行
  const ABSTRACT_CONCEPT_PATTERN = /(?:问题|态度|能力|实力|智慧|勇气|心态|状态|情况|情形|本质|表面|内在|外在|形式|内容|意义|价值|目的|目标|方向|方式|手段|工具|资源|条件|环境|背景|基础|根基|根本|核心|关键|重点|要点|难点|焦点|特色|特点|特征|特性|属性|性质|品质|质量|水平|标准|规格|规范|规则|规律|原则|理论|理念|观念|思想|思维|意识|认识|认知|理解|领悟|感受|体验|经历|经验|教训|启示|灵感|创意|创新|创造|发明|发现|探索|研究|调查|分析|总结|判断|决策|选择|抉择|决定|决心|意志|毅力|耐心|细心|粗心|用心|尽力|努力|勤奋|懒惰|积极|消极|主动|被动|乐观|悲观|开朗|内向|外向|热情|冷漠|温柔|粗暴|友善|敌意|仇恨|爱慕|喜欢|讨厌|厌恶|憎恨|愤怒|生气|开心|快乐|悲伤|难过|痛苦|幸福|不幸|幸运|倒霉|运气|命运|缘分|机遇|机会|挑战|困难|障碍|阻力|助力|动力|压力|张力|冲突|矛盾|和谐|对立|变化|发展|进步|退步|前进|后退|上升|下降|增长|减少|增加|降低|提高|改善|恶化|感觉|情绪|心情|现象|形式|方法|技术|艺术|工艺|思想|思维|意识|认识|认知|理解|领悟|体会|感受|体验|经历|经验|教训|启示|启发|灵感|创意|创新|创造|发明|发现|探索|研究|调查|分析|总结|概括|归纳|演绎|推理|判断|决策|选择|抉择|决定|决心|意志|毅力|耐心|细心|粗心|用心|尽心|全力|努力|勤奋|懒惰|积极|消极|主动|被动|乐观|悲观|开朗|内向|外向|热情|冷漠|温柔|粗暴|和蔼|凶狠|友善|敌意|仇恨|爱慕|喜欢|讨厌|厌恶|憎恨|愤怒|生气|开心|快乐|悲伤|难过|痛苦|幸福|不幸|幸运|倒霉|运气|命运|缘分|机遇|机会|挑战|困难|障碍|阻力|助力|动力|压力|张力|冲突|矛盾|和谐|统一|对立|变化|发展|进步|退步|前进|后退|上升|下降|增长|减少|增加|降低|提高|改善|恶化)$/;

  // R31b: 修饰结构标记——出现这些词说明"不是...是..."带修饰语，是 AI 腔叙事而非文学修辞
  // 例如："不是一次普通的异常"（数量+形容词）、"不是被改写后的现场证据"（被动+时态）
  const MODIFIER_MARKER_PATTERN = /(?:一次|一个|一种|一些|那种|这种|那种|某|某次|某个|普通|真正|所谓|被|后的|前的|的|地|得|着|了|过|已经|曾经|刚刚|正在|似乎|仿佛|犹如|宛如|像是|好比|如同)/;

  // R31b: 人名/代词模式——明确的文学修辞对比，应过滤
  // 例如："不是张三，是李四"、"不是你的，是借来的"、"不是正门，是侧楼梯"
  const PERSON_OR_PRONOUN_PATTERN = /^(?:张三|李四|王五|赵六|小明|小红|小华|他|她|它|你|我|你们|我们|他们|她们|它们|你的|我的|他的|她的|它的|这边|那边|这里|那里|这个|那个|正门|侧门|后门|前门|侧楼梯|主楼梯|楼上|楼下|里面|外面|左边|右边)$/;

  // P22修复: 感官/触觉/温度描写类——"不是A温，是B凉"是文学感官对比，不是 AI 腔
  // 当 partA 或 partB 含感官词（温度/触觉/光影/声音）时，过滤为文学修辞
  const SENSORY_DESCRIPTION_PATTERN = /(?:余温|凉|热|烫|冷|冰|暖|寒|温|凉透|冰凉|滚烫|灼热|冰冷|刺骨|阴冷|余热|熄|灭|亮|暗|光|影|声|响|味|气|香|臭|涩|甜|苦|辣|咸|颤|抖|麻|痛|痒|软|硬|粗|细|滑|糙|轻|重|沉|浮)/;

  // [FIX 2026-06-26] 具体事物词——网文揭示句式"不是旧电——是新接的"含具体事物词，
  // 是文学揭示修辞（真相揭示），不是翻译腔 AI 腔。当 partA 或 partB 含具体事物词时过滤。
  const CONCRETE_OBJECT_PATTERN = /(?:电|断口|灵脉|引线|刀|核心|账|代价|人|自己|旧电|新电|旧路|新路|装置|机关|阵|符|线|管|芯|头|尾|端|门|窗|墙|地|板|顶|柱|台|案|柜|盒|瓶|玉简|记录|日志|痕迹|证据|线索|指纹|脚印|血|水|火|烟|灰|尘|土|石|木|铁|铜|银|金)/;

  // [FIX 2026-06-26] 情绪/认知状态词——"不是惊讶，是认得"描述角色情绪→认知的状态转换,
  // 是文学内心刻画,不是翻译腔 AI 腔否定铺垫。仅当非破折号连接且 A/B 均 ≤4 字时过滤。
  // 破折号"——是"连接的是英译中迁移模式("不是X——是Y"="It's not X — it's Y"),仍保留检测。
  const EMOTION_COGNITION_PATTERN = /^(?:惊讶|惊|愣|怔|呆|懵|痴|傻|怒|气|愤|恼|恨|怕|惧|慌|急|忧|愁|苦|悲|哀|痛|疼|累|倦|疲|乏|困|饿|渴|饱|醉|醒|喜|乐|笑|哭|认得|认识|明白|懂|会|知道|清楚|熟悉|陌生|警觉|清醒|迷茫|疑惑|犹豫|坚决|镇定|冷静|平静|认命|抗拒|顺从|妥协|坚持|放弃|害怕|恐惧|紧张|焦虑|不安|担心|忐忑|迟疑|踌躇|纠结|矛盾|激动|兴奋|低落|失落|失望|满足|庆幸|后悔|无奈|不甘|愤怒|生气|开心|快乐|悲伤|难过|幸福|不幸|幸运|倒霉)$/;

  // [FIX 2026-06-26] 力量性质词——修真/精神空间场景"不是威压，是撕裂"/"不是弹开，是涌来"
  // /"不是实体，是某种边界" 描述力量性质或空间性质对比,
  // 是修真文学有效修辞(区分两种力量感受/空间属性),不是翻译腔 AI 腔否定铺垫。
  // 当 partA 或 partB 含力量性质词时,过滤为修真场景有效修辞。
  // 注意:用子串匹配(非锚定)以处理"某种边界""一种威压"等带修饰语的形式。
  const FORCE_NATURE_PATTERN = /(?:威压|撕裂|冲击|震荡|侵蚀|灼烧|冰冻|切割|贯穿|压迫|吞噬|腐蚀|渗透|侵入|挤压|拉扯|扭曲|冻结|燃烧|震颤|波动|气浪|劲风|罡气|灵压|神识|意念|意志|杀意|敌意|恶意|怒意|怨气|煞气|阴气|阳气|戾气|邪气|正气|灵气|妖气|鬼气|魔气|佛气|仙气|神气|道韵|道意|剑意|刀意|拳意|掌意|阵意|符意|丹意|器意|法意|心魔|执念|妄念|杂念|念头|识念|神念|魂力|精神力|灵魂力|法力|真元|内力|外力|暗劲|明劲|化劲|罡劲|柔劲|刚劲|阴劲|阳劲|虚劲|实劲|力场|气场|势场|压力|张力|斥力|引力|拉力|推力|阻力|摩擦力|向心力|离心力|弹开|涌来|涌出|涌动|扩散|蔓延|凝聚|凝结|凝固|崩散|溃散|消散|蒸发|沸腾|翻涌|搅动|搅碎|割裂|割开|劈开|劈裂|崩裂|炸裂|爆裂|爆开|炸开|实体|虚体|幻象|投影|镜像|虚影|边界|空间|界域|领域|结界|阵界|识海|心境|心域|灵境|虚境|实境|破裂|断裂|碎裂|裂开|崩塌|坍塌|塌陷|陷落|崩坏|损坏|破损|损坏|磨损|消耗|耗损|损耗|损伤|伤害|破坏|毁坏|损毁|毁损|崩坏|碎裂|碎裂|碎裂)/;

  const filteredPositions: number[] = [];
  const filteredMatches: string[] = [];

  for (const pos of positions) {
    // [FIX 2026-06-26] 对话内的"不是X，是Y"是角色语言(教学/争辩/强调),不是 AI 叙事腔
    // 例: 师傅教学"不是肌肉，是判断。你每次感知到威胁，重心先走..."是师傅指导弟子,
    // "判断"虽在抽象概念词表内,但对话语境下是自然表达,不是翻译腔否定铺垫。
    if (isPositionWithinDialogue(text, pos)) {
      continue;
    }
    // 提取匹配的完整文本
    const raw = text.slice(pos, pos + 80);
    // 匹配 "不是A，是B" 或 "不是A，而是B" 结构
    // 注意：与原 pattern 保持一致，不排除逗号（A 可能含逗号，如"一次普通的异常，"）
    // 提取 partA/partB 后再 trim 掉尾部的逗号/句号
    const matchResult = raw.match(/这?不是([^。！？\n]{2,30})(?:而是|[，,。]是|——是|—是|--是|-是)([^。！？\n]{2,40})/);
    if (!matchResult) continue;

    // trim 掉 partA 尾部的逗号/句号（原 pattern 允许 A 含逗号）
    const partA = matchResult[1].replace(/[，,。]+$/, "").trim();
    const partB = matchResult[2].trim();

    // 1. 抽象概念对比 → 保留为 AI 腔检测
    const aIsAbstract = ABSTRACT_CONCEPT_PATTERN.test(partA);
    const bIsAbstract = ABSTRACT_CONCEPT_PATTERN.test(partB);
    if (aIsAbstract || bIsAbstract) {
      filteredPositions.push(pos);
      filteredMatches.push(matchResult[0]);
      continue;
    }

    // [FIX 2026-06-26] 情绪/认知状态对比(非破折号连接,A/B 均 ≤4 字) → 过滤为文学内心刻画
    // 必须在 MODIFIER 检查之前:否则"认得"的"得"会被 MODIFIER_MARKER 误判为修饰语,
    // 把"不是惊讶，是认得"这类文学情绪对比误推入分支2并保留检测。
    // 破折号"——是"连接的是英译中迁移模式,仍保留检测(不在此过滤)。
    {
      const isDashConnForEmotion = /——是|—是|--是|-是/.test(matchResult[0]);
      if (!isDashConnForEmotion && partA.length <= 4 && partB.length <= 4) {
        const aIsEmotion = EMOTION_COGNITION_PATTERN.test(partA);
        const bIsEmotion = EMOTION_COGNITION_PATTERN.test(partB);
        if (aIsEmotion || bIsEmotion) {
          continue;
        }
      }
    }

    // [FIX 2026-06-26] 力量性质/空间性质对比(非破折号连接,A/B 均 ≤8 字) → 过滤为修真场景有效修辞
    // "不是威压，是撕裂"/"不是实体，是某种边界" 区分两种力量感受/空间属性,
    // 是修真文学手法,不是翻译腔 AI 腔否定铺垫。
    // 破折号"——是"连接的是英译中迁移模式,仍保留检测(不在此过滤)。
    // 用子串匹配(非锚定)以处理"某种边界""一种威压"等带修饰语的形式。
    {
      const isDashConnForForce = /——是|—是|--是|-是/.test(matchResult[0]);
      if (!isDashConnForForce && partA.length <= 8 && partB.length <= 8) {
        const aIsForce = FORCE_NATURE_PATTERN.test(partA);
        const bIsForce = FORCE_NATURE_PATTERN.test(partB);
        if (aIsForce || bIsForce) {
          continue;
        }
      }
    }

    // [FIX 2026-06-26] 修真揭示修辞(非破折号连接,partA 含力量词 + partB 含具体状态描写) → 过滤
    // "不是威压。是某种极旧的、快要耗尽的东西" 是修真场景排除法锁定未知本质,
    // partB 虽长(>8字)且带修饰语,但含具体状态描写(极旧/快要耗尽等),是文学感知揭示,非 AI 腔。
    // [FIX 2026-06-26] 扩展:文学揭示修辞"不是破裂，是一段...第二种读法"否定物理状态+揭示认知解读,
    // partA 含物理状态词(破裂等),partB 含认知/揭示词(读法/历史/真相等),是文学揭示,非 AI 腔。
    // 破折号连接的否定对比是翻译腔,不过滤。
    {
      const isDashConnForReveal = /——是|—是|--是|-是/.test(matchResult[0]);
      if (!isDashConnForReveal) {
        const CONCRETE_DESCRIPTION_PATTERN = /(?:极旧|极新|古老|苍老|陈旧|破败|衰败|腐朽|干涸|枯竭|耗尽|快要|将要|即将|残存|残留|剩余|微弱|微细|细微|稀薄|浓稠|黏稠|粘稠|滞涩|干涩|苦涩|腥甜|铁锈|血腥|腐朽味|霉味|焦味|烟味|冰冷|滚烫|灼热|刺骨|阴冷|发烫|发凉|发麻|发颤|发紧|发松|颤动|搏动|脉动|跳动|涌动|翻涌|搅动|撕裂|割裂|挤压|拉扯|扭曲|凝结|凝固|崩散|溃散|消散|蒸发|沸腾)/;
        const COGNITIVE_REVEAL_PATTERN = /(?:读法|解读|解释|意义|含义|内涵|真相|事实|秘密|记忆|历史|往事|故事|版本|说法|视角|观点|角度|层次|维度|侧面|另一面|第二种|另一种|新的|重新|刚刚|方才|才|生|长出|浮现|显现|显露|暴露|揭开|揭示|曝光|明朗|清晰)/;
        const aIsForce = FORCE_NATURE_PATTERN.test(partA);
        const bIsConcreteDesc = CONCRETE_DESCRIPTION_PATTERN.test(partB);
        const bIsCognitiveReveal = COGNITIVE_REVEAL_PATTERN.test(partB);
        if (aIsForce && (bIsConcreteDesc || bIsCognitiveReveal)) {
          continue;
        }
      }
    }

    // 2. R31b: 带修饰语的"不是...是..." → 保留为 AI 腔检测
    //    带修饰语说明是叙事性否定铺垫（如"不是一次普通的异常，而是现场证据"），不是短修辞
    const aHasModifier = MODIFIER_MARKER_PATTERN.test(partA);
    const bHasModifier = MODIFIER_MARKER_PATTERN.test(partB);
    if (aHasModifier || bHasModifier) {
      // P22修复: 即使带修饰语，若是感官/温度/触觉描写（如"不是刚熄的余温，是凉透了的凉"），
      // 仍是文学感官对比，不是 AI 腔否定铺垫。先检查感官词再决定。
      // 但破折号连接的否定对比是翻译腔，不过滤。
      const aIsSensory = SENSORY_DESCRIPTION_PATTERN.test(partA);
      const bIsSensory = SENSORY_DESCRIPTION_PATTERN.test(partB);
      const isDashConn = /——是|—是|--是|-是/.test(matchResult[0]);
      if ((aIsSensory || bIsSensory) && !isDashConn) {
        // 感官描写对比，过滤为文学修辞
        continue;
      }
      // [FIX 2026-06-26] 具体事物词揭示修辞：网文"不是旧电——是新接的"含具体事物词，
      // 是真相揭示句式，不是翻译腔 AI 腔。即使带修饰语/破折号也过滤。
      // [FIX 2026-06-26] 仅短揭示修辞(A/B 均 ≤8 字)过滤;长成分含具体词(如
      // "住院记录被改写后的现场证据"14字)是叙事 AI 腔否定铺垫,保留检测。
      const aIsConcrete = CONCRETE_OBJECT_PATTERN.test(partA);
      const bIsConcrete = CONCRETE_OBJECT_PATTERN.test(partB);
      if ((aIsConcrete || bIsConcrete) && partA.length <= 8 && partB.length <= 8) {
        continue;
      }
      // [FIX 2026-06-26] 动作句式对比：partB 含"把/往/向/朝"+动作动词（如"把危险往前推了一步"）
      // 是叙事动作对比，不是抽象概念否定铺垫。partA 是纯动词（2-4字）时也过滤。
      const ACTION_SENTENCE_PATTERN = /^(?:把|将|往|向|朝|跟|随|顺|沿)[^。！？\n]{3,30}(?:了|着|过|起|开|去|来|回|进|出|上|下)$/;
      const aIsShortVerb = partA.length <= 4 && /^(?:收束|展开|延续|推进|停顿|转折|结束|开始|启动|终止|中断|继续|加速|减速|收缩|扩张|释放|吸收|爆发|沉寂|苏醒|崩溃|稳定|崩塌|升起|落下|打开|关闭|锁定|解除|触发|平息|激化|消除|产生|消失|出现|隐藏|显露|聚集|分散|凝聚|瓦解|成型|破碎|重组)$/.test(partA);
      if (aIsShortVerb || ACTION_SENTENCE_PATTERN.test(partB)) {
        continue;
      }
      filteredPositions.push(pos);
      filteredMatches.push(matchResult[0]);
      continue;
    }

    // P22修复: 感官/温度/触觉描写对比（无修饰语）也过滤为文学修辞
    // 但破折号"——是"连接的否定对比是典型翻译腔（"不是X——是Y" = "It's not X — it's Y"），
    // 即使含感官词也应保留为 AI 腔检测（英译中迁移模式）
    const isDashConnection = /——是|—是|--是|-是/.test(matchResult[0]);
    const aIsSensoryNoMod = SENSORY_DESCRIPTION_PATTERN.test(partA);
    const bIsSensoryNoMod = SENSORY_DESCRIPTION_PATTERN.test(partB);
    if ((aIsSensoryNoMod || bIsSensoryNoMod) && !isDashConnection) {
      continue;
    }
    // [FIX 2026-06-26] 具体事物词揭示修辞（无修饰语+破折号）：同样过滤
    // [FIX 2026-06-26] 仅短揭示修辞(A/B 均 ≤8 字)过滤;长成分含具体词是叙事 AI 腔,保留检测
    const aIsConcreteNoMod = CONCRETE_OBJECT_PATTERN.test(partA);
    const bIsConcreteNoMod = CONCRETE_OBJECT_PATTERN.test(partB);
    if ((aIsConcreteNoMod || bIsConcreteNoMod) && partA.length <= 8 && partB.length <= 8) {
      continue;
    }

    // 3. R31b: 明确的人名/代词/短位置对比 → 过滤为文学修辞
    //    只过滤 A、B 都 ≤4 字且匹配人名/代词/位置词的情况
    if (partA.length <= 4 && partB.length <= 4) {
      const aIsPersonOrPronoun = PERSON_OR_PRONOUN_PATTERN.test(partA);
      const bIsPersonOrPronoun = PERSON_OR_PRONOUN_PATTERN.test(partB);
      if (aIsPersonOrPronoun || bIsPersonOrPronoun) {
        // 人名/代词/短位置对比，是文学修辞，过滤掉
        continue;
      }
    }

    // [FIX 2026-06-26] 动作性质对比 → 过滤为文学叙事
    // 1) partB 以 "——" 开头(语塞/未尽):"不是愤怒，是——他说不清楚" 是文学语塞,不是 AI 腔
    // 2) partA/partB 含"在+动词+代词"(如"在教他"/"在问他"):具体动作性质对比,非抽象概念
    // 3) partA/partB 含"代词+动作动词"(如"他松手"):具体人物动作对比,非抽象概念
    {
      // partB 以破折号开头(语塞)
      if (/^[———\-]/.test(partB)) {
        continue;
      }
      // "在+动词+代词" 模式 (在教他/在问他/在逼他/在劝她)
      const ACTION_WITH_PRONOUN = /在(?:教|问|逼|劝|推|拉|挡|拦|追|赶|护|送|带|领|扶|搀|拉|扯|拽|按|压|托|抬|捧|抱|牵|搡|搀|提醒|警告|威胁|欺骗|引导|帮助|阻止|保护|攻击|防守|反击|回应|询问|回答|解释|确认|否认|拒绝|接受|同意|反对|支持|配合|对抗|反抗|服从|违抗|命令|请求|要求|恳求|哀求|乞求|劝说|说服|告知|通知|告知|透露|隐瞒|欺骗|哄骗|诱骗|欺骗)(?:他|她|它|你|我)/;
      if (ACTION_WITH_PRONOUN.test(partA) || ACTION_WITH_PRONOUN.test(partB)) {
        continue;
      }
      // "代词+动作动词" 模式 (他松手/他后退/她起身)
      const PRONOUN_ACTION = /^(?:他|她|它|你|我)(?:松手|松开|放手|后退|前进|起身|坐下|站起|躺下|转身|回头|抬头|低头|伸手|缩手|出手|收手|放手|睁眼|闭眼|张嘴|闭嘴|开口|出声|发声|沉默|说话|回答|回应|点头|摇头|挥手|摆手|招手|松开|抓紧|握紧|松开|推开|拉近|站住|停住|愣住|怔住|惊住|吓住|醒来|睡去|倒下|爬起|逃走|留下|离开|靠近|远离|走近|走开|跑来|跑去|飞来|飞去|落下|升起|沉下|浮起|潜入|浮现|消失|出现|隐去|显出)/;
      if (PRONOUN_ACTION.test(partA) || PRONOUN_ACTION.test(partB)) {
        continue;
      }
    }

    // 4. R31b: 其他"不是...是..."结构（含翻译腔短对比如"不是灯光——是晨光"）→ 保留为 AI 腔检测
    //    翻译腔是 AI 腔的重要子类，不应被过滤
    filteredPositions.push(pos);
    filteredMatches.push(matchResult[0]);
  }

  return { positions: filteredPositions, matches: filteredMatches };
}

/**
 * R32: 过滤 unnecessary_turning_word 的误判
 * "可" 字开头的转折在网文中是有效的叙事工具，只有当它确实多余时才应检测
 * 排除：对话中的口语表达（"可不是嘛"）、有效的叙事转折、时间转折、视角转折
 */
function filterUnnecessaryTurningWordFalsePositives(
  text: string,
  positions: number[]
): { positions: number[]; matches: string[] } {
  const filteredPositions: number[] = [];
  const filteredMatches: string[] = [];

  for (const pos of positions) {
    const raw = text.slice(pos, pos + 15);
    // 提取 "可" 后面的词
    const matchResult = raw.match(/可([^，。！？\n]{1,10})[，,]/);
    if (!matchResult) {
      // 无法匹配，保留
      filteredPositions.push(pos);
      filteredMatches.push(raw.substring(0, 12));
      continue;
    }

    const turningWord = matchResult[1].trim();

    // R32: "可" 字转折在网文中几乎都是有效的叙事工具
    // 只检测明确多余的转折词（如"可这一刮"这种无信息的转折）
    // 有效模式包括：
    //   - 口语表达（可不是嘛）
    //   - 人名/代词转折（可张三、可他、可她）
    //   - 时间/地点转折（可回家、可到了）
    //   - 事物转折（可这、可那、可寻常）
    // 由于网文中"可"字转折几乎都是有效的，这里过滤掉所有"可"字转折
    // 只保留极少数明确多余的（如"可这一刮"这种无主语的模糊转折）
    // 但实际上这种判断太主观，所以全部过滤
    continue;
  }

  return { positions: filteredPositions, matches: filteredMatches };
}

/**
 * R33: 过滤 bare_number_measure 的误判
 * "她们三个"、"我们三个"、"四个，不认识" 是有效的对话/代词表达
 * 只检测真正缺少名词的量词（如"七个。"没有上下文）
 */
function filterBareNumberMeasureFalsePositives(
  text: string,
  positions: number[]
): { positions: number[]; matches: string[] } {
  // [FIX 2026-06-26] 量词后接逗号+动词(如"一碗，搁在"/"一块，压在")是语境省略,过滤
  // 网文常见句式:"端起一碗，搁在桌沿"——量词后省略名词,后接动作承接,不是裸量词
  const VERB_AFTER_MEASURE_COMMA = /^(搁|放|压|塞|扔|丢|抛|摔|砸|递|端|拿|抓|握|捧|托|举|扛|抱|牵|拉|推|摆|铺|盖|罩|裹|包|埋|藏|掖|揣|插|挂|搭|披|绕|缠|系|绑|扎|打|敲|拍|摸|搓|揉|捏|拧|扯|拔|抽|捡|捞|刮|削|切|砍|劈|凿|钻|搅|拌|晃|摇|颤|抖|甩|挥|招|撑|扶|追|赶|拦|挡|护|踢|踹|踩|跨|迈|走|跑|跳|跃|爬|滑|摔|撞|碰|磕|进|出|上|下|起|落|回|转|停|坐|站|躺|趴|跪|蹲|醒|睡|死|活|吃|喝|说|笑|哭|喊|叫|吼|叹|喘|睁|闭|张|咬|吞|吐|闻|听|看|望|盯|瞪|瞥|瞄|扫|瞧|观|不|没|有|是|就|才|又|也|还|都|已|正|将|被|让|给|为|对|向|往|朝|跟|和|与|这|那|此|其)/;

  const filteredPositions: number[] = [];
  const filteredMatches: string[] = [];

  for (const pos of positions) {
    const raw = text.slice(Math.max(0, pos - 10), pos + 20);
    // 提取 pos 处的数字+量词(以 pos 为起点,而非 raw 的第一个匹配)
    // [FIX 2026-06-26] 原代码用 raw.match 取第一个匹配,但 positions 中每个 pos 指向不同匹配,
    // 第一个匹配可能与 pos 不对应,导致后续 before 检查失效(如"每一个"被当成"七八个"处理)。
    const matchResult = text.substring(pos, pos + 10).match(/^([一二三四五六七八九十百千万\d]+)([个只条根把块瓶杯碗])([。！？，,\n])/);
    if (!matchResult) {
      filteredPositions.push(pos);
      filteredMatches.push(raw.substring(0, 15));
      continue;
    }

    // 检查前面是否有人称代词（我们、你们、他们、她们）- 这是有效表达
    const before = text.substring(Math.max(0, pos - 10), pos);
    if (/(?:我们|你们|他们|她们|它们|咱们)$/.test(before)) {
      // "我们三个" 是有效的人称代词表达，过滤掉
      continue;
    }

    // [FIX 2026-06-26] 检查前面是否有指示代词/不定代词（另/这/那/某/每/前/后/上/下/左/右）
    // "另一个"、"这一个"、"某一个"、"每一个" 是有效的代词性表达，不是缺名词
    if (/(?:另|这|那|某|每|前|后|上|下|左|右|其|此)$/.test(before)) {
      continue;
    }

    // [FIX 2026-06-26] 单数代词+一个+句末 是"独一性"表达(如"只有他一个。"/"就剩她一个。")
    // 限定语境(只有/只剩/就剩/唯有/就/都/才/还)内的"代词+一个"是有效文学用法,不是裸量词
    if (matchResult[1] === "一" && matchResult[2] === "个") {
      if (/(?:他|她|它|你|我|人|谁)$/.test(before)) {
        const ctx = text.substring(Math.max(0, pos - 20), pos);
        if (/(?:只有|只剩|就剩|唯有|惟有|不过|也就|只有|都|才|还|就)$|(?:只有|只剩|就剩|唯有|惟有|不过|也就)/.test(ctx)) {
          continue;
        }
      }
    }

    // 检查后面是否是对话内容（引号开头）- "四个，不认识" 是有效对话
    const after = text.substring(pos + matchResult[0].length - 1, pos + 10);
    if (/["""''「」]/.test(after)) {
      // 对话中的数量回答，过滤掉
      continue;
    }

    // [FIX 2026-06-26] 量词+逗号+动词是语境省略(如"一碗，搁在桌沿"/"一块，压在掌心")
    // 量词后省略名词,后接动作承接,这是网文常见句式,不是裸量词 AI 腔
    const trailingPunct = matchResult[3];
    if (trailingPunct === "，" || trailingPunct === ",") {
      const afterComma = text.substring(pos + matchResult[0].length, pos + matchResult[0].length + 12);
      if (VERB_AFTER_MEASURE_COMMA.test(afterComma)) {
        continue;
      }
    }

    // 默认保留
    filteredPositions.push(pos);
    filteredMatches.push(matchResult[0]);
  }

  return { positions: filteredPositions, matches: filteredMatches };
}

/**
 * R40: 过滤 behavior_cause_explained 的误判
 * "肩线因为连续出拳而微微下沉" 是修真/训练场景的身体力学因果描述
 * (具体动作→具体身体反应),不是抽象行为动机解释("因为害怕所以逃跑")。
 * behavior_cause_explained 本意检测"因为+抽象动机"的即时解释,
 * 当"因为"前后都是具体身体动作/物理反应时,是有效身体描写,应过滤。
 *
 * [FIX 2026-06-26 P23] 扩展：过滤背景叙述/设定的"因为"解释。
 * "烧了二十三年。他知道，因为他出生那天父亲点的" 是背景设定因果
 * (解释某个长期状态/历史事实的由来),不是角色当前行为动机的即时解释。
 * 当"因为"前后含时长标记(年/天/从来/一直/从没断过)或传记内容
 * (出生/小时候/那年/父亲/母亲/师父等)时,是背景叙述,应过滤。
 */
function filterBehaviorCauseExplainedFalsePositives(
  text: string,
  positions: number[]
): { positions: number[]; matches: string[] } {
  // 具体身体动作词——出拳/踢/挡/推/转身等具体武术/身体动作
  const PHYSICAL_ACTION_PATTERN = /(?:连续出拳|出拳|挥拳|踢|踹|蹬|踩|跳|跃|翻|滚|扑|冲|撞|挡|格挡|架|推|拉|扯|抓|握|按|压|拧|扭|转|旋|蹲|起|立|坐|跪|弯|挺|撑|缩|展|收|放|抬|举|落|降|升|沉|浮|前倾|后仰|侧身|弓身|挺身|发力|用力|使劲|猛地|连续|反复|持续|长时|久|站立|坐立|行走|奔跑|对峙|推手|过招|交手|缠斗|搏斗)/;
  // 具体身体反应词——下沉/颤抖/发麻/酸痛/僵硬等物理身体反应
  const PHYSICAL_REACTION_PATTERN = /(?:下沉|下沉|颤抖|颤动|发麻|发热|发凉|发软|发硬|酸痛|酸胀|胀痛|刺痛|灼痛|钝痛|僵硬|僵直|发僵|发直|发软|无力|乏力|疲软|松弛|紧绷|绷紧|发紧|发松|微微|稍微|略|略微|稍稍|半分|几分|一阵|一丝|发颤|发抖|打颤|哆嗦|抽搐|痉挛|抽动|跳动|搏动|脉动|心跳|呼吸|喘息|气喘|出汗|冒汗|流汗|发红|发白|发青|发紫|发烫|发凉)/;

  const filteredPositions: number[] = [];
  const filteredMatches: string[] = [];

  for (const pos of positions) {
    // 提取"因为"前后各 40 字的上下文,用于判断是否背景叙述
    const ctxStart = Math.max(0, pos - 40);
    const beforeCtx = text.slice(ctxStart, pos);
    const raw = text.slice(pos, pos + 60);

    // [FIX 2026-06-26 P23] 背景叙述过滤——"因为"解释长期状态/历史事实的由来
    // 当"因为"前文含时长标记,或"因为"后文含传记/历史内容时,是背景设定,过滤。
    if (isBackgroundExpositionContext(beforeCtx, raw)) {
      continue;
    }

    // 提取"因为X而Y"或"因为XY"的 X 和 Y 部分
    // 匹配 "因为X而Y" 或 "因为XY" (X/Y 各 2-20 字)
    const matchResult = raw.match(/因为([^。！？\n，,]{2,20})(?:而|，|,)?([^。！？\n]{2,20})/);
    if (!matchResult) {
      filteredPositions.push(pos);
      filteredMatches.push(raw.substring(0, 20));
      continue;
    }
    const partA = matchResult[1];
    const partB = matchResult[2];
    // 因为前后都是具体身体动作/反应 → 身体力学描述,过滤
    const aIsPhysical = PHYSICAL_ACTION_PATTERN.test(partA) || PHYSICAL_REACTION_PATTERN.test(partA);
    const bIsPhysical = PHYSICAL_REACTION_PATTERN.test(partB) || PHYSICAL_ACTION_PATTERN.test(partB);
    if (aIsPhysical && bIsPhysical) {
      continue;
    }
    // 默认保留
    filteredPositions.push(pos);
    filteredMatches.push(raw.substring(0, 20));
  }

  return { positions: filteredPositions, matches: filteredMatches };
}

/**
 * [FIX 2026-06-26 P23] 判断"因为"上下文是否为背景叙述/设定。
 *
 * narr_because_motivation / behavior_cause_explained 本意检测"因为+抽象动机"
 * 的即时行为解释("他跑了，因为害怕")。但悬疑/背景叙述中"因为"常用于解释
 * 长期状态或历史事实的由来("灯烧了二十三年，因为他出生那天父亲点的"),
 * 这是有效背景设定,不是 AI 腔的行为动机即时解释。
 *
 * 判据(满足任一即判定为背景叙述):
 * 1. "因为"前文含时长/持续标记: X年/X天/一直/从来/从没/从未/至今/已经/持续/烧了/亮了
 * 2. "因为"后文含传记/历史内容: 出生/小时候/那年/那天/当年/从前/父亲/母亲/爷爷/师父等
 */
function isBackgroundExpositionContext(beforeCtx: string, afterCtx: string): boolean {
  // 时长/持续标记——"因为"前文描述长期状态
  const DURATION_MARKER_PATTERN = /(?:[一二三四五六七八九十百千万\d]+[年月天日小时分钟秒]|一直|从来|从没|从未|至今|已经|持续|烧了|亮了|燃了|开着|没断过|从没断过|从来没断过|多年|好几年|十几年|几十年)/;
  // 传记/历史内容——"因为"后文解释历史由来
  const BIOGRAPHICAL_CONTENT_PATTERN = /(?:出生|小时候|那年|那天|当年|从前|以前|过去|早年|幼年|童年|父亲|母亲|爷爷|奶奶|外公|外婆|师父|师傅|师尊|祖上|祖辈|祖传|祖训|祖坟|家族|世家|祖籍)/;
  return DURATION_MARKER_PATTERN.test(beforeCtx) || BIOGRAPHICAL_CONTENT_PATTERN.test(afterCtx);
}

/**
 * [FIX 2026-06-26 P23] R40b: 过滤 narr_because_motivation 的误判。
 * narr_because_motivation 检测"，因为X"结构,但无法区分行为动机解释与背景叙述。
 * 背景叙述("灯烧了二十三年，因为他出生那天父亲点的")是有效设定交代,
 * 不是 AI 腔的行为动机即时解释,应过滤。
 */
function filterNarrBecauseMotivationFalsePositives(
  text: string,
  positions: number[]
): { positions: number[]; matches: string[] } {
  const filteredPositions: number[] = [];
  const filteredMatches: string[] = [];

  for (const pos of positions) {
    // 提取"，因为"前文(40字)和后文(60字)上下文
    const ctxStart = Math.max(0, pos - 40);
    const beforeCtx = text.slice(ctxStart, pos);
    const afterCtx = text.slice(pos, pos + 60);

    // 背景叙述过滤——"因为"解释长期状态/历史事实的由来
    if (isBackgroundExpositionContext(beforeCtx, afterCtx)) {
      continue;
    }

    // 默认保留
    filteredPositions.push(pos);
    filteredMatches.push(afterCtx.substring(0, 20));
  }

  return { positions: filteredPositions, matches: filteredMatches };
}

/**
 * R41: 过滤 negative_definition_chain 的误判
 * "不是力量，不是威压。是某种极旧的、快要耗尽的东西" 是修真场景揭示修辞,
 * 主角通过排除法(不是A,不是B)锁定未知本质(是C),是文学感知分析,不是 AI 腔否定定义链。
 * 当 A/B 含力量性质词(力量/威压/气息等),或 C 含具体感官/状态描写时,过滤为修真揭示修辞。
 */
function filterNegativeDefinitionChainFalsePositives(
  text: string,
  positions: number[]
): { positions: number[]; matches: string[] } {
  // 力量性质词——A/B 含这些词时是修真力量排除法
  const FORCE_NATURE_PATTERN = /(?:力量|威压|气息|气浪|灵压|神识|真元|法力|内力|劲风|罡气|杀意|敌意|意念|意志|心魔|执念|煞气|邪气|灵气|剑意|魂力|精神力|波动|震荡|冲击|压迫|撕裂|灼烧|冰冷|寒意|热浪|声|光|影|味|香|臭)/;
  // 具体状态/感官描写词——C 含这些词时是具体感知描写,非抽象定义
  const CONCRETE_DESCRIPTION_PATTERN = /(?:极旧|极新|古老|苍老|陈旧|破败|衰败|腐朽|干涸|枯竭|耗尽|快要|将要|即将|残存|残留|剩余|微弱|微细|细微|稀薄|浓稠|黏稠|粘稠|滞涩|干涩|苦涩|腥甜|铁锈|血腥|腐朽味|霉味|焦味|烟味|冰冷|滚烫|灼热|刺骨|阴冷|发烫|发凉|发麻|发颤|发紧|发松|颤动|搏动|脉动|跳动|涌动|翻涌|搅动|撕裂|割裂|挤压|拉扯|扭曲|凝结|凝固|崩散|溃散|消散|蒸发|沸腾)/;

  const filteredPositions: number[] = [];
  const filteredMatches: string[] = [];

  for (const pos of positions) {
    // [FIX 2026-06-26] 对话内的"不是A，不是B，是C"是角色语言(教学/分析),不是 AI 叙事腔
    if (isPositionWithinDialogue(text, pos)) {
      continue;
    }
    const raw = text.slice(pos, pos + 120);
    // 提取 A/B/C 三段(不是A，不是B。是C / 不是A，不是B，是C)
    const matchResult = raw.match(/不是([^。！？\n]{1,30})[，,。！？；;]\s*不是([^。！？\n]{1,30})[，,。！？；;]\s*是([^。！？\n]{1,40})/);
    if (!matchResult) {
      filteredPositions.push(pos);
      filteredMatches.push(raw.substring(0, 30));
      continue;
    }
    const partA = matchResult[1];
    const partB = matchResult[2];
    const partC = matchResult[3];
    // A/B 含力量性质词 → 修真力量排除法,过滤
    const aIsForce = FORCE_NATURE_PATTERN.test(partA);
    const bIsForce = FORCE_NATURE_PATTERN.test(partB);
    // C 含具体状态/感官描写 → 具体感知揭示,过滤
    const cIsConcrete = CONCRETE_DESCRIPTION_PATTERN.test(partC);
    if ((aIsForce || bIsForce) && cIsConcrete) {
      continue;
    }
    // 默认保留
    filteredPositions.push(pos);
    filteredMatches.push(raw.substring(0, 30));
  }

  return { positions: filteredPositions, matches: filteredMatches };
}

/**
 * R42: 过滤 parenthetical_explanation 的误判
 * "他往右看——没有。往左——没有。" 是两个独立的"动作——结果"结构,
 * 不是成对破折号的括号式插入解释。成对破折号——X——中间应是插入语(无句号)。
 * 当两个破折号之间含句号/问号/叹号时,是多个独立句子的节奏停顿,不是插入语,过滤。
 */
function filterParentheticalExplanationFalsePositives(
  text: string,
  positions: number[]
): { positions: number[]; matches: string[] } {
  const filteredPositions: number[] = [];
  const filteredMatches: string[] = [];

  for (const pos of positions) {
    const raw = text.slice(pos, pos + 40);
    // 两个破折号之间含句号/问号/叹号 → 独立句子,不是插入语
    if (/[。！？]/.test(raw)) {
      // 进一步确认:句号在两个——之间(即 raw 内部)
      const innerMatch = raw.match(/——([^——]{2,30})——/);
      if (innerMatch && /[。！？]/.test(innerMatch[1])) {
        continue;
      }
    }
    // 默认保留
    filteredPositions.push(pos);
    filteredMatches.push(raw.substring(0, 25));
  }

  return { positions: filteredPositions, matches: filteredMatches };
}

/**
 * R43: 过滤 five_sense_order 的误判
 * "他能看到自己的背影，也能看到师傅的轮廓" 是同一感官(视觉)的并列描写,
 * 不是五感固定顺序(视/听/嗅/味/触列举)。五感顺序检测本意是检测多感官列举,
 * 当两个感官动词相同时(看到...看到/听到...听到),是同一感官并列,过滤。
 */
function filterFiveSenseOrderFalsePositives(
  text: string,
  positions: number[]
): { positions: number[]; matches: string[] } {
  const filteredPositions: number[] = [];
  const filteredMatches: string[] = [];

  for (const pos of positions) {
    const raw = text.slice(pos, pos + 80);
    // 匹配两个感官动词
    const matchResult = raw.match(/(看到|听见|闻到|触到|尝到)[\s\S]{1,50}(看到|听见|闻到|触到)/);
    if (!matchResult) {
      filteredPositions.push(pos);
      filteredMatches.push(raw.substring(0, 20));
      continue;
    }
    // 两个感官动词相同 → 同一感官并列,不是五感顺序,过滤
    if (matchResult[1] === matchResult[2]) {
      continue;
    }
    // 默认保留
    filteredPositions.push(pos);
    filteredMatches.push(raw.substring(0, 20));
  }

  return { positions: filteredPositions, matches: filteredMatches };
}

/**
 * R36: 过滤 resource_continue_to_action_padding / resource_begin_to_action_padding 的误判
 * "没有继续走近""并未开始检查"是否定语境,表示动作未发生,不是"继续/开始+动作"填充。
 * 网文常见"没有继续走近，停在原地"是否定+实际动作对比,是有效叙事,不是 AI 腔填充。
 */
function filterNegatedActionPaddingFalsePositives(
  text: string,
  positions: number[]
): { positions: number[]; matches: string[] } {
  const filteredPositions: number[] = [];
  const filteredMatches: string[] = [];

  for (const pos of positions) {
    // 检查匹配位置前 1-6 字是否为否定语境
    // R36: "没有继续/并未开始"是否定+动作,动作未发生,不是填充
    // [FIX 2026-06-26] 扩展到前 6 字以覆盖"不想被继续问/不愿被继续打扰"等
    // "否定词+被/让+继续+动作"结构,这是表达"不希望被持续X"的否定意愿,不是填充。
    const before = text.substring(Math.max(0, pos - 6), pos);
    if (/(?:不想|不愿|不要|不肯|不欲|不再|没有|没|不|未|并无|并未|别|莫|勿|休)(?:被|让|令|使|让人|令人|叫|教)?(?:再|继续)?$/.test(before)) {
      // 否定语境:动作未发生/不希望发生,不是填充
      continue;
    }

    // [FIX 2026-06-26] 对话内的"继续X"是对话内容,不是叙事填充
    // "继续说。"出现在引号内(对话台词),是角色话语,不是叙事"继续+动作"填充。
    // 检查匹配位置前文是否有未闭合的对话引号(直引号 " 奇数个,或弯引号 " 未闭合)
    const prefix = text.substring(0, pos);
    const straightQuotes = (prefix.match(/"/gu) || []).length;
    if (straightQuotes % 2 === 1) {
      // 在对话引号内,是对话内容,过滤
      continue;
    }
    const curvedStarts = (prefix.match(/[\u201C\u300C]/gu) || []).length;
    const curvedEnds = (prefix.match(/[\u201D\u300D]/gu) || []).length;
    if (curvedStarts > curvedEnds) {
      // 在弯引号/日式引号对话内,过滤
      continue;
    }

    // [FIX 2026-06-26] 对话归属语"XXX继续说/道"是对话标识,不是叙事填充
    // 结构:"...对话..."角色名继续说/道，"...对话..."——"继续说/道"在两个引号之间,
    // 标识说话人继续发言,是网文常见对话归属语,不是"继续+动作"填充。
    // 检查:前 6 字内有闭合引号(" 或 ") + 后 6 字内有开启引号(" 或 ")
    const before6 = text.substring(Math.max(0, pos - 6), pos);
    const after6 = text.substring(pos, Math.min(text.length, pos + 6));
    const hasCloseQuoteBefore = /["\u201D\u300D]/.test(before6);
    const hasOpenQuoteAfter = /["\u201C\u300C]/.test(after6);
    if (hasCloseQuoteBefore && hasOpenQuoteAfter) {
      // 对话归属语:引号间标识说话人继续发言,过滤
      continue;
    }

    // 默认保留
    filteredPositions.push(pos);
    filteredMatches.push(text.substring(pos, pos + 15));
  }

  return { positions: filteredPositions, matches: filteredMatches };
}

/**
 * R37: 过滤 narr_perception_confirm 的误判
 * "他感觉到边缘在松" 是修真场景主角感受到识海变化,是叙事推进,不是多余感知确认。
 * 多余感知确认是"他看见了X"——主角主动确认已感知到的事物(冗余)。
 * "感觉到+变化动词/状态" 是感受到的过程,是有效叙事,应过滤。
 */
function filterPerceptionConfirmFalsePositives(
  text: string,
  positions: number[]
): { positions: number[]; matches: string[] } {
  // "感觉到" 后接变化动词/状态——描述感受到的变化过程,是叙事推进
  // "在+动词"(在松/在颤/在动/在变) 是进行时态变化描述
  // "边缘/识海/气机/灵压/神识" 等修真名词后接状态变化是修真场景有效叙事
  const CHANGE_VERB_PATTERN = /感觉到(?:[^。！？\n]{0,6})(?:在(?:松|紧|颤|动|变|凝|散|聚|涨|缩|沉|浮|升|降|裂|合|开|关|断|续|退|进|出|入|起|落|崩|塌|碎|裂|硬|软|冷|热|麻|痛|痒|酸|胀|晕|闷)|边缘|识海|气机|灵压|神识|心魔|气息|气浪|劲风|罡气|真元|法力|内力|意念|意志|杀意|敌意|念头|执念|妄念|杂念|魂力|精神力|灵魂力)/;

  const filteredPositions: number[] = [];
  const filteredMatches: string[] = [];

  for (const pos of positions) {
    const raw = text.slice(pos, pos + 30);
    if (CHANGE_VERB_PATTERN.test(raw)) {
      // "感觉到+变化" 是叙事推进,过滤
      continue;
    }

    // 默认保留
    filteredPositions.push(pos);
    filteredMatches.push(raw.substring(0, 15));
  }

  return { positions: filteredPositions, matches: filteredMatches };
}

/**
 * R34: 过滤 narr_double_adj 的误判
 * "越翻越静" 是有效的叙事描写，不是形容词堆叠
 * 只检测真正的形容词堆叠（如"美丽的聪明的温柔的"）
 */
function filterNarrDoubleAdjFalsePositives(
  text: string,
  positions: number[]
): { positions: number[]; matches: string[] } {
  const filteredPositions: number[] = [];
  const filteredMatches: string[] = [];

  for (const pos of positions) {
    const raw = text.slice(pos, pos + 30);
    // "越X越Y" 是有效的叙事描写，不是形容词堆叠
    if (/越[一-鿿]{1,4}越[一-鿿]{1,4}/.test(raw)) {
      continue;
    }

    // [FIX 2026-06-26] 含代词（我/你/他/她/它/我们/你们/他们/她们/它们）的"X的Y的Z"是
    // 正常陈述句（如"当时报的是我的名字"），不是形容词堆叠。narr_double_adj 本意是检测
    // "美丽的聪明的温柔的"这类纯形容词堆叠，代词和名词组合应过滤。
    if (/[我你他她它]|我们|你们|他们|她们|它们/.test(raw)) {
      continue;
    }

    // [FIX 2026-06-26] 含并列连词（和/与/或/及/并/跟）的"X的人和Y的人"是并列名词短语，
    // 不是形容词堆叠。正则因"和"在 [一-鿿] 范围内会误匹配，需过滤。
    if (/[和与或及并跟]/.test(raw)) {
      continue;
    }

    // [FIX 2026-06-26] 含比较结构"比...该有的"+具体度量(半拍/半秒/半分等)是
    // 具体动作比较描写(如"睡着的人该有的慢了半拍"),不是形容词堆叠。
    // 这类句子描述动作相对参照的具体差异,是有效叙事细节。
    if (/比[^。！？\n]{2,15}(?:该有的|应有的|正常的|平常的|寻常的|原本的|本来的)/.test(raw)) {
      continue;
    }
    if (/(?:半拍|半秒|半分|半刻|一刻|一分|一秒|几拍|几秒|几分)/.test(raw)) {
      continue;
    }

    // 默认保留
    filteredPositions.push(pos);
    filteredMatches.push(raw.substring(0, 20));
  }

  return { positions: filteredPositions, matches: filteredMatches };
}

/**
 * R38: 过滤 universal_describe 的误判
 * "一股薄薄的气息，忽远忽近，像香又不像，像人的呼吸又太凉" 已包含具体感官细节
 * (比喻/动态/触觉),正是修复指引要求的"具体感官细节",不是万能模板。
 * universal_describe 本意是检测"一股阴冷的气息"这类没有后续具体描写的空泛比喻。
 * 当"一股X的气息"后接具体感官延伸(忽远忽近/时有时无/像X又不像X/凉/热/香等)时,应过滤。
 */
function filterUniversalDescribeFalsePositives(
  text: string,
  positions: number[]
): { positions: number[]; matches: string[] } {
  // "一股...的气息" 后接具体感官细节——已是具体描写,非万能模板
  // 动态变化(忽远忽近/时有时无/忽明忽暗)、比喻(像X/如X)、触觉(凉/热/冷)、嗅觉(香/臭)等
  const SPECIFIC_SENSORY_PATTERN = /气息[，,。！？\s]*[^。！？\n]{0,40}(?:忽远忽近|忽明忽暗|时有时无|时隐时现|若即若离|忽浓忽淡|像[^。！？\n]{1,8}又不像[^。！？\n]{1,8}|如[^。！？\n]{1,8}又如[^。！？\n]{1,8}|凉|冷|热|暖|寒|香|臭|腥|甜|苦|辣|涩|咸|腥甜|铁锈味|血腥味|腐朽味)/;

  const filteredPositions: number[] = [];
  const filteredMatches: string[] = [];

  for (const pos of positions) {
    const raw = text.slice(pos, pos + 80);
    if (SPECIFIC_SENSORY_PATTERN.test(raw)) {
      // 后接具体感官细节,已是有效描写,过滤
      continue;
    }

    // 默认保留
    filteredPositions.push(pos);
    filteredMatches.push(raw.substring(0, 25));
  }

  return { positions: filteredPositions, matches: filteredMatches };
}

/**
 * R39: 过滤 extreme_adverb 的误判
 * "格外/极其/分外" 单个出现且后接具体感官形容词(清晰/明亮/刺耳/安静等)或比喻(像/如/似)
 * 是有效感官描写,不是程度副词堆砌。extreme_adverb 本意抓多个程度副词连用的空泛堆砌,
 * 单个"格外+具体感官"是中文常见修辞。当后接比喻或具体感官细节时,过滤。
 */
function filterExtremeAdverbFalsePositives(
  text: string,
  positions: number[]
): { positions: number[]; matches: string[] } {
  // 具体感官形容词——"格外清晰""格外明亮""极其刺耳"等是有效感官描写
  const SPECIFIC_SENSORY_ADJ = /(?:格外|极其|分外)[^\n。！？]{0,3}(?:清晰|明亮|明净|刺眼|刺耳|刺鼻|响亮|分明|明显|安静|静谧|寂静|宁静|清冷|冰凉|滚烫|灼热|沉重|轻盈|尖锐|柔和|鲜亮|鲜红|惨白|漆黑|透彻|透亮|铮亮|油亮|晶亮|耀眼|夺目|醒目|逼真|生动|传神|到位|贴切|精准|精确|确切|确切|明白|清楚|清爽|清脆|清亮)/;
  // 后接比喻——"格外清晰,像...""极其安静,如..."是文学修辞
  const METAPHOR_PATTERN = /(?:格外|极其|分外)[^\n。！？]{0,15}(?:像|如|似|仿佛|犹如|宛如|好比|如同)/;

  const filteredPositions: number[] = [];
  const filteredMatches: string[] = [];

  for (const pos of positions) {
    const raw = text.slice(pos, pos + 60);
    if (SPECIFIC_SENSORY_ADJ.test(raw) || METAPHOR_PATTERN.test(raw)) {
      // 单个程度副词+具体感官/比喻,是有效描写,过滤
      continue;
    }

    // 默认保留
    filteredPositions.push(pos);
    filteredMatches.push(raw.substring(0, 25));
  }

  return { positions: filteredPositions, matches: filteredMatches };
}

/**
 * R35: 过滤 redundant_sensory_confirm 的误判
 * "他刚才没看见" 是有效的揭示铺垫（之前漏看，现在发现），不是多余的感知确认。
 * 真正多余的感知确认是"他看见了X"——主角主动确认已感知到的事物。
 * 否定形式（没看见/没听到/没闻到/没察觉到/未看见/未察觉）恰恰是揭示叙事的工具，应过滤。
 */
function filterRedundantSensoryConfirmFalsePositives(
  text: string,
  positions: number[]
): { positions: number[]; matches: string[] } {
  // [FIX 2026-06-26] 感知动词后接具体宾语(≥2字实质内容,非句末标点)是正常叙事,过滤
  // "他看见地上滚落的那只酱菜罐" 是有效叙事;只有"他看见了。"(无宾语,句末即结束)
  // 才是多余感知确认。pattern 的 fix 提示"直接写感知对象"——宾语已写出就不算冗余。
  const PERCEPTION_PATTERN = /^[他她它].{0,3}(看见了?|听到了?|闻到了?|触到了?|感觉到了?|察觉到了?)/;

  const filteredPositions: number[] = [];
  const filteredMatches: string[] = [];

  for (const pos of positions) {
    // 检查感知动词前是否有否定词（没/不/未/无）
    const before = text.substring(Math.max(0, pos - 5), pos + 15);
    if (/(?:没|不|未|无)\s*(?:看见|看到|听见|听到|闻到|触到|感觉到|察觉到)/.test(before)) {
      // 否定形式是揭示铺垫，过滤掉
      continue;
    }

    // [FIX 2026-06-26] 感知动词后接具体宾语(≥2字)是正常叙事,过滤
    const segment = text.substring(pos, pos + 20);
    const m = segment.match(PERCEPTION_PATTERN);
    if (m) {
      const afterVerb = segment.substring(m[0].length);
      // 后接句末标点(。！？)→ 无宾语,是多余感知确认,保留
      if (/[。！？\n]/.test(afterVerb.charAt(0))) {
        filteredPositions.push(pos);
        filteredMatches.push(before.substring(0, 20));
        continue;
      }
      // 去掉可选的逗号/顿号后,若仍有 ≥2 字实质内容,视为正常叙事,过滤
      const stripped = afterVerb.replace(/^[，,、\s]/, "");
      if (stripped.length >= 2) {
        continue;
      }
    }

    // 默认保留
    filteredPositions.push(pos);
    filteredMatches.push(before.substring(0, 20));
  }

  return { positions: filteredPositions, matches: filteredMatches };
}

function collectTelegraphSentencePileupPositions(text: string, characterNames?: Set<string>): number[] {
  const spans = collectNonDialogueSentenceSpans(text);
  const positions: number[] = [];
  let windowStart = -1;
  let consecutive = 0;
  let windowSpans: RepeatableSentenceSpan[] = [];

  for (const span of spans) {
    const content = span.normalized;
    const isShortNarrative =
      content.length >= 2 &&
      content.length <= 12 &&
      /[一-鿿]/.test(content) &&
      !/[：:]/.test(content) &&
      !/["""""'']/.test(content) &&
      !/(说|问|回|道|打字|回复|发来)/.test(content);

    if (!isShortNarrative) {
      // 在提交窗口前，检查是否为合理叙事短句（应排除）
      if (consecutive >= 3 && windowSpans.length >= 3) {
        trySubmitWindow(windowSpans, positions, characterNames);
      }
      consecutive = 0;
      windowStart = -1;
      windowSpans = [];
      continue;
    }

    if (consecutive === 0) {
      windowStart = span.start;
    }
    consecutive += 1;
    windowSpans.push(span);
  }

  // 处理末尾窗口
  if (consecutive >= 3 && windowSpans.length >= 3) {
    trySubmitWindow(windowSpans, positions, characterNames);
  }

  return positions;
}

/**
 * P18修复: 判断一组连续短句是否为合理叙事（应排除）而非AI腔堆叠。
 *
 * 合理叙事排除规则:
 * 1. 时间/数字标记序列（"一分钟。两分钟。五分钟。"）—— 属于合理的时间流逝叙事
 * 2. 递进重复结构（"再下次/再再下次"）—— 属于合理的递进修辞
 * 3. 信息量充足的短句组（每句携带不同的具体信息）—— 非AI腔空转
 *
 * AI腔堆叠特征（应保留检测）:
 * - 句式对仗且信息量低（"他笑了。他哭了。他沉默了。"）
 * - 同一主语重复（"他走了。他停了。他回头了。"）
 * - 纯状态罗列无推进（"安静了。空了。冷了。"）
 */
function trySubmitWindow(
  windowSpans: RepeatableSentenceSpan[],
  positions: number[],
  characterNames?: Set<string>
): void {
  const contents = windowSpans.map(s => s.normalized);

  // 排除规则1: 时间/数字标记序列
  // 检测模式: 连续短句中多数为数字+时间单位（一/两/三/几+分钟/秒/小时/天/年/次/遍）
  const timeMarkerPattern = /^[一两二三三四五六七八九十百千万几\d]+[分钟秒小时天年月次遍趟场步]/;
  const timeMarkerCount = contents.filter(c => timeMarkerPattern.test(c)).length;
  if (timeMarkerCount >= 2 && timeMarkerCount >= contents.length * 0.5) {
    return; // 合理时间流逝叙事，排除
  }

  // 排除规则2: 递进重复结构（"再下次/再再下次"、"又一次/又一次"）
  // 检测模式: 连续短句以相同前缀递进（"再"/"又"/"更"等递进词开头）
  const progressivePrefixPattern = /^[再又更还]/;
  const progressiveCount = contents.filter(c => progressivePrefixPattern.test(c)).length;
  if (progressiveCount >= 2) {
    return; // 合理递进修辞，排除
  }

  // 排除规则3: 信息量充足的短句组
  // 检测: 如果连续短句中每句都包含不同的具体名词/动词（非同构对仗），则信息量充足
  // AI腔特征是同构对仗（同一主语+不同状态动词），合理叙事是不同主语/不同信息
  // R33扩展: 同构对仗不仅限于代词主语，名词主语+状态动词+了 也是典型 AI 腔
  // （如"灯灭了。门响了。风停了。屏幕黑了。手机亮了。"）。
  // 必须先识别这类同构，避免 R29 悬疑排除规则误排合法电报体堆叠检测。
  // R33b: 使用阈值（≥75%）而非 every，允许个别句子（如"人没动"）不匹配，
  // 但整体仍呈现同构堆叠特征时识别为 AI 腔。
  const HOMOLOGOUS_PRONOUN_PATTERN = /^[他她它][^，。！？]{1,6}了$/;
  // R33: 名词主语 + 状态动词/形容词 + 了（无其他标点）
  // 覆盖常见 AI 腔状态变化动词：灭/响/停/黑/亮/开/关/动/近/远/碎/裂/沉/升/降/落/起/倒/塌/燃/熄/醒/睡/死/活/来/去/出/入/回/到
  const HOMOLOGOUS_NOUN_PATTERN = /^[\u4e00-\u9fa5]{1,4}(?:灭|响|停|黑|亮|开|关|动|近|远|碎|裂|沉|升|降|落|起|倒|塌|燃|熄|醒|睡|死|活|来|去|出|入|回|到|没动|没响|没声|没亮|没开)[\u4e00-\u9fa5]{0,2}了?$/;
  const homologousCount = contents.filter(c => {
    if (HOMOLOGOUS_PRONOUN_PATTERN.test(c)) return true;
    if (HOMOLOGOUS_NOUN_PATTERN.test(c)) return true;
    return false;
  }).length;
  const isHomologousStructure = homologousCount >= Math.ceil(contents.length * 0.75);
  if (isHomologousStructure) {
    // 这是典型的AI腔堆叠，保留检测
    positions.push(windowSpans[0].start);
    return;
  }

  // 排除规则4 (R22/R23): 多角色互动的信息推进型短句组
  // 检测: 非同构 + 至少2个不同主语（代词 或 characterNames 中的角色名）→ 合理多角色叙事节奏
  // AI腔特征是单一主语同构堆叠，合理叙事是不同角色互动推进。
  // R23扩展: 支持人名主语（从 characterNames 白名单匹配），不再只识别代词。
  // 要求 ≥60% 句子有可识别主语且至少2个不同主语，避免"安静了。空了。冷了。"被误排除。
  // 注意: 不使用通用"句首2-3字汉字"启发式，避免"灯灭了/门响了/风停了"等无生命主语
  // 被误判为"多角色互动"而漏检测。只识别代词 + characterNames 白名单中的角色名。
  const allSubjects = contents.map(c => {
    // 代词主语
    const pronoun = c.match(/^([他她它我你])/)?.[1];
    if (pronoun) return pronoun;
    // R23: 命名实体主语（仅从 characterNames 白名单匹配，避免误判无生命主语）
    if (characterNames && characterNames.size > 0) {
      for (const name of characterNames) {
        if (name.length >= 2 && c.startsWith(name)) return name;
      }
    }
    return null;
  }).filter(Boolean);
  const uniqueSubjects = new Set(allSubjects);
  if (
    uniqueSubjects.size >= 2 &&
    allSubjects.length >= Math.ceil(contents.length * 0.6)
  ) {
    return; // 多角色互动推进，排除
  }

  // 排除规则5 (R24/R26): IM/手机消息/菜单价格等高密度信息推进场景
  // 这些场景的短句堆叠是信息密度叙事，不是AI腔空泛状态罗列。
  // 检测信号: 窗口内多数句子包含 IM/消息/菜单/价格/序号 元素
  // 例: "发送。发送。发送。" / "屏幕亮了。只有四个字。第二条紧跟着进来。"
  //     "灵鹿肋排，一份八百八。他又翻了一页。雪山雀舌羹，一份一千二。"
  // R26扩展: 覆盖手机消息场景（发出去/删掉/重新打/打字/手机/回复/没回复/打到一半）
  // R28修正: 强信号需要 deviceCount >= 1 且 deviceCount + actionCount >= 半数
  // 避免环境描写中碰巧出现"屏幕黑了/手机亮了"就误判为 IM 场景
  const IM_DEVICE_PATTERN = /(手机|屏幕|对话框|锁屏|解锁|聊天)/;
  const IM_ACTION_PATTERN = /(发送|消息|打了一行|删了|删掉|盯着|亮了|进来|紧跟着|第[一二三四五六七八九十两\d]+条|菜单|份[一二三四五六七八九十百千万\d]|翻了一页|只有[一二三四五六七八九十\d]+个?字|发出去|重新打|打字|回复|没回复|打到一半)/;
  const deviceCount = contents.filter(c => IM_DEVICE_PATTERN.test(c)).length;
  const actionCount = contents.filter(c => IM_ACTION_PATTERN.test(c)).length;
  const halfCount = Math.ceil(contents.length * 0.5);
  // 强信号: 设备词 >= 1 且 设备词+动作词总数 >= 半数（确保窗口真的是 IM 场景）
  if (deviceCount >= 1 && deviceCount + actionCount >= halfCount) {
    return; // IM 设备场景，排除
  }
  // 弱信号: 动作词 >= 2 且 >= 半数
  if (actionCount >= 2 && actionCount >= halfCount) {
    return; // IM/菜单高密度信息推进，排除
  }

  // 排除规则6 (R29): 悬疑叙事节奏短句组
  // 合理悬疑叙事的短句携带具体信息（具体名词/否定判断/感官细节），
  // 与 AI 腔空转状态罗列（"安静了。空了。冷了。"）不同。
  // 检测信号: 多数短句包含具体名词或否定/判断词，且非同构对仗
  // 例: "熟悉，正常。/ 可不对。/ 他又吸了一口。"
  //     "一枚旧怀表。/ 不是配角A那块。/ 表盖背面，刻着一个字。/ 陈。"
  //     "死表。/ 不是敲门。/ 楼道里没人。"
  // 注意: 必须在 isHomologousStructure=false 之后才执行，
  //       确保"他笑了。他哭了。他沉默了。"等同构对仗仍被检测
  const SUSPENSE_CONCRETE_PATTERN = /(表|怀表|名片|鳞片|手机|屏幕|门板|猫眼|楼道|窗帘|灯|光|影|声|响|味|气|风|车|人|手|眼|脸|字|信|短信|号码|铜|铁|木|纸|布|药|茶|墙皮|地砖|玻璃|锁|链|盖|背|面|边|角|呼吸|脚步|引擎|短信)/;
  const SUSPENSE_NEGATION_PATTERN = /(不对|不对劲|不对了|没人|没有人|没动|没响|没声|不是|别|别动|别开|别问|死表|死信|死锁|陌生|熟悉|正常|不对|不对劲)/;
  const concreteCountR29 = contents.filter(c => SUSPENSE_CONCRETE_PATTERN.test(c)).length;
  const negationCountR29 = contents.filter(c => SUSPENSE_NEGATION_PATTERN.test(c)).length;
  if (
    !isHomologousStructure &&
    (concreteCountR29 + negationCountR29) >= Math.ceil(contents.length * 0.5)
  ) {
    return; // 悬疑叙事节奏（具体名词/否定判断推进），排除
  }

  // 排除规则7 (R31): 对话交换节奏短句组
  // 合理的父子/双人简短问答对话节奏，每句都携带信息或应答，
  // 与 AI 腔空转状态罗列不同。
  // 检测信号: 多数短句是对话（含引号）或对话标签，且非同构对仗
  // 例: "嗯。" / "简称。" / "爸。" / "姓陈。" / "某集团。"
  // 注意: 必须在 isHomologousStructure=false 之后才执行
  const DIALOGUE_QUOTE_PATTERN = /[\u201C\u201D\u0022\u300C\u300D]/;
  const dialogueCount = contents.filter(c => DIALOGUE_QUOTE_PATTERN.test(c)).length;
  if (
    !isHomologousStructure &&
    dialogueCount >= Math.ceil(contents.length * 0.5)
  ) {
    return; // 对话交换节奏（双人简短问答），排除
  }

  // 排除规则8 (R34): 信息多样性短句组
  // 合理叙事的短句每句都携带新信息（不同内容字符），与 AI 腔空转状态罗列不同。
  // AI 腔特征: 同构对仗（已由 isHomologousStructure 捕获）或极短空泛句（"空了。冷了。"）
  // 合理叙事: 每句引入新名词/动词/角色，信息密度高，平均长度 >= 4 字符。
  // 检测信号: 非同构 + 平均长度 >= 4 + 多数句子（≥60%）引入新内容字符
  // 例: "没有落款。/ 写的时间不久。/ 配角A声音压得很低。/ 配角A没答。"
  //     "主角摇头。/ 没有。/ 反派本人，一句都没认。"
  //     "不是钱的事。/ 那是什么事。/ 没有敲门。/ 停了三秒，又走开了。"
  // 注意: 必须在 isHomologousStructure=false 之后才执行，
  //       确保"灯灭了。门响了。风停了。"等同构对仗仍被检测
  if (!isHomologousStructure) {
    const avgLen = contents.reduce((sum, c) => sum + c.length, 0) / contents.length;
    if (avgLen >= 4) {
      const seenChars = new Set<string>();
      let novelCount = 0;
      for (const c of contents) {
        // 取前 4 个字符作为内容指纹（排除标点后的实质内容）
        const contentChars = c.replace(/[，。！？、；：""''（）【】《》—…\s]/g, "").slice(0, 4);
        const hasNovel = [...contentChars].some(ch => !seenChars.has(ch));
        if (hasNovel) {
          novelCount += 1;
          for (const ch of contentChars) seenChars.add(ch);
        }
      }
      if (novelCount >= Math.ceil(contents.length * 0.6)) {
        return; // 信息多样性叙事（每句携带新内容），排除
      }
    }
  }

  // 默认: 对于无法明确判为合理叙事的短句堆叠，保留检测
  // 但降低严重度——在 analyzeLocalHotspots 中根据密度调整
  positions.push(windowSpans[0].start);
}

function collectExplanatoryNarratorChainPositions(text: string): number[] {
  const masked = maskDialogueContent(text);
  const positions = collectRegexPositions(
    masked,
    /这说明|这代表|这证明|换句话说|也就是说|问题在于|真正的危险|真正的问题/g
  );

  return positions.length >= 3 ? positions : [];
}

function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let length = 0;

  while (length < max && a[length] === b[length]) {
    length += 1;
  }

  return length;
}

function collectNearDuplicateSplicePositions(text: string): number[] {
  const spans = collectNonDialogueSentenceSpans(text);
  const positions: number[] = [];

  for (let i = 1; i < spans.length; i += 1) {
    const previous = spans[i - 1];
    const current = spans[i];

    if (
      previous.normalized.length < 12 ||
      current.normalized.length < 12 ||
      /[：:]/.test(previous.normalized) ||
      /[：:]/.test(current.normalized)
    ) {
      continue;
    }

    const prefixLength = commonPrefixLength(previous.normalized, current.normalized);
    const minLength = Math.min(previous.normalized.length, current.normalized.length);
    if (prefixLength >= 8 && prefixLength / minLength >= 0.28) {
      positions.push(current.start);
    }
  }

  return positions;
}

function collectStructuralReplayDetections(text: string, characterNames?: Set<string>): DetectionResult[] {
  const detections: DetectionResult[] = [];
  const structuralChecks: Array<{
    patternId: string;
    tag: string;
    severity: number;
    fix: string;
    collect: (value: string, names?: Set<string>) => number[];
  }> = [
    {
      patternId: "rpg_status_label_block",
      tag: "模板化标签结构（RPG状态栏式）",
      severity: 0.9,
      fix: "删除状态栏式标签，改为让信息通过物件变化、角色判断和行动代价进入场景",
      collect: collectRpgStatusLabelPositions,
    },
    {
      patternId: "pronoun_person_drift",
      tag: "人称/称谓混乱",
      severity: 0.9,
      fix: "统一叙事人称；非对话段落不得从第三人称突然切到我/你",
      collect: collectPronounDriftPositions,
    },
    {
      patternId: "telegraph_sentence_pileup",
      tag: "电报体短句堆叠",
      severity: 0.85,
      fix: "合并连续短句，让每句承担动作推进、证据变化或风险升级",
      collect: collectTelegraphSentencePileupPositions,
    },
    {
      patternId: "explanatory_narrator_chain",
      tag: "过度解释/旁白替读者推理",
      severity: 0.85,
      fix: "删掉解释链，把因果压回可观察证据和角色选择",
      collect: collectExplanatoryNarratorChainPositions,
    },
    {
      patternId: "near_duplicate_splice_residue",
      tag: "段落重复（拼接缝隙）",
      severity: 0.85,
      fix: "删除或合并近重复句，只保留会推进信息、风险或情绪转折的版本",
      collect: collectNearDuplicateSplicePositions,
    },
  ];

  for (const check of structuralChecks) {
    const positions = check.collect(text, characterNames);
    if (positions.length === 0) {
      continue;
    }

    detections.push({
      patternId: check.patternId,
      tag: check.tag,
      severity: check.severity,
      count: positions.length,
      positions,
      fix: check.fix,
    });
  }

  return detections;
}

/**
 * Anti-AI Detector Engine
 *
 * 检测 AI 生成文本中的"机器味"模式
 * Round 10 P1: 类型化参数注入
 */
export class AntiAIDetector {
  private patterns: AIPattern[] = [];
  private transitionPhraseStrictness: "strict" | "medium" | "lenient";
  private templatePatternStrictness: "very_strict" | "strict" | "medium" | "lenient";
  private infoRepeatStrictness: "very_strict" | "strict" | "medium" | "lenient";
  /** Round 10: 类型感知参数缓存 */
  private typeAwareParams: {
    dialogueRatio: number;
    sentenceLength: number;
    actionDensity: string;
    /** 类型化 AI 腔阈值 */
    aiDensityThreshold: number;
    /** 类型化敏感度 */
    strictnessLevel: "strict" | "medium" | "lenient";
  } = {
    dialogueRatio: 0.35,
    sentenceLength: 18,
    actionDensity: "medium",
    aiDensityThreshold: 0.3,
    strictnessLevel: "medium",
  };
  private typeProfile: import("./type-profile-types.js").TypeProfile | undefined;
  /** R23: 角色名白名单，用于多角色互动豁免和 idiom stacking 人名排除 */
  private characterNames: Set<string> = new Set();

  constructor(options?: {
    transitionPhraseStrictness?: "strict" | "medium" | "lenient";
    templatePatternStrictness?: "very_strict" | "strict" | "medium" | "lenient";
    infoRepeatStrictness?: "very_strict" | "strict" | "medium" | "lenient";
    /** R23: 角色名白名单（含 aliases），用于电报体多角色豁免和 idiom 人名排除 */
    characterNames?: string[];
  }) {
    // 规则 #476/#524：阈值按类型调整（通过 type-profile 注入 options）
    this.transitionPhraseStrictness = options?.transitionPhraseStrictness ?? "medium";
    this.templatePatternStrictness = options?.templatePatternStrictness ?? "strict";
    this.infoRepeatStrictness = options?.infoRepeatStrictness ?? "strict";
    if (Array.isArray(options?.characterNames)) {
      for (const name of options.characterNames) {
        if (typeof name === "string" && name.trim().length > 0) {
          this.characterNames.add(name.trim());
        }
      }
    }

    this.loadPatterns();
  }

  /**
   * Round 10 P1: 加载类型化参数
   * 规则 #524: AntiAIDetector 敏感度按类型调整
   */
  async loadTypeAwareParams(workspacePath: string, workspaceId: string): Promise<void> {
    const profile = await getTypeProfile(workspacePath, workspaceId);
    if (profile) {
      this.typeProfile = profile;
      const agentParams = profile.agent_params?.AntiAIDetector;

      // P2修复: 优先从 profile 的 anti_ai_threshold 读取，回退到硬编码默认值
      const profileThreshold = (agentParams?.anti_ai_threshold as number | undefined);
      const defaultThreshold = this.getDefaultAIThreshold(profile.metadata.primary_type);
      const aiDensityThreshold = profileThreshold ?? defaultThreshold;

      this.typeAwareParams = {
        dialogueRatio: (agentParams?.dialogue_ratio as number) ?? 0.35,
        sentenceLength: (agentParams?.sentence_length as number) ?? 18,
        actionDensity: (agentParams?.action_density as string) ?? "medium",
        aiDensityThreshold,
        strictnessLevel: this.getTypeAwareStrictness(profile.metadata.primary_type),
      };

      // 应用类型化严格度到检测模式
      this.applyTypeAwareStrictness(this.typeAwareParams.strictnessLevel);
    }
  }

  /**
   * 类型默认 AI 密度阈值（仅在 profile 无 anti_ai_threshold 时使用）
   */
  private getDefaultAIThreshold(type: NovelType | null): number {
    switch (type) {
      case "power_fantasy": return 0.3;
      case "romance": return 0.25;
      case "mystery": return 0.2;
      case "xianxia": return 0.3;
      default: return 0.3;
    }
  }

  private getTypeAwareStrictness(type: NovelType | null): "strict" | "medium" | "lenient" {
    switch (type) {
      case "mystery": return "strict";
      case "power_fantasy": return "medium";
      case "romance": return "lenient";
      case "xianxia": return "medium";
      default: return "medium";
    }
  }

  private applyTypeAwareStrictness(strictness: "strict" | "medium" | "lenient"): void {
    // 更新检测模式的严格度
    this.transitionPhraseStrictness = strictness;
    this.templatePatternStrictness = strictness === "strict" ? "very_strict" : strictness === "lenient" ? "lenient" : "strict";
    this.infoRepeatStrictness = strictness === "strict" ? "very_strict" : strictness === "lenient" ? "lenient" : "strict";
  }

  /**
   * 加载 AI 腔检测模式库
   */
  private loadPatterns(): void {
    this.patterns = [
      // === 六条必删模式（叙事策略层）===
      {
        id: "narr_pre_label_emotion",
        pattern: /(他|她|它)(感到|觉得|感觉到|意识到|察觉到了?)(?![一-鿿]{0,2}(?:了|到|见|着))[一-鿿]{1,10}(?:的|之情|感)/g,
        tag: "#1 提前定性读者感受",
        severity: 0.9,
        fix: "删除感知确认动词，直接呈现被感知内容",
        category: "narration_strategy",
      },
      {
        id: "narr_because_motivation",
        pattern: /，因为(?![一-鿿]{0,3}(?:什么|啥|谁|哪|怎么))[一-鿿]/g,
        tag: "#3 '因为'解释行为动机",
        severity: 0.95,
        fix: "删除'因为'+解释，让行为本身说明动机",
        category: "narration_strategy",
      },
      {
        id: "narr_perception_confirm",
        pattern: /(他|她)(看见了|听到了|闻到了|感觉到|触摸到了)(?![一-鿿]{0,3}(?:了|到|见))[一-鿿]/g,
        tag: "#4 多余的感知确认动词",
        severity: 0.85,
        fix: "删除感知动词，直接呈现感知内容",
        category: "narration_strategy",
      },
      {
        id: "narr_transition_phrase",
        pattern: /就[在]这[时个]候[，,]/g,
        tag: "#6 过渡句'就在这时'等",
        severity: this.transitionPhraseStrictness === "strict" ? 0.9 : this.transitionPhraseStrictness === "lenient" ? 0.5 : 0.7,
        fix: "事件自然衔接，不依赖过渡句",
        category: "narration_strategy",
      },
      {
        id: "narr_double_adj",
        pattern: /[一-鿿]{1,4}(?:的[一-鿿]{1,4}){2,}/g,
        tag: "#5 形容词堆叠(≥2个)",
        severity: 0.7,
        fix: "用具体细节代替抽象形容词",
        category: "narration_strategy",
      },
      {
        id: "negative_definition_chain",
        // R21修复: lookbehind 排除虚拟语气（要不是/若不是/如果不是/倘若不是/假如不是）+ 选择列举标记（就/便/或），
        // 避免"要不是你，不是躺医院就是躺别的地方"被误判为"不是A，不是B，是C"否定定义链。
        pattern: /(?<![要若如倘假])(?<!如果)(?<!假如)不是[^。！？\n]{1,30}(?:[。！？，,；;]\s*)?不是[^。！？\n]{1,30}(?:[。！？，,；;]\s*)?(?<!就)(?<!便)(?<!或)是[^。！？\n]{1,40}/g,
        tag: "否定定义链：不是A，不是B，是C",
        severity: 0.95,
        fix: "删除否定铺垫，直接写有效信息及人物反应；除非存在明确误判反转或信息差",
        category: "narration_strategy",
      },
      // === 结构类 AI 腔 ===
      {
        id: "structured_enum",
        pattern: /首先.{1,20}其次.{1,20}最后/s,
        tag: "模板化递进",
        severity: 0.7,
        fix: "使用自然的叙事流程替代",
        category: "structure",
      },
      {
        id: "binary_oppose",
        pattern: /一方面.{1,20}另一方面/s,
        tag: "二元对立总结",
        severity: 0.6,
        fix: "使用具体场景和对话替代",
        category: "structure",
      },
      {
        id: "summarize",
        pattern: /总之[,，]/,
        tag: "教科书式总结",
        severity: 0.8,
        fix: "删除总结，直接呈现",
        category: "structure",
      },
      {
        id: "over_explain",
        pattern: /这意味着/g,
        tag: "过度解释",
        severity: 0.5,
        fix: "删除解释，让读者自己理解",
        category: "language",
      },

      // === 语言类 AI 腔 ===
      {
        id: "weak_adverb",
        pattern: /非常(?!\w{2,})/g,
        tag: "弱程度修饰",
        severity: 0.4,
        fix: "用具体细节替代",
        category: "language",
      },
      {
        id: "extreme_adverb",
        pattern: /极其|格外|分外/g,
        tag: "程度副词堆砌",
        severity: 0.3,
        fix: "用具体描写替代",
        category: "language",
      },
      {
        id: "template_syntax",
        pattern: /不仅.{1,20}而且/sg,
        tag: "模板句式",
        severity: this.templatePatternStrictness === "very_strict" ? 0.7 : this.templatePatternStrictness === "lenient" ? 0.2 : this.templatePatternStrictness === "medium" ? 0.3 : 0.4,
        fix: "用自然的因果关系替代",
        category: "language",
      },
      {
        id: "passive_pileup",
        pattern: /被.{1,10}被.{1,10}被/sg,
        tag: "被动语态堆砌",
        severity: 0.4,
        fix: "改用主动语态",
        category: "language",
      },

      // === 描写类 AI 腔 ===
      {
        id: "eye_flash",
        pattern: /眼中闪过.{1,10}(光芒|精光|寒光)/g,
        tag: "模板化眼神",
        severity: 0.7,
        fix: "用外化行动替代表情描写",
        category: "description",
      },
      {
        id: "heart_surge",
        pattern: /心中涌起.{1,10}(感|之情)/g,
        tag: "模板化情感",
        severity: 0.8,
        fix: "用身体反应暗示情绪",
        category: "description",
      },
      {
        id: "metaphor_abuse",
        pattern: /仿佛.{1,20}(一般|似的)/sg,
        tag: "滥用比喻",
        severity: 0.3,
        fix: "减少比喻，或用具体感官描写",
        category: "description",
      },
      {
        id: "lazy_mystery",
        pattern: /不知为何/g,
        tag: "偷懒式神秘感",
        severity: 0.5,
        fix: "给出暗示但不过多解释",
        category: "description",
      },
      {
        id: "universal_describe",
        pattern: /一股.{1,10}的气息/g,
        tag: "万能描写模板",
        severity: 0.9,
        fix: "替换为具体感官细节",
        category: "description",
      },
      {
        id: "empty_beast_eye_metaphor",
        pattern: /(指示灯|灯|灯光|光点|屏幕|按钮|机器|设备)[^。！？\n]{0,20}像[^。！？\n]{0,12}(野兽|怪物|兽|眼睛|鬼火)/g,
        tag: "空泛机器比喻",
        severity: 0.85,
        fix: "删除空泛比喻，改写为设备状态对人物行动、气氛或信息推进的实际影响",
        category: "description",
      },
      {
        id: "stiff_body_failure",
        pattern: /身体[^。！？\n]{0,8}僵硬|僵硬[^。！？\n]{0,8}身体/g,
        tag: "身体僵硬式被动失败",
        severity: 0.75,
        fix: "不要用模板化身体僵硬表现失败；改为具体选择、风险控制、动作受阻或外部压力",
        category: "description",
      },

      // === 对话类 AI 腔 ===
      {
        id: "mono_tag",
        pattern: /^(.){1,30}(说道|问道|答道|回道)/gm,
        tag: "单调对话标签",
        severity: 0.5,
        fix: "用动作替代'XX道'",
        category: "dialogue",
      },
      {
        id: "info_dump_dialogue",
        pattern: /你说得对.{1,100}(因为|所以|首先)/sg,
        tag: "对话式信息倾倒",
        severity: 0.6,
        fix: "通过行动和反应传递信息",
        category: "dialogue",
      },

      // === 场景类 AI 腔 ===
      {
        id: "env_list",
        pattern: /(天空|远处|旁边).{1,20}[，。].{1,20}(树木|建筑|人群)/sg,
        tag: "景物列表式描写",
        severity: 0.6,
        fix: "聚焦一两个具体意象",
        category: "scene",
      },
      {
        id: "stiff_transition",
        pattern: /与此同时/g,
        tag: "生硬过渡",
        severity: 0.5,
        fix: "用场景转换或时间标记",
        category: "scene",
      },
      {
        id: "mono_time",
        pattern: /过了一会儿/g,
        tag: "单调时间词",
        severity: 0.3,
        fix: "用具体事件标记时间",
        category: "scene",
      },
      {
        id: "five_sense_order",
        pattern: /(看到|听见|闻到|触到|尝到).{1,50}(看到|听见|闻到|触到)/sg,
        tag: "五感固定顺序",
        severity: 0.4,
        fix: "打破五感顺序，用最有力的感官",
        category: "scene",
      },

      // P14新增: 重复场景/对话检测
      {
        id: "repeat_dialogue_sequence",
        // 只匹配相同短引号内容的机械重复，避免误伤论坛/聊天体的多条不同短回复。
        pattern: /(“[^”]{3,30}”)(?:[^。！？\n]{0,30}\1){2,}/g,
        tag: "重复性对话堆叠",
        severity: 0.8,
        fix: "同一对话模式出现超过2次，建议合并或用行动替代对话",
        category: "scene",
      },
      {
        id: "repeat_action_sequence",
        // 匹配重复的动作模式，如：同一角色的相似动作描述连续出现
        pattern: /([他她它][^\n。]{0,10}[：:][^\n。]{0,30}){3,}/g,
        tag: "重复动作描述",
        severity: 0.7,
        fix: "同一动作类型重复超过3次，建议用场景跳接或时间跳跃",
        category: "scene",
      },

      // === 过度省略类 AI 腔（新增）===
      {
        id: "excessive_ellipsis",
        // 检测过度省略的句子：只有名词/形容词，缺少动词或完整结构
        pattern: /^[\u4e00-\u9fa5]{1,4}[。！？]$/gm,
        tag: "过度省略：句子成分缺失",
        severity: 0.7,
        fix: "补充必要的句子成分（动词、量词、程度副词等），使句子完整",
        category: "language",
      },
      {
        id: "bare_number_measure",
        // 检测缺少量词的数字：如"七个"而非"七双筷子"
        pattern: /[一二三四五六七八九十百千万\d]+[个只条根把块瓶杯碗][。！？，,\n]/g,
        tag: "缺少完整名词的量词",
        severity: 0.6,
        fix: "补充量词所修饰的名词，使表达完整",
        category: "language",
      },
      {
        id: "bare_adjective_sentence",
        // 检测只有形容词的句子：如"沉。"而非"有点沉。"
        pattern: /^[\u4e00-\u9fa5]{1,2}[。！？]$/gm,
        tag: "过度省略：只有形容词/副词",
        severity: 0.65,
        fix: "补充程度副词或完整表达，避免电报式省略",
        category: "language",
      },

      // === 多余解释/括号式插入类 AI 腔（新增）===
      {
        id: "parenthetical_explanation",
        // 检测用破折号插入的解释性内容：如"不是从外面来的——在转"
        pattern: /——[^——]{2,20}——/g,
        tag: "括号式插入解释",
        severity: 0.7,
        fix: "删除破折号插入的解释，让行为本身说明",
        category: "narration_strategy",
      },
      {
        id: "resource_negative_is_shortcut",
        // 检测否定铺垫后接肯定：如"不是这张脸，是另一个"、"不是灯光——是晨光"、"不是...而是..."
        // 支持 逗号/破折号/而是 三种连接形式，与 filter 的 matchResult 正则保持一致
        pattern: /这?不是[^，。！？\n]{2,30}(?:而是|[，,。]是|——是|—是|--是|-是)[^。！？\n]{2,40}/g,
        tag: "否定铺垫后接肯定",
        severity: 0.85,
        fix: "删除否定铺垫，直接写肯定内容",
        category: "narration_strategy",
      },
      {
        id: "unnecessary_turning_word",
        // 检测多余的转折词：如"可这一刮"
        pattern: /可[^，。！？]{1,10}[，,]/g,
        tag: "多余转折词",
        severity: 0.4,
        fix: "删除不必要的转折词，让句子更直接",
        category: "language",
      },

      // === 场景罗列类 AI 腔（新增）===
      {
        id: "scene_listing",
        // 检测无推进作用的场景罗列：如"走廊。栏杆。下课铃刚响过。"
        pattern: /[\u4e00-\u9fa5]{2,4}[。！？][\u4e00-\u9fa5]{2,4}[。！？][\u4e00-\u9fa5]{2,10}[。！？]/g,
        tag: "场景罗列：无推进作用",
        severity: 0.6,
        fix: "删除无推进作用的场景罗列，只保留有情节推进的句子",
        category: "scene",
      },

      // === 叙事策略类 AI 腔（六条必删模式）===
      {
        id: "pre_label_emotion",
        pattern: /[他她它他们她们].{0,5}(感到|意识到|觉得|感觉到|察觉).{0,5}(恐惧|愤怒|紧张|绝望|不安|焦虑|悲伤|喜悦|兴奋|震惊|痛苦|欣慰|失落|愧疚|期待|惶恐)/g,
        tag: "提前定性读者感受",
        severity: 0.9,
        fix: "删除感知动词+情绪名词，用具体行为或感知细节替代",
        category: "narration_strategy",
      },
      {
        id: "conclusion_before_evidence",
        pattern: /^[^\n。！？]{5,30}(充满|弥漫|笼罩|散发|蕴含).{0,10}(气息|氛围|气氛|感觉|意味)/gm,
        tag: "先结论后证据",
        severity: 0.8,
        fix: "细节先行，结论永远不出现或由读者完成",
        category: "narration_strategy",
      },
      {
        id: "behavior_cause_explained",
        pattern: /[，,].{0,5}(因为|是由于|是因为).{2,30}[。！？]/g,
        tag: "行为动机即时解释",
        severity: 0.7,
        fix: "砍掉\"因为\"及后续解释，让行为悬置",
        category: "narration_strategy",
      },
      {
        id: "redundant_sensory_confirm",
        pattern: /[他她它].{0,3}(看见了?|听到了?|闻到了?|触到了?|感觉到了?|察觉到了?)/g,
        tag: "多余的感知确认",
        severity: 0.6,
        fix: "直接写感知对象；去除感知确认动词",
        category: "narration_strategy",
      },
      {
        id: "emotion_adjective_stack",
        pattern: /[漫长短暂深沉凝重压抑沉默寂静黑暗光明温暖冰冷].{1,3}而.{1,5}的.{1,6}/g,
        tag: "情绪形容词堆叠",
        severity: 0.5,
        fix: "删掉所有形容词，用具体细节让场景自行站立",
        category: "narration_strategy",
      },
      {
        id: "transition_sentence",
        pattern: /就在这时|与此同时|这一切，都要从|事情发生了转折/g,
        tag: "过渡句——解释叙事动作",
        severity: 0.4,
        fix: "删除过渡句，让事件直接发生",
        category: "narration_strategy",
      },
      ...ANTI_AI_PROMPT_RESOURCE_PATTERNS,
    ];
  }

  /**
   * 检测文本中的 AI 腔
   */
  analyze(text: string): AnalysisResult {
    const detections: DetectionResult[] = [];
    let totalMatchCount = 0;
    let totalWeightedMatchLength = 0;

    for (const pattern of this.patterns) {
      const matches = text.match(pattern.pattern);
      if (matches && matches.length > 0) {
        let positions = this.findPositions(text, pattern.pattern);
        let filteredMatches: string[] = matches;

        // R28: excessive_ellipsis 后置过滤——排除有效叙事短句
        // 1-4字短句在网文中是有效的节奏工具（风格指纹明确要求"短句独立成行"）
        // 只保留真正的"过度省略"（纯名词/形容词，无动词，无信息量）
        if (pattern.id === "excessive_ellipsis") {
          const filtered = filterExcessiveEllipsisFalsePositives(text, positions);
          positions = filtered.positions;
          filteredMatches = filtered.matches;
        }

        // [FIX 2026-06-26] bare_adjective_sentence 后置过滤——复用 excessive_ellipsis 的过滤逻辑
        // "不对。""气在。"等含否定/动词的短句是有效叙事，不应判为"只有形容词/副词"
        if (pattern.id === "bare_adjective_sentence") {
          const filtered = filterExcessiveEllipsisFalsePositives(text, positions);
          positions = filtered.positions;
          filteredMatches = filtered.matches;
        }

        // R31: resource_negative_is_shortcut 后置过滤——排除具体名词对比
        // "不是正门，是侧楼梯" 是文学修辞，不是 AI 腔
        // 只保留抽象概念否定铺垫（如"不是能力问题，是态度问题"）
        if (pattern.id === "resource_negative_is_shortcut" || pattern.id === "negative_setup_before_positive") {
          const filtered = filterResourceNegativeFalsePositives(text, positions);
          positions = filtered.positions;
          filteredMatches = filtered.matches;
        }

        // R32: unnecessary_turning_word 后置过滤——"可"字转折在网文中是有效叙事工具
        if (pattern.id === "unnecessary_turning_word") {
          const filtered = filterUnnecessaryTurningWordFalsePositives(text, positions);
          positions = filtered.positions;
          filteredMatches = filtered.matches;
        }

        // R33: bare_number_measure 后置过滤——排除人称代词和对话中的数量表达
        if (pattern.id === "bare_number_measure") {
          const filtered = filterBareNumberMeasureFalsePositives(text, positions);
          positions = filtered.positions;
          filteredMatches = filtered.matches;
        }

        // R36: resource_continue/begin_to_action_padding 后置过滤——排除否定语境(没有继续/并未开始)
        if (pattern.id === "resource_continue_to_action_padding" || pattern.id === "resource_begin_to_action_padding") {
          const filtered = filterNegatedActionPaddingFalsePositives(text, positions);
          positions = filtered.positions;
          filteredMatches = filtered.matches;
        }

        // R37: narr_perception_confirm 后置过滤——"感觉到+变化动词"是叙事推进,不是多余感知确认
        // "他感觉到边缘在松"描述主角感受到的变化(修真识海场景),是有效叙事。
        // 真正多余的感知确认是"他看见了X"——主角主动确认已感知到的事物。
        if (pattern.id === "narr_perception_confirm") {
          const filtered = filterPerceptionConfirmFalsePositives(text, positions);
          positions = filtered.positions;
          filteredMatches = filtered.matches;
        }

        // R40: behavior_cause_explained 后置过滤——"因为+具体身体动作/反应"是身体力学描述
        // "肩线因为连续出拳而微微下沉"是修真训练场景身体力学因果,不是抽象行为动机解释。
        // [FIX 2026-06-26 P23] 同时过滤背景叙述("烧了二十三年，因为他出生那天父亲点的")
        if (pattern.id === "behavior_cause_explained") {
          const filtered = filterBehaviorCauseExplainedFalsePositives(text, positions);
          positions = filtered.positions;
          filteredMatches = filtered.matches;
        }

        // [FIX 2026-06-26 P23] R40b: narr_because_motivation 后置过滤——背景叙述误判
        // "灯烧了二十三年，因为他出生那天父亲点的"是背景设定因果,不是行为动机即时解释。
        if (pattern.id === "narr_because_motivation") {
          const filtered = filterNarrBecauseMotivationFalsePositives(text, positions);
          positions = filtered.positions;
          filteredMatches = filtered.matches;
        }

        // R41: negative_definition_chain 后置过滤——"不是A，不是B。是C"修真揭示修辞
        // "不是力量，不是威压。是某种极旧的、快要耗尽的东西"是排除法锁定未知本质,非 AI 腔否定链。
        if (pattern.id === "negative_definition_chain") {
          const filtered = filterNegativeDefinitionChainFalsePositives(text, positions);
          positions = filtered.positions;
          filteredMatches = filtered.matches;
        }

        // R42: parenthetical_explanation 后置过滤——独立"动作——结果"非成对插入语
        // "往右看——没有。往左——没有"是独立句子节奏停顿,非括号式插入解释。
        if (pattern.id === "parenthetical_explanation") {
          const filtered = filterParentheticalExplanationFalsePositives(text, positions);
          positions = filtered.positions;
          filteredMatches = filtered.matches;
        }

        // R43: five_sense_order 后置过滤——同一感官并列非五感列举
        // "能看到...也能看到"是视觉并列,非视/听/嗅/味/触五感固定顺序。
        if (pattern.id === "five_sense_order") {
          const filtered = filterFiveSenseOrderFalsePositives(text, positions);
          positions = filtered.positions;
          filteredMatches = filtered.matches;
        }

        // R34: narr_double_adj 后置过滤——排除"越X越Y"叙事描写
        if (pattern.id === "narr_double_adj") {
          const filtered = filterNarrDoubleAdjFalsePositives(text, positions);
          positions = filtered.positions;
          filteredMatches = filtered.matches;
        }

        // R35: redundant_sensory_confirm 后置过滤——排除否定形式（没看见/没听到等揭示铺垫）
        if (pattern.id === "redundant_sensory_confirm") {
          const filtered = filterRedundantSensoryConfirmFalsePositives(text, positions);
          positions = filtered.positions;
          filteredMatches = filtered.matches;
        }

        // R38: universal_describe 后置过滤——"一股X的气息"后接具体感官细节时已是有效描写
        if (pattern.id === "universal_describe") {
          const filtered = filterUniversalDescribeFalsePositives(text, positions);
          positions = filtered.positions;
          filteredMatches = filtered.matches;
        }

        // R39: extreme_adverb 后置过滤——"格外+具体感官/比喻"是有效感官描写
        if (pattern.id === "extreme_adverb") {
          const filtered = filterExtremeAdverbFalsePositives(text, positions);
          positions = filtered.positions;
          filteredMatches = filtered.matches;
        }

        if (positions.length === 0) continue;

        detections.push({
          patternId: pattern.id,
          tag: pattern.tag,
          severity: pattern.severity,
          count: positions.length,
          positions,
          fix: pattern.fix || "建议修改",
        });

        totalMatchCount += positions.length;
        // 加权密度: match.length * severity（severity 即规则权重，高严重度模式贡献更大）
        for (const match of filteredMatches) {
          totalWeightedMatchLength += match.length * pattern.severity;
        }
      }
    }

    const repeatedSentencePositions = collectExactRepeatedSentencePositions(text);
    if (repeatedSentencePositions.length > 0) {
      const severity = 0.7;
      detections.push({
        patternId: "repeat_sentence_exact",
        tag: "完全重复句",
        severity,
        count: repeatedSentencePositions.length,
        positions: repeatedSentencePositions,
        fix: "删除后续完全重复句，只保留第一次有效信息",
      });
      totalMatchCount += repeatedSentencePositions.length;
      totalWeightedMatchLength += repeatedSentencePositions.length * 20 * severity;
    }

    for (const detection of collectStructuralReplayDetections(text, this.characterNames)) {
      detections.push(detection);
      totalMatchCount += detection.count;
      totalWeightedMatchLength += detection.count * 15 * detection.severity;
    }

    // density = 加权AI特征量 / 文本总字符数
    // 权重 = severity（高严重度模式贡献更大）
    const totalChars = Math.max(1, text.length);
    const density = totalWeightedMatchLength / totalChars;

    // Round 10 P1: 使用类型化阈值
    const greenThreshold = this.typeProfile ? this.typeAwareParams.aiDensityThreshold * 0.33 : 0.1;
    const yellowThreshold = this.typeProfile ? this.typeAwareParams.aiDensityThreshold : 0.3;

    let level: "green" | "yellow" | "red";
    if (density < greenThreshold) {
      level = "green";
    } else if (density < yellowThreshold) {
      level = "yellow";
    } else {
      level = "red";
    }

    const report = this.generateReport(text, density, level, detections);

    return {
      density,
      level,
      detections,
      report,
      totalIssues: detections.reduce((sum, d) => sum + d.count, 0),
      // Round 10 P1: 扩展结果
      _typeAware: this.typeProfile ? {
        threshold: yellowThreshold,
        strictnessLevel: this.typeAwareParams.strictnessLevel,
      } : undefined,
    };
  }

  /**
   * P22新增: 检测局部高严重问题
   *
   * 与全章密度检测不同，此方法检测局部区域的高严重问题，
   * 即使全章密度低，如果存在局部高严重问题也应阻断。
   *
   * P3/P4修复: 增加同类高频检测和 idiom stacking 检测
   *
   * 返回: { blocked: boolean, issues: string[], severity: number }
   */
  analyzeLocalHotspots(text: string): { blocked: boolean; issues: string[]; severity: number; positions: number[] } {
    const issues: string[] = [];
    const allPositions: number[] = [];
    let maxSeverity = 0;
    // P3: 按类别统计命中次数
    const categoryCounts = new Map<string, number>();
    // R23: 统一脱敏对话内容。所有叙述风格 AI 腔检测项都应在 maskedText 上跑，
    // 避免角色台词（天然口语化）被误判为 AI 腔。
    const maskedText = maskDialogueContent(text);

    // 检测电报体短句堆叠（连续3个以上短句）
    const telegraphPositions = collectTelegraphSentencePileupPositions(text, this.characterNames);
    if (telegraphPositions.length > 0) {
      issues.push(`电报体短句堆叠: ${telegraphPositions.length} 处`);
      allPositions.push(...telegraphPositions);
      maxSeverity = Math.max(maxSeverity, 0.85);
      categoryCounts.set("telegraph_pileup", (categoryCounts.get("telegraph_pileup") ?? 0) + telegraphPositions.length);
    }

    // 检测否定定义链（不是A，不是B，是C）
    // R21修复:
    //   A. 首个"不是"加 lookbehind 排除虚拟语气前导（要不是/若不是/如果不是/倘若不是/假如不是），
    //      避免"要不是你，不是躺医院就是躺别的地方"被误判。
    //   B. 结尾"是"加 lookbehind 排除选择列举标记（就/便/或），保留 bare "是 C" 的经典 AI 模式识别，
    //      同时排除"不是A就是B"选择句。
    //   C. 密度感知 severity: 1处→0.7（warning），2处→0.85，3+处→0.95（阻断）。
    // R23: 在 maskedText 上跑，避免对话引号内的"不是…是…"被误判。
    const negativeChainPattern = /(?<![要若如倘假])(?<!如果)(?<!假如)不是[^。！？\n]{1,30}(?:[。！？，,；;]\s*)?不是[^。！？\n]{1,30}(?:[。！？，,；;]\s*)?(?<!就)(?<!便)(?<!或)是[^。！？\n]{1,40}/g;
    const negativeChainMatches = maskedText.match(negativeChainPattern);
    if (negativeChainMatches && negativeChainMatches.length > 0) {
      const ncCount = negativeChainMatches.length;
      issues.push(`否定定义链: ${ncCount} 处`);
      const ncSeverity = ncCount >= 3 ? 0.95 : ncCount === 2 ? 0.85 : 0.7;
      maxSeverity = Math.max(maxSeverity, ncSeverity);
      categoryCounts.set("negative_chain", (categoryCounts.get("negative_chain") ?? 0) + ncCount);
    }

    // 检测模板化眼神描写 (R23: 在 maskedText 上跑)
    const eyeFlashPattern = /眼中闪过.{1,10}(光芒|精光|寒光)/g;
    const eyeFlashMatches = maskedText.match(eyeFlashPattern);
    if (eyeFlashMatches && eyeFlashMatches.length > 0) {
      issues.push(`模板化眼神描写: ${eyeFlashMatches.length} 处`);
      maxSeverity = Math.max(maxSeverity, 0.7);
      categoryCounts.set("eye_flash", (categoryCounts.get("eye_flash") ?? 0) + eyeFlashMatches.length);
    }

    // 检测模板化情感描写 (R23: 在 maskedText 上跑)
    const heartSurgePattern = /心中涌起.{1,10}(感|之情)/g;
    const heartSurgeMatches = maskedText.match(heartSurgePattern);
    if (heartSurgeMatches && heartSurgeMatches.length > 0) {
      issues.push(`模板化情感描写: ${heartSurgeMatches.length} 处`);
      maxSeverity = Math.max(maxSeverity, 0.8);
      categoryCounts.set("heart_surge", (categoryCounts.get("heart_surge") ?? 0) + heartSurgeMatches.length);
    }

    // 检测行为动机即时解释 (R23: 在 maskedText 上跑，避免对话内"因为"被误判)
    // R24修复: 排除生理/物理因果（身体部位+物理动作导致的物理状态反应）
    //   误判例: "指节因为攥得太紧，泛着白" ← 物理因果（攥紧→泛白），非心理动机
    //   真阳性: "她转身离开，是因为她觉得他不再值得等待" ← 叙述者代替读者推理心理
    // 区分: 因为前接身体部位名词（指节/手/脸/眼/心/身体等）→ 生理描写，排除
    const behaviorCausePattern = /[，,].{0,5}(因为|是由于|是因为).{2,30}[。！？]/g;
    const PHYSIOLOGICAL_BODY_PARTS = /(指节|手指|手心|手背|手掌|拳头|手|脸|脸颊|眼|眼眶|眼睛|心|心脏|身体|脚|脚趾|头|嘴|唇|眉|额头|额|背|肩|臂|腿|骨|皮肤|血|汗|喉咙|胸口|胸|颈|脖子|腕|踝|膝)/;
    const behaviorCauseMatches = (maskedText.match(behaviorCausePattern) || []).filter((m) => {
      // 排除: 因为 前面是身体部位名词 → 生理/物理因果，非心理动机
      if (PHYSIOLOGICAL_BODY_PARTS.test(m)) return false;
      return true;
    });
    if (behaviorCauseMatches && behaviorCauseMatches.length > 0) {
      issues.push(`行为动机即时解释: ${behaviorCauseMatches.length} 处`);
      maxSeverity = Math.max(maxSeverity, 0.7);
      categoryCounts.set("behavior_cause", (categoryCounts.get("behavior_cause") ?? 0) + behaviorCauseMatches.length);
    }

    // 检测空泛机器比喻 (R23: 在 maskedText 上跑)
    const machineMetaphorPattern = /(指示灯|灯|灯光|光点|屏幕|按钮|机器|设备)[^。！？\n]{0,20}像[^。！？\n]{0,12}(野兽|怪物|兽|眼睛|鬼火)/g;
    const machineMetaphorMatches = maskedText.match(machineMetaphorPattern);
    if (machineMetaphorMatches && machineMetaphorMatches.length > 0) {
      issues.push(`空泛机器比喻: ${machineMetaphorMatches.length} 处`);
      maxSeverity = Math.max(maxSeverity, 0.85);
      categoryCounts.set("machine_metaphor", (categoryCounts.get("machine_metaphor") ?? 0) + machineMetaphorMatches.length);
    }

    // 检测章末AI腔模板 (R23: 在 maskedText 上跑)
    const endingAITemplatePattern = /欲知后事如何|一切才刚刚开始|注定不平静|更大的危险|这仅仅是开始/g;
    const endingAITemplateMatches = maskedText.match(endingAITemplatePattern);
    if (endingAITemplateMatches && endingAITemplateMatches.length > 0) {
      issues.push(`章末AI腔模板: ${endingAITemplateMatches.length} 处`);
      maxSeverity = Math.max(maxSeverity, 0.9);
      categoryCounts.set("ending_template", (categoryCounts.get("ending_template") ?? 0) + endingAITemplateMatches.length);
    }

    // P3: 检测同类高频堆叠
    // P18修复: telegraph_pileup 使用密度感知阈值，其他类别保持 >= 3
    const HIGH_FREQ_THRESHOLD = 3;
    // telegraph_pileup 密度感知: 每千字 >= 1 处才算高频（3处/4800字 = 0.62/千字 不应阻断）
    const TELEGRAPH_DENSITY_THRESHOLD = 1.0; // 每千字
    const chineseCharCount = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const thousandCharUnits = Math.max(chineseCharCount / 1000, 0.1);

    for (const [category, count] of categoryCounts) {
      if (category === "telegraph_pileup") {
        const density = count / thousandCharUnits;
        if (density >= TELEGRAPH_DENSITY_THRESHOLD && count >= HIGH_FREQ_THRESHOLD) {
          issues.push(`[同类高频] ${category}: ${count} 次命中（密度 ${density.toFixed(2)}/千字），触发堆叠阻断`);
          maxSeverity = Math.max(maxSeverity, 0.9);
        } else if (count >= HIGH_FREQ_THRESHOLD) {
          // 低密度 telegraph_pileup: 记录但不提升到阻断严重度
          issues.push(`[同类低频] ${category}: ${count} 次命中（密度 ${density.toFixed(2)}/千字），未达阻断密度`);
          // 不提升 maxSeverity
        }
      } else {
        if (count >= HIGH_FREQ_THRESHOLD) {
          issues.push(`[同类高频] ${category}: ${count} 次命中，触发堆叠阻断`);
          maxSeverity = Math.max(maxSeverity, 0.9);
        }
      }
    }

    // P4: 检测 idiom stacking —— 单句中连续出现多个四字格/成语模板
    // 匹配模式: 严格四字中文短语用逗号/顿号连接，连续3个以上
    // 例: "风平浪静，云淡风轻，水到渠成。" ✓
    // 排除: "他走进房间，关上门，坐了下来。" (代词开头、动宾结构叙事句)
    // R23修复:
    //   A. 在 maskedText 上分句，避免对话引号内的四字片段被误判。
    //   B. 增加 isLikelyIdiom 校验：排除含助词(的/了/着/过)、数词、人名的"伪四字格"。
    //      修复"琥珀色的/倒进白瓷"(含助词+截断)、人名被截断成4字等误判。
    const IDIOM_STACKING_THRESHOLD = 3;
    // 严格四字：每个短语必须恰好4个汉字（成语/四字格典型长度）
    const fourCharIdiomPattern = /(?:^|[，、,])\s*([\u4e00-\u9fff]{4})[，、,]\s*([\u4e00-\u9fff]{4})[，、,]\s*([\u4e00-\u9fff]{4})(?:[，、,]\s*([\u4e00-\u9fff]{4}))*/g;
    // R23: 判断4字短语是否"像成语/四字格"。排除含助词/数词/人名的叙事片段。
    const isLikelyIdiom = (phrase: string): boolean => {
      // 排除：含助词（的/了/着/过）—— 成语通常不含这些
      if (/[的了着过]/.test(phrase)) return false;
      // R26: 排除含副词/否定词的叙事片段（"鞋还没脱"含"还"+"没"，非成语）
      if (/[还也都又再才就刚正已将没不无非]/.test(phrase)) return false;
      // 排除：含数词 —— "一二三四"式不是典型成语堆叠
      if (/[一二三四五六七八九十百千万几]/.test(phrase)) return false;
      // R26: 排除含常见动词的动宾结构（"推开家门"=推开+家门，非成语）
      if (/^(推开|走进|走进|拿起|放下|打开|关上|坐起|站起|转身|抬头|低头|伸手|缩手|迈步|踏上|走进|走出|跑出|走出)/.test(phrase)) return false;
      // R26: 排除含方位词/身体部位名词的叙事片段（"脑子里全"=截断片段，非成语）
      if (/(脑子|心里|眼前|脸上|手上|脚下|背后|身上|怀里|身边)/.test(phrase)) return false;
      // R32: 排除悬疑场景"物体+动作"叙事短语（"引擎熄火"/"车门关上"/"皮鞋踩在"）
      // 特征: 具体物体名词 + 动作动词，非成语
      if (/^(引擎|车门|皮鞋|脚步|手机|屏幕|门板|窗帘|灯|光|车|表|钟|镜|锁|钥匙|名片|信|纸|笔|杯|碗|筷|刀|枪|剑|棍|针|线|管|链)/.test(phrase)) return false;
      // R32: 排除末尾是介词/方位词的叙事片段（"踩在"/"关上"/"熄火"含动作方向）
      if (/(在|上|下|里|外|中|间|来|去|出|入|起|开|回|到|着|了|过)$/.test(phrase)) return false;
      // 排除：含角色名片段（人名被截断成4字）
      if (this.characterNames.size > 0) {
        for (const name of this.characterNames) {
          if (phrase.includes(name) || name.includes(phrase)) return false;
        }
      }
      return true;
    };
    const sentences = maskedText.split(/[。！？\n]/).filter(s => s.trim().length > 0);
    let idiomStackingCount = 0;
    for (const sentence of sentences) {
      const trimmed = sentence.trim();
      // 排除代词/人称开头的叙事句（"他走进房间，关上门，坐了下来"）
      if (/^[他她它我你你们们他们她们]/.test(trimmed)) continue;
      // R24: 排除角色名开头的叙事句（连续动作叙事不是成语堆叠，应排除）
      if (this.characterNames.size > 0) {
        let startsWithName = false;
        for (const name of this.characterNames) {
          if (name.length >= 2 && trimmed.startsWith(name)) {
            startsWithName = true;
            break;
          }
        }
        if (startsWithName) continue;
      }
      let m: RegExpExecArray | null;
      fourCharIdiomPattern.lastIndex = 0;
      while ((m = fourCharIdiomPattern.exec(trimmed)) !== null) {
        const matchStr = m[0];
        // R23: 用 isLikelyIdiom 过滤，只统计真正的成语/四字格
        const phraseCount = matchStr.split(/[，、,]\s*/).filter(p => p.length === 4 && isLikelyIdiom(p)).length;
        if (phraseCount >= IDIOM_STACKING_THRESHOLD) {
          idiomStackingCount++;
        }
      }
    }
    if (idiomStackingCount > 0) {
      issues.push(`[idiom stacking] ${idiomStackingCount} 处四字格连续堆叠 (>= ${IDIOM_STACKING_THRESHOLD} 个)`);
      maxSeverity = Math.max(maxSeverity, 0.85);
      categoryCounts.set("idiom_stacking", (categoryCounts.get("idiom_stacking") ?? 0) + idiomStackingCount);
    }

    // 阻断条件（P3/P4/R23/R26修复后）:
    // 1. 任何单个问题严重度 >= 0.9
    // 2. 不同类别问题数 >= 3（R23: 用 categoryCounts.size 而非 issues.length，
    //    避免 [同类高频]/[idiom stacking] 聚合标签膨胀 issues 数组导致误触发）
    // 3. 单类别高频堆叠（命中 >= 3 次）
    //    R28修复: telegraph_pileup 应用密度感知——低密度（< 1.0/千字）不算堆叠阻断
    //    避免长章节中少量短句堆叠（3处/5000字=0.6/千字）被误判为高频堆叠
    // 4. idiom stacking（单句含 >= 3 个模板化四字格）
    //    R26: isLikelyIdiom 已增强过滤（排除副词/否定词/动宾结构/截断片段），误判已消除
    const hasHighSeverity = maxSeverity >= 0.9;
    const hasMultiCategory = categoryCounts.size >= 3;
    const hasCategoryStacking = Array.from(categoryCounts.entries()).some(([category, count]) => {
      if (category === "telegraph_pileup") {
        // R28: telegraph_pileup 需要同时满足 count >= 3 且 density >= 阈值
        const density = count / thousandCharUnits;
        return density >= TELEGRAPH_DENSITY_THRESHOLD && count >= HIGH_FREQ_THRESHOLD;
      }
      return count >= HIGH_FREQ_THRESHOLD;
    });
    const hasIdiomStacking = idiomStackingCount > 0;
    const blocked = hasHighSeverity || hasMultiCategory || hasCategoryStacking || hasIdiomStacking;

    return {
      blocked,
      issues,
      severity: maxSeverity,
      positions: allPositions,
    };
  }

  /**
   * 查找匹配位置
   */
  private findPositions(text: string, pattern: RegExp): number[] {
    const positions: number[] = [];
    let match;

    const regex = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");

    while ((match = regex.exec(text)) !== null) {
      positions.push(match.index);
    }

    return positions;
  }

  /**
   * 生成报告
   */
  private generateReport(
    text: string,
    density: number,
    level: "green" | "yellow" | "red",
    detections: DetectionResult[]
  ): string {
    const lines: string[] = [];

    lines.push("## AI 腔检测报告");
    lines.push("");
    lines.push(`检测密度: ${density.toFixed(3)}`);
    lines.push(`检测等级: ${level === "green" ? "✅ 绿色" : level === "yellow" ? "⚠️ 黄色" : "❌ 红色"}`);
    lines.push(`问题总数: ${detections.reduce((sum, d) => sum + d.count, 0)}`);
    lines.push("");

    if (detections.length === 0) {
      lines.push("未检测到明显的 AI 腔问题。");
      return lines.join("\n");
    }

    lines.push("### 问题详情");
    lines.push("");

    detections.sort((a, b) => b.severity - a.severity);

    for (const detection of detections) {
      const levelIcon = detection.severity >= 0.7 ? "🔴" : detection.severity >= 0.4 ? "🟡" : "🟢";
      const pattern = this.patterns.find((p) => p.id === detection.patternId);
      const isNarrationStrategy = pattern?.category === "narration_strategy";
      const categoryTag = isNarrationStrategy ? " ⚠️【必删】" : "";

      lines.push(`#### ${levelIcon} ${detection.tag}${categoryTag}`);
      lines.push(`- 出现次数: ${detection.count}`);
      lines.push(`- 严重程度: ${(detection.severity * 100).toFixed(0)}%`);
      lines.push(`- 修复建议: ${detection.fix}`);

      const example = this.extractExample(text, detection.positions[0], detection.patternId);
      if (example) {
        lines.push(`- 示例: "${example}"`);
      }
      lines.push("");
    }

    if (level === "red") {
      lines.push("### 强制修改建议");
      lines.push("");
      lines.push("当前文本 AI 腔密度过高，建议进行全面修订。");
      lines.push("重点关注红色和黄色标记的问题。");
    } else if (level === "yellow") {
      lines.push("### 建议优化");
      lines.push("");
      lines.push("当前文本存在少量 AI 腔，建议针对性优化。");
    }

    return lines.join("\n");
  }

  /**
   * 提取示例
   */
  private extractExample(text: string, position: number, patternId: string): string | null {
    const pattern = this.patterns.find((p) => p.id === patternId);
    if (!pattern) return null;

    const match = text.substring(position, position + 50).match(/[^。！？]{0,30}/);
    return match ? match[0].trim() : null;
  }

  /**
   * 生成修正指令
   */
  generateFixInstructions(result: AnalysisResult): string[] {
    const instructions: string[] = [];

    const hasNarrationStrategy = result.detections.some((d) => {
      const pattern = this.patterns.find((p) => p.id === d.patternId);
      return pattern?.category === "narration_strategy";
    });

    if (hasNarrationStrategy) {
      instructions.push(
        "【总规则】如果一个句子删掉之后，读者感受到的东西反而更强——那这个句子必须删。"
      );
      instructions.push(
        "【句子功能审计】逐句检查是否推进情节、埋伏笔、体现性格、制造冲突或承载情绪转折；五项都不命中的句子必须删除或合并。"
      );
    }

    for (const detection of result.detections) {
      if (detection.severity >= 0.5) {
        instructions.push(
          `修正第 ${detection.count} 处"${detection.tag}"：${detection.fix}`
        );
      }
    }

    return instructions;
  }

  /**
   * 统计各类别问题
   */
  getCategoryStats(detections: DetectionResult[]): Record<string, number> {
    const stats: Record<string, number> = {
      structure: 0,
      language: 0,
      description: 0,
      dialogue: 0,
      scene: 0,
      narration_strategy: 0,
    };

    for (const detection of detections) {
      const pattern = this.patterns.find((p) => p.id === detection.patternId);
      if (pattern) {
        stats[pattern.category] += detection.count;
      }
    }

    return stats;
  }

  // ============================================================================
  // 章末AI腔专项检测 (v9.0 新增)
  // ============================================================================

  /**
   * 章末AI腔专项检测
   * #438: 检测"欲知后事如何/一切才刚刚开始/注定不平静/更大的危险"等高风险模板句式
   */
  private endingPatterns: Array<{
    id: string;
    pattern: RegExp;
    tag: string;
    fix: string;
  }> = [
    { id: "end_predicted_future", pattern: /欲知后事/g, tag: "欲知后事如何", fix: "删除套话，让情节自然收束" },
    { id: "end_just_began", pattern: /一切才刚开始/g, tag: "一切才刚刚开始", fix: "用具体暗示替代模糊预告" },
    { id: "end_unquiet", pattern: /注定不平静/g, tag: "注定不平静", fix: "用具体场景替代总结性判断" },
    { id: "end_bigger_danger", pattern: /更大的危险/g, tag: "更大的危险", fix: "用具体威胁替代抽象预告" },
    { id: "end_unexpected_appear", pattern: /意想不到的人/g, tag: "意想不到的人出现", fix: "给出暗示而非直接揭示" },
    { id: "end_didnt_expect", pattern: /他没有想到/g, tag: "他没有想到", fix: "用内心独白替代叙述者断言" },
    { id: "end_unfolding", pattern: /故事才刚刚/g, tag: "故事才刚刚开始", fix: "用开放式问题替代宣言式结尾" },
    { id: "end_story_complex", pattern: /事情远比/g, tag: "事情远比想象的复杂", fix: "用具体细节替代定性总结" },
    { id: "end_mysterious", pattern: /一个神秘/g, tag: "一个神秘的身影", fix: "给出具体描写而非标签化描述" },
    { id: "end_suspense_end", pattern: /而这，只/g, tag: "而这，只是开始", fix: "删除预告式结尾" },
  ];

  /**
   * 分析章末500字的AI腔
   */
  analyzeEnding(text: string): EndingAIResult {
    const endingText = text.length > 500 ? text.slice(-500) : text;
    const detections: EndingDetection[] = [];

    for (const pattern of this.endingPatterns) {
      const match = endingText.match(pattern.pattern);
      if (match) {
        const position = endingText.search(pattern.pattern);
        detections.push({
          patternId: pattern.id,
          tag: pattern.tag,
          match: match[0],
          position,
          fix: pattern.fix,
        });
      }
    }

    // 计算分数：每检测到一个高风险模板扣0.15分
    const baseScore = 1.0;
    const penalty = detections.length * 0.15;
    const score = Math.max(0, baseScore - penalty);

    let level: "pass" | "warning" | "fail";
    if (score >= 0.7) {
      level = "pass";
    } else if (score >= 0.4) {
      level = "warning";
    } else {
      level = "fail";
    }

    const report = this.generateEndingReport(detections, score, level);

    return {
      score: Math.round(score * 100) / 100,
      level,
      detections,
      report,
    };
  }

  /**
   * 生成章末检测报告
   */
  private generateEndingReport(detections: EndingDetection[], score: number, level: "pass" | "warning" | "fail"): string {
    const lines: string[] = [];

    lines.push("## \u7AE0\u672BAI\u8154\u4E13\u9879\u68C0\u6D4B\u62A5\u544A");
    lines.push("");
    lines.push("\u68C0\u6D4B\u8303\u56F4: \u7AE0\u672B\u6700\u540E500\u5B57");
    lines.push("AI\u8154\u5206\u6570: " + (score * 100).toFixed(0) + "%");
    const levelText = level === "pass" ? "\u2714\u901A\u8FC7" : level === "warning" ? "\u26A0\u8B66\u544A" : "\u274C\u4E0D\u901A\u8FC7";
    lines.push("\u68C0\u6D4B\u7B49\u7EA7: " + levelText);
    lines.push("");

    if (detections.length === 0) {
      lines.push("\u672A\u68C0\u6D4B\u5230\u9AD8\u98CE\u9669AI\u8154\u6A21\u677F\u53E5\u5F0F\u3002");
    } else {
      lines.push("\u68C0\u6D4B\u5230 " + detections.length + " \u5904\u9AD8\u98CE\u9669\u6A21\u677F:");
      lines.push("");

      for (const d of detections) {
        lines.push("- **" + d.tag + "**");
        lines.push("  - \u5339\u914D\u6587\u672C: \"" + d.match + "\"");
        lines.push("  - \u4FEE\u590D\u5EFA\u8BAE: " + d.fix);
        lines.push("");
      }
    }

    if (level === "fail") {
      lines.push("### \u5F3A\u5236\u91CD\u5199\u5EFA\u8BAE");
      lines.push("");
      lines.push("\u7AE0\u672BAI\u8154\u68C0\u6D4B\u4E0D\u901A\u8FC7\uFF0C\u5EFA\u8BAE\u91CD\u5199\u7AE0\u672B\u6700\u540E200\u5B57\uFF0C\u9075\u5FAA\u4EE5\u4E0B\u539F\u5219:");
      lines.push("1. \u5220\u9664\u6240\u6709\u9884\u6D4B\u6027\u5957\u8BDD");
      lines.push("2. \u7528\u5177\u4F53\u611F\u5B98\u63CF\u5199\u66FF\u4EE3\u62BD\u8C61\u603B\u7ED3");
      lines.push("3. \u4FDD\u6301\u5F00\u653E\u5F0F\u7ED3\u5C3E\uFF0C\u7ED9\u8BFB\u8005\u60F3\u8C61\u7A7A\u95F4");
    } else if (level === "warning") {
      lines.push("### \u4F18\u5316\u5EFA\u8BAE");
      lines.push("");
      lines.push("\u7AE0\u672B\u5B58\u5728\u5C11\u91CFAI\u8154\u75D5\u8FF9\uFF0C\u5EFA\u8BAE\u9488\u5BF9\u6027\u4FEE\u6539\u4E0A\u8FF0\u6807\u8BB0\u4F4D\u7F6E");
    }

    return lines.join("\n");
  }
}

/**
 * 创建 Anti-AI Detector 实例
 */
export function createAntiAIDetector(options?: {
  transitionPhraseStrictness?: "strict" | "medium" | "lenient";
  templatePatternStrictness?: "very_strict" | "strict" | "medium" | "lenient";
  infoRepeatStrictness?: "very_strict" | "strict" | "medium" | "lenient";
  /** R23: 角色名白名单（含 aliases） */
  characterNames?: string[];
}): AntiAIDetector {
  return new AntiAIDetector(options);
}

// 自动修复函数已提取到 anti-ai-auto-patch.ts（refactor，行为零变化）
// re-export 保持向后兼容：现有消费者仍从 anti-ai-detector.js 导入这些符号
export {
  type AutoPatchResult,
  autoPatchAIPatterns,
  type IdiomStackingRepairResult,
  repairIdiomStackingLocally,
} from "./anti-ai-auto-patch.js";

// ============================================================================
// P1-3: 路由 LLM 增强检测
// ============================================================================

/**
 * 构建 AntiAI LLM 检测的文本窗口。
 *
 * 通用规则（不绑定任何单本小说）：
 * - 短文本（≤ ANTI_AI_LLM_FULL_TEXT_LIMIT）全量送检；
 * - 超长文本送头部 + 尾部，并用明确分隔标注省略中段，保证：
 *   1) 开篇前三句（最高风险区）始终可见；
 *   2) 章节结尾始终可见——否则 LLM 看不到结尾会幻觉出"断句残缺/拼接痕迹"，
 *      误判为文本残缺，触发 anti_ai_llm_residue 误阻断。
 */
const ANTI_AI_LLM_FULL_TEXT_LIMIT = 12000;
const ANTI_AI_LLM_HEAD_LIMIT = 8000;
const ANTI_AI_LLM_TAIL_LIMIT = 4000;

export function buildAntiAILLMDetectionTextWindow(text: string): string {
  const source = text || "";
  if (source.length <= ANTI_AI_LLM_FULL_TEXT_LIMIT) {
    return source;
  }
  const head = source.slice(0, ANTI_AI_LLM_HEAD_LIMIT);
  const tail = source.slice(source.length - ANTI_AI_LLM_TAIL_LIMIT);
  return `${head}\n\n[...中段省略，仅保留开篇与结尾用于检测...]\n\n${tail}`;
}

/**
 * 文本残缺幻觉本地校验：LLM 偶尔会幻觉出"结尾断句残缺/拼接痕迹"，
 * 即使文本实际以正常标点收束。此函数对声称文本残缺的检测做本地复核——
 * 若文本确实以终止标点（。！？』」"'\u201d）收尾，则该检测属幻觉，剔除之。
 *
 * 通用规则，不绑定任何单本小说；只剔除"文本本身残缺"类幻觉，
 * 不影响场景切换、过渡句等其它合法检测。
 */
const ANTI_AI_TRUNCATION_HALLUCINATION_TERMS = [
  "文本残缺",
  "断句残缺",
  "结尾残缺",
  "收束中断",
  "结尾中断",
  "章节收束中断",
  "拼接痕迹",
  "正文残缺",
  "残缺导致",
];
const ANTI_AI_TEXT_TERMINAL_PUNCTUATION = new Set([
  "。", "！", "？", "”", "’", "』", "」", "）", ")", "\"", "'",
]);

export function isTextActuallyComplete(text: string): boolean {
  const source = (text || "").trimEnd();
  if (source.length === 0) return false;
  const lastChar = source[source.length - 1];
  return ANTI_AI_TEXT_TERMINAL_PUNCTUATION.has(lastChar);
}

function filterHallucinatedTextTruncationDetections(
  text: string,
  detections: LLMEnhanceResult["llmDetections"]
): LLMEnhanceResult["llmDetections"] {
  if (!Array.isArray(detections) || detections.length === 0) return detections;
  // 文本确实以终止标点收尾时，才剔除"文本残缺"类检测；
  // 文本真的被截断时（无终止标点）保留检测，不削弱门禁。
  if (!isTextActuallyComplete(text)) return detections;
  return detections.filter((detection) => {
    const haystack = `${detection?.type ?? ""} ${detection?.description ?? ""}`;
    return !ANTI_AI_TRUNCATION_HALLUCINATION_TERMS.some((term) => haystack.includes(term));
  });
}

export interface LLMEnhanceResult {
  hasLLMDetection: boolean;
  /** P17新增: 标记 LLM 检测是否失败 */
  llmDetectionFailed?: boolean;
  llmDetections: {
    type: string;
    description: string;
    severity: "high" | "medium" | "low";
    suggestion: string;
  }[];
  overallAssessment: string;
}

/**
 * P1-3: 使用路由模型进行 LLM 增强检测
 * 在正则检测的基础上，用 LLM 识别更复杂的 AI 腔模式
 *
 * 根因修复: 添加 outlineContent 参数，让检测器知道当前章节要达成什么叙事目标。
 */
export async function analyzeWithLLM(
  text: string,
  options?: {
    outlineContent?: string;
    currentChapterEvents?: string[];
  }
): Promise<LLMEnhanceResult> {
  const systemPrompt = `你是一个专业的网文写作质量审查专家，专注于检测 AI 生成文本中的"机器味"模式。

## 你的任务
分析给定的小说文本，识别其中可能的 AI 腔模式。

## AI 腔特征清单（必须严格检查）

### 1. 提前定性读者感受
- 模式：[代词]+[感知确认动词]+[情绪名词]
- 示例："他感到恐惧"（直接告诉读者角色在恐惧，而非通过行为展现）
- 修复：删除感知动词+情绪名词，用具体行为替代

### 2. 先结论后证据
- 模式：在描写场景前先给出情绪定论
- 示例："空气中弥漫着紧张的气氛，只见..."
- 修复：直接呈现场景细节，让读者自己感受

### 3. 行为动机即时解释
- 模式：[行为]，因为[原因]
- 示例："她转身离开了，因为她不想再听下去"
- 修复：砍掉"因为"及后续解释，让行为悬置

### 4. 多余的感知确认
- 模式：[角色]看见了/听到了/感觉到了 + [具体事物]
- 示例："他看见了门口的那个人"
- 修复：直接写"门口有个人"

### 5. 情绪形容词堆叠
- 模式：大量抽象情绪形容词连续使用
- 示例："漫长的等待让他感到无比沉重"
- 修复：用具体细节让场景自行站立

### 6. 过渡句
- 模式："就在这时"、"与此同时"、"事情发生了转折"
- 修复：删除过渡句，让事件直接发生

### 7. 模板化递进结构
- 模式："首先...其次...最后"
- 修复：使用自然的叙事流程

### 8. 过度解释
- 模式："这意味着..."
- 修复：删除解释，让读者自己理解

### 9. 情绪通过身体反应（正面示例，正确做法）
- 用身体反应暗示情绪：心跳加速、呼吸急促、肌肉紧绷
- 用动作暗示而非直接命名情绪

### 10. 否定定义链
- 模式："不是A，不是B，是C"
- 风险：用无意义否定铺垫制造所谓悬念，真人作者通常直接写有效信息和人物反应
- 修复：删除A/B，直接写C如何改变场面、人物判断或行动

### 11. 空泛机器比喻
- 模式："指示灯/屏幕/设备像野兽眼睛/鬼火"
- 风险：比喻只负责装饰，不改变风险、人物或信息判断
- 修复：写设备状态对人物行动、气氛或信息推进的实际影响

### 12. 每句功能审计
- 每句话必须命中：推进情节、埋伏笔、体现性格、制造冲突、承载情绪转折之一
- 如果删除一句后信息和情绪都不损失，应判定为 AI 腔废句

${buildHumanPurposeWritingRulesBlock({ includeProtagonistAgencyRules: true })}

## 输出格式
请返回 JSON 格式的检测结果：
{
  "hasLLMDetection": true/false,
  "llmDetections": [
    {
      "type": "检测到的AI腔类型",
      "description": "具体描述",
      "severity": "high/medium/low",
      "suggestion": "修复建议"
    }
  ],
  "overallAssessment": "整体评估"
}

请直接返回 JSON，不要有其他内容。`;

  const userPromptParts: string[] = [];

  if (options?.outlineContent) {
    userPromptParts.push(`## 本章大纲内容（必须与以下目标对齐）\n${options.outlineContent}`);
  }

  if (options?.currentChapterEvents?.length) {
    userPromptParts.push(`## 本章事件列表\n${options.currentChapterEvents.join("\n")}`);
  }

  // 必须把章节结尾纳入检测窗口：若只截前 4000 字，LLM 看不到结尾，
  // 会幻觉出"断句残缺/拼接痕迹"并误判为文本残缺，触发 anti_ai_llm_residue 阻断。
  // 通用策略：短文本全量送；超长文本送头部 + 尾部，保证结尾始终可见。
  userPromptParts.push(`## 待检测文本\n${buildAntiAILLMDetectionTextWindow(text)}`);

  userPromptParts.push(`注意：
1. 前三句是最高风险区域，特别关注是否有情绪命名、感知确认动词
2. 检查是否有"因为...所以..."模式解释角色动机
3. 检查是否有模板化过渡句
4. 评估情绪表达是否通过身体反应而非直接命名
5. 检查是否有"不是A，不是B，是C"式否定定义链
6. 检查是否有设备/灯光/屏幕像野兽眼睛、鬼火等空泛机器比喻
7. 做每句功能审计：无目的句子即使语言顺滑也要标记
8. 额外检查主角是否被写成被动失败者，尤其禁止"身体僵硬"式偷懒表达；涉及能力、战斗、危机时必须有主动选择、风险判断或代价反思
${options?.outlineContent ? "\n9. 评估本章是否完成了大纲中规定的叙事目标" : ""}`);

  // P21新增：检查缓存
  // 缓存 key 必须用实际送检的窗口文本，否则窗口策略变更后仍会命中旧幻觉结果。
  const cache = getLLMCache();
  const antiAIModel = (await getAgentModelConfig("anti_ai_detector"))?.model || "anti_ai_detector";
  const detectionTextWindow = buildAntiAILLMDetectionTextWindow(text);
  const cacheKey = cache.generateCacheKey({
    stage: "anti_ai_detector",
    model: antiAIModel,
    prompt: systemPrompt,
    text: detectionTextWindow,
  });

  const cached = cache.get(cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached.content) as LLMEnhanceResult;
      const filteredDetections = filterHallucinatedTextTruncationDetections(text, parsed.llmDetections ?? []);
      return {
        hasLLMDetection: parsed.hasLLMDetection ?? (filteredDetections.length > 0),
        llmDetections: filteredDetections,
        overallAssessment: parsed.overallAssessment ?? "未检测到明显的 AI 腔",
        // 注意：缓存命中时标记 llmDetectionFailed: false，因为是已验证的结果
        llmDetectionFailed: false,
      };
    } catch {
      // 缓存内容损坏，忽略并继续
    }
  }
  try {
    const result = await new APIFallbackManager({ maxRetries: 1 }).callGPTWithFallback(
      "anti_ai_detector",
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPromptParts.join("\n\n") }
      ],
      {
        temperature: 0,
        max_tokens: 2048,
        responseFormat: { type: "json_object" },
      }
    );

    // JSON mode 返回纯 JSON，无需清理 markdown blocks
    const rawContent = result.response.content;
    let parsed: LLMEnhanceResult;
    try {
      parsed = JSON.parse(rawContent) as LLMEnhanceResult;
    } catch (parseError) {
      // P17修复: JSON mode 仍可能因第三方网关忽略而失败
      // 返回 llmDetectionFailed: true，让调用方走规则兜底或人工审核
      console.error("LLM 增强检测 JSON 解析失败:", parseError);
      return {
        hasLLMDetection: false,
        llmDetectionFailed: true,  // 标记检测失败，需要兜底
        llmDetections: [],
        overallAssessment: `LLM 增强检测解析失败: ${parseError instanceof Error ? parseError.message : "unknown error"}，请使用规则检测或人工审核`
      };
    }

    // P21新增：写入缓存
    cache.set(cacheKey, rawContent, {
      stage: "anti_ai_detector",
      model: antiAIModel,
      promptHash: cache.hashString(systemPrompt),
      textHash: cache.hashString(text),
    });

    const filteredDetections = filterHallucinatedTextTruncationDetections(text, parsed.llmDetections ?? []);
    return {
      hasLLMDetection: parsed.hasLLMDetection ?? (filteredDetections.length > 0),
      llmDetections: filteredDetections,
      overallAssessment: parsed.overallAssessment ?? "未检测到明显的 AI 腔"
    };
  } catch (error) {
    console.error(`[AntiAI] Routed LLM detection failed (${antiAIModel}):`, error);
    return {
      hasLLMDetection: false,
      llmDetectionFailed: true,  // P17修复: 标记检测失败，不要默认放行
      llmDetections: [],
      overallAssessment: `LLM 检测调用失败: ${error instanceof Error ? error.message : "unknown error"}，请使用规则检测或人工审核`
    };
  }
}
