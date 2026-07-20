/**
 * CreativeConstitution — 作品级创意宪法（Phase 1，计划 §4.1）
 *
 * 表达"这一本书想成为什么"：作品身份、审美方向、类型承诺、人物核心矛盾、取舍偏好。
 * 只表达作品目标，不写句式配额、对白比例等机械指标。
 *
 * 设计原则：
 * - 用户明确要求优先级最高
 * - 自动学习不得修改 readerPromise / protagonistCoreConflict / thematicQuestions 等核心字段，只能提出 proposal
 * - 核心字段为 lockedFields，applyProposal 拒绝修改它们
 *
 * 路径：workspaces/{id}/creative-constitution.json
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";

// ============================================================================
// 类型定义
// ============================================================================

export interface NarrativePreference {
  id: string;
  preference: string;
  rationale?: string;
  evidenceSource: "user" | "accepted_revision" | "imported";
}

export interface CreativeConstitution {
  schemaVersion: number;
  workIdentity: string;
  readerPromise: string[];
  genrePromises: string[];
  protagonistCoreConflict: string;
  thematicQuestions: string[];
  aestheticDirection: string[];
  forbiddenDrift: string[];
  narrativePreferences: NarrativePreference[];
  updatedAt: string;
}

/**
 * 自动学习只能提出 proposal，不能直接改宪法。
 * targetField 限定为非核心字段：narrativePreferences / forbiddenDrift / aestheticDirection。
 */
export interface ConstitutionProposal {
  proposalId: string;
  targetField: "narrativePreferences" | "forbiddenDrift" | "aestheticDirection";
  proposedPreference?: NarrativePreference;
  proposedValue?: string;
  rationale: string;
  evidenceSource: "user" | "accepted_revision" | "imported";
  status: "pending" | "accepted" | "rejected";
  createdAt: string;
}

// ============================================================================
// 常量
// ============================================================================

export const CONSTITUTION_SCHEMA_VERSION = 1;
const FILE_NAME = "creative-constitution.json";

/** 核心字段：自动学习一律不得修改 */
export const LOCKED_FIELDS: ReadonlyArray<keyof CreativeConstitution> = [
  "workIdentity",
  "readerPromise",
  "genrePromises",
  "protagonistCoreConflict",
  "thematicQuestions",
  "schemaVersion",
];

// ============================================================================
// 路径与 IO
// ============================================================================

export function constitutionPath(workspaceId: string, projectRoot: string): string {
  return join(projectRoot, "workspaces", workspaceId, FILE_NAME);
}

export function loadCreativeConstitution(
  workspaceId: string,
  projectRoot: string
): CreativeConstitution | null {
  const path = constitutionPath(workspaceId, projectRoot);
  if (!existsSync(path)) {
    return null;
  }
  const raw = readFileSync(path, "utf-8");
  const parsed = JSON.parse(raw);
  const validation = validateConstitution(parsed);
  if (!validation.ok) {
    throw new Error(
      `CreativeConstitution 无效（${path}）：${validation.errors.join("; ")}`
    );
  }
  return parsed as CreativeConstitution;
}

export function saveCreativeConstitution(
  constitution: CreativeConstitution,
  workspaceId: string,
  projectRoot: string
): void {
  const path = constitutionPath(workspaceId, projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  const out: CreativeConstitution = { ...constitution, updatedAt: new Date().toISOString() };
  writeFileSync(path, JSON.stringify(out, null, 2), "utf-8");
}

// ============================================================================
// 校验
// ============================================================================

export interface ConstitutionValidation {
  ok: boolean;
  errors: string[];
}

export function validateConstitution(obj: unknown): ConstitutionValidation {
  const errors: string[] = [];
  if (typeof obj !== "object" || obj === null) {
    return { ok: false, errors: ["根对象不是对象"] };
  }
  const c = obj as Partial<CreativeConstitution>;
  if (typeof c.schemaVersion !== "number") errors.push("schemaVersion 必须为 number");
  if (typeof c.workIdentity !== "string" || !c.workIdentity) errors.push("workIdentity 必须为非空 string");
  if (!Array.isArray(c.readerPromise)) errors.push("readerPromise 必须为 string[]");
  if (!Array.isArray(c.genrePromises)) errors.push("genrePromises 必须为 string[]");
  if (typeof c.protagonistCoreConflict !== "string" || !c.protagonistCoreConflict)
    errors.push("protagonistCoreConflict 必须为非空 string");
  if (!Array.isArray(c.thematicQuestions)) errors.push("thematicQuestions 必须为 string[]");
  if (!Array.isArray(c.aestheticDirection)) errors.push("aestheticDirection 必须为 string[]");
  if (!Array.isArray(c.forbiddenDrift)) errors.push("forbiddenDrift 必须为 string[]");
  if (!Array.isArray(c.narrativePreferences)) {
    errors.push("narrativePreferences 必须为数组");
  } else {
    c.narrativePreferences.forEach((p, i) => {
      if (!p || typeof p.preference !== "string" || !p.preference)
        errors.push(`narrativePreferences[${i}].preference 必须为非空 string`);
      if (!["user", "accepted_revision", "imported"].includes(p.evidenceSource))
        errors.push(`narrativePreferences[${i}].evidenceSource 非法：${p.evidenceSource}`);
    });
  }
  return { ok: errors.length === 0, errors };
}

// ============================================================================
// 默认骨架（无宪法文件时提供最小可用 scaffold，不阻断生成）
// ============================================================================

export function defaultConstitution(workIdentity: string): CreativeConstitution {
  return {
    schemaVersion: CONSTITUTION_SCHEMA_VERSION,
    workIdentity,
    readerPromise: [],
    genrePromises: [],
    protagonistCoreConflict: "",
    thematicQuestions: [],
    aestheticDirection: [],
    forbiddenDrift: [],
    narrativePreferences: [],
    updatedAt: new Date().toISOString(),
  };
}

// ============================================================================
// Proposal 应用（自动学习唯一入口）
// ============================================================================

export interface ProposalApplyResult {
  constitution: CreativeConstitution;
  applied: boolean;
  reason: string;
}

/**
 * 应用 proposal 到宪法。
 *
 * 硬约束：
 * - targetField 必须为非核心字段（narrativePreferences / forbiddenDrift / aestheticDirection）
 * - 修改核心字段（LOCKED_FIELDS）的 proposal 一律拒绝
 * - narrativePreferences 追加，不覆盖；forbiddenDrift / aestheticDirection 追加去重
 *
 * 注意：本函数只产出"提议后的宪法副本"，是否落盘由调用方决定（用户审阅点）。
 */
export function applyProposal(
  constitution: CreativeConstitution,
  proposal: ConstitutionProposal
): ProposalApplyResult {
  // 核心字段锁定
  if ((LOCKED_FIELDS as readonly string[]).includes(proposal.targetField)) {
    return {
      constitution,
      applied: false,
      reason: `核心字段 ${proposal.targetField} 已锁定，自动学习不得修改`,
    };
  }

  const next: CreativeConstitution = {
    ...constitution,
    narrativePreferences: [...constitution.narrativePreferences],
    forbiddenDrift: [...constitution.forbiddenDrift],
    aestheticDirection: [...constitution.aestheticDirection],
  };

  if (proposal.targetField === "narrativePreferences") {
    if (!proposal.proposedPreference) {
      return { constitution, applied: false, reason: "narrativePreferences proposal 缺少 proposedPreference" };
    }
    next.narrativePreferences.push(proposal.proposedPreference);
  } else if (proposal.targetField === "forbiddenDrift") {
    if (!proposal.proposedValue) {
      return { constitution, applied: false, reason: "forbiddenDrift proposal 缺少 proposedValue" };
    }
    if (!next.forbiddenDrift.includes(proposal.proposedValue)) {
      next.forbiddenDrift.push(proposal.proposedValue);
    }
  } else if (proposal.targetField === "aestheticDirection") {
    if (!proposal.proposedValue) {
      return { constitution, applied: false, reason: "aestheticDirection proposal 缺少 proposedValue" };
    }
    if (!next.aestheticDirection.includes(proposal.proposedValue)) {
      next.aestheticDirection.push(proposal.proposedValue);
    }
  }

  next.updatedAt = new Date().toISOString();
  return { constitution: next, applied: true, reason: `已追加到 ${proposal.targetField}` };
}

// ============================================================================
// 工厂
// ============================================================================

export function createCreativeConstitutionStore(): {
  load: typeof loadCreativeConstitution;
  save: typeof saveCreativeConstitution;
  applyProposal: typeof applyProposal;
} {
  return { load: loadCreativeConstitution, save: saveCreativeConstitution, applyProposal };
}
