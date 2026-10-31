/**
 * 作者章纲契约的平台侧材料映射（EXPERT-HOST-HANDOFF-1）
 *
 * 职责：
 * 1. 把「按章节批准」的章纲契约与 provenance 映射成项目文档类型；
 * 2. 从作者已确认的材料（世界观 / 人物卡 / 叙事状态）派生 `knownFactIds` /
 *    `knownPromiseIds`，供 runtime 校验器拒绝编造 FACT/OOC/PROMISE 引用。
 *
 * 安全边界：派生只读已确认材料，绝不读取本次提案文本，也不接受客户端自报 ID，
 * 否则作者（或前端）就能自己给自己授权新事实。
 *
 * 存储约定：`NovelDocument.documentType` 是自由字符串，因此把章节号编码进类型，
 * 避免多章契约互相覆盖：
 *   - chapter_contract:ch12
 *   - chapter_contract_provenance:ch12
 * 生成链路据此按目标章节精确物化，不会把第 3 章的契约套到第 12 章。
 */

import { createHash } from 'node:crypto';

/** 作者批准章纲契约的文档类型前缀。 */
export const CHAPTER_CONTRACT_DOCUMENT_PREFIX = 'chapter_contract:ch';

/** 作者批准章纲 provenance 的文档类型前缀。 */
export const CHAPTER_CONTRACT_PROVENANCE_DOCUMENT_PREFIX = 'chapter_contract_provenance:ch';

/** 生成章纲契约文档类型（如 chapter_contract:ch12）。 */
export function chapterContractDocumentType(chapterNumber: number): string {
  return `${CHAPTER_CONTRACT_DOCUMENT_PREFIX}${chapterNumber}`;
}

/** 生成章纲 provenance 文档类型（如 chapter_contract_provenance:ch12）。 */
export function chapterContractProvenanceDocumentType(chapterNumber: number): string {
  return `${CHAPTER_CONTRACT_PROVENANCE_DOCUMENT_PREFIX}${chapterNumber}`;
}

/** runtime handoff 落盘的 provenance 结构（只取消费方对账所需字段）。 */
export interface ChapterContractProvenanceRecord {
  chapterNumber?: number;
  proposalHash?: string;
  commitStatus?: string;
}

export type ChapterContractRejectReason =
  | 'invalid_provenance'
  | 'missing_provenance'
  | 'not_committed'
  | 'chapter_mismatch'
  | 'hash_mismatch';

/** 作者契约消费判定：通过时返回可逐字节复现 proposalHash 的章纲原文。 */
export type ChapterContractConsumption =
  | {
      ok: true;
      outlineMarkdown: string;
      provenance: ChapterContractProvenanceRecord;
      provenanceJson: string;
    }
  | {
      ok: false;
      reason: ChapterContractRejectReason;
      expectedHash?: string;
      actualHash: string;
      provenanceStatus?: string;
    };

/**
 * 判定生成链路是否可以消费某章的「作者已批准章纲契约」（CRASH-RECOVERY-1）。
 *
 * 返回 `null` 表示本章没有作者契约，调用方按原逻辑自动生成章纲；
 * 返回 `ok:false` 表示存在契约但状态不一致，调用方必须 fail-closed 阻断，
 * 不得消费 pending/failed 提案，也不得静默退回自动生成稿。
 *
 * hash 必须对章纲原文逐字节计算（不 trim）：runtime 的 proposalHash 就是
 * `sha256(outlineMarkdown)`，任何空白规范化都会让合法契约被误判。
 */
export function resolveApprovedChapterContract(input: {
  chapterNumber: number;
  contractContent?: string | null;
  provenanceContent?: string | null;
}): ChapterContractConsumption | null {
  const contract = input.contractContent;
  if (!contract || !contract.trim()) return null;

  const actualHash = createHash('sha256').update(contract, 'utf8').digest('hex');
  const provenanceJson = input.provenanceContent;
  if (!provenanceJson || !provenanceJson.trim()) {
    return { ok: false, reason: 'missing_provenance', actualHash };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(provenanceJson) as unknown;
  } catch {
    return { ok: false, reason: 'invalid_provenance', actualHash };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'invalid_provenance', actualHash };
  }
  const provenance = parsed as ChapterContractProvenanceRecord;
  if (provenance.commitStatus !== 'committed') {
    return {
      ok: false,
      reason: 'not_committed',
      actualHash,
      expectedHash: provenance.proposalHash,
      provenanceStatus: provenance.commitStatus,
    };
  }
  if (provenance.chapterNumber !== input.chapterNumber) {
    return {
      ok: false,
      reason: 'chapter_mismatch',
      actualHash,
      expectedHash: provenance.proposalHash,
      provenanceStatus: provenance.commitStatus,
    };
  }
  if (provenance.proposalHash !== actualHash) {
    return {
      ok: false,
      reason: 'hash_mismatch',
      actualHash,
      expectedHash: provenance.proposalHash,
      provenanceStatus: provenance.commitStatus,
    };
  }
  return { ok: true, outlineMarkdown: contract, provenance, provenanceJson };
}

/**
 * 是否为作者审批链专用的系统文档类型。
 *
 * 通用文档 CRUD 必须拒绝这些类型：它们只能由 `ChapterContractService`
 * 在完成 runtime 审批 + receipt 消费后写入，否则作者可以直接伪造
 * `commitStatus=committed` 绕过审批。按前缀判断，避免 `chapter_contract:chX`
 * 这类畸形类型漏网。
 */
export function isReservedAuthorContractDocumentType(documentType: string): boolean {
  return documentType.startsWith('chapter_contract');
}

/** 从文档类型解析章节号；不是章纲契约类型时返回 null。 */
export function parseChapterContractDocumentType(documentType: string): number | null {
  const match = documentType.match(/^chapter_contract(?:_provenance)?:ch(\d+)$/u);
  if (!match) return null;
  const chapterNumber = Number(match[1]);
  return Number.isInteger(chapterNumber) && chapterNumber > 0 ? chapterNumber : null;
}

export interface KnownContractIds {
  /** canon/人物卡中已登记的 FACT/OOC ID。 */
  knownFactIds: string[];
  /** PromiseLedger 中已确认的 PROMISE ID；新书为空数组。 */
  knownPromiseIds: string[];
}

const FACT_ID_PATTERN = /FACT-\d+/gu;
const OOC_ID_PATTERN = /OOC-\d+/gu;
const PROMISE_ID_PATTERN = /PROMISE-[A-Za-z0-9_-]+/gu;

/**
 * 从已确认材料派生可引用 ID。
 *
 * 只接受作者确认过的项目材料；明确排除章纲契约本体，避免“提案写了 FACT-99，
 * 于是 FACT-99 变为已知”这种自授权。
 */
export function deriveKnownContractIds(
  materials: Array<{ documentType: string; content: string }>,
): KnownContractIds {
  const factIds = new Set<string>();
  const promiseIds = new Set<string>();
  for (const material of materials) {
    if (parseChapterContractDocumentType(material.documentType) !== null) continue;
    const content = material.content ?? '';
    for (const match of content.matchAll(FACT_ID_PATTERN)) factIds.add(match[0]);
    for (const match of content.matchAll(OOC_ID_PATTERN)) factIds.add(match[0]);
    for (const match of content.matchAll(PROMISE_ID_PATTERN)) promiseIds.add(match[0]);
  }
  return {
    knownFactIds: [...factIds].sort(),
    knownPromiseIds: [...promiseIds].sort(),
  };
}
