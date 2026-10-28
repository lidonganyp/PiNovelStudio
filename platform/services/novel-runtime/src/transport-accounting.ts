/** Runtime-only callbacks; request prompts and credentials never enter accounting payloads. */
import type { BillingClient } from './billing-client.js';
import type { MeteringResult } from './metering-binder.js';

export interface TransportReservation {
  callId: string; route: string; model: string; requestHash: string; inputTokenLimit: number; outputTokenLimit: number; recovery?: boolean;
}
export interface TransportSettlement { callId: string; tokensIn?: number; tokensOut?: number; status: number; }
export interface RuntimeTransportHooks {
  signal?: AbortSignal;
  reserve(input: TransportReservation): Promise<void>;
  settle(input: TransportSettlement): Promise<void>;
}
export type TransportHookRunner = <T>(hooks: RuntimeTransportHooks, fn: () => Promise<T>) => Promise<T>;
export interface TransportAccounting { hooks: RuntimeTransportHooks; summary(): MeteringResult; }

export function createTransportAccounting(client: BillingClient, jobId: string, maximumFen: number, signal: AbortSignal): TransportAccounting {
  const calls = new Map<string, { maximum: number; actual?: number; input?: number; output?: number }>();
  return {
    hooks: {
      signal,
      reserve: async (input): Promise<void> => {
        signal.throwIfAborted();
        if (!client.reserveTransport) throw new Error('transport budget callback is unavailable');
        const result = await client.reserveTransport({ ...input, jobId });
        calls.set(input.callId, { maximum: Number(result.maximumFen) });
      },
      settle: async (input): Promise<void> => {
        if (!client.settleTransport) throw new Error('transport usage callback is unavailable');
        const result = await client.settleTransport({ ...input, jobId });
        const call = calls.get(input.callId);
        if (!call) throw new Error('transport settlement has no admission');
        if (!result.unknownUsage) { call.actual = Number(result.actualChargeFen); call.input = input.tokensIn; call.output = input.tokensOut; }
      },
    },
    summary: (): MeteringResult => {
      const values = [...calls.values()];
      const charged = values.reduce((sum, c) => sum + (c.actual ?? 0), 0);
      const reserved = values.reduce((sum, c) => sum + (c.actual ?? c.maximum), 0);
      return { modelCallCount: values.length, inputTokens: values.reduce((sum, c) => sum + (c.input ?? 0), 0),
        outputTokens: values.reduce((sum, c) => sum + (c.output ?? 0), 0),
        settledCount: values.filter((c) => c.actual !== undefined).length, alreadySettledCount: 0,
        totalSettledAmountFen: charged, remainingBudgetFen: Math.max(0, maximumFen - reserved),
        budgetExhausted: false, budgetExhaustedCount: 0, settleErrors: values.flatMap((c, i) => c.actual === undefined
          ? [{ callId: `transport-${i}`, route: 'unknown_usage', error: 'Provider usage is unknown; maximum cost remains reserved for reconciliation' }] : []),
      };
    },
  };
}
