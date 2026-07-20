/**
 * PiNovelStudio — ChineseNarrativeNaturalnessScanner
 *
 * 中文叙事自然感本地诊断器（软诊断）。
 * 职责：用本地启发式正则扫描章节正文，统计"英文感/翻译腔/说明文腔/AI 总结腔"
 * 高频出戏点的密度与命中，输出结构化 findings 与 riskLevel。
 *
 * 规范来源：chinese-narrative-naturalness 历史文档（第 4.1-4.10 节出戏点 + 第 6 节密度自检表，文档已删除）。
 *
 * 重要边界：
 * - 本扫描器是**软诊断**，不等于 P22 validated rule。
 * - validated runtime rules 只能通过 replay 晋级（见 data/runtime/validated-craft-rules.json
 *   与 scripts/learning/promote_validated_rules.py）；本扫描器**不写**任何 runtime 规则文件。
 * - 本扫描器**不调用 LLM**，**不修改正文**，**不写文件**，只返回诊断结果。
 * - 不在 Stage 8 形成 hard-block；medium 仅标记 needsHumanReview，high 才由调用方发 review 信号降为候选草稿。
 *
 * 风险阈值依据 chinese-narrative-naturalness 历史文档第 6 节（按每 3000 中文字统计，文档已删除）：
 *   temporalClause:        0-2 low / 3-5 medium / 6+ high
 *   logicalConnector:      0-3 low / 4-8 medium / 9+ high
 *   psychologyExplanation: 0-5 low / 6-12 medium / 13+ high
 *   abstractSubject:       0-3 low / 4-8 medium / 9+ high
 *   performativeDialogueTag: 偶发 low / 多处 medium / 抢戏 high
 */

export interface ChineseNarrativeNaturalnessFinding {
  /** 命中类型，对应 docs 第 4.1-4.10 节出戏点 + P32 6类 + P33 六大类翻译腔 */
  type:
    | "temporal_clause"
    | "logical_connector"
    | "psychology_explanation"
    | "abstract_subject"
    | "performative_dialogue_tag"
    | "modifier_stack"
    | "pov_leak"
    | "golden_sentence"
    // P32 新增：英文翻译腔母语语感诊断（docs §4.19-§4.24）
    | "nonhuman_subject_action"
    | "english_fragment_clause"
    | "quantified_camera_beat"
    | "bureaucratic_noun_phrase"
    | "mechanism_overexplanation"
    | "overwritten_sensory_phrase"
    // P33 新增：六大类翻译腔深度诊断（用户反馈第17章问题）
    | "fragment_paragraph"           // 一、短句断裂与独句成段（西式节奏）
    | "action_noun_subject"          // 二、动作/事物名词作主语（物称优先）
    | "postpositive_modifier"        // 三、定语后置与语序颠倒
    | "western_action_breakdown"     // 四、动作西式拆解与生硬通感
    | "narrator_judgment"            // 五、叙事旁白直白议论（上帝视角评断）
    | "western_dialogue"             // 六、西式对话与指代生硬
    // P42 新增：中文母语镜头治理（用户 2026-07-07 任务规格书）
    | "abstract_sensory_actor"       // 抽象感官名词做主动作（冷空气裹着柴油味钻进领口）
    | "translated_collocation"       // 翻译腔硬搭配（阳光砸在脸上 / 目光劈下来）
    | "mechanical_measurement"       // 机械量化关系（松了半分 / 短了半寸 / 退了半步）
    | "hard_synesthesia_verb";       // 硬通感动词（声音拽断 / 视线切碎 / 寒意咬住）
  /** 命中处的上下文片段（命中词 + 前后少量字符） */
  text: string;
  /** 命中在原文中的字符偏移 */
  index: number;
  /** 修订建议（中文，简短） */
  suggestion: string;
  /** 严重程度：用于分层处理 */
  severity?: "high" | "medium" | "low";
}

export type ChineseNarrativeNaturalnessRiskLevel = "low" | "medium" | "high";

export interface ChineseNarrativeNaturalnessScanResult {
  /** 时间容器句密度（每 3000 字）：当……的时候/在……的瞬间/的一刻/那一刹那/与此同时 */
  temporalClauseDensity: number;
  /** 逻辑连接词密度（每 3000 字）：然而/因此/于是/事实上/显然/毫无疑问/换句话说/也就是说 等 */
  logicalConnectorDensity: number;
  /** 心理解释密度（每 3000 字）：感到/意识到/明白/发现/内心深处/难以言喻 */
  psychologyExplanationDensity: number;
  /** 抽象物主语主动动作密度（每 3000 字）：沉默笼罩/恐惧攫住/不安蔓延/空气凝固/夜色吞没 等 */
  abstractSubjectDensity: number;
  /** 表演化对话标签密度（每 3000 字）：呢喃道/低语道/反驳道/咆哮道/苦涩地/意味深长地 等 */
  performativeDialogueTagDensity: number;
  /** 长定语/"的"字堆叠命中（每句"的">3 视为长定语） */
  modifierStackFindings: ChineseNarrativeNaturalnessFinding[];
  /** 视角越界疑似句：他不知道的是/殊不知/真正的危险/命运的齿轮/这将成为 等 */
  povLeakFindings: ChineseNarrativeNaturalnessFinding[];
  /** 段尾金句疑似句：有些人/有些事/命运/成长/再也回不去/从此以后 等 */
  goldenSentenceFindings: ChineseNarrativeNaturalnessFinding[];
  /**
   * P32 新增：英文翻译腔母语语感命中（聚合 6 类）。
   * - nonhuman_subject_action：非人主语动作化（低吼撞进耳朵/硝烟味呛上来/眼神停了半秒）
   * - english_fragment_clause：英文式短碎后置（客气，却隔着一层/下面有东西，大的）
   * - quantified_camera_beat：量化镜头（近了半步/停了半秒）
   * - bureaucratic_noun_phrase：任务/报告腔名词串（青鱼嘴，水域采样）
   * - mechanism_overexplanation：机制解释过度（在心里推开那道空间的门——短距瞬移）
   * - overwritten_sensory_phrase：感官描写用力过猛（腥气黏在鼻腔里）
   */
  nativeSyntaxFindings: ChineseNarrativeNaturalnessFinding[];
  /**
   * P33 新增：六大类翻译腔深度诊断命中（用户反馈第17章问题）
   */
  p33TranslationToneFindings: {
    /** 一、短句断裂独句成段（迟疑了半拍。/它要显了。/意念一动。/一击，毙命。连续2+处） */
    fragmentParagraphFindings: ChineseNarrativeNaturalnessFinding[];
    /** 二、动作/事物名词作主语（虫卵刮取顺利/空间在收窄/价码已经开出来了） */
    actionNounSubjectFindings: ChineseNarrativeNaturalnessFinding[];
    /** 三、定语后置与语序颠倒（下面有东西，大的/指尖蹭过鳞片微凉的边缘） */
    postpositiveModifierFindings: ChineseNarrativeNaturalnessFinding[];
    /** 四、动作西式拆解与生硬通感（低吼撞进耳朵/阳光劈头砸下来/瞳孔松了下来） */
    westernActionBreakdownFindings: ChineseNarrativeNaturalnessFinding[];
    /** 五、叙事旁白直白议论（客气，却隔着一层/位置要变了/疑惑把危险推前） */
    narratorJudgmentFindings: ChineseNarrativeNaturalnessFinding[];
    /** 六、西式对话与指代生硬（角色名尖声/声音抖/你那段/不是一路了） */
    westernDialogueFindings: ChineseNarrativeNaturalnessFinding[];
  };
  /** 综合风险等级 */
  riskLevel: ChineseNarrativeNaturalnessRiskLevel;
  /** 所有命中汇总（带 type/text/index/suggestion），按 index 升序 */
  findings: ChineseNarrativeNaturalnessFinding[];
  /** 中文诊断摘要 */
  summary: string;
}

/**
 * P33 新增：中文自然感千字密度评分结果。
 *
 * 用于 Stage 2 事件级硬门禁：按"翻译腔/英文味命中数 ÷ 千字"计算密度，
 * 给出 pass / repair / block 三档判定。
 *
 * 阈值（docs 第 6 节 + P33 用户反馈第17章问题收敛）：
 *   - < 3 处/千字：pass（优质母语）
 *   - 3-8 处/千字：repair（合格边缘，需局部修补）
 *   - > 8 处/千字：block（不合格，必须重写）
 *
 * 严重短路：3+ 连续独句成段（fragment_paragraph）即使密度低也直接 block。
 */
export interface ChineseNaturalnessDensityScore {
  /** 翻译腔/英文味命中总数（含 P32 nativeSyntax + P33 六大类） */
  totalHits: number;
  /** 章节字符数 */
  charCount: number;
  /** 千字密度（hits / charCount * 1000），charCount < 200 时返回 0 */
  densityPerThousand: number;
  /** 判定：pass / repair / block */
  verdict: "pass" | "repair" | "block";
  /** 严重短路标记：3+ 连续独句成段等结构性问题 */
  hasStructuralShortCircuit: boolean;
  /** 分类型计数（用于 trace） */
  byType: Record<string, number>;
  /** 判定理由（中文） */
  reason: string;
}

/** 用于评估文本字符数是否达到密度统计意义的最小阈值 */
const MIN_DENSITY_CHARS = 600;
/** 密度归一化基准（每 N 字） */
const DENSITY_BASE = 3000;
/** P33 千字密度评估的最小文本长度（短于该值不计算密度，直接判 pass） */
const DENSITY_SCORE_MIN_CHARS = 200;

/**
 * 按每 3000 字归一化的密度。
 * 短文本（< MIN_DENSITY_CHARS）返回 0，避免少量命中被归一化放大成误报。
 */
function normalizeDensity(count: number, charCount: number): number {
  if (charCount < MIN_DENSITY_CHARS) {
    return 0;
  }
  return Math.round((count / charCount) * DENSITY_BASE * 100) / 100;
}

interface PatternSpec {
  type: ChineseNarrativeNaturalnessFinding["type"];
  pattern: RegExp;
  suggestion: string;
}

/** 时间容器句（docs 4.1） */
const TEMPORAL_PATTERNS: PatternSpec[] = [
  { type: "temporal_clause", pattern: /当[^。！？\n]{0,30}?的时候/gu, suggestion: "按动作发生顺序拆开，少用'当……的时候'。" },
  { type: "temporal_clause", pattern: /在[^。！？\n]{0,30}?的瞬间/gu, suggestion: "让动作自然前后发生，少用'在……的瞬间'。" },
  { type: "temporal_clause", pattern: /[^。！？\n，；]{0,12}的一刻/gu, suggestion: "按动作顺序直写，少用'……的一刻'时间容器。" },
  { type: "temporal_clause", pattern: /那一刹那/gu, suggestion: "用具体动作或身体反应替代'那一刹那'。" },
  { type: "temporal_clause", pattern: /与此同时/gu, suggestion: "靠场景切换或动作顺承体现同时发生，删掉'与此同时'。" },
];

/** 逻辑连接词过载（docs 4.4） */
const LOGICAL_CONNECTOR_PATTERNS: PatternSpec[] = [
  { type: "logical_connector", pattern: /然而/gu, suggestion: "转折靠后一句形成，删掉'然而'。" },
  { type: "logical_connector", pattern: /因此/gu, suggestion: "因果靠动作看出，删掉'因此'。" },
  { type: "logical_connector", pattern: /于是/gu, suggestion: "让动作顺承表达承接，少用'于是'。" },
  { type: "logical_connector", pattern: /事实上/gu, suggestion: "不要用论述词，让事件自己呈现。" },
  { type: "logical_connector", pattern: /显然/gu, suggestion: "删掉'显然'，用细节让读者自己看出。" },
  { type: "logical_connector", pattern: /毫无疑问/gu, suggestion: "删掉'毫无疑问'，避免论述腔。" },
  { type: "logical_connector", pattern: /换句话说/gu, suggestion: "删掉'换句话说'，不要替读者整理逻辑。" },
  { type: "logical_connector", pattern: /也就是说/gu, suggestion: "删掉'也就是说'，避免说明文腔。" },
  { type: "logical_connector", pattern: /更重要的是/gu, suggestion: "删掉'更重要的是'，让事件自己排序。" },
];

/** 心理活动被直接解释（docs 4.3） */
const PSYCHOLOGY_PATTERNS: PatternSpec[] = [
  { type: "psychology_explanation", pattern: /感到/gu, suggestion: "把心理判断改成动作、停顿、异常，少用'感到'。" },
  { type: "psychology_explanation", pattern: /意识到/gu, suggestion: "用动作或反应露出'意识到'，不要直接说破。" },
  { type: "psychology_explanation", pattern: /内心深处/gu, suggestion: "删掉'内心深处'，用可见行为呈现心理。" },
  { type: "psychology_explanation", pattern: /难以言喻/gu, suggestion: "删掉'难以言喻'，写具体的身体反应或动作。" },
  { type: "psychology_explanation", pattern: /[他她它][^。！？\n]{0,8}?(?:明白|发现)/gu, suggestion: "让读者从动作里读出'明白/发现'，不要叙述者下结论。" },
];

/** 抽象物/环境/情绪当主语（docs 4.2） */
const ABSTRACT_SUBJECT_PATTERNS: PatternSpec[] = [
  { type: "abstract_subject", pattern: /(?:沉默|恐惧|不安|夜色|月光|光线|空气|寒意|寂静|黑暗|疲惫|紧张|绝望|孤独|哀伤|怒意|杀意|凉意)(?:笼罩|攫住|蔓延|吞没|切开|凝固|涌上|袭来|爬上|弥漫)/gu, suggestion: "把抽象主语改成人物动作、身体反应或可见细节。" },
];

/** 对话标签过度表演化（docs 4.5） */
const DIALOGUE_TAG_PATTERNS: PatternSpec[] = [
  { type: "performative_dialogue_tag", pattern: /(?:呢喃|低语|反驳|咆哮|嘶吼|冷笑|叹息|嘟囔|嘀咕)道/gu, suggestion: "用'说/问/喊'即可，情绪用动作补。" },
  { type: "performative_dialogue_tag", pattern: /(?:苦涩|若有所思|意味深长|颤抖着声音|颤声道)地?(?:说|道|问|笑)?/gu, suggestion: "删掉表演化副词标签，情绪靠动作体现。" },
];

/** 视角漂移（docs 4.9） */
const POV_LEAK_PATTERNS: PatternSpec[] = [
  { type: "pov_leak", pattern: /他不知道的是/gu, suggestion: "只写视角人物能感知到的异常，删掉'他不知道的是'。" },
  { type: "pov_leak", pattern: /她没有(?:意识|发现)到/gu, suggestion: "改成视角人物能感知的异常，不要上帝视角。" },
  { type: "pov_leak", pattern: /殊不知/gu, suggestion: "删掉'殊不知'，保持限知视角。" },
  { type: "pov_leak", pattern: /真正的危险/gu, suggestion: "用可见的异常信号替代'真正的危险'预告。" },
  { type: "pov_leak", pattern: /命运的齿轮/gu, suggestion: "删掉'命运的齿轮'，落在具体动作或物件上。" },
  { type: "pov_leak", pattern: /这将成为/gu, suggestion: "删掉'这将成为……的开始'类预告。" },
];

/** 金句收尾冲动（docs 5.4） */
const GOLDEN_SENTENCE_PATTERNS: PatternSpec[] = [
  { type: "golden_sentence", pattern: /有些人(?:一旦|就是|,|，)/gu, suggestion: "段尾落在动作或物件，删掉'有些人……'金句。" },
  { type: "golden_sentence", pattern: /有些事/gu, suggestion: "删掉'有些事'类情绪总结。" },
  { type: "golden_sentence", pattern: /命运的齿轮/gu, suggestion: "删掉'命运的齿轮'金句收尾。" },
  { type: "golden_sentence", pattern: /所谓成长/gu, suggestion: "删掉'所谓成长'类总结，用未解释的后果收尾。" },
  { type: "golden_sentence", pattern: /再也回不去/gu, suggestion: "用具体动作或物件收尾，删掉'再也回不去'。" },
  { type: "golden_sentence", pattern: /从此以后/gu, suggestion: "删掉'从此以后'总结腔，落在当下动作。" },
];

// ============================================================================
// P32 新增：英文翻译腔母语语感诊断（docs §4.19-§4.24）
//
// 6 类英文味出戏点，对应用户列出的第17章失败样例。这些类型与上面的 density 类
// 不同：它们是"母语语感"层面的英文翻译腔，不是 AI 总结腔。命中后用绝对计数
// 判风险（≥5 medium / ≥10 high），不归一化——因为单章出现 5 处英文翻译腔已
// 明显影响母语阅读体验，与章节长度无关。
// ============================================================================

/**
 * 非人主语动作化（docs §4.19）。
 * 把本该由人感知的动作强加给非人名词（声音/眼神/低吼/硝烟味/腥气等），
 * 如"低吼撞进耳朵""硝烟味呛上来""眼神停了半秒""声音发紧"。
 *
 * 与 abstract_subject（docs §4.2）的区别：
 * - abstract_subject 是抽象情绪/环境当主语（沉默笼罩/恐惧攫住）——更偏 AI 总结腔
 * - nonhuman_subject_action 是具体非人名词做人专属动作（撞/呛/停/发紧）——更偏英文翻译腔
 *
 * 负例验证："林子里响起了低吼声" 不应命中——"低吼声"是名词作宾语，"响起"是动词，
 * 匹配模式要求"低吼"+动作动词相邻，"低吼声"中间有"声"断开匹配。
 */
const NONHUMAN_SUBJECT_ACTION_PATTERNS: PatternSpec[] = [
  { type: "nonhuman_subject_action", pattern: /(?:声音|眼神|目光|低吼|咆哮|嘶吼|硝烟味|腥气|血腥味|寒意|杀意|凉意|话音|尾音|脚步声?|呼吸|心跳|沉默|寂静|寒气|热浪|冷意|阴影|深绿|黑暗|夜色|紧张感|压迫感|恐惧感|不安感|虚脱感|无力感|疲惫感|危机感|危险|冲突|判断|预感)[^。！？\n]{0,3}(?:撞进|撞上|撞来|呛上|呛来|钻进|钻入|爬上|爬进|缠住|缠上|缠进|停在|停了|发紧|收紧|刺入|刺进|扎进|嵌入|黏在|贴在|压在|涌上|涌进|袭来|扑来|扑上|灌进|渗进|渗入|侵入|顶上来|涌上来|漫上来|贴到|落下来|吞掉|泼进|切碎|拽断|糊成|贴住|压上来|漫过来|压回|压住)/gu, suggestion: "把非人主语改成人物感知：'低吼撞进耳朵'→'他听见低吼'，'硝烟味呛上来'→'他闻到硝烟味'，'紧张感又顶了上来'→'他又紧张起来'，'深绿吞掉光'→'脚下深绿把光吞了'。" },
  // P34 新增：X感抽象名词作主语 + 方向动词（紧张感顶上来/压迫感涌上来/恐惧感漫上来）
  { type: "nonhuman_subject_action", pattern: /(?:紧张感|压迫感|恐惧感|不安感|虚脱感|无力感|疲惫感|危机感|窒息感|眩晕感|存在感|孤寂感|悲凉感)[^。！？\n，；]{0,4}(?:顶上来|顶了上来|涌上来|涌了上来|漫上来|漫了上来|爬上来|爬了上来|升起来|升了上来|压下来|压了下来|落下来|袭来|袭了上来|涌回)/gu, suggestion: "'X感+方向动词'是西式抽象主语动作化：'紧张感又顶了上来'→'他又紧张起来'或'心里又是一紧'，把抽象名词改成人物心理或身体反应。" },
  // P34 新增：抽象概念/判断/冲突作施动者主动靠近（新的冲突贴到眼前/这个判断落下来）
  { type: "nonhuman_subject_action", pattern: /(?:新的冲突|新的局面|新的变化|这个判断|这个结论|这个预感|这件事|这话|那话)[^。！？\n，；]{0,4}(?:贴到眼前|贴上前来|逼近|压下来|落下来|砸下来|扑过来|顶上来)/gu, suggestion: "抽象概念作施动者主动靠近是西式表达：'新的冲突已经贴到眼前'→'新的冲突已经逼到眼前'或改用人物视角'他知道新的冲突已经到了眼前'；'这个判断落下来'→'他作出这个判断'。" },
  // P34 新增：颜色/光影+吞掉/吃掉/喝掉（脚下深绿一寸寸吞掉光）
  { type: "nonhuman_subject_action", pattern: /(?:深绿|深黑|暗红|墨黑|暗绿|黑暗|阴影|夜色|雾气|水色)[^。！？\n，；]{0,5}(?:吞掉|吃掉|喝掉|吞没|淹没|吞噬|吞进)/gu, suggestion: "颜色/光影+吞掉是西式抽象主语动作化：'脚下的深绿一寸寸吞掉光'→'脚下的深绿把光一点点吞掉'或'光被脚下的深绿一点点吞了'，把抽象颜色改成具体动作或用'把'字句。" },
];

/**
 * 英文式短碎后置（docs §4.20）。
 * 英文翻译腔的典型句法：把修饰成分后置成独立短句，如"客气，却隔着一层"
 * "下面有东西，大的"。中文母语习惯是前置修饰（"大的东西"）或合并成一句。
 */
const ENGLISH_FRAGMENT_PATTERNS: PatternSpec[] = [
  // "客气，却隔着一层" —— 短形容/短语 + 却 + 后置修饰动词
  { type: "english_fragment_clause", pattern: /[，。！？\n][^。！？\n，；]{1,6}，却(?:隔着|带着|透着|藏着|含着|裹着|压着|噙着|裹了|透出|带着|藏着)[^。！？\n]{0,8}[。！？\n]/gu, suggestion: "把后置修饰合并到主句：'客气，却隔着一层'→'客气里隔着一层'或'客气，但隔着距离'。" },
  // "下面有东西，大的" —— 存在句 + 后置量化修饰
  { type: "english_fragment_clause", pattern: /(?:有|是|没|看到|发现|听见|闻到|察觉)[^。！？\n，；]{1,8}，(?:大|小|不对|要命|厉害|严重|危险|不简单|不寻常)的?[。！？\n]/gu, suggestion: "把后置修饰前置：'有东西，大的'→'有个大的东西'，'不对'→合并到主句。" },
  // "往深里走的那圈，不对。" —— 名词短语 + ，+ 短评估（不对/不行/不对劲）
  // 仅匹配 3-12 字名词短语（含"的+指示词+量词"名词化标记），避免误报口语短句
  // 允许"的那圈/这回事/那种事"等"的+(那|这|此)?+量词"结构
  { type: "english_fragment_clause", pattern: /[^。！？\n，；]{3,12}的(?:那|这|此)?(?:圈|事|处|人|地|方|种|样|回|次|趟|路|边|头|件|笔|摊|档|茬)，(?:不对|不行|不对劲|不好|不对头)[。！？\n]/gu, suggestion: "把后置评估合并：'走的那圈，不对'→'走的那圈不对'或'那圈往深里走的，不对劲'。" },
];

/**
 * 量化镜头（docs §4.21）。
 * 用精确量化（半步/半秒/一寸）替代自然动作描写，是英文小说翻译腔的典型特征。
 * 如"近了半步""停了半秒"。中文母语更常用"凑近些""顿了顿"。
 */
const QUANTIFIED_CAMERA_PATTERNS: PatternSpec[] = [
  { type: "quantified_camera_beat", pattern: /(?:近了|停了|沉了|挪了|退了|偏了|动了|靠了|凑了|缩了|歪了|侧了|倾了|探了|挪近|移近|靠近|凑近|贴近|拉近)(?:半步|半秒|一寸|一分|几寸|几分|些许|半分|半点|一步|一秒|两步|几步|寸许|分许)/gu, suggestion: "量化镜头改自然动作：'近了半步'→'凑近些'，'停了半秒'→'顿了顿'或'愣了一下'。" },
];

/**
 * 任务/报告腔名词串（docs §4.22）。
 * 对白或叙述里出现"地点，XX采样""代号，XX任务"式名词串，像作战报告而非人物对话。
 * 如"青鱼嘴，水域采样"。
 */
const BUREAUCRATIC_NOUN_PHRASE_PATTERNS: PatternSpec[] = [
  // "，水域采样" / "，空气采样" 等
  { type: "bureaucratic_noun_phrase", pattern: /[，,][^。！？\n，;；]{0,4}(?:水域|空气|土壤|生物|能量|灵气|水质|环境|生态|地质|大气|植被)采样/gu, suggestion: "把报告腔名词串改成口语：'青鱼嘴，水域采样'→'去青鱼嘴采水样'。" },
  // "，侦察任务" / "，突击行动" 等
  { type: "bureaucratic_noun_phrase", pattern: /[，,][^。！？\n，;；]{0,4}(?:侦察|巡逻|警戒|突击|撤离|集结|支援|截击|封锁|搜救|清剿|渗透)(?:任务|行动|编队)/gu, suggestion: "把任务编号式名词串改成口语指令。" },
];

/**
 * 机制解释过度（docs §4.23）。
 * 用破折号引出机制术语解释，像游戏说明书而非叙事。如"在心里推开那道空间的门——短距瞬移"。
 */
const MECHANISM_OVEREXPLANATION_PATTERNS: PatternSpec[] = [
  // 心理/识海动作 + —— + 机制术语
  { type: "mechanism_overexplanation", pattern: /(?:在心里|识海里|脑海里|心念里|念头里|意识里|心念一动)[^。！？\n——]{0,14}——[^。！？\n]{0,14}(?:瞬移|传输|锚定|定位|锁定|解析|扫描|投射|灌注|链接|接入|切入|折叠|跃迁|共振|解码|编码|激活|触发|释放)/gu, suggestion: "删掉机制术语解释，让能力直接体现为动作结果：'推开空间的门——短距瞬移'→'人已挡在身前'。" },
  // 破折号 + 复合机制术语（独立检测，覆盖更多）
  { type: "mechanism_overexplanation", pattern: /——[^。！？\n]{0,8}(?:短距瞬移|空间折叠|能量灌注|灵力链接|识海投射|源力接入|维度切入|时空跃迁|序列解码|规则解析|权限激活|模组触发)/gu, suggestion: "破折号后的机制术语是游戏说明书腔，删掉让动作自己说话。" },
];

/**
 * 感官描写用力过猛（docs §4.24）。
 * 感官名词 + 强黏附动词 + 身体部位，像刻意营造氛围。如"腥气黏在鼻腔里"。
 */
const OVERWRITTEN_SENSORY_PATTERNS: PatternSpec[] = [
  { type: "overwritten_sensory_phrase", pattern: /(?:腥气|气味|味道|寒意|杀意|凉意|热浪|冷意|酸楚|血腥|硝烟味?|腐臭|恶臭)[，,]?[^。！？\n]{0,2}(?:黏在|缠在|嵌在|钻进|渗进|扎进|刺入|烙在|钉在|楔入|钉进|楔进|黏住|缠住|嵌住)(?:鼻腔|喉咙|肺里|骨头|皮肤|心里|胸腔|脑海|胃里|齿缝|喉头|肺腑|四肢)/gu, suggestion: "感官描写收着写：'腥气黏在鼻腔里'→'闻到一股腥气'，让感官自然出现而非强黏。" },
  // P34 新增：冷/热/疼/痛/麻+像一巴掌拍/扇/砸在脸上（西式直译比喻，用力过猛）
  { type: "overwritten_sensory_phrase", pattern: /(?:冷|热|疼|痛|麻|酸|凉|寒|暖)得像一(?:巴掌|拳|脚|掌)(?:拍|扇|砸|打|抽)在(?:脸|脸侧|脸上|身上|胸口|胸口上)/gu, suggestion: "感官比喻用力过猛偏西式直译：'冷得像一巴掌拍在脸上'→'冷得刺骨'或'冷得直打哆嗦'，用中文常用感官词替代'一巴掌拍脸'式直译比喻。" },
];

// ============================================================================
// P42 新增：中文母语镜头 4 类搭配诊断（用户 2026-07-07 任务规格书）
//
// 与现有 6 类英文翻译腔的差异：
// - nonhuman_subject_action：具体非人名词做人专属动作（撞/呛/停）——已覆盖"低吼撞进耳朵"
// - overwritten_sensory_phrase：感官名词+强黏附动词+身体部位——已覆盖"腥气黏在鼻腔里"
// - quantified_camera_beat：动作动词+量化单位——已覆盖"近了半步/停了半秒"
// - western_action_breakdown：声音/光线+强碰撞通感动词——已覆盖"阳光劈头砸下来"
//
// P42 4 类补齐用户样例的漏检：
// - abstract_sensory_actor：冷空气/腥气+裹着/钻进+领口（用户样例"冷空气裹着柴油味钻进领口"）
// - translated_collocation：光线/视线+砸/劈+脸上（用户样例"阳光砸在脸上"——要求带身体部位目标词）
// - mechanical_measurement：松了/紧了+半分/半寸（用户样例"手指松了半分"——补齐 quantified_camera_beat 缺失的"松了"等动词）
// - hard_synesthesia_verb：感官名词+物理破坏动词（用户样例"声音拽断"——补齐 western_action_breakdown 缺失的硬通感）
// ============================================================================

/**
 * P42 抽象感官名词做主动作（用户样例："冷空气裹着柴油味钻进领口" / "腥气裹着风往领口里钻"）。
 *
 * 与 overwritten_sensory_phrase 的区别：
 * - overwritten_sensory_phrase 要求感官名词 + 强黏附动词（黏在/缠在/嵌在）+ 身体部位
 * - abstract_sensory_actor 覆盖"裹着/钻进/灌进/贴着"等更宽的主动作动词 + 领口/脖颈/鼻腔类目标
 *
 * 命中样例：
 *   - 冷空气裹着柴油味钻进领口
 *   - 腥气裹着风往领口里钻
 *   - 寒气贴着脖颈往上爬
 */
const ABSTRACT_SENSORY_ACTOR_PATTERNS: PatternSpec[] = [
  { type: "abstract_sensory_actor", pattern: /(?:冷空气|冷风|寒气|腥气|血腥气|柴油味|烟味|潮气|湿气|热浪|夜风|山风)[^，。；！？\n]{0,10}(?:裹着|裹住|裹了|钻进|钻入|灌进|涌进|窜进|渗进|渗入|贴着|贴住|黏在|攀上|爬上|缠绕|攀附|钻到|灌入)[^，。；！？\n]{0,8}(?:领口|衣领|领口里|袖口|脖颈|脖子|喉咙|鼻腔|眉骨|脸颊|脸侧|皮肤|脊背|指缝|袖管|衣襟)/gu, suggestion: "「冷空气裹着柴油味钻进领口」式英文感官主语句。把感官写成主角身体反应：『他缩了下脖子，柴油味呛进喉咙』。" },
  // 腥气/寒气 + 裹着风 + 往领口里钻（用户第二样例变体）
  { type: "abstract_sensory_actor", pattern: /(?:腥气|寒气|冷风|夜风|山风)[^，。；！？\n]{0,6}裹着[^，。；！？\n]{0,4}风[^，。；！？\n]{0,6}(?:往|向)(?:领口|袖口|衣领|脖颈|领口里)(?:里|中)?(?:钻|灌|涌|窜|渗)/gu, suggestion: "「腥气裹着风往领口里钻」式英文感官主语句。改为人物身体反应：『腥气混着风灌进领口，他打了个寒噤』。" },
];

/**
 * P42 翻译腔硬搭配（用户样例："阳光砸在脸上" / "目光劈下来"）。
 *
 * 与 western_action_breakdown 的区别：
 * - western_action_breakdown 匹配"声音/光线 + 撞进/砸下/切碎"（不要求身体部位目标词）
 * - translated_collocation 要求"光线/视线 + 砸/劈/切 + 身体部位目标词"，更精准定位翻译腔硬搭配
 *
 * 命中样例：
 *   - 阳光砸在脸上
 *   - 目光劈下来砸在肩头
 *   - 寒意切在心口
 */
const TRANSLATED_COLLOCATION_PATTERNS: PatternSpec[] = [
  { type: "translated_collocation", pattern: /(?:阳光|日光|月光|灯光|灯火|视线|目光|寒意|杀意|怒意|声音|嗓音|噪音)[^，。；！？\n]{0,6}(?:砸|劈|切|割|拽断|撕裂|劈开|劈头|砸下来|砸在|劈在|切在|割在|砍在|钉在|烙在)(?:脸上|身上|头顶|肩头|脊背|心口|眉心|眼前|脸上|胸口|后背|脖颈)/gu, suggestion: "「阳光砸在脸上」式翻译腔硬搭配。改为母语动作或神态：『日头毒，他眯了下眼』；『目光落在他肩头』。" },
];

/**
 * P42 机械量化关系（用户样例："手指松了半分" / "短了半寸" / "退了半步"）。
 *
 * 与 quantified_camera_beat 的区别：
 * - quantified_camera_beat 动词表只有"近了/停了/沉了/挪了/退了/偏了/动了/靠了/凑了/缩了/歪了/侧了/倾了/探了"
 * - mechanical_measurement 补齐"松了/紧了/沉了/轻了/移了/抬了/压了/低了/高了/远了"等动词 + 量化单位
 *
 * 命中样例：
 *   - 手指松了半分
 *   - 短了半寸
 *   - 退了半步
 *   - 沉了半拍
 */
const MECHANICAL_MEASUREMENT_PATTERNS: PatternSpec[] = [
  // P42 修复（p35-t03 回归根因）：
  //   - 动词表移除「低了」：在母语中文里太常见（压低了/调低了/降低了），易误命中母语文本
  //   - 量化单位移除「一截」：与母语常用搭配冲突（短了一截/长了一截），且与上方
  //     QUANTIFIED_CAMERA_PATTERNS（L288）保持一致——该聚合已避开「一截」
  //   - 保留「半截」：半截在母语中较少见，更偏向翻译腔样例，可保留作为命中点
  //   验证：不影响 P42-T01 用户样例（"松了半分"用"松了"+"半分"、"短了半寸"用"短了"+"半寸"、
  //         "退了半步"用"退了"+"半步"，均不依赖"低了"或"一截"）
  { type: "mechanical_measurement", pattern: /(?:松了|紧了|沉了|轻了|移了|偏了|抬了|压了|高了|近了|远了|短了|长了|快了|慢了|硬了|软了|冷了|热了|退了|缩了|挪了|侧了|歪了|倾了|探了|停了|动了|靠了|凑了)[了得]?(?:半分|半寸|半步|半拍|半秒|几寸|几分|几步|几秒|小半寸|小半步|一寸|一分|一步|一秒|半截|寸许|分许)/gu, suggestion: "「松了半分」式机械量化。改为可见的状态变化或动作后果：『他手指一松，刀柄差点脱手』；『退了半步』→『退了一步』或用动作体现。" },
];

/**
 * P42 硬通感动词（用户样例："声音被拽断" / "视线切碎" / "寒意咬住"）。
 *
 * 与 western_action_breakdown 的区别：
 * - western_action_breakdown 已覆盖"切碎/割碎+在+表面"和"声音+被拽断+在半空"
 * - hard_synesthesia_verb 覆盖更宽的"感官名词 + 物理破坏动词"搭配（不要求"在+表面"或"被+动词"结构）
 *
 * 命中样例：
 *   - 声音拽断
 *   - 视线切碎
 *   - 寒意咬住脊背
 *   - 杀意刺穿
 */
const HARD_SYNESTHESIA_VERB_PATTERNS: PatternSpec[] = [
  { type: "hard_synesthesia_verb", pattern: /(?:声音|嗓音|话音|气息|寒意|杀意|怒意|视线|目光|气味|腥气|光影|阴影|夜色|寂静|沉默)[^，。；！？\n]{0,4}(?:拽断|撕裂|切碎|割断|咬住|咬断|撕开|撕碎|绞断|刺穿|刺破|劈开|劈断|割裂|绞碎|拧断|掐断)/gu, suggestion: "「声音被拽断」式硬通感。感官不能被物理破坏：『话音陡然止住』；『视线切碎』→『视线被截断』或用人物动作体现。" },
];

/** P42 新增 4 类中文母语镜头 patterns 聚合 */
const P42_COLLOCATION_PATTERNS: PatternSpec[] = [
  ...ABSTRACT_SENSORY_ACTOR_PATTERNS,
  ...TRANSLATED_COLLOCATION_PATTERNS,
  ...MECHANICAL_MEASUREMENT_PATTERNS,
  ...HARD_SYNESTHESIA_VERB_PATTERNS,
];

/** P42 新增类型优先级（用于与现有类型重叠时去重，数值越大优先级越高） */
const P42_TYPE_PRIORITY: Record<string, number> = {
  hard_synesthesia_verb: 5,
  translated_collocation: 4,
  abstract_sensory_actor: 3,
  mechanical_measurement: 2,
};

/**
 * P42 密度去重：同一字符区间内多类型重叠命中时，按优先级只保留最高优先级命中。
 *
 * 规则：
 * - 两个命中字符区间重叠（[start1, end1] ∩ [start2, end2] ≠ ∅）且都属于 P42 新类型 → 保留优先级高的
 * - P42 新类型与现有 nativeSyntax 类型重叠时，保留现有类型（避免破坏现有 density 行为）
 * - 不重叠的命中全部保留
 *
 * 简化实现：用命中 index 近似匹配区间起点，按 type 优先级排序后逐个加入，
 * 若新命中起点落在已保留命中的 [index, index+approxLen] 区间内则跳过。
 */
function dedupeP42OverlappingFindings(
  findings: ChineseNarrativeNaturalnessFinding[],
  matchLengths: Map<number, number>,
): ChineseNarrativeNaturalnessFinding[] {
  const result: ChineseNarrativeNaturalnessFinding[] = [];
  // 按 index 升序、P42 优先级降序排序
  const sorted = [...findings].sort((a, b) => {
    if (a.index !== b.index) return a.index - b.index;
    const pa = P42_TYPE_PRIORITY[a.type] ?? 0;
    const pb = P42_TYPE_PRIORITY[b.type] ?? 0;
    return pb - pa;
  });
  for (const f of sorted) {
    const len = matchLengths.get(f.index) ?? f.text.length;
    const fEnd = f.index + len;
    // 检查是否与已保留命中重叠
    const overlaps = result.some((r) => {
      const rLen = matchLengths.get(r.index) ?? r.text.length;
      const rEnd = r.index + rLen;
      return f.index < rEnd && fEnd > r.index;
    });
    if (!overlaps) {
      result.push(f);
    }
  }
  return result;
}

/** P32 新增 6 类英文翻译腔 patterns 聚合 */
const NATIVE_SYNTAX_PATTERNS: PatternSpec[] = [
  ...NONHUMAN_SUBJECT_ACTION_PATTERNS,
  ...ENGLISH_FRAGMENT_PATTERNS,
  ...QUANTIFIED_CAMERA_PATTERNS,
  ...BUREAUCRATIC_NOUN_PHRASE_PATTERNS,
  ...MECHANISM_OVEREXPLANATION_PATTERNS,
  ...OVERWRITTEN_SENSORY_PATTERNS,
  // P42 新增 4 类中文母语镜头 patterns
  ...P42_COLLOCATION_PATTERNS,
];

// ============================================================================
// P33 新增：六大类翻译腔深度诊断（用户反馈xinmo第17章问题）
//
// 豆包分析的6大类核心问题：
// 1. 短句断裂与独句成段（西式节奏生硬移植）
// 2. 抽象/事物主语（物称优先的西式逻辑）
// 3. 定语后置与语序颠倒（不符合中文修饰逻辑）
// 4. 动作与感官描写西式拆解与生硬通感
// 5. 叙事旁白直白议论（上帝视角评断感）
// 6. 对话与指代西式人际表达生硬
// ============================================================================

/**
 * 二、动作/事物名词作主语（物称优先西式逻辑）
 * 中文以"人"为核心主语；英文大量用动作名词/抽象概念/事物作主语。
 * 例：虫卵刮取顺利/空间在收窄/疑惑把危险推前/价码开出来了/车门合上的闷响里
 */
const ACTION_NOUN_SUBJECT_PATTERNS: PatternSpec[] = [
  // 动作名词+形容词/动词作谓语（刮取顺利/进展顺利/进行顺利）
  { type: "action_noun_subject", pattern: /(?:刮取|提取|采样|搜索|检查|调查|撤离|进攻|防守|突围|救援|谈判|交易|交接|部署|准备|行动|计划|方案|过程)[^。！？\n，；]{0,4}(?:顺利|成功|失败|受阻|中断|完成|结束|开始|继续)/gu, suggestion: "动作名词作主语是西式表达，改为'人'作主语：'虫卵刮取顺利'→'刮取虫卵的过程很顺利'或'顺利刮到了虫卵'。" },
  // 空间/时间/声响等非人名词发出主动动作（空间收窄/时间流逝/车门闷响里）
  { type: "action_noun_subject", pattern: /(?:空间|四周|周围|视野|光线|夜色|黑暗|沉默|寂静|时间|气氛|氛围)(?:在)?(?:收窄|收缩|压缩|变窄|流逝|凝固|凝结|绷紧|拉紧|沉下|沉下去)/gu, suggestion: "非人抽象名词作主语偏西式：'空间在收窄'→'四周越来越狭窄'；'气氛绷紧'→'众人都绷紧了神经'。" },
  // 抽象概念作施动者推动情节（疑惑/恐惧/不安推动危险）
  { type: "action_noun_subject", pattern: /(?:疑惑|恐惧|不安|紧张|犹豫|迟疑|好奇|愤怒|杀意|怒意|恨意|悔意)[^。！？\n，；]{0,6}(?:不是收束|把[^。！？\n]{0,8}推|把[^。！？\n]{0,8}拉|让[^。！？\n]{0,8}提前|让[^。！？\n]{0,8}靠近)/gu, suggestion: "抽象概念作施动者是西式议论：'疑惑把危险推前'→'他心里一沉，知道这点疑惑会引来更大麻烦'（改用人物视角和心理活动）。" },
  // 事物/价码作主语（价码开出来了/条件摆出来了）
  { type: "action_noun_subject", pattern: /(?:价码|条件|筹码|规矩|底牌|话|事|问题)[^。！？\n，；]{0,4}(?:已经|早已|刚刚)?(?:开出来|摆出来|说出来|抛出来|摊开|亮出|摆在那里)/gu, suggestion: "事物作主语弱化施动者偏西式：'价码开出来了'→'对方已经开出了条件'；'话撂在那里'→'他把话撂在那里'。" },
  // 声响场景切入状语（……的闷响里/……的声音中）
  { type: "action_noun_subject", pattern: /[^。！？\n]{2,10}(?:的闷响|的声响|的声音|的轰鸣|的震动|的震荡)[^。！？\n]{0,2}(?:里|中|间)，/gu, suggestion: "以声响场景作状语切入偏西式：'车门合上的闷响里，柴油机震着'→'车门闷声关上，柴油机震着底盘'（先说动作再补环境）。" },
];

/**
 * 三、定语后置与语序颠倒
 * 中文定语习惯前置；英文大量后置定语、定语从句。
 * 例：下面有东西，大的/你袖子里那道，亮了/指尖蹭过鳞片微凉的边缘/离岸三米那圈涟漪
 */
const POSTPOSITIVE_MODIFIER_PATTERNS: PatternSpec[] = [
  // 存在句+逗号+单字形容词后置（有东西，大的/有个人，高的）
  { type: "postpositive_modifier", pattern: /(?:有|见|看|发现|瞧见|望见|瞅见|瞥见)[^。！？\n，；]{0,6}(?:东西|人|影子|黑影|物件|家伙|玩意儿|动静|声响)，(?:大|小|高|矮|胖|瘦|长|短|粗|细|黑|白|红|不对|要命|厉害|危险)的?[。！？\n，]/gu, suggestion: "定语后置是英文句式：'有东西，大的'→'有个大家伙'，将修饰语前置到中心语前。" },
  // 多层定语顺序颠倒（微凉的边缘→微凉的鳞片边缘；微凉的是属性，应紧贴中心语）
  { type: "postpositive_modifier", pattern: /[^。！？\n，；]{0,4}(?:微凉|冰凉|冰冷|温热|滚烫|冰冷|锋利|锐利|粗糙|光滑|柔软|坚硬)[^。！？\n，；]{0,4}的(?:边缘|表面|表层|皮肤|外壳|鳞片|刀刃|指尖|手掌)/gu, suggestion: "多层定语顺序偏西式：'鳞片微凉的边缘'→'微凉的鳞片边缘'（属性定语紧贴中心语）。" },
  // 距离定语缺少"远/的"（离岸三米那圈→离岸三米远的那圈）
  { type: "postpositive_modifier", pattern: /(?:离岸|离他|离她|离我|离人|距岸|距他|距此|相距)[^。！？\n，；]{0,6}(?:米|步|丈|尺|寸|里|公里|厘米)(?:那圈|那道|那条|那个|那片|那团|那个)/gu, suggestion: "距离定语位置不当：'离岸三米那圈涟漪'→'离岸三米远的那圈涟漪'，加'远/的'符合中文语序。" },
  // 中心语省略导致定语悬空（你袖子里那道→那道鳞光）
  { type: "postpositive_modifier", pattern: /(?:袖子里|袖口|口袋里|手里|怀里|腰间|背后|身后|衣服上|身上|脸上)[^。！？\n，；]{0,4}那(?:道|个|团|片|缕|丝|点|抹|线|束)[^。！？\n，；]{0,4}，(?:亮|闪|动|抖|颤|跳|震|发烫|发凉|发亮|闪了|亮了)/gu, suggestion: "中心语被省略、定语悬空偏西式：'你袖子里那道，亮了'→'你袖子里那道鳞光，闪了一下'，补出中心语。" },
  // 状态定语拆分（软下去的手臂→已经软下来的手臂）
  { type: "postpositive_modifier", pattern: /(?:一截|一段|一只|一条|一个|一双)(?:软下去|硬起来|沉下去|浮上来|掉下来|抬起来|伸出去|缩回来)的(?:手臂|手|腿|脚|身体|胳膊|手腕)/gu, suggestion: "状态定语拆分偏西式：'一截软下去的手臂'→'一条已经软下来的手臂'，用'已经/了'体现状态完成。" },
];

/**
 * 四、动作与感官描写西式拆解与生硬通感
 * 英文用细碎分句拆解连续动作，非常规动词搭配制造通感；中文讲究动作连贯与动词精准适配。
 * 例：低吼撞进耳朵/惊叫只出了半截/气音递过去/阳光砸下来/眼皮抖着掀开/灯火切在脸上/瞳孔松了
 */
const WESTERN_ACTION_BREAKDOWN_PATTERNS: PatternSpec[] = [
  // 声音/光线+强碰撞通感动词（撞进/砸下/切在/劈头盖脸砸）
  { type: "western_action_breakdown", pattern: /(?:低吼|咆哮|嘶吼|惊叫|尖叫|声音|话音|枪声|炮声|爆炸声|阳光|光线|灯光|灯火|月光|霓虹|高架灯|车灯|整片光|那片光|这片光|一线光|一缕光)[^。！？\n，；]{0,4}(?:撞进|撞上|砸下|砸在|砸到|劈头砸下|切在|切过|划在|划过|钉在|烙在|楔入|劈头盖脸砸下来|切碎|割碎|泼进|灌进|倒进)/gu, suggestion: "强通感动词搭配偏西式：'低吼撞进耳朵'→'他听见低吼'；'阳光劈头砸下来'→'阳光劈头盖脸照下来'；'灯火切碎在玻璃上'→'灯火映在玻璃上'；'光泼进了夜里'→'光洒进夜色里'。" },
  // P34 新增：光线+切碎/割碎+在+表面（直接匹配动词+表面，不依赖前置光线名词）
  // 覆盖候选稿"高架灯...，橙的、白的，切碎在玻璃上"这种光线名词与动词被逗号隔开的情况
  { type: "western_action_breakdown", pattern: /(?:切碎|割碎)在(?:玻璃|镜面|水面|桌面|地面|墙上|脸颊|脸上)/gu, suggestion: "镜头感切割动词偏西式：'切碎在玻璃上'→'映在玻璃上'，光线用'映/照/扫'更符合中文，'切碎/割碎'是强碰撞动词。" },
  // P34 新增：光+泼进/灌进/倒进+容器（光泼进了夜里/光灌进窗户）
  { type: "western_action_breakdown", pattern: /(?:整片光|那片光|这片光|一线光|一缕光|光)泼进(?:了|入)?(?:夜里|夜色|窗户|屋内|房间|室内)/gu, suggestion: "光线+泼进+容器是西式容器化误用：'光泼进了夜里'→'光洒进夜色里'，光线用'洒/照/落'更自然，'泼'偏液体容器化。" },
  // P34 新增：声音+被动+拽断/扯断/掐断（声音被拽断在半空/话音被扯断）
  { type: "western_action_breakdown", pattern: /(?:声音|话音|吼声|惊叫|喊声|叫声|话|气音)[^。！？\n，；]{0,4}(?:被拽断|被扯断|被切断|被掐断|被截断|被吞没)[^。！？\n，；]{0,4}(?:在半空|在空中|在喉咙里|在嘴边)/gu, suggestion: "声音+被动+拽断是西式动作拆解：'声音被拽断在半空'→'刚喊出半声'或'话没说完就被打断'，去掉被动+强碰撞动词。" },
  // P34 新增：声音+糊成+名词化（声音全糊成一团闷响/喊声糊成一片）
  { type: "western_action_breakdown", pattern: /(?:声音|话音|吼声|喊声|叫声|响声)[^。！？\n，；]{0,4}(?:全?糊成一团|糊成一片|搅成一团|搅成一片|拧成一团)[^。！？\n，；]{0,4}(?:闷响|闷声|杂音|回响|混响)/gu, suggestion: "声音+糊成+名词化是西式感官拆解：'声音全糊成一团闷响'→'喊声隔着水闷成一片'或'声音混在一起听不清'，去掉'糊成一团'强黏通感。" },
  // 动作碎片化拆解（惊叫只出了半截/话说了一半/气音递过去）
  { type: "western_action_breakdown", pattern: /(?:惊叫|尖叫|喊声|声音|话|气音|话音)[^。！？\n，；]{0,4}(?:只出了半截|只喊了一半|只说了一半|只发了半截|没喊完|没说完|没出口|卡在喉咙里|贴着面罩递过去)[^。！？\n，；]{0,6}/gu, suggestion: "动作碎片化拆解偏西式：'惊叫只出了半截'→'刚发出半声惊叫'；'气音贴着面罩递过去'→'隔着面罩吐出短促的气声'。" },
  // 生理动作西式拆解（眼皮抖着掀开/嘴唇颤着张开/手指抖着抬起）
  { type: "western_action_breakdown", pattern: /(?:眼皮|嘴唇|手指|手指尖|嘴角|肩膀|身体)[^。！？\n，；]{0,4}(?:抖着|颤着|哆嗦着|颤抖着)(?:掀开|张开|抬起|举起|伸开|张开|睁开|打开)/gu, suggestion: "动作拆解成'抖着XX'是西式分词结构直译：'眼皮抖着掀开'→'眼皮颤了颤，缓缓睁开'，拆成连贯动作更符合中文。" },
  // 生理描写不符合中文习惯（瞳孔松了下来/眼神松了/肌肉松了）
  { type: "western_action_breakdown", pattern: /(?:瞳孔|眼神|目光|肌肉|神经|心弦)[^。！？\n，；]{0,4}(?:松了下来|松下来|松弛下来|放松下来|松了)/gu, suggestion: "生理描写不符合中文习惯：'瞳孔松了下来'→'眼神一滞'或'瞳孔骤然一缩'（中文更常用骤然收缩表达紧张变化）。" },
  // 光/影+切割类动词（一格格切/一刀刀割）
  { type: "western_action_breakdown", pattern: /(?:灯火|灯光|光线|月光|阳光|阴影|影子)[^。！？\n，；]{0,4}(?:一格格|一刀刀|一寸寸|一道道)(?:切|割|划|劈|砍)(?:在|过|到)/gu, suggestion: "镜头感切割动词偏西式：'灯火一格格切在脸上'→'灯火一格格扫过他的脸'，用'扫/映/照'更符合中文。" },
];

/**
 * 五、叙事旁白直白议论（上帝视角评断感）
 * 中文讲究"藏而不露"把判断融入情节；英文常插入旁白式议论直接下结论。
 * 例：客气，却隔着一层/疑惑不是收束而是推危险/从今天起位置要变了
 */
const NARRATOR_JUDGMENT_PATTERNS: PatternSpec[] = [
  // 直接态度判断短评（客气，却隔着一层/近，却远在天边）
  { type: "narrator_judgment", pattern: /(?:^|[。！？\n])(?:客气|亲近|热情|冷淡|疏远|陌生|熟悉|平静|镇定|紧张|不安)[^。！？\n，；]{0,2}，却(?:隔着一层|隔着距离|带着疏离|透着生分|藏着戒备|含着敌意|压着情绪)/gu, suggestion: "旁白直接下判断偏西式：'客气，却隔着一层'→'客气是客气，却总带着几分疏离'，将判断融入状态描写。" },
  // 情节预判式议论（不是…而是…把危险推前/这只是开始/后面更危险）
  { type: "narrator_judgment", pattern: /(?:没想到|他不知道|他没意识到|殊不知)[^。！？\n]{0,20}(?:不是[^。！？\n]{0,8}而是|反而|反倒|竟是|竟然|却把|却让|却将)[^。！？\n]{0,12}(?:危险|麻烦|危机|灾祸|问题|变故|转折)/gu, suggestion: "上帝视角情节预判偏西式：'疑惑不是收束而是推危险'→'他心里一沉，知道这点疑惑非但没消，反倒会引来更大麻烦'（改用人物心理活动）。" },
  // 命运/位置变化直白宣告（位置要变了/命运要改写了/从此不一样了）
  { type: "narrator_judgment", pattern: /(?:从今天起|从这一刻起|从此|自此|从这之后|经此一役|经此一事)[^。！？\n，；]{0,10}(?:位置|地位|身份|命运|关系|一切|局面|形势)[^。！？\n，；]{0,6}(?:要变了|会改变|将改写|不一样了|不同了)/gu, suggestion: "直白命运预判式议论偏西式：'他在队伍里的位置要变了'→通过人物心理或他人反应侧面传递，不要由叙述者直接宣告。" },
  // 段尾议论总结（这就是…/这便是…/这就是所谓的…）
  { type: "narrator_judgment", pattern: /(?:这就是|这便是|这才是|这就是所谓|这便是真正的|这才是真正的)[^。！？\n]{0,15}[。！？\n]/gu, suggestion: "段尾总结式议论偏说教，改为通过动作或物件收尾，让读者自己体会。" },
];

/**
 * 六、西式对话与指代生硬
 * 中文人际对话、指代更含蓄具象；英文口语表达与指代习惯直译后显得生硬。
 * 例：角色名尖声/声音抖/你那段/是要有人签字担责的/眼神不是一路了
 */
const WESTERN_DIALOGUE_PATTERNS: PatternSpec[] = [
  // 名词直接动用的对话标签（尖声/厉声/颤声/冷声+逗号直接对话，缺"说/道/喊/叫"）
  // 角色名用通用角色占位（队长/老张/小张/他/她），避免绑定具体小说角色
  // P34：兼容中文弯引号 “” （U+201C/U+201D），不再只匹配 「」『』 与直引号 "
  { type: "western_dialogue", pattern: /[」』"\u201D][，,]\s*(?:队长|组长|组员|老[张王李赵]|小[张王李赵]|某[甲乙丙]|他|她)[^。！？\n，；]{0,4}?(?:尖声|厉声|颤声|冷声|怒声|轻声|低声|高声|哑声|沉声)[，,]\s*[「『"\u201C]/gu, suggestion: "名词直接动用作对话标签是英文名词动用直译：'某角色尖声，「XXX」'→'某角色尖声喊道：「XXX」'，补全'说/道/喊/叫'动词。" },
  // "声音抖"式过度省略（声音抖/手颤/脸白）
  { type: "western_dialogue", pattern: /[」』"\u201D][，,]\s*[^。！？\n，；]{0,8}?(?:声音抖|声音发颤|手在抖|手在颤|脸发白|脸煞白|腿发软|脚发软)[，。！？\n]/gu, suggestion: "对话标签过度省略偏西式简洁：'声音抖'→'声音发颤'；'手在抖'→'手微微发颤'，补全状态表达更自然。" },
  // 模糊指代（你那段/你那部分/这茬/这事/那事）
  { type: "western_dialogue", pattern: /[「『"\u201C][^」』"\u201D]{0,20}(?:你那段|你那部分|你这块|这茬|这事|那事|这档子|那档子|这摊|那摊)[^」』"\u201D]{0,20}[」』"\u201D]/gu, suggestion: "对话指代过于模糊简略偏西式：'你那段，我替你补上'→'你那部分情况，我替你补上'，指代明确更符合中文职场/日常对话习惯。" },
  // "是要……的"判断句式书面化（是要有人签字担责的/是要付出代价的/是要负责任的）
  { type: "western_dialogue", pattern: /(?:补这四个字|做这事|这么干|这样做|说这话|签这字)[^。！？\n]{0,6}是要[^。！？\n]{0,12}(?:的|了)/gu, suggestion: "'做某事是要……的'判断句式偏西式书面化：'补这四个字，是要有人签字担责的'→'这四个字不是白写的，得有人签字担责任'。" },
  // "不是一路了"式口语直译（不是一路了/不对劲了/不对味了/不是一个路数了）
  { type: "western_dialogue", pattern: /(?:眼神|目光|表情|脸色|态度|感觉|味道|气氛|关系)[^。！？\n，；]{0,6}(?:已经|早就)?(?:跟[^。！？\n]{0,4}不是一路|不是一路了|不对味了|不对劲了|不是一个路数了|不是从前了)/gu, suggestion: "口语直译偏西式：'眼神跟下水前不是一路了'→'眼神却和下水前完全不一样了'，用中文常用表达。" },
  // 对话标签"XX道"前缺修饰或过度省略（XX道，XX道。孤立短句）
  { type: "western_dialogue", pattern: /[」』"\u201D][，,]\s*[^。！？\n，；]{1,4}道。/gu, suggestion: "过短对话标签偏西式断裂，要么合并到动作描写，要么补全'XX说道/问道/喊道'，避免孤立'XX道。'短句。" },
];

/**
 * 一、短句断裂与独句成段检测（需要按段落分析，非简单正则）
 * 检测连续2个及以上1-6字的超短短句独立成段（非对话、非诗词、非强调用）。
 */
function detectFragmentParagraphs(text: string): ChineseNarrativeNaturalnessFinding[] {
  const findings: ChineseNarrativeNaturalnessFinding[] = [];
  const paragraphs = text.split(/\n\s*\n|\n(?=[^\n「」『』\u201C\u201D])/u); // 按段落分割
  let searchBase = 0;

  for (const para of paragraphs) {
    const trimmedPara = para.trim();
    if (!trimmedPara) continue;

    // 跳过纯对话段落（以引号开头/结尾）—— P34 兼容中文弯引号 “”
    if (/^[「『"\u201C]/.test(trimmedPara) && /[」』"\u201D]$/.test(trimmedPara)) {
      searchBase += para.length + 2;
      continue;
    }

    // 按句号/感叹号/问号拆成句子
    const sentences = trimmedPara.split(/(?<=[。！？])/u).filter((s) => s.trim().length > 0);
    const shortSentences: Array<{ text: string; index: number }> = [];

    for (const sent of sentences) {
      const trimmedSent = sent.replace(/^[\s「」『』"'“”]+|[\s「」『』"'“”]+$/gu, "").trim();
      // 检测2-6字的短句（排除纯对话、单字、7字以上）
      if (trimmedSent.length >= 2 && trimmedSent.length <= 6) {
        // 排除含对话的句子
        if (/[「」『』"'“”]/.test(trimmedSent)) continue;
        // 排除是人名+说/道/喊的对话标签（XX道/XX说/XX问）
        if (/^(?:他|她|我|你|.{1,4})(?:说|道|问|喊|叫|答|应|笑|叹)$/u.test(trimmedSent)) continue;
        // 排除常用语气词/感叹词
        if (/^(?:嗯|哦|啊|呀|哇|唉|嗨|喂|好|是|对|不|没|行了|够了|住手|不要|快走|快跑|小心)$/u.test(trimmedSent)) continue;
        shortSentences.push({ text: sent, index: trimmedPara.indexOf(sent) });
      }
    }

    // 连续2个及以上超短短句视为短句断裂
    if (shortSentences.length >= 2) {
      const firstShort = shortSentences[0];
      const idx = text.indexOf(trimmedPara, searchBase);
      const index = idx >= 0 ? idx + firstShort.index : searchBase;
      findings.push({
        type: "fragment_paragraph",
        text: excerptAround(text, index, Math.min(30, trimmedPara.length)),
        index,
        suggestion: `超短短句连续独立成段是西式节奏（${shortSentences.length}处）：如"迟疑了半拍。/它要显了。/意念一动。"应合并为连贯句式，融入主句，避免靠物理断句制造节奏。`,
        severity: shortSentences.length >= 3 ? "high" : "medium",
      });
    }

    searchBase += para.length + 2;
  }

  return findings;
}

/** P33 六大类翻译腔 patterns 聚合（正则类） */
const P33_TRANSLATION_TONE_PATTERNS: PatternSpec[] = [
  ...ACTION_NOUN_SUBJECT_PATTERNS,
  ...POSTPOSITIVE_MODIFIER_PATTERNS,
  ...WESTERN_ACTION_BREAKDOWN_PATTERNS,
  ...NARRATOR_JUDGMENT_PATTERNS,
  ...WESTERN_DIALOGUE_PATTERNS,
];

const ALL_DENSITY_PATTERNS: { spec: PatternSpec[]; kind: "temporal" | "logical" | "psychology" | "abstract" | "dialogueTag" }[] = [
  { spec: TEMPORAL_PATTERNS, kind: "temporal" },
  { spec: LOGICAL_CONNECTOR_PATTERNS, kind: "logical" },
  { spec: PSYCHOLOGY_PATTERNS, kind: "psychology" },
  { spec: ABSTRACT_SUBJECT_PATTERNS, kind: "abstract" },
  { spec: DIALOGUE_TAG_PATTERNS, kind: "dialogueTag" },
];

/**
 * 从文本中剥离对话内容（成对引号内的部分），用于 narration-only 扫描。
 * 仅用于 modifierStack / povLeak / goldenSentence 这类叙事层出戏点，
 * 避免对话里合法出现的词被误报。
 */
function stripDialogue(text: string): string {
  return text.replace(/[“"「『（]([^”"」』）]*?)[”"」』）]/gu, "");
}

/** 取命中处的上下文片段（命中词 + 前后窗口） */
function excerptAround(text: string, index: number, matchLength: number, window = 12): string {
  const start = Math.max(0, index - window);
  const end = Math.min(text.length, index + matchLength + window);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end)}${suffix}`;
}

interface RawMatch {
  type: ChineseNarrativeNaturalnessFinding["type"];
  text: string;
  index: number;
  suggestion: string;
  severity?: "high" | "medium" | "low";
  /** P42 新增：实际命中字符串长度（不含前后窗口），用于密度去重 */
  matchLength?: number;
}

/** 对一组 pattern 跑匹配，返回带 index/text/suggestion 的原始命中 */
function collectMatches(text: string, specs: PatternSpec[]): RawMatch[] {
  const matches: RawMatch[] = [];
  for (const spec of specs) {
    const pattern = new RegExp(spec.pattern.source, spec.pattern.flags);
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text)) !== null) {
      if (m.index === undefined) {
        break;
      }
      matches.push({
        type: spec.type,
        text: excerptAround(text, m.index, m[0].length),
        index: m.index,
        suggestion: spec.suggestion,
        matchLength: m[0].length,
      });
      if (m.index === pattern.lastIndex) {
        pattern.lastIndex += 1;
      }
    }
  }
  return matches;
}

/**
 * 长定语/"的"字堆叠检测（docs 4.6）。
 * 按句切分，单句"的"出现超过 3 个即记为长定语疑似。
 */
function detectModifierStack(text: string, _charCount: number): ChineseNarrativeNaturalnessFinding[] {
  const findings: ChineseNarrativeNaturalnessFinding[] = [];
  // 长定语检测基于单句"的"绝对计数（>3），不依赖总文本长度：
  // 一句 4+ 个"的"无论章节多短都是长定语问题，故不设 charCount 门槛。
  const narration = stripDialogue(text);
  const sentences = narration.split(/[。！？\n；;]+/u).filter((s) => s.trim().length >= 8);
  let searchBase = 0;
  for (const sentence of sentences) {
    const deCount = (sentence.match(/的/gu) || []).length;
    if (deCount > 3) {
      // 在原文中定位该句起始
      const idx = text.indexOf(sentence, searchBase);
      const index = idx >= 0 ? idx : searchBase;
      if (idx >= 0) {
        searchBase = idx + sentence.length;
      }
      findings.push({
        type: "modifier_stack",
        text: excerptAround(text, index, Math.min(sentence.length, 24)),
        index,
        suggestion: "长定语拆成短句，主干先出来；一句里的'的'不要堆叠超过两个。",
      });
    }
  }
  return findings;
}

/**
 * 综合风险等级判定。
 * - density 类：按 docs 第 6 节阈值（每 3000 字），取最高风险。
 * - findings 类（pov/golden/modifier）：用绝对计数，避免短文本密度放大。
 * - P32 nativeSyntax（6 类英文翻译腔）：≥5 medium / ≥10 high（绝对计数）。
 * - 短文本（< MIN_DENSITY_CHARS）：density 全为 0，只看 findings 绝对计数。
 */
function determineRiskLevel(
  densities: {
    temporal: number;
    logical: number;
    psychology: number;
    abstract: number;
    dialogueTag: number;
  },
  povCount: number,
  goldenCount: number,
  modifierCount: number,
  nativeSyntaxCount: number,
): ChineseNarrativeNaturalnessRiskLevel {
  let level: ChineseNarrativeNaturalnessRiskLevel = "low";

  const bump = (next: ChineseNarrativeNaturalnessRiskLevel): void => {
    if (next === "high") {
      level = "high";
    } else if (next === "medium" && level !== "high") {
      level = "medium";
    }
  };

  // density 阈值（docs 第 6 节）
  // temporal: 0-2 low / 3-5 medium / 6+ high
  if (densities.temporal >= 6) bump("high");
  else if (densities.temporal >= 3) bump("medium");
  // logical: 0-3 low / 4-8 medium / 9+ high
  if (densities.logical >= 9) bump("high");
  else if (densities.logical >= 4) bump("medium");
  // psychology: 0-5 low / 6-12 medium / 13+ high
  if (densities.psychology >= 13) bump("high");
  else if (densities.psychology >= 6) bump("medium");
  // abstract: 0-3 low / 4-8 medium / 9+ high
  if (densities.abstract >= 9) bump("high");
  else if (densities.abstract >= 4) bump("medium");
  // dialogueTag: 偶发 low / 多处 medium / 抢戏 high（用密度近似）
  if (densities.dialogueTag >= 6) bump("high");
  else if (densities.dialogueTag >= 3) bump("medium");

  // findings 绝对计数（pov/golden 是强出戏信号，少量即记 medium）
  if (povCount >= 3 || goldenCount >= 2) bump("high");
  else if (povCount >= 1 || goldenCount >= 1) bump("medium");
  if (modifierCount >= 4) bump("high");
  else if (modifierCount >= 2) bump("medium");

  // P32 nativeSyntax：英文翻译腔绝对计数（不归一化，单章 5 处已明显影响母语阅读）
  if (nativeSyntaxCount >= 10) bump("high");
  else if (nativeSyntaxCount >= 5) bump("medium");

  return level;
}

function buildSummary(
  riskLevel: ChineseNarrativeNaturalnessRiskLevel,
  densities: {
    temporal: number;
    logical: number;
    psychology: number;
    abstract: number;
    dialogueTag: number;
  },
  povCount: number,
  goldenCount: number,
  modifierCount: number,
  nativeSyntaxCount: number,
  nativeSyntaxByType: Record<string, number>,
  charCount: number,
): string {
  if (charCount === 0) {
    return "文本为空，未做中文自然感诊断。";
  }
  if (charCount < MIN_DENSITY_CHARS) {
    const nativeParts = nativeSyntaxCount > 0
      ? `、英文翻译腔 ${nativeSyntaxCount} 处`
      : "";
    return `文本较短（${charCount} 字），仅做命中扫描：POV 越界 ${povCount} 处、金句 ${goldenCount} 处、长定语 ${modifierCount} 处${nativeParts}；综合风险 ${riskLevel}。`;
  }
  const parts: string[] = [];
  parts.push(`综合风险 ${riskLevel}`);
  parts.push(`时间容器句 ${densities.temporal}/3000字`);
  parts.push(`逻辑连接词 ${densities.logical}/3000字`);
  parts.push(`心理解释 ${densities.psychology}/3000字`);
  parts.push(`抽象物主语 ${densities.abstract}/3000字`);
  parts.push(`表演化对话标签 ${densities.dialogueTag}/3000字`);
  parts.push(`POV 越界 ${povCount} 处`);
  parts.push(`金句收尾 ${goldenCount} 处`);
  parts.push(`长定语/“的”堆叠 ${modifierCount} 处`);
  if (nativeSyntaxCount > 0) {
    // P34：用中文展示词替代英文 enum，避免 trace summary 出现英文技术 token
    const breakdown = Object.entries(nativeSyntaxByType)
      .filter(([, n]) => n > 0)
      .map(([t, n]) => `${getChineseNaturalnessTypeLabel(t)}:${n}`)
      .join(" ");
    parts.push(`翻译腔/英文味 ${nativeSyntaxCount} 处${breakdown ? `（${breakdown}）` : ""}`);
  }
  return parts.join("；") + "。";
}

export class ChineseNarrativeNaturalnessScanner {
  /**
   * 扫描正文，返回中文自然感诊断结果。纯本地，不调用 LLM，不修改正文，不写文件。
   */
  scan(text: string): ChineseNarrativeNaturalnessScanResult {
    const safeText = typeof text === "string" ? text : "";
    const charCount = safeText.length;

    // 空文本：返回全零低风险，不崩溃
    if (charCount === 0) {
      return {
        temporalClauseDensity: 0,
        logicalConnectorDensity: 0,
        psychologyExplanationDensity: 0,
        abstractSubjectDensity: 0,
        performativeDialogueTagDensity: 0,
        modifierStackFindings: [],
        povLeakFindings: [],
        goldenSentenceFindings: [],
        nativeSyntaxFindings: [],
        p33TranslationToneFindings: {
          fragmentParagraphFindings: [],
          actionNounSubjectFindings: [],
          postpositiveModifierFindings: [],
          westernActionBreakdownFindings: [],
          narratorJudgmentFindings: [],
          westernDialogueFindings: [],
        },
        riskLevel: "low",
        findings: [],
        summary: buildSummary("low", { temporal: 0, logical: 0, psychology: 0, abstract: 0, dialogueTag: 0 }, 0, 0, 0, 0, {}, 0),
      };
    }

    // density 类命中（在全文本上扫描）
    const temporalMatches = collectMatches(safeText, TEMPORAL_PATTERNS);
    const logicalMatches = collectMatches(safeText, LOGICAL_CONNECTOR_PATTERNS);
    const psychologyMatches = collectMatches(safeText, PSYCHOLOGY_PATTERNS);
    const abstractMatches = collectMatches(safeText, ABSTRACT_SUBJECT_PATTERNS);
    const dialogueTagMatches = collectMatches(safeText, DIALOGUE_TAG_PATTERNS);

    // P32 新增：英文翻译腔母语语感命中（在全文本上扫描，含对白——报告腔名词串常出现在对白内）
    const nativeSyntaxMatches = collectMatches(safeText, NATIVE_SYNTAX_PATTERNS);

    // P33 新增：六大类翻译腔深度诊断命中
    const p33PatternMatches = collectMatches(safeText, P33_TRANSLATION_TONE_PATTERNS);
    const fragmentParagraphFindings = detectFragmentParagraphs(safeText);
    const actionNounSubjectFindings = p33PatternMatches.filter((m) => m.type === "action_noun_subject");
    const postpositiveModifierFindings = p33PatternMatches.filter((m) => m.type === "postpositive_modifier");
    const westernActionBreakdownFindings = p33PatternMatches.filter((m) => m.type === "western_action_breakdown");
    const narratorJudgmentFindings = p33PatternMatches.filter((m) => m.type === "narrator_judgment");
    const westernDialogueFindings = p33PatternMatches.filter((m) => m.type === "western_dialogue");

    // findings 类命中：POV 越界与金句在叙事层扫描（剥离对话），避免对话内合法词误报
    const narrationForFindings = stripDialogue(safeText);
    const povMatches = collectMatches(narrationForFindings, POV_LEAK_PATTERNS).map((m) => ({
      ...m,
      // 把 index 映射回原文：narrationForFindings 是删除对话后的子串，
      // 直接 indexOf 可能定位到首次出现；对软诊断足够，不要求像素级精确。
      index: safeText.indexOf(m.text.replace(/^…/, "").replace(/…$/, "")) >= 0
        ? safeText.indexOf(m.text.replace(/^…/, "").replace(/…$/, ""))
        : m.index,
    }));
    const goldenMatches = collectMatches(narrationForFindings, GOLDEN_SENTENCE_PATTERNS).map((m) => ({
      ...m,
      index: safeText.indexOf(m.text.replace(/^…/, "").replace(/…$/, "")) >= 0
        ? safeText.indexOf(m.text.replace(/^…/, "").replace(/…$/, ""))
        : m.index,
    }));

    const modifierStackFindings = detectModifierStack(safeText, charCount);

    // density 归一化
    const densities = {
      temporal: normalizeDensity(temporalMatches.length, charCount),
      logical: normalizeDensity(logicalMatches.length, charCount),
      psychology: normalizeDensity(psychologyMatches.length, charCount),
      abstract: normalizeDensity(abstractMatches.length, charCount),
      dialogueTag: normalizeDensity(dialogueTagMatches.length, charCount),
    };

    const povLeakFindings = povMatches.map((m) => ({
      type: m.type,
      text: m.text,
      index: m.index,
      suggestion: m.suggestion,
    }));
    const goldenSentenceFindings = goldenMatches.map((m) => ({
      type: m.type,
      text: m.text,
      index: m.index,
      suggestion: m.suggestion,
    }));

    // P32 nativeSyntax findings + 按类型分组计数（用于 summary 与 trace）
    // P42 密度去重：先把 P42 新类型命中与现有 nativeSyntax 命中分开，P42 内部重叠按优先级去重，
    // 再剔除与现有 nativeSyntax 重叠的 P42 命中（保留现有类型，避免破坏既有 density 行为）。
    const P42_TYPES_SET = new Set<string>(Object.keys(P42_TYPE_PRIORITY));
    const matchLengths = new Map<number, number>();
    for (const m of nativeSyntaxMatches) {
      if (m.matchLength !== undefined) {
        matchLengths.set(m.index, m.matchLength);
      }
    }
    const existingNativeMatches = nativeSyntaxMatches.filter((m) => !P42_TYPES_SET.has(m.type));
    const p42NativeMatches = nativeSyntaxMatches.filter((m) => P42_TYPES_SET.has(m.type));

    // P42 内部去重：同区间多类型只保留优先级最高的
    const p42FindingsBeforeDedup: ChineseNarrativeNaturalnessFinding[] = p42NativeMatches.map((m) => ({
      type: m.type,
      text: m.text,
      index: m.index,
      suggestion: m.suggestion,
    }));
    const p42Deduped = dedupeP42OverlappingFindings(p42FindingsBeforeDedup, matchLengths);

    // 剔除与现有 nativeSyntax 命中重叠的 P42 命中（现有优先）
    // 同时也剔除与 P33 翻译腔命中重叠的 P42 命中（P33 现有类型优先）
    const existingIntervals = [
      ...existingNativeMatches.map((m) => ({
        start: m.index,
        end: m.index + (m.matchLength ?? m.text.length),
      })),
      ...p33PatternMatches.map((m) => ({
        start: m.index,
        end: m.index + (m.matchLength ?? m.text.length),
      })),
    ];
    const p42Final = p42Deduped.filter((f) => {
      const fLen = matchLengths.get(f.index) ?? f.text.length;
      const fEnd = f.index + fLen;
      return !existingIntervals.some((iv) => f.index < iv.end && fEnd > iv.start);
    });

    const nativeSyntaxFindings: ChineseNarrativeNaturalnessFinding[] = [
      ...existingNativeMatches.map((m) => ({
        type: m.type,
        text: m.text,
        index: m.index,
        suggestion: m.suggestion,
      })),
      ...p42Final,
    ].sort((a, b) => a.index - b.index);
    const nativeSyntaxByType: Record<string, number> = {};
    for (const f of nativeSyntaxFindings) {
      nativeSyntaxByType[f.type] = (nativeSyntaxByType[f.type] || 0) + 1;
    }
    const nativeSyntaxCount = nativeSyntaxFindings.length;

    // P33 六大类翻译腔 findings 聚合
    const p33Findings: ChineseNarrativeNaturalnessFinding[] = [
      ...fragmentParagraphFindings,
      ...p33PatternMatches.map((m) => ({
        type: m.type as ChineseNarrativeNaturalnessFinding["type"],
        text: m.text,
        index: m.index,
        suggestion: m.suggestion,
        severity: "medium" as const,
      })),
    ];
    const p33TranslationToneFindings = {
      fragmentParagraphFindings,
      actionNounSubjectFindings,
      postpositiveModifierFindings,
      westernActionBreakdownFindings,
      narratorJudgmentFindings,
      westernDialogueFindings,
    };
    const p33Count = p33Findings.length;

    const riskLevel = determineRiskLevel(
      densities,
      povLeakFindings.length,
      goldenSentenceFindings.length,
      modifierStackFindings.length,
      nativeSyntaxCount + p33Count,
    );

    // 汇总所有 findings，按 index 升序
    const allFindings: ChineseNarrativeNaturalnessFinding[] = [
      ...temporalMatches,
      ...logicalMatches,
      ...psychologyMatches,
      ...abstractMatches,
      ...dialogueTagMatches,
      ...povLeakFindings,
      ...goldenSentenceFindings,
      ...modifierStackFindings,
      ...nativeSyntaxFindings,
      ...p33Findings,
    ]
      .map((m) => ({
        type: m.type,
        text: m.text,
        index: m.index,
        suggestion: m.suggestion,
        severity: (m as { severity?: "high" | "medium" | "low" }).severity,
      }))
      .sort((a, b) => a.index - b.index);

    // 合并 nativeSyntaxByType 和 p33 类型计数
    const allNativeByType: Record<string, number> = { ...nativeSyntaxByType };
    for (const f of p33Findings) {
      allNativeByType[f.type] = (allNativeByType[f.type] || 0) + 1;
    }

    const summary = buildSummary(
      riskLevel,
      densities,
      povLeakFindings.length,
      goldenSentenceFindings.length,
      modifierStackFindings.length,
      nativeSyntaxCount + p33Count,
      allNativeByType,
      charCount,
    );

    return {
      temporalClauseDensity: densities.temporal,
      logicalConnectorDensity: densities.logical,
      psychologyExplanationDensity: densities.psychology,
      abstractSubjectDensity: densities.abstract,
      performativeDialogueTagDensity: densities.dialogueTag,
      modifierStackFindings,
      povLeakFindings,
      goldenSentenceFindings,
      nativeSyntaxFindings,
      p33TranslationToneFindings,
      riskLevel,
      findings: allFindings,
      summary,
    };
  }

  /**
   * P33 新增：中文自然感千字密度评分（用于 Stage 2 事件级硬门禁）。
   *
   * 在 scan() 基础上计算"翻译腔/英文味命中数 ÷ 千字"密度，给出三档判定：
   *   - pass：密度 < 3 处/千字（优质母语）
   *   - repair：3-8 处/千字（合格边缘，需局部修补）
   *   - block：> 8 处/千字（不合格，必须重写）
   *
   * 严重短路：3+ 连续独句成段（fragment_paragraph severity=high）即使密度低也直接 block。
   *
   * 短文本（< 200 字）不计算密度，直接判 pass，避免少量命中被放大误报。
   */
  scoreChineseNaturalnessDensity(text: string): ChineseNaturalnessDensityScore {
    const safeText = typeof text === "string" ? text : "";
    const charCount = safeText.length;

    // 空文本或极短文本：直接 pass
    if (charCount < DENSITY_SCORE_MIN_CHARS) {
      return {
        totalHits: 0,
        charCount,
        densityPerThousand: 0,
        verdict: "pass",
        hasStructuralShortCircuit: false,
        byType: {},
        reason: `文本过短（${charCount} 字），跳过千字密度评估，直接放行。`,
      };
    }

    const scanResult = this.scan(safeText);

    // 统计翻译腔/英文味相关命中（P32 nativeSyntax + P33 六大类 + AI 总结腔）
    const translationToneTypes = new Set<ChineseNarrativeNaturalnessFinding["type"]>([
      "nonhuman_subject_action",
      "english_fragment_clause",
      "quantified_camera_beat",
      "bureaucratic_noun_phrase",
      "mechanism_overexplanation",
      "overwritten_sensory_phrase",
      "fragment_paragraph",
      "action_noun_subject",
      "postpositive_modifier",
      "western_action_breakdown",
      "narrator_judgment",
      "western_dialogue",
      "temporal_clause",
      "logical_connector",
      "psychology_explanation",
      "abstract_subject",
      "performative_dialogue_tag",
      "modifier_stack",
      "pov_leak",
      "golden_sentence",
      // P42 新增 4 类中文母语镜头搭配
      "abstract_sensory_actor",
      "translated_collocation",
      "mechanical_measurement",
      "hard_synesthesia_verb",
    ]);

    let totalHits = 0;
    const byType: Record<string, number> = {};
    let hasStructuralShortCircuit = false;

    for (const f of scanResult.findings) {
      if (!translationToneTypes.has(f.type)) continue;
      totalHits += 1;
      byType[f.type] = (byType[f.type] || 0) + 1;
      // 3+ 连续独句成段（fragment_paragraph severity=high）= 结构性短路
      if (f.type === "fragment_paragraph" && f.severity === "high") {
        hasStructuralShortCircuit = true;
      }
    }

    const densityPerThousand = Math.round((totalHits / charCount) * 1000 * 100) / 100;

    let verdict: "pass" | "repair" | "block";
    let reason: string;

    if (hasStructuralShortCircuit) {
      verdict = "block";
      reason = `结构性短路：检测到 3+ 连续独句成段（fragment_paragraph severity=high），即使整体密度不高也必须重写。千字密度 ${densityPerThousand} 处。`;
    } else if (densityPerThousand > 5) {
      verdict = "block";
      reason = `千字密度 ${densityPerThousand} 处（>5），翻译腔/英文味过浓，必须重写。`;
    } else if (densityPerThousand >= 3) {
      verdict = "repair";
      reason = `千字密度 ${densityPerThousand} 处（3-5），合格边缘，需局部修补后再放行。`;
    } else {
      verdict = "pass";
      reason = `千字密度 ${densityPerThousand} 处（<3），母语感达标，放行。`;
    }

    return {
      totalHits,
      charCount,
      densityPerThousand,
      verdict,
      hasStructuralShortCircuit,
      byType,
      reason,
    };
  }
}

export function createChineseNarrativeNaturalnessScanner(): ChineseNarrativeNaturalnessScanner {
  return new ChineseNarrativeNaturalnessScanner();
}

/**
 * 修订优先级（docs 第 9.3/6 节 + P32 §4.19-§4.24 + P33 六大类翻译腔）：
 * P33 翻译腔优先级最高（短句断裂/非人主语/动作拆解/旁白议论/对话生硬/定语后置），
 * 紧接 P32 英文翻译腔，再是 AI 总结腔。
 * 用于 StyleShaper 修订 hints 与 Stage 8 trace revisionHints。
 * 不删除关键剧情信息，只改句法惯性。
 */
const REVISION_PRIORITY: Array<{ type: ChineseNarrativeNaturalnessFinding["type"]; label: string }> = [
  // P33 六大类翻译腔（最高优先级，用户反馈最影响阅读体验）
  { type: "fragment_paragraph", label: "短句断裂独句成段" },
  { type: "western_action_breakdown", label: "动作西式拆解/生硬通感" },
  { type: "narrator_judgment", label: "叙事旁白直白议论" },
  { type: "western_dialogue", label: "西式对话/指代生硬" },
  { type: "action_noun_subject", label: "事物名词作主语" },
  { type: "postpositive_modifier", label: "定语后置/语序颠倒" },
  // P42 新增：中文母语镜头 4 类搭配（用户 2026-07-07 任务规格书）
  { type: "hard_synesthesia_verb", label: "硬通感动词（感官被物理破坏）" },
  { type: "translated_collocation", label: "翻译腔硬搭配（光线/视线+砸/劈+身体部位）" },
  { type: "abstract_sensory_actor", label: "抽象感官做主动作（冷空气裹着钻进领口）" },
  { type: "mechanical_measurement", label: "机械量化关系（松了半分/短了半寸）" },
  // P32 英文翻译腔母语语感（docs §4.19-§4.24）
  { type: "mechanism_overexplanation", label: "机制解释过度" },
  { type: "nonhuman_subject_action", label: "非人主语动作化" },
  { type: "overwritten_sensory_phrase", label: "感官描写用力过猛" },
  { type: "english_fragment_clause", label: "英文式短碎后置" },
  { type: "quantified_camera_beat", label: "量化镜头" },
  { type: "bureaucratic_noun_phrase", label: "任务/报告腔名词串" },
  // AI 总结腔
  { type: "psychology_explanation", label: "心理解释" },
  { type: "abstract_subject", label: "抽象物主语" },
  { type: "logical_connector", label: "逻辑连接词" },
  { type: "modifier_stack", label: "长定语/“的”字堆叠" },
  { type: "performative_dialogue_tag", label: "对话标签表演化" },
  { type: "golden_sentence", label: "金句收尾" },
];

/**
 * P33 中文化改造：命中类型 → 中文展示词映射（供 narrator 构建中文 prompt 使用）。
 *
 * 把英文 enum（fragment_paragraph 等）映射为中文展示词（短句断裂独句成段 等），
 * 避免英文技术 token 进入模型 prompt。
 */
export const CHINESE_NATURALNESS_TYPE_LABELS: Record<ChineseNarrativeNaturalnessFinding["type"], string> =
  Object.fromEntries(REVISION_PRIORITY.map(({ type, label }) => [type, label])) as Record<
    ChineseNarrativeNaturalnessFinding["type"],
    string
  >;

/**
 * P33 中文化改造：verdict → 中文展示词映射（供 narrator 构建中文 prompt 使用）。
 *
 * pass → 通过；repair → 需修补；block → 必须重写。
 */
export const CHINESE_NATURALNESS_VERDICT_LABELS: Record<ChineseNaturalnessDensityScore["verdict"], string> = {
  pass: "通过",
  repair: "需修补",
  block: "必须重写",
};

/**
 * P33 中文化改造：按命中类型枚举取中文展示词。
 * 未知类型回退为"其他翻译腔"。
 */
export function getChineseNaturalnessTypeLabel(type: string): string {
  return CHINESE_NATURALNESS_TYPE_LABELS[type as ChineseNarrativeNaturalnessFinding["type"]] ?? "其他翻译腔";
}

/**
 * P33 中文化改造：按 verdict 取中文展示词。
 */
export function getChineseNaturalnessVerdictLabel(verdict: string): string {
  return CHINESE_NATURALNESS_VERDICT_LABELS[verdict as ChineseNaturalnessDensityScore["verdict"]] ?? verdict;
}

/**
 * 从 scanner 结果构造中文自然感修订 hints（中文短句列表）。
 * 按优先级排序，每类最多 2 条，总最多 12 条（P33 扩展到 12，覆盖六大类翻译腔）。
 * 仅在 riskLevel 为 medium/high 时由调用方使用。
 */
export function buildChineseNaturalnessHints(
  result: ChineseNarrativeNaturalnessScanResult,
): string[] {
  const hints: string[] = [];
  for (const { type, label } of REVISION_PRIORITY) {
    const hits = result.findings.filter((f) => f.type === type);
    if (hits.length === 0) {
      continue;
    }
    const sample = hits[0];
    hints.push(
      `【${label}】命中 ${hits.length} 处，例如"${sample.text}"。${sample.suggestion} 修订时保持事件推进、人物主动性与类型落点，不得删除关键剧情信息。`,
    );
    if (hints.length >= 12) {
      break;
    }
  }
  return hints;
}
