/**
 * PiNovelStudio — Anti-AI prompt resource rules
 *
 * GitHub-screened and local analysis resources distilled into local regex
 * rules for the AntiAIDetector. These rules target recurring Chinese AI-tone
 * structures and keep the source taxonomy separate from the detector
 * implementation.
 */

export type PromptResourceCategory =
  | "structure"
  | "language"
  | "description"
  | "dialogue"
  | "scene"
  | "narration_strategy";

export interface AntiAIPromptResourceSource {
  id: string;
  title: string;
  url: string;
  license?: string;
  retainedSignals: string[];
}

export interface PromptResourcePattern {
  id: string;
  pattern: RegExp;
  tag: string;
  severity: number;
  fix: string;
  category: PromptResourceCategory;
  sourceIds: string[];
}

export const ANTI_AI_PROMPT_RESOURCE_SOURCES: AntiAIPromptResourceSource[] = [
  {
    id: "qu-ai-wei",
    title: "qu-ai-wei: 去除中文 AI 写作痕迹",
    url: "https://github.com/LifelongLazyLearner/qu-ai-wei/blob/main/SKILL.md",
    license: "MIT",
    retainedSignals: [
      "空洞关注/强调句",
      "不仅...更...空洞并列",
      "从某种意义上说/在一定程度上等模糊限定",
      "文学/故事类 AI 味与抽象气氛堆叠",
    ],
  },
  {
    id: "authenticity-check",
    title: "authenticity-check",
    url: "https://github.com/aihxp/authenticity-check/blob/main/SKILL.md",
    retainedSignals: [
      "uniformity as signal",
      "span-level diagnostic flags",
      "false-positive veto for concrete human markers",
    ],
  },
  {
    id: "humanizer",
    title: "humanizer",
    url: "https://github.com/blader/humanizer/blob/main/SKILL.md",
    license: "MIT",
    retainedSignals: [
      "significance inflation",
      "negative parallelisms",
      "filler and hedging phrases",
      "generic positive or dramatic conclusions",
    ],
  },
  {
    id: "slopbuster",
    title: "slopbuster",
    url: "https://github.com/gabelul/slopbuster/blob/main/SKILL.md",
    license: "MIT",
    retainedSignals: [
      "two-pass audit",
      "AI vocabulary and structural templates",
      "specificity and rhythm as counter-evidence",
    ],
  },
  {
    id: "avoid-ai-writing-multilingual",
    title: "avoid-ai-writing multilingual skills",
    url: "https://github.com/jurigis/avoid-ai-writing-multilingual/blob/main/README.md",
    license: "MIT",
    retainedSignals: [
      "language-native pattern policy",
      "severity grading",
      "context-aware false-positive controls",
    ],
  },
  {
    id: "en-zh-sentence-pattern-analysis",
    title: "中英文句式对比分析：英文高频句式的中文 AI 腔识别",
    url: "local:C:/Users/Administrator/Desktop/en-zh-sentence-pattern-analysis.md",
    retainedSignals: [
      "not X but Y sentence transfer",
      "cleft and pseudo-cleft sentence transfer",
      "explicit logic connector transfer",
      "formal discourse marker transfer",
      "English-order when/in-order-to/double-conjunction transfer",
      "began-to/continued-to action padding",
      "seems-that full-sentence hedging",
      "time/process marker transfer",
    ],
  },
];

export const ANTI_AI_PROMPT_RESOURCE_PATTERNS: PromptResourcePattern[] = [
  {
    id: "resource_empty_attention_marker",
    pattern: /(?:值得(?:注意|一提|思考)的是|需要注意的是|不可否认|毋庸置疑)[，,]/g,
    tag: "资源规则: 空洞关注/强调句",
    severity: 0.8,
    fix: "删除空洞提示语，直接写可验证的事件、动作或信息差",
    category: "narration_strategy",
    sourceIds: ["qu-ai-wei", "humanizer", "slopbuster", "en-zh-sentence-pattern-analysis"],
  },
  {
    id: "resource_not_only_more_is",
    pattern: /不仅[^。！？\n]{1,40}(?:更是|更|而且|还)[^。！？\n]{1,40}/g,
    tag: "资源规则: 不仅...更...空洞并列",
    severity: 0.85,
    fix: "拆掉并列升华骨架，只保留真正改变局面的具体信息",
    category: "language",
    sourceIds: ["qu-ai-wei", "humanizer", "en-zh-sentence-pattern-analysis"],
  },
  {
    id: "resource_negative_is_shortcut",
    // R31: 排除具体名词对比（如"不是正门，是侧楼梯"），只检测抽象概念否定铺垫
    // 具体名词对比是文学修辞手法，不是 AI 腔
    // 通过后置过滤实现：在 anti-ai-detector.ts 中添加 filterResourceNegativeFalsePositives
    pattern: /这?不是[^。！？\n]{2,30}(?:而是|[，,。]是|——是|—是|--是|-是)[^。！？\n]{2,40}/g,
    tag: "资源规则: 不是...是/而是...否定转正捷径",
    severity: 0.86,
    fix: "删除否定铺垫，直接写'是...'后的有效信息及其可见证据",
    category: "language",
    sourceIds: ["qu-ai-wei", "humanizer", "slopbuster", "en-zh-sentence-pattern-analysis"],
  },
  {
    id: "resource_rather_than_marker",
    pattern: /与其说[^。！？\n]{1,40}不如说[^。！？\n]{1,40}/g,
    tag: "资源规则: 与其说...不如说...翻译腔对照",
    severity: 0.82,
    fix: "删除对照外壳，直接写后半句判断或让动作呈现差异",
    category: "language",
    sourceIds: ["en-zh-sentence-pattern-analysis", "humanizer"],
  },
  {
    id: "resource_cleft_zhengshi_cai",
    pattern: /正是[^。！？\n]{1,30}才[^。！？\n]{1,40}/g,
    tag: "资源规则: 正是...才...分裂句迁移",
    severity: 0.86,
    fix: "去掉强调骨架，改为中文自然语序或具体反应",
    category: "structure",
    sourceIds: ["en-zh-sentence-pattern-analysis"],
  },
  {
    id: "resource_wh_cleft_de_shi",
    pattern: /(?:让[^。！？\n]{1,12}(?:惊讶|意外|不安|发冷|沉默|困惑|在意)的是|[^。！？\n]{1,20}所做的是)[^。！？\n]{1,40}/g,
    tag: "资源规则: ...的是...伪分裂句迁移",
    severity: 0.78,
    fix: "把'...的是...'改成动作、反应或直接判断，减少书面说明感",
    category: "structure",
    sourceIds: ["en-zh-sentence-pattern-analysis"],
  },
  {
    id: "resource_one_hand_other_hand",
    pattern: /一方面[^。！？\n]{1,40}另一方面[^。！？\n]{1,40}/g,
    tag: "资源规则: 一方面...另一方面...议论文连接词迁移",
    severity: 0.86,
    fix: "改为中文叙事里的轻量转折，例如'但/可/偏偏'，或拆成动作后果",
    category: "structure",
    sourceIds: ["en-zh-sentence-pattern-analysis"],
  },
  {
    id: "resource_by_contrast_marker",
    pattern: /(?:相比之下|与之相比|相较之下)[，,][^。！？\n]{1,40}/g,
    tag: "资源规则: 相比之下显性对比标记",
    severity: 0.8,
    fix: "删除元连接词，用'却/倒是'或并置画面完成对比",
    category: "language",
    sourceIds: ["en-zh-sentence-pattern-analysis"],
  },
  {
    id: "resource_rephrase_marker",
    pattern: /(?:换句话说|也就是说|换言之)[，,][^。！？\n]{1,40}/g,
    tag: "资源规则: 换句话说元解释标记",
    severity: 0.82,
    fix: "删除重述提示语，直接保留更具体、更有信息量的表达",
    category: "narration_strategy",
    sourceIds: ["en-zh-sentence-pattern-analysis", "humanizer"],
  },
  {
    id: "resource_no_doubt_marker",
    pattern: /(?:毫无疑问|毫无疑义|毋庸置疑)[，,][^。！？\n]{1,40}/g,
    tag: "资源规则: 毫无疑问正式强调标记",
    severity: 0.8,
    fix: "用人物判断、证据或后果替代正式确认语",
    category: "language",
    sourceIds: ["en-zh-sentence-pattern-analysis", "qu-ai-wei"],
  },
  {
    id: "resource_needless_to_say_marker",
    pattern: /不言而喻[，,][^。！？\n]{1,40}/g,
    tag: "资源规则: 不言而喻书面标记",
    severity: 0.8,
    fix: "删除书面提示语，直接写后果或人物的口语化判断",
    category: "language",
    sourceIds: ["en-zh-sentence-pattern-analysis"],
  },
  {
    id: "resource_concession_fact_marker",
    pattern: /尽管事实上[^。！？\n]{1,40}/g,
    tag: "资源规则: 尽管事实上翻译腔让步",
    severity: 0.84,
    fix: "改成条件事实加轻量转折，例如'外面还下着雨，她照样出门'",
    category: "language",
    sourceIds: ["en-zh-sentence-pattern-analysis"],
  },
  {
    id: "resource_admittedly_concession",
    pattern: /诚然[^。！？\n]{1,30}(?:但是|但|可是|可)[^。！？\n]{1,40}/g,
    tag: "资源规则: 诚然...但...书面让步",
    severity: 0.76,
    fix: "改为更口语的让步或直接写人物态度变化",
    category: "language",
    sourceIds: ["en-zh-sentence-pattern-analysis"],
  },
  {
    id: "resource_reason_is_marker",
    pattern: /[^。！？\n]{1,24}的原因是[^。！？\n]{1,40}/g,
    tag: "资源规则: ...的原因是...显性因果",
    severity: 0.82,
    fix: "用事件顺序暗示因果，避免说明文式原因标记",
    category: "narration_strategy",
    sourceIds: ["en-zh-sentence-pattern-analysis"],
  },
  {
    id: "resource_this_means_marker",
    pattern: /这(?:就)?意味着[^。！？\n]{1,40}/g,
    tag: "资源规则: 这意味着推理说明",
    severity: 0.82,
    fix: "让人物反应、代价或新风险呈现含义，不直接解释",
    category: "narration_strategy",
    sourceIds: ["en-zh-sentence-pattern-analysis", "humanizer"],
  },
  {
    id: "resource_extent_hedge",
    pattern: /(?:在某种程度上|从某种程度上说|在一定程度上)[，,][^。！？\n]{1,40}/g,
    tag: "资源规则: 在某种程度上模糊限定",
    severity: 0.78,
    fix: "删掉模糊限定，改成明确态度、比例、动作或代价",
    category: "language",
    sourceIds: ["en-zh-sentence-pattern-analysis", "qu-ai-wei", "avoid-ai-writing-multilingual"],
  },
  {
    id: "resource_in_terms_of_marker",
    pattern: /在[^。！？\n]{1,12}方面[，,][^。！？\n]{1,40}/g,
    tag: "资源规则: 在...方面范围显化",
    severity: 0.72,
    fix: "改为'...上'、直接省略范围词，或用具体指标承接",
    category: "language",
    sourceIds: ["en-zh-sentence-pattern-analysis", "avoid-ai-writing-multilingual"],
  },
  {
    id: "resource_meanwhile_marker",
    pattern: /与此同时[，,][^。！？\n]{1,40}/g,
    tag: "资源规则: 与此同时时间连接词迁移",
    severity: 0.76,
    fix: "改用场景切换、时间锚点或动作并置，不显式喊出连接关系",
    category: "narration_strategy",
    sourceIds: ["en-zh-sentence-pattern-analysis"],
  },
  {
    id: "resource_just_then_marker",
    pattern: /就在这时[，,][^。！？\n]{1,40}/g,
    tag: "资源规则: 就在这时流程标记",
    severity: 0.74,
    fix: "直接写突然发生的声响、动作或打断，不使用流程提示语",
    category: "narration_strategy",
    sourceIds: ["en-zh-sentence-pattern-analysis"],
  },
  {
    id: "resource_when_clause_transfer",
    pattern: /当[^。！？\n，,]{2,30}时[，,][^。！？\n]{1,60}/g,
    tag: "资源规则: 当...时...英文时间从句迁移",
    severity: 0.8,
    fix: "去掉'当...时'外壳，改成事件先后或直接写后半句动作",
    category: "language",
    sourceIds: ["en-zh-sentence-pattern-analysis", "avoid-ai-writing-multilingual"],
  },
  {
    id: "resource_in_order_to_transfer",
    pattern: /为了[^。！？\n，,]{2,32}[，,][^。！？\n]{1,60}/g,
    tag: "资源规则: 为了...目的从句迁移",
    severity: 0.78,
    fix: "删除目的状语外壳，直接写人物动作、物件变化或结果",
    category: "language",
    sourceIds: ["en-zh-sentence-pattern-analysis", "avoid-ai-writing-multilingual"],
  },
  {
    id: "resource_double_conjunction_concession",
    pattern: /虽然[^。！？\n]{2,50}但是[^。！？\n]{2,60}/g,
    tag: "资源规则: 虽然...但是...双连接词迁移",
    severity: 0.82,
    fix: "只保留一个轻量转折，或拆成事实与后果两句",
    category: "language",
    sourceIds: ["en-zh-sentence-pattern-analysis", "avoid-ai-writing-multilingual"],
  },
  {
    id: "resource_double_conjunction_cause",
    pattern: /因为[^。！？\n]{2,50}所以[^。！？\n]{2,60}/g,
    tag: "资源规则: 因为...所以...双连接词迁移",
    severity: 0.84,
    fix: "只保留原因或结果，让事件顺序承担因果关系",
    category: "narration_strategy",
    sourceIds: ["en-zh-sentence-pattern-analysis", "avoid-ai-writing-multilingual"],
  },
  {
    id: "resource_even_if_still_transfer",
    pattern: /即使[^。！？\n]{2,50}也[^。！？\n]{2,60}/g,
    tag: "资源规则: 即使...也...让步从句迁移",
    severity: 0.78,
    fix: "去掉让步外壳，直接写选择、动作或阻力",
    category: "language",
    sourceIds: ["en-zh-sentence-pattern-analysis", "avoid-ai-writing-multilingual"],
  },
  {
    id: "resource_begin_to_action_padding",
    pattern: /开始(?:检查|核对|意识到|观察|思考|询问|追问|解释|确认|寻找|查看|处理|消化|审视|分析|判断|理解|回忆|回想|怀疑|注意|感受|看|听|问|说|写|读|翻|敲|推|拉|走|跑|退|靠|摸|按|盯|扫)[^。！？\n]{0,30}/g,
    tag: "资源规则: 开始+常规动作填充",
    severity: 0.7,
    fix: "常规动作直接写动词；只有真实状态起点才保留'开始'",
    category: "narration_strategy",
    sourceIds: ["en-zh-sentence-pattern-analysis", "humanizer", "slopbuster", "avoid-ai-writing-multilingual"],
  },
  {
    id: "resource_continue_to_action_padding",
    pattern: /继续(?:检查|核对|意识到|观察|思考|询问|追问|解释|确认|寻找|查看|处理|消化|审视|分析|判断|理解|回忆|回想|怀疑|注意|感受|看|听|问|说|写|读|翻|敲|推|拉|走|跑|退|靠|摸|按|盯|扫)[^。！？\n]{0,30}/g,
    tag: "资源规则: 继续+常规动作填充",
    severity: 0.68,
    fix: "常规动作直接写动词；只有真实持续状态才保留'继续'",
    category: "narration_strategy",
    sourceIds: ["en-zh-sentence-pattern-analysis", "humanizer", "slopbuster", "avoid-ai-writing-multilingual"],
  },
  {
    id: "resource_seems_that_sentence",
    pattern: /(?:^|[。！？\n])\s*(?:似乎|仿佛)[^。！？\n]{2,50}/g,
    tag: "资源规则: 似乎/仿佛+整句英文式悬置",
    severity: 0.74,
    fix: "删除不确定外壳，改写为可见事实、声音、动作或人物误判",
    category: "description",
    sourceIds: ["en-zh-sentence-pattern-analysis", "humanizer", "slopbuster", "avoid-ai-writing-multilingual"],
  },
  {
    id: "resource_process_gradual_realization",
    pattern: /在这个过程中[^。！？\n]{0,30}(?:逐渐|慢慢)?(?:意识到|明白|发现)[^。！？\n]{1,40}/g,
    tag: "资源规则: 过程式顿悟解释",
    severity: 0.82,
    fix: "用人物看到的证据、作出的动作或状态变化替代顿悟说明",
    category: "narration_strategy",
    sourceIds: ["qu-ai-wei", "authenticity-check"],
  },
  {
    id: "resource_vague_sensory_atmosphere",
    pattern: /空气[^。！？\n]{0,12}(?:仿佛|像是)?(?:凝固|冻结)[^。！？\n]{0,30}(?:难以言喻|无法形容|说不清)[^。！？\n]{0,30}(?:蔓延|弥漫|扩散)/g,
    tag: "资源规则: 抽象感官氛围堆叠",
    severity: 0.88,
    fix: "替换为可定位的声、光、温度、动作或物件变化",
    category: "description",
    sourceIds: ["qu-ai-wei", "authenticity-check", "slopbuster"],
  },
  {
    id: "resource_no_doubt_crisis_begins",
    pattern: /这(?:无疑|显然)?意味着[^。！？\n]{0,20}(?:真正的)?(?:危机|危险|风暴|麻烦)[^。！？\n]{0,12}才刚刚?开始/g,
    tag: "资源规则: 解释式危机升格结尾",
    severity: 0.9,
    fix: "删除'这意味着'式解说，让新的风险以动作、代价或未结账细节出现",
    category: "narration_strategy",
    sourceIds: ["humanizer", "slopbuster", "qu-ai-wei", "en-zh-sentence-pattern-analysis"],
  },
  {
    id: "resource_abstract_significance_stack",
    pattern: /(?:从某种意义上说|在一定程度上|整体而言)[^。！？\n]{0,30}(?:尤为重要|至关重要|意义重大|不可忽视)/g,
    tag: "资源规则: 模糊限定+重要性膨胀",
    severity: 0.86,
    fix: "删掉抽象重要性判断，改为具体后果、约束或人物选择",
    category: "language",
    sourceIds: ["qu-ai-wei", "humanizer", "avoid-ai-writing-multilingual", "en-zh-sentence-pattern-analysis"],
  },
];
