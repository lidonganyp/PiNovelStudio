/**
 * 作者章纲契约材料映射与消费判定（EXPERT-HOST-HANDOFF-1 / CRASH-RECOVERY-1）。
 *
 * 覆盖两类必须守住的边界：
 *   1. 章节号编码进 documentType，多章契约不互相覆盖；
 *   2. 只有 provenance = committed 且 hash 与章纲正文逐字节一致时才允许消费，
 *      pending / failed / 缺失 / 篡改一律拒绝。
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CHAPTER_CONTRACT_DOCUMENT_PREFIX,
  CHAPTER_CONTRACT_PROVENANCE_DOCUMENT_PREFIX,
  chapterContractDocumentType,
  chapterContractProvenanceDocumentType,
  deriveKnownContractIds,
  parseChapterContractDocumentType,
  resolveApprovedChapterContract,
} from './chapter-contract-materials';

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

describe('chapter contract document types', () => {
  it('encodes the chapter number so per-chapter contracts do not overwrite each other', () => {
    expect(chapterContractDocumentType(3)).toBe(`${CHAPTER_CONTRACT_DOCUMENT_PREFIX}3`);
    expect(chapterContractProvenanceDocumentType(12)).toBe(
      `${CHAPTER_CONTRACT_PROVENANCE_DOCUMENT_PREFIX}12`,
    );
    expect(chapterContractDocumentType(3)).not.toBe(chapterContractDocumentType(12));
  });

  it('parses chapter numbers back out and rejects unrelated document types', () => {
    expect(parseChapterContractDocumentType('chapter_contract:ch3')).toBe(3);
    expect(parseChapterContractDocumentType('chapter_contract_provenance:ch12')).toBe(12);
    expect(parseChapterContractDocumentType('chapter_contract:ch0')).toBeNull();
    expect(parseChapterContractDocumentType('story_outline')).toBeNull();
    expect(parseChapterContractDocumentType('chapter_contract:chX')).toBeNull();
  });
});

describe('resolveApprovedChapterContract', () => {
  const outline = '# 第 3 章 显式契约\n\n## 章节定位\n\n- **本章功能**：推进\n';
  const hash = sha256(outline);

  function committedProvenance(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      schemaVersion: 'chapter-contract-provenance/1',
      chapterNumber: 3,
      proposalHash: hash,
      commitStatus: 'committed',
      ...overrides,
    });
  }

  it('returns null when the chapter has no authored contract', () => {
    expect(resolveApprovedChapterContract({ chapterNumber: 3, contractContent: undefined })).toBeNull();
    expect(resolveApprovedChapterContract({ chapterNumber: 3, contractContent: '   ' })).toBeNull();
  });

  it('accepts a committed contract whose hash matches byte-for-byte', () => {
    const result = resolveApprovedChapterContract({
      chapterNumber: 3,
      contractContent: outline,
      provenanceContent: committedProvenance(),
    });
    if (!result) throw new Error('expected a consumption verdict');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    // 消费方必须拿到原文（不 trim），否则物化后 hash 会漂移。
    expect(result.outlineMarkdown).toBe(outline);
    expect(result.provenanceJson).toBe(committedProvenance());
  });

  it('rejects a pending provenance (crash between outline write and provenance commit)', () => {
    const result = resolveApprovedChapterContract({
      chapterNumber: 3,
      contractContent: outline,
      provenanceContent: committedProvenance({ commitStatus: 'pending' }),
    });
    if (!result) throw new Error('expected a consumption verdict');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected reject');
    expect(result.reason).toBe('not_committed');
    expect(result.provenanceStatus).toBe('pending');
    expect(result.expectedHash).toBe(hash);
  });

  it('rejects a failed provenance', () => {
    const result = resolveApprovedChapterContract({
      chapterNumber: 3,
      contractContent: outline,
      provenanceContent: committedProvenance({ commitStatus: 'failed' }),
    });
    if (!result) throw new Error('expected a consumption verdict');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected reject');
    expect(result.reason).toBe('not_committed');
  });

  it('rejects when the provenance document is missing or unparseable', () => {
    const missing = resolveApprovedChapterContract({
      chapterNumber: 3,
      contractContent: outline,
      provenanceContent: undefined,
    });
    if (!missing) throw new Error('expected a consumption verdict');
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error('expected reject');
    expect(missing.reason).toBe('missing_provenance');

    const broken = resolveApprovedChapterContract({
      chapterNumber: 3,
      contractContent: outline,
      provenanceContent: '{not json',
    });
    if (!broken) throw new Error('expected a consumption verdict');
    expect(broken.ok).toBe(false);
    if (broken.ok) throw new Error('expected reject');
    expect(broken.reason).toBe('invalid_provenance');
  });

  it('rejects a provenance bound to another chapter', () => {
    const result = resolveApprovedChapterContract({
      chapterNumber: 3,
      contractContent: outline,
      provenanceContent: committedProvenance({ chapterNumber: 4 }),
    });
    if (!result) throw new Error('expected a consumption verdict');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected reject');
    expect(result.reason).toBe('chapter_mismatch');
  });

  it('rejects a contract edited after approval (hash mismatch)', () => {
    const result = resolveApprovedChapterContract({
      chapterNumber: 3,
      contractContent: `${outline}\n（手工追加）`,
      provenanceContent: committedProvenance(),
    });
    if (!result) throw new Error('expected a consumption verdict');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected reject');
    expect(result.reason).toBe('hash_mismatch');
    expect(result.actualHash).not.toBe(hash);
  });
});

describe('deriveKnownContractIds', () => {
  it('collects FACT/OOC/PROMISE ids from author-confirmed materials only', () => {
    const ids = deriveKnownContractIds([
      { documentType: 'worldbuilding', content: 'FACT-01 铜哨来自旧案；PROMISE-01 追查失踪名单' },
      { documentType: 'character_profile', content: 'OOC-02 沈砚不会轻易相信官府' },
    ]);
    expect(ids.knownFactIds).toEqual(['FACT-01', 'OOC-02']);
    expect(ids.knownPromiseIds).toEqual(['PROMISE-01']);
  });

  it('does not let a proposal self-authorize new ids', () => {
    const ids = deriveKnownContractIds([
      { documentType: chapterContractDocumentType(3), content: 'FACT-99 新设定；PROMISE-99 新承诺' },
      { documentType: chapterContractProvenanceDocumentType(3), content: 'FACT-98' },
    ]);
    expect(ids.knownFactIds).toEqual([]);
    expect(ids.knownPromiseIds).toEqual([]);
  });
});
