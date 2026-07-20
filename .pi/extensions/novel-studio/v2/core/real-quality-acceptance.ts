/**
 * RealQualityAcceptance - 真实质量验收证据的 fail-closed 校验器。
 *
 * 只验证已落盘证据，不调用模型，不修改路由，不提交章节或长期状态。
 *
 * P1-4 Layer A 升级：`validateRealProvenance` 现在做深度校验，关闭 4 类伪造向量：
 * 1. tracePath 文件不存在（existsSync + readFileSync）
 * 2. tracePath 路径穿越（isPathWithin + realpathSync 防符号链接绕过）
 * 3. trace JSON schema 不完整（schemaVersion/workspaceId/chapterId/events/llmTimings）
 * 4. generator/judge model 与 trace.llmTimings 不一致（双向 includes 匹配）
 *
 * Layer B 缺口（推迟到 REQUIRES_AUTH 切片）：
 * - requestId/responseHash 落盘 + 集合 membership 校验
 * - 原因：LLMTimingEntry 当前不存储这两个字段；需扩展 trace schema + 修改 fallback-manager
 */

import { captureUserRevisionDelta } from "./user-revision-delta.js";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

export const FULL_PREVIEW_STAGES = [
  "raw",
  "fact_guard",
  "editorial_opportunity",
  "editorial_candidate",
  "chinese_calibration",
  "pairwise_judge",
  "selection_policy",
  "span_repair",
  "final_fact_recheck",
] as const;

export type FullPreviewStage = typeof FULL_PREVIEW_STAGES[number];
export type RealAcceptanceSource = "raw" | "candidate";

export interface RealRunProvenance {
  mode: "real" | "stub" | "replay";
  generatorModel: string;
  judgeModel: string;
  generationRequestId: string;
  judgeRequestIds: string[];
  providerResponseHashes: string[];
  tracePath: string;
  fallbackUsed: boolean;
}

export interface AllowedEditRange {
  raw: { start: number; end: number };
  candidate: { start: number; end: number };
}

export interface AnonymousJudgeRound {
  candidateLabel: "A" | "B";
  winner: "A" | "B" | "tie";
  confidence: "clear" | "slight" | "uncertain";
}

export interface AnonymousReverseJudge {
  forward: AnonymousJudgeRound;
  reverse: AnonymousJudgeRound;
}

export interface RealEditorialSample {
  chapterId: string;
  rawText: string;
  candidateText: string;
  allowedEdits: AllowedEditRange[];
  factGuardPassed: boolean;
  storyPreservationPassed: boolean;
  judge: AnonymousReverseJudge;
  finalSelectedSource: RealAcceptanceSource;
  provenance: RealRunProvenance;
}

export interface EndingPressureSample extends RealEditorialSample {
  causalEndPressure: { value: string; sourceRef: string };
  currentHookType: string;
  recentHookTypes: string[];
}

export interface EditorialRealAcceptanceResult {
  accepted: boolean;
  blockers: string[];
  sampleCount: number;
  candidateClearWins: number;
  rawClearWins: number;
  rawRetained: number;
}

export interface CleanBenchmarkRun {
  chapterId: string;
  sceneType: string;
  rawModel: string;
  frontierHash: string;
  chapterIntentHash: string;
  contextBudget: number;
  outputRange: { min: number; max: number };
  fullPipelinePreview: boolean;
  executedStages: FullPreviewStage[];
  stateHashBefore: string;
  stateHashAfter: string;
  anonymousOrder: ["A", "B"] | ["B", "A"];
  fallbackUsed: boolean;
  provenance: RealRunProvenance;
}

export interface CleanModelBenchmarkInput {
  models: string[];
  runs: CleanBenchmarkRun[];
}

export interface CleanModelBenchmarkResult {
  accepted: boolean;
  blockers: string[];
  status: "blocked" | "screening_only" | "temporary_routing_recommendation_eligible";
  chapterCount: number;
  runCount: number;
  sceneTypes: string[];
}

export function verifyLanguageCalibrationReal(
  samples: RealEditorialSample[],
): EditorialRealAcceptanceResult {
  return verifyEditorialSamples(samples, "LANGUAGE-CALIBRATION-REAL-1");
}

export function verifyEndingPressureReal(
  samples: EndingPressureSample[],
): EditorialRealAcceptanceResult {
  const result = verifyEditorialSamples(samples, "ENDING-PRESSURE-REAL-1");
  for (const sample of samples) {
    if (!sample.causalEndPressure?.value.trim() || !sample.causalEndPressure?.sourceRef.trim()) {
      result.blockers.push(`${sample.chapterId}: causalEndPressure 缺少 sourceRef`);
    }
    if (!sample.currentHookType.trim()) {
      result.blockers.push(`${sample.chapterId}: currentHookType 为空`);
    }
    const recentCount = sample.recentHookTypes.filter(
      (hookType) => hookType === sample.currentHookType,
    ).length;
    if (recentCount >= 2) {
      result.blockers.push(`${sample.chapterId}: PatternMemory 检出近期钩子重复`);
    }
    for (const edit of sample.allowedEdits) {
      if (edit.raw.start < Math.floor(sample.rawText.length * 0.5)) {
        result.blockers.push(`${sample.chapterId}: chapter_end_pressure 编辑超出章末区域`);
      }
    }
  }
  result.accepted = result.blockers.length === 0;
  return result;
}

export function verifyCleanModelBenchmark(
  input: CleanModelBenchmarkInput,
): CleanModelBenchmarkResult {
  const blockers: string[] = [];
  const models = Array.from(new Set(input.models));
  if (models.length < 2 || models.length !== input.models.length) {
    blockers.push("benchmark 至少需要两个不重复 raw model");
  }
  const byChapter = new Map<string, CleanBenchmarkRun[]>();
  for (const run of input.runs) {
    const chapterRuns = byChapter.get(run.chapterId) ?? [];
    chapterRuns.push(run);
    byChapter.set(run.chapterId, chapterRuns);
    validateRealProvenance(run.provenance, run.chapterId, blockers);
    if (run.provenance.generatorModel !== run.rawModel) {
      blockers.push(`${run.chapterId}/${run.rawModel}: provenance generatorModel 不匹配`);
    }
    if (run.fallbackUsed || run.provenance.fallbackUsed) {
      blockers.push(`${run.chapterId}/${run.rawModel}: benchmark 禁止 fallback`);
    }
    if (!run.fullPipelinePreview) {
      blockers.push(`${run.chapterId}/${run.rawModel}: 未启用 fullPipelinePreview`);
    }
    if (run.executedStages.join(",") !== FULL_PREVIEW_STAGES.join(",")) {
      blockers.push(`${run.chapterId}/${run.rawModel}: 完整链路 stages 不一致`);
    }
    if (run.stateHashBefore !== run.stateHashAfter) {
      blockers.push(`${run.chapterId}/${run.rawModel}: 只读预览修改了文件或状态 hash`);
    }
    if (run.anonymousOrder.join(",") !== "A,B" && run.anonymousOrder.join(",") !== "B,A") {
      blockers.push(`${run.chapterId}/${run.rawModel}: anonymousOrder 非法`);
    }
  }
  if (byChapter.size < 5) {
    blockers.push(`clean benchmark 至少需要 5 章，实际 ${byChapter.size}`);
  }
  for (const [chapterId, runs] of byChapter) {
    const runModels = new Set(runs.map((run) => run.rawModel));
    if (runs.length !== models.length || models.some((model) => !runModels.has(model))) {
      blockers.push(`${chapterId}: 未覆盖全部 raw models`);
    }
    const baseline = runs[0];
    for (const run of runs.slice(1)) {
      if (run.frontierHash !== baseline.frontierHash) {
        blockers.push(`${chapterId}: frontier hash 不一致`);
      }
      if (run.chapterIntentHash !== baseline.chapterIntentHash) {
        blockers.push(`${chapterId}: ChapterIntent hash 不一致`);
      }
      if (run.contextBudget !== baseline.contextBudget) {
        blockers.push(`${chapterId}: context budget 不一致`);
      }
      if (run.outputRange.min !== baseline.outputRange.min || run.outputRange.max !== baseline.outputRange.max) {
        blockers.push(`${chapterId}: output range 不一致`);
      }
    }
  }
  const orders = new Set(input.runs.map((run) => run.anonymousOrder.join("")));
  if (!orders.has("AB") || !orders.has("BA")) {
    blockers.push("匿名顺序未覆盖 A/B 与 B/A 两种方向");
  }
  const sceneTypes = Array.from(new Set(input.runs.map((run) => run.sceneType))).sort();
  const requiredScenes = ["combat", "emotion", "transition", "reveal", "ensemble"];
  const recommendationEligible =
    byChapter.size >= 10 && requiredScenes.every((sceneType) => sceneTypes.includes(sceneType));
  return {
    accepted: blockers.length === 0,
    blockers,
    status: blockers.length > 0
      ? "blocked"
      : recommendationEligible
        ? "temporary_routing_recommendation_eligible"
        : "screening_only",
    chapterCount: byChapter.size,
    runCount: input.runs.length,
    sceneTypes,
  };
}

function verifyEditorialSamples(
  samples: RealEditorialSample[],
  taskId: string,
): EditorialRealAcceptanceResult {
  const blockers: string[] = [];
  const chapterIds = new Set(samples.map((sample) => sample.chapterId));
  if (samples.length < 5 || chapterIds.size < 5) {
    blockers.push(`${taskId}: 至少需要 5 个不同真实章节`);
  }
  let candidateClearWins = 0;
  let rawClearWins = 0;
  let rawRetained = 0;
  for (const sample of samples) {
    validateRealProvenance(sample.provenance, sample.chapterId, blockers);
    if (!sample.factGuardPassed) blockers.push(`${sample.chapterId}: FactGuard 未通过`);
    if (!sample.storyPreservationPassed) blockers.push(`${sample.chapterId}: StoryPreservation 未通过`);
    if (!editsStayInsideAllowedRanges(sample)) {
      blockers.push(`${sample.chapterId}: 候选存在目标 span 外改文`);
    }
    const judgeOutcome = classifyJudgeOutcome(sample.judge);
    if (judgeOutcome === "candidate") candidateClearWins += 1;
    if (judgeOutcome === "raw") rawClearWins += 1;
    if (sample.finalSelectedSource === "raw") rawRetained += 1;
    const expectedSource = judgeOutcome === "candidate" ? "candidate" : "raw";
    if (sample.finalSelectedSource !== expectedSource) {
      blockers.push(`${sample.chapterId}: judge 不明确或 raw 胜出时必须保留 raw`);
    }
  }
  if (candidateClearWins <= rawClearWins) {
    blockers.push(`${taskId}: 未证明候选相对 raw 的真实净正收益`);
  }
  return {
    accepted: blockers.length === 0,
    blockers,
    sampleCount: samples.length,
    candidateClearWins,
    rawClearWins,
    rawRetained,
  };
}

function validateRealProvenance(
  provenance: RealRunProvenance,
  label: string,
  blockers: string[],
): void {
  // 1. mode 检查（fail-fast 短路：mode 不对时其他深检无意义）
  if (provenance.mode !== "real") {
    blockers.push(`${label}: 缺少真实模型 provenance`);
    return;
  }

  // 2. 基础格式校验（保留原 shallow 检查）
  if (!provenance.generatorModel.trim() || !provenance.judgeModel.trim()) {
    blockers.push(`${label}: generator/judge model 为空`);
  }
  if (!provenance.generationRequestId.trim() || provenance.judgeRequestIds.length < 2) {
    blockers.push(`${label}: 缺少生成或反向 A/B request id`);
  }
  if (
    provenance.providerResponseHashes.length < 3 ||
    provenance.providerResponseHashes.some((hash) => !/^[a-f0-9]{64}$/i.test(hash))
  ) {
    blockers.push(`${label}: provider response hash 证据不足`);
  }
  if (!provenance.tracePath.trim()) {
    blockers.push(`${label}: tracePath 为空`);
    return; // tracePath 为空时无法深检
  }
  if (provenance.fallbackUsed) {
    blockers.push(`${label}: 真实验收运行发生 fallback`);
  }

  // 3. Layer A 深检：tracePath 路径越界检查
  //    baseDir = process.cwd()（运行验收的工作目录）
  //    realpathSync 解析符号链接；失败时 fallback 到相对路径检查（交由 readTraceFile 给出更精确错误）
  if (!isPathWithin(provenance.tracePath, process.cwd())) {
    blockers.push(`${label}: tracePath 路径越界: ${provenance.tracePath}`);
    return;
  }

  // 4. Layer A 深检：trace 文件存在 + 可读 + JSON 可解析
  const traceRead = readTraceFile(provenance.tracePath);
  if (!traceRead.ok) {
    blockers.push(`${label}: tracePath 不存在或无法解析 — ${traceRead.error}`);
    return;
  }

  // 5. Layer A 深检：JSON schema 最小字段集
  const schemaErrors = validateTraceSchema(traceRead.value);
  if (schemaErrors.length > 0) {
    blockers.push(`${label}: trace schema 不完整 — ${schemaErrors.join("; ")}`);
    return;
  }

  // 6. Layer A 深检：generator/judge model 与 trace.llmTimings 一致
  if (!matchesModelInTrace(traceRead.value, provenance.generatorModel)) {
    blockers.push(`${label}: generatorModel '${provenance.generatorModel}' 未在 trace 中找到`);
  }
  if (!matchesModelInTrace(traceRead.value, provenance.judgeModel)) {
    blockers.push(`${label}: judgeModel '${provenance.judgeModel}' 未在 trace 中找到`);
  }
}

/**
 * 检查 targetPath 是否位于 baseDir 内（防路径穿越，含符号链接守护）。
 *
 * 模板参考 replay-provenance-guard.ts:340-350，补上 realpathSync 防符号链接绕过。
 * realpathSync 失败（文件不存在/无权限/符号链接循环）时 fallback 到相对路径检查，
 * 让 readTraceFile 给出更精确的"不存在"错误。
 */
function isPathWithin(targetPath: string, baseDir: string): boolean {
  if (!targetPath || !baseDir) return false;
  const absoluteTarget = isAbsolute(targetPath)
    ? targetPath
    : join(baseDir, targetPath);
  let realTarget: string;
  let realBase: string;
  try {
    realTarget = realpathSync(absoluteTarget);
    realBase = realpathSync(baseDir);
  } catch {
    // realpathSync 失败（文件不存在/无权限）— fallback 到相对路径检查
    const rel = relative(baseDir, absoluteTarget);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  }
  const rel = relative(realBase, realTarget);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * 安全读取 trace 文件：检查存在性 + UTF-8 读取 + JSON 解析。
 *
 * 返回 { ok: true, value } 或 { ok: false, error }。不抛异常。
 */
function readTraceFile(
  tracePath: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (!existsSync(tracePath)) {
    return { ok: false, error: `tracePath 不存在 (not exist): ${tracePath}` };
  }
  let text: string;
  try {
    text = readFileSync(tracePath, "utf-8");
  } catch (err) {
    return { ok: false, error: `读取失败: ${err instanceof Error ? err.message : String(err)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `JSON 解析失败: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { ok: true, value: parsed };
}

/**
 * 校验 trace 文件最小 schema 字段集。
 *
 * 必须满足：
 * - 是对象
 * - schemaVersion === 1
 * - workspaceId/chapterId 是字符串
 * - events 是数组
 * - performanceProfile 是对象且 llmTimings 是数组
 */
function validateTraceSchema(trace: unknown): string[] {
  const errors: string[] = [];
  if (!trace || typeof trace !== "object") {
    errors.push("trace 不是对象");
    return errors;
  }
  const t = trace as Record<string, unknown>;
  if (t.schemaVersion !== 1) errors.push("schemaVersion !== 1");
  if (typeof t.workspaceId !== "string" || !t.workspaceId) {
    errors.push("workspaceId 缺失或非字符串");
  }
  if (typeof t.chapterId !== "string" || !t.chapterId) {
    errors.push("chapterId 缺失或非字符串");
  }
  if (!Array.isArray(t.events)) {
    errors.push("events 不是数组");
  }
  if (!t.performanceProfile || typeof t.performanceProfile !== "object") {
    errors.push("performanceProfile 缺失");
  } else {
    const p = t.performanceProfile as Record<string, unknown>;
    if (!Array.isArray(p.llmTimings)) {
      errors.push("llmTimings 不是数组");
    }
  }
  return errors;
}

/**
 * 校验 declared model 是否出现在 trace 的 llmTimings 中。
 *
 * 匹配规则：双向 includes（大小写不敏感）。例如：
 *   declared="doubao-seed-2.1-pro" 应在 trace.llmTimings 中找到 model="doubao-seed-2.1-pro"
 *   declared="gpt-5.6-sol" 应在 trace.llmTimings 中找到 model="gpt-5.6-sol"
 *
 * 兼容 provider 前缀：declared="doubao-seed-2-1-pro-260628" 与 trace model="doubao-seed-2.1-pro"
 * 通过双向 includes 仍可匹配。
 */
function matchesModelInTrace(trace: unknown, declaredModel: string): boolean {
  if (!trace || typeof trace !== "object") return false;
  const t = trace as Record<string, unknown>;
  const perf = t.performanceProfile;
  if (!perf || typeof perf !== "object") return false;
  const timings = (perf as Record<string, unknown>).llmTimings;
  if (!Array.isArray(timings)) return false;
  const declared = declaredModel.trim().toLowerCase();
  if (!declared) return false;
  return timings.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const model = (entry as Record<string, unknown>).model;
    if (typeof model !== "string") return false;
    const m = model.trim().toLowerCase();
    if (!m) return false;
    return declared.includes(m) || m.includes(declared);
  });
}

function classifyJudgeOutcome(judge: AnonymousReverseJudge): "candidate" | "raw" | "uncertain" {
  const rounds = [judge.forward, judge.reverse];
  if (rounds.some((round) => round.confidence !== "clear" || round.winner === "tie")) {
    return "uncertain";
  }
  const candidateWins = rounds.every((round) => round.winner === round.candidateLabel);
  if (candidateWins) return "candidate";
  const rawWins = rounds.every((round) => round.winner !== round.candidateLabel);
  return rawWins ? "raw" : "uncertain";
}

function editsStayInsideAllowedRanges(sample: RealEditorialSample): boolean {
  if (sample.allowedEdits.length === 0) return false;
  for (const range of sample.allowedEdits) {
    if (!validRange(range.raw, sample.rawText.length) || !validRange(range.candidate, sample.candidateText.length)) {
      return false;
    }
  }
  const delta = captureUserRevisionDelta({
    workspaceId: "acceptance",
    chapterId: sample.chapterId,
    selectedCandidateId: "candidate",
    systemSelectedText: sample.rawText,
    userFinalText: sample.candidateText,
  });
  return delta.modifiedSpans.length > 0 && delta.modifiedSpans.every((span) =>
    sample.allowedEdits.some((range) =>
      containsRange(range.raw, span.before) && containsRange(range.candidate, span.after),
    ),
  );
}

function validRange(range: { start: number; end: number }, length: number): boolean {
  return Number.isInteger(range.start) && Number.isInteger(range.end) &&
    range.start >= 0 && range.end >= range.start && range.end <= length;
}

function containsRange(
  allowed: { start: number; end: number },
  actual: { start: number; end: number },
): boolean {
  return actual.start >= allowed.start && actual.end <= allowed.end;
}

