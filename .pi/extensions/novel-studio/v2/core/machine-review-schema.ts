/**
 * MachineReviewSchema - anonymous packet, local review, and three-slot aggregate.
 *
 * This module validates evidence against an anonymous packet. Its aggregate is
 * advisory-only and cannot produce a person-authored decision or final winner.
 */

export const ANONYMOUS_REVIEW_PACKET_SCHEMA_ID =
  "pinovel.anonymous-review-packet" as const;
export const ANONYMOUS_REVIEW_PACKET_SCHEMA_VERSION = "v1" as const;
export const ANONYMOUS_REVIEW_PACKET_SCHEMA_FULL_ID =
  `${ANONYMOUS_REVIEW_PACKET_SCHEMA_ID}/${ANONYMOUS_REVIEW_PACKET_SCHEMA_VERSION}` as const;

export type AnonymousOptionLabel = "A" | "B";

export interface AnonymousReviewOption {
  label: AnonymousOptionLabel;
  text: string;
}

export interface AnonymousReviewPacketV1 {
  schemaId: typeof ANONYMOUS_REVIEW_PACKET_SCHEMA_ID;
  schemaVersion: typeof ANONYMOUS_REVIEW_PACKET_SCHEMA_VERSION;
  packetId: string;
  options: [AnonymousReviewOption, AnonymousReviewOption];
}

export interface AnonymousReviewValidationError {
  code: string;
  path: string;
  message: string;
}

export type AnonymousReviewPacketValidationResult =
  | { ok: true; value: AnonymousReviewPacketV1; errors: [] }
  | { ok: false; errors: AnonymousReviewValidationError[] };

export const MACHINE_REVIEW_SCHEMA_ID = "pinovel.machine-review" as const;
export const MACHINE_REVIEW_SCHEMA_VERSION = "v1" as const;
export const MACHINE_REVIEW_SCHEMA_FULL_ID =
  `${MACHINE_REVIEW_SCHEMA_ID}/${MACHINE_REVIEW_SCHEMA_VERSION}` as const;

export const MACHINE_REVIEW_SLOTS = [1, 2, 3] as const;

export type MachineReviewSlot = (typeof MACHINE_REVIEW_SLOTS)[number];
export type MachineReviewPreference = "A" | "B" | "TIE" | "ABSTAIN";
export type MachineReviewAggregateStatus =
  | "TRIAGE_ONLY"
  | "HOLD_FOR_HUMAN_CONFIRMATION";

export interface MachineReviewSpan {
  option: AnonymousOptionLabel;
  start: number;
  end: number;
  quote: string;
}

export interface MachineReviewV1 {
  schemaId: typeof MACHINE_REVIEW_SCHEMA_ID;
  schemaVersion: typeof MACHINE_REVIEW_SCHEMA_VERSION;
  packetId: string;
  slot: MachineReviewSlot;
  preference: MachineReviewPreference;
  rationale: string;
  spans: MachineReviewSpan[];
}

export interface MachineReviewValidationError {
  code: string;
  path: string;
  message: string;
}

export type MachineReviewValidationResult =
  | { ok: true; value: MachineReviewV1; errors: [] }
  | { ok: false; errors: MachineReviewValidationError[] };

export interface MachineReviewCounts {
  A: number;
  B: number;
  TIE: number;
  ABSTAIN: number;
}

export interface MachineReviewAggregate {
  status: MachineReviewAggregateStatus;
  suggestedPreference: Exclude<MachineReviewPreference, "ABSTAIN"> | null;
  counts: MachineReviewCounts;
  errors: MachineReviewValidationError[];
}

type UnknownObject = Record<string, unknown>;

const PACKET_KEYS = new Set(["schemaId", "schemaVersion", "packetId", "options"]);
const OPTION_KEYS = new Set(["label", "text"]);
const REVIEW_KEYS = new Set([
  "schemaId",
  "schemaVersion",
  "packetId",
  "slot",
  "preference",
  "rationale",
  "spans",
]);
const SPAN_KEYS = new Set(["option", "start", "end", "quote"]);
const PREFERENCES = new Set<MachineReviewPreference>(["A", "B", "TIE", "ABSTAIN"]);

function isObject(value: unknown): value is UnknownObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function addPacketUnknownKeyErrors(
  value: UnknownObject,
  allowed: ReadonlySet<string>,
  path: string,
  errors: AnonymousReviewValidationError[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      errors.push({
        code: "unknown_key",
        path: path ? `${path}.${key}` : key,
        message: `Unknown key is not allowed: ${key}`,
      });
    }
  }
}

/** Validate and sanitize a pinovel.anonymous-review-packet/v1 value. */
export function validateAnonymousReviewPacket(
  input: unknown,
): AnonymousReviewPacketValidationResult {
  const errors: AnonymousReviewValidationError[] = [];
  if (!isObject(input)) {
    return {
      ok: false,
      errors: [{ code: "invalid_packet", path: "", message: "Packet must be an object" }],
    };
  }

  addPacketUnknownKeyErrors(input, PACKET_KEYS, "", errors);
  if (
    input.schemaId !== ANONYMOUS_REVIEW_PACKET_SCHEMA_ID ||
    input.schemaVersion !== ANONYMOUS_REVIEW_PACKET_SCHEMA_VERSION
  ) {
    errors.push({
      code: "schema_mismatch",
      path: "schemaId/schemaVersion",
      message: `Packet schema must be ${ANONYMOUS_REVIEW_PACKET_SCHEMA_FULL_ID}`,
    });
  }
  if (!isNonEmptyString(input.packetId)) {
    errors.push({
      code: "invalid_string",
      path: "packetId",
      message: "packetId must be a non-empty string",
    });
  }

  const options = input.options;
  const optionShapeIsValid =
    Array.isArray(options) &&
    options.length === 2 &&
    isObject(options[0]) &&
    isObject(options[1]) &&
    options[0].label === "A" &&
    options[1].label === "B";
  if (!optionShapeIsValid) {
    errors.push({
      code: "invalid_options",
      path: "options",
      message: "options must contain exactly one ordered A option and one ordered B option",
    });
  }
  if (Array.isArray(options)) {
    for (let index = 0; index < options.length; index += 1) {
      const option = options[index];
      if (!isObject(option)) {
        continue;
      }
      addPacketUnknownKeyErrors(option, OPTION_KEYS, `options[${index}]`, errors);
      if (!isNonEmptyString(option.text)) {
        errors.push({
          code: "invalid_string",
          path: `options[${index}].text`,
          message: "Option text must be a non-empty string",
        });
      }
    }
  }
  if (errors.length > 0 || !optionShapeIsValid) {
    return { ok: false, errors };
  }

  const first = options[0] as UnknownObject;
  const second = options[1] as UnknownObject;
  return {
    ok: true,
    errors: [],
    value: {
      schemaId: ANONYMOUS_REVIEW_PACKET_SCHEMA_ID,
      schemaVersion: ANONYMOUS_REVIEW_PACKET_SCHEMA_VERSION,
      packetId: input.packetId as string,
      options: [
        { label: "A", text: first.text as string },
        { label: "B", text: second.text as string },
      ],
    },
  };
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

function isSlot(value: unknown): value is MachineReviewSlot {
  return isFiniteInteger(value) && MACHINE_REVIEW_SLOTS.includes(value as MachineReviewSlot);
}

function addUnknownKeyErrors(
  value: UnknownObject,
  allowed: ReadonlySet<string>,
  path: string,
  errors: MachineReviewValidationError[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      errors.push({
        code: "unknown_key",
        path: path ? `${path}.${key}` : key,
        message: `Unknown key is not allowed: ${key}`,
      });
    }
  }
}

function packetErrors(
  errors: AnonymousReviewValidationError[],
): MachineReviewValidationError[] {
  return errors.map((error) => ({
    code: "invalid_packet",
    path: error.path ? `packet.${error.path}` : "packet",
    message: error.message,
  }));
}

function validateSpan(
  input: unknown,
  index: number,
  packet: AnonymousReviewPacketV1,
  errors: MachineReviewValidationError[],
): MachineReviewSpan | null {
  const path = `spans[${index}]`;
  if (!isObject(input)) {
    errors.push({ code: "invalid_span", path, message: "Span must be an object" });
    return null;
  }

  addUnknownKeyErrors(input, SPAN_KEYS, path, errors);

  const option = input.option;
  const start = input.start;
  const end = input.end;
  const quote = input.quote;
  const optionIsValid = option === "A" || option === "B";
  const offsetsAreIntegers = isFiniteInteger(start) && isFiniteInteger(end);
  let boundsAreValid = false;

  if (!optionIsValid || !offsetsAreIntegers) {
    errors.push({
      code: "invalid_span",
      path,
      message: "Span option and offsets are invalid",
    });
  } else {
    const optionText = option === "A" ? packet.options[0].text : packet.options[1].text;
    boundsAreValid = start >= 0 && end > start && end <= optionText.length;
    if (!boundsAreValid) {
      errors.push({
        code: "invalid_span",
        path,
        message: "Span must be non-empty and within the selected option text",
      });
    } else if (typeof quote !== "string" || quote !== optionText.slice(start, end)) {
      errors.push({
        code: "quote_mismatch",
        path: `${path}.quote`,
        message: "Span quote must exactly match the selected option text slice",
      });
    }
  }

  if (!optionIsValid || !offsetsAreIntegers || !boundsAreValid || typeof quote !== "string") {
    return null;
  }
  const optionText = option === "A" ? packet.options[0].text : packet.options[1].text;
  if (quote !== optionText.slice(start, end)) {
    return null;
  }
  return { option, start, end, quote };
}

/** Validate one isolated review slot against its anonymous packet. */
export function validateMachineReview(
  input: unknown,
  packetInput: unknown,
): MachineReviewValidationResult {
  const packetResult = validateAnonymousReviewPacket(packetInput);
  if (!packetResult.ok) {
    return { ok: false, errors: packetErrors(packetResult.errors) };
  }
  const packet = packetResult.value;
  const errors: MachineReviewValidationError[] = [];

  if (!isObject(input)) {
    return {
      ok: false,
      errors: [{ code: "invalid_review", path: "", message: "Review must be an object" }],
    };
  }

  addUnknownKeyErrors(input, REVIEW_KEYS, "", errors);

  if (
    input.schemaId !== MACHINE_REVIEW_SCHEMA_ID ||
    input.schemaVersion !== MACHINE_REVIEW_SCHEMA_VERSION
  ) {
    errors.push({
      code: "schema_mismatch",
      path: "schemaId/schemaVersion",
      message: `Review schema must be ${MACHINE_REVIEW_SCHEMA_FULL_ID}`,
    });
  }
  if (!isNonEmptyString(input.packetId)) {
    errors.push({
      code: "invalid_string",
      path: "packetId",
      message: "packetId must be a non-empty string",
    });
  } else if (input.packetId !== packet.packetId) {
    errors.push({
      code: "packet_mismatch",
      path: "packetId",
      message: "Review packetId does not match the packet under review",
    });
  }
  if (!isSlot(input.slot)) {
    errors.push({
      code: "invalid_slot",
      path: "slot",
      message: "slot must be one of the fixed protocol slots: 1, 2, or 3",
    });
  }
  if (!PREFERENCES.has(input.preference as MachineReviewPreference)) {
    errors.push({
      code: "invalid_preference",
      path: "preference",
      message: "preference must be A, B, TIE, or ABSTAIN",
    });
  }
  if (!isNonEmptyString(input.rationale)) {
    errors.push({
      code: "invalid_string",
      path: "rationale",
      message: "rationale must be a non-empty string",
    });
  }

  const spans: MachineReviewSpan[] = [];
  if (!Array.isArray(input.spans)) {
    errors.push({ code: "invalid_span", path: "spans", message: "spans must be an array" });
  } else {
    for (let index = 0; index < input.spans.length; index += 1) {
      const span = validateSpan(input.spans[index], index, packet, errors);
      if (span !== null) {
        spans.push(span);
      }
    }
  }

  if (input.preference === "ABSTAIN" && Array.isArray(input.spans) && input.spans.length > 0) {
    errors.push({
      code: "unexpected_evidence",
      path: "spans",
      message: "ABSTAIN must not carry evidence spans",
    });
  } else if (
    input.preference !== "ABSTAIN" &&
    PREFERENCES.has(input.preference as MachineReviewPreference) &&
    Array.isArray(input.spans) &&
    input.spans.length === 0
  ) {
    errors.push({
      code: "missing_evidence",
      path: "spans",
      message: "A non-abstaining preference requires at least one evidence span",
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    errors: [],
    value: {
      schemaId: MACHINE_REVIEW_SCHEMA_ID,
      schemaVersion: MACHINE_REVIEW_SCHEMA_VERSION,
      packetId: input.packetId as string,
      slot: input.slot as MachineReviewSlot,
      preference: input.preference as MachineReviewPreference,
      rationale: input.rationale as string,
      spans,
    },
  };
}

function emptyCounts(): MachineReviewCounts {
  return { A: 0, B: 0, TIE: 0, ABSTAIN: 0 };
}

function triage(
  counts: MachineReviewCounts,
  errors: MachineReviewValidationError[],
): MachineReviewAggregate {
  return {
    status: "TRIAGE_ONLY",
    suggestedPreference: null,
    counts,
    errors,
  };
}

function holdForHumanConfirmation(
  counts: MachineReviewCounts,
  suggestedPreference: "A" | "B",
): MachineReviewAggregate {
  return {
    status: "HOLD_FOR_HUMAN_CONFIRMATION",
    suggestedPreference,
    counts,
    errors: [],
  };
}

/** Aggregate exactly three independently supplied protocol slots. */
export function aggregateMachineReviews(
  packet: unknown,
  inputs: readonly unknown[],
): MachineReviewAggregate {
  const errors: MachineReviewValidationError[] = [];
  const reviews: MachineReviewV1[] = [];

  if (inputs.length !== MACHINE_REVIEW_SLOTS.length) {
    errors.push({
      code: "review_count",
      path: "reviews",
      message: "Exactly three review inputs are required",
    });
  }

  for (let index = 0; index < inputs.length; index += 1) {
    const result = validateMachineReview(inputs[index], packet);
    if (result.ok) {
      reviews.push(result.value);
    } else {
      errors.push(...result.errors.map((error) => ({
        ...error,
        path: error.path ? `reviews[${index}].${error.path}` : `reviews[${index}]`,
      })));
    }
  }

  const slots = new Set(reviews.map((review) => review.slot));
  const hasExactSlotSet =
    reviews.length === MACHINE_REVIEW_SLOTS.length &&
    slots.size === MACHINE_REVIEW_SLOTS.length &&
    MACHINE_REVIEW_SLOTS.every((slot) => slots.has(slot));
  if (reviews.length === MACHINE_REVIEW_SLOTS.length && !hasExactSlotSet) {
    errors.push({
      code: "invalid_slot_set",
      path: "reviews[].slot",
      message: "Review inputs must contain each fixed slot exactly once",
    });
  }

  const counts = emptyCounts();
  for (const review of reviews) {
    counts[review.preference] += 1;
  }

  if (reviews.some((review) => review.preference === "ABSTAIN")) {
    errors.push({
      code: "abstained_review",
      path: "reviews[].preference",
      message: "An abstaining slot requires later confirmation",
    });
  }

  if (errors.length > 0 || !hasExactSlotSet) {
    return triage(counts, errors);
  }

  if (counts.A >= 2) {
    return holdForHumanConfirmation(counts, "A");
  }
  if (counts.B >= 2) {
    return holdForHumanConfirmation(counts, "B");
  }

  const code = counts.TIE >= 2 ? "review_tie" : "review_disagreement";
  return triage(counts, [{
    code,
    path: "reviews[].preference",
    message: "The three slots do not provide a confirmable A/B majority",
  }]);
}
