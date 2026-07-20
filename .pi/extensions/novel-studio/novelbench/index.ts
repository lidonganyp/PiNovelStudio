/**
 * NovelBench 模块 barrel（eval-only）。
 *
 * 由 tsconfig.eval.json 编译到 dist-eval/，不进 dist/。
 * 生产入口（index.ts / novelos/）不 import 本模块。
 *
 * 当前导出：
 * - NB-0：auditCorpora + 文件名/类型/ID 工具
 * - NB-1：splitChaptersStrict + sampleChapters + resolveReferenceBody
 * - NB-1R：calibrateChapterSplitting + aggregateCalibrationStats
 * - NB-2：auditLeakage + ReferenceRegistry + partitionByBook + buildDataset
 * - NB-2R：sanitizeForGenerator + writeGeneratorBundle + readGeneratorBundle + validateGeneratorSchema（生成器进程隔离）
 * - NB-3：analyzeReference + validateSpan/markInvalidSpans + 12 类资产类型
 */

export {
  auditCorpora,
  parseFilename,
  detectGenreFromPath,
  computeBookId,
  computeAuthorId,
  countChapters,
} from "./corpus-auditor.js";
export type { AuditCorporaOptions, ParsedFilename } from "./corpus-auditor.js";

export {
  splitChaptersStrict,
  sampleChapters,
  resolveReferenceBody,
} from "./chapter-splitter.js";

export {
  calibrateChapterSplitting,
  aggregateCalibrationStats,
} from "./chapter-calibrator.js";
export type { CalibrateOptions } from "./chapter-calibrator.js";

export { auditLeakage } from "./leakage-scanner.js";
export type { AuditLeakageOptions } from "./leakage-scanner.js";

export { ReferenceRegistry } from "./reference-registry.js";
export type { ReferenceRecord } from "./reference-registry.js";

export { partitionByBook, findSplit } from "./partition.js";
export type { PartitionRatios, PartitionEntry } from "./partition.js";

export { buildDataset } from "./dataset-builder.js";
export type { BuildDatasetOptions, BuildDatasetResult } from "./dataset-builder.js";

// ─────────────────────────────────────────────────────────────────────────────
// NB-2R：生成器进程隔离（GeneratorCase sanitized bundle + schema 校验）
// ─────────────────────────────────────────────────────────────────────────────

export {
  sanitizeForGenerator,
  writeGeneratorBundle,
  readGeneratorBundle,
  listGeneratorBundles,
} from "./generator-bundle.js";

export {
  validateGeneratorSchema,
  assertNoLeakageFields,
  FORBIDDEN_FIELDS,
} from "./generator-schema-validator.js";

export type {
  BookManifestEntry,
  CorpusAuditStats,
  CorpusAuditResult,
  ChapterSplit,
  VolumeInfo,
  ChapterSplitResult,
  SourceRef,
  LeakageAudit,
  ReferenceLocator,
  DatasetCase,
  DatasetSplit,
  PartitionResult,
  ChapterBoundaryAnnotation,
  ChapterBoundaryErrorCategory,
  BookCalibrationResult,
  CalibrationStats,
  GeneratorCase,
  GeneratorSchemaValidation,
} from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// NB-3：Reference Analyzer（evaluator-only，提取 12 类叙事资产）
// ─────────────────────────────────────────────────────────────────────────────

export { analyzeReference, sha256 } from "./reference-analyzer.js";
export {
  validateSpan,
  markInvalidSpans,
  markInvalidSpan,
  countByStatus,
} from "./span-validator.js";
export type {
  AssetStatus,
  TextSpan,
  SpannedAssetBase,
  ReferenceEvent,
  ReferenceCausalEdge,
  EventGraphAsset,
  CharacterStateDelta,
  CanonStateDelta,
  PromiseMovement,
  InformationRelease,
  CharacterChoice,
  CostConsequence,
  SceneTransition,
  EndingFunction,
  VoiceFingerprintAsset,
  DialogueRole,
  ReferenceAssetProvenance,
  ReferenceAssetConsistency,
  ReferenceAsset,
  LlmAdapter,
  AnalyzeReferenceOptions,
} from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// NB-4：Generation Matrix B0-B4 五层生成矩阵（generator 进程，能力层叠加对比）
// ─────────────────────────────────────────────────────────────────────────────

export { runGenerationMatrix } from "./generation-matrix-runner.js";
export type {
  LayerName,
  LayerResult,
  JudgeDecision,
  GenerationMatrixRoutes,
  GenerationMatrixInput,
  GenerationMatrixResult,
  EvalLayerRunner,
} from "./generation-matrix-runner.js";

// NB-4 eval-pipeline-adapter（主链路 eval layer 入口，B0-B4 共享 orchestrate）
export { runEvalLayer } from "./eval-pipeline-adapter.js";
export type {
  EvalLayerName,
  EvalLayerOutput,
} from "./eval-pipeline-adapter.js";

// DEMO-3-R2.5：运行时代码 provenance 收集器（code/build/env 指纹，可复现验证）
export { collectRuntimeProvenance, verifyRuntimeProvenance } from "./runtime-provenance-collector.js";
export type {
  RuntimeProvenance,
  RuntimeFileHash,
  EnvSwitchState,
  CollectRuntimeProvenanceInput,
} from "./runtime-provenance-collector.js";

// ─────────────────────────────────────────────────────────────────────────────
// NB-5：Reference-aware Judge（匿名 pairwise + 反向复判 + 多数投票，evaluator-only）
// ─────────────────────────────────────────────────────────────────────────────

export { runReferenceAwareJudge, ALL_DIMENSIONS } from "./reference-aware-judge.js";
export type {
  JudgeDimension,
  JudgeTextSpan,
  DimensionScore,
  SingleVerdict,
  PairResult,
  ReferenceAwareJudgeInput,
  ReferenceAwareJudgeResult,
} from "./reference-aware-judge.js";

export {
  CEILING_DIMENSION_IDS,
  CEILING_JUDGE_SCHEMA_VERSION,
  buildCeilingJudgeSchema,
  parseAndValidateCeilingVerdict,
  runCeilingJudgeWithRepair,
} from "../novelos/eval/ceiling-judge-schema.js";
export type {
  CeilingJudgeVerdict,
  CeilingJudgeRunInput,
  CeilingJudgeRunResult,
  CeilingVerdictParseResult,
  CeilingDimensionVerdict,
} from "../novelos/eval/ceiling-judge-schema.js";

export {
  buildReferenceQualityCase,
  validateReferenceQualityCase,
} from "../novelos/eval/ceiling-reference-cases.js";
export type {
  ReferenceQualityCase,
  ReferenceQualityCaseKind,
  ReferenceQualityAnnotation,
} from "../novelos/eval/ceiling-reference-cases.js";

export {
  summarizeAbsoluteQuality,
  aggregateBaselineArm,
  compareBaselineMatrix,
  validateContinuousChapters,
} from "./ceiling-baseline-matrix.js";
export type {
  CeilingExperimentArm,
  AbsoluteQualitySummary,
  BaselineArmSummary,
  BaselineMatrixResult,
  ChapterFrontierObservation,
  ContinuousChapterResult,
} from "./ceiling-baseline-matrix.js";

export { evaluateQualityStrategyAdmission } from "./quality-strategy-admission.js";
export { compareWriterModels } from "./writer-model-comparison.js";
export type {
  ComparedWriterModel,
  CompareWriterModelsInput,
  WriterModelComparisonResult,
  WriterCandidateMetrics,
  WriterPreviewInput,
} from "./writer-model-comparison.js";
export type {
  QualityStrategyStatus,
  QualityStrategyEvidence,
  QualityStrategyDecision,
} from "./quality-strategy-admission.js";
