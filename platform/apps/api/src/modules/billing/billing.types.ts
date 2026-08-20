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
}

export interface SettleCallResult {
  jobId: string;
  callId: string;
  alreadySettled: boolean;
  actualCharge: bigint;
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
  balance: bigint;
  reserved: bigint;
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
