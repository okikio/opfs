/** Finite byte-range admission shared by the direct object protocol clients. @module */
import { close } from "./close.ts";
import type { ObjectGetOptionsType } from "./driver/object.ts";

/** One operation owns range settings; it continues to borrow the actual caller signal. */
export interface RangeType {
  /** A zero-length read has no remote object acquisition or existence evidence. */
  readonly empty: boolean;
  /** Captured inclusive start and optional end for response admission. */
  readonly start: number;
  /** Captured inclusive end, or undefined for an open range to the end of the object. */
  readonly end: number | undefined;
  /** Inclusive HTTP byte range, or absence for a complete object. */
  readonly header: string | undefined;
  /** Captured caller authority; no credential/transport is acquired during admission. */
  readonly signal: AbortSignal | undefined;
}

/**
 * Selects the byte range one object read requests, before credentials or Fetch.
 *
 * Call it at the start of a provider's ranged read, then check the provider's answer against the same value:
 *
 * ```ts
 * const selected = resolveRange(options);
 * if (selected.empty) return new Blob().stream();
 * if (selected.header !== undefined) headers.set("range", selected.header);
 * const response = await fetch(url, { headers, signal: selected.signal });
 * await assertRangeResponse(response, selected);
 * ```
 *
 * Offsets must be complete safe integers. A requested length of zero returns an empty local stream, including
 * beyond EOF. Nonzero ranges retain the provider's ordinary status and EOF behavior. End arithmetic is checked
 * before addition; no rounding or clamping repairs an invalid input.
 */
export function resolveRange(options: ObjectGetOptionsType): RangeType {
  const signal = options.signal;
  if (signal?.aborted) throw signal.reason;
  const { at, length } = options;
  for (const value of [at, length]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new RangeError("Object range offsets and lengths must be nonnegative safe integers.");
    }
  }
  const start = at ?? 0;
  if (length !== undefined && length > 0 && length - 1 > Number.MAX_SAFE_INTEGER - start) {
    throw new RangeError("Object range end exceeds the safe integer boundary.");
  }
  if (signal?.aborted) throw signal.reason;
  return Object.freeze({
    empty: length === 0,
    start,
    end: length === undefined || length === 0 ? undefined : start + length - 1,
    header: length === 0 || (at === undefined && length === undefined)
      ? undefined
      : `bytes=${start}-${length === undefined ? "" : start + length - 1}`,
    signal,
  });
}

/**
 * Admit provider range evidence before handing its body to a caller. A proxy
 * that ignores Range must not silently substitute another extent. EOF may clamp
 * an inclusive end, but the provider must report a finite, consistent total.
 * A rejected response remains owned here and is cancelled, preserving failures.
 */
export async function assertRangeResponse(response: Response, selected: RangeType): Promise<Response> {
  try {
    const encoding = response.headers.get("content-encoding");
    if (encoding !== null && encoding.trim().toLowerCase() !== "identity") {
      throw new TypeError("Encoded object responses cannot preserve byte offsets.");
    }
    if (selected.header === undefined) {
      if (response.status !== 200) throw new TypeError("A complete object read requires HTTP 200.");
    } else {
      if (response.status !== 206) throw new TypeError("An object range requires HTTP 206.");
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("content-range") ?? "");
      if (match === null) throw new TypeError("An object range requires a finite Content-Range.");
      const start = Number(match[1]);
      const end = Number(match[2]);
      const total = Number(match[3]);
      if (
        ![start, end, total].every(Number.isSafeInteger) || start !== selected.start ||
        end < start || end >= total || end !== Math.min(selected.end ?? total - 1, total - 1)
      ) {
        throw new TypeError("Object Content-Range differs from the requested extent.");
      }
      const length = response.headers.get("content-length");
      if (length !== null && (!/^\d+$/.test(length) || Number(length) !== end - start + 1)) {
        throw new TypeError("Object Content-Length differs from Content-Range.");
      }
    }
    return response;
  } catch (reason) {
    await close(response.body === null ? [] : [() => response.body!.cancel(reason)], [reason]);
    throw reason;
  }
}
