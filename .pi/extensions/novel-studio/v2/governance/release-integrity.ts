/**
 * ReleaseIntegrity — releaseId 占用守护与四方一致性检查
 *
 * capture 不得覆盖已有 release 目录。pre-review / pre-production_like /
 * pre-promote 必须核对 manifest.status、最后一条 state-event、审批
 * payload hash、以及 pointer binding 是否一致。
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { createEvolutionReleaseRegistry } from "./evolution-release-registry.js";
import { createReleasePointerStore } from "./release-pointer-store.js";
import { createProxyApprovalRegistry } from "./release-proxy-approval-registry.js";
import { computeReleasePayloadHash } from "./evolution-release-schema.js";
import { verifyManifestBinding } from "./release-proxy-approval-schema.js";
import type { EvolutionReleaseManifest, ReleaseStatus } from "./evolution-release-types.js";

const APPROVAL_REQUIRED = new Set<ReleaseStatus>([
  "approved_dev",
  "active_dev",
  "candidate_prod",
  "active_prod",
]);

export interface ReleaseOccupancy {
  occupied: boolean;
  existing: string[];
}

export function inspectReleaseOccupancy(releasesDir: string, releaseId: string): ReleaseOccupancy {
  const dir = join(releasesDir, releaseId);
  const existing: string[] = [];
  if (existsSync(join(dir, "manifest.json"))) existing.push("manifest");
  if (existsSync(join(dir, "state-events.jsonl"))) existing.push("state-events");
  const approvalsDir = join(dir, "approvals");
  if (existsSync(approvalsDir)) {
    const entries = readdirSync(approvalsDir).filter((name) => !name.startsWith("."));
    if (entries.length > 0) existing.push("approvals");
  }
  return { occupied: existing.length > 0, existing };
}

export function assertReleaseIdAvailable(releasesDir: string, releaseId: string): void {
  const occupancy = inspectReleaseOccupancy(releasesDir, releaseId);
  if (!occupancy.occupied) return;
  throw new Error(
    `releaseId "${releaseId}" 已被占用（${occupancy.existing.join(", ")}）；` +
      "evolution:capture 禁止覆盖既有 manifest / state-events / approvals，必须使用新的 releaseId",
  );
}

export interface ReleaseIntegrityResult {
  ok: boolean;
  reasons: string[];
  manifest: EvolutionReleaseManifest | null;
}

export function evaluateReleaseIntegrity(input: {
  evolutionRoot: string;
  releaseId: string;
}): ReleaseIntegrityResult {
  const reasons: string[] = [];
  const releasesDir = join(input.evolutionRoot, "releases");
  const registry = createEvolutionReleaseRegistry({ releasesDir });
  let manifest: EvolutionReleaseManifest | null;
  try {
    manifest = registry.loadManifest(input.releaseId);
  } catch (error) {
    return {
      ok: false,
      reasons: [`manifest 无法加载：${error instanceof Error ? error.message : String(error)}`],
      manifest: null,
    };
  }
  if (manifest === null) {
    return { ok: false, reasons: [`release "${input.releaseId}" manifest 不存在`], manifest: null };
  }

  let events;
  try {
    events = registry.loadStateEvents(input.releaseId);
  } catch (error) {
    return {
      ok: false,
      reasons: [`state-events 无法加载：${error instanceof Error ? error.message : String(error)}`],
      manifest,
    };
  }
  if (events.length === 0) {
    if (manifest.status !== "draft") {
      reasons.push(`status=${manifest.status} 但没有 state-events（禁止无事件的非 draft 状态）`);
    }
  } else {
    const last = events[events.length - 1];
    if (last.toStatus !== manifest.status) {
      reasons.push(
        `四方不一致：manifest.status=${manifest.status} 与最后 state-event.toStatus=${last.toStatus}`,
      );
    }
    if (last.releaseId !== manifest.releaseId) {
      reasons.push(`state-event.releaseId=${last.releaseId} 与 manifest.releaseId 不一致`);
    }
  }

  const payloadHash = computeReleasePayloadHash(manifest);
  if (manifest.approvalRef) {
    const approvalsDir = join(releasesDir, manifest.releaseId, "approvals");
    const approvalRegistry = createProxyApprovalRegistry({ approvalsDir });
    const artifact = approvalRegistry.loadArtifact(manifest.approvalRef);
    if (artifact === null) {
      reasons.push(`approvalRef=${manifest.approvalRef} 对应 artifact 不存在`);
    } else {
      if (artifact.approvalId !== manifest.approvalRef) {
        reasons.push("approval artifact.approvalId 与 manifest.approvalRef 不一致");
      }
      if (artifact.releaseId !== manifest.releaseId) {
        reasons.push("approval artifact 不得跨 release 复用");
      }
      const binding = verifyManifestBinding(artifact, payloadHash);
      if (!binding.ok) {
        reasons.push(
          `审批 payload hash 不一致：artifact=${artifact.releaseManifestHash.slice(0, 16)}… ` +
            `manifest=${payloadHash.slice(0, 16)}…`,
        );
      }
      if (APPROVAL_REQUIRED.has(manifest.status)) {
        if (artifact.finalVerdict !== "APPROVE_DEV") {
          reasons.push(`finalVerdict=${artifact.finalVerdict}，审批要求状态必须是 APPROVE_DEV`);
        }
        if (artifact.forwardVerdict !== "APPROVE_DEV" || artifact.reverseVerdict !== "APPROVE_DEV") {
          reasons.push(
            `双向审批必须均为 APPROVE_DEV（forward=${artifact.forwardVerdict}, reverse=${artifact.reverseVerdict}）`,
          );
        }
      }
    }
  } else if (APPROVAL_REQUIRED.has(manifest.status)) {
    reasons.push(`status=${manifest.status} 缺少 approvalRef`);
  }

  const store = createReleasePointerStore({ configDir: input.evolutionRoot });
  const pointer = store.readActive("production");
  if (pointer?.releaseId === manifest.releaseId && manifest.status !== "active_prod") {
    reasons.push(
      `binding 不一致：active_prod pointer 指向 ${manifest.releaseId}，但 status=${manifest.status}`,
    );
  }

  return { ok: reasons.length === 0, reasons, manifest };
}

export function assertReleaseIntegrity(input: {
  evolutionRoot: string;
  releaseId: string;
  stage: string;
}): EvolutionReleaseManifest {
  const result = evaluateReleaseIntegrity(input);
  if (!result.ok || result.manifest === null) {
    throw new Error(
      `${input.stage} 阻断：release "${input.releaseId}" 四方一致性失败：${result.reasons.join("；")}`,
    );
  }
  return result.manifest;
}
