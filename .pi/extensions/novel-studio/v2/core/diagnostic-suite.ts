/**
 * V2 DiagnosticSuite — 诊断套件（P5）
 *
 * 目标（规格 P5）：旧 gate 降权为诊断提供者。只诊断不改文。
 *
 * 设计原则：
 * - 诊断不能直接改文
 * - 诊断不能直接触发整章重写
 * - 每个 diagnostic 必须可定位证据
 * - 硬阻断（fatal/hard）仅 6 类白名单：
 *   format_hard_gate / duplicate_scan / scene_continuity / entity_checker / skeleton_consistency / event_progression
 * - 其余 provider 只能产出 review/info severity
 *
 * DiagnosticProvider 接口：只输出结构化问题清单，不返回 text 修改，不触发整章重写。
 */

import type {
  Diagnostic,
  DiagnosticSeverity,
  Candidate,
  CompiledContext,
} from "./types.js";
import type { ChapterSeed } from "../../craft/chapter-seed-types.js";

// ============================================================================
// DiagnosticProvider 接口
// ============================================================================

export interface DiagnosticInput {
  candidate: Candidate;
  context: CompiledContext;
  seed?: ChapterSeed;
}

export interface DiagnosticProvider {
  /** provider id，对应 hard-block 白名单或诊断类 id */
  id: string;
  /** 声明的最高 severity（受 HARD_BLOCK_PROVIDERS 白名单约束） */
  maxSeverity: DiagnosticSeverity;
  /** 诊断函数：只输出 Diagnostic[]，不改文不触发重写 */
  diagnose(input: DiagnosticInput): Diagnostic[];
}

// ============================================================================
// Hard-block 白名单（仅 6 类）
// ============================================================================

export const HARD_BLOCK_PROVIDERS = new Set<string>([
  "format_hard_gate",
  "duplicate_scan",
  "scene_continuity",
  "entity_checker",
  "skeleton_consistency",
  "event_progression",
]);

const SEVERITY_RANK: Record<DiagnosticSeverity, number> = {
  fatal: 4,
  hard: 3,
  review: 2,
  info: 1,
};

/**
 * 校验 provider 是否在 hard-block 白名单内。
 * 非白名单 provider 的 maxSeverity 不得超过 review。
 */
export function isHardBlockProvider(providerId: string): boolean {
  return HARD_BLOCK_PROVIDERS.has(providerId);
}

/**
 * 强制降级：非白名单 provider 的 fatal/hard 诊断会被降级为 review。
 * 这是防止旧 gate 越权触发整章重写的最后防线。
 */
export function enforceHardBlockWhitelist(
  provider: DiagnosticProvider,
  diagnostics: Diagnostic[]
): Diagnostic[] {
  if (isHardBlockProvider(provider.id)) {
    return diagnostics;
  }
  // 非白名单：fatal→review, hard→review
  return diagnostics.map((d) => {
    if (d.severity === "fatal" || d.severity === "hard") {
      return {
        ...d,
        severity: "review" as DiagnosticSeverity,
        evidence: `[降级：非白名单 provider ${provider.id} 不得 hard_block] ${d.evidence}`,
      };
    }
    return d;
  });
}

// ============================================================================
// DiagnosticSuite 类
// ============================================================================

export interface DiagnosticSuiteRunResult {
  /** 全部诊断（已按白名单降级） */
  diagnostics: Diagnostic[];
  /** 按 severity 分组 */
  bySeverity: Record<DiagnosticSeverity, Diagnostic[]>;
  /** 是否存在硬阻断（fatal/hard） */
  hasHardBlock: boolean;
  /** 硬阻断诊断（仅来自白名单 provider） */
  hardBlocks: Diagnostic[];
  /** 各 provider 产出的诊断数 */
  providerCounts: Array<{ providerId: string; count: number; maxSeverity: DiagnosticSeverity }>;
}

export class DiagnosticSuite {
  private providers: DiagnosticProvider[] = [];

  register(provider: DiagnosticProvider): void {
    // 校验：非白名单 provider 的 maxSeverity 强制降为 review
    if (!isHardBlockProvider(provider.id) && SEVERITY_RANK[provider.maxSeverity] > SEVERITY_RANK.review) {
      throw new Error(
        `provider ${provider.id} 非白名单，maxSeverity 不得超过 review，实际 ${provider.maxSeverity}`
      );
    }
    this.providers.push(provider);
  }

  registerAll(providers: DiagnosticProvider[]): void {
    for (const p of providers) this.register(p);
  }

  listProviders(): DiagnosticProvider[] {
    return [...this.providers];
  }

  run(input: DiagnosticInput): DiagnosticSuiteRunResult {
    const all: Diagnostic[] = [];
    const providerCounts: DiagnosticSuiteRunResult["providerCounts"] = [];

    for (const provider of this.providers) {
      let diags = provider.diagnose(input);
      // 防御性：非白名单 provider 即使内部误返回 fatal/hard 也降级
      diags = enforceHardBlockWhitelist(provider, diags);
      // 防御性：每个 diagnostic 必须有证据
      diags = diags.filter((d) => typeof d.evidence === "string" && d.evidence.length > 0);
      all.push(...diags);
      providerCounts.push({
        providerId: provider.id,
        count: diags.length,
        maxSeverity: diags.reduce(
          (max, d) => (SEVERITY_RANK[d.severity] > SEVERITY_RANK[max] ? d.severity : max),
          "info" as DiagnosticSeverity
        ),
      });
    }

    const bySeverity: Record<DiagnosticSeverity, Diagnostic[]> = {
      fatal: all.filter((d) => d.severity === "fatal"),
      hard: all.filter((d) => d.severity === "hard"),
      review: all.filter((d) => d.severity === "review"),
      info: all.filter((d) => d.severity === "info"),
    };

    const hardBlocks = [...bySeverity.fatal, ...bySeverity.hard];

    return {
      diagnostics: all,
      bySeverity,
      hasHardBlock: hardBlocks.length > 0,
      hardBlocks,
      providerCounts,
    };
  }
}

export function createDiagnosticSuite(): DiagnosticSuite {
  return new DiagnosticSuite();
}

// ============================================================================
// 工具：断言 provider 不改文不触发重写
// ============================================================================

/**
 * 校验 Diagnostic 不含 text 修改字段（suggestedRepair 只能是 no_op 或 patch，不能是 chapter_rewrite）。
 * chapter_rewrite 只允许由 RepairPlanner 在 catastrophic 证据下产出，不由 diagnostic 直接携带。
 */
export function assertDiagnosticNoChapterRewrite(d: Diagnostic): boolean {
  if (d.suggestedRepair && d.suggestedRepair.kind === "chapter_rewrite") {
    return false;
  }
  return true;
}
