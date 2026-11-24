/**
 * 7-Zip header decoding: folders, coders, pack and substream sizes, and file
 * entries.
 *
 * @module
 */
import { add, Admission, Cursor } from "./cursor.ts";
import type { SevenCoderType } from "./types.ts";
import { invalid, unsupported } from "../error.ts";

export interface StreamType {
  size: number;
  crc: number | undefined;
  origin: "substream" | "folder";
}

export interface FolderType {
  coders: SevenCoderType[];
  output: number;
  size: number;
  crc: number | undefined;
  streams: StreamType[];
}

/** Linear one-input/one-output graphs are fully connected and acyclic, not merely count-compatible. */
export function folder(cursor: Cursor, admission: Admission): FolderType {
  const count = cursor.number();
  admission.coders(count);
  if (count === 0) throw invalid("7z folders require a coder.");
  const coders: SevenCoderType[] = [];
  for (let id = 0; id < count; id++) {
    const flags = cursor.byte();
    const idSize = flags & 15;
    if ((flags & 0xc0) !== 0 || idSize === 0 || idSize > 8) {
      throw unsupported("7z coder identifier/alternative form is unsupported.");
    }
    const methodBytes = cursor.take(idSize);
    if (flags & 0x10) {
      if (cursor.number() !== 1 || cursor.number() !== 1) {
        throw unsupported("7z complex/multi-input coder graphs are unsupported.");
      }
    }
    const properties = flags & 0x20 ? cursor.take(cursor.number()) : new Uint8Array();
    admission.copies((methodBytes.length + properties.length) * 4); // Two hex chars, up to two logical bytes per char.
    const hex = (bytes: Uint8Array): string => {
      let result = "";
      for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
      return result;
    };
    coders.push(Object.freeze({ method: hex(methodBytes), properties: hex(properties) }));
  }
  const inputs = new Set<number>();
  const outputs = new Set<number>();
  const edges = new Map<number, number>();
  for (let index = 0; index < count - 1; index++) {
    const input = cursor.number();
    const output = cursor.number();
    if (input >= count || output >= count || inputs.has(input) || outputs.has(output)) {
      throw invalid("7z coder bindings are invalid or repeated.");
    }
    inputs.add(input);
    outputs.add(output);
    edges.set(output, input);
  }
  let first = -1;
  let last = -1;
  for (let index = 0; index < count; index++) {
    if (!inputs.has(index)) first = index;
    if (!outputs.has(index)) last = index;
  }
  const visited = new Set<number>();
  let current: number | undefined = first;
  while (current !== undefined) {
    if (visited.has(current)) throw invalid("7z coder graph contains a cycle.");
    visited.add(current);
    const next = edges.get(current);
    if (next === undefined && current !== last) throw invalid("7z coder graph has an invalid final output.");
    current = next;
  }
  if (visited.size !== count) throw invalid("7z coder graph is disconnected.");
  return { coders, output: last, size: 0, crc: undefined, streams: [] };
}

/** Read a supported StreamsInfo without acquiring or decoding a packed payload. */
export function streams(
  cursor: Cursor,
  admission: Admission,
): { position: number; sizes: number[]; crcs: (number | undefined)[]; folders: FolderType[] } {
  cursor.expect(6);
  const position = cursor.number();
  const count = cursor.number();
  admission.streams(count);
  cursor.expect(9);
  const sizes = Array.from({ length: count }, () => cursor.number());
  let tag = cursor.number();
  let crcs: (number | undefined)[] = Array.from({ length: count }, () => undefined);
  if (tag === 10) {
    crcs = cursor.digests(count);
    tag = cursor.number();
  }
  if (tag !== 0) throw unsupported("7z packed stream metadata is unsupported.");
  cursor.expect(7);
  cursor.expect(11);
  const foldersCount = cursor.number();
  admission.count(foldersCount, admission.max.folders);
  if (cursor.byte() !== 0) throw unsupported("7z external folder metadata is unsupported.");
  const folders = Array.from({ length: foldersCount }, () => folder(cursor, admission));
  if (foldersCount !== count) throw unsupported("7z profile requires one packed stream per linear folder.");
  cursor.expect(12);
  for (const item of folders) {
    const unpacked = item.coders.map(() => cursor.number());
    item.size = unpacked[item.output]!;
  }
  tag = cursor.number();
  if (tag === 10) {
    const values = cursor.digests(foldersCount);
    folders.forEach((item, index) => {
      item.crc = values[index];
    });
    tag = cursor.number();
  }
  if (tag !== 0) throw unsupported("7z folder unpack metadata is unsupported.");
  tag = cursor.number();
  let counts = folders.map(() => 1);
  if (tag === 8) {
    tag = cursor.number();
    if (tag === 13) {
      counts = folders.map(() => cursor.number());
      tag = cursor.number();
    }
    let total = 0;
    for (const value of counts) total = add(total, value);
    admission.streams(total);
    const needsSizes = counts.some((value) => value > 1);
    if (needsSizes && tag !== 9) throw invalid("7z multi-substream sizes are missing.");
    for (let index = 0; index < folders.length; index++) {
      const item = folders[index]!;
      const count = counts[index]!;
      if (count === 0) throw unsupported("7z zero-substream folders are unsupported.");
      let used = 0;
      for (let stream = 0; stream < count; stream++) {
        const size = stream === count - 1 ? item.size - used : cursor.number();
        if (size < 0 || size > item.size - used) throw invalid("7z substreams exceed the folder extent.");
        used = add(used, size);
        item.streams.push({
          size,
          crc: count === 1 ? item.crc : undefined,
          origin: count === 1 && item.crc !== undefined ? "folder" : "substream",
        });
      }
    }
    if (tag === 9) tag = cursor.number();
    const missing = folders.reduce(
      (sum, item) => add(sum, item.streams.length === 1 && item.crc !== undefined ? 0 : item.streams.length),
      0,
    );
    if (tag === 10) {
      const digests = cursor.digests(missing);
      let at = 0;
      for (const item of folders) {
        if (!(item.streams.length === 1 && item.crc !== undefined)) {
          for (const stream of item.streams) stream.crc = digests[at++];
        }
      }
      tag = cursor.number();
    }
    if (tag !== 0) throw unsupported("7z substream metadata is unsupported.");
    cursor.expect(0);
  } else {
    if (tag !== 0) throw unsupported("7z stream metadata is unsupported.");
    admission.streams(folders.length);
    for (const item of folders) {
      item.streams.push({ size: item.size, crc: item.crc, origin: item.crc === undefined ? "substream" : "folder" });
    }
  }
  return { position, sizes, crcs, folders };
}

/** Inline file properties never resolve additional streams or host metadata. */
export function files(
  cursor: Cursor,
  admission: Admission,
): {
  names: string[];
  empty: boolean[];
  emptyFile: boolean[];
  anti: boolean[];
  attributes: (number | undefined)[];
  mtime: (bigint | undefined)[];
} {
  const count = cursor.number();
  admission.count(count, admission.max.entries);
  const properties = new Map<number, Uint8Array>();
  while (true) {
    const id = cursor.number();
    if (id === 0) break;
    admission.property();
    if (id === 25) {
      const padding = cursor.take(cursor.number());
      if (padding.some((byte) => byte !== 0)) throw invalid("7z Dummy padding contains nonzero bytes.");
      continue;
    }
    if (properties.has(id)) throw invalid("7z file property is duplicated.");
    if (![14, 15, 16, 17, 18, 19, 20, 21, 22, 25].includes(id)) {
      throw unsupported("7z file property semantics are unsupported.");
    }
    properties.set(id, cursor.take(cursor.number()));
  }
  const bits = (id: number, length: number): boolean[] => {
    const value = properties.get(id);
    if (!value) return Array.from({ length }, () => false);
    const field = new Cursor(value);
    const result = field.bits(length);
    field.end();
    return result;
  };
  const empty = bits(14, count);
  const emptyCount = empty.filter(Boolean).length;
  const emptyFile = bits(15, emptyCount);
  const anti = bits(16, emptyCount);
  const names: string[] = [];
  const encoded = properties.get(17);
  if (count > 0 && !encoded) throw unsupported("7z names must be present inline for this profile.");
  if (encoded) {
    const field = new Cursor(encoded);
    if (field.byte() !== 0) throw unsupported("7z external filename streams are unsupported.");
    for (let id = 0; id < count; id++) {
      const raw = field.name(admission.max.name);
      if (raw.length === 0) throw unsupported("7z empty names are unsupported.");
      admission.copies(raw.length);
      try {
        names.push(new TextDecoder("utf-16le", { fatal: true, ignoreBOM: true }).decode(raw));
      } catch {
        throw unsupported("7z filename contains invalid UTF-16.");
      }
    }
    field.end();
  }
  let attributes: (number | undefined)[] = Array.from({ length: count }, () => undefined);
  let mtime: (bigint | undefined)[] = Array.from({ length: count }, () => undefined);
  for (const id of [18, 19, 20, 21]) {
    const value = properties.get(id);
    if (!value) continue;
    const field = new Cursor(value);
    const defined = field.defined(count);
    if (field.byte() !== 0) throw unsupported("7z external attribute/time streams are unsupported.");
    if (id === 21) attributes = defined.map((present) => present ? field.u32() : undefined);
    else {
      const values = defined.map((present) => present ? field.u64() : undefined);
      if (id === 20) mtime = values;
    }
    field.end();
  }
  return { names, empty, emptyFile, anti, attributes, mtime };
}
