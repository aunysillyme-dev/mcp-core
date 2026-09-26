import { redactUrl } from "./http.js";

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: unknown;
}

export interface Budget { maxBytes: number }

// Provisional until unit 1317-E measures representative production output.
export const DEFAULT_BUDGET: Readonly<Budget> = Object.freeze({ maxBytes: 32_768 });

const encoder = new TextEncoder();

function ceiling(budget: Budget): number {
  if (!Number.isSafeInteger(budget.maxBytes) || budget.maxBytes < 1) {
    throw new RangeError("maxBytes must be a positive safe integer");
  }
  return budget.maxBytes;
}

function serialized(data: unknown): string {
  const text = JSON.stringify(data, (_key, value: unknown) => {
    if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol" ||
      (typeof value === "number" && !Number.isFinite(value))) {
      throw new TypeError("Tool results require JSON values without omitted or non-finite fields");
    }
    return value;
  });
  if (text === undefined) throw new TypeError("Tool results require a JSON value");
  return text;
}

function envelope(body: unknown, isError = false): ToolResult {
  const text = serialized(body);
  // Snapshot the data so later caller mutations cannot invalidate the measured budget.
  const result: ToolResult = { content: [{ type: "text", text }], structuredContent: JSON.parse(text) as unknown };
  if (isError) result.isError = true;
  return result;
}

function size(result: ToolResult): number { return encoder.encode(JSON.stringify(result)).byteLength; }

/**
 * The constructors below enforce the budget on what they build. A consumer that
 * assembles a ToolResult by hand (for example, several content parts) must check
 * it here, because nothing else measures a hand-built result.
 */
export function withinBudget(result: ToolResult, budget: Budget = DEFAULT_BUDGET): boolean {
  return size(result) <= ceiling(budget);
}

export function assertWithinBudget(result: ToolResult, budget: Budget = DEFAULT_BUDGET): ToolResult {
  const bytes = size(result);
  const maxBytes = ceiling(budget);
  if (bytes > maxBytes) throw new RangeError(`Tool result of ${bytes} bytes exceeds budget of ${maxBytes} bytes`);
  return result;
}

function fitPrefix(length: number, make: (count: number) => ToolResult, maxBytes: number): ToolResult {
  if (size(make(0)) > maxBytes) throw new RangeError("Budget cannot hold the truncation envelope and cursor");
  let low = 0;
  let high = length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (size(make(middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  if (length > 0 && low === 0) throw new RangeError("Budget cannot hold the first record; paginate or reduce record size");
  return make(low);
}

/**
 * Cursors are local offsets, not upstream API tokens. Resume against the same
 * immutable ordered input: offset counts array records, property counts object
 * keys in Object.entries order, and scalar counts Unicode code points.
 */
export function ok(data: unknown, budget: Budget = DEFAULT_BUDGET): ToolResult {
  const maxBytes = ceiling(budget);
  const snapshot = JSON.parse(serialized(data)) as unknown;
  const full = envelope({ data: snapshot });
  if (size(full) <= maxBytes) return full;
  if (Array.isArray(snapshot)) {
    return fitPrefix(snapshot.length, count => envelope({ data: snapshot.slice(0, count), truncated: true, cursor: `offset:${count}` }), maxBytes);
  }
  if (snapshot !== null && typeof snapshot === "object") {
    const entries = Object.entries(snapshot);
    return fitPrefix(entries.length, count => envelope({ data: Object.fromEntries(entries.slice(0, count)), truncated: true, cursor: `property:${count}` }), maxBytes);
  }
  if (typeof snapshot === "string") {
    const characters = Array.from(snapshot);
    return fitPrefix(characters.length, count => envelope({ data: characters.slice(0, count).join(""), truncated: true, cursor: `scalar:${count}` }), maxBytes);
  }
  throw new RangeError("Budget cannot hold this scalar result; paginate larger records before formatting");
}

/** Complete text stays plain text; truncated text becomes a JSON text/cursor envelope. */
export function okText(text: string, budget: Budget = DEFAULT_BUDGET): ToolResult {
  const maxBytes = ceiling(budget);
  const full: ToolResult = { content: [{ type: "text", text }] };
  if (size(full) <= maxBytes) return full;
  const characters = Array.from(text);
  return fitPrefix(characters.length, count => envelope({ text: characters.slice(0, count).join(""), truncated: true, cursor: `text:${count}` }), maxBytes);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Tool operation failed";
}

function redactUrls(message: string): string {
  return message.replace(/https?:\/\/[^\s<>"']+/gi, redactUrl);
}

export function fail(err: unknown, opts: { redactUrls?: boolean } = {}): ToolResult {
  const message = opts.redactUrls === false ? errorMessage(err) : redactUrls(errorMessage(err));
  const full = envelope({ error: message }, true);
  if (size(full) <= DEFAULT_BUDGET.maxBytes) return full;
  const characters = Array.from(message);
  return fitPrefix(characters.length, count => envelope({ error: characters.slice(0, count).join(""), truncated: true, cursor: `error:${count}` }, true), DEFAULT_BUDGET.maxBytes);
}

export function absent(what: string): ToolResult { return fail(`${what} was not found`); }

/** Preserve resource IDs and the entire recovery instruction, or fail explicitly. */
export function partial(data: unknown, resume: { cursor?: string; next_action?: string }): ToolResult {
  if (!(typeof resume.cursor === "string" && resume.cursor.trim()) &&
    !(typeof resume.next_action === "string" && resume.next_action.trim())) {
    throw new TypeError("Partial results require a non-empty resume cursor or next_action");
  }
  const body: Record<string, unknown> = { data, partial: true };
  if (resume.cursor !== undefined) body.cursor = resume.cursor;
  if (resume.next_action !== undefined) body.next_action = resume.next_action;
  const result = envelope(body);
  if (size(result) > DEFAULT_BUDGET.maxBytes) {
    throw new RangeError("Partial result exceeds budget: preserve resource IDs and resume data in a smaller payload");
  }
  return result;
}

export async function run(fn: () => Promise<unknown>, budget: Budget = DEFAULT_BUDGET): Promise<ToolResult> {
  ceiling(budget);
  try { return ok(await fn(), budget); }
  catch (err) {
    const failure = fail(err);
    if (size(failure) <= budget.maxBytes) return failure;
    const message = redactUrls(errorMessage(err));
    const characters = Array.from(message);
    return fitPrefix(characters.length, count => envelope({ error: characters.slice(0, count).join(""), truncated: true, cursor: `error:${count}` }, true), budget.maxBytes);
  }
}

/** next_cursor identifies the last returned row, for APIs using exclusive after-cursors. */
export function clampPage<T>(rows: T[], limit: number, cursorOf: (row: T) => string): { rows: T[]; next_cursor?: string; complete: boolean } {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("Page limit must be a positive safe integer");
  const page = rows.slice(0, limit);
  if (rows.length <= limit) return { rows: page, complete: true };
  const cursor = cursorOf(page[page.length - 1]!);
  if (typeof cursor !== "string" || cursor.length === 0) throw new TypeError("A truncated page needs a non-empty cursor");
  return { rows: page, next_cursor: cursor, complete: false };
}

export interface BoundedInteger {
  readonly jsonSchema: Readonly<{ type: "integer"; minimum: number; maximum: number; default: number }>;
  parse(value: unknown): number;
  safeParse(value: unknown): { success: true; data: number } | { success: false; error: RangeError };
}

/** Dependency-free integer validator and JSON Schema, not a Zod schema. No coercion. */
export function boundedInt(min: number, max: number, dflt: number): BoundedInteger {
  if (![min, max, dflt].every(Number.isSafeInteger) || min > max || dflt < min || dflt > max) {
    throw new RangeError("Integer bounds and default must be safe integers with min <= default <= max");
  }
  const parse = (value: unknown): number => {
    if (value === undefined) return dflt;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
      throw new RangeError(`Expected an integer from ${min} to ${max}`);
    }
    return value;
  };
  return Object.freeze({
    jsonSchema: Object.freeze({ type: "integer" as const, minimum: min, maximum: max, default: dflt }),
    parse,
    safeParse(value: unknown) {
      try { return { success: true as const, data: parse(value) }; }
      catch (err) { return { success: false as const, error: err as RangeError }; }
    },
  });
}
