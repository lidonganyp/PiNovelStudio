/**
 * AGENT-WORK-PACKAGE-TOOL-GATE — 工具执行前工作包权限强制校验（MA-2.3 / MA-3.2）
 *
 * 把“角色声明”变成 beforeToolCall 可执行的 fail-closed 门闩：
 * - 未知工具 → 拒绝
 * - 动作不在工作包 allowedActions → 拒绝
 * - 动作在 forbiddenActions / 角色禁止 → 拒绝
 * - 若工具参数含路径类字段，校验资源范围
 * - 输入字段白名单校验（编排器调用代理前）
 */

import {
  assertActionAllowed,
  assertInputFieldsWhitelisted,
  assertResourceInScope,
  type AgentWorkPackage,
  AgentWorkPackageError,
} from "./agent-work-package.js";
import { mapToolNameToAction } from "./action-catalog.js";
import type { ActionName } from "./control-types.js";

export interface WorkPackageToolGateResult {
  allowed: boolean;
  reason?: string;
  action?: ActionName | null;
  code?: string;
}

const PATH_ARG_KEYS = [
  "path",
  "filePath",
  "file_path",
  "targetPath",
  "resource",
  "resourcePath",
  "uri",
] as const;

function collectPathArgs(args: unknown): string[] {
  if (!args || typeof args !== "object" || Array.isArray(args)) return [];
  const record = args as Record<string, unknown>;
  const paths: string[] = [];
  for (const key of PATH_ARG_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      paths.push(value.trim());
    }
  }
  for (const nestedKey of ["query", "target", "input", "params"]) {
    const nested = record[nestedKey];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      paths.push(...collectPathArgs(nested));
    }
  }
  return paths;
}

/**
 * 评估工具调用是否被当前工作包授权。
 * 无工作包时返回 allowed=true（由上层 autonomy 策略继续守护）；
 * 有工作包时严格 fail-closed。
 */
export function evaluateToolCallAgainstWorkPackage(input: {
  workPackage: AgentWorkPackage | null | undefined;
  toolName: string;
  toolArgs?: unknown;
}): WorkPackageToolGateResult {
  const pkg = input.workPackage;
  if (!pkg) {
    return { allowed: true, action: null };
  }

  const toolName = (input.toolName ?? "").trim();
  if (!toolName) {
    return {
      allowed: false,
      reason: "工具名为空",
      action: null,
      code: "empty_tool_name",
    };
  }

  const action = mapToolNameToAction(toolName);
  if (action === null) {
    return {
      allowed: false,
      reason: `工作包拒绝未知工具：${toolName}`,
      action: null,
      code: "unknown_action",
    };
  }

  try {
    assertActionAllowed(pkg, action);
  } catch (err) {
    const code =
      err instanceof AgentWorkPackageError ? err.code : "action_not_allowed";
    const reason = err instanceof Error ? err.message : String(err);
    return { allowed: false, reason, action, code };
  }

  for (const path of collectPathArgs(input.toolArgs)) {
    try {
      assertResourceInScope(pkg, path);
    } catch (err) {
      const code =
        err instanceof AgentWorkPackageError ? err.code : "resource_out_of_scope";
      const reason = err instanceof Error ? err.message : String(err);
      return { allowed: false, reason, action, code };
    }
  }

  return { allowed: true, action };
}

/**
 * 校验代理输入对象是否仅含工作包白名单字段。
 * 供编排器在调用代理前强制执行（MA-3.2）。
 */
export function evaluateInputAgainstWorkPackage(input: {
  workPackage: AgentWorkPackage;
  payload: Record<string, unknown>;
}): WorkPackageToolGateResult {
  try {
    assertInputFieldsWhitelisted(input.workPackage, input.payload);
    return { allowed: true };
  } catch (err) {
    const code =
      err instanceof AgentWorkPackageError ? err.code : "input_field_not_allowed";
    const reason = err instanceof Error ? err.message : String(err);
    return { allowed: false, reason, code };
  }
}
