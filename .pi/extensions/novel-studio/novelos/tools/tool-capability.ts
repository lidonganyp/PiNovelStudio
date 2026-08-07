/**
 * NovelOS 工具能力清单（Phase 0：工具基线盘点）
 *
 * 为每个叙事工具登记静态元数据，作为观测与改造的基线依据：
 * - 能力域 domain（canon / character / timeline / promise / pattern / voice / span / evidence）
 * - 必填输入 / 可选输入
 * - 默认返回数量 / 最大返回数量
 * - 预计响应 token（粗略估算，用于诊断 prompt/上下文过载）
 * - evidenceLevel（工具典型返回的证据等级）
 * - sourceRef 规则（trace 可追溯性）
 * - timeoutMs
 * - 是否可能返回全量数据（未指定过滤参数时的风险）
 * - 空结果语义 / 失败语义（区分"没有证据"与"查询失败"）
 *
 * 本模块是纯静态数据，无副作用，可被 tool 实现、tracer、诊断脚本与测试共享。
 * 不参与运行时逻辑，只是"工具能力清单"这一交付物的代码化。
 */

import type { EvidenceLevel } from "./tool-protocol.js";

/** 工具能力域 */
export type ToolDomain =
  | "canon"
  | "character"
  | "timeline"
  | "promise"
  | "pattern"
  | "voice"
  | "span"
  | "evidence";

/** 单工具能力登记 */
export interface ToolCapability {
  /** 工具名（与 NARRATIVE_TOOL_NAMES 对齐） */
  name: string;
  /** 能力域 */
  domain: ToolDomain;
  /** 必填输入参数名（缺省会失败或返回宽结果） */
  requiredInputs: string[];
  /** 可选输入参数名 */
  optionalInputs: string[];
  /** 默认返回条数 */
  defaultReturnCount: number;
  /** 单次调度最大返回条数（无界时标记为 null） */
  maxReturnCount: number | null;
  /** 预计响应 token（粗略估算：结果文本长度 / 2，中文约 1.5-2 字/token） */
  estimatedResponseTokens: number;
  /** 工具典型返回的证据等级（空结果时为 inferred，见 emptySourceRef） */
  evidenceLevel: EvidenceLevel;
  /** sourceRef 规则说明 */
  sourceRefRule: string;
  /** 执行超时 ms */
  timeoutMs: number;
  /** 是否可能返回全量数据（未指定过滤参数时） */
  canReturnFullData: boolean;
  /** 空结果语义（区分"没有证据"与"查询失败"） */
  emptyResultSemantics: string;
  /** 失败语义（异常/超时时的行为） */
  failureSemantics: string;
}

/** 工具能力登记表（key = 工具名） */
export const TOOL_CAPABILITIES: Record<string, ToolCapability> = {
  search_narrative_evidence: {
    name: "search_narrative_evidence",
    domain: "evidence",
    requiredInputs: ["query"],
    optionalInputs: ["maxResults"],
    defaultReturnCount: 10,
    maxReturnCount: 10,
    estimatedResponseTokens: 600,
    evidenceLevel: "confirmed",
    sourceRefRule: "取自排序证据首条 sourceRef；无匹配时置 'ranked:no-match'",
    timeoutMs: 15_000,
    canReturnFullData: false,
    emptyResultSemantics: "无匹配（ranked:no-match，inferred）——表示没有证据，非查询失败",
    failureSemantics: "检索异常向上抛错，由 runtime 记录 tool 错误",
  },
  search_chapter_span: {
    name: "search_chapter_span",
    domain: "span",
    requiredInputs: ["query"],
    optionalInputs: ["maxChapters", "maxResults"],
    defaultReturnCount: 10,
    maxReturnCount: 10,
    estimatedResponseTokens: 500,
    evidenceLevel: "exact_chapter_span",
    sourceRefRule: "取自首个 span 的 sourceRef；无匹配时置 'search:chapter_span:no-match'",
    timeoutMs: 15_000,
    canReturnFullData: false,
    emptyResultSemantics: "无匹配（search:chapter_span:no-match，inferred）——表示没有证据",
    failureSemantics: "检索异常向上抛错，由 runtime 记录 tool 错误",
  },
  query_canon: {
    name: "query_canon",
    domain: "canon",
    requiredInputs: [],
    optionalInputs: ["category"],
    defaultReturnCount: 0,
    maxReturnCount: null,
    estimatedResponseTokens: 800,
    evidenceLevel: "confirmed",
    sourceRefRule: "取自首条 entry 的 sourceRef；无匹配时置 'canon:empty'",
    timeoutMs: 10_000,
    canReturnFullData: true,
    emptyResultSemantics: "无 canon 事实（canon:empty，inferred）",
    failureSemantics: "查询异常向上抛错",
  },
  query_character_state: {
    name: "query_character_state",
    domain: "character",
    requiredInputs: [],
    optionalInputs: ["characterId"],
    defaultReturnCount: 0,
    maxReturnCount: null,
    estimatedResponseTokens: 800,
    evidenceLevel: "confirmed_state",
    sourceRefRule: "取自首条 entry 的 sourceRef；无匹配时置 'character:empty'",
    timeoutMs: 10_000,
    canReturnFullData: true,
    emptyResultSemantics: "无角色状态（character:empty，inferred）",
    failureSemantics: "查询异常向上抛错",
  },
  query_timeline: {
    name: "query_timeline",
    domain: "timeline",
    requiredInputs: [],
    optionalInputs: [],
    defaultReturnCount: 0,
    maxReturnCount: null,
    estimatedResponseTokens: 800,
    evidenceLevel: "confirmed",
    sourceRefRule: "取自首条 entry 的 sourceRef；无匹配时置 'timeline:empty'",
    timeoutMs: 10_000,
    canReturnFullData: true,
    emptyResultSemantics: "无时间线事件（timeline:empty，inferred）",
    failureSemantics: "查询异常向上抛错",
  },
  query_character_knowledge_boundary: {
    name: "query_character_knowledge_boundary",
    domain: "character",
    requiredInputs: [],
    optionalInputs: ["characterId"],
    defaultReturnCount: 0,
    maxReturnCount: null,
    estimatedResponseTokens: 800,
    evidenceLevel: "confirmed",
    sourceRefRule: "取自首条 entry 的 sourceRef；无匹配时置 'knowledge_boundary:empty'",
    timeoutMs: 10_000,
    canReturnFullData: true,
    emptyResultSemantics: "无知识边界记录（knowledge_boundary:empty，inferred）——可能 legacy 未记录",
    failureSemantics: "查询异常向上抛错",
  },
  query_promise_ledger: {
    name: "query_promise_ledger",
    domain: "promise",
    requiredInputs: [],
    optionalInputs: ["status"],
    defaultReturnCount: 0,
    maxReturnCount: null,
    estimatedResponseTokens: 800,
    evidenceLevel: "confirmed",
    sourceRefRule: "取自首条 entry 的 sourceRef；无匹配时置 'promise:empty'",
    timeoutMs: 10_000,
    canReturnFullData: true,
    emptyResultSemantics: "无 promise 条目（promise:empty，inferred）",
    failureSemantics: "查询异常向上抛错",
  },
  query_pattern_memory: {
    name: "query_pattern_memory",
    domain: "pattern",
    requiredInputs: [],
    optionalInputs: ["patternType"],
    defaultReturnCount: 0,
    maxReturnCount: null,
    estimatedResponseTokens: 800,
    evidenceLevel: "confirmed",
    sourceRefRule: "取自首条 entry 的 sourceRef；无匹配时置 'pattern:empty'",
    timeoutMs: 10_000,
    canReturnFullData: true,
    emptyResultSemantics: "无 pattern（pattern:empty，inferred）——legacy 无直接对应，Phase 6 填充",
    failureSemantics: "查询异常向上抛错",
  },
  query_voice_evidence: {
    name: "query_voice_evidence",
    domain: "voice",
    requiredInputs: [],
    optionalInputs: ["characterId"],
    defaultReturnCount: 1,
    maxReturnCount: 1,
    estimatedResponseTokens: 100,
    evidenceLevel: "profile_only",
    sourceRefRule: "固定 'voice:profile_only:degraded'（M1 无 Voice Foundation）",
    timeoutMs: 5_000,
    canReturnFullData: false,
    emptyResultSemantics: "不空——始终返回降级 profile_only 说明",
    failureSemantics: "无失败路径（恒返回降级结果）",
  },
};

/** 返回全部工具能力登记（按工具名排序，供诊断/replay 使用） */
export function listToolCapabilities(): ToolCapability[] {
  return Object.values(TOOL_CAPABILITIES).sort((a, b) => a.name.localeCompare(b.name));
}