/**
 * PiNovelStudio — LLM 调用缓存
 *
 * 基于内容哈希的 LLM 结果缓存，避免重复调用相同输入。
 * 用于调试同一章节重复运行时命中缓存，减少无效 LLM 调用。
 *
 * Cache Key 组成：
 * stage + model + promptHash + textHash + styleProfile + dagHash
 *
 * P21 新增模块
 */

import { createHash } from "crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  unlinkSync,
} from "fs";
import { join } from "path";
import { homedir } from "os";

// ============================================================================
// 类型定义
// ============================================================================

/** 缓存条目 */
export interface LLMCacheEntry {
  /** 缓存 key */
  key: string;
  /** 缓存的响应内容 */
  content: string;
  /** 创建时间 */
  createdAt: number;
  /** 过期时间（毫秒） */
  expiresAt: number;
  /** 调用时的元数据 */
  metadata: {
    stage: string;
    model: string;
    promptHash: string;
    textHash?: string;
    styleProfile?: string;
    dagHash?: string;
    tokens?: number;
  };
}

/** 缓存配置 */
export interface LLMCacheConfig {
  /** 缓存目录路径 */
  cacheDir?: string;
  /** 默认过期时间（小时） */
  defaultTTLHours?: number;
  /** 最大缓存条目数 */
  maxEntries?: number;
  /** 是否启用缓存 */
  enabled?: boolean;
}

// ============================================================================
// 常量定义
// ============================================================================

/** 默认配置 */
const DEFAULT_CONFIG: Required<LLMCacheConfig> = {
  cacheDir: join(homedir(), ".pinel-studio", "cache", "llm"),
  defaultTTLHours: 24,
  maxEntries: 500,
  enabled: true,
};

/** 缓存文件名后缀 */
const CACHE_FILE_SUFFIX = ".json";

// ============================================================================
// LLMCache 类
// ============================================================================

export class LLMCache {
  private readonly config: Required<LLMCacheConfig>;
  private readonly cacheDir: string;

  constructor(config: LLMCacheConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.cacheDir = this.config.cacheDir;
    this.ensureCacheDir();
  }

  /**
   * 确保缓存目录存在
   */
  private ensureCacheDir(): void {
    if (!existsSync(this.cacheDir)) {
      mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  /**
   * 生成缓存 key
   */
  generateCacheKey(params: {
    stage: string;
    model: string;
    prompt: string;
    text?: string;
    styleProfile?: string;
    dagJson?: string;
  }): string {
    const { stage, model, prompt, text, styleProfile, dagJson } = params;

    // 生成各部分哈希
    const promptHash = this.hashString(prompt);
    const textHash = text ? this.hashString(text) : undefined;
    const styleHash = styleProfile ? this.hashString(styleProfile) : undefined;
    const dagHash = dagJson ? this.hashString(dagJson) : undefined;

    // 组合缓存 key
    const parts = [stage, model, promptHash];
    if (textHash) parts.push(textHash);
    if (styleHash) parts.push(styleHash);
    if (dagHash) parts.push(dagHash);

    return this.hashString(parts.join("|"));
  }

  /**
   * 生成字符串哈希
   */
  hashString(input: string): string {
    return createHash("sha256").update(input, "utf8").digest("hex").substring(0, 16);
  }

  /**
   * 获取缓存条目
   */
  get(key: string): LLMCacheEntry | null {
    if (!this.config.enabled) return null;

    const cacheFile = this.getCacheFilePath(key);
    if (!existsSync(cacheFile)) {
      return null;
    }

    try {
      const content = readFileSync(cacheFile, "utf-8");
      const entry: LLMCacheEntry = JSON.parse(content);

      // 检查是否过期
      if (Date.now() > entry.expiresAt) {
        this.delete(key);
        return null;
      }

      return entry;
    } catch {
      return null;
    }
  }

  /**
   * 设置缓存条目
   */
  set(
    key: string,
    content: string,
    metadata: LLMCacheEntry["metadata"],
    ttlHours?: number
  ): void {
    if (!this.config.enabled) return;

    const ttl = ttlHours ?? this.config.defaultTTLHours;
    const now = Date.now();
    const entry: LLMCacheEntry = {
      key,
      content,
      createdAt: now,
      expiresAt: now + ttl * 60 * 60 * 1000,
      metadata,
    };

    try {
      const cacheFile = this.getCacheFilePath(key);
      writeFileSync(cacheFile, JSON.stringify(entry, null, 2), "utf-8");
    } catch (error) {
      console.warn(`[LLMCache] Failed to write cache: ${error}`);
    }

    // 清理过期缓存
    this.cleanupExpired();
  }

  /**
   * 删除缓存条目
   */
  delete(key: string): boolean {
    const cacheFile = this.getCacheFilePath(key);
    if (existsSync(cacheFile)) {
      try {
        unlinkSync(cacheFile);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  /**
   * 清空所有缓存
   */
  clear(): void {
    try {
      const files = readdirSync(this.cacheDir);
      for (const file of files) {
        if (file.endsWith(CACHE_FILE_SUFFIX)) {
          unlinkSync(join(this.cacheDir, file));
        }
      }
    } catch (error) {
      console.warn(`[LLMCache] Failed to clear cache: ${error}`);
    }
  }

  /**
   * 获取缓存文件路径
   */
  private getCacheFilePath(key: string): string {
    return join(this.cacheDir, `${key}${CACHE_FILE_SUFFIX}`);
  }

  /**
   * 清理过期缓存
   */
  private cleanupExpired(): void {
    try {
      const files = readdirSync(this.cacheDir);
      const now = Date.now();
      let deletedCount = 0;

      for (const file of files) {
        if (!file.endsWith(CACHE_FILE_SUFFIX)) continue;

        const filePath = join(this.cacheDir, file);
        try {
          const content = readFileSync(filePath, "utf-8");
          const entry: LLMCacheEntry = JSON.parse(content);

          if (now > entry.expiresAt) {
            unlinkSync(filePath);
            deletedCount++;
          }
        } catch {
          // 文件损坏，直接删除
          unlinkSync(filePath);
          deletedCount++;
        }
      }

      if (deletedCount > 0) {
      }
    } catch (error) {
      console.warn(`[LLMCache] Failed to cleanup: ${error}`);
    }
  }

  /**
   * 获取缓存统计信息
   */
  getStats(): {
    totalEntries: number;
    expiredEntries: number;
    totalSizeBytes: number;
  } {
    try {
      const files = readdirSync(this.cacheDir);
      const now = Date.now();
      let totalEntries = 0;
      let expiredEntries = 0;
      let totalSizeBytes = 0;

      for (const file of files) {
        if (!file.endsWith(CACHE_FILE_SUFFIX)) continue;

        const filePath = join(this.cacheDir, file);
        const stats = statSync(filePath);
        totalSizeBytes += stats.size;
        totalEntries++;

        try {
          const content = readFileSync(filePath, "utf-8");
          const entry: LLMCacheEntry = JSON.parse(content);
          if (now > entry.expiresAt) {
            expiredEntries++;
          }
        } catch {
          expiredEntries++;
        }
      }

      return { totalEntries, expiredEntries, totalSizeBytes };
    } catch {
      return { totalEntries: 0, expiredEntries: 0, totalSizeBytes: 0 };
    }
  }
}

// ============================================================================
// 工厂函数
// ============================================================================

/** 全局缓存实例 */
let globalCache: LLMCache | null = null;

/**
 * 获取全局 LLM 缓存实例
 */
export function getLLMCache(config?: LLMCacheConfig): LLMCache {
  if (!globalCache) {
    globalCache = new LLMCache(config);
  }
  return globalCache;
}

/**
 * 创建新的 LLM 缓存实例
 */
export function createLLMCache(config?: LLMCacheConfig): LLMCache {
  return new LLMCache(config);
}

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 装饰器：为 LLM 调用添加缓存支持
 *
 * @example
 * ```typescript
 * const cachedCall = withLLMCache(llmCall, {
 *   stage: "style_shaper",
 *   model: "configured-model",
 * });
 * const result = await cachedCall({ prompt, text, styleProfile });
 * ```
 */
export function withLLMCache<T extends (...args: any[]) => Promise<any>>(
  llmCall: T,
  defaultParams: {
    stage: string;
    model: string;
    getPrompt?: (args: Parameters<T>) => string;
    getText?: (args: Parameters<T>) => string | undefined;
    getStyleProfile?: (args: Parameters<T>) => string | undefined;
    getDagJson?: (args: Parameters<T>) => string | undefined;
  },
  cacheConfig?: LLMCacheConfig
): T {
  const cache = createLLMCache(cacheConfig);

  return (async (...args: Parameters<T>) => {
    const prompt = defaultParams.getPrompt?.(args) ?? "";
    const text = defaultParams.getText?.(args);
    const styleProfile = defaultParams.getStyleProfile?.(args);
    const dagJson = defaultParams.getDagJson?.(args);

    const cacheKey = cache.generateCacheKey({
      stage: defaultParams.stage,
      model: defaultParams.model,
      prompt,
      text,
      styleProfile,
      dagJson,
    });

    // 尝试从缓存获取
    const cached = cache.get(cacheKey);
    if (cached) {
      return cached.content;
    }

    // 执行 LLM 调用
    const result = await llmCall(...args);

    // 写入缓存
    cache.set(cacheKey, result, {
      stage: defaultParams.stage,
      model: defaultParams.model,
      promptHash: cache.hashString(prompt),
      textHash: text ? cache.hashString(text) : undefined,
      styleProfile,
      dagHash: dagJson ? cache.hashString(dagJson) : undefined,
    });

    return result;
  }) as T;
}
