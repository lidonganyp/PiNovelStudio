/**
 * ProductionIdentityPack — 可部署注入的密封生产身份包
 *
 * 运行时 registry / pointer 仍可 gitignore。clean checkout 通过 pack 恢复：
 *   1. PINOVEL_PRODUCTION_IDENTITY_PACK 或 identityPackPath 给 G6 只读回退
 *   2. evolution:inject-identity 把 pack 物化进 PINOVEL_EVOLUTION_ROOT
 *
 * 本模块不调用模型，不切换文学结论，不修改用户 WIP。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { createEvolutionReleaseRegistry } from "./evolution-release-registry.js";
import { createReleasePointerStore } from "./release-pointer-store.js";
import { createProxyApprovalRegistry } from "./release-proxy-approval-registry.js";
import type { EvolutionReleaseManifest, ReleasePointer } from "./evolution-release-types.js";
import type { ReleaseProxyApprovalArtifact } from "./release-proxy-approval-types.js";

export const PRODUCTION_IDENTITY_PACK_SCHEMA_ID = "pinovel.production-identity-pack" as const;
export const PRODUCTION_IDENTITY_PACK_SCHEMA_VERSION = 1 as const;
export const DEFAULT_PRODUCTION_IDENTITY_PACK_REL = join(
  "config",
  "production-identity",
  "active.pack.json",
);

export interface ProductionIdentityPack {
  schemaId: typeof PRODUCTION_IDENTITY_PACK_SCHEMA_ID;
  schemaVersion: typeof PRODUCTION_IDENTITY_PACK_SCHEMA_VERSION;
  exportedAt: string;
  releaseId: string;
  pointer: ReleasePointer;
  manifest: EvolutionReleaseManifest;
  approvalArtifact: ReleaseProxyApprovalArtifact | null;
  environmentFingerprint: Record<string, unknown> | null;
  packHash: string;
}

export interface ProductionIdentityPackParseResult {
  ok: boolean;
  pack: ProductionIdentityPack | null;
  errors: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalPackPayload(pack: Omit<ProductionIdentityPack, "packHash">): string {
  return JSON.stringify({
    schemaId: pack.schemaId,
    schemaVersion: pack.schemaVersion,
    exportedAt: pack.exportedAt,
    releaseId: pack.releaseId,
    pointer: pack.pointer,
    manifest: pack.manifest,
    approvalArtifact: pack.approvalArtifact,
    environmentFingerprint: pack.environmentFingerprint,
  });
}

export function computeIdentityPackHash(
  pack: Omit<ProductionIdentityPack, "packHash">,
): string {
  return createHash("sha256").update(canonicalPackPayload(pack), "utf-8").digest("hex");
}

export function buildProductionIdentityPack(input: {
  pointer: ReleasePointer;
  manifest: EvolutionReleaseManifest;
  approvalArtifact?: ReleaseProxyApprovalArtifact | null;
  environmentFingerprint?: Record<string, unknown> | null;
  exportedAt?: string;
}): ProductionIdentityPack {
  const draft: Omit<ProductionIdentityPack, "packHash"> = {
    schemaId: PRODUCTION_IDENTITY_PACK_SCHEMA_ID,
    schemaVersion: PRODUCTION_IDENTITY_PACK_SCHEMA_VERSION,
    exportedAt: input.exportedAt ?? new Date().toISOString(),
    releaseId: input.manifest.releaseId,
    pointer: input.pointer,
    manifest: input.manifest,
    approvalArtifact: input.approvalArtifact ?? null,
    environmentFingerprint: input.environmentFingerprint ?? null,
  };
  return {
    ...draft,
    packHash: computeIdentityPackHash(draft),
  };
}

export function parseProductionIdentityPack(raw: unknown): ProductionIdentityPackParseResult {
  if (!isPlainObject(raw)) {
    return { ok: false, pack: null, errors: ["identity pack 必须是对象"] };
  }
  const errors: string[] = [];
  if (raw.schemaId !== PRODUCTION_IDENTITY_PACK_SCHEMA_ID) {
    errors.push(`schemaId 非法：${String(raw.schemaId)}`);
  }
  if (raw.schemaVersion !== PRODUCTION_IDENTITY_PACK_SCHEMA_VERSION) {
    errors.push(`schemaVersion 非法：${String(raw.schemaVersion)}`);
  }
  if (typeof raw.releaseId !== "string" || raw.releaseId.trim().length === 0) {
    errors.push("releaseId 缺失");
  }
  if (!isPlainObject(raw.pointer) || typeof raw.pointer.releaseId !== "string") {
    errors.push("pointer 缺失或非法");
  }
  if (!isPlainObject(raw.manifest) || typeof raw.manifest.releaseId !== "string") {
    errors.push("manifest 缺失或非法");
  }
  if (typeof raw.packHash !== "string" || !/^[0-9a-f]{64}$/.test(raw.packHash)) {
    errors.push("packHash 必须为 64 位 SHA-256 hex");
  }
  if (errors.length > 0) {
    return { ok: false, pack: null, errors };
  }
  const pack = raw as unknown as ProductionIdentityPack;
  if (pack.pointer.releaseId !== pack.releaseId || pack.manifest.releaseId !== pack.releaseId) {
    return {
      ok: false,
      pack: null,
      errors: ["pointer/manifest/releaseId 不一致"],
    };
  }
  const { packHash, ...payload } = pack;
  const recomputed = computeIdentityPackHash(payload);
  if (recomputed !== packHash) {
    return {
      ok: false,
      pack: null,
      errors: [`packHash 不匹配：declared=${packHash} computed=${recomputed}`],
    };
  }
  return { ok: true, pack, errors: [] };
}

export function loadProductionIdentityPackFromFile(packPath: string): ProductionIdentityPackParseResult {
  if (!existsSync(packPath)) {
    return { ok: false, pack: null, errors: [`identity pack 不存在：${packPath}`] };
  }
  try {
    return parseProductionIdentityPack(JSON.parse(readFileSync(packPath, "utf-8")));
  } catch (error) {
    return {
      ok: false,
      pack: null,
      errors: [`identity pack 解析失败：${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

export function resolveProductionIdentityPackPath(
  projectRoot: string,
  explicitPath?: string | null,
): string | null {
  if (explicitPath && explicitPath.trim().length > 0) {
    return explicitPath;
  }
  const env = process.env.PINOVEL_PRODUCTION_IDENTITY_PACK;
  if (env && env.trim().length > 0) {
    return env;
  }
  const defaultPath = join(projectRoot, DEFAULT_PRODUCTION_IDENTITY_PACK_REL);
  return existsSync(defaultPath) ? defaultPath : null;
}

function atomicWrite(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, content, "utf-8");
  renameSync(tmpPath, filePath);
}

export function exportProductionIdentityPack(evolutionRoot: string): ProductionIdentityPack {
  const store = createReleasePointerStore({ configDir: evolutionRoot });
  const pointer = store.readActive("production");
  if (!pointer) {
    throw new Error("export-identity：没有 active production pointer");
  }
  const registry = createEvolutionReleaseRegistry({
    releasesDir: join(evolutionRoot, "releases"),
  });
  const manifest = registry.loadManifest(pointer.releaseId);
  if (!manifest) {
    throw new Error(`export-identity：release ${pointer.releaseId} manifest 不存在`);
  }
  let approvalArtifact: ReleaseProxyApprovalArtifact | null = null;
  if (manifest.approvalRef) {
    approvalArtifact = createProxyApprovalRegistry({
      approvalsDir: join(evolutionRoot, "releases", pointer.releaseId, "approvals"),
    }).loadArtifact(manifest.approvalRef);
  }
  let environmentFingerprint: Record<string, unknown> | null = null;
  const fpPath = join(evolutionRoot, "releases", pointer.releaseId, "environment-fingerprint.json");
  if (existsSync(fpPath)) {
    environmentFingerprint = JSON.parse(readFileSync(fpPath, "utf-8")) as Record<string, unknown>;
  }
  return buildProductionIdentityPack({
    pointer,
    manifest,
    approvalArtifact,
    environmentFingerprint,
  });
}

export function injectProductionIdentityPack(
  evolutionRoot: string,
  pack: ProductionIdentityPack,
): void {
  const parsed = parseProductionIdentityPack(pack);
  if (!parsed.ok || !parsed.pack) {
    throw new Error(`inject-identity：pack 非法：${parsed.errors.join("; ")}`);
  }
  const sealed = parsed.pack;
  mkdirSync(join(evolutionRoot, "releases", sealed.releaseId), { recursive: true });
  const registry = createEvolutionReleaseRegistry({
    releasesDir: join(evolutionRoot, "releases"),
  });
  registry.writeManifest(sealed.manifest);
  if (sealed.approvalArtifact) {
    const approvals = createProxyApprovalRegistry({
      approvalsDir: join(evolutionRoot, "releases", sealed.releaseId, "approvals"),
    });
    const existing = approvals.loadArtifact(sealed.approvalArtifact.approvalId);
    if (!existing) {
      approvals.writeArtifact(sealed.approvalArtifact);
    }
  }
  if (sealed.environmentFingerprint) {
    atomicWrite(
      join(evolutionRoot, "releases", sealed.releaseId, "environment-fingerprint.json"),
      `${JSON.stringify(sealed.environmentFingerprint, null, 2)}\n`,
    );
  }
  atomicWrite(
    join(evolutionRoot, "active-production.json"),
    `${JSON.stringify(sealed.pointer, null, 2)}\n`,
  );
}
