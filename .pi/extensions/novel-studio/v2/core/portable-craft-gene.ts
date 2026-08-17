/**
 * PORTABLE-CRAFT-GENE-1: compile bounded, abstract craft guidance for raw generation.
 * Evaluator provenance and source excerpts are deliberately outside this runtime shape.
 */

import { sealCapabilityPackage } from "../governance/capability-package-registry.js";
import type { CapabilityPackageManifest, CapabilityPayloadRecord } from "./capability-package-contracts.js";

export interface PortableCraftGene {
  geneId: string;
  generationGuidance: string;
  requiredMoves: string[];
  avoidPatterns: string[];
}

export interface PortableCraftGeneValidation {
  valid: boolean;
  errors: string[];
}

export interface CompiledPortableCraftGenes {
  promptBlock: string;
  geneIds: string[];
}

const MAX_GENES = 6;
const MAX_GUIDANCE_LENGTH = 240;
const MAX_LIST_ITEMS = 5;
const MAX_LIST_ITEM_LENGTH = 80;
const REFERENCE_BEARING_PATTERN = /神秘复苏|杨间|鬼眼|鬼域|人皮纸|敲门鬼|模仿.{0,8}原句|复刻.{0,8}原文/u;

export function validatePortableCraftGenes(
  genes: readonly PortableCraftGene[],
): PortableCraftGeneValidation {
  const errors: string[] = [];
  if (!Array.isArray(genes)) return { valid: false, errors: ["craft_genes_not_array"] };
  if (genes.length > MAX_GENES) errors.push("craft_genes_exceed_limit");

  const ids = new Set<string>();
  for (const [index, gene] of genes.entries()) {
    if (!gene || typeof gene !== "object") {
      errors.push(`craft_gene_${index}_not_object`);
      continue;
    }
    if (!isBoundedText(gene.geneId, 64) || !/^[a-z0-9][a-z0-9_-]*$/u.test(gene.geneId)) {
      errors.push(`craft_gene_${index}_invalid_id`);
    } else if (ids.has(gene.geneId)) {
      errors.push(`craft_gene_duplicate:${gene.geneId}`);
    } else {
      ids.add(gene.geneId);
    }
    if (!isBoundedText(gene.generationGuidance, MAX_GUIDANCE_LENGTH)) {
      errors.push(`craft_gene_${index}_invalid_guidance`);
    } else if (REFERENCE_BEARING_PATTERN.test(gene.generationGuidance)) {
      errors.push(`craft_gene_${index}_reference_bearing_guidance`);
    }
    validateList(gene.requiredMoves, index, "required_moves", errors);
    validateList(gene.avoidPatterns, index, "avoid_patterns", errors);
    for (const item of [...(gene.requiredMoves ?? []), ...(gene.avoidPatterns ?? [])]) {
      if (REFERENCE_BEARING_PATTERN.test(item)) {
        errors.push(`craft_gene_${index}_reference_bearing_list_item`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

export function compilePortableCraftGenes(
  genes: readonly PortableCraftGene[],
): CompiledPortableCraftGenes {
  if (genes.length === 0) return { promptBlock: "", geneIds: [] };
  const validation = validatePortableCraftGenes(genes);
  if (!validation.valid) {
    throw new Error(`invalid_portable_craft_genes:${validation.errors.join(";")}`);
  }

  const entries = genes.map((gene) => [
    `叙事工艺：${gene.generationGuidance}`,
    `应体现：${gene.requiredMoves.join("；")}`,
    `避免：${gene.avoidPatterns.join("；")}`,
  ].join("\n"));
  return {
    promptBlock: [
      "【可迁移叙事工艺：只执行抽象写作决策，不模仿任何作品、角色、设定、剧情或原句】",
      ...entries,
    ].join("\n"),
    geneIds: genes.map((gene) => gene.geneId),
  };
}

function validateList(
  value: unknown,
  index: number,
  field: string,
  errors: string[],
): void {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_LIST_ITEMS) {
    errors.push(`craft_gene_${index}_invalid_${field}`);
    return;
  }
  if (value.some((item) => !isBoundedText(item, MAX_LIST_ITEM_LENGTH))) {
    errors.push(`craft_gene_${index}_invalid_${field}_item`);
  }
}

function isBoundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

/** Read-only one-shot adapter. Genes stay candidate_only / excluded_from_raw. */
export function adaptCraftGeneToPackage(
  gene: PortableCraftGene,
): { manifest: CapabilityPackageManifest; payload: CapabilityPayloadRecord } {
  return sealCapabilityPackage({
    schemaVersion: "capability-package-v1",
    packageId: `craft_gene.${gene.geneId}`,
    version: "1.0.0",
    slot: `craft_gene.${gene.geneId}`,
    kind: "craft_gene",
    purpose: gene.generationGuidance.slice(0, 240),
    applicableWhen: [],
    excludedWhen: [],
    requiredInputs: [],
    outputArtifacts: [{ kind: "candidate_guidance", schemaId: "craft-gene-guidance-v1" }],
    payloadRef: {
      mediaType: "application/json",
      payloadHash: "",
      sourceRef: `craft-gene:${gene.geneId}`,
    },
    targetStages: ["style_optimization"],
    allowedTools: [],
    stopConditions: [{ kind: "max_output_artifacts", value: 1 }],
    budgetPolicy: {
      maxCalls: 0,
      maxInputTokens: 400,
      maxOutputTokens: 0,
      maxLatencyMs: 0,
      maxCost: 0,
    },
    authority: "methodology",
    enforcement: "candidate_only",
    dependencies: [],
    conflicts: [],
    modelCapabilityRequirements: [],
    provenance: [{ sourceId: gene.geneId, sourceType: "portable_craft_gene" }],
    evalManifestId: `craft-gene:${gene.geneId}`,
    admissionEvidence: [{
      evalManifestId: `craft-gene:${gene.geneId}`,
      sampleSize: 0,
      validatedWinRate: null,
      reason: "adapter_only_not_auto_admitted",
    }],
    status: "eval",
    criticality: "optional",
  }, {
    generationGuidance: gene.generationGuidance,
    requiredMoves: gene.requiredMoves,
    avoidPatterns: gene.avoidPatterns,
  });
}
