/**
 * OntologyContractCompiler (WORLD-ONTOLOGY-1)
 *
 * 对命名境界序列等封闭世界本体建立可追溯 contract。
 * 防止模型创造冲突同义体系或无事件跨级。
 *
 * 只覆盖明确列举的 closed-world terms，不硬化开放设定。
 */

import { createHash } from "crypto";

export interface OntologyEntry {
  category: string;
  terms: string[];
  sourceRefs: string[];
}

export interface OntologyContract {
  schema: "pinovel.ontology-contract";
  version: "1.0";
  contractId: string;
  contractHash: string;
  available: boolean;
  emptyReason?: string;
  entries: OntologyEntry[];
}

/**
 * 从 config worldKeyTerms.levels 编译封闭世界本体契约。
 *
 * 输入格式：["炼体（锻骨/淬腑/易筋/洗髓/金身/法相/归一）", ...]
 * 解析：category = "炼体"，terms = ["锻骨", "淬腑", ...]
 *
 * 纯本地编译，不调用 LLM，不读写文件。
 */
export function compileOntologyContract(levels: string[]): OntologyContract {
  const entries: OntologyEntry[] = [];

  for (const levelStr of levels) {
    // 解析格式：category（term1/term2/.../termN）
    const match = levelStr.match(/^(.+?)[（(](.+)[)）]$/);
    if (!match) continue;
    const category = match[1].trim();
    const terms = match[2].split("/").map((t) => t.trim()).filter(Boolean);
    if (category && terms.length > 0) {
      entries.push({ category, terms, sourceRefs: ["config.json:worldKeyTerms.levels"] });
    }
  }

  const hashInput = entries
    .map((e) => `${e.category}|${e.terms.join(",")}`)
    .join(";");
  const contractHash = createHash("sha256").update(hashInput).digest("hex").slice(0, 16);
  const contractId = `ontology-${contractHash}`;

  return {
    schema: "pinovel.ontology-contract",
    version: "1.0",
    contractId,
    contractHash,
    available: entries.length > 0,
    ...(entries.length === 0
      ? { emptyReason: "未提供或不可解析的 closed-world levels；本体门禁保持 unavailable" }
      : {}),
    entries,
  };
}

/**
 * 收集所有已注册的 closed-world 术语（去重）。
 */
export function collectAllRegisteredTerms(contract: OntologyContract | null | undefined): Set<string> {
  if (!contract) return new Set();
  return new Set(contract.entries.flatMap((e) => e.terms));
}
