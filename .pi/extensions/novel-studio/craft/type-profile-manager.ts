/**
 * PiNovelStudio — TypeProfile Manager
 *
 * 第十轮蒸馏：类型感知系统
 *
 * 职责：
 * 1. 读写 type-profile.json
 * 2. 管理类型配置与 Agent 参数的注入
 * 3. 处理类型优先级（type-profile > workspace_config > Agent 默认值）
 *
 * 规则 #547-#555
 */

import { readFileSync, writeFileSync, existsSync, readFileSync as fsReadFileSync } from "fs";
import { join } from "path";
import { normalizeNovelType } from "./type-profile-types.js";
import type { NovelType as PresetNovelType } from "./type-profile-types.js";
import type {
  TypeProfile,
  AgentTypeParams,
  AgentParamsMap,
  NovelType,
  DriftStatus,
  TypeProfileMetadata
} from "./type-profile-types.js";

export type { TypeProfile } from "./type-profile-types.js";

/**
 * 优先级链：type-profile > workspace_config > Agent 内置默认值
 */
export const PARAM_OVERRIDE_PRIORITY = {
  TYPE_PROFILE: 3,
  WORKSPACE_CONFIG: 2,
  AGENT_DEFAULT: 1,
} as const;

/**
 * force_override 标记的参数不被覆盖
 */
const FORCE_OVERRIDE_KEY = "__force_override__";

/**
 * TypeProfile Manager
 *
 * 管理类型配置档案的读写和参数注入
 */
export interface TypePresetFile {
  type: PresetNovelType;
  version?: string;
  description?: string;
  agent_params?: Record<string, Record<string, unknown>>;
}

export class TypeProfileManager {
  private workspacePath: string;
  private workspaceId: string;
  private typeProfile: TypeProfile | null = null;
  private workspaceConfig: Record<string, unknown> | null = null;

  constructor(workspacePath: string, workspaceId: string) {
    this.workspacePath = workspacePath;
    this.workspaceId = workspaceId;
  }

  /**
   * 加载 type-profile.json
   *
   * @param forceReload 强制重新加载
   */
  async load(forceReload = false): Promise<TypeProfile | null> {
    if (this.typeProfile && !forceReload) {
      if (this.isProfileAlignedWithWorkspaceDeclaration(this.typeProfile)) {
        return this.typeProfile;
      }
      this.typeProfile = null;
    }

    const profilePath = this.getProfilePath();
    if (!existsSync(profilePath)) {
      return null;
    }

    try {
      const content = fsReadFileSync(profilePath, "utf-8");
      const parsed = JSON.parse(content) as TypeProfile;
      if (!this.isProfileAlignedWithWorkspaceDeclaration(parsed)) {
        console.warn(
          `Ignoring stale type-profile.json for ${this.workspaceId}: workspace config declares a different primary type.`
        );
        this.typeProfile = null;
        return null;
      }
      this.typeProfile = parsed;
      return parsed;
    } catch (error) {
      console.error(`加载 type-profile.json 失败: ${error instanceof Error ? error.message : "unknown"}`);
      return null;
    }
  }

  private isProfileAlignedWithWorkspaceDeclaration(profile: TypeProfile): boolean {
    if (profile.metadata?.human_override) {
      return true;
    }

    const declaredPrimaryType = this.getDeclaredPrimaryTypeFromWorkspace();
    if (!declaredPrimaryType) {
      return true;
    }

    return normalizeNovelType(profile.metadata?.primary_type) === declaredPrimaryType;
  }

  private getDeclaredPrimaryTypeFromWorkspace(): NovelType | null {
    const config = this.loadWorkspaceConfig();
    if (!config) {
      return null;
    }

    const novel = config.novel;
    if (novel && typeof novel === "object") {
      const primaryType = normalizeNovelType((novel as Record<string, unknown>).primary_type);
      if (primaryType) {
        return primaryType;
      }
    }

    return normalizeNovelType(config.genre);
  }

  private loadWorkspaceConfig(): Record<string, unknown> | null {
    if (this.workspaceConfig) {
      return this.workspaceConfig;
    }

    const configPath = join(this.workspacePath, this.workspaceId, "config.json");
    if (!existsSync(configPath)) {
      return null;
    }

    try {
      const content = fsReadFileSync(configPath, "utf-8");
      this.workspaceConfig = JSON.parse(content);
      return this.workspaceConfig;
    } catch {
      return null;
    }
  }

  /**
   * 获取 type-profile.json 文件路径
   */
  private getProfilePath(): string {
    return join(this.workspacePath, this.workspaceId, "type-profile.json");
  }

  /**
   * 保存 type-profile.json
   */
  async save(profile: TypeProfile): Promise<boolean> {
    const profilePath = this.getProfilePath();

    try {
      profile.metadata.updated_at = new Date().toISOString();
      const content = JSON.stringify(profile, null, 2);
      writeFileSync(profilePath, content, "utf-8");
      this.typeProfile = profile;
      return true;
    } catch (error) {
      console.error(`保存 type-profile.json 失败: ${error instanceof Error ? error.message : "unknown"}`);
      return false;
    }
  }

  /**
   * 获取指定 Agent 的类型化参数
   *
   * @param agentName Agent 名称
   * @param paramName 参数名称（可选，不传则返回所有参数）
   */
  async getAgentParams(
    agentName: string,
    paramName?: string
  ): Promise<AgentTypeParams | unknown | null> {
    const profile = await this.load();
    if (!profile) {
      return null;
    }

    const agentParams = profile.agent_params[agentName as keyof AgentParamsMap];
    if (!agentParams) {
      return null;
    }

    if (paramName) {
      return (agentParams as Record<string, unknown>)[paramName] ?? null;
    }

    return agentParams;
  }

  /**
   * 获取参数值（带优先级覆盖）
   *
   * 规则 #520: type-profile 参数 > workspace_config 手动配置 > Agent 内置默认值
   * force_override=true 的参数不被覆盖
   *
   * @param agentName Agent 名称
   * @param paramName 参数名称
   * @param agentDefault Agent 内置默认值
   */
  async getParamWithPriority<T>(
    agentName: string,
    paramName: string,
    agentDefault: T
  ): Promise<T> {
    // 1. 先检查是否有 force_override 标记
    // 语义：若某参数被标记为 force_override，则锁定该参数值，禁止被更低优先级来源覆盖。
    const forceOverrideKey = `${paramName}_${FORCE_OVERRIDE_KEY}`;
    const agentParams = await this.getAgentParams(agentName) as Record<string, unknown> | null;
    const isForceOverride = agentParams?.[forceOverrideKey] === true;

    // 2. 从 type-profile 读取
    const typeProfileValue = await this.getAgentParams(agentName, paramName);
    if (typeProfileValue !== null && typeProfileValue !== undefined) {
      return typeProfileValue as T;
    }

    // 3. 从 workspace_config 读取（仅在未 force_override 时允许）
    if (!isForceOverride) {
      const workspaceConfigValue = await this.getWorkspaceConfigParam(agentName, paramName);
      if (workspaceConfigValue !== null && workspaceConfigValue !== undefined) {
        return workspaceConfigValue as T;
      }
    }

    // 4. 使用 Agent 内置默认值
    return agentDefault;
  }

  /**
   * 获取 workspace config 中的参数
   */
  private getWorkspaceConfigParam(agentName: string, paramName: string): unknown | null {
    const config = this.loadWorkspaceConfig();
    if (!config) {
      return null;
    }

    // 尝试从 novel.novelTypeOverrides 或 typeOverrides 中读取
    const overrides = config.novelTypeOverrides ||
                      config.typeOverrides ||
                      {};

    if (typeof overrides === "object" && overrides !== null) {
      const agentOverrides = (overrides as Record<string, unknown>)[agentName];
      if (agentOverrides && typeof agentOverrides === "object") {
        return (agentOverrides as Record<string, unknown>)[paramName] ?? null;
      }
    }

    return null;
  }

  /**
   * 获取当前主类型
   */
  async getPrimaryType(): Promise<NovelType | null> {
    const profile = await this.load();
    return profile?.metadata.primary_type ?? null;
  }

  /**
   * 获取当前副类型
   */
  async getSecondaryType(): Promise<NovelType | null> {
    const profile = await this.load();
    return profile?.metadata.secondary_type ?? null;
  }

  /**
   * 获取类型模式（单类型/复合类型）
   */
  async getTypeMode(): Promise<"single" | "composite" | null> {
    const profile = await this.load();
    return profile?.metadata.type_mode ?? null;
  }

  /**
   * 获取置信度
   */
  async getConfidence(): Promise<number> {
    const profile = await this.load();
    return profile?.metadata.confidence ?? 0;
  }

  /**
   * 获取漂移状态
   */
  async getDriftStatus(): Promise<DriftStatus> {
    const profile = await this.load();
    return profile?.metadata.drift_status ?? "stable";
  }

  /**
   * 获取钩子模板
   */
  async getHookTemplates(type: NovelType): Promise<TypeProfile["hook_template_library"][NovelType] | null> {
    const profile = await this.load();
    return profile?.hook_template_library[type] ?? null;
  }

  /**
   * 获取情绪曲线模板
   */
  async getEmotionCurveTemplate(
    template: keyof TypeProfile["emotion_curve_templates"]
  ): Promise<TypeProfile["emotion_curve_templates"][keyof TypeProfile["emotion_curve_templates"]] | null> {
    const profile = await this.load();
    return profile?.emotion_curve_templates[template] ?? null;
  }

  /**
   * 获取当前主类型（同步版本，用于构建 prompt 时快速获取）
   */
  getPrimaryTypeSync(): NovelType | null {
    return this.typeProfile?.metadata.primary_type ?? null;
  }

  /**
   * 获取类型对应的情绪曲线模板名称
   */
  async getTypeEmotionCurveTemplate(type: NovelType): Promise<keyof TypeProfile["emotion_curve_templates"]> {
    const templateMap: Record<NovelType, keyof TypeProfile["emotion_curve_templates"]> = {
      power_fantasy: "sawtooth_rising",
      mystery: "undercurrent",
      romance: "wave_advance",
      xianxia: "staircase",
    };
    return templateMap[type] || "sawtooth_rising";
  }

  /**
   * 检查类型是否有变更
   */
  async hasTypeChanged(newProfile: TypeProfile): Promise<boolean> {
    const currentProfile = await this.load();
    if (!currentProfile) {
      return true;
    }

    return (
      currentProfile.metadata.primary_type !== newProfile.metadata.primary_type ||
      currentProfile.metadata.secondary_type !== newProfile.metadata.secondary_type
    );
  }

  /**
   * 更新漂移状态
   */
  async updateDriftStatus(status: DriftStatus): Promise<boolean> {
    const profile = await this.load();
    if (!profile) {
      return false;
    }

    profile.metadata.drift_status = status;
    return await this.save(profile);
  }

  /**
   * 将 presets/*.json 合并到 type-profile.json（仅合并 agent_params）
   */
  async applyPresetToProfile(preset: TypePresetFile): Promise<boolean> {
    const profile = await this.load();
    if (!profile) return false;

    if (!preset?.agent_params || typeof preset.agent_params !== "object") {
      return false;
    }

    // 合并到 agent_params（不覆盖已存在字段，除非 preset 提供明确值）
    for (const [agentName, params] of Object.entries(preset.agent_params)) {
      const existing = profile.agent_params[agentName as keyof AgentParamsMap] as Record<string, unknown> | undefined;
      if (existing) {
        profile.agent_params[agentName as keyof AgentParamsMap] = {
          ...existing,
          ...(params || {}),
        } as any;
      } else {
        profile.agent_params[agentName as keyof AgentParamsMap] = (params || {}) as any;
      }
    }

    return await this.save(profile);
  }

  /**
   * 读取 preset 文件
   */
  static loadPresetFile(presetPath: string): TypePresetFile | null {
    try {
      if (!existsSync(presetPath)) return null;
      const raw = readFileSync(presetPath, "utf-8");
      const data = JSON.parse(raw) as TypePresetFile;
      if (!data || typeof data !== "object") return null;
      if (!data.type) return null;
      return data;
    } catch {
      return null;
    }
  }

  /**
   * 根据类型返回 preset 文件路径
   */
  static getPresetPathByType(presetsRoot: string, type: PresetNovelType): string {
    const fileName: Record<PresetNovelType, string> = {
      power_fantasy: "power_fantasy_default.json",
      mystery: "mystery_default.json",
      romance: "romance_default.json",
      xianxia: "xianxia_default.json",
    };
    return join(presetsRoot, fileName[type]);
  }
}

/**
 * 创建 TypeProfileManager 实例
 */
export function createTypeProfileManager(workspacePath: string, workspaceId: string): TypeProfileManager {
  return new TypeProfileManager(workspacePath, workspaceId);
}

/**
 * 便捷函数：获取指定 Agent 的类型化参数
 *
 * 用于 Agent 初始化时快速获取类型化参数
 */
export async function getTypeAwareParams(
  workspacePath: string,
  workspaceId: string,
  agentName: string,
  defaultParams: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const manager = new TypeProfileManager(workspacePath, workspaceId);
  const profile = await manager.load();

  if (!profile) {
    return defaultParams;
  }

  const agentParams = profile.agent_params[agentName as keyof AgentParamsMap];
  if (!agentParams) {
    return defaultParams;
  }

  // 合并：类型化参数覆盖默认值
  return {
    ...defaultParams,
    ...agentParams,
  };
}

/**
 * 同步获取主类型（用于 prompt 构建等同步场景）
 */
export function getPrimaryTypeSync(profile: TypeProfile | undefined | null): NovelType | null {
  return profile?.metadata?.primary_type ?? null;
}

/**
 * 便捷函数：获取 AntiAIDetector 的类型化阈值
 *
 * 规则 #476: AntiAIDetector 阈值按类型调整
 */
export async function getTypeAwareAntiAIThreshold(
  workspacePath: string,
  workspaceId: string
): Promise<number> {
  const manager = new TypeProfileManager(workspacePath, workspaceId);
  const threshold = await manager.getParamWithPriority("AntiAIDetector", "anti_ai_threshold", 0.7);
  return threshold as number;
}

/**
 * 便捷函数：获取完整 TypeProfile 对象（用于 Agent 的 loadTypeAwareParams）
 * 替代 getTypeAwareParams（后者需要4参数，不适合直接加载完整 profile）
 */
export async function getTypeProfile(
  workspacePath: string,
  workspaceId: string
): Promise<TypeProfile | null> {
  const manager = new TypeProfileManager(workspacePath, workspaceId);
  return await manager.load();
}

/**
 * 便捷函数：获取 EmotionMetronome 的类型化情绪基线
 *
 * 规则 #523: 情绪曲线类型化
 */
export async function getTypeAwareEmotionBaseline(
  workspacePath: string,
  workspaceId: string
): Promise<number> {
  const manager = new TypeProfileManager(workspacePath, workspaceId);
  const baseline = await manager.getParamWithPriority("EmotionMetronome", "emotion_baseline", 5.0);
  return baseline as number;
}
