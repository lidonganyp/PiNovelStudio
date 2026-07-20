/**
 * NovelOS Narrative Tool Registry（OPT-9.2 / OPT-9.12）
 *
 * 工具注册中心：管理 ToolProtocol 实例 + 权限关联。
 * - getToolsForRole(role)：返回该角色可用工具列表（转成 AgentTool 格式）
 * - getToolProtocol(name)：按名称查询单个工具元数据
 * - 校验：agent 角色不可注册 final_commit 工具
 *
 * 与 PermissionPolicy 协作：
 * - Registry 负责工具→权限的静态映射
 * - PermissionPolicy 负责运行时权限校验（角色是否持有该权限）
 */

import type { AgentTool } from "../adapters/pi-agent-core-adapter.js";
import type { ToolProtocol, ToolPermission } from "../tools/tool-protocol.js";
import type { Role, PermissionPolicy } from "../security/permission-policy.js";
import type { TSchema } from "typebox";
import { createNarrativeTools } from "../tools/narrative-tools.js";
import type { NarrativeSearchService } from "./narrative-search-service.js";

// ============================================================================
// Registry
// ============================================================================

export interface NarrativeToolRegistryOptions {
  searchService: NarrativeSearchService;
  permissionPolicy: PermissionPolicy;
}

export class NarrativeToolRegistry {
  private readonly tools = new Map<string, ToolProtocol<TSchema>>();
  private readonly permissionPolicy: PermissionPolicy;

  constructor(options: NarrativeToolRegistryOptions) {
    this.permissionPolicy = options.permissionPolicy;
    // 注册 8 个内置叙事工具
    const tools = createNarrativeTools({ searchService: options.searchService });
    for (const tool of tools) {
      this.register(tool);
    }
  }

  /** 注册一个工具（校验权限约束） */
  register(tool: ToolProtocol<TSchema>): void {
    // 硬性边界：工具不能要求 final_commit
    if (tool.requiredPermission === "final_commit") {
      throw new Error(
        `工具 "${tool.name}" 要求 final_commit 权限，agent 不可注册此类工具。final_commit 只能由统一编排器在最终选择后执行。`,
      );
    }
    // 校验：read_only 工具应要求 workspace_read
    if (tool.sideEffect === "read_only" && tool.requiredPermission !== "workspace_read") {
      throw new Error(
        `工具 "${tool.name}" sideEffect=read_only 但 requiredPermission=${tool.requiredPermission}，应为 workspace_read。`,
      );
    }
    if (this.tools.has(tool.name)) {
      throw new Error(`工具 "${tool.name}" 已注册，不可重复注册。`);
    }
    this.tools.set(tool.name, tool);
  }

  /** 按名称获取工具元数据 */
  getToolProtocol(name: string): ToolProtocol<TSchema> | undefined {
    return this.tools.get(name);
  }

  /**
   * 获取角色可用的工具列表（转成 AgentTool 格式供 Agent 消费）。
   * 过滤掉角色不持有 requiredPermission 的工具。
   */
  getToolsForRole(role: Role): AgentTool[] {
    const result: AgentTool[] = [];
    for (const tool of this.tools.values()) {
      if (this.permissionPolicy.can(role, tool.requiredPermission as ToolPermission)) {
        // AgentTool 是 ToolProtocol 的超集（去掉 requiredPermission/sideEffect/timeoutMs 元数据）
        result.push(tool as unknown as AgentTool);
      }
    }
    return result;
  }

  /** 获取所有已注册工具名称 */
  getToolNames(): string[] {
    return [...this.tools.keys()];
  }

  /** 获取工具数量 */
  size(): number {
    return this.tools.size;
  }
}

// ============================================================================
// 工厂
// ============================================================================

export function createNarrativeToolRegistry(
  options: NarrativeToolRegistryOptions,
): NarrativeToolRegistry {
  return new NarrativeToolRegistry(options);
}
