/**
 * PiNovelStudio — 文件系统工具
 *
 * 封装常用的文件系统操作，提供跨平台兼容
 */

import {
  readFile,
  writeFile,
  mkdir,
  readdir,
  stat,
  copyFile,
  unlink,
  rmdir,
  access,
  constants,
  rename,
} from "fs/promises";
import { existsSync } from "fs";
import { join, resolve, dirname, basename } from "path";
import { glob } from "glob";

export interface FileInfo {
  path: string;
  name: string;
  isDirectory: boolean;
  size?: number;
  modifiedAt?: Date;
  createdAt?: Date;
}

/**
 * 确保目录存在（递归创建）
 */
export async function ensureDir(dirPath: string): Promise<void> {
  if (!existsSync(dirPath)) {
    await mkdir(dirPath, { recursive: true });
  }
}

/**
 * 检查路径是否存在
 */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 读取文本文件
 */
export async function readTextFile(filePath: string): Promise<string> {
  const content = await readFile(filePath, "utf-8");
  return content;
}

/**
 * 写入文本文件
 */
export async function writeTextFile(
  filePath: string,
  content: string
): Promise<void> {
  const dir = dirname(filePath);
  await ensureDir(dir);
  await writeFile(filePath, content, "utf-8");
}

/**
 * 读取 JSON 文件
 */
export async function readJsonFile<T>(filePath: string): Promise<T> {
  const content = await readTextFile(filePath);
  return JSON.parse(content) as T;
}

/**
 * 写入 JSON 文件
 */
export async function writeJsonFile<T>(
  filePath: string,
  data: T,
  pretty: boolean = true
): Promise<void> {
  const content = pretty
    ? JSON.stringify(data, null, 2)
    : JSON.stringify(data);
  await writeTextFile(filePath, content);
}

/**
 * 复制文件
 */
export async function copyFileAsync(
  source: string,
  destination: string
): Promise<void> {
  const destDir = dirname(destination);
  await ensureDir(destDir);
  await copyFile(source, destination);
}

/**
 * 删除文件
 */
export async function deleteFile(filePath: string): Promise<void> {
  if (existsSync(filePath)) {
    await unlink(filePath);
  }
}

/**
 * 删除目录（递归）
 */
export async function deleteDir(dirPath: string): Promise<void> {
  if (!existsSync(dirPath)) {
    return;
  }

  const entries = await readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      await deleteDir(fullPath);
    } else {
      await unlink(fullPath);
    }
  }

  await rmdir(dirPath);
}

/**
 * 列出目录内容
 */
export async function listDir(
  dirPath: string,
  options?: {
    recursive?: boolean;
    includeHidden?: boolean;
  }
): Promise<FileInfo[]> {
  if (!existsSync(dirPath)) {
    return [];
  }

  const results: FileInfo[] = [];
  const entries = await readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    if (!options?.includeHidden && entry.name.startsWith(".")) {
      continue;
    }

    const fullPath = join(dirPath, entry.name);
    const info: FileInfo = {
      path: fullPath,
      name: entry.name,
      isDirectory: entry.isDirectory(),
    };

    if (!entry.isDirectory()) {
      const stats = await stat(fullPath);
      info.size = stats.size;
      info.modifiedAt = stats.mtime;
      info.createdAt = stats.birthtime;
    }

    results.push(info);

    if (options?.recursive && entry.isDirectory()) {
      const subResults = await listDir(fullPath, options);
      results.push(...subResults);
    }
  }

  return results;
}

/**
 * 获取文件信息
 */
export async function getFileInfo(filePath: string): Promise<FileInfo | null> {
  if (!existsSync(filePath)) {
    return null;
  }

  const stats = await stat(filePath);
  return {
    path: filePath,
    name: basename(filePath),
    isDirectory: stats.isDirectory(),
    size: stats.size,
    modifiedAt: stats.mtime,
    createdAt: stats.birthtime,
  };
}

/**
 * 查找匹配的文件
 */
export async function findFiles(
  pattern: string,
  options?: { cwd?: string; absolute?: boolean }
): Promise<string[]> {
  return glob(pattern, {
    cwd: options?.cwd || process.cwd(),
    absolute: options?.absolute || false,
    dot: false,
  });
}

/**
 * 复制目录
 */
export async function copyDir(
  source: string,
  destination: string
): Promise<void> {
  await ensureDir(destination);

  const entries = await readdir(source, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = join(source, entry.name);
    const destPath = join(destination, entry.name);

    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      await copyFileAsync(srcPath, destPath);
    }
  }
}

/**
 * 读取 Markdown 文件并提取元数据
 */
export interface MarkdownMetadata {
  content: string;
  frontmatter: Record<string, unknown>;
}

export async function readMarkdownFile(
  filePath: string
): Promise<MarkdownMetadata> {
  const content = await readTextFile(filePath);

  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

  if (frontmatterMatch) {
    try {
      const frontmatter = parseYAML(frontmatterMatch[1]);
      return {
        frontmatter,
        content: frontmatterMatch[2],
      };
    } catch {
      return { frontmatter: {}, content };
    }
  }

  return { frontmatter: {}, content };
}

/**
 * 简单的 YAML 解析（仅支持基本格式）
 */
function parseYAML(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = content.split("\n");

  for (const line of lines) {
    const match = line.match(/^(\w+):\s*(.*)$/);
    if (match) {
      const [, key, value] = match;
      result[key] = value.replace(/^["']|["']$/g, "");
    }
  }

  return result;
}

/**
 * 写入 Markdown 文件（带可选的 frontmatter）
 */
export async function writeMarkdownFile(
  filePath: string,
  content: string,
  frontmatter?: Record<string, unknown>
): Promise<void> {
  let fullContent = content;

  if (frontmatter && Object.keys(frontmatter).length > 0) {
    const fm = Object.entries(frontmatter)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join("\n");
    fullContent = `---\n${fm}\n---\n\n${content}`;
  }

  await writeTextFile(filePath, fullContent);
}

/**
 * 获取相对路径
 */
export function relativePath(from: string, to: string): string {
  return resolve(from, "..", to);
}

/**
 * 规范化路径分隔符
 */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

/**
 * 校验 workspaceId 格式安全（防 Path Traversal）
 * 只允许字母、数字、下划线、连字符
 */
export function validateWorkspaceId(workspaceId: string): void {
  if (!workspaceId || typeof workspaceId !== "string") {
    throw new Error(`Invalid workspaceId: must be a non-empty string`);
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(workspaceId)) {
    throw new Error(
      `Invalid workspaceId "${workspaceId}": only alphanumeric, underscore and hyphen allowed`
    );
  }
  if (workspaceId.includes("..")) {
    throw new Error(`Invalid workspaceId "${workspaceId}": must not contain ".."`);
  }
}

/**
 * 安全解析 workspace 路径（二次防线）
 * 1. 校验 workspaceId 格式
 * 2. resolve 消除符号链接和 ..
 * 3. startsWith 确保结果在 basePath 内
 */
export function resolveWorkspacePath(basePath: string, workspaceId: string): string {
  validateWorkspaceId(workspaceId);
  const resolvedBase = resolve(basePath);
  const resolvedPath = resolve(resolvedBase, workspaceId);
  const sep = resolvedPath.includes("\\") ? "\\" : "/";
  if (!resolvedPath.startsWith(resolvedBase + sep) && resolvedPath !== resolvedBase) {
    throw new Error(
      `Path traversal detected: workspace "${workspaceId}" resolves outside base directory`
    );
  }
  return resolvedPath;
}

// ============================================================================
// LLM JSON 安全解析
// ============================================================================

export interface ParseLLMJsonResult<T> {
  ok: boolean;
  data: T | null;
  raw: string;
  error?: string;
}

/**
 * 安全解析 LLM 输出的 JSON。
 * 1. 去除 markdown code fence（```json ... ```）
 * 2. 捕获 parse error
 * 3. 返回 { ok, data, raw, error }
 * 4. 失败时不让 SyntaxError 直接击穿流程
 */
export function parseLLMJson<T = unknown>(raw: string): ParseLLMJsonResult<T> {
  if (!raw || typeof raw !== "string") {
    return { ok: false, data: null, raw: String(raw), error: "Input is not a string" };
  }

  // 去除 markdown code fence
  let cleaned = raw.trim();
  const fenceMatch = cleaned.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  // 去除前后多余的文字（LLM 有时在 JSON 前后加说明）
  const jsonStart = cleaned.indexOf("{");
  const jsonEnd = cleaned.lastIndexOf("}");
  if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
    cleaned = cleaned.substring(jsonStart, jsonEnd + 1);
  }

  try {
    const data = JSON.parse(cleaned) as T;
    return { ok: true, data, raw };
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    return { ok: false, data: null, raw, error: `JSON parse failed: ${errorMsg}` };
  }
}

// ============================================================================
// 原子写入
// ============================================================================

/**
 * 原子写入 JSON 文件。
 * 1. 写入 .tmp 临时文件
 * 2. rename 替换目标文件（原子操作）
 * 3. 失败时清理临时文件
 *
 * 适用于状态文件、trace、runtime rules、workspace 配置等。
 *
 * Windows rename 在目标文件被其他进程/杀软占用时会偶发 EPERM/EBUSY/EPERM。
 * 这里加 3 次指数退避重试，避免全量测试偶发失败。
 */
export async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const tmpPath = filePath + ".tmp";
  try {
    await writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    await renameWithRetry(tmpPath, filePath);
  } catch (e) {
    // 清理临时文件
    try { await unlink(tmpPath); } catch { /* ignore cleanup error */ }
    throw e;
  }
}

/**
 * Windows rename 偶发 EPERM/EBUSY 重试。
 * 重试条件：错误码为 EPERM、EACCES、EBUSY、ENOTEMPTY 之一。
 * 其它错误（如 ENOENT 源文件不存在）直接抛出。
 */
async function renameWithRetry(src: string, dest: string): Promise<void> {
  const RETRYABLE = new Set(["EPERM", "EACCES", "EBUSY", "ENOTEMPTY"]);
  const MAX_RETRIES = 3;
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await rename(src, dest);
      return;
    } catch (e) {
      lastError = e;
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code && RETRYABLE.has(code) && attempt < MAX_RETRIES) {
        await sleep(20 * Math.pow(2, attempt)); // 20ms, 40ms, 80ms
        continue;
      }
      throw e;
    }
  }
  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
