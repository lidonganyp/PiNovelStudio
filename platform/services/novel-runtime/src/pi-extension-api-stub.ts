/**
 * PI ExtensionAPI 最小桩（plan §1 T1-1）
 *
 * Novel Runtime 不运行完整 PI 编码代理，只加载 PiNovelStudio 扩展以捕获其注册的 6 个工具。
 * 本桩实现 ExtensionAPI 的最小子集：
 * - registerTool(tool)：捕获到内部数组
 * - on(event, handler)：no-op（novel-runtime 不消费 PI 事件）
 * - ui.notify：no-op（novel-runtime 无 PI UI）
 *
 * 严禁实现的能力（plan §1 T1-2 明确禁止）：
 * - Shell / 系统命令执行
 * - 任意代码执行
 * - 任意路径文件读写
 * - Git 操作
 * - 插件安装
 * - MCP 客户端
 * - 网络抓取
 * - 动态加载扩展
 *
 * 这些能力在桩中根本没有方法，PiNovelStudio 即使想调用也调不到。
 */

import type { ToolLike } from "./tool-whitelist.js";

/**
 * PI 工具的最小结构类型（与 PiNovelStudio ToolDefinition 结构兼容）。
 *
 * P0-1（第二轮 P0 修复）：真实 PiNovelStudio 通过 wrapLegacyTool 注册的工具
 * 仅暴露 `execute(toolCallId, params, signal, onUpdate, ctx)`（PI 内部协议），
 * 不暴露 `invoke(input)`（PI 标准协议）。extension-loader 在加载后会用
 * adaptExecuteToInvoke 包装器把 `execute` 转成 `invoke`，使 invoke.ts 的
 * `typeof tool.invoke === "function"` 守卫通过。
 */
export interface PiTool extends ToolLike {
  name: string;
  description?: string;
  inputSchema?: unknown;
  invoke?: (input: unknown, signal?: AbortSignal) => Promise<unknown>;
  /**
   * PI 内部协议：wrapLegacyTool 产出的工具用此方法。
   * 返回 { content: [{type:"text", text}], details: raw.invoke 返回值 }。
   * extension-loader 的 adaptExecuteToInvoke 会把 execute 包装成 invoke。
   */
  execute?: (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    details?: unknown;
  }>;
}

/** PI ExtensionAPI 的最小子集——只保留捕获工具所需方法 */
export interface PiExtensionApiStub {
  /** 捕获注册的工具 */
  registerTool(tool: PiTool): void;
  /** 事件订阅——no-op，novel-runtime 不消费 PI 事件 */
  on(event: string, handler: (...args: unknown[]) => unknown): void;
  /** UI 通知——no-op，novel-runtime 无 PI UI */
  ui: {
    notify(message: string, level: string): void;
  };
  /** 读取已捕获的工具列表 */
  _capturedTools(): PiTool[];
}

/**
 * 创建 PI ExtensionAPI 桩。
 * 捕获所有 registerTool 调用，其余能力一律不实现。
 */
export function createPiExtensionApiStub(): PiExtensionApiStub {
  const capturedTools: PiTool[] = [];

  return {
    registerTool(tool: PiTool): void {
      capturedTools.push(tool);
    },
    on(_event: string, _handler: (...args: unknown[]) => unknown): void {
      // no-op：novel-runtime 不消费 PI 事件
    },
    ui: {
      notify(_message: string, _level: string): void {
        // no-op
      },
    },
    _capturedTools(): PiTool[] {
      return [...capturedTools];
    },
  };
}
