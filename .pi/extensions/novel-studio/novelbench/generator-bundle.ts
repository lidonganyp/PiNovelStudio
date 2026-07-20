/**
 * NB-2R：生成器进程隔离 bundle（sanitized GeneratorCase 读写）。
 *
 * 核心原则（任务要求）：
 * - Generator process must be isolated from evaluator process
 * - Generator schema must not contain sourcePath, offset, or reference asset paths
 * - Generator process cannot import reference-registry（含 reference 解封方法）
 *
 * 本模块是生成器进程（NB-4 Generation Matrix）唯一 import 的 novelbench 模块。
 * 严禁 import 以下模块（架构边界，由 dependency-boundary + generator-isolation 测试守护）：
 * - reference-registry.js（含 reference 解封逻辑，evaluator-only）
 * - reference-analyzer.js（evaluator-only 资产提取）
 * - dataset-builder.js（含 sourcePath 处理，evaluator-only）
 * - leakage-scanner.js（dataset-builder 内部使用，generator 无需）
 * - chapter-splitter.js（dataset-builder 内部使用，generator 无需）
 *
 * 仅允许 import：
 * - types.js（纯类型，无运行时副作用）
 * - node:fs / node:path（标准库）
 *
 * 本模块为 eval-only，由 tsconfig.eval.json 编译到 dist-eval/，不进 dist/。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type {
  DatasetCase,
  DatasetSplit,
  GeneratorCase,
} from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// 公开 API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 将 evaluator-only DatasetCase 净化为生成器可见的 GeneratorCase。
 *
 * 剥离字段：
 * - priorChapterRefs（含 sourcePath / startOffset / endOffset）
 * - referenceHash（evaluator 校验用）
 * - leakageAudit（dataset-builder 审计结果）
 * - datasetVersion（evaluator 元数据）
 *
 * 转换：
 * - generationInputPath 从绝对路径转为相对路径（相对于 datasetsRoot，正斜杠分隔）
 *
 * @param datasetCase evaluator-only 完整 case
 * @param split 分区（train/validation/test）
 * @param datasetsRoot datasets 根目录绝对路径，用于计算 generationInputPath 相对路径
 * @returns GeneratorCase（无 sourcePath/offset/referenceBody/referenceAssetPath）
 */
export function sanitizeForGenerator(
  datasetCase: DatasetCase,
  split: DatasetSplit,
  datasetsRoot: string,
): GeneratorCase {
  const relativeInputPath = relative(datasetsRoot, datasetCase.generationInputPath)
    .split(sep)
    .join("/");

  return {
    caseId: datasetCase.caseId,
    bookId: datasetCase.bookId,
    authorId: datasetCase.authorId,
    genre: datasetCase.genre,
    mode: datasetCase.mode,
    targetChapter: datasetCase.targetChapter,
    generationInputPath: relativeInputPath,
    generationInputHash: datasetCase.generationInputHash,
    split,
    referenceLocator: datasetCase.referenceLocator,
    splitConfidence: datasetCase.splitConfidence,
  };
}

/**
 * 写 GeneratorCase JSON bundle 到 outputDir/<caseId>.json。
 *
 * @returns 写入的绝对路径
 */
export function writeGeneratorBundle(
  generatorCase: GeneratorCase,
  outputDir: string,
): string {
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }
  const outPath = join(outputDir, `${generatorCase.caseId}.json`);
  writeFileSync(outPath, JSON.stringify(generatorCase, null, 2) + "\n", "utf-8");
  return outPath;
}

/**
 * 读 GeneratorCase JSON bundle。
 *
 * @param bundlePath bundle 绝对路径
 * @returns GeneratorCase
 * @throws 若文件不存在或 JSON 解析失败
 */
export function readGeneratorBundle(bundlePath: string): GeneratorCase {
  if (!existsSync(bundlePath)) {
    throw new Error(`Generator bundle 不存在：${bundlePath}`);
  }
  const content = readFileSync(bundlePath, "utf-8");
  return JSON.parse(content) as GeneratorCase;
}

/**
 * 列出目录下所有 GeneratorCase bundle 路径（按 caseId 排序）。
 */
export function listGeneratorBundles(bundleDir: string): string[] {
  if (!existsSync(bundleDir)) return [];
  return readdirSync(bundleDir)
    .filter((f: string) => f.endsWith(".json"))
    .map((f: string) => join(bundleDir, f))
    .sort();
}
