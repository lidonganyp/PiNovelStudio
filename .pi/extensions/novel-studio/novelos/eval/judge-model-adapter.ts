/**
 * P1-2：GPT-5.6-sol 裁判模型适配器（第三方兼容路由）。
 *
 * 设计原则：
 * - 模型/Base URL/Key 全部从 env 读取，不硬编码
 * - 启动时只记录 provider/model/脱敏 endpoint，不记录 Key/Auth header
 * - 支持 capability spike：/models 探测、最小请求、JSON schema 输出
 * - 仅用于 NovelOS eval 脚本盲测裁判，不进生产 fallback 链
 *
 * 安全约束：
 * - callJudgeModel 不记录 Key / Authorization header / 完整请求体
 * - 只记录 provider / model / 脱敏 endpoint / 响应耗时 / 响应长度
 * - 失败时只暴露 status code + 截断的 error message，不回显请求体
 */

import { fetchWithTimeout } from "../../api/request-timeout.js";
import { parseOpenAIStream } from "../../api/openai-stream.js";
import { localizeLlmMessages } from "../../utils/llm-language-guard.js";

// ─────────────────────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────────────────────

export interface JudgeModelConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs?: number;
}

/** 裁判模型 chat 消息（OpenAI 兼容） */
export interface JudgeChatMessage {
  role: "system" | "user";
  content: string;
}

/** callJudgeModel 调用选项 */
export interface JudgeCallOptions {
  /** 使用 JSON schema 约束输出（OpenAI response_format=json_schema） */
  responseFormat?: "json_schema";
  /** JSON schema 定义（responseFormat=json_schema 时必填） */
  schema?: object;
  /** schema 名称（responseFormat=json_schema 时必填） */
  schemaName?: string;
  temperature?: number;
  maxTokens?: number;
  /** 显式启用 SSE，适用于网关对长耗时非流式请求容易返回 504 的场景。 */
  stream?: boolean;
}

/** callJudgeModel 返回结果 */
export interface JudgeCallResult {
  text: string;
  model: string;
  durationMs: number;
}

/** Capability spike 结果 */
export interface JudgeSpikeResult {
  available: boolean;
  modelIdentifier?: string;
  supportsJsonSchema?: boolean;
  notes: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// 配置加载
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 从 env 加载裁判模型配置。
 *
 * 需要：
 * - NOVELOS_JUDGE_API_KEY：API 密钥
 * - NOVELOS_JUDGE_BASE_URL：第三方兼容端点（如 https://shunfen6.win/v1）
 * - NOVELOS_JUDGE_MODEL：模型标识符（如 gpt-5.6-sol）
 *
 * 缺任一变量抛错。
 */
export function loadJudgeModelConfigFromEnv(): JudgeModelConfig {
  const apiKey = process.env.NOVELOS_JUDGE_API_KEY;
  const baseUrl = process.env.NOVELOS_JUDGE_BASE_URL;
  const model = process.env.NOVELOS_JUDGE_MODEL;
  if (!apiKey || !baseUrl || !model) {
    throw new Error(
      "裁判模型 env 未配置：需要 NOVELOS_JUDGE_API_KEY / NOVELOS_JUDGE_BASE_URL / NOVELOS_JUDGE_MODEL",
    );
  }
  const timeoutMsRaw = process.env.NOVELOS_JUDGE_TIMEOUT_MS;
  const timeoutMs = timeoutMsRaw
    ? Number.parseInt(timeoutMsRaw, 10)
    : 120_000;
  return {
    apiKey,
    baseUrl,
    model,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 120_000,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 脱敏
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 脱敏 endpoint：只保留 protocol + host，不暴露 path/key。
 * 例：https://shunfen6.win/v1/chat/completions → https://shunfen6.win
 */
export function maskEndpoint(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "[invalid-url]";
  }
}

/**
 * 脱敏日志描述：provider/model/脱敏 endpoint，不含 Key/Auth。
 */
export function describeJudgeConfig(config: JudgeModelConfig): string {
  return `judge(provider=gpt, model=${config.model}, endpoint=${maskEndpoint(config.baseUrl)}, timeoutMs=${config.timeoutMs ?? 120_000})`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Capability spike
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Capability spike：探测裁判模型是否可用。
 *
 * 探测顺序：
 * 1. GET /models —— 端点可达性 + 模型列表
 * 2. 最小 Chat Completions 请求 —— 基础生成能力
 * 3. JSON schema 输出测试 —— 结构化裁判输出能力
 *
 * 返回 { available, modelIdentifier, supportsJsonSchema, notes }。
 * 不抛错；所有失败记入 notes，available=false。
 */
export async function spikeJudgeModel(
  config: JudgeModelConfig,
): Promise<JudgeSpikeResult> {
  const notes: string[] = [];
  let available = false;
  let modelIdentifier: string | undefined;
  let supportsJsonSchema: boolean | undefined;

  // ── 1. GET /models ─────────────────────────────────────────────────
  try {
    const modelsUrl = `${config.baseUrl.replace(/\/$/, "")}/models`;
    const modelsResp = await fetchWithTimeout(
      modelsUrl,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
        },
      },
      { label: "judge-spike-models", timeoutMs: config.timeoutMs ?? 120_000 },
    );
    if (modelsResp.ok) {
      const modelsData = (await modelsResp.json()) as {
        data?: Array<{ id: string }>;
      };
      const modelIds = modelsData.data?.map((m) => m.id) ?? [];
      notes.push(
        `GET /models 成功：共 ${modelIds.length} 个模型${modelIds.includes(config.model) ? `（含目标 ${config.model}）` : `（未直接列出 ${config.model}，但兼容端点可能接受任意 model id）`}`,
      );
      available = true;
    } else {
      notes.push(`GET /models 返回 HTTP ${modelsResp.status}（兼容端点可能不支持 /models，继续 chat 探测）`);
    }
  } catch (e) {
    notes.push(
      `GET /models 失败：${e instanceof Error ? e.message.substring(0, 120) : String(e).substring(0, 120)}`,
    );
  }

  // ── 2. 最小 Chat Completions 请求 ─────────────────────────────────
  try {
    const result = await callJudgeModel(
      config,
      [
        {
          role: "system",
          content: "你是测试助手。只回复单个汉字：好",
        },
        {
          role: "user",
          content: "回复单个汉字。",
        },
      ],
      { temperature: 0, maxTokens: 16 },
    );
    modelIdentifier = result.model;
    notes.push(
      `Chat Completions 成功：model=${result.model}, 耗时=${result.durationMs}ms, 响应长度=${result.text.length}`,
    );
    available = true;
  } catch (e) {
    notes.push(
      `Chat Completions 失败：${e instanceof Error ? e.message.substring(0, 150) : String(e).substring(0, 150)}`,
    );
    available = false;
  }

  // ── 3. JSON schema 输出测试 ────────────────────────────────────────
  if (available) {
    try {
      const testSchema = {
        type: "object",
        properties: {
          winner: { type: "string", enum: ["A", "B", "tie"] },
          reason: { type: "string" },
        },
        required: ["winner", "reason"],
        additionalProperties: false,
      };
      const result = await callJudgeModel(
        config,
        [
          {
            role: "system",
            content: "你是裁判。输出 JSON：{winner, reason}。winner 只能是 A/B/tie。",
          },
          {
            role: "user",
            content: "候选 A：好。候选 B：差。请输出 JSON 裁决。",
          },
        ],
        {
          responseFormat: "json_schema",
          schema: testSchema,
          schemaName: "spike_verdict",
          temperature: 0,
          maxTokens: 128,
        },
      );
      const parsed = JSON.parse(result.text) as { winner?: string; reason?: string };
      if (parsed.winner && ["A", "B", "tie"].includes(parsed.winner)) {
        supportsJsonSchema = true;
        notes.push(
          `JSON schema 输出成功：winner=${parsed.winner}, 耗时=${result.durationMs}ms`,
        );
      } else {
        supportsJsonSchema = false;
        notes.push(
          `JSON schema 输出可解析但字段不合规：${result.text.substring(0, 80)}`,
        );
      }
    } catch (e) {
      supportsJsonSchema = false;
      notes.push(
        `JSON schema 输出失败：${e instanceof Error ? e.message.substring(0, 150) : String(e).substring(0, 150)}`,
      );
    }
  }

  return { available, modelIdentifier, supportsJsonSchema, notes };
}

// ─────────────────────────────────────────────────────────────────────────────
// 调用裁判模型
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 调用裁判模型（OpenAI Chat Completions 兼容）。
 *
 * 安全约束：
 * - 不记录 Key / Authorization header / 完整请求体
 * - 只记录 provider / model / 脱敏 endpoint / 响应耗时 / 响应长度
 * - 失败时只暴露 status code + 截断的 error message
 *
 * @param config 裁判模型配置
 * @param messages chat 消息（system + user）
 * @param options 调用选项（JSON schema / temperature / maxTokens）
 */
export async function callJudgeModel(
  config: JudgeModelConfig,
  messages: JudgeChatMessage[],
  options?: JudgeCallOptions,
): Promise<JudgeCallResult> {
  const url = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const timeoutMs = config.timeoutMs ?? 120_000;
  const startMs = Date.now();
  const streamLongRequest = options?.stream === true || (
    config.model === "gpt-5.6-sol"
    && (options?.maxTokens ?? 4096) >= 8192
  );

  // 构造请求体
  const requestBody: Record<string, unknown> = {
    model: config.model,
    messages: localizeLlmMessages(messages),
    temperature: options?.temperature ?? 0.2,
    max_tokens: options?.maxTokens ?? 4096,
  };
  if (streamLongRequest) requestBody.stream = true;

  // JSON schema 输出约束
  if (options?.responseFormat === "json_schema") {
    if (!options.schema || !options.schemaName) {
      throw new Error(
        "responseFormat=json_schema 需要 schema 和 schemaName",
      );
    }
    requestBody.response_format = {
      type: "json_schema",
      json_schema: {
        name: options.schemaName,
        schema: options.schema,
        strict: true,
      },
    };
  }

  const response = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(requestBody),
    },
    { label: `judge:${config.model}`, timeoutMs },
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    let errorMessage = response.statusText;
    try {
      const errorData = JSON.parse(errorText) as {
        error?: { message?: string };
      };
      errorMessage = errorData.error?.message || response.statusText;
    } catch {
      errorMessage = errorText.substring(0, 200) || response.statusText;
    }
    throw new Error(
      `judge API error (HTTP ${response.status}): ${errorMessage.substring(0, 200)}`,
    );
  }

  const data = (streamLongRequest && response.headers.get("content-type")?.includes("text/event-stream")
    ? { model: config.model, ...await parseOpenAIStream(response, config.model) }
    : await response.json()) as {
    model?: string;
    choices?: Array<{
      message?: { content?: string };
      finish_reason?: string;
    }>;
  };

  const text = data.choices?.[0]?.message?.content ?? "";
  const model = data.model ?? config.model;
  const durationMs = Date.now() - startMs;

  return { text, model, durationMs };
}
