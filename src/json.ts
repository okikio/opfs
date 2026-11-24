/**
 * Bounded JSON parsing for responses from remote services.
 *
 * `JSON.parse` has no limits: a hostile or broken server can send deep
 * nesting, huge strings or millions of values, and the whole text is built
 * into objects before any check runs. {@link parseJson} walks the text once,
 * refuses it as soon as one limit is passed, and builds objects without a
 * prototype, so keys such as `__proto__` cannot reach `Object.prototype`.
 *
 * Fourteen provider clients used to carry their own copy of this lexer with
 * slightly different limits. They now call this one with their own limits.
 *
 * @module
 */

/** Limits and number handling for one {@link parseJson} call. */
export interface JsonLimitsType {
  /** Service name used in error messages, such as `CMIS` or `Yandex Disk`. */
  readonly label: string;
  /** Largest text, in UTF-16 code units. No limit when absent. */
  readonly maxLength?: number;
  /** Values plus object keys. Default 100,000. */
  readonly maxTokens?: number;
  /** Nesting depth of objects and arrays. Default 32. */
  readonly maxDepth?: number;
  /** Longest string, in code units, counted from its opening quote. Default 65,536. */
  readonly maxString?: number;
  /** Longest number or literal (`true`, `false`, `null`). Default 128. */
  readonly maxScalar?: number;
  /**
   * Converts one number. `raw` already matches the JSON number grammar.
   * Return `undefined` to refuse it. Default {@link readSafeInteger}.
   */
  readonly number?: (raw: string) => unknown;
}

/**
 * Accepts an integer that fits a JavaScript number exactly and is not `-0`.
 *
 * Most storage APIs send sizes, offsets and counts this way; a fraction or a
 * value above 2^53 - 1 would silently lose precision.
 */
export function readSafeInteger(raw: string): number | undefined {
  if (!/^-?(0|[1-9][0-9]*)$/.test(raw) || raw === "-0") return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

/** Accepts any finite number, but an integer only when it fits exactly. */
export function readFiniteNumber(raw: string): number | undefined {
  const value = Number(raw);
  if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) return undefined;
  return value;
}

/** Keys that would reach a prototype if they were assigned on an ordinary object. */
const reserved = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Parses JSON text within fixed limits.
 *
 * Objects come back with a `null` prototype and duplicate keys are refused.
 * A malformed or over-limit text throws a `TypeError` that names the service
 * but never quotes the text, because a response can carry signed URLs or
 * tokens. A text longer than `maxLength` throws a `RangeError` before any
 * parsing.
 *
 * @example Read a listing from a storage API.
 * ```ts
 * const body = parseJson(await response.text(), { label: "Seafile", maxLength: 8 * 1024 * 1024 });
 * ```
 *
 * @example Keep numbers as strings, for exact decimal fields.
 * ```ts
 * const body = parseJson(text, { label: "pCloud", number: (raw) => raw });
 * ```
 */
export function parseJson(text: string, limits: JsonLimitsType): unknown {
  const label = limits.label;
  if (limits.maxLength !== undefined && text.length > limits.maxLength) {
    throw new RangeError(`${label} JSON exceeds its lexical budget.`);
  }
  const maxTokens = limits.maxTokens ?? 100_000;
  const maxDepth = limits.maxDepth ?? 32;
  const maxString = limits.maxString ?? 65_536;
  const maxScalar = limits.maxScalar ?? 128;
  const number = limits.number ?? readSafeInteger;
  let at = 0;
  let tokens = 0;
  const fail = (): never => {
    throw new TypeError(`Malformed or over-budget ${label} JSON.`);
  };
  const space = (): void => {
    while (/[ \t\r\n]/.test(text[at] ?? "x")) at++;
  };
  const count = (): void => {
    if (++tokens > maxTokens) fail();
  };
  function string(): string {
    const start = at++;
    while (at < text.length) {
      if (at - start > maxString) fail();
      const char = text[at++];
      if (char === "\\") {
        at++;
        continue;
      }
      if (char === '"') {
        let value: unknown;
        // JSON.parse's SyntaxError would quote the string, which can hold a signed URL.
        try {
          value = JSON.parse(text.slice(start, at));
        } catch {
          return fail();
        }
        if (typeof value !== "string") fail();
        return value as string;
      }
    }
    return fail();
  }
  function value(depth: number): unknown {
    count();
    if (depth > maxDepth) fail();
    space();
    if (text[at] === '"') return string();
    if (text[at] === "{") {
      at++;
      space();
      const object: Record<string, unknown> = Object.create(null);
      if (text[at] === "}") {
        at++;
        return object;
      }
      while (true) {
        count();
        space();
        if (text[at] !== '"') fail();
        const key = string();
        if (reserved.has(key) || Object.hasOwn(object, key)) fail();
        space();
        if (text[at++] !== ":") fail();
        object[key] = value(depth + 1);
        space();
        const end = text[at++];
        if (end === "}") return object;
        if (end !== ",") fail();
      }
    }
    if (text[at] === "[") {
      at++;
      space();
      const array: unknown[] = [];
      if (text[at] === "]") {
        at++;
        return array;
      }
      while (true) {
        array.push(value(depth + 1));
        space();
        const end = text[at++];
        if (end === "]") return array;
        if (end !== ",") fail();
      }
    }
    const start = at;
    while (at < text.length && !/[ \t\r\n,}\]]/.test(text[at]!)) {
      if (at - start >= maxScalar) fail();
      at++;
    }
    const raw = text.slice(start, at);
    if (raw === "true") return true;
    if (raw === "false") return false;
    if (raw === "null") return null;
    if (!/^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(raw)) return fail();
    const result = number(raw);
    return result === undefined ? fail() : result;
  }
  const result = value(0);
  space();
  if (at !== text.length) fail();
  return result;
}
