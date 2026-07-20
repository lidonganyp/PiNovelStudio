/**
 * StrategyEvidenceStore — 策略证据持久化存储（STRATEGY-EVIDENCE-1B）
 *
 * 派工计划 docs/remaining-development-dispatch-plan-20260715.md §3 P0-D：
 * 完成 StrategyEvidenceDataset 的 append/revocation/quarantine 的持久化层，
 * 不改变生产策略状态。
 *
 * 设计目标：
 * - load：读取 evidence artifact 文件，返回 records（文件不存在返回空数组）
 * - save：原子写入（temp → rename），保证不残留 partial 文件
 * - append：加载 → appendEvidence 校验 → 保存（append-only + workspaceId 隔离）
 * - snapshot/artifact：只读视图
 *
 * 不变量（READY_LOCAL 边界）：
 * - 不调用模型、不保存章节、不提交长期状态
 * - 不修改 alpha/beta / 不改生产策略信誉（StrategyPolicyStore）
 * - 不是 gate；不阻断正文生成
 * - 只写 evidence.json，不写 chapter/state/strategy 文件
 * - 写 evidence 不得自动 active（admission 由 compileAdmissionDecisions 独立评估）
 *
 * 与 strategy-evidence-dataset.ts 的关系：
 * - 本模块是 fs 持久化层，委托 schema 校验与 append-only 校验给纯函数
 * - strategy-evidence-dataset.ts 保持纯函数（无 fs 依赖）
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";

import {
  STRATEGY_EVIDENCE_SCHEMA_ID,
  STRATEGY_EVIDENCE_SCHEMA_VERSION,
  validateStrategyEvidenceArtifact,
  validateStrategyEvidenceAppend,
} from "./strategy-evidence-dataset.js";
import type {
  StrategyEvidenceArtifact,
  StrategyEvidenceRecord,
  StrategyEvidenceValidationError,
} from "./strategy-evidence-dataset.js";

// ============================================================================
// 类型
// ============================================================================

export interface StrategyEvidenceStoreOptions {
  /** evidence artifact 文件路径 */
  filePath: string;
  /** workspace 标识（写入 artifact.workspaceId，append 时校验与既有文件一致） */
  workspaceId: string;
}

export interface StrategyEvidenceStore {
  /** 加载 evidence records（文件不存在返回空数组；损坏文件抛错） */
  load(): StrategyEvidenceRecord[];
  /** 原子保存 records（覆盖写入，temp → rename；先校验结构） */
  save(records: StrategyEvidenceRecord[]): void;
  /**
   * append-only 追加（加载既有 → 校验 append → 保存）。
   * 既有文件 workspaceId 与 store 不一致时拒绝。
   */
  append(
    newRecords: StrategyEvidenceRecord[]
  ):
    | { ok: true; appendedCount: number }
    | { ok: false; error: StrategyEvidenceValidationError };
  /** 当前 snapshot（等价于 load，语义上表示只读视图） */
  snapshot(): StrategyEvidenceRecord[];
  /** 完整 artifact（含 schemaId/schemaVersion/workspaceId/records） */
  artifact(): StrategyEvidenceArtifact;
}

// ============================================================================
// 辅助
// ============================================================================

function buildArtifact(
  workspaceId: string,
  records: StrategyEvidenceRecord[],
): StrategyEvidenceArtifact {
  return {
    schemaId: STRATEGY_EVIDENCE_SCHEMA_ID,
    schemaVersion: STRATEGY_EVIDENCE_SCHEMA_VERSION,
    workspaceId,
    records,
  };
}

function readArtifact(
  filePath: string,
): StrategyEvidenceArtifact | null {
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, "utf-8");
  const parsed: unknown = JSON.parse(raw);
  const validation = validateStrategyEvidenceArtifact(parsed);
  if (!validation.ok) {
    throw new Error(
      `strategy evidence artifact 校验失败: ${validation.error.code} at ${validation.error.path} — ${validation.error.message}`,
    );
  }
  return validation.artifact;
}

function writeArtifact(filePath: string, artifact: StrategyEvidenceArtifact): void {
  const json = JSON.stringify(artifact, null, 2);
  const tmpPath = filePath + ".tmp";
  // 原子写入：先写 .tmp，再 rename 覆盖目标文件
  writeFileSync(tmpPath, json, "utf-8");
  renameSync(tmpPath, filePath);
}

// ============================================================================
// createStrategyEvidenceStore
// ============================================================================

/**
 * 创建一个 fs 持久化的策略证据存储。
 *
 * 每次操作都重新读取/写入文件（无内存缓存），保证多进程/多次调用的一致性。
 * append 操作内部执行 append-only 校验，拒绝重复 evidenceId / 历史 mutation。
 */
export function createStrategyEvidenceStore(
  options: StrategyEvidenceStoreOptions,
): StrategyEvidenceStore {
  const { filePath, workspaceId } = options;

  function loadRecords(): StrategyEvidenceRecord[] {
    const artifact = readArtifact(filePath);
    return artifact ? artifact.records : [];
  }

  return {
    load: loadRecords,

    save(records) {
      const artifact = buildArtifact(workspaceId, records);
      // 校验 records 结构（防止调用方写入非法 record）
      const validation = validateStrategyEvidenceArtifact(artifact);
      if (!validation.ok) {
        throw new Error(
          `strategy evidence save 校验失败: ${validation.error.code} at ${validation.error.path} — ${validation.error.message}`,
        );
      }
      writeArtifact(filePath, artifact);
    },

    append(newRecords) {
      // 加载既有 artifact
      const existing = readArtifact(filePath);

      // workspaceId 隔离：既有文件 workspaceId 与 store 不一致 → 拒绝
      if (existing && existing.workspaceId !== workspaceId) {
        return {
          ok: false,
          error: {
            code: "artifact_identity_changed",
            path: "workspaceId",
            message: `既有 artifact workspaceId=${existing.workspaceId} 与 store workspaceId=${workspaceId} 不一致，append 不得跨 workspace 合并`,
          },
        };
      }

      const previousArtifact: StrategyEvidenceArtifact =
        existing ?? buildArtifact(workspaceId, []);

      // 构造 next
      const nextArtifact: StrategyEvidenceArtifact = {
        ...previousArtifact,
        records: [...previousArtifact.records, ...newRecords],
      };

      // append-only 校验（含 next 结构校验、重复 evidenceId 检测、历史 mutation 检测）
      const validation = validateStrategyEvidenceAppend(
        previousArtifact,
        nextArtifact,
      );
      if (!validation.ok) return validation;

      writeArtifact(filePath, nextArtifact);
      return { ok: true, appendedCount: validation.appendedCount };
    },

    snapshot: loadRecords,

    artifact() {
      const existing = readArtifact(filePath);
      return existing ?? buildArtifact(workspaceId, []);
    },
  };
}
