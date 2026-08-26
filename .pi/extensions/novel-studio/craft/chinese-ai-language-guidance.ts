/**
 * 中文网文 AI 腔研究库的运行时软提示编译器。
 *
 * 研究库用于提示模型和记录 provenance，不是禁词表，也不替代
 * ChineseNarrativeNaturalnessScanner 的正文 span 诊断。
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DATASET_FILE = join("data", "runtime", "chinese-webnovel-ai-language-patterns.json");
const MAX_RECORDS = 10;
const MAX_BLOCK_CHARS = 2600;

interface ResearchPattern {
  id: string;
  label: string;
  severity: "A" | "B" | "C" | string;
  forms?: string[];
  naturalAlternatives?: string[];
  runtimeRecommendation?: string;
}

interface ResearchDataset {
  datasetId?: string;
  patterns?: ResearchPattern[];
}

export interface ChineseAiLanguageGuidance {
  block: string;
  source: "runtime_dataset" | "built_in_fallback";
  datasetId: string;
  recordCount: number;
  recordIds: string[];
  blockHash: string;
}

const FALLBACK_PATTERNS: ResearchPattern[] = [
  {
    id: "CNW-AI-004",
    label: "抽象对比套式",
    severity: "A",
    forms: ["不是 X，而是 Y"],
    naturalAlternatives: ["改写为可观察行为或具体事实差异"],
  },
  {
    id: "CNW-AI-016",
    label: "伪精确状态变化",
    severity: "A",
    forms: ["慢了半拍", "短了半寸", "少了两分", "凝实了一分"],
    naturalAlternatives: ["写停顿、距离、动作后果；明确计量系统除外"],
  },
  {
    id: "CNW-AI-031",
    label: "抽象状态封闭比喻",
    severity: "B",
    forms: ["眉宇间沉得像压着一层铅块"],
    naturalAlternatives: ["落到眉眼、语气、手部动作和可见反应"],
  },
  {
    id: "CNW-AI-057",
    label: "成对评价封口",
    severity: "B",
    forms: ["平静而顺利", "看起来重得多"],
    naturalAlternatives: ["补出过程、阻力、代价或实际结果"],
  },
  {
    id: "CNW-AI-059",
    label: "叠量词动态模板",
    severity: "B",
    forms: ["一串串急促的气泡"],
    naturalAlternatives: ["交代来源、方向和变化过程"],
  },
  {
    id: "CNW-AI-060",
    label: "生理事实加异常结论",
    severity: "B",
    forms: ["心跳沉稳得近乎诡异"],
    naturalAlternatives: ["写呼吸节拍、身体动作或旁观者反应"],
  },
];

const cache = new Map<string, ChineseAiLanguageGuidance>();

function readDataset(projectRoot: string): { dataset: ResearchDataset; source: ChineseAiLanguageGuidance["source"] } {
  const path = join(projectRoot, DATASET_FILE);
  if (!existsSync(path)) {
    return { dataset: { datasetId: "builtin-chinese-webnovel-ai-patterns", patterns: FALLBACK_PATTERNS }, source: "built_in_fallback" };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as ResearchDataset;
    if (!Array.isArray(parsed.patterns) || parsed.patterns.length === 0) {
      return { dataset: { datasetId: "builtin-chinese-webnovel-ai-patterns", patterns: FALLBACK_PATTERNS }, source: "built_in_fallback" };
    }
    return { dataset: parsed, source: "runtime_dataset" };
  } catch {
    return { dataset: { datasetId: "builtin-chinese-webnovel-ai-patterns", patterns: FALLBACK_PATTERNS }, source: "built_in_fallback" };
  }
}

function selectPatterns(patterns: ResearchPattern[]): ResearchPattern[] {
  const runtimePatterns = patterns.filter((pattern) =>
    pattern.runtimeRecommendation === "span_diagnostic"
    || pattern.runtimeRecommendation === "density_diagnostic"
    || pattern.id >= "CNW-AI-057",
  );
  const candidates = runtimePatterns.length > 0 ? runtimePatterns : patterns;
  const compoundPatterns = candidates.filter((pattern) => {
    const number = Number(pattern.id.match(/(\d+)$/)?.[1] ?? 0);
    return number >= 57;
  });
  const ranked = [...compoundPatterns, ...candidates.filter((pattern) => !compoundPatterns.includes(pattern))]
    .filter((pattern) => pattern.severity === "A" || pattern.severity === "B")
    .sort((left, right) => {
      const leftCompound = compoundPatterns.includes(left) ? 0 : 1;
      const rightCompound = compoundPatterns.includes(right) ? 0 : 1;
      return leftCompound - rightCompound
        || left.severity.localeCompare(right.severity)
        || left.id.localeCompare(right.id);
    });
  return ranked.slice(0, MAX_RECORDS);
}

function renderPattern(pattern: ResearchPattern): string {
  const forms = (pattern.forms ?? []).slice(0, 3).join("、");
  const alternative = pattern.naturalAlternatives?.[0] ?? "优先落到具体动作、来源、阻力或后果";
  return `- ${pattern.label}：${forms || "结构共现"}；${alternative}。`;
}

export function buildChineseAiLanguageGuidance(projectRoot: string): ChineseAiLanguageGuidance {
  const cacheKey = projectRoot.trim();
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const { dataset, source } = readDataset(cacheKey);
  const selected = selectPatterns(dataset.patterns ?? FALLBACK_PATTERNS);
  const lines = selected.map(renderPattern);
  const block = [
    "【中文网文自然表达软提示】",
    "以下仅用于减少模型默认套话，不是禁词表或硬门禁；角色口吻、类型修辞、明确计量和作者有意比喻优先。",
    "优先让读者看到人物动作、感官来源、方向、阻力、选择和后果；不要用抽象程度结论替代过程证据。",
    ...lines,
  ].join("\n").slice(0, MAX_BLOCK_CHARS);
  const result: ChineseAiLanguageGuidance = {
    block,
    source,
    datasetId: dataset.datasetId ?? "chinese-webnovel-ai-patterns",
    recordCount: Array.isArray(dataset.patterns) ? dataset.patterns.length : FALLBACK_PATTERNS.length,
    recordIds: selected.map((pattern) => pattern.id),
    blockHash: createHash("sha256").update(block, "utf-8").digest("hex"),
  };
  cache.set(cacheKey, result);
  return result;
}
