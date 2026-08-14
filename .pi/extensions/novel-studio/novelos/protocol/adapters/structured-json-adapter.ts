/**
 * NovelOS Structured JSON Protocol Adapter（Phase 3 — 预留接口，不实现）
 *
 * 本阶段只预留接口，不进入生产或 eval。
 * 未来实现时，模型输出结构化 JSON，适配器解析 JSON 中的工具调用字段。
 */

import {
  type ModelProtocolAdapter,
  type AdapterRequest,
  type ProviderRequest,
  type ProviderResponse,
  type ProviderContinuation,
} from "../protocol-adapter.js";
import type { ModelTurn } from "../model-turn.js";

/**
 * Structured JSON 协议适配器（预留，不实现）。
 *
 * createRequest / parseResponse / serializeToolResults 均抛出 NotImplemented 错误。
 * 仅满足接口签名，供未来实现。
 */
export class StructuredJsonAdapter implements ModelProtocolAdapter {
  readonly protocol = "structured-json" as const;
  readonly version = "structured-json-v0";

  createRequest(_input: AdapterRequest): ProviderRequest {
    throw new Error("StructuredJsonAdapter 未实现：本阶段只预留接口");
  }

  parseResponse(_response: ProviderResponse): ModelTurn {
    throw new Error("StructuredJsonAdapter 未实现：本阶段只预留接口");
  }

  serializeToolResults(_turn: ModelTurn): ProviderContinuation {
    throw new Error("StructuredJsonAdapter 未实现：本阶段只预留接口");
  }
}
