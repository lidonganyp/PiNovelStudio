/**
 * Ceiling validation runtime isolation helpers.
 *
 * A provider failure in one historical case must not turn later independent
 * cases into synthetic circuit-breaker failures.
 */

import {
  clearChapterTimeoutCounts,
  clearUnhealthyProviders,
} from "../api/fallback-manager.js";

export function prepareIsolatedCeilingCase(): void {
  clearUnhealthyProviders();
  clearChapterTimeoutCounts();
}

export type CeilingArmId = "A" | "B" | "C";

export function parseCeilingArmIds(args: readonly string[]): CeilingArmId[] {
  const index = args.indexOf("--arms");
  if (index === -1) return ["A", "B", "C"];
  const raw = args[index + 1] ?? "";
  const values = raw.split(",").map((value) => value.trim()).filter(Boolean);
  if (values.some((value) => value !== "A" && value !== "B" && value !== "C")) {
    throw new Error("--arms accepts only A,B,C");
  }
  const unique = [...new Set(values)] as CeilingArmId[];
  if (!unique.includes("A") || !unique.includes("B")) {
    throw new Error("--arms must include A and B");
  }
  return ["A", "B", "C"].filter((value): value is CeilingArmId => unique.includes(value as CeilingArmId));
}

export interface BoundedCeilingOperationInput<T> {
  maxAttempts: number;
  operation: (attempt: number) => Promise<T>;
}

export async function runBoundedCeilingOperation<T>(
  input: BoundedCeilingOperationInput<T>,
): Promise<T> {
  if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > 3) {
    throw new Error("maxAttempts must be an integer from 1 to 3");
  }
  let lastError: unknown = new Error("bounded operation was not attempted");
  for (let attempt = 1; attempt <= input.maxAttempts; attempt += 1) {
    try {
      return await input.operation(attempt);
    } catch (error: unknown) {
      lastError = error;
    }
  }
  throw lastError;
}
