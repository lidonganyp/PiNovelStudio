/**
 * Shared normalization helpers for read-only methodology diagnostic state.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export function recordValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

export function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

export function stringArray(value: unknown, limit: number): string[] {
  return Array.isArray(value)
    ? uniqueStrings(value.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim())))
        .slice(0, limit)
    : [];
}

export function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function encodeRefComponent(value: string): string {
  return value
    .replaceAll("%", "%25")
    .replaceAll("#", "%23")
    .replaceAll(":", "%3A")
    .replaceAll("|", "%7C")
    .replaceAll("/", "%2F");
}

export function clampInteger(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

export function isDefined<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}
