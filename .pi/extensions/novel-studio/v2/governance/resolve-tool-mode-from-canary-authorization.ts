/**
 * resolveToolModeFromCanaryAuthorization — Phase 5 受控生产接入
 *
 * 从 workspace canary 授权解析叙事工具暴露模式（toolMode）。
 *
 * 设计原则（受控接入，非全量切换）：
 * - 只对**显式 opt-in 的 canary workspace** 启用 "facade"（统一入口 query_narrative_production）。
 * - 其余 workspace（授权缺失 / 未声明 toolMode / 声明 "standard"）一律返回 undefined
 *   （= 默认 "standard"，9 专用工具执行面不变）。
 * - fail-closed：无法读取/解析授权文件时返回 undefined（不因 I/O 错误误启用 facade），
 *   仅当授权**明确**声明 toolMode="facade" 且未过期时才会启用。
 *
 * 这是 "guided facade vs 9 工具" 的受控对照，不推广为"任意单入口 facade 更优"；
 * 失败或 promotion gate 不通过即回退 9 专用工具。
 */

import { loadCanaryAuthorizationFromFile } from "./canary-workspace-authorization.js";

/**
 * 从 workspace canary 授权文件解析 toolMode。
 *
 * @param projectRoot 项目根目录
 * @param workspaceId 目标 workspace ID
 * @param now 当前时间（测试可注入）；undefined 时用 Date.now()
 * @returns
 *   - "facade"：授权文件存在、schema 校验通过、toolMode 明确为 "facade" 且未过期。
 *   - undefined：授权缺失 / 未声明 toolMode / 声明 "standard" / 校验失败 / 过期
 *     （fail-closed，默认 9 专用工具标准行为）。
 */
export function resolveToolModeFromCanaryAuthorization(
  projectRoot: string,
  workspaceId: string,
  now?: Date | string,
): "facade" | undefined {
  const filePath = `${projectRoot}/workspaces/${workspaceId}/canary-authorization.json`;
  let authorization;
  try {
    authorization = loadCanaryAuthorizationFromFile(filePath);
  } catch {
    // I/O 失败 / schema 校验失败 → fail-closed：不启用 facade，走默认 standard 行为。
    return undefined;
  }

  // 过期授权不得启用 facade（避免用已失效的 opt-in 切换工具集）。
  if (authorization.toolMode === "facade") {
    const nowResolved = now ?? new Date();
    const nowMs = nowResolved instanceof Date
      ? nowResolved.getTime()
      : new Date(nowResolved).getTime();
    const expiresMs = new Date(authorization.expiresAt).getTime();
    if (Number.isNaN(expiresMs) || Number.isNaN(nowMs) || expiresMs <= nowMs) {
      return undefined;
    }
  }

  return authorization.toolMode === "facade" ? "facade" : undefined;
}