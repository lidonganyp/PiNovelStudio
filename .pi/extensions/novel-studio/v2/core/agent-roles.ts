/**
 * AGENT-ROLES — 统一主链路代理角色枚举与权限 profile（MA 计划 Wave 1/2）
 *
 * 角色是编排器内职责边界，不等于 ActorType（model/orchestrator/user/system）。
 * 模型代理最高仅 bounded_execute；commit 级动作只允许 orchestrator/system actor。
 */

import type { ActionName, AutonomyLevel } from "./control-types.js";
import type { Permission } from "../../novelos/security/permission-policy.js";

/** 生产主链路代理角色（与 AuditStage 对齐但不等同） */
export type AgentRole =
  | "preflight"
  | "context_compiler"
  | "chapter_intent"
  | "novelos_agentic"
  | "fact_guard"
  | "author_style"
  | "story_preservation"
  | "final_fact_recheck"
  | "final_state_commit"
  | "audit";

export const AGENT_ROLES: readonly AgentRole[] = [
  "preflight",
  "context_compiler",
  "chapter_intent",
  "novelos_agentic",
  "fact_guard",
  "author_style",
  "story_preservation",
  "final_fact_recheck",
  "final_state_commit",
  "audit",
] as const;

export function isAgentRole(value: string): value is AgentRole {
  return (AGENT_ROLES as readonly string[]).includes(value);
}

/**
 * 角色权限 profile：声明允许动作、资源类与最高自主性。
 * 强制边界在 work-package / autonomy-policy / tool gate 执行。
 */
export interface AgentRoleProfile {
  role: AgentRole;
  /** 人类可读职责 */
  responsibility: string;
  /** 该角色默认可请求的动作 */
  allowedActions: readonly ActionName[];
  /** 明确禁止的动作 */
  forbiddenActions: readonly ActionName[];
  /** 对应 NovelOS PermissionPolicy 权限（agent 侧） */
  novelosPermissions: readonly Permission[];
  /** 模型侧最高自主性；门禁/系统角色为 observe */
  maxAutonomyLevel: AutonomyLevel;
  /** 是否允许写 candidate workspace */
  mayWriteCandidate: boolean;
  /** 是否允许读正式 chapters/ 与 NarrativeState（只读） */
  mayReadWorkspace: boolean;
  /** 是否允许产生 proposal（patch/建议） */
  mayPropose: boolean;
  /** 是否允许执行 commit 副作用（仅 final_state_commit + orchestrator actor） */
  mayCommit: boolean;
}

const COMMIT_ACTIONS: readonly ActionName[] = [
  "chapter.save",
  "state.commit",
  "release.promote",
  "baseline.replace",
];

const ROLE_PROFILES: Readonly<Record<AgentRole, AgentRoleProfile>> = {
  preflight: {
    role: "preflight",
    responsibility: "只读检查 workspace/风格档案/预算，不创作不改状态",
    allowedActions: ["workspace.read"],
    forbiddenActions: [
      "draft.generate",
      "editorial.optimize",
      "repair.suggest",
      "checkpoint.save",
      ...COMMIT_ACTIONS,
    ],
    novelosPermissions: ["workspace_read"],
    maxAutonomyLevel: "observe",
    mayWriteCandidate: false,
    mayReadWorkspace: true,
    mayPropose: false,
    mayCommit: false,
  },
  context_compiler: {
    role: "context_compiler",
    responsibility: "编译最小工作上下文与来源引用",
    allowedActions: ["workspace.read", "retrieval.execute"],
    forbiddenActions: [
      "draft.generate",
      "editorial.optimize",
      "checkpoint.save",
      ...COMMIT_ACTIONS,
    ],
    novelosPermissions: ["workspace_read"],
    maxAutonomyLevel: "observe",
    mayWriteCandidate: false,
    mayReadWorkspace: true,
    mayPropose: false,
    mayCommit: false,
  },
  chapter_intent: {
    role: "chapter_intent",
    responsibility: "形成章级任务目标，不规定句子写法",
    allowedActions: ["workspace.read"],
    forbiddenActions: [
      "draft.generate",
      "editorial.optimize",
      "checkpoint.save",
      ...COMMIT_ACTIONS,
    ],
    novelosPermissions: ["workspace_read"],
    maxAutonomyLevel: "suggest",
    mayWriteCandidate: false,
    mayReadWorkspace: true,
    mayPropose: true,
    mayCommit: false,
  },
  novelos_agentic: {
    role: "novelos_agentic",
    responsibility: "检索、验证、生成初稿与局部 patch 提案；不提交状态",
    allowedActions: [
      "workspace.read",
      "retrieval.execute",
      "draft.generate",
      "repair.suggest",
    ],
    forbiddenActions: [
      "editorial.optimize",
      "checkpoint.save",
      ...COMMIT_ACTIONS,
    ],
    novelosPermissions: ["workspace_read", "candidate_write", "project_propose"],
    maxAutonomyLevel: "bounded_execute",
    mayWriteCandidate: true,
    mayReadWorkspace: true,
    mayPropose: true,
    mayCommit: false,
  },
  fact_guard: {
    role: "fact_guard",
    responsibility: "事实核验；不改正文、不做风格裁决",
    allowedActions: ["workspace.read"],
    forbiddenActions: [
      "draft.generate",
      "editorial.optimize",
      "repair.suggest",
      "checkpoint.save",
      ...COMMIT_ACTIONS,
    ],
    novelosPermissions: ["workspace_read"],
    maxAutonomyLevel: "observe",
    mayWriteCandidate: false,
    mayReadWorkspace: true,
    mayPropose: false,
    mayCommit: false,
  },
  author_style: {
    role: "author_style",
    responsibility: "作者风格整章优化候选；不改事件骨架",
    allowedActions: ["workspace.read", "editorial.optimize"],
    forbiddenActions: [
      "draft.generate",
      "checkpoint.save",
      ...COMMIT_ACTIONS,
    ],
    novelosPermissions: ["workspace_read", "candidate_write", "project_propose"],
    maxAutonomyLevel: "bounded_execute",
    mayWriteCandidate: true,
    mayReadWorkspace: true,
    mayPropose: true,
    mayCommit: false,
  },
  story_preservation: {
    role: "story_preservation",
    responsibility: "故事保持核验；不重设剧情",
    allowedActions: ["workspace.read"],
    forbiddenActions: [
      "draft.generate",
      "editorial.optimize",
      "repair.suggest",
      "checkpoint.save",
      ...COMMIT_ACTIONS,
    ],
    novelosPermissions: ["workspace_read"],
    maxAutonomyLevel: "observe",
    mayWriteCandidate: false,
    mayReadWorkspace: true,
    mayPropose: false,
    mayCommit: false,
  },
  final_fact_recheck: {
    role: "final_fact_recheck",
    responsibility: "最终事实复核；不代替用户文学裁决",
    allowedActions: ["workspace.read"],
    forbiddenActions: [
      "draft.generate",
      "editorial.optimize",
      "repair.suggest",
      "checkpoint.save",
      ...COMMIT_ACTIONS,
    ],
    novelosPermissions: ["workspace_read"],
    maxAutonomyLevel: "observe",
    mayWriteCandidate: false,
    mayReadWorkspace: true,
    mayPropose: false,
    mayCommit: false,
  },
  final_state_commit: {
    role: "final_state_commit",
    responsibility: "编排器侧状态提交与原子保存；不生成正文",
    allowedActions: ["workspace.read", "checkpoint.save", "chapter.save", "state.commit"],
    forbiddenActions: [
      "draft.generate",
      "editorial.optimize",
      "repair.suggest",
      "release.promote",
      "baseline.replace",
    ],
    novelosPermissions: [
      "workspace_read",
      "candidate_write",
      "project_propose",
      "final_commit",
    ],
    maxAutonomyLevel: "commit",
    mayWriteCandidate: false,
    mayReadWorkspace: true,
    mayPropose: false,
    mayCommit: true,
  },
  audit: {
    role: "audit",
    responsibility: "汇总证据与血缘；不改变生产决策",
    allowedActions: ["workspace.read"],
    forbiddenActions: [
      "retrieval.execute",
      "draft.generate",
      "editorial.optimize",
      "repair.suggest",
      "checkpoint.save",
      ...COMMIT_ACTIONS,
    ],
    novelosPermissions: ["workspace_read"],
    maxAutonomyLevel: "observe",
    mayWriteCandidate: false,
    mayReadWorkspace: true,
    mayPropose: false,
    mayCommit: false,
  },
};

export function getAgentRoleProfile(role: AgentRole): AgentRoleProfile {
  return ROLE_PROFILES[role];
}

export function listAgentRoleProfiles(): readonly AgentRoleProfile[] {
  return AGENT_ROLES.map((role) => ROLE_PROFILES[role]);
}

/** 角色是否允许某动作（未知角色由调用方先 isAgentRole 拦截） */
export function roleAllowsAction(role: AgentRole, action: ActionName): boolean {
  const profile = ROLE_PROFILES[role];
  if (profile.forbiddenActions.includes(action)) return false;
  return profile.allowedActions.includes(action);
}
