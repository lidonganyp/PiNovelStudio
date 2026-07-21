/**
 * PiNovelStudio — 章节身份与路径 canonical resolver
 *
 * canonical 规则: chapterId = 纯数字字符串（如 "2"），不补零、去前导零
 * 路径派生: chapter-2.md / chapter-2/ / 2-quality-trace.json / ch2-contract.yaml
 *
 * 旧格式（chapter-02.md / ch002 / chapter-chapter-2）仅保留兼容读取，
 * resolveExisting* 系列依次尝试候选路径，canonical 优先。
 * 所有新写入必须走 resolve* 系列（canonical only），禁止手写字符串拼接。
 *
 * 替代散落逻辑: narrator.extractChapterNumber / nrs-engine parseInt(replace(/\D/g,'')) ||
 * 1 / workspace/manager replace("chapter-","") / dag/serializer listAll 解析。
 */

import { existsSync, statSync } from "fs";
import { join } from "path";

// ============================================================================
// chapterId 归一化
// ============================================================================

/**
 * 把任意输入归一化为 canonical chapterId（纯数字字符串，去前导零）。
 * 接受: "2" | "chapter-2" | "chapter-02" | "ch002" | "ch_002" | "chapter-chapter-2" | 2(number)
 * 策略: 正则提取首段连续数字，parseInt 去前导零；无数字返回 ""。
 * 用正则不用 parseInt(input)：parseInt("chapter-2") 返回 NaN，/\d+/.exec 返回 "2"。
 */
export function toChapterId(input: string | number): string {
  if (typeof input === "number") {
    return Number.isFinite(input) ? String(input) : "";
  }
  if (typeof input !== "string") {
    return "";
  }
  const match = input.match(/\d+/);
  if (!match) {
    return "";
  }
  const num = parseInt(match[0], 10);
  return Number.isNaN(num) ? "" : String(num);
}

/**
 * 解析为章节号 number。NaN 或 < 1 时 fallback 到 1（保持现有行为，不引入新阻断）。
 * 替代旧 narrator.extractChapterNumber / nrs-engine 的 parseInt(replace(/\D/g,'')) || 1。
 */
export function parseChapterNumber(input: string | number): number {
  const id = toChapterId(input);
  const n = parseInt(id, 10);
  if (Number.isNaN(n) || n < 1) {
    return 1;
  }
  return n;
}

/**
 * 解析已存在的 chapterId 字符串，返回 { raw, canonical, prefix } 用于诊断。
 * prefix 为数字串前的字面片段（可能含前导零，仅用于诊断）。
 */
export function parseChapterId(raw: string): {
  raw: string;
  canonical: string;
  prefix: string | null;
} {
  const canonical = toChapterId(raw);
  if (canonical === "") {
    return { raw, canonical: "", prefix: null };
  }
  const match = raw.match(/^([^\d]*)(\d+)/);
  const prefix = match && match[1] ? match[1] : null;
  return { raw, canonical, prefix };
}

// ============================================================================
// 路径派生（canonical only，用于新写入）
// ============================================================================

/**
 * P1 安全修复：校验 chapterId 格式，防止路径穿越。
 * 只允许字母、数字、连字符、下划线；拒绝路径分隔符、`..`、控制字符。
 * 兼容 canonical（"2"）、legacy（"chapter-2"、"ch002"）与测试 fixture（"chapter-type-obligation"）。
 * 拒绝 "../../pwn"、"2/3"、"..\pwn" 等穿越输入，所有 resolve* 写路径 fail-closed。
 */
export function validateChapterId(chapterId: string): void {
  if (typeof chapterId !== "string" || chapterId.length === 0) {
    throw new Error(`Invalid chapterId: must be a non-empty string (got: ${JSON.stringify(chapterId)})`);
  }
  if (chapterId.includes("..") || chapterId.includes("/") || chapterId.includes("\\") || chapterId.includes("\0")) {
    throw new Error(`Invalid chapterId: path traversal characters not allowed (got: ${JSON.stringify(chapterId)})`);
  }
  if (!/^[A-Za-z0-9_-]+$/.test(chapterId)) {
    throw new Error(`Invalid chapterId: only alphanumeric, hyphen, underscore allowed (got: ${JSON.stringify(chapterId)})`);
  }
}

/**
 * 写入路径用的有效 chapterId：数字输入走 canonical（去前导零/前缀），
 * 非数字输入（如测试 fixture "chapter-type-obligation"）原样透传，避免塌成空串。
 * toChapterId 对无数字输入返回 ""，这里 fallback 到原始输入保形。
 * P1 修复：先走 validateChapterId fail-closed，再归一化。
 */
function effectiveChapterId(chapterId: string): string {
  validateChapterId(chapterId);
  const id = toChapterId(chapterId);
  return id === "" ? chapterId : id;
}

/** 章节正文路径: chapters/chapter-{N}.md */
export function resolveChapterFile(workspacePath: string, chapterId: string): string {
  const id = effectiveChapterId(chapterId);
  return join(workspacePath, "chapters", `chapter-${id}.md`);
}

/** 章节目录路径: chapters/chapter-{N}/ */
export function resolveChapterDir(workspacePath: string, chapterId: string): string {
  const id = effectiveChapterId(chapterId);
  return join(workspacePath, "chapters", `chapter-${id}`);
}

/** trace 路径: traces/{N}-quality-trace.json */
export function resolveTraceFile(workspacePath: string, chapterId: string): string {
  const id = effectiveChapterId(chapterId);
  return join(workspacePath, "traces", `${id}-quality-trace.json`);
}

/** contract 路径: series/ch{N}-contract.yaml */
export function resolveContractFile(workspacePath: string, chapterId: string): string {
  const id = effectiveChapterId(chapterId);
  return join(workspacePath, "series", `ch${id}-contract.yaml`);
}

/** outline-explicit 路径: series/ch{N}-outline-explicit.md */
export function resolveExplicitOutlineFile(workspacePath: string, chapterId: string): string {
  const id = effectiveChapterId(chapterId);
  return join(workspacePath, "series", `ch${id}-outline-explicit.md`);
}

/** anchors 路径: chapters/chapter-{N}/anchors.json */
export function resolveAnchorsFile(workspacePath: string, chapterId: string): string {
  return join(resolveChapterDir(workspacePath, chapterId), "anchors.json");
}

/** blueprint 路径: chapters/chapter-{N}/blueprint.json */
export function resolveBlueprintFile(workspacePath: string, chapterId: string): string {
  return join(resolveChapterDir(workspacePath, chapterId), "blueprint.json");
}

/** generate-result 路径: chapters/chapter-{N}/generate-result.json */
export function resolveGenerateResultFile(workspacePath: string, chapterId: string): string {
  return join(resolveChapterDir(workspacePath, chapterId), "generate-result.json");
}

/**
 * 给 DAGSerializer 用（basePath 已是 chapters/ 目录）。
 * 返回 chapters/chapter-{N}/ 目录（不包含 blueprint.json 文件名）。
 */
export function resolveChapterDirFromChaptersDir(
  chaptersDir: string,
  chapterId: string,
): string {
  const id = effectiveChapterId(chapterId);
  return join(chaptersDir, `chapter-${id}`);
}

// ============================================================================
// 兼容读取（只读，不写）。canonical 优先，避免读到旧分裂产物。
// ============================================================================

export type ChapterPathFormat = "canonical" | "numeric" | "padded2" | "padded3" | "double_prefix";

export interface ResolvedChapterPath {
  path: string;
  format: ChapterPathFormat;
}

/** 生成章节正文候选路径列表（canonical 优先） */
function chapterFileCandidates(
  chaptersDir: string,
  chapterId: string,
): Array<{ path: string; format: ChapterPathFormat }> {
  const id = toChapterId(chapterId);
  if (id === "") {
    return [];
  }
  const padded2 = id.padStart(2, "0");
  const padded3 = id.padStart(3, "0");
  return [
    { path: join(chaptersDir, `chapter-${id}.md`), format: "canonical" },
    { path: join(chaptersDir, `${id}.md`), format: "numeric" },
    { path: join(chaptersDir, `chapter-${padded2}.md`), format: "padded2" },
    { path: join(chaptersDir, `chapter-${padded3}.md`), format: "padded3" },
    { path: join(chaptersDir, `chapter-chapter-${id}.md`), format: "double_prefix" },
  ];
}

/** 生成章节目录候选路径列表（canonical 优先） */
function chapterDirCandidates(
  chaptersDir: string,
  chapterId: string,
): Array<{ path: string; format: ChapterPathFormat }> {
  const id = toChapterId(chapterId);
  if (id === "") {
    return [];
  }
  const padded2 = id.padStart(2, "0");
  const padded3 = id.padStart(3, "0");
  return [
    { path: join(chaptersDir, `chapter-${id}`), format: "canonical" },
    { path: join(chaptersDir, `chapter-${padded2}`), format: "padded2" },
    { path: join(chaptersDir, `chapter-${padded3}`), format: "padded3" },
    { path: join(chaptersDir, `chapter-chapter-${id}`), format: "double_prefix" },
  ];
}

/**
 * 兼容读取章节正文: 依次尝试候选路径，返回首个存在的路径或 null。
 * canonical 优先，避免读到旧 padded 分裂产物。
 */
export function resolveExistingChapterFile(
  workspacePath: string,
  chapterId: string,
): ResolvedChapterPath | null {
  const chaptersDir = join(workspacePath, "chapters");
  return resolveExistingChapterFileFromChaptersDir(chaptersDir, chapterId);
}

/**
 * 兼容读取已知 chapters/ 目录下的章节正文。用于离线验收脚本等已经持有
 * 章节目录的调用点，避免重新拼接 workspace 路径。
 */
export function resolveExistingChapterFileFromChaptersDir(
  chaptersDir: string,
  chapterId: string,
): ResolvedChapterPath | null {
  for (const c of chapterFileCandidates(chaptersDir, chapterId)) {
    if (existsSync(c.path)) {
      return c;
    }
  }
  return null;
}

/**
 * 兼容读取章节目录: 同上候选策略
 */
export function resolveExistingChapterDir(
  workspacePath: string,
  chapterId: string,
): ResolvedChapterPath | null {
  const chaptersDir = join(workspacePath, "chapters");
  for (const c of chapterDirCandidates(chaptersDir, chapterId)) {
    if (existsSync(c.path)) {
      return c;
    }
  }
  return null;
}

/**
 * 兼容读取 blueprint.json: 在 resolveExistingChapterDir 下找 blueprint.json
 */
export function resolveExistingBlueprintFile(
  workspacePath: string,
  chapterId: string,
): string | null {
  const dir = resolveExistingChapterDir(workspacePath, chapterId);
  if (!dir) {
    return null;
  }
  const bp = join(dir.path, "blueprint.json");
  return existsSync(bp) ? bp : null;
}

/**
 * 兼容读取 generate-result.json
 */
export function resolveExistingGenerateResultFile(
  workspacePath: string,
  chapterId: string,
): string | null {
  const dir = resolveExistingChapterDir(workspacePath, chapterId);
  if (!dir) {
    return null;
  }
  const gr = join(dir.path, "generate-result.json");
  return existsSync(gr) ? gr : null;
}

/**
 * 检测是否为双前缀 bug 目录（chapter-chapter-{N}）。
 * 用于 workspace manager 列出警告，提示手动清理历史孤儿目录。
 */
export function isDoublePrefixChapterDir(dirName: string): boolean {
  return /^chapter-chapter-\d+$/.test(dirName);
}

/**
 * 获取 contract 文件的修订时间（ISO 字符串），用于指纹。
 * 失败时返回 epoch（1970-01-01）。
 */
export function getContractRevisionTimestamp(contractPath: string): string {
  try {
    return statSync(contractPath).mtime.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}
