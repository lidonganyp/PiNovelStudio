/**
 * Phase 6.1 eval-only：从 BaselineScenario 派生 LongTermStateSnapshot。
 *
 * 当前 eval runner 的临时 workspace 只写入 legacy 状态文件（narrative-state.json），
 * 不写入 narrative-state-store.json（四类长期状态权威文件）。因此 ContextCompiler
 * 返回的 longTermState 为 null。
 *
 * 本模块从 BaselineScenario 的 workspace 数据（skeleton/narrativeState/arcRegistry/
 * unsettledDetails）派生模拟的 LongTermStateSnapshot，使 A/B/C 三组能测量长期状态
 * 注入对模型工具选择和证据覆盖的影响。
 *
 * 设计原则：
 * - 派生的状态数据必须与场景的 mustVerify 项相关（否则注入也无意义）
 * - 状态来源章节为历史章节（sourceChapter < currentChapter），遵循 FUTURE-STATE-ISOLATION
 * - 每类状态至少 8 条，确保 maxItems 缩减（4→2、6→3）确实截断条目
 * - 摘要文本足够长（canon padding ≥800 字符、character padding ≥400 字符），
 *   确保 maxChars 缩减（2400→1200、1800→900）确实截断文本
 *
 * Phase 6.2 扩充：生成 padding 条目（附加细节/背景扩展），使 maxItems 和 maxChars
 * 单因素消融的限制确实生效。padding 条目不包含 mustVerify 关键词，避免干扰覆盖检测。
 * character padding 统一使用主角名（characters[0]）避免被 relevantNames 过滤。
 */

import type { LongTermStateSnapshot } from "../../v2/core/types.js";
import type { BaselineScenario } from "./tool-interface-baseline.js";

/**
 * 从 BaselineScenario 派生模拟的 LongTermStateSnapshot。
 * 若场景无历史章节或无可用状态数据，返回 null（C 组行为）。
 */
export function deriveSnapshotFromScenario(scenario: BaselineScenario): LongTermStateSnapshot | null {
  const ws = scenario.workspace;
  const historicalCount = ws.historicalChapters.length;
  if (historicalCount === 0) return null;

  // 用最后一个历史章节作为"当前章"前一章
  const lastChapterNum = ws.historicalChapters[historicalCount - 1].number;
  const sourceChapter = `ch${lastChapterNum}`;

  // ── CanonState：从 skeleton.events 派生确立事实 + padding ──
  const baseCanon = ws.skeleton.events.slice(0, 6).map((evt, i) => ({
    id: `canon-${scenario.id}-${i}`,
    fact: `${evt.summary}（${evt.location}）`,
    category: evt.type.includes("time") ? "timeline" : evt.type.includes("location") ? "location" : "entity",
    sourceChapter,
  }));
  // Padding 条目：扩充到至少 8 条，每条附带详细描述使总字符超过 2400
  // Phase 6.2 D_sl 扩充：每条 padding 约 800 字符，使前 4 条总字符 > 2400，
  // 让 A(maxChars=2400) 和 D_sl(maxChars=1200) 都触发 maxChars 截断
  const canonPadTemplates = [
    "该区域地理环境复杂涉及多处地标性建筑与历史遗迹为故事提供了丰富的空间维度参考",
    "相关人物关系网络中存在多条潜在线索链每条线索链连接不同势力集团的核心利益",
    "时间线上存在若干关键节点这些节点与主线剧情的推进节奏紧密关联相互交织",
    "世界规则中包含若干约束条件这些条件影响角色行动范围与决策路径形成闭环",
    "物品体系中存在多件关键道具每件道具承载不同的叙事功能与象征意义互为表里",
    "势力格局中各方力量对比微妙平衡任何一方行动都可能引发连锁反应波及全局",
  ];
  const canonPadding = canonPadTemplates.map((tpl, idx) => ({
    id: `canon-${scenario.id}-pad${idx + 1}`,
    fact: `${tpl}${"（详细的背景设定补充描述用于扩充字符数以触发 maxChars 截断阈值，包含地理环境、人物关系、时间线、世界规则、物品体系、势力格局等多维度信息）".repeat(6)}`,
    category: "entity" as const,
    sourceChapter,
  }));
  const canon = [...baseCanon, ...canonPadding];

  // ── CharacterState：从 narrativeState.characterUpdates 派生 + padding ──
  const baseCharacter = ws.narrativeState.characterUpdates.map((cu, i) => ({
    id: `char-${scenario.id}-${i}`,
    characterId: cu.name,
    field: cu.field,
    value: cu.value,
    sourceChapter,
  }));
  // Padding 条目：扩充到至少 8 条，使 maxItems 6→3 截断生效
  // Phase 6.2 D_sl 扩充：每条 padding 约 400 字符，使前 6 条总字符 > 1800，
  // 让 A(maxChars=1800) 和 D_sl(maxChars=900) 都触发 maxChars 截断
  // 统一使用主角名（characters[0]）避免被 relevantNames 过滤
  const mainCharName = ws.config.characters[0]?.name ?? "主角";
  const charPadTemplates = [
    { field: "background", value: "出身于没落世家年少时经历家族变故性格内敛但意志坚定" },
    { field: "relationship", value: "与主角存在复杂的恩怨纠葛既有合作关系也有潜在的利益冲突" },
    { field: "ability", value: "擅长情报收集与分在组织中担任谋士角色掌握多条暗线信息" },
    { field: "motivation", value: "暗中追求自身利益最大化表面忠诚实则有自己的盘算与布局" },
    { field: "secret", value: "隐藏着一段不为人知的过去这段经历直接影响其在当前事件中的立场" },
    { field: "growth", value: "在近期事件中展现出超越预期的决断力引起了上层关注与资源倾斜" },
    { field: "limitation", value: "存在一个致命的能力短板在特定环境下会完全失效难以弥补" },
  ];
  const charPadding = charPadTemplates.map((tpl, idx) => ({
    id: `char-${scenario.id}-pad${idx + 1}`,
    characterId: mainCharName,
    field: tpl.field,
    value: `${tpl.value}${"（详细的角色状态补充描述用于扩充字符数以触发 maxChars 截断阈值，包含背景、关系、能力、动机、秘密、成长、限制等多维度信息）".repeat(3)}`,
    sourceChapter,
  }));
  const character = [...baseCharacter, ...charPadding];

  // ── PromiseLedger：从 arcRegistry.foreshadowings + arcs 派生 ──
  const promise = [
    ...ws.arcRegistry.foreshadowings.map((fs, i) => ({
      id: `promise-${scenario.id}-${i}`,
      promiseId: fs.id,
      description: fs.description,
      status: (fs.status ?? "open") as "open" | "advancing" | "fulfilled" | "broken",
      currentHeat: fs.level === "high" ? 8 : fs.level === "medium" ? 5 : 3,
      sourceChapter,
    })),
    ...ws.arcRegistry.arcs.map((arc, i) => ({
      id: `arc-${scenario.id}-${i}`,
      promiseId: arc.arcId,
      description: `${arc.name}${arc.coreQuestion ? `：${arc.coreQuestion}` : ""}`,
      status: (arc.status === "closed" ? "fulfilled" : "open") as "open" | "advancing" | "fulfilled" | "broken",
      currentHeat: arc.priority === "high" ? 7 : 4,
      sourceChapter,
    })),
  ];

  // ── PatternMemory：从历史章节文本派生简化模式 ──
  // 从历史章节标题和内容中提取简单模式标记
  const pattern = ws.historicalChapters.slice(0, 4).map((ch, i) => ({
    id: `pattern-${scenario.id}-${i}`,
    patternType: i % 2 === 0 ? "hook_type" : "trope",
    description: `${ch.title}中的叙事节奏模式`,
    occurrenceCount: i + 1,
    sourceChapter: `ch${ch.number}`,
  }));

  // ── Expectation：从 unsettledDetails 派生读者期待 ──
  const expectation = ws.unsettledDetails.slice(0, 4).map((ud, i) => ({
    id: `exp-${scenario.id}-${i}`,
    expectationId: ud.id,
    description: ud.description,
    expectationType: ud.type,
    targetReaderExperience: undefined,
    delayReason: undefined,
    status: (ud.status ?? "open") as "open" | "advanced" | "delayed" | "escalated" | "fulfilled",
    sourceChapter: ud.chapterId ?? sourceChapter,
    sourceRef: undefined,
  }));

  // 空状态检查
  if (canon.length === 0 && character.length === 0 && promise.length === 0 && pattern.length === 0) {
    return null;
  }

  return {
    canon,
    character,
    promise,
    pattern,
    expectation: expectation.length > 0 ? expectation : undefined,
    lastCommittedChapter: sourceChapter,
    sourceIds: ["narrative-state-store.json"],
    retrievalReport: null,
    promptItems: [], // 由 compressed-context-builder.buildContextBlock 直接从快照构建
    overdueAlerts: [],
    planned: undefined,
  };
}
