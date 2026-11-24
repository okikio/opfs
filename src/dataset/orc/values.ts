/**
 * ORC value decoding.
 *
 * These readers decode byte run-length, boolean bit and signed integer
 * run-length version 1 streams, and size the typed array for each column kind.
 *
 * @module
 */
import { Meter, Wire } from "./wire.ts";
import type { OrcValuesType } from "./types.ts";
import { invalid, unsupported } from "../../archive/error.ts";

export function width(kind: number): number {
  return kind === 0 || kind === 1
    ? 1
    : kind === 2
    ? 2
    : kind === 3 || kind === 5
    ? 4
    : kind === 4 || kind === 6
    ? 8
    : 0;
}

export function values(kind: number, count: number): OrcValuesType {
  if (kind === 0) return new Uint8Array(count);
  if (kind === 1) return new Int8Array(count);
  if (kind === 2) return new Int16Array(count);
  if (kind === 3) return new Int32Array(count);
  if (kind === 4) return new BigInt64Array(count);
  if (kind === 5) return new Float32Array(count);
  if (kind === 6) return new Float64Array(count);
  throw unsupported("ORC column is outside the physical numeric profile.");
}

/** Byte RLE expands at most 130 bytes per run; its terminal check rejects hidden extra runs. */
export class Bytes {
  readonly cursor: Wire;
  #remaining = 0;
  #repeat: number | undefined;
  constructor(bytes: Uint8Array, meter: Meter) {
    this.cursor = new Wire(bytes, meter);
  }
  next(): number {
    this.cursor.meter.step();
    if (this.#remaining === 0) {
      const control = this.cursor.byte();
      this.#remaining = control < 128 ? control + 3 : 256 - control;
      this.#repeat = control < 128 ? this.cursor.byte() : undefined;
    }
    this.#remaining--;
    return this.#repeat ?? this.cursor.byte();
  }
  end(): void {
    if (this.#remaining !== 0 || this.cursor.at !== this.cursor.bytes.length) {
      throw invalid("ORC byte RLE has excess values or trailing runs.");
    }
  }
}

/** Boolean RLE packs most-significant bits first; only the last byte's unused bits are ignored. */
export class Bits {
  readonly bytes: Bytes;
  #byte = 0;
  #bit = 8;
  constructor(bytes: Uint8Array, meter: Meter) {
    this.bytes = new Bytes(bytes, meter);
  }
  next(): boolean {
    this.bytes.cursor.meter.step();
    if (this.#bit === 8) {
      this.#byte = this.bytes.next();
      this.#bit = 0;
    }
    return ((this.#byte >>> (7 - this.#bit++)) & 1) === 1;
  }
  end(): void {
    this.bytes.end();
  }
}

/** Integer RLEv1 uses exact bigint delta arithmetic, then checks the declared signed leaf width. */
export class Integers {
  readonly cursor: Wire;
  #remaining = 0;
  #value = 0n;
  #delta: bigint | undefined;
  constructor(bytes: Uint8Array, meter: Meter) {
    this.cursor = new Wire(bytes, meter);
  }
  next(): bigint {
    this.cursor.meter.step();
    const signed = (): bigint => {
      const value = this.cursor.uint();
      return (value >> 1n) ^ -(value & 1n);
    };
    if (this.#remaining === 0) {
      const control = this.cursor.byte();
      if (control < 128) {
        this.#remaining = control + 3;
        const delta = this.cursor.byte();
        this.#delta = BigInt(delta < 128 ? delta : delta - 256);
        this.#value = signed();
      } else {
        this.#remaining = 256 - control;
        this.#delta = undefined;
      }
    }
    this.#remaining--;
    if (this.#delta === undefined) return signed();
    const value = this.#value;
    this.#value += this.#delta;
    return value;
  }
  end(): void {
    if (this.#remaining !== 0 || this.cursor.at !== this.cursor.bytes.length) {
      throw invalid("ORC integer RLE has excess values or trailing runs.");
    }
  }
}
