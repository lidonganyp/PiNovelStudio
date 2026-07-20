/**
 * NovelOS M1 评测 — Blind Test Pack（Task C.2）
 *
 * Go 决策时生成匿名 A/B/C 盲测包，供人工盲测确认文学质量正收益。
 *
 * 设计：
 * - `prepareBlindTestPack(fixture, candidates, outputDir)` 写入：
 *   - A.txt / B.txt / C.txt：三个候选正文（B1/B2/B3，确定性洗牌打乱顺序）
 *   - mapping.csv：`file,source,fixture_id` 映射（盲测后对照真相）
 *   - fixture-id.txt：fixture 元信息
 * - 确定性洗牌：用 sha256(fixture.id) 作为种子，seed % 6 选 6 种排列之一
 * - 保证可复现：同一 fixture 多次调用产出相同 mapping
 *
 * 匿名化避免确认偏误（人工评审不知道 A/B/C 分别对应哪条 baseline）。
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { EvalFixture } from "./eval-types.js";

// ============================================================================
// 类型
// ============================================================================

export type BlindTestMode = "b1" | "b2" | "b3";

export interface BlindTestCandidate {
  mode: BlindTestMode;
  text: string;
}

export interface BlindTestMapping {
  /** 文件名（A.txt / B.txt / C.txt） */
  file: string;
  /** 真实来源 baseline */
  source: BlindTestMode;
}

export interface BlindTestPack {
  /** 盲测包目录 */
  dir: string;
  /** A/B/C → b1/b2/b3 映射（供盲测后对照） */
  mapping: BlindTestMapping[];
}

// ============================================================================
// prepareBlindTestPack
// ============================================================================

/** A/B/C 文件标签 */
const LABELS: Array<"A" | "B" | "C"> = ["A", "B", "C"];

/** 3! = 6 种 b1/b2/b3 排列 */
const PERMUTATIONS: Array<Array<BlindTestMode>> = [
  ["b1", "b2", "b3"],
  ["b1", "b3", "b2"],
  ["b2", "b1", "b3"],
  ["b2", "b3", "b1"],
  ["b3", "b1", "b2"],
  ["b3", "b2", "b1"],
];

/**
 * 生成匿名盲测包。
 *
 * 流程：
 * 1. 用 sha256(fixture.id) 计算确定性种子
 * 2. seed % 6 选择 b1/b2/b3 的排列顺序
 * 3. 按排列顺序写入 A.txt / B.txt / C.txt
 * 4. 写入 mapping.csv（file,source,fixture_id）
 * 5. 写入 fixture-id.txt
 *
 * @param fixture 评测 fixture
 * @param candidates 三条 baseline 的候选正文
 * @param outputDir 盲测包输出目录
 * @returns BlindTestPack（含 mapping 供后续对照）
 */
export function prepareBlindTestPack(
  fixture: EvalFixture,
  candidates: BlindTestCandidate[],
  outputDir: string,
): BlindTestPack {
  mkdirSync(outputDir, { recursive: true });

  // 确定性洗牌：基于 fixture.id 的 hash 决定 A/B/C → b1/b2/b3 的映射
  const seed = createHash("sha256").update(fixture.id, "utf8").digest("hex");
  const seedNum = parseInt(seed.slice(0, 8), 16);
  const order = PERMUTATIONS[seedNum % PERMUTATIONS.length];

  const mapping: BlindTestMapping[] = [];
  for (let i = 0; i < 3; i++) {
    const label = LABELS[i];
    const sourceMode = order[i];
    const candidate = candidates.find((c) => c.mode === sourceMode);
    const text = candidate?.text ?? "";
    writeFileSync(join(outputDir, `${label}.txt`), text, "utf-8");
    mapping.push({ file: `${label}.txt`, source: sourceMode });
  }

  // mapping.csv（人工盲测后对照真相）
  const csvLines = ["file,source,fixture_id"];
  for (const m of mapping) {
    csvLines.push(`${m.file},${m.source},${fixture.id}`);
  }
  writeFileSync(join(outputDir, "mapping.csv"), csvLines.join("\n"), "utf-8");

  // fixture 元信息
  writeFileSync(join(outputDir, "fixture-id.txt"), fixture.id, "utf-8");

  return { dir: outputDir, mapping };
}
