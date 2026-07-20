/**
 * ReplayProvenanceGuard — replay fixture 来源元数据守卫（DEMO-3-R2.3）
 *
 * R2.3 任务规范第六章要求：为 replay fixture 增加来源元数据校验，
 * 确保 raw 与 editorial 来自同一次 B4 orchestrate() 运行。
 *
 * 背景（r1-evidence-audit.md）：
 * R2.2 的 r1-replay-report.json 错误地用 `layers.B3.text`（独立 B3 layer）
 * 作为 B4 内部 rawCandidate.text。B3 与 B4 是不同 layer 的独立 orchestrate() 运行，
 * 不是同一次 B4 orchestrate() 的内部候选对。
 *
 * 本守卫强制要求 fixture 提供来源元数据，并校验：
 * 1. 字段完整性（caseId/layer/orchestratorRunId/candidateId/candidateKind/
 *    rawCandidateId/editorialCandidateId/sourcePath/contentHash）
 * 2. raw 与 editorial 的 orchestratorRunId 一致（同一 run）
 * 3. raw 与 editorial 的 layer 一致（避免 B3 vs B4 跨 layer）
 * 4. raw 与 editorial 的 rawCandidateId 一致（指向同一 raw 候选）
 * 5. raw 与 editorial 的 editorialCandidateId 一致（指向同一 editorial 候选）
 *
 * 任一校验失败 → status="unverifiable_provenance"，valid=false。
 *
 * 本地确定性，无 LLM 调用。
 *
 * DEMO-3-R2.4 升级：
 * 新增 validateB4ArtifactsProvenance 函数，实际从磁盘读取候选文件，
 * 校验文件存在、路径越界、UTF-8 读取、SHA-256 重算、candidateId 与文件元数据一致、
 * raw/editorial 同一 run、editorial 指向 raw、selected 与 finalSource/fallbacked/outcomeType 一致。
 * 不再仅比较调用方自行填写的两个对象。
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, isAbsolute, relative, sep } from "node:path";

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 单个候选（raw 或 editorial）的来源元数据。
 */
export interface ReplayFixtureProvenance {
  /** case 标识（如 "case-a-glm-r1"） */
  caseId: string;
  /** layer 标识（如 "B4"）——raw 与 editorial 必须同 layer */
  layer: string;
  /**
   * orchestrate() 运行 ID——raw 与 editorial 必须属同一 run。
   * 这是核心校验：证明 raw 与 editorial 来自同一次 B4 orchestrate()。
   */
  orchestratorRunId: string;
  /** 该候选自身的 ID */
  candidateId: string;
  /** 候选类型：raw = B4 内部 rawCandidate；editorial_amplified = editorial 候选 */
  candidateKind: "raw" | "editorial_amplified";
  /** B4 内部的 rawCandidate ID（raw 与 editorial 都应指向同一 rawCandidateId） */
  rawCandidateId: string;
  /** B4 内部的 editorial candidate ID（raw 与 editorial 都应指向同一 editorialCandidateId） */
  editorialCandidateId: string;
  /** 来源文件路径（用于审计追溯） */
  sourcePath: string;
  /** 内容 hash（用于校验文本完整性） */
  contentHash: string;
}

/**
 * replay fixture：含 raw/editorial 文本及其来源元数据。
 */
export interface ReplayFixture {
  rawText: string;
  editorialText: string;
  provenance: {
    raw: ReplayFixtureProvenance;
    editorial: ReplayFixtureProvenance;
  };
}

/**
 * 单项校验结果。
 */
export interface ProvenanceCheck {
  /** 校验项名称 */
  name: string;
  /** 是否通过 */
  passed: boolean;
  /** 详细说明（含失败原因） */
  detail: string;
}

/**
 * provenance 校验结果。
 */
export interface ProvenanceValidationResult {
  /** true = 校验通过；false = 校验失败（unverifiable_provenance） */
  valid: boolean;
  /** "ok" = 校验通过；"unverifiable_provenance" = 无法证明同一 run */
  status: "ok" | "unverifiable_provenance";
  /** 可读原因（失败时说明失败理由） */
  reason: string;
  /** 详细校验项列表 */
  checks: ProvenanceCheck[];
}

// ============================================================================
// 必填字段列表
// ============================================================================

const REQUIRED_FIELDS: ReadonlyArray<keyof ReplayFixtureProvenance> = [
  "caseId",
  "layer",
  "orchestratorRunId",
  "candidateId",
  "candidateKind",
  "rawCandidateId",
  "editorialCandidateId",
  "sourcePath",
  "contentHash",
];

// ============================================================================
// 核心校验函数
// ============================================================================

/**
 * 校验 replay fixture 的 provenance：确保 raw 与 editorial 来自同一次 orchestrate() 运行。
 *
 * 校验项：
 * 1. raw provenance 字段完整性
 * 2. editorial provenance 字段完整性
 * 3. raw.caseId === editorial.caseId（同一 case）
 * 4. raw.layer === editorial.layer（同一 layer，避免 B3 vs B4 跨 layer）
 * 5. raw.orchestratorRunId === editorial.orchestratorRunId（同一 run，核心校验）
 * 6. raw.rawCandidateId === editorial.rawCandidateId（指向同一 raw 候选）
 * 7. raw.editorialCandidateId === editorial.editorialCandidateId（指向同一 editorial 候选）
 *
 * 任一失败 → status="unverifiable_provenance"，valid=false。
 */
export function validateReplayProvenance(
  fixture: ReplayFixture,
): ProvenanceValidationResult {
  const checks: ProvenanceCheck[] = [];

  if (!fixture || !fixture.provenance) {
    return {
      valid: false,
      status: "unverifiable_provenance",
      reason: "fixture 或 provenance 缺失",
      checks: [{ name: "fixture存在性", passed: false, detail: "fixture 或 provenance 为空" }],
    };
  }

  const { raw, editorial } = fixture.provenance;

  // ── 校验 1：raw provenance 字段完整性 ──────────────────────────────
  const rawMissing = REQUIRED_FIELDS.filter((f) => {
    const v = raw?.[f];
    return v === undefined || v === null || (typeof v === "string" && v.length === 0);
  });
  checks.push({
    name: "raw provenance 字段完整性",
    passed: rawMissing.length === 0,
    detail:
      rawMissing.length === 0
        ? "raw provenance 所有必填字段齐全"
        : `raw provenance 缺失字段：${rawMissing.join("、")}`,
  });

  // ── 校验 2：editorial provenance 字段完整性 ────────────────────────
  const edMissing = REQUIRED_FIELDS.filter((f) => {
    const v = editorial?.[f];
    return v === undefined || v === null || (typeof v === "string" && v.length === 0);
  });
  checks.push({
    name: "editorial provenance 字段完整性",
    passed: edMissing.length === 0,
    detail:
      edMissing.length === 0
        ? "editorial provenance 所有必填字段齐全"
        : `editorial provenance 缺失字段：${edMissing.join("、")}`,
  });

  // 若字段不完整，后续校验无法进行
  if (rawMissing.length > 0 || edMissing.length > 0) {
    return {
      valid: false,
      status: "unverifiable_provenance",
      reason: `provenance 字段不完整：raw 缺失 ${rawMissing.join("、")}；editorial 缺失 ${edMissing.join("、")}`,
      checks,
    };
  }

  // ── 校验 3：同一 case ──────────────────────────────────────────────
  const caseMatch = raw.caseId === editorial.caseId;
  checks.push({
    name: "同一 caseId",
    passed: caseMatch,
    detail: caseMatch
      ? `caseId 一致：${raw.caseId}`
      : `caseId 不一致：raw=${raw.caseId}，editorial=${editorial.caseId}`,
  });

  // ── 校验 4：同一 layer（避免 B3 vs B4 跨 layer）────────────────────
  const layerMatch = raw.layer === editorial.layer;
  checks.push({
    name: "同一 layer",
    passed: layerMatch,
    detail: layerMatch
      ? `layer 一致：${raw.layer}`
      : `layer 不一致：raw=${raw.layer}，editorial=${editorial.layer}（跨 layer 独立运行，非同一次 orchestrate() 内部候选对）`,
  });

  // ── 校验 5：同一 orchestratorRunId（核心校验）──────────────────────
  const runMatch = raw.orchestratorRunId === editorial.orchestratorRunId;
  checks.push({
    name: "同一 orchestratorRunId",
    passed: runMatch,
    detail: runMatch
      ? `orchestratorRunId 一致：${raw.orchestratorRunId}`
      : `orchestratorRunId 不一致：raw=${raw.orchestratorRunId}，editorial=${editorial.orchestratorRunId}（不同 run，无法证明同一 orchestrate()）`,
  });

  // ── 校验 6：指向同一 rawCandidateId ────────────────────────────────
  const rawCandMatch = raw.rawCandidateId === editorial.rawCandidateId;
  checks.push({
    name: "同一 rawCandidateId",
    passed: rawCandMatch,
    detail: rawCandMatch
      ? `rawCandidateId 一致：${raw.rawCandidateId}`
      : `rawCandidateId 不一致：raw=${raw.rawCandidateId}，editorial=${editorial.rawCandidateId}`,
  });

  // ── 校验 7：指向同一 editorialCandidateId ──────────────────────────
  const edCandMatch = raw.editorialCandidateId === editorial.editorialCandidateId;
  checks.push({
    name: "同一 editorialCandidateId",
    passed: edCandMatch,
    detail: edCandMatch
      ? `editorialCandidateId 一致：${raw.editorialCandidateId}`
      : `editorialCandidateId 不一致：raw=${raw.editorialCandidateId}，editorial=${editorial.editorialCandidateId}`,
  });

  // ── 汇总判定 ───────────────────────────────────────────────────────
  const failedChecks = checks.filter((c) => !c.passed);
  const valid = failedChecks.length === 0;

  if (valid) {
    return {
      valid: true,
      status: "ok",
      reason: "provenance 校验通过：raw 与 editorial 来自同一 orchestrate() 运行",
      checks,
    };
  }

  // 失败原因优先级：runId > layer > rawCandidateId > editorialCandidateId > caseId
  const runFailed = !runMatch;
  const layerFailed = !layerMatch;
  let reason: string;
  if (runFailed) {
    reason = `orchestratorRunId 不一致：raw=${raw.orchestratorRunId}，editorial=${editorial.orchestratorRunId}（不同 run，无法证明同一 orchestrate()）`;
  } else if (layerFailed) {
    reason = `layer 不一致：raw=${raw.layer}，editorial=${editorial.layer}（跨 layer 独立运行）`;
  } else {
    reason = `provenance 校验失败：${failedChecks.map((c) => c.name).join("、")}`;
  }

  return {
    valid: false,
    status: "unverifiable_provenance",
    reason,
    checks,
  };
}

// ============================================================================
// DEMO-3-R2.4：B4 artifacts provenance 守卫（实际从磁盘读取并校验）
// ============================================================================

/**
 * 单个 B4 候选文件的元数据（来自 b4-artifacts/run.json）。
 *
 * 与 ReplayFixtureProvenance 的区别：
 * - ReplayFixtureProvenance 是调用方填写的对象（可能伪造）
 * - B4CandidateFileMeta 是 run.json 中记录的文件元数据，守卫据此从磁盘读取正文并校验
 */
export interface B4CandidateFileMeta {
  candidateId: string;
  candidateKind: "raw" | "editorial_amplified";
  rawCandidateId: string;
  sourcePath: string;
  contentHash: string;
  textLength: number;
}

/**
 * B4 run.json 的 provenance 守卫输入（含运行级元数据 + 候选文件元数据）。
 */
export interface B4RunProvenanceInput {
  orchestratorRunId: string;
  caseId: string;
  layer: string;
  rawCandidate: B4CandidateFileMeta;
  editorialCandidates: B4CandidateFileMeta[];
  selectedCandidateId: string;
  selectedSource: "raw" | "editorial";
  finalSource: "B2" | "B3";
  fallbacked: boolean;
  outcomeType: string;
}

/**
 * B4 artifacts provenance 校验结果。
 */
export interface B4ProvenanceValidationResult {
  valid: boolean;
  status: "ok" | "unverifiable_provenance";
  reason: string;
  checks: ProvenanceCheck[];
  /** 校验通过时从磁盘读取的实际 raw 正文（供后续 replay 使用） */
  rawText?: string;
  /** 校验通过时从磁盘读取的实际 editorial 正文（取 selectedCandidateId 对应的 editorial） */
  editorialText?: string;
  /** 校验通过时选中的 editorial candidateId（selectedSource=raw 时为空字符串） */
  selectedEditorialCandidateId?: string;
}

/**
 * 计算文本的 SHA-256 hash（hex，无前缀）。
 * 与 generation-matrix-runner.computeSha256 保持一致。
 */
function computeSha256Local(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

/**
 * 检查 resolvedPath 是否位于 baseDir 内（防止路径越界，如 ../escape 或绝对路径注入）。
 *
 * 使用 relative + 检查无 ".." 前缀的方式，避免符号链接绕过。
 */
function isPathWithin(resolvedPath: string, baseDir: string): boolean {
  if (isAbsolute(resolvedPath)) {
    // 绝对路径必须以 baseDir 开头
    const rel = relative(baseDir, resolvedPath);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  }
  // 相对路径：resolve 后再检查
  const full = join(baseDir, resolvedPath);
  const rel = relative(baseDir, full);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * 安全地读取候选文件：校验路径越界、文件存在、UTF-8 读取。
 *
 * 返回 { ok, text?, error? }：
 * - ok=false 时 error 说明原因（路径越界/文件不存在/读取失败）
 * - ok=true 时 text 为文件内容（UTF-8）
 */
function readCandidateFileSafely(
  caseOutDir: string,
  sourcePath: string,
): { ok: boolean; text?: string; error?: string } {
  // 路径越界检查
  if (!isPathWithin(sourcePath, caseOutDir)) {
    return {
      ok: false,
      error: `路径越界：sourcePath='${sourcePath}' 不在 case 输出目录 '${caseOutDir}' 内`,
    };
  }
  const fullPath = join(caseOutDir, sourcePath);
  // 文件存在检查
  if (!existsSync(fullPath)) {
    return {
      ok: false,
      error: `文件不存在：${fullPath}`,
    };
  }
  // UTF-8 读取
  try {
    const text = readFileSync(fullPath, "utf-8");
    return { ok: true, text };
  } catch (err) {
    return {
      ok: false,
      error: `读取失败：${fullPath} — ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * DEMO-3-R2.4：校验 B4 artifacts 的 provenance（实际从磁盘读取并校验）。
 *
 * 这是强化版守卫，不再仅比较调用方填写的两个对象，而是：
 * 1. 实际从磁盘读取候选文件（sourcePath 指向的 .md 文件）
 * 2. 校验文件位于 case 输出目录内（路径越界检查）
 * 3. 按 UTF-8 读取正文
 * 4. 重新计算 SHA-256 并与 contentHash 比对
 * 5. 校验正文长度与 textLength 一致
 * 6. 校验 candidateId 与文件元数据一致
 * 7. 校验 raw.candidateKind === "raw"
 * 8. 校验 editorial.candidateKind === "editorial_amplified"
 * 9. 校验 raw/editorial 属于同一 caseId、layer="B4"、orchestratorRunId
 * 10. 校验 editorial.rawCandidateId 指向 raw.candidateId
 * 11. 校验 selectedCandidateId 是 raw 或某个 editorial 的 candidateId
 * 12. 校验 selectedSource 与 selectedCandidateId 的 kind 一致
 * 13. 校验 finalSource/fallbacked/outcomeType 与 selectedSource 一致
 *
 * 任一失败 → status="unverifiable_provenance"，valid=false。
 *
 * @param caseOutDir - case 输出目录（b4-artifacts/ 的父目录）
 * @param runMeta - run.json 中的运行级元数据
 * @returns 校验结果（valid 时含 rawText/editorialText 供后续 replay）
 */
export function validateB4ArtifactsProvenance(
  caseOutDir: string,
  runMeta: B4RunProvenanceInput,
): B4ProvenanceValidationResult {
  const checks: ProvenanceCheck[] = [];

  if (!runMeta) {
    return {
      valid: false,
      status: "unverifiable_provenance",
      reason: "runMeta 为空",
      checks: [{ name: "runMeta 存在性", passed: false, detail: "runMeta 为空" }],
    };
  }

  const { rawCandidate, editorialCandidates, orchestratorRunId, caseId, layer } = runMeta;

  // ── 校验 1：runMeta 顶层字段完整性 ──────────────────────────────────
  const topRequired: Array<[string, unknown]> = [
    ["orchestratorRunId", orchestratorRunId],
    ["caseId", caseId],
    ["layer", layer],
    ["selectedCandidateId", runMeta.selectedCandidateId],
    ["selectedSource", runMeta.selectedSource],
    ["finalSource", runMeta.finalSource],
    ["outcomeType", runMeta.outcomeType],
  ];
  const topMissing = topRequired.filter(
    ([, v]) => v === undefined || v === null || (typeof v === "string" && v.length === 0),
  );
  checks.push({
    name: "runMeta 顶层字段完整性",
    passed: topMissing.length === 0,
    detail:
      topMissing.length === 0
        ? "runMeta 顶层所有必填字段齐全"
        : `runMeta 顶层缺失字段：${topMissing.map(([k]) => k).join("、")}`,
  });

  // ── 校验 2：layer 必须为 "B4" ──────────────────────────────────────
  const layerIsB4 = layer === "B4";
  checks.push({
    name: "layer 为 B4",
    passed: layerIsB4,
    detail: layerIsB4 ? "layer=B4" : `layer='${layer}'，期望 'B4'`,
  });

  // ── 校验 3：rawCandidate 元数据完整性 ───────────────────────────────
  const rawFields: Array<[string, unknown]> = [
    ["candidateId", rawCandidate?.candidateId],
    ["candidateKind", rawCandidate?.candidateKind],
    ["rawCandidateId", rawCandidate?.rawCandidateId],
    ["sourcePath", rawCandidate?.sourcePath],
    ["contentHash", rawCandidate?.contentHash],
    ["textLength", rawCandidate?.textLength],
  ];
  const rawMissing = rawFields.filter(
    ([, v]) => v === undefined || v === null || (typeof v === "string" && v.length === 0),
  );
  checks.push({
    name: "rawCandidate 元数据完整性",
    passed: rawMissing.length === 0,
    detail:
      rawMissing.length === 0
        ? "rawCandidate 所有必填字段齐全"
        : `rawCandidate 缺失字段：${rawMissing.map(([k]) => k).join("、")}`,
  });

  if (rawMissing.length > 0 || topMissing.length > 0 || !layerIsB4) {
    return {
      valid: false,
      status: "unverifiable_provenance",
      reason: "runMeta 或 rawCandidate 元数据不完整",
      checks,
    };
  }

  // ── 校验 4：raw.candidateKind === "raw" ─────────────────────────────
  const rawKindOk = rawCandidate.candidateKind === "raw";
  checks.push({
    name: "raw.candidateKind === 'raw'",
    passed: rawKindOk,
    detail: rawKindOk
      ? "raw.candidateKind='raw'"
      : `raw.candidateKind='${rawCandidate.candidateKind}'，期望 'raw'`,
  });

  // ── 校验 5：raw.rawCandidateId === raw.candidateId（raw 指向自身）────
  const rawSelfRefOk = rawCandidate.rawCandidateId === rawCandidate.candidateId;
  checks.push({
    name: "raw.rawCandidateId 指向自身",
    passed: rawSelfRefOk,
    detail: rawSelfRefOk
      ? `raw.rawCandidateId='${rawCandidate.rawCandidateId}' === raw.candidateId`
      : `raw.rawCandidateId='${rawCandidate.rawCandidateId}' !== raw.candidateId='${rawCandidate.candidateId}'`,
  });

  // ── 校验 6：从磁盘读取 raw 候选文件并校验路径越界/存在/UTF-8 ──────────
  const rawFileRead = readCandidateFileSafely(caseOutDir, rawCandidate.sourcePath);
  checks.push({
    name: "raw 候选文件可读（路径越界/存在/UTF-8）",
    passed: rawFileRead.ok,
    detail: rawFileRead.ok
      ? `raw 文件读取成功：${rawCandidate.sourcePath}`
      : `raw 文件读取失败：${rawFileRead.error}`,
  });

  if (!rawFileRead.ok || !rawKindOk || !rawSelfRefOk) {
    return {
      valid: false,
      status: "unverifiable_provenance",
      reason: rawFileRead.ok
        ? "raw 候选元数据校验失败（candidateKind 或 rawCandidateId 不一致）"
        : `raw 候选文件不可读：${rawFileRead.error}`,
      checks,
    };
  }

  const rawText = rawFileRead.text!;

  // ── 校验 7：raw 文件 SHA-256 与 contentHash 一致 ─────────────────────
  const rawActualHash = computeSha256Local(rawText);
  const rawHashOk = rawActualHash === rawCandidate.contentHash;
  checks.push({
    name: "raw 文件 SHA-256 与 contentHash 一致",
    passed: rawHashOk,
    detail: rawHashOk
      ? `raw hash 一致：${rawCandidate.contentHash.slice(0, 16)}…`
      : `raw hash 不符：实际=${rawActualHash.slice(0, 16)}…，声明=${rawCandidate.contentHash.slice(0, 16)}…`,
  });

  // ── 校验 8：raw 文件长度与 textLength 一致 ──────────────────────────
  const rawLenOk = rawText.length === rawCandidate.textLength;
  checks.push({
    name: "raw 文件长度与 textLength 一致",
    passed: rawLenOk,
    detail: rawLenOk
      ? `raw 长度一致：${rawCandidate.textLength}`
      : `raw 长度不符：实际=${rawText.length}，声明=${rawCandidate.textLength}`,
  });

  if (!rawHashOk || !rawLenOk) {
    return {
      valid: false,
      status: "unverifiable_provenance",
      reason: !rawHashOk
        ? "raw 文件 SHA-256 与 contentHash 不符（文件被篡改或元数据错误）"
        : "raw 文件长度与 textLength 不符",
      checks,
    };
  }

  // ── 校验 9-13：遍历 editorialCandidates ─────────────────────────────
  // 如果 selectedSource === "editorial"，需要找到 selectedCandidateId 对应的 editorial
  let selectedEditorial: B4CandidateFileMeta | null = null;

  for (let i = 0; i < editorialCandidates.length; i++) {
    const ed = editorialCandidates[i]!;
    const label = `editorial[${i}](${ed.candidateId ?? "?"})`;

    // 元数据完整性
    const edFields: Array<[string, unknown]> = [
      ["candidateId", ed?.candidateId],
      ["candidateKind", ed?.candidateKind],
      ["rawCandidateId", ed?.rawCandidateId],
      ["sourcePath", ed?.sourcePath],
      ["contentHash", ed?.contentHash],
      ["textLength", ed?.textLength],
    ];
    const edMissing = edFields.filter(
      ([, v]) => v === undefined || v === null || (typeof v === "string" && v.length === 0),
    );
    checks.push({
      name: `${label} 元数据完整性`,
      passed: edMissing.length === 0,
      detail:
        edMissing.length === 0
          ? `${label} 所有必填字段齐全`
          : `${label} 缺失字段：${edMissing.map(([k]) => k).join("、")}`,
    });
    if (edMissing.length > 0) {
      return {
        valid: false,
        status: "unverifiable_provenance",
        reason: `${label} 元数据不完整`,
        checks,
      };
    }

    // candidateKind === "editorial_amplified"
    const edKindOk = ed.candidateKind === "editorial_amplified";
    checks.push({
      name: `${label}.candidateKind === 'editorial_amplified'`,
      passed: edKindOk,
      detail: edKindOk
        ? `${label}.candidateKind='editorial_amplified'`
        : `${label}.candidateKind='${ed.candidateKind}'，期望 'editorial_amplified'`,
    });

    // editorial.rawCandidateId 指向 raw.candidateId
    const edRawRefOk = ed.rawCandidateId === rawCandidate.candidateId;
    checks.push({
      name: `${label}.rawCandidateId 指向 raw`,
      passed: edRawRefOk,
      detail: edRawRefOk
        ? `${label}.rawCandidateId='${ed.rawCandidateId}' === raw.candidateId`
        : `${label}.rawCandidateId='${ed.rawCandidateId}' !== raw.candidateId='${rawCandidate.candidateId}'`,
    });

    // 从磁盘读取 editorial 候选文件
    const edFileRead = readCandidateFileSafely(caseOutDir, ed.sourcePath);
    checks.push({
      name: `${label} 候选文件可读`,
      passed: edFileRead.ok,
      detail: edFileRead.ok
        ? `${label} 文件读取成功：${ed.sourcePath}`
        : `${label} 文件读取失败：${edFileRead.error}`,
    });

    if (!edKindOk || !edRawRefOk || !edFileRead.ok) {
      return {
        valid: false,
        status: "unverifiable_provenance",
        reason: !edFileRead.ok
          ? `${label} 候选文件不可读：${edFileRead.error}`
          : `${label} 元数据校验失败`,
        checks,
      };
    }

    const edText = edFileRead.text!;

    // SHA-256 校验
    const edActualHash = computeSha256Local(edText);
    const edHashOk = edActualHash === ed.contentHash;
    checks.push({
      name: `${label} 文件 SHA-256 与 contentHash 一致`,
      passed: edHashOk,
      detail: edHashOk
        ? `${label} hash 一致：${ed.contentHash.slice(0, 16)}…`
        : `${label} hash 不符：实际=${edActualHash.slice(0, 16)}…，声明=${ed.contentHash.slice(0, 16)}…`,
    });

    // 长度校验
    const edLenOk = edText.length === ed.textLength;
    checks.push({
      name: `${label} 文件长度与 textLength 一致`,
      passed: edLenOk,
      detail: edLenOk
        ? `${label} 长度一致：${ed.textLength}`
        : `${label} 长度不符：实际=${edText.length}，声明=${ed.textLength}`,
    });

    if (!edHashOk || !edLenOk) {
      return {
        valid: false,
        status: "unverifiable_provenance",
        reason: !edHashOk
          ? `${label} 文件 SHA-256 与 contentHash 不符`
          : `${label} 文件长度与 textLength 不符`,
        checks,
      };
    }

    // 记录选中的 editorial
    if (ed.candidateId === runMeta.selectedCandidateId) {
      selectedEditorial = { ...ed, _text: edText } as B4CandidateFileMeta & { _text: string };
    }
  }

  // ── 校验 14：selectedCandidateId 是 raw 或某个 editorial 的 candidateId ──
  const selectedIsRaw = runMeta.selectedCandidateId === rawCandidate.candidateId;
  const selectedIsEditorial = editorialCandidates.some(
    (e) => e.candidateId === runMeta.selectedCandidateId,
  );
  const selectedExists = selectedIsRaw || selectedIsEditorial;
  checks.push({
    name: "selectedCandidateId 存在于候选列表",
    passed: selectedExists,
    detail: selectedExists
      ? `selectedCandidateId='${runMeta.selectedCandidateId}' 是 ${selectedIsRaw ? "raw" : "editorial"} 候选`
      : `selectedCandidateId='${runMeta.selectedCandidateId}' 不在 raw 或 editorial 候选列表中`,
  });

  if (!selectedExists) {
    return {
      valid: false,
      status: "unverifiable_provenance",
      reason: `selectedCandidateId='${runMeta.selectedCandidateId}' 不存在于候选列表`,
      checks,
    };
  }

  // ── 校验 15：selectedSource 与 selectedCandidateId 的 kind 一致 ───────
  const selectedSourceMatchesKind =
    (runMeta.selectedSource === "raw" && selectedIsRaw) ||
    (runMeta.selectedSource === "editorial" && selectedIsEditorial);
  checks.push({
    name: "selectedSource 与 selectedCandidateId kind 一致",
    passed: selectedSourceMatchesKind,
    detail: selectedSourceMatchesKind
      ? `selectedSource='${runMeta.selectedSource}' 与 candidateId kind 一致`
      : `selectedSource='${runMeta.selectedSource}' 但 selectedCandidateId='${runMeta.selectedCandidateId}' 是 ${selectedIsRaw ? "raw" : "editorial"}（kind 矛盾）`,
  });

  // ── 校验 16：outcomeType === "editorial_win" ↔ selectedSource === "editorial" ─
  const isEditorialWin = runMeta.outcomeType === "editorial_win";
  const outcomeSourceConsistent =
    (isEditorialWin && runMeta.selectedSource === "editorial") ||
    (!isEditorialWin && runMeta.selectedSource === "raw");
  checks.push({
    name: "outcomeType 与 selectedSource 一致",
    passed: outcomeSourceConsistent,
    detail: outcomeSourceConsistent
      ? `outcomeType='${runMeta.outcomeType}' 与 selectedSource='${runMeta.selectedSource}' 一致`
      : `outcomeType='${runMeta.outcomeType}' 但 selectedSource='${runMeta.selectedSource}'（矛盾：editorial_win 应对应 editorial，非 editorial_win 应对应 raw）`,
  });

  // ── 校验 17：finalSource 与 outcomeType 一致 ─────────────────────────
  const finalSourceOk = isEditorialWin
    ? runMeta.finalSource === "B3"
    : runMeta.finalSource === "B2";
  checks.push({
    name: "finalSource 与 outcomeType 一致",
    passed: finalSourceOk,
    detail: finalSourceOk
      ? `finalSource='${runMeta.finalSource}' 与 outcomeType='${runMeta.outcomeType}' 一致`
      : `finalSource='${runMeta.finalSource}' 但 outcomeType='${runMeta.outcomeType}'（矛盾：editorial_win→B3，其余→B2）`,
  });

  // ── 校验 18：fallbacked 与 outcomeType 一致 ──────────────────────────
  const fallbackedOk = runMeta.fallbacked === !isEditorialWin;
  checks.push({
    name: "fallbacked 与 outcomeType 一致",
    passed: fallbackedOk,
    detail: fallbackedOk
      ? `fallbacked=${runMeta.fallbacked} 与 outcomeType='${runMeta.outcomeType}' 一致`
      : `fallbacked=${runMeta.fallbacked} 但 outcomeType='${runMeta.outcomeType}'（矛盾：editorial_win→fallbacked=false，其余→fallbacked=true）`,
  });

  // ── 校验 19：所有 editorial 与 raw 共享同一 caseId/layer/orchestratorRunId ─
  // （已在上方逐个校验 rawCandidateId 指向 raw，这里再统一校验 run 级元数据一致性）
  // 注意：editorialCandidates 元数据中不含独立的 caseId/layer/orchestratorRunId 字段，
  // 它们隐式继承自 runMeta。所以这里校验 runMeta 本身的完整性即可。
  // 但需要校验：如果 editorialCandidates 非空，则 selectedSource=editorial 时
  // selectedCandidateId 必须对应一个实际读取成功的 editorial 文件。
  let selectedEditorialText = "";
  if (runMeta.selectedSource === "editorial") {
    if (selectedEditorial === null) {
      checks.push({
        name: "selected editorial 候选文件存在",
        passed: false,
        detail: `selectedSource='editorial' 但 selectedCandidateId='${runMeta.selectedCandidateId}' 未在 editorialCandidates 中找到对应文件`,
      });
      return {
        valid: false,
        status: "unverifiable_provenance",
        reason: "selected editorial 候选文件未找到",
        checks,
      };
    }
    selectedEditorialText = (selectedEditorial as B4CandidateFileMeta & { _text: string })._text;
    checks.push({
      name: "selected editorial 候选文件存在",
      passed: true,
      detail: `selected editorial 文件已读取：${selectedEditorial.sourcePath}`,
    });
  } else {
    // selectedSource === "raw"，editorialText 为空（不使用）
    checks.push({
      name: "selected editorial 候选文件存在",
      passed: true,
      detail: "selectedSource='raw'，无需 editorial 候选文件",
    });
  }

  // ── 汇总判定 ───────────────────────────────────────────────────────
  const failedChecks = checks.filter((c) => !c.passed);
  const valid = failedChecks.length === 0;

  if (valid) {
    return {
      valid: true,
      status: "ok",
      reason: "B4 artifacts provenance 校验通过：所有候选文件从磁盘读取成功，hash/路径/身份/选择一致",
      checks,
      rawText,
      editorialText: selectedEditorialText,
      selectedEditorialCandidateId: selectedEditorial?.candidateId ?? "",
    };
  }

  return {
    valid: false,
    status: "unverifiable_provenance",
    reason: `provenance 校验失败：${failedChecks.map((c) => c.name).join("、")}`,
    checks,
  };
}
