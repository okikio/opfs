/**
 * ORC footer decoding: column types, stripes, streams and column encodings.
 *
 * @module
 */
import { limit, Wire } from "./wire.ts";
import type { OrcStripeType } from "./types.ts";
import { unsupported } from "../../archive/error.ts";

export interface TypeType {
  kind: number;
  children: number[];
  names: string[];
}

export interface StripeType {
  offset: number;
  index: number;
  data: number;
  footer: number;
  rows: number;
}

export interface StreamType {
  kind: number;
  column: number;
  length: number;
  offset: number;
}

export interface SelectedType {
  stripe: OrcStripeType;
  present?: StreamType;
  data?: StreamType;
  stored: number;
}

/** Retain only the flat schema fields this reader interprets; unknown binary annotations remain opaque. */
export function type(cursor: Wire): TypeType {
  cursor.meter.retain(96);
  let kind = 0;
  const children: number[] = [], names: string[] = [];
  cursor.fields({
    1: (t) => {
      kind = cursor.number(t, 32);
    },
    2: (t) => {
      cursor.integers(t, children, cursor.meter.policy.columns);
    },
    3: (t) => {
      if (names.length >= cursor.meter.policy.columns) limit("Field name count");
      cursor.meter.retain(16);
      names.push(cursor.text(t));
    },
  });
  return { kind, children, names };
}

/** Capture declared physical geometry; encryption presence refuses before any later instance can hide it. */
export function stripe(cursor: Wire): StripeType {
  cursor.meter.retain(96);
  let offset = 0, index = 0, data = 0, footer = 0, rows = 0;
  cursor.fields({
    1: (t) => {
      offset = cursor.number(t);
    },
    2: (t) => {
      index = cursor.number(t);
    },
    3: (t) => {
      data = cursor.number(t);
    },
    4: (t) => {
      footer = cursor.number(t);
    },
    5: (t) => {
      rows = cursor.number(t);
    },
    6: () => {
      throw unsupported("ORC encryption stripe IDs are outside this profile.");
    },
    7: () => {
      throw unsupported("ORC encrypted local keys are unsupported.");
    },
  });
  return { offset, index, data, footer, rows };
}

/** Physical stream lengths receive an offset only after their complete stripe section is checked. */
export function stream(cursor: Wire): Omit<StreamType, "offset"> {
  cursor.meter.retain(64);
  let kind = 0, column = 0, length = 0;
  cursor.fields({
    1: (t) => {
      kind = cursor.number(t, 32);
    },
    2: (t) => {
      column = cursor.number(t, 32);
    },
    3: (t) => {
      length = cursor.number(t);
    },
  });
  if (kind === 9 || kind === 10 || kind >= 100) {
    throw unsupported("ORC encrypted/statistics virtual streams are unsupported.");
  }
  if (kind > 8) throw unsupported("ORC stream kind is unsupported.");
  return { kind, column, length };
}

/** The encoding kind is a scalar; duplicate instances inside this message use Protobuf last-wins. */
export function encoding(cursor: Wire): number {
  cursor.meter.retain(16);
  let kind = 0;
  cursor.fields({
    1: (t) => {
      kind = cursor.number(t, 32);
    },
  });
  return kind;
}
