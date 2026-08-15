/**
 * CONTEXT-PACKAGE — 分槽上下文包（PROMPT-INJECTION-TRUST-ARCHITECTURE-1 Phase 1）
 *
 * 指令与资料在数据结构上分离：
 * - authority 槽位不得写入 reference/draft
 * - 每个槽位保留 sourceRefs、contentHash、消费目的
 * - 编译时校验缺槽位/错槽位/hash 不匹配
 */

import { createHash } from "node:crypto";
import type { ConstraintPriority } from "../context-safety.js";
import {
  SLOT_DEFAULTS,
  canFormHardConstraint,
  isExpired,
  slotAllowsHardConstraint,
  type Authority,
  type ContentSlot,
  type EvidenceRef,
  type ExpiryPolicy,
  type TrustClass,
  type TrustMetadata,
} from "./trust-types.js";

export const CONTEXT_PACKAGE_SCHEMA = "pinovel.context-package" as const;
export const CONTEXT_PACKAGE_VERSION = "1.0" as const;

/** 所有必需槽位（完整性校验） */
export const REQUIRED_SLOTS: readonly ContentSlot[] = [
  "SYSTEM_AUTHORITY",
  "AUTHOR_CONTRACT",
  "IMMUTABLE_FACTS",
  "COMMITTED_STATE",
  "REFERENCE_MATERIAL",
  "DIAGNOSTIC_EVIDENCE",
  "UNTRUSTED_DRAFT",
  "USER_FEEDBACK",
] as const;

export interface ContextSlotItem {
  id: string;
  content: string;
  contentHash: string;
  trustClass: TrustClass;
  authority: Authority;
  sourceRefs: EvidenceRef[];
  expiry: ExpiryPolicy;
  canPromote: boolean;
  /** 消费目的说明 */
  purpose: string;
  priority?: ConstraintPriority;
  kind?: string;
}

export interface ContextSlotBucket {
  slot: ContentSlot;
  items: ContextSlotItem[];
  /** 槽位级 hash（items 规范序列化） */
  slotHash: string;
}

export interface ContextPackage {
  schema: typeof CONTEXT_PACKAGE_SCHEMA;
  version: typeof CONTEXT_PACKAGE_VERSION;
  packageId: string;
  contextHash: string;
  slots: Record<ContentSlot, ContextSlotBucket>;
  createdAt: string;
}

export type ContextPackageBlockReason =
  | "slot_integrity_failure"
  | "authority_slot_pollution"
  | "hash_mismatch"
  | "expired_hard_constraint"
  | "missing_required_slot"
  | "trust_downgrade_required";

export interface ContextPackageValidationResult {
  ok: boolean;
  blockReason?: ContextPackageBlockReason;
  errors: string[];
  package: ContextPackage;
}

export interface BuildContextSlotItemInput {
  id: string;
  content: string;
  slot: ContentSlot;
  sourceRefs?: EvidenceRef[];
  trustClass?: TrustClass;
  authority?: Authority;
  expiry?: ExpiryPolicy;
  canPromote?: boolean;
  purpose?: string;
  priority?: ConstraintPriority;
  kind?: string;
}

function hashContent(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const obj = v as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(obj).sort()) {
        sorted[key] = obj[key];
      }
      return sorted;
    }
    return v;
  });
}

/** 构造单个槽位条目；强制槽位默认信任，拒绝 authority 槽位被 reference 污染 */
export function buildContextSlotItem(
  input: BuildContextSlotItemInput,
): { ok: true; item: ContextSlotItem } | { ok: false; error: string } {
  const content = (input.content ?? "").trim();
  if (!content) {
    return { ok: false, error: `槽位条目 ${input.id} 内容为空` };
  }

  const defaults = SLOT_DEFAULTS[input.slot];
  const trustClass = input.trustClass ?? defaults.trustClass;
  const authority = input.authority ?? defaults.authority;

  // 硬约束只能进入 authority 槽位
  if (canFormHardConstraint(trustClass) && !slotAllowsHardConstraint(input.slot)) {
    return {
      ok: false,
      error: `硬约束 trustClass=${trustClass} 不能写入槽位 ${input.slot}`,
    };
  }

  // reference/untrusted 不能写入 authority 槽位
  if (
    slotAllowsHardConstraint(input.slot) &&
    (trustClass === "retrieved_reference" ||
      trustClass === "model_or_user_untrusted")
  ) {
    return {
      ok: false,
      error: `不可信内容 trustClass=${trustClass} 不能写入权威槽位 ${input.slot}`,
    };
  }

  // authority 与 trustClass 一致性
  if (
    authority === "hard_constraint" &&
    !canFormHardConstraint(trustClass)
  ) {
    return {
      ok: false,
      error: `authority=hard_constraint 与 trustClass=${trustClass} 不一致`,
    };
  }

  const contentHash = hashContent(content);
  return {
    ok: true,
    item: {
      id: input.id,
      content,
      contentHash,
      trustClass,
      authority,
      sourceRefs: input.sourceRefs ? [...input.sourceRefs] : [],
      expiry: input.expiry ?? { kind: "never" },
      canPromote: input.canPromote ?? false,
      purpose: input.purpose ?? defaults.authority,
      priority: input.priority,
      kind: input.kind,
    },
  };
}

function emptyBucket(slot: ContentSlot): ContextSlotBucket {
  return {
    slot,
    items: [],
    slotHash: hashContent(`${slot}:empty`),
  };
}

function bucketHash(slot: ContentSlot, items: ContextSlotItem[]): string {
  return hashContent(
    stableStringify({
      slot,
      items: items.map((item) => ({
        id: item.id,
        contentHash: item.contentHash,
        trustClass: item.trustClass,
        authority: item.authority,
      })),
    }),
  );
}

/**
 * 从分槽条目构建 ContextPackage。
 * 缺槽位会以空桶补齐；污染/不一致在 validate 阶段阻断。
 */
export function buildContextPackage(input: {
  items: Array<BuildContextSlotItemInput>;
  createdAt?: string;
}): ContextPackageValidationResult {
  const errors: string[] = [];
  const buckets: Record<ContentSlot, ContextSlotBucket> = {
    SYSTEM_AUTHORITY: emptyBucket("SYSTEM_AUTHORITY"),
    AUTHOR_CONTRACT: emptyBucket("AUTHOR_CONTRACT"),
    IMMUTABLE_FACTS: emptyBucket("IMMUTABLE_FACTS"),
    COMMITTED_STATE: emptyBucket("COMMITTED_STATE"),
    REFERENCE_MATERIAL: emptyBucket("REFERENCE_MATERIAL"),
    DIAGNOSTIC_EVIDENCE: emptyBucket("DIAGNOSTIC_EVIDENCE"),
    UNTRUSTED_DRAFT: emptyBucket("UNTRUSTED_DRAFT"),
    USER_FEEDBACK: emptyBucket("USER_FEEDBACK"),
  };

  for (const raw of input.items) {
    const built = buildContextSlotItem(raw);
    if (!built.ok) {
      errors.push(built.error);
      continue;
    }
    const bucket = buckets[raw.slot];
    bucket.items = [...bucket.items, built.item];
  }

  for (const slot of REQUIRED_SLOTS) {
    const bucket = buckets[slot];
    bucket.slotHash = bucketHash(slot, bucket.items);
  }

  const contextHash = hashContent(
    stableStringify(
      REQUIRED_SLOTS.map((slot) => ({
        slot,
        slotHash: buckets[slot].slotHash,
      })),
    ),
  );

  const pkg: ContextPackage = {
    schema: CONTEXT_PACKAGE_SCHEMA,
    version: CONTEXT_PACKAGE_VERSION,
    packageId: `ctxpkg:${contextHash.slice(0, 16)}`,
    contextHash,
    slots: buckets,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };

  return validateContextPackage(pkg, { priorErrors: errors });
}

/**
 * 槽位完整性与信任校验。
 * 缺槽位、错槽位、hash 不匹配、过期硬约束均结构化阻断。
 */
export function validateContextPackage(
  pkg: ContextPackage,
  options?: {
    priorErrors?: string[];
    now?: Date;
    revision?: string;
    artifactHash?: string;
  },
): ContextPackageValidationResult {
  const errors = [...(options?.priorErrors ?? [])];
  const now = options?.now ?? new Date();

  if (pkg.schema !== CONTEXT_PACKAGE_SCHEMA) {
    errors.push(`schema 不匹配：${pkg.schema}`);
  }
  if (pkg.version !== CONTEXT_PACKAGE_VERSION) {
    errors.push(`version 不匹配：${pkg.version}`);
  }

  for (const slot of REQUIRED_SLOTS) {
    const bucket = pkg.slots[slot];
    if (!bucket) {
      errors.push(`缺少必需槽位：${slot}`);
      continue;
    }
    if (bucket.slot !== slot) {
      errors.push(`槽位标记错误：expected=${slot} actual=${bucket.slot}`);
    }
    const expectedSlotHash = bucketHash(slot, bucket.items);
    if (bucket.slotHash !== expectedSlotHash) {
      errors.push(`槽位 hash 不匹配：${slot}`);
    }
    for (const item of bucket.items) {
      const recomputed = hashContent(item.content);
      if (item.contentHash !== recomputed) {
        errors.push(`条目 contentHash 不匹配：${item.id}`);
      }
      if (
        slotAllowsHardConstraint(slot) &&
        (item.trustClass === "retrieved_reference" ||
          item.trustClass === "model_or_user_untrusted")
      ) {
        errors.push(
          `权威槽位污染：${slot} 含 trustClass=${item.trustClass} 条目 ${item.id}`,
        );
      }
      if (
        item.authority === "hard_constraint" &&
        isExpired(item.expiry, now, {
          revision: options?.revision,
          artifactHash: options?.artifactHash,
        })
      ) {
        errors.push(`硬约束已过期：${item.id}`);
      }
    }
  }

  const expectedContextHash = hashContent(
    stableStringify(
      REQUIRED_SLOTS.map((slot) => ({
        slot,
        slotHash: pkg.slots[slot]?.slotHash,
      })),
    ),
  );
  if (pkg.contextHash !== expectedContextHash) {
    errors.push("contextHash 不匹配");
  }

  if (errors.length === 0) {
    return { ok: true, errors: [], package: pkg };
  }

  let blockReason: ContextPackageBlockReason = "slot_integrity_failure";
  if (errors.some((e) => e.includes("权威槽位污染"))) {
    blockReason = "authority_slot_pollution";
  } else if (errors.some((e) => e.includes("hash 不匹配") || e.includes("contentHash"))) {
    blockReason = "hash_mismatch";
  } else if (errors.some((e) => e.includes("过期"))) {
    blockReason = "expired_hard_constraint";
  } else if (errors.some((e) => e.includes("缺少必需槽位"))) {
    blockReason = "missing_required_slot";
  }

  return { ok: false, blockReason, errors, package: pkg };
}

/**
 * 将 reference 材料统一降级为无指令权元数据。
 * 历史正文含“忽略系统规则”时仍保持 retrieved_reference。
 */
export function asReferenceMaterial(input: {
  id: string;
  content: string;
  sourceRefs?: EvidenceRef[];
  purpose?: string;
}): BuildContextSlotItemInput {
  return {
    id: input.id,
    content: input.content,
    slot: "REFERENCE_MATERIAL",
    trustClass: "retrieved_reference",
    authority: "reference_only",
    canPromote: false,
    sourceRefs: input.sourceRefs,
    purpose: input.purpose ?? "reference_only_no_instruction_authority",
    expiry: { kind: "never" },
  };
}

/** 将模型草稿放入 UNTRUSTED_DRAFT 槽 */
export function asUntrustedDraft(input: {
  id: string;
  content: string;
  sourceRefs?: EvidenceRef[];
}): BuildContextSlotItemInput {
  return {
    id: input.id,
    content: input.content,
    slot: "UNTRUSTED_DRAFT",
    trustClass: "model_or_user_untrusted",
    authority: "no_authority",
    canPromote: false,
    sourceRefs: input.sourceRefs,
    purpose: "untrusted_candidate_draft",
    expiry: { kind: "never" },
  };
}

/** 从 ConstraintManifest 风格条目提取 TrustMetadata */
export function toTrustMetadata(item: ContextSlotItem, slot: ContentSlot): TrustMetadata {
  return {
    trustClass: item.trustClass,
    authority: item.authority,
    slot,
    sourceRefs: [...item.sourceRefs],
    expiry: item.expiry,
    canPromote: item.canPromote,
    contentHash: item.contentHash,
  };
}

/**
 * 检查检索/历史文本是否试图注入指令。
 * 仅作诊断标记，不改变 trustClass（信任层由槽位决定，不由文本内容决定）。
 */
export function detectInjectionPhrases(text: string): string[] {
  const hits: string[] = [];
  const patterns: Array<{ re: RegExp; label: string }> = [
    { re: /忽略\s*(所有|之前|以上|系统)?\s*规则/, label: "ignore_rules_zh" },
    {
      re: /ignore\s*(all\s*)?(previous|prior|system)?\s*(rules|instructions)/i,
      label: "ignore_rules_en",
    },
    { re: /系统必须/, label: "system_must_zh" },
    { re: /用户已批准|user\s+has\s+approved/i, label: "claimed_user_approval" },
    { re: /你现在是|you\s+are\s+now/i, label: "role_override" },
  ];
  for (const { re, label } of patterns) {
    if (re.test(text)) hits.push(label);
  }
  return hits;
}
