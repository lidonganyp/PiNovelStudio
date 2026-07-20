/**
 * NB-4：Generation Matrix B0-B4 五层生成矩阵
 *
 * 在同模型 / 同 case / 同 seed / 同 budget 下，按能力层叠加对比，证明系统输出
 * 是否稳定优于裸模型。每层只叠加声明的能力，便于测量边际贡献。
 *
 * 五层定义（冻结计划 §8.1，R1 恢复冻结层定义）：
 * - B0 PureModel：evalMode="B0"，空 intent + 空 context（裸模型 + 前文），raw 后直接交付
 * - B1 CompiledContext：evalMode="B1"，空 intent + 基础 context（genre worldRule），raw 后直接交付
 * - B2 AgenticRetrieval：evalMode="B2"，完整 intent + 完整 context + agentic(retrieval=true, verify=false)
 * - B3 VerifiedAgenticRaw：evalMode="B3"，B2 输入 + agentic(retrieval=true, verify=true) + FactGuard
 * - B4 EditorialSelection：evalMode="B4"，B3 输入 + editorial candidates + pairwise judge + select
 *
 * R1 架构变更（通过 novel_generate_chapter 公开入口进入）：
 * - B0-B4 全部通过 `runUnifiedPipeline`（= novel_generate_chapter 内部入口）走主链路
 * - 不直接实例化 UnifiedOrchestrator（由 runUnifiedPipeline 在 eval 模式下内部创建）
 * - 层级差异由 evalMode 控制（agentic 消融 + FactGuard 消融 + editorial/judge 消融）
 * - agenticCandidateSource 由 runUnifiedPipeline 按 evalMode 自动构造（B2/B3/B4）
 * - B4 judge 由 orchestrate 内部 JudgeArbitrator 完成
 *
 * 回退策略（冻结计划 §8.1 边际贡献测量）：
 * - B3 FactGuard 阻断 → 回退 one_shot_raw（fallbackFrom="B2"）
 * - B4 judge 选 raw 或 FactGuard 阻断 → winner="B2"（fallbacked=true）
 * - B2 agentic 失败 → 回退 one_shot_raw（fallbackFrom="B1"）
 * - raw 输出永久保留：所有层文本（含失败层）写入 result.layers，CLI 落盘
 *
 * 架构边界（generator 进程隔离）：
 * - 本模块是 generator 进程，只读 GeneratorCase（无 sourcePath / offset / referenceBody）
 * - 只 import eval-pipeline-adapter（主链路入口）+ types.js（纯类型）+ v2 ModelGenerateFn 类型
 * - 严禁 import reference-registry / reference-analyzer / dataset-builder / leakage-scanner / chapter-splitter
 * - reference 访问由 evaluator 进程在生成完成后进行（NB-5 Judge）
 *
 * 本模块为 eval-only，由 tsconfig.eval.json 编译到 dist-eval/，不进 dist/。
 */

import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import type { GeneratorCase } from "./types.js";
import type {
  ModelGenerateFn,
} from "../v2/adapters/legacy-model-route-adapter.js";
import {
  runEvalLayer,
  type EvalLayerName,
  type EvalLayerOutput,
} from "./eval-pipeline-adapter.js";
import type { RuntimeProvenance } from "./runtime-provenance-collector.js";

/**
 * eval layer runner 函数签名（与 eval-pipeline-adapter.runEvalLayer 一致）。
 * 导出为类型别名，供 GenerationMatrixInput.evalLayerRunner 注入测试 stub。
 */
export type EvalLayerRunner = (
  layer: EvalLayerName,
  genCase: GeneratorCase,
  prefix: string,
  modelGenerate: ModelGenerateFn,
  generateRoute: string,
  judgeRoute: string,
  seed?: number,
  timeoutMs?: number,
  /** DEMO-3-R2.4：已知角色名，传入 StoryPreservationGate 的 knownEntities */
  characterNames?: string[],
) => Promise<EvalLayerOutput>;

// ─────────────────────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────────────────────

/** 能力层名 */
export type LayerName = "B0" | "B1" | "B2" | "B3" | "B4";

/**
 * B4 结果分类（DEMO-3-R1 阶段2：fallback 状态误分类修复；DEMO-3-R2.1 扩展）。
 *
 * 明确定义 B4 的所有可能交付状态，让外层 judge 能正确分入：
 * - pairOutcomesPure：仅 editorial_win（editorial 候选产生且被选出）
 * - pairOutcomesWithFallback：其余所有状态（B4 文本 = raw，未测量 editorial 增量贡献）
 *
 * 分类优先级（classifyB4Outcome 内部按此顺序判定）：
 * 1. orchestrate_failed — B4 runUnifiedPipeline 失败/blocked
 * 2. editorial_win — selectedSource="editorial"（editorial 候选胜出）
 * 3. factguard_block — editorial 候选已生成但全部被 FactGuard 拒绝（stage5a 或 final FactGuard）
 * 4. story_preservation_block — editorial 候选已通过 FactGuard 但全部被 StoryPreservationGate 拒绝
 * 5. budget_fallback — selectedSource="raw" + warnings 含 "软上限"
 * 6. judge_all_failed — judgeArbitration.error="全部裁判异常"
 * 7. judge_degraded — judgeArbitration.rounds[0].degraded=true 或 auditSummary 含 "降级"
 * 8. judge_conflict — judgeArbitration.conflicted=true
 * 9. judge_raw — judgeArbitration 存在且正常（judge 正常选 raw，editorial 未胜出）
 * 10. no_editorial — judgeArbitration 为 null/undefined（0 hypothesis / Thompson 未准入 / 未生成候选）
 *
 * DEMO-3-R2.1：新增 story_preservation_block，区分"无机会"与"候选被故事保持门禁拒绝"。
 * 三者（no_editorial / factguard_block / story_preservation_block）都属于 fallback，
 * 但原因必须准确，且均不进入 pairOutcomesPure。
 */
export type B4OutcomeType =
  | "editorial_win"
  | "judge_raw"
  | "judge_degraded"
  | "judge_conflict"
  | "judge_all_failed"
  | "no_editorial"
  | "factguard_block"
  | "story_preservation_block"
  | "budget_fallback"
  | "orchestrate_failed";

/**
 * B4 层详细元数据（DEMO-3-R1 阶段1：editorial 故事重建修复 — trace 持久化）。
 *
 * 持久化 editorial 候选预览和 judge 状态到 result.json，使得事后可以验证：
 * - editorial 候选是否基于 raw 增量编辑（而非重建不同故事）
 * - judge 是否降级/冲突
 * - fallback 的具体原因
 */
export interface B4Details {
  /** B4 最终选择来源（raw/editorial） */
  selectedSource: "raw" | "editorial";
  /** B4 结果分类 */
  outcomeType: B4OutcomeType;
  /** judge auditSummary（如有） */
  judgeAuditSummary: string | null;
  /** judge 是否降级（rounds[0].degraded 或 auditSummary 含"降级"） */
  judgeDegraded: boolean;
  /** judge 是否冲突（两轮裁判冲突） */
  judgeConflicted: boolean;
  /** judge 是否全部异常（judgeArbitration.error 存在） */
  judgeAllFailed: boolean;
  /** editorial 机会数（hypotheses 数，来自 stageResults.editorialOpportunity） */
  hypothesesCount: number;
  /** editorial 候选数（来自 result.candidates 中 kind=editorial_amplified 的数量） */
  editorialCandidateCount: number;
  /** editorial 候选预览（前 500 字符，用于验证是否基于 raw 增量编辑） */
  editorialCandidatePreviews: Array<{ id: string; preview: string }>;
  /** raw 候选预览（前 500 字符，用于对比 editorial 是否同故事） */
  rawCandidatePreview: string;
  /** B4 层 warnings（用于诊断 fallback 原因） */
  warnings: string[];
  /**
   * DEMO-3-R2.1 新增：各阶段候选数量和拒绝原因持久化。
   *
   * 用于区分 fallback 子类型（no_editorial / factguard_block / story_preservation_block），
   * 使 outcome 分类有可审计的证据。
   */
  /** FactGuard 拒绝的 editorial 候选数（stage5a） */
  factGuardRejectionCount: number;
  /** StoryPreservation 拒绝的 editorial 候选数（stage5a.1） */
  storyPreservationRejectionCount: number;
  /** StoryPreservation 各候选的门禁报告摘要（含 rejectionType） */
  storyPreservationReports: Array<{
    candidateId: string;
    preserved: boolean;
    unverifiable: boolean;
    rejectionType: "missing_event" | "replaced_event" | "order_violation" | "unverifiable" | null;
    missingEventCount: number;
    replacedEventCount: number;
    orderViolationCount: number;
    reason: string;
  }>;
  /**
   * DEMO-3-R2.4 新增：orchestrator 运行 ID（唯一标识单次 B4 orchestrate() 运行）。
   *
   * raw 与 editorial 候选必须属于同一 orchestratorRunId，才能证明它们来自同一次
   * B4 orchestrate() 内部的候选对（而非跨 layer 的独立运行）。
   * R2.3 provenance 守卫的核心校验项。
   */
  orchestratorRunId: string;
  /**
   * DEMO-3-R2.4 新增：候选产物元数据（路径 + hash，不含完整正文）。
   *
   * result.json 只保存路径/hash/元数据，完整正文保存到 b4-artifacts/ 目录的独立文件。
   * provenance 守卫通过这些元数据从磁盘读取正文并校验 SHA-256。
   */
  rawArtifact: B4CandidateArtifactMeta;
  editorialArtifacts: B4CandidateArtifactMeta[];
}

/**
 * DEMO-3-R2.4：单个 B4 候选的产物元数据（保存到 result.json，不含完整正文）。
 *
 * 完整正文保存到 b4-artifacts/{kind}-{candidateId}.md 文件，
 * 此处只记录路径/hash/身份元数据供 provenance 守卫校验。
 */
export interface B4CandidateArtifactMeta {
  /** 候选 ID（与 orchestrate 内部 candidates[].id 一致） */
  candidateId: string;
  /** 候选类型：raw = B4 内部 rawCandidate；editorial_amplified = editorial 候选 */
  candidateKind: "raw" | "editorial_amplified";
  /** 指向的 raw 候选 ID（raw 自身 = 自身 candidateId；editorial = 其所基于的 raw 候选 ID） */
  rawCandidateId: string;
  /** 产物文件相对路径（相对于 case 输出目录，如 b4-artifacts/raw-{candidateId}.md） */
  sourcePath: string;
  /** 正文 SHA-256 hash（hex，无前缀） */
  contentHash: string;
  /** 正文长度（字符数） */
  textLength: number;
}

/**
 * DEMO-3-R2.4：B4 完整候选产物（含完整正文，供 CLI 落盘到 b4-artifacts/）。
 *
 * runGenerationMatrix 返回此结构，由 CLI 负责将完整正文写入独立文件、
 * 将元数据写入 run.json。result.json 只引用路径和 hash。
 */
export interface B4Artifacts {
  /** 唯一标识本次 B4 orchestrate() 运行 */
  orchestratorRunId: string;
  /** case 标识 */
  caseId: string;
  /** layer 固定为 "B4" */
  layer: "B4";
  /** 生成时间（ISO） */
  generatedAt: string;
  /** raw 候选完整产物（含完整正文） */
  rawCandidate: B4CandidateArtifact;
  /** editorial 候选完整产物列表（含完整正文） */
  editorialCandidates: B4CandidateArtifact[];
  /** 编辑机会 hypotheses（完整） */
  hypotheses: unknown[];
  /** FactGuard 完整结果（每个 editorial 候选） */
  editorialFactGuard: Array<{
    candidateId: string;
    passed: boolean;
    errors: string[];
  }>;
  /** StoryPreservationGate 完整报告（每个通过 FactGuard 的候选） */
  editorialStoryPreservation: unknown[];
  /** judge 仲裁结果（完整） */
  judgeArbitration: unknown;
  /** 全部仲裁结果（每个 editorial 候选 vs raw） */
  allArbitrationResults: unknown[];
  /** 最终选中的候选 ID */
  selectedCandidateId: string;
  /** 最终选中来源（raw/editorial） */
  selectedSource: "raw" | "editorial";
  /** 最终交付来源层 */
  finalSource: "B2" | "B3";
  /** 是否 fallback（outcomeType !== editorial_win） */
  fallbacked: boolean;
  /** B4 结果分类 */
  outcomeType: B4OutcomeType;
  /** B4 层 warnings */
  warnings: string[];
  /**
   * DEMO-3-R2.5 新增：运行时代码 provenance 指纹。
   * 由 CLI 在启动时采集并传入，写入 run.json，使产物可复现验证。
   * 包含 codeCommit / worktreeDirty / runtimeFilesHash / buildArtifactHash /
   * model / modelVersion / seed / costProfile / envSwitches。
   * 不含密钥值。
   */
  runtimeProvenance?: RuntimeProvenance;
}

/**
 * DEMO-3-R2.4：单个 B4 候选的完整产物（含完整正文，供 CLI 落盘）。
 */
export interface B4CandidateArtifact {
  /** 候选 ID */
  candidateId: string;
  /** 候选类型 */
  candidateKind: "raw" | "editorial_amplified";
  /** 指向的 raw 候选 ID */
  rawCandidateId: string;
  /** 完整正文（CLI 写入 {kind}-{candidateId}.md） */
  text: string;
  /** 正文 SHA-256 hash（hex） */
  contentHash: string;
  /** 正文长度 */
  textLength: number;
  /** opportunity hypothesis ID（仅 editorial，raw 留空） */
  hypothesisId?: string;
  /** editorial 策略（仅 editorial，raw 留空） */
  editorialStrategy?: string;
}

/** 单层结果（含失败层，用于永久保留 raw 输出） */
export interface LayerResult {
  layer: LayerName;
  /** 生成正文（失败时为空字符串） */
  text: string;
  /** 实际使用的模型 */
  model: string;
  /** 路由名 */
  route: string;
  /** 耗时 ms */
  durationMs: number;
  /** 是否成功 */
  success: boolean;
  /**
   * 回退来源层（仅 B3/B4 失败回退时填）：
   * - B3 无 editorial → fallbackFrom: "B2"（B3 文本 = raw 文本）
   * - B4 未产出/未选出 editorial 候选 → fallbackFrom: "B2"（B4 文本 = raw 文本）
   *
   * DEMO-3-R1 修正：B4 fallbackFrom 的判定从"judgeArbitration 不存在"改为
   * "outcomeType !== editorial_win"（所有非 editorial 胜出的结果都是 fallback）。
   */
  fallbackFrom?: LayerName;
  /** 失败原因（success=false 或 fallbackFrom 存在时填） */
  fallbackReason?: string;
  /** prompt hash（用于 judge 缓存键） */
  promptHash?: string;
  /** B4 层详细元数据（仅 B4 层填，用于 trace 持久化和 fallback 诊断） */
  b4Details?: B4Details;
  /**
   * DEMO-3-R2.4 新增：B4 完整候选产物（含完整正文，供 CLI 落盘到 b4-artifacts/）。
   * 仅 B4 层填；CLI 读取此字段将完整正文写入独立文件，result.json 只引用路径/hash。
   */
  b4Artifacts?: B4Artifacts;
}

/** B4 Judge 决策 */
export interface JudgeDecision {
  /** 胜出层（B4 judge 选 raw 时为 "B2"，选 editorial 时为 "B3"） */
  winner: "B2" | "B3";
  /** 决策理由（从 orchestrate judgeResult.auditSummary 提取） */
  reason: string;
  /** 匿名映射：A/B 哪个是 B2 / B3（基于 seed，可复现） */
  anonymizedMapping: { A: "B2" | "B3"; B: "B2" | "B3" };
  /**
   * 是否因 B4 未产出/未选出 editorial 候选而回退（true 时 winner="B2"）。
   *
   * DEMO-3-R1 修正：fallbacked = (outcomeType !== "editorial_win")。
   * 所有非 editorial 胜出的结果（judge 选 raw、judge 降级、FactGuard 阻断、
   * 预算回退、无编辑机会、orchestrate 失败）都是 fallback。
   */
  fallbacked: boolean;
  /** B4 结果分类（DEMO-3-R1 阶段2 新增，用于 pure/fallback 分桶） */
  outcomeType: B4OutcomeType;
}

/** 路由配置（每层独立路由，默认同模型） */
export interface GenerationMatrixRoutes {
  b0: string;
  b1: string;
  b2: string;
  b3: string;
  b4: string;
}

/** 生成矩阵输入 */
export interface GenerationMatrixInput {
  /** 生成器可见的 sanitized case（无 sourcePath / offset / referenceBody） */
  case: GeneratorCase;
  /** 前文 prefix（generationInput .txt 内容，CLI 读取后传入） */
  prefix: string;
  /** 模型调用函数（由 CLI 注入，已绑定 benchmarkCostProfile 守卫） */
  modelGenerate: ModelGenerateFn;
  /** 五层路由配置 */
  routes: GenerationMatrixRoutes;
  /** 随机种子（B4 匿名映射 + 可复现） */
  seed?: number;
  /** 单次模型调用超时 ms（默认 600000） */
  timeoutMs?: number;
  /** 目标字数（默认 2500，写入 B1/B2 prompt） */
  targetWordCount?: number;
  /**
   * 可选：自定义 eval layer runner（测试注入用，默认用 eval-pipeline-adapter.runEvalLayer）。
   * 生产路径由 CLI 调用时不传此字段，走真实主链路 orchestrate。
   * 测试用 stub 替换以隔离 runner 逻辑（toLayerResult/judgeDecision 提取/fallback 检测）
   * 与 orchestrate 内部行为，遵循项目"依赖注入桩"约定（不依赖实验性 mock.module）。
   */
  evalLayerRunner?: EvalLayerRunner;
  /**
   * DEMO-3-R2.4 新增：已知角色名列表。
   * 传入 StoryPreservationGate 的 knownEntities，使 R2.2 门禁能在真实管线内执行。
   * 不传时为空数组（门禁返回 unverifiable）。
   */
  characterNames?: string[];
  /**
   * DEMO-3-R2.5 新增：运行时代码 provenance 指纹。
   * 由 CLI 在启动时采集（git commit + 文件 hash + 构建产物 hash + 环境开关），
   * 传入后写入 B4Artifacts.run.json，使产物可复现验证。
   * 不传时 B4Artifacts 不含 runtimeProvenance 字段（兼容旧测试）。
   */
  runtimeProvenance?: RuntimeProvenance;
}

/** 生成矩阵输出 */
export interface GenerationMatrixResult {
  caseId: string;
  /** 五层结果（含失败层，永久保留） */
  layers: {
    B0: LayerResult;
    B1: LayerResult;
    B2: LayerResult;
    B3: LayerResult;
    B4: LayerResult;
  };
  /** B4 Judge 决策（B4 层为 winner 文本；失败回退时 winner=B2） */
  judgeDecision: JudgeDecision;
  /** 最终交付正文（= judgeDecision.winner 对应层文本） */
  finalText: string;
  /** 最终交付来源层 */
  finalSource: "B2" | "B3";
  /** 总耗时 ms */
  totalDurationMs: number;
  /** 总模型调用次数（各层 modelCalls 累加） */
  totalModelCalls: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 600000;
const DEFAULT_TARGET_WORD_COUNT = 2500;

// ─────────────────────────────────────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────────────────────────────────────

/**
 * DEMO-3-R2.4：计算文本的 SHA-256 hash（hex，无前缀）。
 *
 * 用于 B4 候选产物的 contentHash，provenance 守卫从磁盘读取正文后
 * 重新计算并与此值比对，确保文件内容未被篡改。
 */
export function computeSha256(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

/**
 * DEMO-3-R2.4：生成唯一的 orchestratorRunId。
 *
 * 格式：b4-run-{timestamp}-{uuid短前缀}
 * 唯一标识单次 B4 orchestrate() 运行，使 raw 与 editorial 候选可被 provenance 守卫
 * 校验为同一 run 的内部候选对（而非跨 layer 的独立运行）。
 */
export function generateOrchestratorRunId(): string {
  const ts = Date.now().toString(36);
  const uuidPrefix = randomUUID().replace(/-/g, "").slice(0, 12);
  return `b4-run-${ts}-${uuidPrefix}`;
}

/**
 * DEMO-3-R2.4：从候选 ID 派生安全的文件名（去除冒号等不安全字符）。
 *
 * candidateId 形如 "candidate:raw:chapter-001" → "candidate_raw_chapter-001"
 */
function sanitizeCandidateIdForFilename(candidateId: string): string {
  return candidateId.replace(/[:/\\]/g, "_");
}

/** 简易 hash（FNV-1a），用于 promptHash 缓存键 */
function fnv1aHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * 基于 seed 决定 B4 匿名映射。
 * seed 决定 A=B2 还是 A=B3，保证可复现。
 * 注意：Fix-1 后 B4 judge 由 orchestrate 内部 JudgeArbitrator 完成，
 * 匿名映射在 judge 内部，此处仅用于 JudgeDecision 接口向后兼容。
 */
function resolveAnonymizedMapping(seed?: number): { A: "B2" | "B3"; B: "B2" | "B3" } {
  // seed 为 undefined 或偶数时 A=B2；奇数时 A=B3
  const aIsB2 = seed === undefined ? true : (seed % 2 === 0);
  return aIsB2
    ? { A: "B2", B: "B3" }
    : { A: "B3", B: "B2" };
}

/**
 * judgeArbitration 的结构化形状（从 stageResults 读取）。
 *
 * 注意：mapOrchResultToV2Output（unified-entry.ts）已修复为保留 stageResults 中
 * 完整的 judgeArbitration（含 rounds/allArbitrations/error），不再从 orchResult.judgeResult
 * 重构简化版本。这使 rounds[0].degraded 可用于 judge 降级检测。
 */
interface JudgeArbitrationShape {
  error?: string;
  reverseReviewed?: boolean;
  arbitrationTriggered?: boolean;
  conflicted?: boolean;
  finalSelectedCandidateId?: string | null;
  auditSummary?: string;
  rounds?: Array<{ round: number; winnerCandidateId: string | null; degraded?: boolean }>;
  allArbitrations?: unknown[];
}

/**
 * editorialOpportunity 的结构化形状（从 stageResults 读取）。
 */
interface EditorialOpportunityShape {
  hypothesesCount?: number;
  noOpReason?: string | null;
  llmJudged?: boolean;
  llmFallbackReason?: string | null;
  signals?: unknown[];
}

/**
 * DEMO-3-R1 阶段2：分类 B4 交付结果。
 *
 * 按 B4OutcomeType 文档注释中的优先级判定。所有非 editorial_win 的结果都是 fallback。
 *
 * 关键修复：此前 fallbacked = "selectedSource=raw && !judgeArbitration"，
 * 但 judge 降级时 judgeArbitration 存在（含 rounds[0].degraded=true），
 * 导致降级回退被误判为非 fallback。现在用 outcomeType 统一分类。
 *
 * DEMO-3-R2.1 修复：
 * - factguard_block 匹配 "FactGuard"（覆盖 stage5a "未通过 FactGuard" 和 stage 6.5 "FactGuard 阻断"）
 * - 新增 story_preservation_block 匹配 "StoryPreservationGate"
 * - no_editorial 收紧为"0 hypothesis / Thompson 未准入 / 未生成候选"（judgeArbitration 为 null 且无上述 warning）
 */
function classifyB4Outcome(evalOutput: EvalLayerOutput): B4OutcomeType {
  const { result } = evalOutput;

  // 1. orchestrate 失败/blocked
  if (!evalOutput.success || result.status !== "ok") {
    return "orchestrate_failed";
  }

  const selectedSource = result.stageResults?.selectedSource as string | undefined;
  const judgeArbitration = result.stageResults?.judgeArbitration as
    | JudgeArbitrationShape
    | null
    | undefined;
  const warnings = (result.stageResults?.warnings as string[]) ?? [];

  // 2. editorial 胜出
  if (selectedSource === "editorial") {
    return "editorial_win";
  }

  // selectedSource === "raw" — 区分子类型

  // 3. FactGuard 阻断（editorial 候选已生成但全部被 FactGuard 拒绝，或 final FactGuard 复检失败）
  //    匹配两种 warning：
  //    - stage5a: "所有 editorial 候选均未通过 FactGuard，交付 raw"
  //    - stage 6.5: "evalMode=B4 final FactGuard 阻断：..."
  //    注意：此路径 judgeArbitration 可能存在（judge 已跑但 final FactGuard 阻断了最终正文）
  if (warnings.some((w) => w.includes("FactGuard"))) {
    return "factguard_block";
  }

  // 4. StoryPreservation 阻断（editorial 候选已通过 FactGuard，但全部被故事保持门禁拒绝）
  //    匹配 warning: "所有 editorial 候选均未通过 StoryPreservationGate（故事骨架漂移），交付 raw"
  if (warnings.some((w) => w.includes("StoryPreservationGate"))) {
    return "story_preservation_block";
  }

  // 5. 预算回退（SOFT 上限触发，跳过 editorial 候选生成）
  if (warnings.some((w) => w.includes("软上限"))) {
    return "budget_fallback";
  }

  // 6. 所有裁判异常（judgeArbitration.error 存在）
  if (judgeArbitration?.error) {
    return "judge_all_failed";
  }

  // 7. judge 降级（rounds[0].degraded=true 或 auditSummary 含"降级"）
  const firstRoundDegraded = judgeArbitration?.rounds?.[0]?.degraded === true;
  const auditSummaryDegraded = judgeArbitration?.auditSummary?.includes("降级") === true;
  if (firstRoundDegraded || auditSummaryDegraded) {
    return "judge_degraded";
  }

  // 8. judge 冲突（两轮裁判冲突）
  if (judgeArbitration?.conflicted === true) {
    return "judge_conflict";
  }

  // 9. judge 正常选 raw（judgeArbitration 存在且正常，editorial 未胜出）
  if (judgeArbitration) {
    return "judge_raw";
  }

  // 10. 无编辑机会（judgeArbitration 为 null/undefined，且无 FactGuard/StoryPreservation/预算 warning）
  //     对应：0 hypothesis / Thompson 未准入 / editorial 候选生成异常或未生成候选
  return "no_editorial";
}

/**
 * DEMO-3-R1 阶段1：从 EvalLayerOutput 提取 B4 详细元数据。
 *
 * 持久化 editorial 候选预览和 judge 状态，使得事后可以验证：
 * - editorial 候选是否基于 raw 增量编辑（而非重建不同故事）
 * - judge 降级/冲突的具体原因
 * - fallback 的具体路径
 *
 * DEMO-3-R2.4 新增：
 * - orchestratorRunId：唯一标识单次 B4 orchestrate() 运行
 * - rawArtifact / editorialArtifacts：候选产物元数据（路径+hash，不含完整正文）
 *   完整正文保存到 b4-artifacts/ 目录，result.json 只引用路径/hash。
 *   provenance 守卫通过这些元数据从磁盘读取正文并校验 SHA-256。
 */
function extractB4Details(
  evalOutput: EvalLayerOutput,
  outcomeType: B4OutcomeType,
  orchestratorRunId: string,
  caseId: string,
): B4Details {
  const { result } = evalOutput;
  const selectedSource = (result.stageResults?.selectedSource as string | undefined) ?? "raw";
  const selectedCandidateId =
    (result.stageResults?.selectedCandidateId as string | undefined) ?? "";
  const judgeArbitration = result.stageResults?.judgeArbitration as
    | JudgeArbitrationShape
    | null
    | undefined;
  const editorialOpportunity = result.stageResults?.editorialOpportunity as
    | EditorialOpportunityShape
    | null
    | undefined;
  const warnings = (result.stageResults?.warnings as string[]) ?? [];

  // 从 result.candidates 提取 editorial 候选和 raw 候选预览
  const candidates = (result.candidates as Array<{
    id: string;
    kind: string;
    text: string;
  }>) ?? [];
  const editorialCandidates = candidates.filter((c) => c.kind === "editorial_amplified");
  // DEMO-3-R2.4 修复：B4 主 raw 候选识别。
  // B4 模式下 orchestrator（unified-orchestrator.ts line 525）将 rawCandidate 替换为
  // agentic_raw，editorial 候选基于 agentic_raw 改写，FactGuard block 时也交付 agentic_raw。
  // 但 candidates 数组同时含 one-shot raw（candidate:raw:...，kind=context_enhanced）
  // 和 agentic_raw（candidate:agentic_raw:...，kind=agentic_raw），二者都
  // kind !== "editorial_amplified"。旧 find 返回第一个非 editorial = one-shot raw，
  // 导致 selectedCandidateId（= agentic_raw ID）不在候选列表，provenance 校验 14 失败。
  // 正确逻辑：selectedSource=raw 时用 selectedCandidateId 找实际交付的 raw；
  // 否则优先 agentic_raw（editorial 所基于的 raw），回退第一个非 editorial（B0/B1 无 agentic）。
  const rawCandidate =
    (selectedSource === "raw" && selectedCandidateId
      ? candidates.find((c) => c.id === selectedCandidateId)
      : null) ??
    candidates.find((c) => c.kind === "agentic_raw") ??
    candidates.find((c) => c.kind !== "editorial_amplified");

  // DEMO-3-R2.1: 提取 FactGuard 和 StoryPreservation 的 stageResults，持久化各阶段拒绝原因
  const editorialFactGuard = (result.stageResults?.editorialFactGuard as Array<{
    candidateId: string;
    passed: boolean;
    errors: string[];
  }> | undefined) ?? [];
  const factGuardRejectionCount = editorialFactGuard.filter((r) => !r.passed).length;

  const editorialStoryPreservation = (result.stageResults?.editorialStoryPreservation as Array<{
    candidateId: string;
    preserved: boolean;
    unverifiable: boolean;
    rejectionType: "missing_event" | "replaced_event" | "order_violation" | "unverifiable" | null;
    missingEventCount: number;
    replacedEventCount: number;
    orderViolationCount: number;
    reason: string;
  }> | undefined) ?? [];
  const storyPreservationRejectionCount = editorialStoryPreservation.filter((r) => !r.preserved).length;

  const PREVIEW_LEN = 500;

  // DEMO-3-R2.4：构建候选产物元数据（路径+hash，不含完整正文）
  // 完整正文由 extractB4Artifacts 构建并经 CLI 落盘到 b4-artifacts/ 目录。
  // rawCandidateId 规则：raw 自身 = 自身 candidateId；editorial = 其所基于的 raw 候选 ID。
  const rawCandId = rawCandidate?.id ?? "raw-unknown";
  const rawArtifact: B4CandidateArtifactMeta = {
    candidateId: rawCandId,
    candidateKind: "raw",
    rawCandidateId: rawCandId,
    sourcePath: `b4-artifacts/raw-${sanitizeCandidateIdForFilename(rawCandId)}.md`,
    contentHash: computeSha256(rawCandidate?.text ?? evalOutput.text ?? ""),
    textLength: (rawCandidate?.text ?? evalOutput.text ?? "").length,
  };
  const editorialArtifacts: B4CandidateArtifactMeta[] = editorialCandidates.map((c) => ({
    candidateId: c.id,
    candidateKind: "editorial_amplified",
    rawCandidateId: rawCandId,
    sourcePath: `b4-artifacts/editorial-${sanitizeCandidateIdForFilename(c.id)}.md`,
    contentHash: computeSha256(c.text ?? ""),
    textLength: (c.text ?? "").length,
  }));

  return {
    selectedSource: selectedSource === "editorial" ? "editorial" : "raw",
    outcomeType,
    judgeAuditSummary: judgeArbitration?.auditSummary ?? null,
    judgeDegraded:
      judgeArbitration?.rounds?.[0]?.degraded === true ||
      judgeArbitration?.auditSummary?.includes("降级") === true,
    judgeConflicted: judgeArbitration?.conflicted === true,
    judgeAllFailed: !!judgeArbitration?.error,
    hypothesesCount: editorialOpportunity?.hypothesesCount ?? 0,
    editorialCandidateCount: editorialCandidates.length,
    editorialCandidatePreviews: editorialCandidates.map((c) => ({
      id: c.id,
      preview: c.text.slice(0, PREVIEW_LEN),
    })),
    rawCandidatePreview: (rawCandidate?.text ?? evalOutput.text).slice(0, PREVIEW_LEN),
    warnings,
    // DEMO-3-R2.1 新增：各阶段拒绝原因持久化
    factGuardRejectionCount,
    storyPreservationRejectionCount,
    storyPreservationReports: editorialStoryPreservation.map((r) => ({
      candidateId: r.candidateId,
      preserved: r.preserved,
      unverifiable: r.unverifiable,
      rejectionType: r.rejectionType,
      missingEventCount: r.missingEventCount,
      replacedEventCount: r.replacedEventCount,
      orderViolationCount: r.orderViolationCount,
      reason: r.reason,
    })),
    // DEMO-3-R2.4 新增：provenance 元数据
    orchestratorRunId,
    rawArtifact,
    editorialArtifacts,
  };
}

/**
 * DEMO-3-R2.4：从 EvalLayerOutput 提取 B4 完整候选产物（含完整正文）。
 *
 * 与 extractB4Details 的区别：
 * - extractB4Details 只保存路径/hash/元数据到 result.json（不含完整正文）
 * - extractB4Artifacts 保存完整正文到 LayerResult.b4Artifacts，由 CLI 落盘到
 *   b4-artifacts/{kind}-{candidateId}.md 独立文件
 *
 * provenance 守卫通过 result.json 中的路径找到这些文件，读取正文并校验 SHA-256。
 */
function extractB4Artifacts(
  evalOutput: EvalLayerOutput,
  orchestratorRunId: string,
  caseId: string,
  outcomeType: B4OutcomeType,
  b4Details: B4Details,
  runtimeProvenance?: RuntimeProvenance,
): B4Artifacts | undefined {
  const { result } = evalOutput;
  const selectedSource = (result.stageResults?.selectedSource as string | undefined) ?? "raw";
  const selectedCandidateId =
    (result.stageResults?.selectedCandidateId as string | undefined) ?? "";
  const candidates = (result.candidates as Array<{
    id: string;
    kind: string;
    text: string;
  }>) ?? [];
  const editorialCandidates = candidates.filter((c) => c.kind === "editorial_amplified");
  // DEMO-3-R2.4 修复：B4 主 raw 候选识别（与 extractB4Details 同逻辑）。
  // 详见 extractB4Details 中的注释。selectedSource=raw 时用 selectedCandidateId 找实际交付的 raw；
  // 否则优先 agentic_raw（editorial 所基于的 raw），回退第一个非 editorial（B0/B1 无 agentic）。
  const rawCandidate =
    (selectedSource === "raw" && selectedCandidateId
      ? candidates.find((c) => c.id === selectedCandidateId)
      : null) ??
    candidates.find((c) => c.kind === "agentic_raw") ??
    candidates.find((c) => c.kind !== "editorial_amplified");

  const rawCandId = rawCandidate?.id ?? "raw-unknown";
  const rawText = rawCandidate?.text ?? evalOutput.text ?? "";

  const rawCandidateArtifact: B4CandidateArtifact = {
    candidateId: rawCandId,
    candidateKind: "raw",
    rawCandidateId: rawCandId,
    text: rawText,
    contentHash: computeSha256(rawText),
    textLength: rawText.length,
  };

  const editorialCandidateArtifacts: B4CandidateArtifact[] = editorialCandidates.map((c) => ({
    candidateId: c.id,
    candidateKind: "editorial_amplified",
    rawCandidateId: rawCandId,
    text: c.text ?? "",
    contentHash: computeSha256(c.text ?? ""),
    textLength: (c.text ?? "").length,
  }));

  // hypotheses（完整）
  const editorialOpportunity = result.stageResults?.editorialOpportunity as
    | { hypotheses?: unknown[] }
    | null
    | undefined;
  const hypotheses = editorialOpportunity?.hypotheses ?? [];

  // FactGuard 完整结果
  const editorialFactGuard = (result.stageResults?.editorialFactGuard as Array<{
    candidateId: string;
    passed: boolean;
    errors: string[];
  }> | undefined) ?? [];

  // StoryPreservationGate 完整报告
  const editorialStoryPreservation =
    (result.stageResults?.editorialStoryPreservation as unknown[]) ?? [];

  // judge 仲裁结果（完整）
  const judgeArbitration = result.stageResults?.judgeArbitration ?? null;
  const allArbitrationResults =
    (judgeArbitration as { allArbitrations?: unknown[] } | null)?.allArbitrations ?? [];

  // selected candidate（selectedSource/selectedCandidateId 已在上方提取，供 raw 候选查找使用）
  const fallbacked = outcomeType !== "editorial_win";
  const finalSource: "B2" | "B3" = outcomeType === "editorial_win" ? "B3" : "B2";

  return {
    orchestratorRunId,
    caseId,
    layer: "B4",
    generatedAt: new Date().toISOString(),
    rawCandidate: rawCandidateArtifact,
    editorialCandidates: editorialCandidateArtifacts,
    hypotheses,
    editorialFactGuard,
    editorialStoryPreservation,
    judgeArbitration,
    allArbitrationResults,
    selectedCandidateId,
    selectedSource: selectedSource === "editorial" ? "editorial" : "raw",
    finalSource,
    fallbacked,
    outcomeType,
    warnings: b4Details.warnings,
    runtimeProvenance,
  };
}

/**
 * 生成 B4 fallback 的可读原因描述。
 */
function describeB4FallbackReason(outcomeType: B4OutcomeType, warnings: string[]): string {
  const reasonMap: Record<B4OutcomeType, string> = {
    editorial_win: "",
    judge_raw: "B4 judge 正常选 raw（editorial 候选未胜出），B4 文本=raw",
    judge_degraded: "B4 judge 降级（LLM parse 失败或字段缺失），保留 raw",
    judge_conflict: "B4 两轮裁判冲突，保留 raw",
    judge_all_failed: "B4 所有 editorial 候选裁判均异常，保留 raw",
    no_editorial: "B4 无编辑机会（0 hypothesis / Thompson 未准入 / 未生成候选），交付 raw",
    factguard_block: "B4 editorial 候选已生成但全部被 FactGuard 拒绝，回退 raw",
    story_preservation_block: "B4 editorial 候选已通过 FactGuard 但全部被 StoryPreservationGate 拒绝（故事骨架漂移），交付 raw",
    budget_fallback: "B4 模型调用达软上限，跳过 editorial 候选生成，交付 raw",
    orchestrate_failed: "B4 runUnifiedPipeline 失败",
  };
  const base = reasonMap[outcomeType];
  if (warnings.length > 0) {
    return `${base}：${warnings.join("; ")}`;
  }
  return base;
}

/** 从 EvalLayerOutput 构造 LayerResult */
function toLayerResult(
  layer: LayerName,
  evalOutput: EvalLayerOutput,
  prefix: string,
  orchestratorRunId?: string,
  caseId?: string,
  runtimeProvenance?: RuntimeProvenance,
): LayerResult {
  const promptHash = fnv1aHash(`${layer}|${prefix}`);
  const { result } = evalOutput;

  // B2/B3 正常交付 raw（selectedSource="raw"），不标记 fallback。
  // B4 使用 classifyB4Outcome 统一分类（DEMO-3-R1 修复）。
  let fallbackFrom: LayerName | undefined;
  let fallbackReason: string | undefined;
  let b4Details: B4Details | undefined;
  let b4Artifacts: B4Artifacts | undefined;

  if (layer === "B4") {
    const outcomeType = classifyB4Outcome(evalOutput);
    // DEMO-3-R2.4：orchestratorRunId 必须传入（B4 层），用于 provenance 元数据
    if (!orchestratorRunId || !caseId) {
      throw new Error(
        "toLayerResult: B4 层必须传入 orchestratorRunId 和 caseId（R2.4 provenance 守卫要求）",
      );
    }
    b4Details = extractB4Details(evalOutput, outcomeType, orchestratorRunId, caseId);
    b4Artifacts = extractB4Artifacts(evalOutput, orchestratorRunId, caseId, outcomeType, b4Details, runtimeProvenance);
    const warnings = (result.stageResults?.warnings as string[]) ?? [];

    if (outcomeType !== "editorial_win") {
      // 所有非 editorial 胜出的结果都是 fallback（B4 文本 = raw）
      fallbackFrom = "B2";
      if (outcomeType === "orchestrate_failed" && evalOutput.fallbackReason) {
        // orchestrate_failed 时保留原始错误信息（evalOutput.fallbackReason）
        fallbackReason = `B4 runUnifiedPipeline 失败：${evalOutput.fallbackReason}`;
      } else {
        fallbackReason = describeB4FallbackReason(outcomeType, warnings);
      }
    }
  }

  if (!evalOutput.success && !fallbackFrom) {
    fallbackReason = evalOutput.fallbackReason;
  }

  const layerResult: LayerResult = {
    layer,
    text: evalOutput.text,
    model: evalOutput.model,
    route: evalOutput.route,
    durationMs: evalOutput.durationMs,
    success: evalOutput.success,
    fallbackFrom,
    fallbackReason,
    promptHash,
  };
  if (b4Details) {
    layerResult.b4Details = b4Details;
  }
  if (b4Artifacts) {
    layerResult.b4Artifacts = b4Artifacts;
  }
  return layerResult;
}

/** 从 EvalLayerOutput 的 stageResults.modelCalls 提取该层模型调用次数 */
function extractModelCallCount(evalOutput: EvalLayerOutput): number {
  const modelCalls = (evalOutput.result.stageResults?.modelCalls as unknown[]) ?? [];
  return modelCalls.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// 主函数：runGenerationMatrix
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 执行 B0-B4 五层生成矩阵（R1：全部经 runUnifiedPipeline 公开入口进入主链路）。
 *
 * 冻结计划 §8.1 流程：
 * 1. B0 PureModel / B1 CompiledContext：one_shot_raw 后直接交付（无 agentic）
 * 2. B2 AgenticRetrieval：agentic(retrieval=true, verify=false)，交付 agentic_raw
 * 3. B3 VerifiedAgenticRaw：agentic(retrieval=true, verify=true) + FactGuard，交付 verified agentic_raw
 * 4. B4 EditorialSelection：B3 + editorial candidates + pairwise judge + select
 * 5. judgeDecision 从 B4 的 V2Output 提取（winner = B2 if raw 胜出，B3 if editorial 胜出）
 * 6. 最终交付 = B4 层文本（= judgeDecision.winner 对应的文本）
 *
 * 所有层文本永久保留在 result.layers，含失败层。
 */
export async function runGenerationMatrix(
  input: GenerationMatrixInput,
): Promise<GenerationMatrixResult> {
  const totalStart = Date.now();
  const { case: genCase, prefix, modelGenerate, routes, seed } = input;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // DEMO-3-R2.4：已知角色名，传入 StoryPreservationGate 的 knownEntities
  const characterNames = input.characterNames ?? [];
  // DEMO-3-R2.5：运行时代码 provenance 指纹（由 CLI 采集，写入 b4Artifacts.run.json）
  const runtimeProvenance = input.runtimeProvenance;
  // targetWordCount 保留在 input 中供未来扩展（adapter 内构造 intent 时可参考，当前 runner 不直接使用）
  // 测试注入：用 stub runner 隔离 runner 逻辑与 orchestrate 内部行为（项目约定：依赖注入桩）
  const evalRunner: EvalLayerRunner = input.evalLayerRunner ?? runEvalLayer;
  let modelCallCount = 0;

  // DEMO-3-R2.4：为本次 B4 orchestrate() 生成唯一 orchestratorRunId。
  // raw 与 editorial 候选必须共享同一 orchestratorRunId，provenance 守卫据此校验
  // 它们来自同一次 B4 orchestrate() 内部的候选对（而非跨 layer 的独立运行）。
  const orchestratorRunId = generateOrchestratorRunId();

  // ── B0 PureModel：空 intent + 空 context，raw 后直接交付 ──────────────
  const b0Eval = await evalRunner(
    "B0", genCase, prefix, modelGenerate, routes.b0, routes.b4, seed, timeoutMs, characterNames,
  );
  modelCallCount += extractModelCallCount(b0Eval);
  const B0 = toLayerResult("B0", b0Eval, prefix);

  // ── B1 CompiledContext：空 intent + 基础 context，raw 后直接交付 ──────
  const b1Eval = await evalRunner(
    "B1", genCase, prefix, modelGenerate, routes.b1, routes.b4, seed, timeoutMs, characterNames,
  );
  modelCallCount += extractModelCallCount(b1Eval);
  const B1 = toLayerResult("B1", b1Eval, prefix);

  // ── B2 AgenticRetrieval：完整 intent + context + agentic(retrieval, no verify) ─
  const b2Eval = await evalRunner(
    "B2", genCase, prefix, modelGenerate, routes.b2, routes.b4, seed, timeoutMs, characterNames,
  );
  modelCallCount += extractModelCallCount(b2Eval);
  const B2 = toLayerResult("B2", b2Eval, prefix);

  // ── B3 VerifiedAgenticRaw：agentic(retrieval+verify) + FactGuard ──────
  // orchestrate(evalMode=B3) 运行 agentic(retrieval=true, verify=true) + FactGuard，
  // 交付 verified agentic_raw（无 editorial / judge）。
  // FactGuard 阻断时回退 one_shot_raw（fallbackFrom="B2"）。
  const b3Eval = await evalRunner(
    "B3", genCase, prefix, modelGenerate, routes.b3, routes.b4, seed, timeoutMs, characterNames,
  );
  modelCallCount += extractModelCallCount(b3Eval);
  const B3 = toLayerResult("B3", b3Eval, prefix);

  // ── B4 EditorialSelection：B3 + editorial + pairwise judge + select ──
  // orchestrate(evalMode=B4) 以 verified agentic_raw 为 primary raw，
  // 跑完整 editorial + judge + select（FactGuard 启用）。
  // judge 由内部 JudgeArbitrator 完成（arbitratorModelGenerate 用 routes.b4）。
  // DEMO-3-R2.4：传入 orchestratorRunId 和 caseId，使 b4Details/b4Artifacts 含 provenance 元数据。
  // DEMO-3-R2.5：传入 runtimeProvenance（code/build/env 指纹），写入 b4Artifacts.run.json。
  const b4Eval = await evalRunner(
    "B4", genCase, prefix, modelGenerate, routes.b3, routes.b4, seed, timeoutMs, characterNames,
  );
  modelCallCount += extractModelCallCount(b4Eval);
  const B4 = toLayerResult("B4", b4Eval, prefix, orchestratorRunId, genCase.caseId, runtimeProvenance);

  // ── JudgeDecision：从 B4 的 V2Output 结果提取 ───────────────────────
  // DEMO-3-R1 修复：使用 classifyB4Outcome 统一分类，替代旧的
  // "fallbacked = selectedSource=raw && !judgeArbitration" 逻辑。
  // 旧逻辑的 bug：judge 降级时 judgeArbitration 存在（含 rounds[0].degraded=true），
  // 导致降级回退被误判为 fallbacked=false，污染 pure editorial 胜率统计。
  // 新逻辑：fallbacked = (outcomeType !== "editorial_win")，所有非 editorial 胜出都是 fallback。
  const b4OutcomeType = classifyB4Outcome(b4Eval);
  const b4Warnings = (b4Eval.result.stageResults?.warnings as string[]) ?? [];
  const b4JudgeArbitration = b4Eval.result.stageResults?.judgeArbitration as
    | JudgeArbitrationShape
    | null
    | undefined;
  const fallbacked = b4OutcomeType !== "editorial_win";
  const winner: "B2" | "B3" = b4OutcomeType === "editorial_win" ? "B3" : "B2";

  // reason 优先使用 judgeArbitration.auditSummary（保留 judge 的原始决策理由）
  const reason = b4OutcomeType === "orchestrate_failed"
    ? `B4 runUnifiedPipeline 失败，保守回退 B2：${b4Eval.fallbackReason ?? "unknown"}`
    : b4JudgeArbitration?.auditSummary
      ?? describeB4FallbackReason(b4OutcomeType, b4Warnings);

  const judgeDecision: JudgeDecision = {
    winner,
    reason,
    anonymizedMapping: resolveAnonymizedMapping(seed),
    fallbacked,
    outcomeType: b4OutcomeType,
  };

  const finalSource = judgeDecision.winner;
  const finalText = finalSource === "B2" ? B2.text : B3.text;
  // 若 B3 也 fallback 到 raw（无 editorial），finalText 可能等于 B2.text 但更准确取 B3.text

  return {
    caseId: genCase.caseId,
    layers: { B0, B1, B2, B3, B4 },
    judgeDecision,
    finalText,
    finalSource,
    totalDurationMs: Date.now() - totalStart,
    totalModelCalls: modelCallCount,
  };
}
