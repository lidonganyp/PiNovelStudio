/**
 * IdentityContractCompiler (CANON-IDENTITY-1)
 *
 * 从角色档案/config 编译唯一实体身份契约，含 name/aliases/role/stableIdentity。
 * 使 raw prompt 与后置 FactGuard 消费同一 contract（id/hash 一致）。
 *
 * 不把人物性格偏好设为 hard fact；只编译结构性身份（name/aliases/role）。
 */

import { createHash } from "crypto";

export interface IdentityEntry {
  characterId: string;
  name: string;
  aliases: string[];
  role: string;
  /** 人类可读的身份描述（如"主角"、"主角的父亲"） */
  stableIdentity: string;
  sourceRefs: string[];
}

export interface IdentityContract {
  schema: "pinovel.identity-contract";
  version: "1.0";
  contractId: string;
  contractHash: string;
  entries: IdentityEntry[];
}

/** 输入格式：config.json characters 或 CharacterStateFact 映射 */
export interface IdentityInput {
  name: string;
  role?: string;
  aliases?: string[];
  characterId?: string;
}

/** 从 role + aliases 派生人类可读身份描述 */
function deriveStableIdentity(name: string, role: string | undefined, aliases: string[]): string {
  if (!role) return name;

  // 检查 aliases 中的关系词
  const aliasStr = aliases.join("/");
  if (role === "family") {
    if (/父亲|爸/.test(aliasStr)) return `${name}是主角的父亲`;
    if (/母亲|妈/.test(aliasStr)) return `${name}是主角的母亲`;
    if (/哥|兄/.test(aliasStr)) return `${name}是主角的兄长`;
    if (/姐/.test(aliasStr)) return `${name}是主角的姐姐`;
    if (/弟/.test(aliasStr)) return `${name}是主角的弟弟`;
    return `${name}是主角的家人`;
  }
  if (role === "protagonist") return `${name}是主角`;
  if (role === "love-interest") return `${name}是恋慕对象/重要他人`;
  if (role === "mentor") return `${name}是导师/前辈`;
  if (role === "antagonist-ally") return `${name}是敌方盟友`;
  if (role === "supporting") return `${name}是配角`;
  if (role === "deceased") return `${name}是已故角色`;
  if (role === "companion") return `${name}是同伴`;
  if (role === "monster") return `${name}是敌对生物/怪物`;
  return `${name}（${role}）`;
}

/**
 * 从角色列表编译身份契约。
 * 纯本地编译，不调用 LLM，不读写文件。
 */
export function compileIdentityContract(characters: IdentityInput[]): IdentityContract {
  const entries: IdentityEntry[] = characters.map((c) => {
    const name = c.name;
    const role = c.role ?? "unknown";
    const aliases = c.aliases ?? [];
    const characterId = c.characterId ?? name;
    return {
      characterId,
      name,
      aliases: [...aliases],
      role,
      stableIdentity: deriveStableIdentity(name, role, aliases),
      sourceRefs: ["config.json"],
    };
  });

  // 计算 hash
  const hashInput = entries
    .map((e) => `${e.characterId}|${e.name}|${e.role}|${e.aliases.join(",")}`)
    .join(";");
  const contractHash = createHash("sha256").update(hashInput).digest("hex").slice(0, 16);
  const contractId = `identity-${contractHash}`;

  return {
    schema: "pinovel.identity-contract",
    version: "1.0",
    contractId,
    contractHash,
    entries,
  };
}

/**
 * 从 IdentityContract 收集所有已知名称（name + aliases）。
 * 用于 FactGuard 的 entity_checker，防止别名被误报为实体幻觉。
 */
export function collectAllKnownNames(contract: IdentityContract | null | undefined): string[] {
  if (!contract) return [];
  return contract.entries.flatMap((e) => [e.name, ...e.aliases]);
}
