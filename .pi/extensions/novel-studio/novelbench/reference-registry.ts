/**
 * NB-2：Reference 注册表
 *
 * 核心原则（任务要求）：
 * - reference 原文只供 evaluator 使用，generator 不得访问
 * - 持久化文件仅存 referenceId + sourcePath + bodyHash + offsets，**无 body**
 * - generator 路径只调 register()，evaluator 路径才调 resolve()
 *
 * 架构边界：
 * - ReferenceLocator 类型（types.ts）无 sourcePath 字段，case JSON 无法携带源路径
 * - dataset-builder.ts 只调 register()/save()，不调 resolve()（边界测试守护）
 * - resolve() 供未来 evaluator（NB-3 Reference Analyzer）使用
 *
 * 本模块为 eval-only，由 tsconfig.eval.json 编译到 dist-eval/，不进 dist/。
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { decodeNovelSourceBuffer } from "../eval/replay-case-extractor.js";

// ─────────────────────────────────────────────────────────────────────────────
// 公开 API
// ─────────────────────────────────────────────────────────────────────────────

/** reference 记录（无 body，可持久化） */
export interface ReferenceRecord {
  referenceId: string;
  /** 源文件绝对路径（仅 evaluator 可见，不入 case JSON） */
  sourcePath: string;
  bodyHash: string;
  startOffset: number;
  endOffset: number;
  /** 源文件编码提示（可选，用于解码优化） */
  encoding?: string;
}

/**
 * Reference 注册表。
 *
 * 持久化为 JSON 文件（无 body），支持 register/resolve/save/load。
 * generator 路径只调 register + save；evaluator 路径调 resolve。
 */
export class ReferenceRegistry {
  private readonly storagePath: string;
  private readonly records = new Map<string, ReferenceRecord>();

  /**
   * @param storagePath 持久化文件路径（reference-registry.json）
   */
  constructor(storagePath: string) {
    this.storagePath = storagePath;
  }

  /** 注册一条 reference 记录（generator 调用） */
  register(record: ReferenceRecord): void {
    this.records.set(record.referenceId, { ...record });
  }

  /** 是否已注册 */
  has(referenceId: string): boolean {
    return this.records.has(referenceId);
  }

  /**
   * 解封 reference：读源文件 → 解码 → 切片 → hash 验证 → 返回 body。
   *
   * ⚠️ evaluator-only：generator 路径不得调用本方法。
   *
   * @returns body 文本；记录不存在或 hash 不匹配返回 null
   */
  resolve(referenceId: string): string | null {
    const record = this.records.get(referenceId);
    if (!record) return null;

    if (!existsSync(record.sourcePath)) return null;

    const buffer = readFileSync(record.sourcePath);
    const decoded = decodeNovelSourceBuffer(new Uint8Array(buffer));
    const body = decoded.text
      .slice(record.startOffset, record.endOffset)
      .replace(/^\uFEFF/, "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .trim();

    const hash = sha256(body);
    return hash === record.bodyHash ? body : null;
  }

  /** 持久化到 storagePath（JSON，无 body） */
  save(): void {
    const dir = dirname(this.storagePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const list = this.list();
    writeFileSync(this.storagePath, JSON.stringify(list, null, 2) + "\n", "utf-8");
  }

  /** 从 storagePath 加载 */
  load(): void {
    this.records.clear();
    if (!existsSync(this.storagePath)) return;
    const content = readFileSync(this.storagePath, "utf-8");
    try {
      const list = JSON.parse(content) as ReferenceRecord[];
      for (const r of list) {
        this.records.set(r.referenceId, r);
      }
    } catch {
      // 损坏的 registry 文件：忽略，从空开始
    }
  }

  /** 列出所有记录（无 body） */
  list(): ReferenceRecord[] {
    return [...this.records.values()].sort((a, b) =>
      a.referenceId.localeCompare(b.referenceId),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 内部工具
// ─────────────────────────────────────────────────────────────────────────────

function sha256(data: string): string {
  return createHash("sha256").update(data, "utf-8").digest("hex");
}
