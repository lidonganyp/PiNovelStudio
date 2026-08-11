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

import type { EvidenceLevel, ToolSideEffect, ToolPermission } from "./tool-protocol.js";

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
  /** 副作用类型（Tool Interface Contract v1：read_only / candidate_write / propose） */
  sideEffect: ToolSideEffect;
  /** 调用此工具所需权限（运行时由 PermissionPolicy 校验，不暴露给模型） */
  requiredPermission: ToolPermission;
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
    maxReturnCount: 50,
    estimatedResponseTokens: 600,
    evidenceLevel: "confirmed",
    sourceRefRule: "取自排序证据首条 sourceRef；无匹配时置 'ranked:no-match'",
    timeoutMs: 15_000,
    sideEffect: "read_only",
    requiredPermission: "workspace_read",
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
    maxReturnCount: 50,
    estimatedResponseTokens: 500,
    evidenceLevel: "exact_chapter_span",
    sourceRefRule: "取自首个 span 的 sourceRef；无匹配时置 'search:chapter_span:no-match'",
    timeoutMs: 15_000,
    sideEffect: "read_only",
    requiredPermission: "workspace_read",
    canReturnFullData: false,
    emptyResultSemantics: "无匹配（search:chapter_span:no-match，inferred）——表示没有证据",
    failureSemantics: "检索异常向上抛错，由 runtime 记录 tool 错误",
  },
  query_canon: {
    name: "query_canon",
    domain: "canon",
    requiredInputs: [],
    optionalInputs: ["category"],
    defaultReturnCount: 50,
    maxReturnCount: 50,
    estimatedResponseTokens: 800,
    evidenceLevel: "confirmed",
    sourceRefRule: "取自首条 entry 的 sourceRef；无匹配时置 'canon:empty'",
    timeoutMs: 10_000,
    sideEffect: "read_only",
    requiredPermission: "workspace_read",
    canReturnFullData: false,
    emptyResultSemantics: "无 canon 事实（canon:empty，inferred）",
    failureSemantics: "查询异常向上抛错",
  },
  query_character_state: {
    name: "query_character_state",
    domain: "character",
    requiredInputs: [],
    optionalInputs: ["characterId"],
    defaultReturnCount: 50,
    maxReturnCount: 50,
    estimatedResponseTokens: 800,
    evidenceLevel: "confirmed_state",
    sourceRefRule: "取自首条 entry 的 sourceRef；无匹配时置 'character:empty'",
    timeoutMs: 10_000,
    sideEffect: "read_only",
    requiredPermission: "workspace_read",
    canReturnFullData: false,
    emptyResultSemantics: "无角色状态（character:empty，inferred）",
    failureSemantics: "查询异常向上抛错",
  },
  query_timeline: {
    name: "query_timeline",
    domain: "timeline",
    requiredInputs: [],
    optionalInputs: [],
    defaultReturnCount: 50,
    maxReturnCount: 50,
    estimatedResponseTokens: 800,
    evidenceLevel: "confirmed",
    sourceRefRule: "取自首条 entry 的 sourceRef；无匹配时置 'timeline:empty'",
    timeoutMs: 10_000,
    sideEffect: "read_only",
    requiredPermission: "workspace_read",
    canReturnFullData: false,
    emptyResultSemantics: "无时间线事件（timeline:empty，inferred）",
    failureSemantics: "查询异常向上抛错",
  },
  query_character_knowledge_boundary: {
    name: "query_character_knowledge_boundary",
    domain: "character",
    requiredInputs: [],
    optionalInputs: ["characterId"],
    defaultReturnCount: 50,
    maxReturnCount: 50,
    estimatedResponseTokens: 800,
    evidenceLevel: "confirmed",
    sourceRefRule: "取自首条 entry 的 sourceRef；无匹配时置 'knowledge_boundary:empty'",
    timeoutMs: 10_000,
    sideEffect: "read_only",
    requiredPermission: "workspace_read",
    canReturnFullData: false,
    emptyResultSemantics: "无知识边界记录（knowledge_boundary:empty，inferred）——可能 legacy 未记录",
    failureSemantics: "查询异常向上抛错",
  },
  query_promise_ledger: {
    name: "query_promise_ledger",
    domain: "promise",
    requiredInputs: [],
    optionalInputs: ["status"],
    defaultReturnCount: 50,
    maxReturnCount: 50,
    estimatedResponseTokens: 800,
    evidenceLevel: "confirmed",
    sourceRefRule: "取自首条 entry 的 sourceRef；无匹配时置 'promise:empty'",
    timeoutMs: 10_000,
    sideEffect: "read_only",
    requiredPermission: "workspace_read",
    canReturnFullData: false,
    emptyResultSemantics: "无 promise 条目（promise:empty，inferred）",
    failureSemantics: "查询异常向上抛错",
  },
  query_pattern_memory: {
    name: "query_pattern_memory",
    domain: "pattern",
    requiredInputs: [],
    optionalInputs: ["patternType"],
    defaultReturnCount: 50,
    maxReturnCount: 50,
    estimatedResponseTokens: 800,
    evidenceLevel: "confirmed",
    sourceRefRule: "取自首条 entry 的 sourceRef；无匹配时置 'pattern:empty'",
    timeoutMs: 10_000,
    sideEffect: "read_only",
    requiredPermission: "workspace_read",
    canReturnFullData: false,
    emptyResultSemantics: "无 pattern（pattern:empty，inferred）——legacy 无直接对应，Phase 6 填充",
    failureSemantics: "查询异常向上抛错",
  },
  query_voice_evidence: {
    name: "query_voice_evidence",
    domain: "voice",
    requiredInputs: [],
    optionalInputs: ["characterId"],
    defaultReturnCount: 0,
    maxReturnCount: 0,
    estimatedResponseTokens: 100,
    evidenceLevel: "profile_only",
    sourceRefRule: "固定 'voice:profile_only:degraded'（M1 无 Voice Foundation）",
    timeoutMs: 5_000,
    sideEffect: "read_only",
    requiredPermission: "workspace_read",
    canReturnFullData: false,
    emptyResultSemantics: "不空——始终返回降级 profile_only 说明",
    failureSemantics: "无失败路径（恒返回降级结果）",
  },
  /**
   * 受控生产接入 facade（canary/eval，非默认生产）。
   *
   * 它是路由 facade，不持有检索逻辑，按 intent 把（intent 之外的）参数原样透传给
   * 底层 9 个专用工具，返回的 details 与底层工具完全一致。因此：
   * - requiredInputs = ["intent"]（facade 层必填），其余参数透传。
   * - evidenceLevel / sourceRefRule / emptyResultSemantics 均「透传」底层工具结果。
   * - 仅当 registry `enableFacade=true`（workspace canary opt-in）时注册；默认生产不注册。
   *   故本条目属于 OPTIONAL_CAPABILITIES：幻影检查不会因它缺席而报错。
   */
  query_narrative_production: {
    name: "query_narrative_production",
    domain: "evidence",
    requiredInputs: ["intent"],
    optionalInputs: [
      "query",
      "category",
      "characterId",
      "status",
      "patternType",
      "maxResults",
      "maxChapters",
    ],
    defaultReturnCount: 10,
    maxReturnCount: 50,
    estimatedResponseTokens: 800,
    evidenceLevel: "confirmed",
    sourceRefRule: "透传底层路由工具的 sourceRef；无匹配时沿用底层 empty sourceRef",
    timeoutMs: 15_000,
    sideEffect: "read_only",
    requiredPermission: "workspace_read",
    canReturnFullData: false,
    emptyResultSemantics: "透传底层工具的 no_match 语义（sourceRef/evidenceLevel 一致）",
    failureSemantics: "未知 intent 或底层工具缺失时抛错；由 runtime 记录 tool 错误",
  },
};

/**
 * 可选能力：登记表中可能缺席的工具（不强制要求存在）。
 *
 * 目前仅有受控生产接入 facade `query_narrative_production`：它仅在 workspace canary
 * opt-in（registry `enableFacade=true`）时注册，默认生产不注册。幻影检查（登记表有而实际
 * 工具集没有）不得因它缺席而报错，否则默认生产启动校验会误报。
 */
export const OPTIONAL_CAPABILITIES: ReadonlySet<string> = new Set([
  "query_narrative_production",
]);

/**
 * 返回全部【基础】工具能力登记（按工具名排序）——排除 OPTIONAL_CAPABILITIES。
 *
 * 基础能力 = 始终注册的 9 个专用叙事工具（默认生产执行面）。可选能力（如 canary
 * facade `query_narrative_production`）不在此迭代集合中，但它们仍保留在 TOOL_CAPABILITIES
 * 中，供 register() 白名单与契约校验按名引用。
 */
export function listToolCapabilities(): ToolCapability[] {
  return Object.values(TOOL_CAPABILITIES)
    .filter((cap) => !OPTIONAL_CAPABILITIES.has(cap.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ============================================================================
// 启动校验：TOOL_CAPABILITIES 与实际工具定义对齐
// ============================================================================

/**
 * 实际工具定义中可被校验的运行时元数据（Tool Interface Contract v1 子任务1）。
 * 由 registry/runtime 在注册工具后传入，逐一与 TOOL_CAPABILITIES 对齐。
 */
export interface RuntimeToolDefinition<T = unknown> {
  name: string;
  timeoutMs?: number;
  sideEffect?: string;
  requiredPermission?: string;
}

/**
 * 校验实际工具定义与 TOOL_CAPABILITIES 登记表是否一致。
 *
 * 子任务1 验收：tool-capability.ts 是单一真相源，启动时校验实际工具定义。
 * 校验维度：
 * - 每个实际工具都必须在 TOOL_CAPABILITIES 中有登记（缺失 → 登记表不全）
 * - 登记表不得包含实际工具之外的幻影工具（多出 → 登记表超前于实现）
 * - timeoutMs / sideEffect / requiredPermission 必须一致（不一致 → 契约漂移）
 *
 * @param runtimeTools 启动时实际注册的工具定义列表
 * @returns 校验失败项列表（空数组 = 全部通过）
 */
export function validateToolCapabilitiesAgainstRuntime<T = unknown>(
  runtimeTools: RuntimeToolDefinition<T>[],
): string[] {
  const failures: string[] = [];
  const registeredNames = new Set(Object.keys(TOOL_CAPABILITIES));
  const runtimeNames = new Set(runtimeTools.map((t) => t.name));

  // 1. 实际工具必须在登记表中
  for (const tool of runtimeTools) {
    const cap = TOOL_CAPABILITIES[tool.name];
    if (!cap) {
      failures.push(`工具 "${tool.name}" 未在 TOOL_CAPABILITIES 中登记，登记表不完整`);
      continue;
    }
    // 2. timeout 对齐
    if (tool.timeoutMs !== undefined && cap.timeoutMs !== tool.timeoutMs) {
      failures.push(
        `工具 "${tool.name}" timeoutMs 不一致：登记表=${cap.timeoutMs}，实际=${tool.timeoutMs}`,
      );
    }
    // 3. sideEffect 对齐
    if (tool.sideEffect !== undefined && cap.sideEffect !== tool.sideEffect) {
      failures.push(
        `工具 "${tool.name}" sideEffect 不一致：登记表=${cap.sideEffect}，实际=${tool.sideEffect}`,
      );
    }
    // 4. requiredPermission 对齐
    if (tool.requiredPermission !== undefined && cap.requiredPermission !== tool.requiredPermission) {
      failures.push(
        `工具 "${tool.name}" requiredPermission 不一致：登记表=${cap.requiredPermission}，实际=${tool.requiredPermission}`,
      );
    }
  }

  // 5. 登记表不得有幻影工具（实际不存在，且非可选能力）
  for (const name of registeredNames) {
    if (OPTIONAL_CAPABILITIES.has(name)) continue; // 可选工具可缺席（如 canary facade）
    if (!runtimeNames.has(name)) {
      failures.push(
        `TOOL_CAPABILITIES 登记了 "${name}"，但实际工具集合中不存在（登记表超前/工具已移除）`,
      );
    }
  }

  return failures;
}