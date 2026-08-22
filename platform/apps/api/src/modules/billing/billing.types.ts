/**
 * 计费引擎领域类型：预占 / 结算 / 收尾 / 调账 / 可用余额。
 */

export type HoldStatus = 'active' | 'released' | 'settled';
export type FinalizeOutcome = 'success' | 'failure';

export interface CreateHoldInput {
  userId: number;
  jobId: string;
  amount: bigint;
}

export interface HoldView {
  jobId: string;
  userId: number;
  amount: bigint;
  settledAmount: bigint;
  status: HoldStatus;
  alreadyExisted: boolean;
  alreadyFinalized: boolean;
  progressStage: string | null;
}

export interface SettleCallInput {
  jobId: string;
  callId: string;
  internalStage: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  /**
   * 结算超出预占余量时按余量封顶收费而不是拒绝（402）。
   * 用于内容已生成、丢弃即浪费的对话式结算；默认 false = 超占即抛 HoldExhaustedException。
   */
  capAtHold?: boolean;
}

export interface SettleCallResult {
  jobId: string;
  callId: string;
  alreadySettled: boolean;
  actualCharge: bigint;
  chargeFromReal: bigint;
  chargeFromBonus: bigint;
  settledAmount: bigint;
  remainingBudget: bigint;
}

export interface FinalizeHoldInput {
  jobId: string;
  outcome: FinalizeOutcome;
}

export interface AdjustBalanceInput {
  userId: number;
  adminUserId: number;
  amount: bigint;
  reason: string;
}

export interface AdjustmentView {
  id: number;
  userId: number;
  adminUserId: number;
  amount: bigint;
  reason: string;
  createdAt: Date;
}

export interface AvailableBalance {
  /** 充值余额（真实收入） */
  balance: bigint;
  /** 赠送余额（虚拟） */
  bonusBalance: bigint;
  reserved: bigint;
  /** 可用 = balance + bonusBalance − reserved */
  available: bigint;
}

export interface UpdateJobProgressInput {
  jobId: string;
  status: string;
  stage?: string;
  detail?: unknown;
}

export interface JobProgressView {
  jobId: string;
  status: string;
  stage: string | null;
  detail: unknown;
}
