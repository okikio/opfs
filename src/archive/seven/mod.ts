/** Bounded 7z indexing with COPY and single-stream LZMA reads. @module */
import { codec, codecPolicy, decode } from "./decode.ts";
import { files, streams, type StreamType } from "./header.ts";
import { add, Admission, checksum, Cursor } from "./cursor.ts";
import type {
  SevenArchiveType,
  SevenCheckType,
  SevenEntryType,
  SevenFolderType,
  SevenOpenOptionsType,
  SevenPackType,
  SevenReadOptionsType,
  SevenReadType,
} from "./types.ts";
import { ArchiveBudget, assertInteger, createArchiveLedger, toSafeInteger } from "../budget.ts";
import type { ByteSourceType } from "../../source.ts";
import { ArchiveError, invalid, unsupported } from "../error.ts";
import { createView } from "../field.ts";
import type { ArchiveLedgerType } from "../budget.ts";
import { crc32 } from "../../hash.ts";
export { ArchiveError } from "../error.ts";
export { createArchiveLedger } from "../budget.ts";
export type { ArchiveErrorCodeType } from "../error.ts";
export type { ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "../budget.ts";

/** Index plain or bounded single-coder encoded headers; mandatory metadata CRCs remain separate from member checks. */
export async function openSeven(
  source: ByteSourceType,
  supplied: SevenOpenOptionsType = {},
): Promise<SevenArchiveType> {
  const options = { ...supplied, lzma: codecPolicy(supplied.lzma) };
  const { size, identity, stability } = source;
  if (stability !== undefined && !["immutable", "provider", "caller"].includes(stability)) {
    throw new TypeError("Unknown 7z source stability.");
  }
  if (identity !== undefined && (typeof identity !== "string" || identity.length > 8192)) {
    throw new TypeError("7z source identity must be a bounded string.");
  }
  if (!stability && !options.allowUnverifiedSource) {
    throw unsupported("7z requires source stability or explicit unverified-source acceptance.");
  }
  const admission = new Admission(options);
  admission.copies(32);
  const snapshot: ByteSourceType = {
    size,
    ...(identity === undefined ? {} : { identity: identity }),
    ...(stability === undefined ? {} : { stability: stability }),
    read: source.read.bind(source),
  };
  const local = createArchiveLedger(options);
  const openingLedger = options.ledger;
  const lifetime: ArchiveLedgerType = {
    reserve(kind, count) {
      local.reserve(kind, count);
      openingLedger?.reserve(kind, count);
    },
    inspect: () => local.inspect(),
  };
  const budget = new ArchiveBudget(snapshot, { ...options, ledger: lifetime }, options.signal);
  const signature = await budget.read(0, 32);
  budget.decoded(32);
  const start = createView(signature);
  if (![55, 122, 188, 175, 39, 28].every((byte, index) => signature[index] === byte)) {
    throw invalid("7z signature must begin at source offset zero.");
  }
  if (signature[6] !== 0 || signature[7] !== 4) throw unsupported("Only 7z archive version 0.4 is supported.");
  if (checksum(signature.subarray(12, 32)) !== start.getUint32(8, true)) {
    throw new ArchiveError("checksum-mismatch", "7z start-header CRC mismatch.");
  }
  const headerAt = add(32, toSafeInteger(start.getBigUint64(12, true), "7z integer"));
  const headerSize = toSafeInteger(start.getBigUint64(20, true), "7z integer");
  if (headerAt > snapshot.size || headerSize !== snapshot.size - headerAt) {
    throw invalid("7z next header must fit and end at the full source extent.");
  }
  admission.copies(headerSize);
  let bytes = await budget.read(headerAt, headerSize);
  budget.decoded(headerSize);
  if (checksum(bytes) !== start.getUint32(28, true)) {
    throw new ArchiveError("checksum-mismatch", "7z next-header CRC mismatch.");
  }
  let payloadEnd = headerAt;
  let decodedHeader: SevenArchiveType["headers"]["decoded"];
  if (headerSize > 0 && bytes[0] === 23) {
    const encoded = new Cursor(bytes);
    encoded.expect(23);
    const data = streams(encoded, admission);
    encoded.end();
    if (data.folders.length !== 1 || data.sizes.length !== 1) {
      throw unsupported("7z encoded header requires one folder/pack.");
    }
    const item = data.folders[0]!;
    if (item.coders.length !== 1 || item.streams.length !== 1 || !codec(item.coders[0]!)) {
      throw unsupported("7z encoded header requires one supported LZMA coder/substream.");
    }
    const offset = add(32, data.position);
    const size = data.sizes[0]!;
    if (offset > headerAt || size !== headerAt - offset) {
      throw invalid("7z encoded header pack must end at its outer header.");
    }
    const checks: { scope: SevenCheckType["scope"]; crc: number }[] = [];
    if (data.crcs[0] !== undefined) checks.push({ scope: "pack", crc: data.crcs[0]! });
    if (item.crc !== undefined) checks.push({ scope: "folder", crc: item.crc });
    if (item.streams[0]!.crc !== undefined && item.streams[0]!.origin !== "folder") {
      checks.push({ scope: "substream", crc: item.streams[0]!.crc! });
    }
    if (!checks.some((check) => check.scope !== "pack")) throw unsupported("7z encoded header requires a decoded CRC.");
    admission.copies(add(size, item.size));
    // Reserve the retained decoded header before allocation, including aggregate admission.
    // The relay consumes this credit, then charges any additional LZMA2 framing work once.
    budget.decoded(item.size);
    const result = await decode(
      snapshot,
      { id: 0, offset, size },
      item.coders[0]!,
      item.size,
      0,
      item.size,
      true,
      budget,
      options.lzma,
      options.signal,
      false,
      item.size,
    );
    for (const check of checks) {
      if (check.crc !== (check.scope === "pack" ? result.packed : result.plain)) {
        throw new ArchiveError("checksum-mismatch", "7z encoded header CRC mismatch.");
      }
    }
    bytes = result.bytes;
    if (bytes[0] !== 1) throw unsupported("7z decoded header must be one unencoded Header.");
    decodedHeader = Object.freeze({
      method: item.coders[0]!.method,
      integrity: "crc32-verified",
      checks: Object.freeze(checks.map((check) => Object.freeze({ ...check, status: "crc32-verified" as const }))),
    });
    payloadEnd = offset;
  }
  const packs: SevenPackType[] = [];
  const publicFolders: SevenFolderType[] = [];
  const entries: SevenEntryType[] = [];
  if (headerSize > 0) {
    const cursor = new Cursor(bytes);
    const marker = cursor.number();
    if (marker === 23) throw unsupported("7z recursively encoded headers are unsupported.");
    if (marker !== 1) throw unsupported("7z next-header profile is unsupported.");
    let tag = cursor.number();
    if (tag === 2) {
      while (true) {
        const id = cursor.number();
        if (id === 0) break;
        admission.property();
        cursor.take(cursor.number());
      }
      tag = cursor.number();
    }
    if (tag === 3) throw unsupported("7z additional/external metadata streams are unsupported.");
    let streamData: ReturnType<typeof streams> = { position: 0, sizes: [], crcs: [], folders: [] };
    if (tag === 4) {
      streamData = streams(cursor, admission);
      tag = cursor.number();
    }
    if (tag !== 5) throw unsupported("7z files metadata is required for this profile.");
    const info = files(cursor, admission);
    cursor.expect(0);
    cursor.end();
    let physical = add(32, streamData.position);
    if (physical > payloadEnd) throw invalid("7z pack base exceeds the payload region.");
    for (let id = 0; id < streamData.sizes.length; id++) {
      const size = streamData.sizes[id]!;
      if (physical > payloadEnd || size > payloadEnd - physical) {
        throw invalid("7z packed stream exceeds the pre-header payload region.");
      }
      const crc = streamData.crcs[id];
      packs.push(Object.freeze({ id, offset: physical, size, ...(crc === undefined ? {} : { crc }) }));
      physical = add(physical, size);
    }
    for (let id = 0; id < streamData.folders.length; id++) {
      const item = streamData.folders[id]!;
      const pack = packs[id]!;
      const copy = item.coders.length === 1 && item.coders[0]!.method === "00" && item.coders[0]!.properties === "";
      if (copy && item.size !== pack.size) throw invalid("7z COPY folder has different packed and unpacked sizes.");
      const compressed = item.coders.length === 1 && codec(item.coders[0]!) !== undefined;
      const known = item.coders.every((coder) => ["00", "21", "030101", "040108", "040202"].includes(coder.method));
      const encrypted = item.coders.some((coder) => coder.method === "06f10701") ? true : known ? false : "unknown";
      publicFolders.push(
        Object.freeze({
          id,
          coders: Object.freeze(item.coders),
          size: item.size,
          packId: id,
          substreams: item.streams.length,
          solid: item.streams.length > 1,
          encrypted,
          readable: (copy || compressed) && item.streams.length === 1,
          ...(item.crc === undefined ? {} : { crc: item.crc }),
        }),
      );
    }
    const substreams: { folder: number; offset: number; stream: StreamType }[] = [];
    streamData.folders.forEach((item, folder) => {
      let offset = 0;
      for (const stream of item.streams) {
        substreams.push({ folder, offset, stream });
        offset = add(offset, stream.size);
      }
    });
    let streamIndex = 0;
    let emptyIndex = 0;
    for (let id = 0; id < info.names.length; id++) {
      const attributes = info.attributes[id];
      const mtime = info.mtime[id];
      const isEmpty = info.empty[id]!;
      const emptyFile = isEmpty ? info.emptyFile[emptyIndex]! : false;
      const anti = isEmpty ? info.anti[emptyIndex++]! : false;
      const substream = isEmpty ? undefined : substreams[streamIndex++];
      if (!isEmpty && !substream) throw invalid("7z file count exceeds available substreams.");
      let kind: SevenEntryType["kind"] = anti ? "anti" : isEmpty && !emptyFile ? "directory" : "file";
      if (attributes !== undefined) {
        const mode = (attributes >>> 16) & 0xf000;
        if (attributes & 0x400) kind = "special";
        else if (attributes & 0x8000) {
          if (mode === 0xa000) kind = "symbolic-link";
          else if (mode !== 0 && mode !== 0x8000 && mode !== 0x4000) kind = "special";
        }
      }
      entries.push(
        Object.freeze({
          id,
          name: info.names[id]!,
          kind,
          size: substream?.stream.size ?? 0,
          readable: kind === "file" && (!substream || publicFolders[substream.folder]!.readable),
          ...(substream === undefined ? {} : { folderId: substream.folder, folderOffset: substream.offset }),
          ...(substream?.stream.crc === undefined
            ? {}
            : { crc: substream.stream.crc, crcSource: substream.stream.origin }),
          ...(attributes === undefined ? {} : { attributes }),
          ...(mtime === undefined ? {} : { mtime }),
        }),
      );
    }
    if (streamIndex !== substreams.length) throw invalid("7z substreams remain without file records.");
  } else if (headerAt !== 32) throw unsupported("7z empty header with preceding packed data is unsupported.");
  return Object.freeze({
    entries: Object.freeze(entries),
    folders: Object.freeze(publicFolders),
    packs: Object.freeze(packs),
    headers: Object.freeze({
      start: "crc32-verified",
      next: "crc32-verified",
      ...(decodedHeader === undefined ? {} : { decoded: decodedHeader }),
    }),
    work: budget.inspect(),
    source: Object.freeze({
      ...(snapshot.identity === undefined ? {} : { identity: snapshot.identity }),
      stability: snapshot.stability ?? "unverified",
    }),
    async read(id: number, readOptions: SevenReadOptionsType = {}): Promise<SevenReadType> {
      const active = options.signal && readOptions.signal
        ? AbortSignal.any([options.signal, readOptions.signal])
        : options.signal ?? readOptions.signal;
      const extra = readOptions.ledger;
      const ledger: ArchiveLedgerType = {
        reserve(kind, count) {
          lifetime.reserve(kind, count);
          if (extra && extra !== openingLedger) extra.reserve(kind, count);
        },
        inspect: () => lifetime.inspect(),
      };
      readOptions = { ...readOptions, ledger, ...(active === undefined ? {} : { signal: active }) };
      assertInteger(id, "Entry ID");
      const entry = entries[id];
      if (!entry) throw new RangeError("7z entry ID does not exist.");
      if (!entry.readable || entry.kind !== "file") {
        throw unsupported("7z payload requires a regular supported single-substream file or an empty file.");
      }
      const offset = readOptions.offset ?? 0;
      const length = readOptions.length ?? entry.size - offset;
      assertInteger(offset, "Member offset");
      assertInteger(length, "Member length");
      if (offset > entry.size || length > entry.size - offset) {
        throw new RangeError("7z requested range exceeds the file.");
      }
      const checks: { scope: SevenCheckType["scope"]; crc: number }[] = [];
      const item = entry.folderId === undefined ? undefined : publicFolders[entry.folderId];
      const pack = item === undefined ? undefined : packs[item.packId];
      if (pack?.crc !== undefined) checks.push({ scope: "pack", crc: pack.crc });
      if (item?.crc !== undefined) checks.push({ scope: "folder", crc: item.crc });
      if (entry.crc !== undefined && entry.crcSource !== "folder") checks.push({ scope: "substream", crc: entry.crc });
      const readBudget = new ArchiveBudget(snapshot, readOptions, readOptions.signal);
      if (item && pack && item.coders[0]!.method !== "00") {
        const result = await decode(
          snapshot,
          pack,
          item.coders[0]!,
          entry.size,
          offset,
          length,
          readOptions.verify ?? true,
          readBudget,
          { ...options.lzma, ...codecPolicy(readOptions.lzma) },
          readOptions.signal,
        );
        const verified = (readOptions.verify ?? true) && result.complete;
        if (verified) {
          for (const check of checks) {
            if (check.crc !== (check.scope === "pack" ? result.packed : result.plain)) {
              throw new ArchiveError("checksum-mismatch", "7z compressed member CRC mismatch.");
            }
          }
        }
        return {
          bytes: result.bytes,
          decoding: result.complete ? "complete" : "prefix",
          integrity: checks.length === 0 ? "none" : verified ? "crc32-verified" : "pending",
          checks: Object.freeze(
            checks.map((check) =>
              Object.freeze({ ...check, status: verified ? "crc32-verified" as const : "pending" as const })
            ),
          ),
          work: readBudget.inspect(),
        };
      }
      const verify = (readOptions.verify ?? true) && checks.length > 0;
      const workLength = verify ? entry.size : length;
      if (
        workLength > readBudget.limits.maxSourceBytes || Math.ceil(workLength / 65536) > readBudget.limits.maxRequests
      ) throw new ArchiveError("budget-exceeded", "7z selected COPY work exceeds source limits.");
      readBudget.output(length);
      readBudget.decoded(workLength);
      readOptions.signal?.throwIfAborted();
      const output = new Uint8Array(length);
      let state = 0xffffffff;
      const begin = verify ? 0 : offset;
      const end = verify ? entry.size : offset + length;
      for (let at = begin; at < end;) {
        const count = Math.min(65536, end - at);
        const chunk = await readBudget.read(add(pack!.offset, at), count);
        if (verify) state = crc32(chunk, state);
        const from = Math.max(at, offset);
        const until = Math.min(at + count, offset + length);
        if (until > from) output.set(chunk.subarray(from - at, until - at), from - offset);
        at += count;
      }
      if (verify && checks.some((check) => check.crc !== ((state ^ 0xffffffff) >>> 0))) {
        throw new ArchiveError("checksum-mismatch", "7z selected COPY extent CRC mismatch.");
      }
      return {
        bytes: output,
        integrity: checks.length === 0 ? "none" : verify ? "crc32-verified" : "pending",
        checks: Object.freeze(
          checks.map((check): SevenCheckType =>
            Object.freeze({ ...check, status: verify ? "crc32-verified" : "pending" })
          ),
        ),
        work: readBudget.inspect(),
      };
    },
  });
}

export type {
  SevenArchiveType,
  SevenCheckType,
  SevenCoderType,
  SevenEntryType,
  SevenFolderType,
  SevenLzmaOptionsType,
  SevenOpenOptionsType,
  SevenPackType,
  SevenReadOptionsType,
  SevenReadType,
} from "./types.ts";
