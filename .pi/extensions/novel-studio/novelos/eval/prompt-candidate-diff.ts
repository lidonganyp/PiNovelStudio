/**
 * MODEL-PROMPT-EVOLUTION-1（t4）— Prompt 候选差异（eval-only）
 *
 * 引入机器可读的候选差异格式（见 docs/model-version-isolation-prompt-evolution-development-plan.md §7.3），
 * 并与安全/实验分层（t3）联动，保证候选不越过系统边界。
 *
 * 候选不得直接编辑生产 Bundle；必须通过 Registry 生命周期（createEvalCandidate ->
 * draft -> eval -> ...）进入 Eval。本模块是纯描述层，不持有、不写入生产指针。
 *
 * 职责：
 * - PromptCandidateDiff：baseBundleId / candidateId / changes / hypothesis / 模型身份。
 * - PromptCandidateChange：surface / operation / id / description。
 * - validateCandidateDiff()：调用 t3 的 validateCandidateSurfaces()，检测候选是否
 *   越过系统边界（fail-closed）。越过边界 -> 不得进入 Eval。
 * - diffManifests()：由 base/candidate 两个 PromptBundleManifest 自动推导 changes，
 *   把「哪些组成 hash 变了」翻译成「哪些表面变了」，实现全自动敏感。
 *
 * eval-only：只注册在 tsconfig.eval.json，不进入生产构建。
 */

import {
  validateCandidateSurfaces,
  type ContractViolation,
  type PromptSurface,
} from "./prompt-security-contract.js";
import type { PromptBundleManifest } from "./prompt-bundle-manifest.js";

// ============================================================================
// 类型
// ============================================================================

/** 候选变更操作 */
export type PromptChangeOperation =
  | "add"       // 新增指令/提示
  | "remove"    // 移除指令/提示
  | "modify"    // 修改内容
  | "reorder"   // 重排顺序
  | "weaken";   // 削弱约束（敏感：可能越过边界）

/** 单个候选变更 */
export interface PromptCandidateChange {
  /** 变更表面（t3 的 PromptSurface） */
  surface: PromptSurface;
  /** 变更操作 */
  operation: PromptChangeOperation;
  /** 变更对象的机器可读 id（如 legacy_tool_plan_instruction） */
  id: string;
  /** 人类可读说明（可选） */
  description?: string;
}

/** 候选差异（§7.3 格式） */
export interface PromptCandidateDiff {
  /** 基线 Bundle ID（baseBundleId） */
  baseBundleId: string;
  /** 候选 Bundle ID（candidateId） */
  candidateId: string;
  /** 变更清单 */
  changes: PromptCandidateChange[];
  /** 进化假设（hypothesis） */
  hypothesis: string;
  /** 模型版本（如 gemini-3.1-pro） */
  modelVersion: string;
  /** provider（如 gemini） */
  provider: string;
  /** route（如 gemini_writer_v2） */
  route: string;
}

/** 候选差异校验结果 */
export interface CandidateDiffValidation {
  diff: PromptCandidateDiff;
  /** 是否通过（无契约违反） */
  passed: boolean;
  /** 契约违反清单（fail-closed） */
  violations: ContractViolation[];
  /** 变更涉及的表面是否全部在实验空间内 */
  allExperimental: boolean;
}

// ============================================================================
// 变更操作合法性
// ============================================================================

/**
 * 判定一个操作是否安全（不削弱契约）。
 *
 * 在实验表面上：
 * - add / modify / reorder 均视为可接受的实验操作；
 * - remove / weaken 视为敏感：即使表面是实验性的，也必须由人工确认（held），
 *   不能仅凭机器门禁通过。
 */
export function isSensitiveOperation(operation: PromptChangeOperation): boolean {
  return operation === "remove" || operation === "weaken";
}

// ============================================================================
// 候选差异校验（fail-closed）
// ============================================================================

/**
 * 校验候选差异是否违反不可变安全契约。
 *
 * 规则：
 * - 任一变更的表面属于系统边界（PROTECTED_SURFACES）-> 契约违反（t3）-> 不得进入 Eval。
 * - 变更表面在实验空间内 -> 契约层面通过；但 remove / weaken 仍标记为敏感，
 *   需要在生命周期中由人工确认（held），不得机器自动晋级。
 *
 * @param diff 候选差异
 */
export function validateCandidateDiff(diff: PromptCandidateDiff): CandidateDiffValidation {
  const surfaces = diff.changes.map((c) => c.surface);
  const violations = validateCandidateSurfaces(surfaces);
  const allExperimental = violations.length === 0;

  return {
    diff,
    passed: allExperimental,
    violations,
    allExperimental,
  };
}

/**
 * 便捷判断：候选差异是否可安全进入 Eval（无系统边界越界）。
 */
export function isCandidateEvalEligible(diff: PromptCandidateDiff): boolean {
  return validateCandidateDiff(diff).passed;
}

// ============================================================================
// 由 Bundle manifest 自动推导差异（全自动敏感）
// ============================================================================

/** 组成 hash -> 表面映射（与 bundle manifest 字段对应） */
const COMPONENT_SURFACE: Record<keyof PromptBundleManifest, PromptSurface | null> = {
  bundleId: null,
  modelVersion: null,   // 模型身份，不映射到表面
  provider: null,
  route: null,
  profileId: null,
  status: null,
  temperature: null,    // 请求参数，不映射到 Prompt 表面
  maxTokens: null,
  systemPromptHash: "system_prompt",
  userPromptRendererHash: "user_prompt_renderer",
  chapterContractRendererHash: "chapter_contract_renderer",
  toolSchemaHash: "tool_schema",
  toolProtocolHash: "tool_protocol",
  contextCompilerHash: "context_compiler",
  outputParserHash: "output_parser",
  terminationProtocolHash: "termination_protocol",
  providerCapabilityHash: "provider_capability",
  budgetHash: "budget",
};

/**
 * 由 base/candidate 两个 Bundle manifest 自动推导 changes。
 *
 * 对比所有组成 hash，凡变化者映射为对应表面的 modify 操作。
 * 系统边界表面变化会被 validateCandidateDiff() 拦截（fail-closed）。
 *
 * @param base 基线 manifest
 * @param candidate 候选 manifest
 * @param hypothesis 进化假设
 */
export function diffManifests(
  base: PromptBundleManifest,
  candidate: PromptBundleManifest,
  hypothesis: string,
): PromptCandidateDiff {
  const hashKeys = [
    "systemPromptHash",
    "userPromptRendererHash",
    "chapterContractRendererHash",
    "toolSchemaHash",
    "toolProtocolHash",
    "contextCompilerHash",
    "outputParserHash",
    "terminationProtocolHash",
    "providerCapabilityHash",
    "budgetHash",
  ] as const;
  type HashKey = (typeof hashKeys)[number];

  const changes: PromptCandidateChange[] = [];
  const seen = new Set<PromptSurface>();

  for (const key of hashKeys) {
    if (base[key] !== candidate[key]) {
      const surface = COMPONENT_SURFACE[key];
      if (surface && !seen.has(surface)) {
        seen.add(surface);
        changes.push({
          surface,
          operation: "modify",
          id: `bundle:${key}`,
          description: `${key} 变化：base=${base[key].slice(0, 8)} candidate=${candidate[key].slice(0, 8)}`,
        });
      }
    }
  }

  return {
    baseBundleId: base.bundleId,
    candidateId: candidate.bundleId,
    changes,
    hypothesis,
    modelVersion: candidate.modelVersion,
    provider: candidate.provider,
    route: candidate.route,
  };
}
