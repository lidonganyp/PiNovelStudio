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
import { createQueryNarrativeProductionFacadeTool } from "../tools/query-narrative-facade.js";
import type { NarrativeSearchService } from "./narrative-search-service.js";

// ============================================================================
// Registry
// ============================================================================

export interface NarrativeToolRegistryOptions {
  searchService: NarrativeSearchService;
  permissionPolicy: PermissionPolicy;
  /**
   * Phase 5 受控接入：是否额外注册 query_narrative_production（facade runtime 变体）。
   *
   * 仅当 workspace canary 授权 opt-in（toolMode="facade"）时为 true；默认 false =
   * 只注册 9 个专用叙事工具（生产默认行为不变）。facade 不改变 9 工具本身，
   * 只是新增一个按 intent 路由的统一入口，作为 "guided facade vs 9 工具" 的受控对照。
   */
  enableFacade?: boolean;
}

export class NarrativeToolRegistry {
  private readonly tools = new Map<string, ToolProtocol<TSchema>>();
  private readonly permissionPolicy: PermissionPolicy;

  constructor(options: NarrativeToolRegistryOptions) {
    this.permissionPolicy = options.permissionPolicy;
    // 注册 9 个内置叙事工具
    const tools = createNarrativeTools({ searchService: options.searchService });
    for (const tool of tools) {
      this.register(tool);
    }
    // Phase 5 受控接入：仅 when enableFacade=true 额外注册 facade runtime 变体。
    // 默认（非 canary workspace）不注册，保持 9 专用工具执行面不变。
    // 注意：useCompactEnvelope 不传（默认 false）--compact envelope 已在 Phase 5.3
    // 真实 replay 多项门禁失败，已弃用，不进入生产。
    if (options.enableFacade === true) {
      const facade = createQueryNarrativeProductionFacadeTool({
        searchService: options.searchService,
      });
      this.register(facade);
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
