/**
 * Thrift compact protocol reader for Parquet metadata.
 *
 * Parquet stores its footer and page headers in Thrift's compact encoding. The
 * reader here decodes only the field types Parquet uses, and a meter caps the
 * work each structure may cost.
 *
 * @module
 */
import type { PolicyType } from "./types.ts";
import { toSafeInteger } from "../../archive/budget.ts";
import { ArchiveError, invalid } from "../../archive/error.ts";

/** This private EOF distinguishes bounded lookahead from malformed non-EOF grammar. */
export class NeedMore extends Error {}

/** Operation-owned counters also bound skipped metadata and repeated header parsing. */
export class Meter {
  #compact = 0;
  #retained = 0;
  readonly policy: PolicyType;
  readonly signal: AbortSignal | undefined;
  constructor(policy: PolicyType, signal?: AbortSignal) {
    this.policy = policy;
    this.signal = signal;
  }
  step(count = 1): void {
    this.signal?.throwIfAborted();
    if (count > this.policy.compact - this.#compact) limit("Compact work");
    this.#compact += count;
  }
  retain(count: number): void {
    if (count > this.policy.retained - this.#retained) limit("Retained metadata");
    this.#retained += count;
  }
}

export function limit(label: string): never {
  throw new ArchiveError("budget-exceeded", `Parquet ${label} limit exceeded.`);
}

/** Struct callbacks retain only fields this profile needs; unknown fields still receive complete bounded validation. */
export class Compact {
  readonly bytes: Uint8Array;
  readonly meter: Meter;
  at = 0;
  #depth = 0;
  constructor(bytes: Uint8Array, meter: Meter) {
    this.bytes = bytes;
    this.meter = meter;
  }
  byte(): number {
    if (this.at === this.bytes.length) throw new NeedMore();
    return this.bytes[this.at++]!;
  }
  take(length: number): Uint8Array {
    if (length > this.bytes.length - this.at) throw new NeedMore();
    const bytes = this.bytes.subarray(this.at, this.at + length);
    this.at += length;
    return bytes;
  }
  uint(bits = 32): bigint {
    let value = 0n;
    for (let shift = 0; shift < bits; shift += 7) {
      this.meter.step();
      const byte = this.byte();
      value |= BigInt(byte & 127) << BigInt(shift);
      if (value >= 1n << BigInt(bits)) throw invalid("Parquet Compact integer exceeds its declared width.");
      if (byte < 128) return value;
    }
    throw invalid("Parquet Compact varint has no terminator within its width.");
  }
  signed(bits: number): bigint {
    const value = this.uint(bits);
    return (value >> 1n) ^ -(value & 1n);
  }
  type(actual: number, expected: number): void {
    if (actual !== expected) throw invalid("Parquet Compact field type mismatch.");
  }
  number(type: number, bits = 32): number {
    this.type(type, bits === 64 ? 6 : bits === 16 ? 4 : 5);
    return toSafeInteger(this.signed(bits), `Parquet ${"integer field"}`);
  }
  bool(type: number): boolean {
    if (type !== 1 && type !== 2) throw invalid("Parquet Compact boolean field type mismatch.");
    return type === 1;
  }
  text(type: number, retain = true): string {
    this.type(type, 8);
    const length = Number(this.uint());
    if (length > 0x7fffffff) throw invalid("Parquet Compact binary length exceeds signed int32.");
    if (length > this.meter.policy.string) limit("String byte");
    if (retain) this.meter.retain(length * 2);
    const bytes = this.take(length);
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw invalid("Parquet metadata string is not UTF-8.");
    }
  }
  nest<T>(body: () => T): T {
    if (++this.#depth > this.meter.policy.depth) limit("Compact depth");
    try {
      return body();
    } finally {
      this.#depth--;
    }
  }
  fields(known: Readonly<Record<number, (type: number) => void>>, observe?: () => void): void {
    this.nest(() => {
      let previous = 0;
      const seen = new Set<number>();
      for (;;) {
        this.meter.step();
        const header = this.byte();
        if (header === 0) return;
        const type = header & 15;
        if (type === 0 || type > 13) throw invalid("Parquet Compact field type is invalid.");
        const delta = header >>> 4;
        const id = delta === 0 ? Number(this.signed(16)) : previous + delta;
        if (id < -32768 || id > 32767 || seen.has(id)) {
          throw invalid("Parquet Compact field ID is invalid or repeated.");
        }
        this.meter.retain(16);
        seen.add(id);
        observe?.();
        previous = id;
        const read = Object.hasOwn(known, id) ? known[id] : undefined;
        if (read) read(type);
        else this.skip(type, true);
      }
    });
  }
  list<T>(type: number, element: number, maximum: number, read: () => T): T[] {
    this.type(type, 9);
    return this.nest(() => {
      const header = this.byte(), tag = header & 15;
      const count = header >>> 4 === 15 ? Number(this.uint()) : header >>> 4;
      if (count > 0x7fffffff) throw invalid("Parquet Compact list size exceeds signed int32.");
      if (tag !== element) throw invalid("Parquet Compact list element type mismatch.");
      if (count > maximum) limit("Collection count");
      this.meter.step(count);
      const output: T[] = [];
      for (let i = 0; i < count; i++) output.push(read());
      return output;
    });
  }
  /** Unknown values are skipped without constructing attacker-selected object graphs. */
  skip(type: number, field = false): void {
    this.meter.step();
    if (type === 1 || type === 2) {
      if (!field) {
        const value = this.byte();
        if (value !== 1 && value !== 2) throw invalid("Parquet Compact collection boolean is invalid.");
      }
    } else if (type === 3) this.take(1);
    else if (type >= 4 && type <= 6) this.signed(type === 4 ? 16 : type === 5 ? 32 : 64);
    else if (type === 7) this.take(8);
    else if (type === 8) {
      const count = Number(this.uint());
      if (count > 0x7fffffff) throw invalid("Parquet Compact binary length exceeds signed int32.");
      if (count > this.meter.policy.string) limit("String byte");
      this.take(count);
    } else if (type === 9 || type === 10) {
      this.nest(() => {
        const header = this.byte(), element = header & 15;
        const count = header >>> 4 === 15 ? Number(this.uint()) : header >>> 4;
        if (count > 0x7fffffff || element < 1 || element > 13) {
          throw invalid("Parquet Compact unknown collection is invalid.");
        }
        this.meter.step(count);
        for (let i = 0; i < count; i++) this.skip(element);
      });
    } else if (type === 11) {
      this.nest(() => {
        const count = Number(this.uint());
        if (count > 0x7fffffff) throw invalid("Parquet Compact map size exceeds signed int32.");
        this.meter.step(count * 2);
        if (count !== 0) {
          const header = this.byte(), key = header >>> 4, value = header & 15;
          if (key < 1 || key > 13 || value < 1 || value > 13) throw invalid("Parquet Compact map type is invalid.");
          for (let i = 0; i < count; i++) {
            this.skip(key);
            this.skip(value);
          }
        }
      });
    } else if (type === 12) this.fields({});
    else if (type === 13) this.take(16);
    else throw invalid("Parquet Compact value type is invalid.");
  }
}
