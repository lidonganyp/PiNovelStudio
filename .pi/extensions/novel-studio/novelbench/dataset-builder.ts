/**
 * NB-2：防泄漏数据集构建器
 *
 * 核心原则（任务要求）：
 * - 严格区分生成输入（generationInput）与隐藏 reference
 * - continuation：只允许目标章之前可知的信息，禁目标章 signal
 * - realization：允许抽象事件合同，禁原句和独特措辞
 * - referenceLocator 不透明（无 sourcePath），generator 无法访问 reference
 * - 所有 case 经 auditLeakage 复核
 *
 * 架构边界：
 * - 本模块 import ReferenceRegistry 但只调 register()/save()，不调 resolve()
 * - referenceLocator 仅 { referenceId, bodyHash }，类型层强制无 sourcePath
 * - 边界测试守护：dist-eval/novelbench/dataset-builder.js 不含 resolve( 调用
 *
 * 本模块为 eval-only，由 tsconfig.eval.json 编译到 dist-eval/，不进 dist/。
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { decodeNovelSourceBuffer } from "../eval/replay-case-extractor.js";
import { resolveReferenceBody } from "./chapter-splitter.js";
import { auditLeakage } from "./leakage-scanner.js";
import { findSplit } from "./partition.js";
import { sanitizeForGenerator, writeGeneratorBundle } from "./generator-bundle.js";
import type { ReferenceRegistry } from "./reference-registry.js";
import type {
  BookManifestEntry,
  ChapterSplit,
  DatasetCase,
  DatasetSplit,
  PartitionResult,
  SourceRef,
} from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// 公开 API
// ─────────────────────────────────────────────────────────────────────────────

export interface BuildDatasetOptions {
  /** 数据集版本（如 "nb2-v1"） */
  datasetVersion: string;
  /** 模式：continuation（禁目标章 signal）或 realization（抽象事件合同） */
  mode: "continuation" | "realization";
  /** 按书分区结果 */
  partition: PartitionResult;
  /** bookId → 该书的章节切分（ChapterSplit[]，来自 NB-1） */
  splits: Map<string, ChapterSplit[]>;
  /** manifest 条目（用于 bookId/authorId/genre/sourcePath） */
  manifest: BookManifestEntry[];
  /** 语料根目录（用于解析 sourcePath 为绝对路径） */
  corpusRoot: string;
  /** generation-input bundle 输出目录（.txt 文件） */
  outputDir: string;
  /** reference 注册表（generator 只调 register） */
  registry: ReferenceRegistry;
  /** 目标章号（默认每书最后一章） */
  targetChapter?: number;
  /**
   * datasets 根目录绝对路径（NB-2R）。
   * 用于 sanitizeForGenerator 计算 generationInputPath 相对路径。
   * 通常等于 outputDir 的父目录（如 data/novelbench/datasets/）。
   */
  datasetsRoot: string;
  /**
   * GeneratorCase JSON bundle 输出目录（NB-2R）。
   * 生成器进程读此目录下的 <caseId>.json，不读 DatasetCase JSONL。
   * 若不提供则不写 generator bundle（仅用于测试/向后兼容）。
   */
  generatorBundleDir?: string;
}

export interface BuildDatasetResult {
  cases: DatasetCase[];
  partitionStats: { train: number; validation: number; test: number };
  leakageFailures: number;
  skipped: string[];
  /** NB-2R：写入的 GeneratorCase bundle 数量 */
  generatorBundlesWritten: number;
}

/**
 * 构建数据集。
 *
 * 对每本 canonical 书的目标章：
 * 1. 确定分区
 * 2. 读 reference body（目标章）
 * 3. 构造 priorChapterRefs + 读 prior 章正文
 * 4. 构造 generationInput（continuation/realization）
 * 5. auditLeakage 复核
 * 6. 写 generation-input bundle
 * 7. 注册 reference（register only）
 * 8. 构造 DatasetCase（referenceLocator 无 sourcePath）
 */
export async function buildDataset(
  options: BuildDatasetOptions,
): Promise<BuildDatasetResult> {
  const {
    datasetVersion,
    mode,
    partition,
    splits,
    manifest,
    corpusRoot,
    outputDir,
    registry,
    datasetsRoot,
    generatorBundleDir,
  } = options;

  const cases: DatasetCase[] = [];
  const partitionStats = { train: 0, validation: 0, test: 0 };
  const skipped: string[] = [];
  let leakageFailures = 0;
  let generatorBundlesWritten = 0;

  // 确保输出目录存在
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  for (const entry of manifest) {
    if (entry.status !== "canonical") continue;

    const bookSplits = splits.get(entry.bookId);
    if (!bookSplits || bookSplits.length < 2) {
      skipped.push(`${entry.bookId}: 无切分或章节数 <2`);
      continue;
    }

    // 确定目标章（默认最后一章）
    const targetSplit = options.targetChapter
      ? bookSplits.find((s) => s.chapterNumber === options.targetChapter)
      : bookSplits[bookSplits.length - 1];

    if (!targetSplit) {
      skipped.push(`${entry.bookId}: 目标章不存在`);
      continue;
    }

    // 前章 = 目标章之前的所有章
    const targetIdx = bookSplits.indexOf(targetSplit);
    const priorSplits = bookSplits.slice(0, targetIdx);

    if (priorSplits.length === 0) {
      skipped.push(`${entry.bookId}: 无前章（目标章为第一章）`);
      continue;
    }

    // 读源文件 → 解码
    const sourceAbsPath = resolve(corpusRoot, entry.sourcePath);
    if (!existsSync(sourceAbsPath)) {
      skipped.push(`${entry.bookId}: 源文件缺失 ${entry.sourcePath}`);
      continue;
    }

    const buffer = readFileSync(sourceAbsPath);
    const decoded = decodeNovelSourceBuffer(new Uint8Array(buffer));
    const fullText = decoded.text;

    // 读 reference body（目标章正文）
    const referenceBody = resolveReferenceBody(fullText, targetSplit);
    if (referenceBody === null) {
      skipped.push(`${entry.bookId}: reference body hash 不匹配`);
      continue;
    }
    const referenceHash = sha256(referenceBody);

    // 读 prior 章正文
    const priorChapterBodies: string[] = [];
    const priorChapterRefs: SourceRef[] = [];
    for (const ps of priorSplits) {
      const body = resolveReferenceBody(fullText, ps);
      if (body === null) {
        skipped.push(`${entry.bookId}: 第 ${ps.chapterNumber} 章 body hash 不匹配`);
        continue;
      }
      priorChapterBodies.push(body);
      priorChapterRefs.push({
        bookId: entry.bookId,
        chapterNumber: ps.chapterNumber,
        sourcePath: entry.sourcePath,
        startOffset: ps.bodyStartOffset,
        endOffset: ps.endOffset,
        bodyHash: ps.bodyHash,
      });
    }

    if (priorChapterBodies.length === 0) {
      skipped.push(`${entry.bookId}: 无可用前章 body`);
      continue;
    }

    // 构造 generationInput
    const generationInput = buildGenerationInput(
      mode,
      entry,
      priorChapterBodies,
      priorSplits,
      targetSplit,
      referenceBody,
    );

    // leakage 审计
    const leakageAudit = auditLeakage(
      generationInput,
      referenceBody,
      priorChapterBodies,
      {
        targetChapterTitle: targetSplit.title,
      },
    );
    if (!leakageAudit.passed) {
      leakageFailures++;
    }

    // 确定分区
    const split = findSplit(partition, entry.bookId);
    if (!split) {
      skipped.push(`${entry.bookId}: 不在分区内`);
      continue;
    }
    partitionStats[split]++;

    // caseId = `${datasetVersion}-${bookId}-ch${targetChapter}`
    const caseId = `${datasetVersion}-${entry.bookId}-ch${targetSplit.chapterNumber}`;

    // 写 generation-input bundle（gitignored，含前章正文派生物）
    const bundlePath = join(outputDir, `${caseId}.txt`);
    writeFileSync(bundlePath, generationInput, "utf-8");
    const generationInputHash = sha256(generationInput);

    // 注册 reference（register only，不调 resolve）
    registry.register({
      referenceId: caseId,
      sourcePath: sourceAbsPath,
      bodyHash: referenceHash,
      startOffset: targetSplit.bodyStartOffset,
      endOffset: targetSplit.endOffset,
      encoding: decoded.encoding,
    });

    // 构造 DatasetCase（referenceLocator 无 sourcePath）
    const datasetCase: DatasetCase = {
      datasetVersion,
      caseId,
      bookId: entry.bookId,
      authorId: entry.authorId,
      genre: entry.genre,
      mode,
      targetChapter: targetSplit.chapterNumber,
      priorChapterRefs,
      generationInputPath: bundlePath,
      generationInputHash,
      referenceLocator: {
        referenceId: caseId,
        bodyHash: referenceHash,
      },
      referenceHash,
      splitConfidence: targetSplit.splitConfidence,
      leakageAudit,
    };
    cases.push(datasetCase);

    // NB-2R：发射 sanitized GeneratorCase bundle（生成器进程读此 JSON，不读 DatasetCase JSONL）
    if (generatorBundleDir) {
      const generatorCase = sanitizeForGenerator(datasetCase, split, datasetsRoot);
      writeGeneratorBundle(generatorCase, generatorBundleDir);
      generatorBundlesWritten++;
    }
  }

  return { cases, partitionStats, leakageFailures, skipped, generatorBundlesWritten };
}

// ─────────────────────────────────────────────────────────────────────────────
// generationInput 构造
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 构造 generationInput。
 *
 * continuation：前 N-1 章正文 + workGoal + 前章状态摘要。禁目标章 signal。
 * realization：前章 input + 目标章抽象事件合同（抽象化，去除原句和独特措辞）。
 */
function buildGenerationInput(
  mode: "continuation" | "realization",
  entry: BookManifestEntry,
  priorChapterBodies: string[],
  priorSplits: ChapterSplit[],
  targetSplit: ChapterSplit,
  referenceBody: string,
): string {
  const workGoal = `【作品目标】${entry.title}（${entry.genre}）：主角在系列推进中面对持续升级的压力与选择，每章推动叙事前进，结尾留下钩子。`;

  const priorContext = priorChapterBodies
    .map((body, i) => {
      const ch = priorSplits[i];
      return `--- 第${ch.chapterNumber}章 ${ch.title} ---\n${body}`;
    })
    .join("\n\n");

  if (mode === "continuation") {
    // continuation：前章正文 + workGoal + 状态摘要。禁目标章 signal。
    return [
      workGoal,
      "",
      "【前文上下文】",
      priorContext,
      "",
      `【任务】请续写第 ${targetSplit.chapterNumber} 章。只使用前文已建立的信息，自然承接前文，推动叙事前进。`,
    ].join("\n");
  }

  // realization：前章 input + 抽象事件合同（从 reference 抽象化，无原句）
  const eventContract = abstractEventContract(referenceBody, targetSplit);
  return [
    workGoal,
    "",
    "【前文上下文】",
    priorContext,
    "",
    `【第 ${targetSplit.chapterNumber} 章 抽象事件合同】`,
    eventContract,
    "",
    "【任务】请基于前文上下文和上述抽象事件合同生成本章。不得复用原作的独特措辞或原句。",
  ].join("\n");
}

/**
 * 从 reference body 抽象出事件合同（去除原句和独特措辞）。
 *
 * 提取：
 * - 事件目标（从正文关键词抽象化）
 * - 人物参与（泛化为主角/配角）
 * - 状态变化（从正文推断方向）
 * - 情绪方向（从正文推断）
 * - 结尾功能（从正文结尾推断）
 *
 * ⚠️ 不引用原文片段，只用模板化描述。
 */
function abstractEventContract(
  referenceBody: string,
  targetSplit: ChapterSplit,
): string {
  const lines: string[] = [];

  // 事件目标：从标题和正文长度推断
  lines.push(`- 事件目标：第 ${targetSplit.chapterNumber} 章应推动主线情节前进，引入新的压力或线索。`);

  // 人物参与：泛化
  const hasDialogue = /[""''「」『』]/.test(referenceBody);
  lines.push(
    `- 人物参与：主角为核心视角${hasDialogue ? "，含对白推进" : "，以行动与观察为主"}。`,
  );

  // 状态变化：从正文长度和结构推断方向
  const bodyLen = referenceBody.length;
  lines.push(
    `- 状态变化：本章正文约 ${bodyLen} 字，应在章节末尾将主角处境推向新的紧张点。`,
  );

  // 情绪方向：从结尾关键词推断
  const endingText = referenceBody.slice(-Math.min(200, bodyLen));
  const tensionWords = ["紧张", "危险", "未知", "悬念", "黑", "声", "门", "异"];
  const hasTension = tensionWords.some((w) => endingText.includes(w));
  lines.push(
    `- 情绪方向：${hasTension ? "从观察转向紧张，章末压力上升" : "从平静转向决断，章末留有余韵"}。`,
  );

  // 结尾功能：泛化
  lines.push(
    `- 结尾功能：本章应以未解的钩子收束，引导读者继续阅读下一章。`,
  );

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// 内部工具
// ─────────────────────────────────────────────────────────────────────────────

function sha256(data: string): string {
  return createHash("sha256").update(data, "utf-8").digest("hex");
}
