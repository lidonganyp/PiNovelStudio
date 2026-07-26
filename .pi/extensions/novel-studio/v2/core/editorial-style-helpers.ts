/**
 * Editorial Style & Constitution Helpers（拆分自 editorial-candidate-generator.ts）
 *
 * 纯函数：作者风格指纹解析 + 作品宪法块构造。
 * 拆分目的：满足 simplicity-gate 800 行限制；这些函数无 `this` 依赖，可独立测试。
 */

import type {
  CompiledContext,
  ConstitutionSnapshot,
  StyleReference,
} from "./types.js";

// ============================================================================
// 常量
// ============================================================================

const MAX_STYLE_GUIDANCE_ITEMS = 8;
const MAX_STYLE_GUIDANCE_CHARS = 900;

// ============================================================================
// 作者风格指纹解析
// ============================================================================

export function parseStylePayload(reference: StyleReference): Record<string, unknown> | null {
  try {
    const value = JSON.parse(reference.content) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Extract only curated qualitative guidance from an author fingerprint.
 * Observed ratios and paragraph percentiles remain diagnostic evidence and
 * are deliberately excluded from the model prompt.
 */
export function buildAuthorStyleReferenceBlock(
  context: CompiledContext,
  relevantCharacters: string[],
): string | null {
  const generalGuidance: string[] = [];
  const characterGuidance: string[] = [];

  for (const reference of context.styleReferences.filter((entry) => entry.kind === "fingerprint")) {
    const payload = parseStylePayload(reference);
    if (!payload) continue;

    const usagePolicy = payload.usagePolicy;
    if (
      !usagePolicy
      || typeof usagePolicy !== "object"
      || Array.isArray(usagePolicy)
      || !["span_evidence_only", "full_chapter_required"].includes(
        String((usagePolicy as Record<string, unknown>).editorialCandidate ?? ""),
      )
    ) {
      continue;
    }

    generalGuidance.push(...stringList(payload.editorialGuidance).map((item) => `- [通用] ${item}`));

    const voices = payload.characterVoiceGuidance;
    if (voices && typeof voices === "object" && !Array.isArray(voices)) {
      const voiceMap = voices as Record<string, unknown>;
      for (const character of relevantCharacters) {
        characterGuidance.push(...stringList(voiceMap[character]).map((item) => `- [${character}] ${item}`));
      }
    }
  }

  const selectedCharacterGuidance = characterGuidance.slice(0, 2);
  const guidance = [
    ...generalGuidance.slice(0, MAX_STYLE_GUIDANCE_ITEMS - selectedCharacterGuidance.length),
    ...selectedCharacterGuidance,
  ];
  const selected: string[] = [];
  let usedChars = 0;
  for (const item of guidance) {
    if (selected.length >= MAX_STYLE_GUIDANCE_ITEMS) break;
    if (usedChars + item.length > MAX_STYLE_GUIDANCE_CHARS) break;
    selected.push(item);
    usedChars += item.length;
  }
  if (selected.length === 0) return null;

  return [
    "【作者风格参考（只用于当前证据 span）】",
    "以下是作者稳定偏好的定性参考，不是句段配额；只在不损伤原意与事实时用于本次局部校准。",
    ...selected,
  ].join("\n");
}

// ============================================================================
// 作品宪法块构造
// ============================================================================

export function getEditorialConstitutionConsumedFields(
  constitution: ConstitutionSnapshot | null
): string[] {
  if (!constitution) return [];
  const fields: string[] = [];
  if (constitution.workIdentity?.trim()) fields.push("constitution.workIdentity");
  if (constitution.protagonistCoreConflict?.trim()) fields.push("constitution.protagonistCoreConflict");
  if (constitution.readerPromise?.length > 0) fields.push("constitution.readerPromise");
  if (constitution.forbiddenDrift?.length > 0) fields.push("constitution.forbiddenDrift");
  return fields;
}

export function buildEditorialConstitutionBlock(constitution: ConstitutionSnapshot | null): string | null {
  if (!constitution) return null;
  const lines: string[] = ["【作品宪法（编辑必须对齐）】"];
  if (constitution.workIdentity?.trim()) lines.push(`作品身份：${constitution.workIdentity}`);
  if (constitution.protagonistCoreConflict?.trim()) {
    lines.push(`主角核心冲突：${constitution.protagonistCoreConflict}`);
  }
  if (constitution.readerPromise?.length > 0) {
    lines.push(`读者承诺：${constitution.readerPromise.slice(0, 3).join("；")}`);
  }
  if (constitution.forbiddenDrift?.length > 0) {
    lines.push(`禁止漂移：${constitution.forbiddenDrift.slice(0, 5).join("；")}`);
  }
  return lines.length > 1 ? lines.join("\n") : null;
}
