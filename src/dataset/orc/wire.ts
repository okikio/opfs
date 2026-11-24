/**
 * Protocol Buffers wire reader for ORC metadata.
 *
 * ORC stores its footer and stripe footers as protobuf messages. The reader here
 * decodes varints, fixed fields and length-delimited fields, and a meter caps the
 * work each message may cost.
 *
 * @module
 */
import type { PolicyType } from "./types.ts";
import { toSafeInteger } from "../../archive/budget.ts";
import { ArchiveError, invalid, unsupported } from "../../archive/error.ts";

export function limit(label: string): never {
  throw new ArchiveError("budget-exceeded", `ORC ${label} limit exceeded.`);
}

/** Count wire and expanded work independently of returned bytes. No global parser or allocation state exists. */
export class Meter {
  readonly policy: PolicyType;
  readonly signal: AbortSignal | undefined;
  #steps = 0;
  #retained = 0;
  streams = 0;
  constructor(policy: PolicyType, signal?: AbortSignal) {
    this.policy = policy;
    this.signal = signal;
  }
  step(count = 1): void {
    this.signal?.throwIfAborted();
    if (count > this.policy.steps - this.#steps) limit("Parser/row work");
    this.#steps += count;
  }
  admitSteps(count: number): void {
    this.signal?.throwIfAborted();
    if (count > this.policy.steps - this.#steps) limit("Parser/row work");
  }
  retain(count: number): void {
    this.signal?.throwIfAborted();
    if (count > this.policy.retained - this.#retained) limit("Retained metadata");
    this.#retained += count;
  }
}

/** Exact bounded Protobuf wire cursor, not a generated object graph.
 * Scalars use last-one-wins. Interpreted nested messages here are repeated;
 * encryption message presence refuses immediately, so no singular message merge
 * is replaced with scalar semantics. Unknown messages are opaque length values.
 */
export class Wire {
  readonly bytes: Uint8Array;
  readonly meter: Meter;
  readonly depth: number;
  at = 0;
  constructor(bytes: Uint8Array, meter: Meter, depth = 0) {
    if (depth > meter.policy.depth) limit("Protobuf depth");
    meter.retain(64); // Admit the next bounded field dispatch set before its caller constructs it.
    this.bytes = bytes;
    this.meter = meter;
    this.depth = depth;
  }
  byte(): number {
    if (this.at >= this.bytes.length) throw invalid("ORC wire value is truncated.");
    return this.bytes[this.at++]!;
  }
  take(count: number): Uint8Array {
    if (count > this.bytes.length - this.at) throw invalid("ORC wire extent is truncated.");
    const result = this.bytes.subarray(this.at, this.at + count);
    this.at += count;
    return result;
  }
  uint(bits = 64): bigint {
    let value = 0n;
    for (let shift = 0; shift < bits; shift += 7) {
      this.meter.step();
      const byte = this.byte();
      value |= BigInt(byte & 127) << BigInt(shift);
      if (value >= (1n << BigInt(bits))) throw invalid("ORC varint exceeds its declared width.");
      if (byte < 128) return value;
    }
    throw invalid("ORC varint has no terminator within its declared width.");
  }
  type(actual: number, expected: number): void {
    if (actual !== expected) throw invalid("ORC Protobuf field wire type mismatch.");
  }
  number(type: number, bits = 64): number {
    this.type(type, 0);
    return toSafeInteger(this.uint(bits), `ORC ${"integer field"}`);
  }
  binary(type: number): Uint8Array {
    this.type(type, 2);
    return this.take(toSafeInteger(this.uint(), `ORC ${"binary length"}`));
  }
  message(type: number): Wire {
    return new Wire(this.binary(type), this.meter, this.depth + 1);
  }
  text(type: number): string {
    const bytes = this.binary(type);
    if (bytes.length > this.meter.policy.string) limit("String byte");
    this.meter.retain(bytes.length * 2);
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw invalid("ORC metadata string is not UTF-8.");
    }
  }
  fields(known: Readonly<Record<number, (type: number) => void>>): void {
    while (this.at < this.bytes.length) {
      this.meter.step();
      const tag = this.uint(32), id = Number(tag >> 3n), type = Number(tag & 7n);
      if (id === 0 || id > 0x1fffffff || type > 5) throw invalid("ORC Protobuf tag is invalid.");
      const read = Object.hasOwn(known, id) ? known[id] : undefined;
      if (read) read(type);
      else this.skip(type);
    }
  }
  skip(type: number): void {
    if (type === 0) this.uint();
    else if (type === 1) this.take(8);
    else if (type === 2) this.binary(type);
    else if (type === 5) this.take(4);
    else throw unsupported("ORC deprecated Protobuf groups are outside this profile.");
  }
  integers(type: number, target: number[], maximum: number): void {
    const append = (cursor: Wire): void => {
      if (target.length >= maximum) limit("Repeated integer count");
      cursor.meter.retain(8);
      target.push(toSafeInteger(cursor.uint(32), `ORC ${"repeated integer"}`));
    };
    if (type === 0) append(this);
    else {
      const cursor = this.message(type);
      while (cursor.at < cursor.bytes.length) append(cursor);
    }
  }
}
