/**
 * ContextDeliveryLedger — CEG-4.2
 *
 * 只记录传递动作，不推断模型是否“理解”证据。
 */
import { createHash } from "node:crypto";
import type { ContextDeliveryAction } from "./evidence-governance-contracts.js";

export interface ContextDeliveryEvent {
  evidenceId: string;
  snapshotId: string;
  queryId: string | null;
  modelTurnId: string | null;
  action: ContextDeliveryAction;
  reason: string;
  sourceRef: string;
  contentHash: string;
  contextPackageHash: string | null;
  modelInputHash: string | null;
  tokenEstimate: number | null;
  recordedAt: string;
}

export function createContextDeliveryLedger(): {
  append: (event: Omit<ContextDeliveryEvent, "recordedAt">) => ContextDeliveryEvent;
  events: () => readonly ContextDeliveryEvent[];
} {
  const events: ContextDeliveryEvent[] = [];
  return {
    append(event) {
      const recorded: ContextDeliveryEvent = {
        ...event,
        recordedAt: new Date().toISOString(),
      };
      events.push(recorded);
      return recorded;
    },
    events: () => events,
  };
}

export function computeContentSha256(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}
