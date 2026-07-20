/**
 * ProxyApprovalProviderRunner — Provider Runner（EVOLUTION-RELEASE-GOVERNANCE-1C）
 *
 * 真相源：docs/evolution-release-governance-development-plan.md §6 / Phase G4 / 1C 任务卡
 *
 * 1C provider runner 连接 1B proxy-approval-caller：
 * - stub 模式：本地端到端跑通（委托 createStubProxyApprovalCaller）
 * - real 模式：必须提供有效授权卡（未过期 + 覆盖 releaseId + 预算充足）
 *   - 有效卡片下返回 identity="gpt5.6-sol" 的 caller
 *   - caller.call() 本身仍 REQUIRES_AUTH（真实 API 集成为后续工程切片）
 *
 * 边界（READY_LOCAL；真实模型调用 REQUIRES_AUTH）：
 * - 不调用模型（real 模式仅交付授权边界，真实 API 集成为后续切片）
 * - 不切换 active pointer
 * - 不接 novel_generate_chapter
 */

import { createStubProxyApprovalCaller } from "./proxy-approval-caller.js";
import type { ProxyApprovalCaller } from "./proxy-approval-caller.js";
import type { RawVerdict } from "./release-proxy-approval-types.js";
import type { AuthorizationCard } from "./authorization-card.js";
import { assertCardAuthorizes } from "./authorization-card.js";

// ============================================================================
// 类型
// ============================================================================

export interface StubProviderRunnerOptions {
  mode: "stub";
  forwardVerdict: RawVerdict;
  reverseVerdict: RawVerdict;
  quarantineReason?: string;
  modelVersion?: string;
}

export interface RealProviderRunnerOptions {
  mode: "real";
  /** 授权卡；未提供时抛 REQUIRES_AUTH（真实 gpt5.6-sol 调用必须持卡） */
  authorizationCard?: AuthorizationCard;
  releaseId: string;
  modelVersion: string;
  /** 真实端点配置（1C 不实现真实调用，字段保留） */
  endpoint?: { baseUrl: string; apiKey: string };
}

export type ProviderRunnerOptions = StubProviderRunnerOptions | RealProviderRunnerOptions;

// ============================================================================
// createProviderRunner
// ============================================================================

/**
 * 创建 provider runner。
 *
 * stub 模式：委托 createStubProxyApprovalCaller，identity="stub"，零网络调用。
 * real 模式：
 *   - 无 authorizationCard → throw REQUIRES_AUTH.*授权卡
 *   - 过期 / 未覆盖 releaseId / 预算不足 → throw REQUIRES_AUTH（对应后缀）
 *   - 有效卡片 → 返回 identity="gpt5.6-sol" 的 caller，但 call() 本身仍 throw REQUIRES_AUTH
 *     （真实 gpt5.6-sol API 集成为后续工程切片，1C 仅交付授权边界）
 *
 * 不切换 active pointer，不接 novel_generate_chapter。
 */
export function createProviderRunner(options: ProviderRunnerOptions): ProxyApprovalCaller {
  if (options.mode === "stub") {
    return createStubProxyApprovalCaller({
      forwardVerdict: options.forwardVerdict,
      reverseVerdict: options.reverseVerdict,
      quarantineReason: options.quarantineReason,
      modelVersion: options.modelVersion,
    });
  }

  // real 模式
  const { authorizationCard, releaseId } = options;

  // 1. 授权卡前置检查：未提供 → REQUIRES_AUTH.*授权卡
  if (!authorizationCard) {
    throw new Error(
      "REQUIRES_AUTH: 真实 gpt5.6-sol 调用需授权卡（authorizationCard 未提供）",
    );
  }

  // 2. 授权边界：过期 / 未覆盖 / 预算不足 → REQUIRES_AUTH（对应后缀）
  //    复用 authorization-card 的统一断言，保证错误消息一致
  assertCardAuthorizes(authorizationCard, releaseId);

  // 3. 有效卡片：返回 identity="gpt5.6-sol" 的 caller
  //    call() 本身仍 REQUIRES_AUTH（真实 API 集成为后续切片）
  return {
    identity: "gpt5.6-sol",
    async call(): Promise<never> {
      throw new Error(
        "REQUIRES_AUTH: 真实 gpt5.6-sol API 集成待授权后实现（1C 切片仅交付授权边界，不调用真实模型）",
      );
    },
  };
}
