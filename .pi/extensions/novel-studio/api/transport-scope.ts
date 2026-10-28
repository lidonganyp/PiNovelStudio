/** Trusted runtime accounting surrounds every HTTP attempt, including transport retries. */
import { AsyncLocalStorage } from 'node:async_hooks';
export interface TransportReservationInput {
  callId: string; route: string; model: string; requestHash: string;
  inputTokenLimit: number; outputTokenLimit: number; recovery?: boolean;
}
export interface TransportSettlementInput { callId: string; tokensIn?: number; tokensOut?: number; status: number; }
export interface ModelTransportHooks {
  signal?: AbortSignal;
  reserve(input: TransportReservationInput): Promise<void>;
  settle(input: TransportSettlementInput): Promise<void>;
}
const hooks = new AsyncLocalStorage<ModelTransportHooks>();
const route = new AsyncLocalStorage<string>();
const recovery = new AsyncLocalStorage<boolean>();
export function runWithModelTransportHooks<T>(value: ModelTransportHooks, fn: () => T): T { return hooks.run(value, fn); }
export function runWithTransportRoute<T>(value: string, fn: () => T): T { return route.run(value, fn); }
export function runWithTransportRecovery<T>(value: boolean, fn: () => T): T { return recovery.run(value, fn); }
export function currentModelTransport(): { hooks?: ModelTransportHooks; route?: string; recovery?: boolean } { return { hooks: hooks.getStore(), route: route.getStore(), recovery: recovery.getStore() }; }
