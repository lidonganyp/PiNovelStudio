/**
 * 为 NB-4 dry-run 生成最小 generation-inputs。
 *
 * 从 reference-registry 拿 sourcePath + 目标章 startOffset，
 * 取目标章之前的最后 ~4000 字作为"前文上下文"，构造最小 prefix。
 * 这不是标准 buildGenerationInput（缺 chapter-splitter 的精确前章切分），
 * 但足以验证 NB-4 CLI 端到端可跑通。
 *
 * 用法：node scripts/novelbench/_build-dryrun-inputs.mjs [--limit N]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(__filename, "..", "..", "..");

const casesPath = join(PROJECT_ROOT, "data/novelbench/datasets/continuation-cases.jsonl");
const registryPath = join(PROJECT_ROOT, "data/novelbench/datasets/reference-registry.json");
const inputsDir = join(PROJECT_ROOT, "data/novelbench/datasets/generation-inputs");

const limit = Number.parseInt(process.argv.slice(2).find((_, i, a) => a[i - 1] === "--limit") ?? "3", 10);

// 读 cases
const cases = readFileSync(casesPath, "utf-8").split("\n").filter((l) => l.trim()).map(JSON.parse);
// 读 registry
const regRaw = JSON.parse(readFileSync(registryPath, "utf-8"));
const regRecords = Array.isArray(regRaw) ? regRaw : (regRaw.records || Object.values(regRaw));
const regMap = new Map(regRecords.map((r) => [r.referenceId, r]));

mkdirSync(inputsDir, { recursive: true });

let built = 0;
let failed = 0;
for (const c of cases.slice(0, limit)) {
  const ref = regMap.get(c.referenceLocator?.referenceId);
  if (!ref) { failed++; console.error(`✗ ${c.caseId}: registry 无记录`); continue; }
  if (!existsSync(ref.sourcePath)) { failed++; console.error(`✗ ${c.caseId}: source 不存在 ${ref.sourcePath}`); continue; }

  // 读源文件（尝试 utf-8，失败则跳过）
  let fullText;
  try {
    fullText = readFileSync(ref.sourcePath, "utf-8");
  } catch {
    failed++; console.error(`✗ ${c.caseId}: 读源失败`); continue;
  }

  // 取目标章之前的最后 ~4000 字作为前文
  const priorEnd = ref.startOffset;
  const priorStart = Math.max(0, priorEnd - 4000);
  const priorText = fullText.slice(priorStart, priorEnd);

  // 构造最小 generation input（仿 buildGenerationInput continuation 格式）
  const workGoal = `【作品目标】bookId=${c.bookId}（${c.genre}）：主角在系列推进中面对持续升级的压力与选择，每章推动叙事前进，结尾留下钩子。`;
  const prefix = [
    workGoal,
    "",
    "【前文上下文】",
    `--- 第${c.targetChapter - 1}章（前文摘要） ---`,
    priorText,
    "",
    `【任务】请续写第 ${c.targetChapter} 章。只使用前文已建立的信息，自然承接前文，推动叙事前进。`,
  ].join("\n");

  const outPath = join(inputsDir, `${c.caseId}.txt`);
  writeFileSync(outPath, prefix, "utf-8");
  built++;
  console.log(`✓ ${c.caseId}: ${prefix.length}字 → ${outPath}`);
}

console.log(`\n完成：${built} 生成，${failed} 失败`);
