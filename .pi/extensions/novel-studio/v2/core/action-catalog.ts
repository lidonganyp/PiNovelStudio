/**
 * ACTION-CATALOG — 统一动作目录与默认自主性等级。
 *
 * 真相源：delete/任务列表/项目计划20260812-2.md §3.3 / §4-P0
 *
 * 所有动作有唯一名称与默认自主性等级；未知动作默认拒绝。
 * 本模块是纯数据 + 查询函数，不含策略裁决。
 */

import type { ActionName, AutonomyLevel } from "./control-types.js";

export interface ActionCatalogEntry {
  action: ActionName;
  /** 默认自主性等级（模型请求上限参考） */
  defaultAutonomyLevel: AutonomyLevel;
  /** 对应执行能力名（CapabilityPolicy / ExecutionCapabilityPolicy） */
  executionCapability?: string;
  description: string;
  /** 是否要求用户审批后才能进入正式事务 */
  requiresUserApproval: boolean;
  /** 模型是否允许请求该动作（请求 ≠ 执行） */
  modelMayRequest: boolean;
}

const CATALOG: ReadonlyArray<ActionCatalogEntry> = [
  {
    action: "workspace.read",
    defaultAutonomyLevel: "observe",
    executionCapability: "state.read",
    description: "读取人物、世界观、伏笔与 workspace 数据",
    requiresUserApproval: false,
    modelMayRequest: true,
  },
  {
    action: "retrieval.execute",
    defaultAutonomyLevel: "bounded_execute",
    executionCapability: "state.read",
    description: "在工具白名单、预算和资源范围内执行检索",
    requiresUserApproval: false,
    modelMayRequest: true,
  },
  {
    action: "draft.generate",
    defaultAutonomyLevel: "bounded_execute",
    executionCapability: "model.generate",
    description: "生成 Agentic 初稿（内部基线，不直接交付）",
    requiresUserApproval: false,
    modelMayRequest: true,
  },
  {
    action: "editorial.optimize",
    defaultAutonomyLevel: "bounded_execute",
    executionCapability: "model.generate",
    description: "作者风格整章优化",
    requiresUserApproval: false,
    modelMayRequest: true,
  },
  {
    action: "repair.suggest",
    defaultAutonomyLevel: "suggest",
    executionCapability: "model.generate",
    description: "提出局部修订候选，不直接覆盖正式作品",
    requiresUserApproval: false,
    modelMayRequest: true,
  },
  {
    action: "checkpoint.save",
    defaultAutonomyLevel: "checkpoint",
    executionCapability: "artifact.export",
    description: "保存代理审批/待审稿到隔离目录",
    requiresUserApproval: false,
    modelMayRequest: false,
  },
  {
    action: "chapter.save",
    defaultAutonomyLevel: "commit",
    executionCapability: "chapter.save",
    description: "正式章节保存（仅编排器，需用户授权）",
    requiresUserApproval: true,
    modelMayRequest: false,
  },
  {
    action: "state.commit",
    defaultAutonomyLevel: "commit",
    executionCapability: "state.commit",
    description: "NarrativeState 正式提交（仅编排器，需用户授权）",
    requiresUserApproval: true,
    modelMayRequest: false,
  },
  {
    action: "release.promote",
    defaultAutonomyLevel: "commit",
    description: "发布晋级（治理流程 + 人工批准）",
    requiresUserApproval: true,
    modelMayRequest: false,
  },
  {
    action: "baseline.replace",
    defaultAutonomyLevel: "commit",
    description: "Prompt/路由/生产基线替换（Eval 证据 + release gate）",
    requiresUserApproval: true,
    modelMayRequest: false,
  },
];

const BY_NAME = new Map<ActionName, ActionCatalogEntry>(
  CATALOG.map((entry) => [entry.action, entry]),
);

/** 动作目录全部条目（只读副本） */
export function listActions(): ReadonlyArray<ActionCatalogEntry> {
  return CATALOG;
}

/** 按名称查询动作目录；未知动作返回 null */
export function getActionCatalogEntry(action: string): ActionCatalogEntry | null {
  return BY_NAME.get(action as ActionName) ?? null;
}

/** 是否为已知动作 */
export function isKnownAction(action: string): action is ActionName {
  return BY_NAME.has(action as ActionName);
}

/** 动作默认自主性等级；未知动作返回 null */
export function getDefaultAutonomyLevel(action: string): AutonomyLevel | null {
  return getActionCatalogEntry(action)?.defaultAutonomyLevel ?? null;
}

/**
 * 将 NovelOS 工具名映射为 ActionName（模型工具调用前的自主性检查用）。
 *
 * fail-closed：
 * - 显式 commit/save 名 → 禁止动作（由 ModelAutonomyPolicy 拒绝）
 * - 已知只读检索/修复模式 → 对应动作
 * - 未知工具名 → null（调用方必须拒绝，不得默认放行）
 */
export function mapToolNameToAction(toolName: string): ActionName | null {
  const raw = (toolName ?? "").trim();
  if (!raw) return null;
  const name = raw.toLowerCase();
  if (
    name.includes("state.commit") ||
    name.includes("final_commit") ||
    name === "state_commit" ||
    name === "finalstatecommit"
  ) {
    return "state.commit";
  }
  if (
    name.includes("chapter.save") ||
    name.includes("chapter_save") ||
    name === "atomic_save" ||
    name === "save_chapter"
  ) {
    return "chapter.save";
  }
  if (name.includes("checkpoint") || name.includes("proxy_draft")) {
    return "checkpoint.save";
  }
  if (name.includes("repair") || name.includes("patch") || name.includes("propose")) {
    return "repair.suggest";
  }
  // 叙事白名单内的只读检索工具 + facade 统一入口
  if (
    name.startsWith("query_") ||
    name.startsWith("search_") ||
    name === "query_narrative_production"
  ) {
    return "retrieval.execute";
  }
  // 未知工具：fail-closed，不默认授予 retrieval 权限
  return null;
}
