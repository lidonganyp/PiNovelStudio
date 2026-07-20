/**
 * NovelOS M1 评测 — 6 个 Fixture 定义（Step 6.1）
 *
 * 每个 fixture 构造一个独立的 workspace 场景，测量 NovelOS 的检索/验证/修复能力。
 *
 * Fixture 清单（计划 §Phase 9）：
 * 1. fact_retrieval：历史章节存在关键事实，初始 prompt 未提供
 * 2. knowledge_boundary：人物知识边界易错
 * 3. continuity_conflict：时间/空间连续性冲突
 * 4. negative_control：无需检索的简单章节（负控）
 * 5. adversarial_retrieval：检索结果含相似但错误事实（对抗）
 * 6. voice_damage：verifier 修复可能损伤声音（对抗）
 *
 * 设计原则：
 * - 历史章节正文包含可被 searchChapterSpan 检索到的事实片段
 * - NarrativeState 包含可被 queryCanon/queryCharacterState 检索到的事实
 * - candidateWithErrors 包含已知错误，可验证 verifier precision/recall
 * - healthyCandidate 无错误，可验证 verifier 不误报
 */

import type { EvalFixture } from "./eval-types.js";

// ============================================================================
// Fixture 1：历史章节存在关键事实，初始 prompt 未提供
// ============================================================================

const fixture1: EvalFixture = {
  id: "F1-historical-fact",
  name: "历史章节关键事实检索",
  description:
    `第3章需要引用第1章中提到的「青鱼嘴暗流」和「老周的潜水装备」。这些事实只在历史章节正文中出现，不在 CompiledContext 的 seed facts 中。B1（无检索）会遗漏，B2（检索）应找到。`,
  category: "fact_retrieval",
  workspace: {
    workspaceId: "eval-f1",
    config: {
      novelType: "现代悬疑",
      characters: [
        { name: "林川", role: "主角" },
        { name: "苏婉", role: "女主" },
        { name: "老周", role: "配角" },
      ],
    },
    historicalChapters: [
      {
        number: 1,
        title: "第一章 青鱼嘴",
        text: [
          "林川站在青鱼嘴水域的岸边，盯着浑浊的水面。",
          `老周走过来，拍了拍他的肩膀：「这水底有暗流，一般人下去就上不来了。」`,
          "老周从背包里拿出一套老旧的潜水装备，递给林川。",
          `「这是我当年用过的，氧气瓶只能撑二十分钟。」`,
          "林川接过装备，检查了一遍。面罩有裂纹，但还能用。",
          "苏婉在远处打电话，似乎在联系救援队。",
        ].join("\n"),
      },
      {
        number: 2,
        title: "第二章 下水",
        text: [
          "林川穿戴好老周给的潜水装备，跳进青鱼嘴。",
          "水下果然有暗流，他用力蹬水才稳住身体。",
          "氧气瓶的指针在缓慢下降，他知道自己时间不多。",
        ].join("\n"),
      },
    ],
    narrativeState: {
      canon: [
        {
          id: "canon:qingyuzui-current",
          fact: "青鱼嘴水域有暗流",
          category: "entity",
          sourceChapter: "ch1",
          sourceRef: "ch1#final.md",
          confidence: 0.9,
        },
      ],
      character: [
        {
          id: "character:laozhou-equipment",
          characterId: "老周",
          field: "equipment",
          value: "老旧潜水装备，氧气瓶20分钟",
          sourceChapter: "ch1",
          sourceRef: "ch1#final.md",
          confidence: 0.9,
        },
      ],
    },
  },
  chapterIntent: {
    chapterNumber: 3,
    chapterId: "ch3",
    relevantCharacters: ["林川", "苏婉", "老周"],
    inviolableFacts: ["青鱼嘴水域有暗流"],
    retrievalQueries: ["青鱼嘴", "暗流", "老周", "潜水装备", "氧气瓶"],
  },
  expected: {
    factsRetrievable: [
      "青鱼嘴水域有暗流",
      "老周有潜水装备",
      "氧气瓶只能撑二十分钟",
      "面罩有裂纹",
    ],
    factsInCompiledContext: ["青鱼嘴水域有暗流"], // 在 canon 中
    requiresRetrieval: true,
    candidateWithErrors: [
      "林川跳进青鱼嘴，水面平静无波。", // 错误：遗漏暗流
      "他没有任何装备，直接潜入水底。", // 错误：遗漏老周的装备
      "他在水下待了一个小时，搜遍了整个水域。", // 错误：氧气瓶只有20分钟
    ].join("\n"),
    expectedVerifierFindings: [
      "遗漏暗流事实",
      "遗漏潜水装备事实",
      "时间矛盾（氧气瓶20分钟 vs 1小时）",
    ],
    healthyCandidate: [
      "林川穿戴好老周给的潜水装备，跳进青鱼嘴。",
      "水下暗流拉扯着他的腿，他用力蹬水才稳住身体。",
      "氧气瓶的指针在缓慢下降，二十分钟是他全部的时间。",
    ].join("\n"),
  },
};

// ============================================================================
// Fixture 2：人物知识边界易错
// ============================================================================

const fixture2: EvalFixture = {
  id: "F2-knowledge-boundary",
  name: "人物知识边界检查",
  description:
    `第3章从苏婉视角展开。苏婉在第1-2章不在场，不知道「林川有潜水装备」和「水下有暗流」。如果生成正文让苏婉知道这些 → verifier 应标记知识边界违规。`,
  category: "knowledge_boundary",
  workspace: {
    workspaceId: "eval-f2",
    config: {
      novelType: "现代悬疑",
      characters: [
        { name: "林川", role: "主角" },
        { name: "苏婉", role: "女主" },
        { name: "老周", role: "配角" },
      ],
    },
    historicalChapters: [
      {
        number: 1,
        title: "第一章 密谈",
        text: [
          "林川和老周在船舱里密谈。",
          `「水下有暗流，我给你一套潜水装备。」老周低声说。`,
          "苏婉此时在岸上的车里睡觉，完全不知道他们的谈话内容。",
        ].join("\n"),
      },
      {
        number: 2,
        title: "第二章 分开行动",
        text: [
          "林川拿着装备去了青鱼嘴，苏婉则被安排去镇上买补给。",
          "苏婉在镇上逛了一天，对水下的事一无所知。",
        ].join("\n"),
      },
    ],
    narrativeState: {
      character: [
        {
          id: "character:suwan-knowledge-boundary",
          characterId: "苏婉",
          field: "knowledgeBoundary",
          value: "不知道林川有潜水装备；不知道水下有暗流；不知道老周的安排",
          sourceChapter: "ch1",
          sourceRef: "ch1#final.md",
          confidence: 0.9,
        },
        {
          id: "character:linchuan-knowledge",
          characterId: "林川",
          field: "knowledge",
          value: "知道水下暗流；有老周给的潜水装备",
          sourceChapter: "ch1",
          sourceRef: "ch1#final.md",
          confidence: 0.9,
        },
      ],
    },
  },
  chapterIntent: {
    chapterNumber: 3,
    chapterId: "ch3",
    relevantCharacters: ["苏婉", "林川"],
    inviolableFacts: ["苏婉不知道水下暗流和潜水装备"],
    retrievalQueries: ["苏婉", "知识", "暗流", "潜水装备"],
  },
  expected: {
    factsRetrievable: [
      "苏婉不知道林川有潜水装备",
      "苏婉不知道水下有暗流",
      "苏婉在镇上买补给",
    ],
    factsInCompiledContext: ["苏婉不知道水下暗流和潜水装备"],
    requiresRetrieval: true,
    candidateWithErrors: [
      "苏婉看着青鱼嘴的水面，心想：水下有暗流，林川的潜水装备不知道够不够用。", // 错误：苏婉不应知道暗流和装备
      "她回忆起老周给林川装备的场景。", // 错误：苏婉不在场
    ].join("\n"),
    expectedVerifierFindings: [
      "苏婉知识边界违规：知道暗流",
      "苏婉知识边界违规：知道潜水装备",
      "苏婉回忆不在场场景",
    ],
    healthyCandidate: [
      "苏婉在镇上的小店里挑着罐头，心里惦记着林川。",
      "她不知道林川此刻正在青鱼嘴的水下，也不知道那水底有多危险。",
      `她只知道林川说「今天有事」，让她先来买补给。`,
    ].join("\n"),
  },
};

// ============================================================================
// Fixture 3：时间/空间连续性冲突
// ============================================================================

const fixture3: EvalFixture = {
  id: "F3-continuity-conflict",
  name: "时间空间连续性冲突",
  description:
    "第3章紧接第2章。第2章结尾林川在青鱼嘴水下，苏婉在镇上。第3章如果让林川瞬间出现在镇上，或让苏婉瞬间出现在水下 → verifier 应标记空间跳转。如果第3章时间回退到第2章之前 → 时间冲突。",
  category: "continuity_conflict",
  workspace: {
    workspaceId: "eval-f3",
    config: {
      novelType: "现代悬疑",
      characters: [
        { name: "林川", role: "主角" },
        { name: "苏婉", role: "女主" },
      ],
    },
    historicalChapters: [
      {
        number: 1,
        title: "第一章 出发",
        text: [
          "早上八点，林川从家里出发前往青鱼嘴。",
          "苏婉则开车去了镇上，预计下午三点回来。",
        ].join("\n"),
      },
      {
        number: 2,
        title: "第二章 水下",
        text: [
          "上午十点，林川跳进青鱼嘴水域。",
          "他在水下摸索前进，氧气瓶的指针在缓慢下降。",
          "此时苏婉还在镇上，正在小店里买东西。",
          "时间接近中午十二点。",
        ].join("\n"),
      },
    ],
    narrativeState: {
      canon: [
        {
          id: "canon:timeline-ch2",
          fact: "第2章时间：上午十点到中午十二点",
          category: "timeline",
          sourceChapter: "ch2",
          sourceRef: "ch2#final.md",
          confidence: 0.9,
        },
        {
          id: "canon:location-linchuan-ch2",
          fact: "第2章结尾林川位置：青鱼嘴水下",
          category: "location",
          sourceChapter: "ch2",
          sourceRef: "ch2#final.md",
          confidence: 0.9,
        },
        {
          id: "canon:location-suwan-ch2",
          fact: "第2章结尾苏婉位置：镇上",
          category: "location",
          sourceChapter: "ch2",
          sourceRef: "ch2#final.md",
          confidence: 0.9,
        },
      ],
    },
  },
  chapterIntent: {
    chapterNumber: 3,
    chapterId: "ch3",
    relevantCharacters: ["林川", "苏婉"],
    inviolableFacts: ["第2章结尾林川在青鱼嘴水下", "第2章结尾苏婉在镇上"],
    retrievalQueries: ["林川", "苏婉", "位置", "时间", "青鱼嘴", "镇上"],
  },
  expected: {
    factsRetrievable: [
      "第2章结尾林川在青鱼嘴水下",
      "第2章结尾苏婉在镇上",
      "第2章时间是上午十点到中午十二点",
    ],
    factsInCompiledContext: [
      "第2章结尾林川在青鱼嘴水下",
      "第2章结尾苏婉在镇上",
    ],
    requiresRetrieval: true,
    candidateWithErrors: [
      "林川从青鱼嘴的水里爬上来，立刻开车去了镇上找苏婉。", // 错误：空间跳转（水下→镇上无过门）
      "此时是上午九点，阳光刚刚升起。", // 错误：时间回退（第2章已到十二点）
      "苏婉正在青鱼嘴岸边等他。", // 错误：苏婉位置冲突（应在镇上）
    ].join("\n"),
    expectedVerifierFindings: [
      "空间跳转：林川从水下瞬间到镇上",
      "时间回退：第3章时间早于第2章",
      "位置冲突：苏婉应在镇上，不在青鱼嘴",
    ],
    healthyCandidate: [
      "林川从青鱼嘴的水里爬上岸，大口喘着气。",
      "他看了眼手表，已经是中午十二点半了。",
      `他掏出手机给苏婉发了个消息：「我上岸了，你在哪？」`,
      `苏婉回复：「还在镇上，三点左右回去。」`,
    ].join("\n"),
  },
};

// ============================================================================
// Fixture 4：无需检索的简单章节（负控）
// ============================================================================

const fixture4: EvalFixture = {
  id: "F4-simple-negative",
  name: "简单章节负控",
  description:
    "第1章，全新故事开始。所有必要事实都在 ChapterSeed/CompiledContext 中，不需要检索历史章节。B1 和 B2 应表现相当（无检索增益）。verifier 在健康候选上不应误报。",
  category: "negative_control",
  workspace: {
    workspaceId: "eval-f4",
    config: {
      novelType: "都市",
      characters: [{ name: "陈默", role: "主角" }],
    },
    historicalChapters: [],
    narrativeState: {},
  },
  chapterIntent: {
    chapterNumber: 1,
    chapterId: "ch1",
    relevantCharacters: ["陈默"],
    inviolableFacts: ["陈默是程序员", "故事发生在上海"],
    retrievalQueries: [], // 第1章无需检索
  },
  expected: {
    factsRetrievable: [],
    factsInCompiledContext: ["陈默是程序员", "故事发生在上海"],
    requiresRetrieval: false,
    candidateWithErrors: [
      "陈默坐在北京的办公室里，敲着 Java 代码。", // 错误：地点冲突（应在上海）
    ].join("\n"),
    expectedVerifierFindings: ["地点冲突：应在上海，不是北京"],
    healthyCandidate: [
      "陈默坐在上海陆家嘴的办公室里，盯着屏幕上的代码。",
      "窗外是黄浦江的夜景，灯光倒映在水面上。",
    ].join("\n"),
  },
};

// ============================================================================
// Fixture 5：检索结果含相似但错误事实（对抗）
// ============================================================================

const fixture5: EvalFixture = {
  id: "F5-adversarial-wrong",
  name: "对抗性错误检索",
  description:
    `历史章节中存在两个相似但不同的事实：「老周有蓝色潜水装备」（第1章，正确）和「老周有红色潜水装备」（第2章，是另一个角色的，被误检索到）。检索应优先返回正确事实，verifier 应检测到候选引用了错误事实。`,
  category: "adversarial_retrieval",
  workspace: {
    workspaceId: "eval-f5",
    config: {
      novelType: "现代悬疑",
      characters: [
        { name: "林川", role: "主角" },
        { name: "老周", role: "配角" },
        { name: "张三", role: "配角" },
      ],
    },
    historicalChapters: [
      {
        number: 1,
        title: "第一章 老周的装备",
        text: [
          "老周从柜子里拿出一套蓝色的潜水装备，递给林川。",
          `「这是我用了十年的老伙计了。」老周说。`,
        ].join("\n"),
      },
      {
        number: 2,
        title: "第二章 张三的装备",
        text: [
          "张三也带来了一套潜水装备，是红色的。",
          `「我的装备比老周的新多了。」张三得意地说。`,
        ].join("\n"),
      },
    ],
    narrativeState: {
      character: [
        {
          id: "character:laozhou-equipment-color",
          characterId: "老周",
          field: "equipment",
          value: "蓝色潜水装备",
          sourceChapter: "ch1",
          sourceRef: "ch1#final.md",
          confidence: 0.9,
        },
        {
          id: "character:zhangsan-equipment-color",
          characterId: "张三",
          field: "equipment",
          value: "红色潜水装备",
          sourceChapter: "ch2",
          sourceRef: "ch2#final.md",
          confidence: 0.9,
        },
      ],
    },
  },
  chapterIntent: {
    chapterNumber: 3,
    chapterId: "ch3",
    relevantCharacters: ["林川", "老周"],
    inviolableFacts: ["老周的潜水装备是蓝色的"],
    retrievalQueries: ["老周", "潜水装备", "蓝色", "红色"],
  },
  expected: {
    factsRetrievable: ["老周有蓝色潜水装备", "张三有红色潜水装备"],
    factsInCompiledContext: ["老周的潜水装备是蓝色的"],
    requiresRetrieval: true,
    candidateWithErrors: [
      "林川拿起老周的红色潜水装备，检查了一遍。", // 错误：老周的是蓝色，红色是张三的
      "他记得老周说过这是新买的。", // 错误：老周说是用了十年的
    ].join("\n"),
    expectedVerifierFindings: [
      "事实冲突：老周装备是蓝色，不是红色",
      "事实冲突：老周装备用了十年，不是新买的",
    ],
    healthyCandidate: [
      "林川拿起老周那套蓝色的潜水装备，检查了一遍。",
      "这套装备已经用了十年，有些地方磨损了，但还能用。",
    ].join("\n"),
  },
};

// ============================================================================
// Fixture 6：verifier 修复可能损伤声音（对抗）
// ============================================================================

const fixture6: EvalFixture = {
  id: "F6-voice-damage",
  name: "verifier 修复声音损伤",
  description:
    "候选正文有独特的文学声音（短句、留白、节奏感），但同时包含一个细微的事实错误。verifier 修复事实错误时不应破坏文学声音。patch 退化检查应拒绝破坏声音的 patch。",
  category: "voice_damage",
  workspace: {
    workspaceId: "eval-f6",
    config: {
      novelType: "文学",
      characters: [{ name: "阿城", role: "主角" }],
    },
    historicalChapters: [
      {
        number: 1,
        title: "第一章 山顶",
        text: [
          "阿城站在山顶。风很大。",
          "他口袋里只有三块钱。硬币。两个一块的，一个五毛的。",
          "山下是镇子。他要走下去。",
        ].join("\n"),
      },
    ],
    narrativeState: {
      canon: [
        {
          id: "canon:acheng-money",
          fact: "阿城口袋里有三块钱（两个一块硬币+一个五毛硬币）",
          category: "entity",
          sourceChapter: "ch1",
          sourceRef: "ch1#final.md",
          confidence: 0.9,
        },
      ],
    },
  },
  chapterIntent: {
    chapterNumber: 2,
    chapterId: "ch2",
    relevantCharacters: ["阿城"],
    inviolableFacts: ["阿城口袋里有三块钱"],
    retrievalQueries: ["阿城", "钱", "硬币", "三块"],
  },
  expected: {
    factsRetrievable: ["阿城有三块钱", "两个一块硬币", "一个五毛硬币"],
    factsInCompiledContext: ["阿城口袋里有三块钱"],
    requiresRetrieval: true,
    candidateWithErrors: [
      "阿城下山。路很长。",
      "他摸了摸口袋。五块钱。", // 错误：应是三块钱
      "够了。能买两个馒头。",
    ].join("\n"),
    expectedVerifierFindings: ["事实冲突：阿城有三块钱，不是五块钱"],
    healthyCandidate: [
      "阿城下山。路很长。",
      "他摸了摸口袋。三块钱。硬币碰硬币，叮当响。",
      "够了。能买馒头。",
    ].join("\n"),
  },
};

// ============================================================================
// 导出全部 fixture
// ============================================================================

export const EVAL_FIXTURES: EvalFixture[] = [
  fixture1,
  fixture2,
  fixture3,
  fixture4,
  fixture5,
  fixture6,
];
