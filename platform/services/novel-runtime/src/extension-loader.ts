/**
 * PiNovelStudio 扩展加载器（plan §1 T1-1）
 *
 * 加载 PiNovelStudio 编译产物（dist/index.js），通过 PI ExtensionAPI 桩捕获其注册的工具，
 * 然后过白名单过滤（T1-2），只保留 6 个 novel_* 工具。
 *
 * 加载流程：
 * 1. 动态 import PiNovelStudio dist/index.js
 * 2. 创建 PI ExtensionAPI 桩
 * 3. 调用扩展默认导出函数（传入桩）
 * 4. 桩捕获所有 registerTool 调用
 * 5. 严格白名单过滤（assertStrictWhitelist）
 * 6. 返回通过白名单的工具映射
 *
 * 失败语义：
 * - 加载失败、工具数不符、命中禁止能力 → fail closed，拒绝启动
 */

import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { createPiExtensionApiStub, type PiExtensionApiStub, type PiTool } from "./pi-extension-api-stub.js";
import {
  assertStrictWhitelist,
  type WhitelistFilterResult,
} from "./tool-whitelist.js";
import type { NovelRuntimeConfig } from "./config.js";

export class ExtensionLoadError extends Error {
  constructor(
    message: string,
    public readonly code: "DIST_NOT_FOUND" | "LOAD_FAILED" | "WHITELIST_VIOLATION",
  ) {
    super(message);
    this.name = "ExtensionLoadError";
  }
}

export interface LoadedTools {
  /** 通过白名单的 6 个工具，按工具名索引 */
  byName: Map<string, PiTool>;
  /** 白名单过滤结果（含 dropped / forbidden 信息，用于审计） */
  filterResult: WhitelistFilterResult<PiTool>;
  /** 加载的 PiNovelStudio dist 路径 */
  distPath: string;
}

/**
 * P0-1（第二轮 P0 修复）：把 `execute` 协议的工具包装成 `invoke` 协议。
 *
 * 真实 PiNovelStudio 通过 wrapLegacyTool 注册的工具只暴露
 * `execute(toolCallId, params, signal, onUpdate, ctx)`（PI 内部协议），
 * 而 invoke.ts 的 `typeof tool.invoke === "function"` 守卫要求 `invoke`。
 *
 * 本包装器：
 *   - 已有 `invoke` → 原样返回（兼容未来或测试桩）
 *   - 只有 `execute` → 用 execute 包装出 invoke，返回 execute 的 `details` 字段
 *     （wrapLegacyTool 返回 { content, details }；details 是 PiNovelStudio raw.invoke 返回值）
 *   - 两者都无 → 原样返回，让下游守卫返回 TOOL_NOT_FOUND（fail-closed）
 *
 * 信号预留：当前 signal 传 undefined；P0-7 在 metering-binder 入口创建 AbortController
 * 后可传入，PiNovelStudio 当前不消费 signal，但接口已就位。
 */
export function adaptExecuteToInvoke(tool: PiTool): PiTool {
  if (typeof tool.invoke === "function") return tool;
  if (typeof tool.execute !== "function") return tool;
  const executeTool = tool as PiTool & {
    execute: NonNullable<PiTool["execute"]>;
  };
  return {
    ...tool,
    invoke: async (input: unknown, signal?: AbortSignal): Promise<unknown> => {
      const result = await executeTool.execute(
        "invoke-call",
        input,
        signal,
        undefined,
        // The runtime, not the HTTP caller, supplies _projectRoot after it
        // materializes an isolated workspace.  Mark that hand-off so the
        // extension can reject caller-injected roots on every other surface.
        { __novelRuntimeTrustedRoot: true },
      );
      // wrapLegacyTool 返回 { content, details }；details 是 PiNovelStudio raw.invoke 返回值
      if (
        result &&
        typeof result === "object" &&
        "details" in (result as Record<string, unknown>)
      ) {
        return (result as { details: unknown }).details;
      }
      return result;
    },
  };
}

/**
 * 加载 PiNovelStudio 扩展，捕获工具，过白名单。
 * fail closed：任何失败都抛出。
 */
export async function loadNovelStudioExtension(
  config: NovelRuntimeConfig,
): Promise<LoadedTools> {
  const distPath = config.novelStudioDistPath;

  // 1. 检查 dist 文件存在
  if (!existsSync(distPath)) {
    throw new ExtensionLoadError(
      `FAIL_CLOSED: PiNovelStudio dist not found at ${distPath}. ` +
        `Build PiNovelStudio first (npm run build:prod in .pi/extensions/novel-studio).`,
      "DIST_NOT_FOUND",
    );
  }

  // 2. 动态 import
  let extensionModule: { default?: (pi: PiExtensionApiStub) => void };
  try {
    const moduleUrl = pathToFileURL(distPath).href;
    extensionModule = (await import(moduleUrl)) as { default?: (pi: PiExtensionApiStub) => void };
  } catch (err: unknown) {
    throw new ExtensionLoadError(
      `FAIL_CLOSED: failed to import PiNovelStudio dist at ${distPath}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      "LOAD_FAILED",
    );
  }

  if (typeof extensionModule.default !== "function") {
    throw new ExtensionLoadError(
      `FAIL_CLOSED: PiNovelStudio dist at ${distPath} does not export a default function.`,
      "LOAD_FAILED",
    );
  }

  // 3. 创建桩并调用扩展
  const stub = createPiExtensionApiStub();
  try {
    extensionModule.default(stub);
  } catch (err: unknown) {
    throw new ExtensionLoadError(
      `FAIL_CLOSED: PiNovelStudio extension initialization failed: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      "LOAD_FAILED",
    );
  }

  // 4. 捕获工具
  const capturedTools = stub._capturedTools();

  // 5. 严格白名单过滤（fail closed on forbidden or count mismatch）
  const filterResult = assertStrictWhitelist(capturedTools);

  // 6. P0-1：把 execute 协议工具包装成 invoke 协议
  //    真实 PiNovelStudio 的 wrapLegacyTool 产出 { execute } 无 { invoke }；
  //    adaptExecuteToInvoke 在已通过白名单的工具上做标准化，使 invoke.ts 守卫通过。
  const adaptedAllowed = filterResult.allowed.map(adaptExecuteToInvoke);
  const nonExecutable = adaptedAllowed.filter(
    (tool) => typeof tool.invoke !== "function",
  );
  if (nonExecutable.length > 0) {
    throw new ExtensionLoadError(
      `FAIL_CLOSED: whitelisted tools are not executable: ${nonExecutable
        .map((tool) => tool.name)
        .join(", ")}.`,
      "LOAD_FAILED",
    );
  }

  // 7. 构建按名索引
  const byName = new Map<string, PiTool>();
  for (const tool of adaptedAllowed) {
    byName.set(tool.name, tool);
  }

  return {
    byName,
    filterResult,
    distPath,
  };
}

/**
 * 仅供测试用：从给定工具列表构造 LoadedTools，不走真实加载。
 */
export function makeLoadedToolsForTest(tools: PiTool[]): LoadedTools {
  const filterResult = assertStrictWhitelist(tools);
  // P0-1：与真实加载保持一致，对测试工具也做 execute → invoke 适配
  const adaptedAllowed = filterResult.allowed.map(adaptExecuteToInvoke);
  const nonExecutable = adaptedAllowed.filter(
    (tool) => typeof tool.invoke !== "function",
  );
  if (nonExecutable.length > 0) {
    throw new Error(
      `FAIL_CLOSED: whitelisted tools are not executable: ${nonExecutable
        .map((tool) => tool.name)
        .join(", ")}.`,
    );
  }
  const byName = new Map<string, PiTool>();
  for (const tool of adaptedAllowed) {
    byName.set(tool.name, tool);
  }
  return {
    byName,
    filterResult,
    distPath: "<test>",
  };
}
