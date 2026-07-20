/**
 * NovelBench 类型定义（NB-0/1/2 共用）
 *
 * - BookManifestEntry / CorpusAuditStats / CorpusAuditResult：NB-0 语料审计
 * - ChapterSplit / VolumeInfo / ChapterSplitResult：NB-1 章节切分
 * - SourceRef / LeakageAudit / ReferenceLocator / DatasetCase：NB-2 防泄漏数据集
 *
 * 本模块为 eval-only，由 tsconfig.eval.json 编译到 dist-eval/，不进 dist/。
 */

/** 源文件引用（不保存正文，仅路径 + hash + offset） */
export interface SourceRef {
  bookId: string;
  chapterNumber: number;
  sourcePath: string;
  startOffset: number;
  endOffset: number;
  bodyHash: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// NB-0：语料审计
// ─────────────────────────────────────────────────────────────────────────────

/** 书籍 Manifest 条目（不含正文） */
export interface BookManifestEntry {
  bookId: string;
  authorId?: string;
  title: string;
  author?: string;
  genre: string;
  /** 相对于语料根目录的源路径（正斜杠分隔） */
  sourcePath: string;
  /** 原始文件字节 hash */
  fileHash: string;
  /** 解码后正文 hash */
  contentHash: string;
  /** 文件大小（字节） */
  size: number;
  encoding: string;
  encodingScore: number;
  chapterCount: number;
  averageChapterLength?: number;
  status: "canonical" | "duplicate" | "incomplete" | "mojibake" | "polluted";
  /** 若为 duplicate，指向 canonical 的 bookId */
  duplicateOf?: string;
  /** 是否为精校/校对/完本版本 */
  isProofread?: boolean;
  issues: string[];
  auditTimestamp: string;
}

/** 语料审计统计 */
export interface CorpusAuditStats {
  totalFiles: number;
  canonical: number;
  duplicate: number;
  incomplete: number;
  mojibake: number;
  polluted: number;
  byGenre: Record<string, number>;
  encodingDistribution: Record<string, number>;
}

/** 语料审计结果 */
export interface CorpusAuditResult {
  entries: BookManifestEntry[];
  stats: CorpusAuditStats;
}

// ─────────────────────────────────────────────────────────────────────────────
// NB-1：章节切分
// ─────────────────────────────────────────────────────────────────────────────

/** 单章切分结果（不含正文，仅 offset + hash） */
export interface ChapterSplit {
  chapterNumber: number;
  heading: string;
  title: string;
  startOffset: number;
  bodyStartOffset: number;
  endOffset: number;
  bodyHash: string;
  characterCount: number;
  splitConfidence: number;
  issues: string[];
}

/** 卷信息 */
export interface VolumeInfo {
  volumeNumber: string;
  title: string;
  startOffset: number;
  endOffset: number;
}

/** 章节切分严格结果 */
export interface ChapterSplitResult {
  chapters: ChapterSplit[];
  volumes: VolumeInfo[];
  splitConfidence: number;
  rejectionReason?: string;
  issues: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// NB-1R：章节切分校准（真实语料 precision 验证）
// ─────────────────────────────────────────────────────────────────────────────

/** 校准标注的单个章节边界（不含正文，仅 offset + 标签） */
export interface ChapterBoundaryAnnotation {
  bookId: string;
  /** 章节在 splitter 输出中的序号；-1 表示 ground-truth 有但 splitter 缺失（FN） */
  splitterIndex: number;
  /** heading 在全文中的 offset */
  headingOffset: number;
  /** body 起始 offset */
  bodyStartOffset: number;
  /** body 结束 offset */
  bodyEndOffset: number;
  /** heading 文本 */
  heading: string;
  /** 章节编号 */
  chapterNumber: number;
  /** 标注标签 */
  label: "correct" | "false_positive" | "missing";
  /** 错误类别（label !== "correct" 时必填） */
  errorCategory?: ChapterBoundaryErrorCategory;
  /** 审核批次（AI 程序化校准标注） */
  annotator: string;
}

/** 章节边界错误类别 */
export type ChapterBoundaryErrorCategory =
  | "missing_heading" // splitter 漏掉的真实 heading（FN）
  | "spurious_heading" // splitter 误识别的假 heading（FP）
  | "offset_mismatch" // heading 存在但 offset 偏差过大
  | "wrong_chapter_number" // heading 存在但编号不同
  | "duplicate_number" // 编号重复
  | "toc_page" // 目录页
  | "short_chapter" // 异常短章
  | "rejected_no_headings"; // splitter 拒绝

/** 单本书的校准结果 */
export interface BookCalibrationResult {
  bookId: string;
  title: string;
  genre: string;
  /** ground-truth heading 数量（独立扫描器） */
  groundTruthCount: number;
  /** splitter 输出章节数量 */
  splitterCount: number;
  /** true positive：splitter 正确识别的章节数 */
  truePositive: number;
  /** false positive：splitter 误识别的章节数 */
  falsePositive: number;
  /** false negative：splitter 漏掉的真实章节数 */
  falseNegative: number;
  /** precision = TP / (TP + FP)；splitter 被拒绝时为 0 */
  precision: number;
  /** recall = TP / (TP + FN）；splitter 被拒绝时为 0 */
  recall: number;
  /** splitter 置信度 */
  splitConfidence: number;
  /** splitter 拒绝原因 */
  rejectionReason?: string;
  /** 书级判定 */
  verdict: "high_confidence" | "low_confidence" | "rejected";
  /** 章节边界标注（不含正文） */
  annotations: ChapterBoundaryAnnotation[];
  /** splitter 报告的 issues */
  issues: string[];
}

/** 校准统计 */
export interface CalibrationStats {
  totalBooks: number;
  highConfidence: number;
  lowConfidence: number;
  rejected: number;
  totalGroundTruth: number;
  totalSplitter: number;
  totalTP: number;
  totalFP: number;
  totalFN: number;
  overallPrecision: number;
  overallRecall: number;
  errorDistribution: Record<string, number>;
}

// ─────────────────────────────────────────────────────────────────────────────
// NB-2：防泄漏数据集
// ─────────────────────────────────────────────────────────────────────────────

/** 泄漏审计结果 */
export interface LeakageAudit {
  ngramOverlapRate: number;
  phraseLeakCount: number;
  entityLeakCount: number;
  sentenceOverlap: number;
  titleSpoilerLeak: boolean;
  passed: boolean;
  details: string[];
}

/** reference locator（不透明，无 sourcePath，仅 referenceId + bodyHash） */
export interface ReferenceLocator {
  referenceId: string;
  bodyHash: string;
}

/** 数据集样本（按任务 schema） */
export interface DatasetCase {
  datasetVersion: string;
  caseId: string;
  bookId: string;
  authorId?: string;
  genre: string;
  mode: "continuation" | "realization";
  targetChapter: number;
  priorChapterRefs: SourceRef[];
  generationInputPath: string;
  generationInputHash: string;
  referenceLocator: ReferenceLocator;
  referenceHash: string;
  splitConfidence: number;
  leakageAudit: LeakageAudit;
}

/** 数据集分区（train / validation / frozen test） */
export type DatasetSplit = "train" | "validation" | "test";

/** 按书分区结果 */
export interface PartitionResult {
  train: string[];
  validation: string[];
  test: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// NB-2R：生成器进程隔离（GeneratorCase 严格子集，无 sourcePath/offset/reference 路径）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generator-facing case schema（NB-2R 进程隔离）。
 *
 * 生成器进程（NB-4 Generation Matrix）只读 GeneratorCase JSON + generationInput .txt bundle。
 * 严禁含以下字段（reference-locating / body / evaluator-only）：
 * - sourcePath / startOffset / endOffset（reference 定位信息）
 * - referenceBody / body（正文）
 * - referenceAssetPath（evaluator 资产路径）
 * - priorChapterRefs（前章元数据；前章正文已在 generationInput .txt 中，生成器无需元数据）
 * - referenceHash（生成器无需校验 reference，由 evaluator 负责）
 * - leakageAudit（审计结果，由 dataset-builder 负责）
 *
 * 与 DatasetCase 的区别：
 * - 无 priorChapterRefs（前章正文已烘焙进 generationInput .txt）
 * - 无 referenceHash / leakageAudit（evaluator-only）
 * - generationInputPath 为相对路径（相对于 datasets 根），机器无关
 * - 新增 split 字段（生成器按分区选择 case）
 *
 * 边界守护：
 * - generator-bundle.ts 是生成器进程唯一 import 的 novelbench 模块
 * - generator-bundle.ts 不得 import reference-registry / reference-analyzer / dataset-builder / leakage-scanner
 * - generator-schema-validator.ts 在生成器进程启动时校验输入 JSON 无禁止字段
 */
export interface GeneratorCase {
  caseId: string;
  bookId: string;
  authorId?: string;
  genre: string;
  mode: "continuation" | "realization";
  targetChapter: number;
  /** 生成输入 .txt bundle 的相对路径（相对于 datasets 根，正斜杠分隔） */
  generationInputPath: string;
  generationInputHash: string;
  /** 分区（train/validation/test） */
  split: DatasetSplit;
  /** reference locator（不透明，无 sourcePath）— 生成器忽略，evaluator 用于匹配 */
  referenceLocator: ReferenceLocator;
  /** splitter 置信度（生成器可参考，决定是否使用该 case） */
  splitConfidence: number;
}

/** GeneratorCase schema 校验结果 */
export interface GeneratorSchemaValidation {
  valid: boolean;
  errors: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// NB-3：Reference Analyzer（隐藏 reference 叙事资产提取）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 资产提取状态。
 * - extracted：LLM 成功提取且 span 校验通过
 * - unknown：LLM 返回 null / confidence < 阈值 / 字段缺失
 * - conflict：多轮提取结果冲突未解决
 * - invalid_span：span 校验失败（excerpt !== slice(start,end)），保留审计但不参与评价
 */
export type AssetStatus = "extracted" | "unknown" | "conflict" | "invalid_span";

/**
 * reference source span（本地定义，excerpt 必填用于校验）。
 *
 * 与 v2/core/types.ts 的 TextSpan 区别：生产路径 TextSpan.excerpt 可选；
 * NB-3 要求每条资产带 excerpt 以便本地校验 slice 一致性，故 excerpt 必填。
 */
export interface TextSpan {
  start: number;
  end: number;
  excerpt: string;
}

/** 带 span + confidence + status 的资产基类 */
export interface SpannedAssetBase {
  span: TextSpan;
  confidence: number;
  status: AssetStatus;
}

// ── 1. EventGraph ───────────────────────────────────────────────────────────

/** reference 事件（简化自 dag/types.ts EventNode，去除运行时字段） */
export interface ReferenceEvent {
  id: string;
  name: string;
  type: "scene" | "dialogue" | "action" | "revelation" | "transition";
  characters: string[];
  narrativeBeat: string;
  conflictLevel: number;
  emotionalArc: { from: string; to: string };
  hooks: string[];
}

export interface ReferenceCausalEdge {
  from: string;
  to: string;
  type: "temporal" | "causal" | "motivational" | "informational";
}

export interface EventGraphAsset {
  events: Array<ReferenceEvent & SpannedAssetBase>;
  causalEdges: ReferenceCausalEdge[];
}

// ── 2. CharacterStateDelta ──────────────────────────────────────────────────

export interface CharacterStateDelta extends SpannedAssetBase {
  characterId: string;
  field: string;
  before: string | "unknown";
  after: string;
}

// ── 3. CanonStateDelta ──────────────────────────────────────────────────────

export interface CanonStateDelta extends SpannedAssetBase {
  id: string;
  fact: string;
  category: string;
  deltaType: "new" | "updated" | "contradicted";
}

// ── 4. PromiseMovement（advance/payoff）──────────────────────────────────────

export interface PromiseMovement extends SpannedAssetBase {
  promiseId: string;
  description: string;
  movement: "advance" | "payoff" | "new" | "abandoned";
  heat: number;
}

// ── 5. InformationRelease ───────────────────────────────────────────────────

export interface InformationRelease extends SpannedAssetBase {
  id: string;
  what: string;
  toWhom: string;
  releaseType: "reveal" | "hint" | "confirm" | "deny";
}

// ── 6. CharacterChoice ──────────────────────────────────────────────────────

export interface CharacterChoice extends SpannedAssetBase {
  characterId: string;
  choice: string;
  motive: string;
  alternative: string | "unknown";
}

// ── 7. CostConsequence ──────────────────────────────────────────────────────

export interface CostConsequence extends SpannedAssetBase {
  characterId: string;
  cost: string;
  consequence: string;
  isIrreversible: boolean;
}

// ── 8. SceneTransition ──────────────────────────────────────────────────────

export interface SceneTransition extends SpannedAssetBase {
  fromScene: string;
  toScene: string;
  transitionType: "time_jump" | "location_change" | "pov_shift" | "continuous";
}

// ── 9. EndingFunction ───────────────────────────────────────────────────────

export interface EndingFunction extends SpannedAssetBase {
  function: "cliffhanger" | "resolution" | "setup" | "escalation" | "reflection";
  description: string;
}

// ── 10. VoiceFingerprint（简化自 craft/voice-fingerprint.ts VoiceFingerprintV2）──

export interface VoiceFingerprintAsset extends SpannedAssetBase {
  characterId: string;
  characterName: string;
  sentenceLengthAvg: number;
  vocabularyLevel: "colloquial" | "mixed" | "formal";
  infoPattern: "direct" | "hint" | "question";
  signaturePatterns: string[];
}

// ── 11. DialogueRole ────────────────────────────────────────────────────────

export interface DialogueRole extends SpannedAssetBase {
  speakerId: string;
  function: "info_request" | "info_give" | "challenge" | "support" | "deflect" | "reveal";
  subtext: string | "unknown";
}

// ── 12. reference source spans 统一在每个资产条目内的 span 字段 ──────────────

// ── 顶层 ReferenceAsset ─────────────────────────────────────────────────────

export interface ReferenceAssetProvenance {
  model: string;
  route: string;
  rounds: number;
}

export interface ReferenceAssetConsistency {
  rounds: number;
  agreedFields: number;
  conflictedFields: number;
  unknownFields: number;
  invalidSpanFields: number;
}

/**
 * Reference Analyzer 输出：12 类叙事评价资产 + consistency 统计 + provenance。
 *
 * 仅供 evaluator 使用（NB-5 Judge 等）；generator 路径不得访问。
 * 每条资产带 span（reference source span）+ confidence + status。
 * 不含单一总分——质量判断由 NB-5 Judge 在 pairwise 中完成。
 */
export interface ReferenceAsset {
  referenceId: string;
  bodyHash: string;
  analyzedAt: string;
  provenance: ReferenceAssetProvenance;
  consistency: ReferenceAssetConsistency;
  eventGraph: EventGraphAsset;
  characterStateDeltas: CharacterStateDelta[];
  canonStateDeltas: CanonStateDelta[];
  promiseMovements: PromiseMovement[];
  informationReleases: InformationRelease[];
  characterChoices: CharacterChoice[];
  costConsequences: CostConsequence[];
  sceneTransitions: SceneTransition[];
  endingFunction: EndingFunction;
  voiceFingerprints: VoiceFingerprintAsset[];
  dialogueRoles: DialogueRole[];
}

// ── LLM Adapter（用于注入 stub 测试）────────────────────────────────────────

export interface LlmAdapter {
  extractJSON<T>(system: string, user: string): Promise<T>;
}

export interface AnalyzeReferenceOptions {
  referenceId: string;
  referenceBody: string;
  bodyHash: string;
  /** 提取轮数：1=单轮（默认），2=双轮一致性检查 */
  rounds?: 1 | 2;
  /** 模型路由名（默认 "reference_analyzer"） */
  route?: string;
  /** LLM 适配器（注入 stub 用于测试；默认走 createRoutedChatAPI） */
  llmAdapter?: LlmAdapter;
}
