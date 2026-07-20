/**
 * PiNovelStudio — 场景技法元数据（轻量版）
 *
 * P10修复：替代 data/scenes/*.json 大文件，提供轻量级元数据。
 *
 * 使用场景：
 * - Narrator 加载场景类型和推荐技法时使用
 * - 不加载完整语料，只提供索引元数据
 *
 * 完整语料（data/scenes/*.json）由数据管线预处理，不在运行时读取。
 */

/** 场景元数据条目 */
export interface SceneMeta {
  name: string;
  description: string;
  file: string;
  tags: string[];
  recommended_techniques: SceneTechnique[];
}

/** 场景技法条目 */
export interface SceneTechnique {
  id: string;
  name: string;
  formula: string;
}

/**
 * 所有可用场景列表。
 *
 * P33 中文化改造：技法名从西方创意写作术语（角色弧光展示/场景蒙太奇）改为
 * 中文本土母语术语（背面傅粉/横云断峰），避免激活英文写作范式。
 * 内部 id 保留以兼容现有索引；name 与 formula 全部使用中文母语表述。
 */
export const SCENE_METADATA: SceneMeta[] = [
  {
    name: "combat",
    description: "战斗场景",
    file: "combat.json",
    tags: ["action", "conflict", "tension"],
    recommended_techniques: [
      { id: "delay_satisfaction", name: "延迟满足", formula: "先压抑后释放，制造对比张力" },
      { id: "sensory_baimiao", name: "感官白描", formula: "用最少字写出可见画面，不堆形容词" },
      { id: "emotion_reversal", name: "情绪反转", formula: "预期与现实的反差制造惊喜" },
      { id: "beimian_fufen", name: "背面傅粉", formula: "写表面动作，衬出人物底细，不点破" }
    ]
  },
  {
    name: "breakthrough",
    description: "突破/成长场景",
    file: "breakthrough.json",
    tags: ["growth", "transformation", "climax"],
    recommended_techniques: [
      { id: "caoshe_huixian", name: "草蛇灰线", formula: "前文埋线后文显形，回收有因果" },
      { id: "info_gradient", name: "信息梯度释放", formula: "逐步揭示信息，控制节奏" },
      { id: "beimian_fufen", name: "背面傅粉", formula: "写表面动作，衬出人物底细，不点破" },
      { id: "delay_satisfaction", name: "延迟满足", formula: "先压抑后释放，制造对比张力" }
    ]
  },
  {
    name: "daily_life",
    description: "日常生活场景",
    file: "daily_life.json",
    tags: ["routine", "character", "relationship"],
    recommended_techniques: [
      { id: "dialogue_subtext", name: "对话潜文本", formula: "表面话语下的真实意图" },
      { id: "sensory_baimiao", name: "感官白描", formula: "用最少字写出可见画面，不堆形容词" },
      { id: "hengyun_duanfeng", name: "横云断峰", formula: "事写到要紧处突然切线，张力翻倍" }
    ]
  },
  {
    name: "faction_conflict",
    description: "阵营冲突场景",
    file: "faction_conflict.json",
    tags: ["group", "power", "politics"],
    recommended_techniques: [
      { id: "emotion_reversal", name: "情绪反转", formula: "预期与现实的反差制造惊喜" },
      { id: "dialogue_subtext", name: "对话潜文本", formula: "表面话语下的真实意图" },
      { id: "info_gradient", name: "信息梯度释放", formula: "逐步揭示信息，控制节奏" }
    ]
  },
  {
    name: "gamble",
    description: "博弈/计谋场景",
    file: "gamble.json",
    tags: ["strategy", "deception", "information"],
    recommended_techniques: [
      { id: "dialogue_subtext", name: "对话潜文本", formula: "表面话语下的真实意图" },
      { id: "caoshe_huixian", name: "草蛇灰线", formula: "前文埋线后文显形，回收有因果" },
      { id: "info_gradient", name: "信息梯度释放", formula: "逐步揭示信息，控制节奏" }
    ]
  },
  {
    name: "cliffhanger",
    description: "悬念结尾场景",
    file: "cliffhanger.json",
    tags: ["suspense", "hook", "ending"],
    recommended_techniques: [
      { id: "suspense_setting", name: "悬念设置", formula: "制造疑问，吸引继续阅读" },
      { id: "emotion_reversal", name: "情绪反转", formula: "预期与现实的反差制造惊喜" },
      { id: "tawei", name: "獭尾", formula: "收束后补一小段余波，落在动作物件上" }
    ]
  },
  {
    name: "romance",
    description: "情感场景",
    file: "romance.json",
    tags: ["emotion", "relationship", "tension"],
    recommended_techniques: [
      { id: "emotion_undercurrent", name: "情感暗涌", formula: "表面平静下的情感暗流" },
      { id: "dialogue_subtext", name: "对话潜文本", formula: "表面话语下的真实意图" },
      { id: "sensory_baimiao", name: "感官白描", formula: "用最少字写出可见画面，不堆形容词" }
    ]
  },
  {
    name: "sacrifice",
    description: "牺牲/悲壮场景",
    file: "sacrifice.json",
    tags: ["tragedy", "cost", "heroism"],
    recommended_techniques: [
      { id: "emotion_burst", name: "情感爆发", formula: "压抑后的情感宣泄" },
      { id: "beimian_fufen", name: "背面傅粉", formula: "写表面动作，衬出人物底细，不点破" },
      { id: "delay_satisfaction", name: "延迟满足", formula: "先压抑后释放，制造对比张力" }
    ]
  },
  {
    name: "face_slapping",
    description: "打脸爽点场景",
    file: "face_slapping.json",
    tags: ["revenge", "triumph", "satisfaction"],
    recommended_techniques: [
      { id: "emotion_reversal", name: "情绪反转", formula: "预期与现实的反差制造惊喜" },
      { id: "sensory_baimiao", name: "感官白描", formula: "用最少字写出可见画面，不堆形容词" },
      { id: "dialogue_subtext", name: "对话潜文本", formula: "表面话语下的真实意图" }
    ]
  },
  {
    name: "team_gathering",
    description: "团队集结场景",
    file: "team_gathering.json",
    tags: ["team", "alliance", "strength"],
    recommended_techniques: [
      { id: "dialogue_subtext", name: "对话潜文本", formula: "表面话语下的真实意图" },
      { id: "sensory_baimiao", name: "感官白描", formula: "用最少字写出可见画面，不堆形容词" },
      { id: "hengyun_duanfeng", name: "横云断峰", formula: "事写到要紧处突然切线，张力翻倍" }
    ]
  }
];

/**
 * 获取所有可用场景列表
 */
export function getAvailableScenes(): SceneMeta[] {
  return SCENE_METADATA;
}

/**
 * 获取指定场景的元数据
 */
export function getSceneMeta(sceneName: string): SceneMeta | undefined {
  return SCENE_METADATA.find(s => s.name === sceneName);
}

/**
 * 获取指定场景的推荐技法列表
 */
export function getTechniquesForScene(sceneName: string): SceneTechnique[] {
  const meta = getSceneMeta(sceneName);
  return meta?.recommended_techniques || [
    { id: "sensory_baimiao", name: "感官白描", formula: "用最少字写出可见画面，不堆形容词" },
    { id: "hengyun_duanfeng", name: "横云断峰", formula: "事写到要紧处突然切线，张力翻倍" },
    { id: "beimian_fufen", name: "背面傅粉", formula: "写表面动作，衬出人物底细，不点破" }
  ];
}
