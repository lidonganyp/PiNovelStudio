/**
 * NovelOS Permission Policy（OPT-8.9）
 *
 * 4 级权限，按角色授予：
 * - workspace_read：读取 workspace 数据（章节正文、状态文件、skeleton 等）
 * - candidate_write：写入隔离的 candidate workspace 目录（novelos-sessions/{sessionId}/）
 * - project_propose：产生 patch proposal（不直接覆盖任何文件）
 * - final_commit：执行 FinalStateCommit（修改长期 NarrativeState + 保存正式章节）
 *
 * 角色权限矩阵：
 * | 角色        | workspace_read | candidate_write | project_propose | final_commit |
 * |-------------|:---:|:---:|:---:|:---:|
 * | agent       | ✅  | ✅  | ✅  | ❌  |
 * | orchestrator| ✅  | ✅  | ✅  | ✅  |
 *
 * 硬性边界：
 * - agent 永远不持有 final_commit
 * - candidate_write 路径白名单：仅 workspaces/{id}/novelos-sessions/{sessionId}/
 * - PI Host 不直接修改 NarrativeState（只有 orchestrator 在最终选择后提交）
 */

import { join, resolve, relative } from "path";

// ============================================================================
// 权限与角色
// ============================================================================

export type Permission =
  | "workspace_read"
  | "candidate_write"
  | "project_propose"
  | "final_commit";

export type Role = "agent" | "orchestrator";

// ============================================================================
// 角色权限矩阵
// ============================================================================

const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  agent: new Set<Permission>([
    "workspace_read",
    "candidate_write",
    "project_propose",
  ]),
  orchestrator: new Set<Permission>([
    "workspace_read",
    "candidate_write",
    "project_propose",
    "final_commit",
  ]),
};

// ============================================================================
// PermissionPolicy
// ============================================================================

export interface PermissionPolicyOptions {
  /** workspace 根目录（projectRoot/workspaces/{workspaceId}） */
  workspaceRoot: string;
  /** 当前 session ID（用于 candidate_write 路径白名单） */
  sessionId: string;
}

export class PermissionPolicy {
  private readonly workspaceRoot: string;
  private readonly sessionId: string;
  private readonly extraGrants = new Map<Role, Set<Permission>>();

  constructor(options: PermissionPolicyOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.sessionId = options.sessionId;
  }

  /** 角色是否持有权限 */
  can(role: Role, permission: Permission): boolean {
    const base = ROLE_PERMISSIONS[role];
    const extra = this.extraGrants.get(role);
    return base.has(permission) || (extra?.has(permission) ?? false);
  }

  /** 断言角色持有权限，否则抛错 */
  assertCan(role: Role, permission: Permission): void {
    if (!this.can(role, permission)) {
      throw new PermissionDeniedError(
        `角色 "${role}" 不持有权限 "${permission}"`,
        role,
        permission,
      );
    }
  }

  /** 追加授权（仅用于测试或 orchestrator 临时提权，不能给 agent 加 final_commit） */
  grant(role: Role, permission: Permission): void {
    if (role === "agent" && permission === "final_commit") {
      throw new PermissionDeniedError(
        "agent 角色永远不能持有 final_commit 权限",
        role,
        permission,
      );
    }
    let set = this.extraGrants.get(role);
    if (!set) {
      set = new Set();
      this.extraGrants.set(role, set);
    }
    set.add(permission);
  }

  /**
   * 校验 candidate_write 路径在白名单内。
   * 白名单：workspaceRoot/novelos-sessions/{sessionId}/ 下的文件。
   *
   * @param filePath 待写入的绝对路径
   * @returns 校验通过返回 true，否则 false
   */
  isCandidateWriteAllowed(filePath: string): boolean {
    const resolved = resolve(filePath);
    const allowedDir = resolve(
      join(this.workspaceRoot, "novelos-sessions", this.sessionId),
    );
    const rel = relative(allowedDir, resolved);
    // rel 不以 ".." 开头且不是绝对路径 → 在白名单目录内
    return rel !== "" && !rel.startsWith("..") && !resolve(rel).startsWith("..");
  }

  /** 断言 candidate_write 路径在白名单内 */
  assertCandidateWriteAllowed(filePath: string): void {
    if (!this.isCandidateWriteAllowed(filePath)) {
      throw new PermissionDeniedError(
        `candidate_write 路径不在白名单内：${filePath}（允许：${join(
          this.workspaceRoot,
          "novelos-sessions",
          this.sessionId,
        )}）`,
        "agent",
        "candidate_write",
      );
    }
  }

  /** 获取当前 session 的 candidate workspace 目录 */
  getCandidateWorkspaceDir(): string {
    return join(this.workspaceRoot, "novelos-sessions", this.sessionId);
  }
}

// ============================================================================
// 错误类型
// ============================================================================

export class PermissionDeniedError extends Error {
  readonly role: Role;
  readonly permission: Permission;

  constructor(message: string, role: Role, permission: Permission) {
    super(message);
    this.name = "PermissionDeniedError";
    this.role = role;
    this.permission = permission;
  }
}

// ============================================================================
// 工厂
// ============================================================================

export function createPermissionPolicy(
  options: PermissionPolicyOptions,
): PermissionPolicy {
  return new PermissionPolicy(options);
}
