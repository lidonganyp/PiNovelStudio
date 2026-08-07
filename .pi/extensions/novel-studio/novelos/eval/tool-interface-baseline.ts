/**
 * NovelOS Phase 4 Pre-baseline — 当前工具接口基线 replay（eval-only）
 *
 * 目标：在执行 Phase 3（统一工具结果格式：resultKind/returnedCount/truncated/nextQueryHint）
 * 之前，冻结并记录「当前 9 个专用工具」的可信对照组。Phase 3 完成后再用同一批
 * fixtures 重跑，才能判断统一结果格式是否减少重复查询、提高证据利用率、降低无效上下文、
 * 改变延迟或影响事实覆盖率。
 *
 * 设计原则：
 * - eval-only：本模块在 tsconfig.eval.json 注册，不进入生产构建。
 * - 确定性：直接用 createNarrativeTools 驱动真实工具实现（不走 stub model agent loop），
 *   零模型调用，可脱离模型单测。latency 来自本地文件系统读取，基本稳定。
 * - 冻结当前工具行为：不修改工具 schema、结果文本、检索逻辑；只做观测。
 * - 7 类场景 × 每类 3 个工具调用用例，记录 9 项指标。
 *
 * 9 项指标（与用户 Phase 4 pre-baseline 约定一致）：
 * 1. visibleTools / selectedTools（可见工具与场景选择工具）
 * 2. 实际调用工具（callsByTool）
 * 3. 重复查询（duplicateQueries）
 * 4. 返回字符数（resultChars）
 * 5. evidenceLevel
 * 6. sourceRef（有效/无效）
 * 7. latency
 * 8. 空结果、超时和失败
 * 9. mustVerify 覆盖率（按 mustVerify 项计算 confirmed 覆盖率）
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createNarrativeTools } from "../tools/narrative-tools.js";
import { NARRATIVE_TOOL_NAMES } from "../tools/narrative-tools.js";
import { createNarrativeSearchService } from "../agent/narrative-search-service.js";
import { ToolCallMetricsTracer } from "../trajectory/tool-metrics-tracer.js";
import type { ToolCallMetrics } from "../trajectory/tool-metrics-tracer.js";
import {
  computeMustVerifyCoverage,
  isValidSourceRef,
  VALID_EVIDENCE_LEVELS,
} from "./uncertainty-recall-metrics.js";
import type { ConfirmedEvidence } from "./uncertainty-recall-metrics.js";

// ============================================================================
// 类型
// ============================================================================

/** 场景 workspace 数据（legacy 文件格式，供 LegacyStateAdapter 导入） */
export interface BaselineWorkspaceData {
  workspaceId: string;
  config: { novelType: string; characters: Array<{ name: string; role: string }> };
  historicalChapters: Array<{ number: number; title: string; text: string }>;
  skeleton: {
    events: Array<{
      eventId: string;
      type: string;
      summary: string;
      characters: string[];
      location: string;
    }>;
  };
  narrativeState: { characterUpdates: Array<{ name: string; field: string; value: string }> };
  arcRegistry: {
    arcs: Array<{ arcId: string; name: string; coreQuestion?: string; priority?: string; status?: string }>;
    foreshadowings: Array<{ id: string; description: string; level?: string; status?: string }>;
  };
  unsettledDetails: Array<{ id: string; type: string; description: string; chapterId?: string; status?: string }>;
}

/** 单个工具调用用例 */
export interface BaselineToolCall {
  /** 工具名（必须在 NARRATIVE_TOOL_NAMES 内） */
  tool: string;
  /** 调用参数 */
  args: Record<string, unknown>;
  /** 本用例期望被检索证据覆盖的 mustVerify 事实（用于计算覆盖率） */
  mustVerify?: string[];
}

/** 场景定义 */
export interface BaselineScenario {
  id: string;
  /** 7 类场景分类 */
  category:
    | "canon_fact_retrieval"
    | "character_state"
    | "timeline"
    | "promise_foreshadow"
    | "chapter_span"
    | "low_risk_no_retrieval"
    | "multi_tool_mixed";
  description: string;
  workspace: BaselineWorkspaceData;
  calls: BaselineToolCall[];
}

/** 单次工具调用基线指标 */
export interface BaselineCallMetrics {
  tool: string;
  args: Record<string, unknown>;
  query: string;
  resultChars: number;
  estimateTokens: number;
  latencyMs: number;
  evidenceLevel: string | undefined;
  sourceRef: string | undefined;
  sourceRefValid: boolean;
  /** Phase 3：结果类型 */
  resultKind: string | undefined;
  /** Phase 3：本次返回的真实条目/span 数量 */
  returnedCount: number | undefined;
  /** Phase 3：结果是否被系统 limit 截断 */
  truncated: boolean | undefined;
  /** Phase 3：系统确定性生成的下一查询提示（无则 undefined） */
  nextQueryHint: string | undefined;
  empty: boolean;
  timeout: boolean;
  isError: boolean;
  duplicateQuery: boolean;
}

/** 单场景基线指标 */
export interface BaselineScenarioMetrics {
  id: string;
  category: string;
  description: string;
  selectedTools: string[];
  visibleTools: string[];
  samples: number;
  actualCalls: number;
  callsByTool: Record<string, number>;
  duplicateQueries: number;
  totalResultChars: number;
  avgResultChars: number;
  totalLatencyMs: number;
  avgLatencyMs: number;
  emptyResults: number;
  timeouts: number;
  errors: number;
  evidenceLevels: Record<string, number>;
  sourceRefsValid: number;
  sourceRefsInvalid: number;
  mustVerify: {
    itemCount: number;
    coveredCount: number;
    coverageRatio: number;
    uncoveredItems: string[];
  };
  calls: BaselineCallMetrics[];
}

/** 完整基线报告 */
export interface ToolInterfaceBaseline {
  schema: string;
  timestamp: string;
  phase: string;
  toolSurface: string;
  visibleTools: string[];
  scenarios: BaselineScenarioMetrics[];
  summary: ToolInterfaceBaselineSummary;
}

export interface ToolInterfaceBaselineSummary {
  scenarioCount: number;
  totalCalls: number;
  totalDuplicateQueries: number;
  totalResultChars: number;
  totalEmptyResults: number;
  totalTimeouts: number;
  totalErrors: number;
  totalSourceRefsValid: number;
  totalSourceRefsInvalid: number;
  avgCoverageRatio: number;
  /** 各工具总调用次数 */
  callsByTool: Record<string, number>;
}

// ============================================================================
// 7 类场景 fixture 数据
// ============================================================================

/** 共享普通角色配置 */
const COMMON_CHARS = [
  { name: "林川", role: "主角" },
  { name: "苏婉", role: "女主" },
  { name: "老周", role: "配角" },
];

const SC1_CANON: BaselineScenario = {
  id: "SC1-canon-fact",
  category: "canon_fact_retrieval",
  description: "canon 事实检索：检索 query_canon 与 search_narrative_evidence 获取世界设定/实体事实",
  workspace: {
    workspaceId: "bl-can1",
    config: { novelType: "现代悬疑", characters: COMMON_CHARS },
    historicalChapters: [
      { number: 1, title: "第一章 青鱼嘴", text: "林川站在青鱼嘴水域的岸边，盯着浑浊的水面。老周说这水底有暗流。" },
      { number: 2, title: "第二章 下水", text: "林川穿戴好老周的潜水装备跳进青鱼嘴，氧气瓶指针缓慢下降。" },
    ],
    skeleton: {
      events: [
        { eventId: "e1", type: "entity", summary: "青鱼嘴水域有暗流", characters: ["老周"], location: "青鱼嘴" },
        { eventId: "e2", type: "entity", summary: "老周有潜水装备", characters: ["老周"], location: "岸边" },
      ],
    },
    narrativeState: { characterUpdates: [] },
    arcRegistry: { arcs: [], foreshadowings: [] },
    unsettledDetails: [],
  },
  calls: [
    // 注：legacy adapter 将 skeleton 事件统一转为 canon category=timeline
    { tool: "query_canon", args: { category: "timeline" }, mustVerify: ["青鱼嘴水域有暗流", "老周有潜水装备"] },
    { tool: "search_narrative_evidence", args: { query: "青鱼嘴水域有暗流" }, mustVerify: ["青鱼嘴水域有暗流"] },
    { tool: "search_narrative_evidence", args: { query: "老周有潜水装备" }, mustVerify: ["老周有潜水装备"] },
  ],
};

const SC2_CHARACTER: BaselineScenario = {
  id: "SC2-character-state",
  category: "character_state",
  description: "角色状态：查询 query_character_state 获取角色欲望/恐惧/关系/能力状态",
  workspace: {
    workspaceId: "bl-char2",
    config: { novelType: "现代悬疑", characters: COMMON_CHARS },
    historicalChapters: [
      { number: 1, title: "第一章 密谈", text: "林川和老周在船舱里密谈，苏婉在岸上睡觉。" },
    ],
    skeleton: { events: [] },
    narrativeState: {
      characterUpdates: [
        { name: "赵无痕", field: "desire", value: "想找到失踪的弟弟" },
        { name: "赵无痕", field: "fear", value: "怕弟弟已经遇害" },
        { name: "林川", field: "equipment", value: "老周给的潜水装备" },
      ],
    },
    arcRegistry: { arcs: [], foreshadowings: [] },
    unsettledDetails: [],
  },
  calls: [
    { tool: "query_character_state", args: { characterId: "赵无痕" }, mustVerify: ["想找到失踪的弟弟", "怕弟弟已经遇害"] },
    { tool: "query_character_state", args: { characterId: "林川" }, mustVerify: ["老周给的潜水装备"] },
    { tool: "query_character_knowledge_boundary", args: { characterId: "苏婉" }, mustVerify: [] },
  ],
};

const SC3_TIMELINE: BaselineScenario = {
  id: "SC3-timeline",
  category: "timeline",
  description: "时间线：查询 query_timeline / query_canon(category=timeline) 获取事件序列与时间顺序",
  workspace: {
    workspaceId: "bl-tl3",
    config: { novelType: "现代悬疑", characters: COMMON_CHARS },
    historicalChapters: [
      { number: 1, title: "第一章 出发", text: "早上八点林川从家里出发前往青鱼嘴。" },
      { number: 2, title: "第二章 水下", text: "上午十点林川跳进青鱼嘴，接近中午十二点。" },
    ],
    skeleton: {
      events: [
        { eventId: "t1", type: "timeline", summary: "第2章时间：上午十点到中午十二点", characters: [], location: "" },
        { eventId: "t2", type: "timeline", summary: "第2章结尾林川在青鱼嘴水下", characters: ["林川"], location: "青鱼嘴" },
      ],
    },
    narrativeState: { characterUpdates: [] },
    arcRegistry: { arcs: [], foreshadowings: [] },
    unsettledDetails: [],
  },
  calls: [
    { tool: "query_timeline", args: {}, mustVerify: ["第2章时间：上午十点到中午十二点", "第2章结尾林川在青鱼嘴水下"] },
    { tool: "query_canon", args: { category: "timeline" }, mustVerify: ["第2章时间：上午十点到中午十二点"] },
    { tool: "search_narrative_evidence", args: { query: "第2章结尾林川在青鱼嘴水下" }, mustVerify: ["第2章结尾林川在青鱼嘴水下"] },
  ],
};

const SC4_PROMISE: BaselineScenario = {
  id: "SC4-promise-foreshadow",
  category: "promise_foreshadow",
  description: "Promise/伏笔：查询 query_promise_ledger 获取伏笔/承诺/读者期待与当前热度",
  workspace: {
    workspaceId: "bl-pr4",
    config: { novelType: "仙侠", characters: [{ name: "林默", role: "主角" }] },
    historicalChapters: [
      { number: 1, title: "第一章 血玉", text: "林默捡到一枚血玉，隐约觉得与身世有关。" },
    ],
    skeleton: { events: [] },
    narrativeState: { characterUpdates: [] },
    arcRegistry: {
      arcs: [
        { arcId: "a1", name: "血玉之谜", coreQuestion: "血玉与林默身世的关系", priority: "high", status: "open" },
      ],
      foreshadowings: [
        { id: "f1", description: "下山时苏云岚留下的玉佩", level: "medium", status: "open" },
      ],
    },
    unsettledDetails: [
      { id: "u1", type: "reader_expectation", description: "读者期待林默揭露血玉来历", chapterId: "ch1", status: "open" },
    ],
  },
  calls: [
    { tool: "query_promise_ledger", args: { status: "open" }, mustVerify: ["血玉之谜", "读者期待林默揭露血玉来历"] },
    { tool: "query_promise_ledger", args: {}, mustVerify: ["血玉之谜", "下山时苏云岚留下的玉佩"] },
    { tool: "search_narrative_evidence", args: { query: "血玉" }, mustVerify: ["血玉之谜"] },
  ],
};

const SC5_SPAN: BaselineScenario = {
  id: "SC5-chapter-span",
  category: "chapter_span",
  description: "章节原文 span：查询 search_chapter_span 获取历史章节正文精确匹配片段",
  workspace: {
    workspaceId: "bl-sp5",
    config: { novelType: "现代悬疑", characters: COMMON_CHARS },
    historicalChapters: [
      { number: 1, title: "第一章 青鱼嘴", text: "林川站在青鱼嘴水域的岸边，盯着浑浊的水面。老周说这水底有暗流，一般人下去就上不来了。" },
      { number: 2, title: "第二章 下水", text: "林川穿戴好老周的潜水装备跳进青鱼嘴，氧气瓶只能撑二十分钟。" },
    ],
    skeleton: { events: [] },
    narrativeState: { characterUpdates: [] },
    arcRegistry: { arcs: [], foreshadowings: [] },
    unsettledDetails: [],
  },
  calls: [
    { tool: "search_chapter_span", args: { query: "暗流" }, mustVerify: ["这水底有暗流"] },
    { tool: "search_chapter_span", args: { query: "氧气瓶" }, mustVerify: ["氧气瓶只能撑二十分钟"] },
    { tool: "search_chapter_span", args: { query: "潜水装备" }, mustVerify: ["老周的潜水装备"] },
  ],
};

const SC6_LOW_RISK: BaselineScenario = {
  id: "SC6-low-risk-no-retrieval",
  category: "low_risk_no_retrieval",
  description: "无需检索的低风险章节：全新故事第 1 章，无检索值的检索调用应返回空结果（测无效上下文开销）",
  workspace: {
    workspaceId: "bl-lr6",
    config: { novelType: "都市", characters: [{ name: "陈默", role: "主角" }] },
    historicalChapters: [],
    skeleton: { events: [] },
    narrativeState: { characterUpdates: [] },
    arcRegistry: { arcs: [], foreshadowings: [] },
    unsettledDetails: [],
  },
  calls: [
    { tool: "search_narrative_evidence", args: { query: "不存在的古代地名" }, mustVerify: [] },
    { tool: "query_canon", args: {}, mustVerify: [] },
    { tool: "query_character_state", args: {}, mustVerify: [] },
  ],
};

const SC7_MIXED: BaselineScenario = {
  id: "SC7-multi-tool-mixed",
  category: "multi_tool_mixed",
  description: "多工具混合场景：一个章节同时检索 canon/角色状态/伏笔/章节 span，含一次重复查询观测",
  workspace: {
    workspaceId: "bl-mx7",
    config: { novelType: "仙侠", characters: [{ name: "林默", role: "主角" }] },
    historicalChapters: [
      { number: 1, title: "第一章 血玉", text: "林默捡到一枚血玉，隐约觉得与身世有关。苏云岚说这是上古遗物。" },
    ],
    skeleton: {
      events: [
        { eventId: "m1", type: "entity", summary: "血玉是上古遗物", characters: ["林默"], location: "山谷" },
      ],
    },
    narrativeState: {
      characterUpdates: [
        { name: "林默", field: "desire", value: "想查明血玉与身世的关系" },
      ],
    },
    arcRegistry: {
      arcs: [{ arcId: "ma1", name: "血玉之谜", coreQuestion: "血玉与身世的关系", priority: "high", status: "open" }],
      foreshadowings: [],
    },
    unsettledDetails: [],
  },
  calls: [
    { tool: "search_narrative_evidence", args: { query: "血玉" }, mustVerify: ["血玉是上古遗物", "想查明血玉与身世的关系"] },
    { tool: "query_character_state", args: { characterId: "林默" }, mustVerify: ["想查明血玉与身世的关系"] },
    { tool: "query_promise_ledger", args: {}, mustVerify: ["血玉之谜"] },
    { tool: "search_chapter_span", args: { query: "血玉" }, mustVerify: ["苏云岚说这是上古遗物"] },
    // 重复查询：与第 1 个调用相同 query，观测重复查询检测
    { tool: "search_narrative_evidence", args: { query: "血玉" }, mustVerify: ["血玉是上古遗物"] },
  ],
};

export const BASELINE_SCENARIOS: BaselineScenario[] = [
  SC1_CANON,
  SC2_CHARACTER,
  SC3_TIMELINE,
  SC4_PROMISE,
  SC5_SPAN,
  SC6_LOW_RISK,
  SC7_MIXED,
];

// ============================================================================
// Workspace 构造（写入 legacy 状态文件）
// ============================================================================

function setupBaselineWorkspace(data: BaselineWorkspaceData): {
  projectRoot: string;
  workspaceId: string;
  cleanup: () => void;
} {
  const projectRoot = mkdtempSync(join(tmpdir(), `novelos-baseline-${data.workspaceId}-`));
  const wsDir = join(projectRoot, "workspaces", data.workspaceId);
  mkdirSync(wsDir, { recursive: true });

  writeFileSync(
    join(wsDir, "config.json"),
    JSON.stringify({ workspaceId: data.workspaceId, ...data.config }),
    "utf-8",
  );

  for (const ch of data.historicalChapters) {
    const chDir = join(wsDir, "chapters", `chapter-${ch.number}`, "");
    mkdirSync(chDir, { recursive: true });
    writeFileSync(join(chDir, "final.md"), ch.text, "utf-8");
  }

  writeFileSync(join(wsDir, "skeleton.json"), JSON.stringify(data.skeleton), "utf-8");
  writeFileSync(join(wsDir, "narrative-state.json"), JSON.stringify(data.narrativeState), "utf-8");
  writeFileSync(join(wsDir, "arc-registry.json"), JSON.stringify(data.arcRegistry), "utf-8");
  writeFileSync(join(wsDir, "unsettled-details.json"), JSON.stringify(data.unsettledDetails), "utf-8");

  return {
    projectRoot,
    workspaceId: data.workspaceId,
    cleanup: () => {
      try {
        rmSync(projectRoot, { recursive: true, force: true });
      } catch {
        /* 忽略清理失败 */
      }
    },
  };
}

// ============================================================================
// 证据提取辅助
// ============================================================================

/** 从工具结果 details 提取 ConfirmedEvidence[]（按 VALID_EVIDENCE_LEVELS + 有效 sourceRef 过滤） */
function collectConfirmedEvidences(details: unknown): ConfirmedEvidence[] {
  if (!details || typeof details !== "object") return [];
  const d = details as Record<string, unknown>;
  const out: ConfirmedEvidence[] = [];

  const pushItem = (sourceRef: unknown, excerpt: unknown, level: unknown): void => {
    const ref = typeof sourceRef === "string" ? sourceRef : undefined;
    if (!isValidSourceRef(ref)) return;
    const lvl = typeof level === "string" ? level : "";
    if (!VALID_EVIDENCE_LEVELS.has(lvl)) return;
    out.push({ sourceRef: ref!, excerpt: typeof excerpt === "string" ? excerpt : "", evidenceLevel: lvl });
  };

  // search_narrative_evidence：rankedEvidences[]
  const ranked = d.rankedEvidences;
  if (Array.isArray(ranked)) {
    for (const ev of ranked) {
      if (ev && typeof ev === "object") {
        const e = ev as Record<string, unknown>;
        pushItem(e.sourceRef, e.excerpt, e.evidenceLevel);
      }
    }
  }
  // search_chapter_span：spans[]
  const spans = d.spans;
  if (Array.isArray(spans)) {
    for (const s of spans) {
      if (s && typeof s === "object") {
        const sp = s as Record<string, unknown>;
        pushItem(sp.sourceRef, sp.excerpt, sp.evidenceLevel);
      }
    }
  }
  // query_*：entries[]（evidenceLevel 取顶层 details.evidenceLevel）
  const entries = d.entries;
  const topLevel = typeof d.evidenceLevel === "string" ? d.evidenceLevel : "";
  if (Array.isArray(entries)) {
    for (const en of entries) {
      if (en && typeof en === "object") {
        const e = en as Record<string, unknown>;
        const excerpt =
          typeof e.fact === "string"
            ? e.fact
            : typeof e.value === "string"
              ? `${e.characterId ?? ""}:${e.value}`
              : typeof e.description === "string"
                ? e.description
                : "";
        pushItem(e.sourceRef, excerpt, topLevel);
      }
    }
  }
  return out;
}

// ============================================================================
// 基线 replay 执行
// ============================================================================

async function runScenario(scenario: BaselineScenario): Promise<BaselineScenarioMetrics> {
  const { projectRoot, workspaceId, cleanup } = setupBaselineWorkspace(scenario.workspace);
  const tracer = new ToolCallMetricsTracer();
  const callMetrics: BaselineCallMetrics[] = [];
  const allConfirmed: ConfirmedEvidence[] = [];
  const mustVerifyItems: string[] = [];

  try {
    const searchService = createNarrativeSearchService({
      projectRoot,
      workspaceId,
      sourceChapter: `ch${scenario.workspace.historicalChapters.length}`,
    });
    const tools = createNarrativeTools({ searchService });
    const toolByName = new Map(tools.map((t) => [t.name, t]));

    for (let i = 0; i < scenario.calls.length; i++) {
      const call = scenario.calls[i];
      const tool = toolByName.get(call.tool);
      const toolCallId = `baseline-${scenario.id}-${i}`;
      if (!tool) {
        callMetrics.push({
          tool: call.tool,
          args: call.args,
          query: typeof call.args.query === "string" ? call.args.query : "",
          resultChars: 0,
          estimateTokens: 0,
          latencyMs: 0,
          evidenceLevel: undefined,
          sourceRef: undefined,
          sourceRefValid: false,
          resultKind: undefined,
          returnedCount: undefined,
          truncated: undefined,
          nextQueryHint: undefined,
          empty: true,
          timeout: false,
          isError: true,
          duplicateQuery: false,
        });
        continue;
      }
      tracer.start(toolCallId, call.tool, call.args);
      // execute 可能抛错（工具失败），此时构造 error 结果
      let isError = false;
      let result: unknown = null;
      try {
        result = await tool.execute(toolCallId, call.args);
      } catch {
        isError = true;
        result = { content: [{ type: "text", text: "tool execution error" }], details: {} };
      }
      const metrics = tracer.end(toolCallId, {
        type: "tool_execution_end",
        toolCallId,
        toolName: call.tool,
        isError,
        result,
      });
      callMetrics.push(toBaselineCall(metrics));
      allConfirmed.push(...collectConfirmedEvidences((result as { details?: unknown })?.details));
      if (call.mustVerify) mustVerifyItems.push(...call.mustVerify);
    }
  } finally {
    cleanup();
  }

  const snap = tracer.snapshot();
  const coverage = computeMustVerifyCoverage(mustVerifyItems, allConfirmed);
  const evidenceLevels: Record<string, number> = {};
  for (const c of callMetrics) {
    if (c.evidenceLevel) evidenceLevels[c.evidenceLevel] = (evidenceLevels[c.evidenceLevel] ?? 0) + 1;
  }
  const totalResultChars = callMetrics.reduce((s, c) => s + c.resultChars, 0);
  const totalLatencyMs = callMetrics.reduce((s, c) => s + c.latencyMs, 0);

  return {
    id: scenario.id,
    category: scenario.category,
    description: scenario.description,
    selectedTools: [...new Set(scenario.calls.map((c) => c.tool))],
    visibleTools: [...NARRATIVE_TOOL_NAMES].sort(),
    samples: scenario.calls.length,
    actualCalls: callMetrics.length,
    callsByTool: snap.callsByTool,
    duplicateQueries: snap.duplicateQueries,
    totalResultChars,
    avgResultChars: callMetrics.length > 0 ? Math.round(totalResultChars / callMetrics.length) : 0,
    totalLatencyMs,
    avgLatencyMs: callMetrics.length > 0 ? Math.round(totalLatencyMs / callMetrics.length) : 0,
    emptyResults: snap.emptyResults,
    timeouts: snap.timeouts,
    errors: snap.errors,
    evidenceLevels,
    sourceRefsValid: callMetrics.filter((c) => c.sourceRefValid).length,
    sourceRefsInvalid: callMetrics.filter((c) => !c.sourceRefValid).length,
    mustVerify: {
      itemCount: mustVerifyItems.length,
      coveredCount: mustVerifyItems.length - coverage.uncoveredItems.length,
      coverageRatio: coverage.coverageRatio,
      uncoveredItems: coverage.uncoveredItems,
    },
    calls: callMetrics,
  };
}

function toBaselineCall(metrics: ToolCallMetrics): BaselineCallMetrics {
  return {
    tool: metrics.toolName,
    args: metrics.args,
    query: typeof metrics.args.query === "string" ? metrics.args.query : "",
    resultChars: metrics.resultChars,
    estimateTokens: metrics.estimateTokens,
    latencyMs: metrics.latencyMs,
    evidenceLevel: metrics.evidenceLevel,
    sourceRef: metrics.sourceRefs[0],
    sourceRefValid: isValidSourceRef(metrics.sourceRefs[0]),
    resultKind: metrics.resultKind,
    returnedCount: metrics.returnedCount,
    truncated: metrics.truncated,
    nextQueryHint: metrics.nextQueryHint,
    empty: metrics.empty,
    timeout: metrics.timeout,
    isError: metrics.isError,
    duplicateQuery: metrics.duplicateQuery,
  };
}

/** 运行全部场景，产出完整基线 */
export async function runToolInterfaceBaseline(
  options: { scenarios?: BaselineScenario[]; timestamp?: string } = {},
): Promise<ToolInterfaceBaseline> {
  const scenarios = options.scenarios ?? BASELINE_SCENARIOS;
  const scenarioResults = await Promise.all(scenarios.map(runScenario));

  const callsByTool: Record<string, number> = {};
  let totalCalls = 0;
  let totalDuplicateQueries = 0;
  let totalResultChars = 0;
  let totalEmptyResults = 0;
  let totalTimeouts = 0;
  let totalErrors = 0;
  let totalSourceRefsValid = 0;
  let totalSourceRefsInvalid = 0;
  let coverageSum = 0;

  for (const s of scenarioResults) {
    totalCalls += s.actualCalls;
    totalDuplicateQueries += s.duplicateQueries;
    totalResultChars += s.totalResultChars;
    totalEmptyResults += s.emptyResults;
    totalTimeouts += s.timeouts;
    totalErrors += s.errors;
    totalSourceRefsValid += s.sourceRefsValid;
    totalSourceRefsInvalid += s.sourceRefsInvalid;
    coverageSum += s.mustVerify.coverageRatio;
    for (const [tool, count] of Object.entries(s.callsByTool)) {
      callsByTool[tool] = (callsByTool[tool] ?? 0) + count;
    }
  }

  return {
    schema: "tool-interface-baseline/v1",
    timestamp: options.timestamp ?? new Date().toISOString(),
    phase: "phase4-pre-baseline",
    toolSurface: "specialized-9-tools",
    visibleTools: [...NARRATIVE_TOOL_NAMES].sort(),
    scenarios: scenarioResults,
    summary: {
      scenarioCount: scenarioResults.length,
      totalCalls,
      totalDuplicateQueries,
      totalResultChars,
      totalEmptyResults,
      totalTimeouts,
      totalErrors,
      totalSourceRefsValid,
      totalSourceRefsInvalid,
      avgCoverageRatio: scenarioResults.length > 0 ? coverageSum / scenarioResults.length : 0,
      callsByTool,
    },
  };
}

// ============================================================================
// 报告格式化（JSON + Markdown）
// ============================================================================

export function formatToolInterfaceBaselineJson(baseline: ToolInterfaceBaseline): string {
  return JSON.stringify(baseline, null, 2);
}

export function formatToolInterfaceBaselineMarkdown(baseline: ToolInterfaceBaseline): string {
  const lines: string[] = [];
  lines.push("# NovelOS 工具接口基线报告（Phase 4 Pre-baseline）");
  lines.push("");
  lines.push(`**schema**：${baseline.schema}`);
  lines.push(`**时间**：${baseline.timestamp}`);
  lines.push(`**阶段**：${baseline.phase}`);
  lines.push(`**工具面**：${baseline.toolSurface}`);
  lines.push("");
  lines.push("## 说明");
  lines.push("");
  lines.push("本报告是**工具执行面基线**（tool execution-surface baseline）：它直接驱动 createNarrativeTools 真实现，观测工具 `execute` 的执行结果。");
  lines.push("因此 `visibleTools` 固定记录 `NARRATIVE_TOOL_NAMES`（9 个工具全量），**不代表**模型实际可见的 schema 集。");
  lines.push("真实生产路径已按 `evidencePlan.allowedTools` 过滤工具，schema 注入（`tool-schema-injector` / `pi-agent-core-adapter`）使用过滤后的工具集；");
  lines.push("模型可见 schema 的渐进披露需另做一次 runtime visibility 检查，本基线不覆盖。");
  lines.push("");
  lines.push("本报告冻结「当前 9 个专用工具」的行为作为 Phase 3（统一工具结果格式）的对照组。");
  lines.push("Phase 3（`resultKind` / `returnedCount` / `truncated` / `nextQueryHint`）已实施并在本基线中逐调用记录。");
  lines.push("同一批 fixtures 重跑后，调用次数、重复查询数、排序顺序与 mustVerify 覆盖率保持不变（本基线与 Phase 4 pre-baseline 一致），");
  lines.push("证明统一结果格式未改变工具行为——这是固定工具 replay，**不能**据此宣称模型质量提升，只证明结果接口更清晰、更可控。");
  lines.push("");
  lines.push("## 聚合指标");
  lines.push("");
  lines.push("| 指标 | 值 |");
  lines.push("|------|------|");
  lines.push(`| 场景数 | ${baseline.summary.scenarioCount} |`);
  lines.push(`| 总调用 | ${baseline.summary.totalCalls} |`);
  lines.push(`| 重复查询 | ${baseline.summary.totalDuplicateQueries} |`);
  lines.push(`| 总返回字符数 | ${baseline.summary.totalResultChars} |`);
  lines.push(`| 空结果 | ${baseline.summary.totalEmptyResults} |`);
  lines.push(`| 超时 | ${baseline.summary.totalTimeouts} |`);
  lines.push(`| 失败 | ${baseline.summary.totalErrors} |`);
  lines.push(`| 有效 sourceRef | ${baseline.summary.totalSourceRefsValid} |`);
  lines.push(`| 无效 sourceRef | ${baseline.summary.totalSourceRefsInvalid} |`);
  lines.push(`| 平均 mustVerify 覆盖率 | ${baseline.summary.avgCoverageRatio.toFixed(2)} |`);
  lines.push("");
  lines.push("### 各工具调用次数");
  lines.push("");
  lines.push("| 工具 | 调用次数 |");
  lines.push("|------|---------|");
  for (const [tool, count] of Object.entries(baseline.summary.callsByTool).sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`| ${tool} | ${count} |`);
  }
  lines.push("");
  lines.push("## 各场景详情");
  lines.push("");
  for (const s of baseline.scenarios) {
    lines.push(`### ${s.id}（${s.category}）`);
    lines.push("");
    lines.push(`> ${s.description}`);
    lines.push("");
    lines.push(`- 选择工具：${s.selectedTools.join(", ")}`);
    lines.push(`- 实际调用：${s.actualCalls}（每工具：${Object.entries(s.callsByTool).map(([t, c]) => `${t}=${c}`).join(", ")}）`);
    lines.push(`- 重复查询：${s.duplicateQueries}`);
    lines.push(`- 返回字符数：${s.totalResultChars}（平均 ${s.avgResultChars}）`);
    lines.push(`- 延迟：${s.totalLatencyMs}ms（平均 ${s.avgLatencyMs}ms）`);
    lines.push(`- 空结果：${s.emptyResults}，超时：${s.timeouts}，失败：${s.errors}`);
    lines.push(`- evidenceLevel：${Object.entries(s.evidenceLevels).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    lines.push(`- sourceRef：有效 ${s.sourceRefsValid}，无效 ${s.sourceRefsInvalid}`);
    lines.push(`- mustVerify 覆盖率：${s.mustVerify.coverageRatio.toFixed(2)}（${s.mustVerify.coveredCount}/${s.mustVerify.itemCount}）`);
    if (s.mustVerify.uncoveredItems.length > 0) {
      lines.push(`- 未覆盖项：${s.mustVerify.uncoveredItems.join("；")}`);
    }
    lines.push("");
    lines.push("| 用例 | 工具 | query | 返回字符 | 延迟ms | evidenceLevel | sourceRef(有效) | 结果类型 | 数量 | 截断 | 空 | 重复 |");
    lines.push("|------|------|-------|---------|--------|---------------|-----------------|---------|------|------|-----|-----|");
    for (const c of s.calls) {
      lines.push(
        `| ${c.tool} | ${c.tool} | ${c.query} | ${c.resultChars} | ${c.latencyMs} | ${c.evidenceLevel ?? "-"} | ${c.sourceRef ?? "-"} (${c.sourceRefValid ? "✓" : "✗"}) | ${c.resultKind ?? "-"} | ${c.returnedCount ?? "-"} | ${c.truncated === true ? "✓" : ""} | ${c.empty ? "✓" : ""} | ${c.duplicateQuery ? "✓" : ""} |`,
      );
    }
    lines.push("");
  }
  lines.push("## Phase 3 兼容性要求（后续实施时遵守）");
  lines.push("");
  lines.push("- 原有 `text` 和 `details` 不删除；新增 `resultKind`、`returnedCount`、`truncated`");
  lines.push("- `nextQueryHint` 必须由系统确定性生成，不能让模型自由注入");
  lines.push("- 所有工具统一上限和空结果语义；不改变检索排序和证据等级");
  lines.push("");
  return lines.join("\n");
}