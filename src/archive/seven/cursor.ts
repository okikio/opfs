/**
 * Byte cursor and work admission for 7-Zip header decoding.
 *
 * The cursor reads 7-Zip's variable-length numbers and fixed fields from one
 * header buffer. Admission charges each decoded structure against the archive
 * limits before the decoder allocates for it.
 *
 * @module
 */
import type { SevenOpenOptionsType } from "./types.ts";
import { assertInteger, toSafeInteger } from "../budget.ts";
import { ArchiveError, invalid, unsupported } from "../error.ts";
import { createView } from "../field.ts";
import { crc32 } from "../../hash.ts";

export function add(left: number, right: number): number {
  return toSafeInteger(BigInt(left) + BigInt(right), "7z integer");
}

export function checksum(bytes: Uint8Array): number {
  return (crc32(bytes) ^ 0xffffffff) >>> 0;
}

/** Counts bound materialized records; string copies share the header-byte admission owner. */
export class Admission {
  readonly max: {
    header: number;
    entries: number;
    folders: number;
    coders: number;
    streams: number;
    properties: number;
    name: number;
  };
  #copies = 0;
  #coders = 0;
  #streams = 0;
  #properties = 0;
  constructor(options: SevenOpenOptionsType) {
    this.max = {
      header: options.maxHeaderBytes ?? 8 * 1024 * 1024,
      entries: options.maxEntries ?? 100000,
      folders: options.maxFolders ?? 4096,
      coders: options.maxCoders ?? 4096,
      streams: options.maxStreams ?? 100000,
      properties: options.maxProperties ?? 100000,
      name: options.maxNameBytes ?? 65536,
    };
    for (const [name, value] of Object.entries(this.max)) assertInteger(value, name);
  }
  count(value: number, maximum: number): void {
    if (value > maximum) throw new ArchiveError("budget-exceeded", "7z metadata admission limit exceeded.");
  }
  copies(value: number): void {
    this.count(value, this.max.header - this.#copies);
    this.#copies += value;
  }
  coders(value: number): void {
    this.count(value, this.max.coders - this.#coders);
    this.#coders += value;
  }
  streams(value: number): void {
    this.count(value, this.max.streams - this.#streams);
    this.#streams += value;
  }
  property(): void {
    this.count(1, this.max.properties - this.#properties);
    this.#properties++;
  }
}

/** Every property gets an extent-limited cursor. Underflow and unconsumed bytes cannot bleed into its neighbor. */
export class Cursor {
  readonly #bytes: Uint8Array;
  #at = 0;
  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }
  get remaining(): number {
    return this.#bytes.length - this.#at;
  }
  byte(): number {
    return this.take(1)[0]!;
  }
  take(size: number): Uint8Array {
    assertInteger(size, "7z property size");
    if (size > this.remaining) throw invalid("7z metadata extent is truncated.");
    const result = this.#bytes.subarray(this.#at, this.#at + size);
    this.#at += size;
    return result;
  }
  name(maximum: number): Uint8Array {
    const start = this.#at;
    while (true) {
      if (this.#at - start + 2 > maximum) throw new ArchiveError("budget-exceeded", "7z filename limit exceeded.");
      const unit = this.take(2);
      if (unit[0] === 0 && unit[1] === 0) return this.#bytes.subarray(start, this.#at - 2);
    }
  }
  number(): number {
    const first = this.byte();
    let mask = 128;
    let result = 0n;
    for (let index = 0; index < 8; index++) {
      if ((first & mask) === 0) {
        return toSafeInteger(result + (BigInt(first & (mask - 1)) << BigInt(index * 8)), "7z integer");
      }
      result += BigInt(this.byte()) << BigInt(index * 8);
      mask >>= 1;
    }
    return toSafeInteger(result, "7z integer");
  }
  u32(): number {
    return createView(this.take(4)).getUint32(0, true);
  }
  u64(): bigint {
    return createView(this.take(8)).getBigUint64(0, true);
  }
  expect(id: number): void {
    if (this.number() !== id) throw unsupported("7z metadata form or property order is unsupported.");
  }
  end(): void {
    if (this.remaining !== 0) throw invalid("7z property has unconsumed bytes.");
  }
  bits(count: number): boolean[] {
    const raw = this.take(Math.ceil(count / 8));
    if (count % 8 && (raw[raw.length - 1]! & ((1 << (8 - count % 8)) - 1)) !== 0) {
      throw invalid("7z bit-vector padding must be zero.");
    }
    return Array.from({ length: count }, (_, index) => (raw[index >> 3]! & (128 >> (index & 7))) !== 0);
  }
  defined(count: number): boolean[] {
    const all = this.byte();
    if (all > 1) throw invalid("7z all-defined flag must be zero or one.");
    return all ? Array.from({ length: count }, () => true) : this.bits(count);
  }
  digests(count: number): (number | undefined)[] {
    return this.defined(count).map((defined) => defined ? this.u32() : undefined);
  }
}
