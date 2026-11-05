/** Inspect bounded, uncompressed MCAP major-0 recordings over an explicit borrowed source. @module */
import { isBytes, toView } from "../bytes.ts";
import type { ByteSourceType } from "../source.ts";
import { ArchiveError, crc32, createArchiveLedger, integer, invalid, unsupported, view } from "../archive/record.ts";
import type { ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "../archive/record.ts";
export { ArchiveError, createArchiveLedger } from "../archive/record.ts";
export type { ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "../archive/record.ts";

/** Ancestor byte quotas and cancellation remain authoritative on derived payload sources. */
export interface McapCallOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
}
/** Implementation safety policies, separate from the format's uint64 address space. */
export interface McapOpenOptionsType extends McapCallOptionsType {
  readonly profile: "mcap0-uncompressed";
  readonly allowUnverifiedSource?: boolean;
  /** Retained messages: default 100,000; hard 1,000,000. */ readonly maxMessages?: number;
  /** Physical and nested record visits: default 1,000,000; hard 4,000,000. */ readonly maxRecords?: number;
  /** Metadata and descriptor reservation: default 8 MiB; hard 64 MiB. */ readonly maxMetadataBytes?: number;
  /** One schema's opaque bytes: default 1 MiB; hard 8 MiB. */ readonly maxSchemaBytes?: number;
  /** One UTF8 field: default 64 KiB; hard 1 MiB. */ readonly maxStringBytes?: number;
  /** One metadata map: default 4096 entries; hard 65536. */ readonly maxMapEntries?: number;
  /** One uncompressed chunk extent: default 64 MiB; hard 256 MiB. */ readonly maxChunkBytes?: number;
  /** A whole checked CRC unit: default 64 MiB; hard 256 MiB. */ readonly maxVerifyBytes?: number;
  /** One returned payload interval: default 8 MiB; hard 64 MiB. */ readonly maxReadBytes?: number;
  /** Validate an available summary CRC on opening; default true. */ readonly verifySummary?: boolean;
}
/** Schema bytes are opaque; no executable or serialization decoder is acquired. */
export interface McapSchemaType {
  readonly id: number;
  readonly name: string;
  readonly encoding: string;
  readonly data: Uint8Array;
}
/** Literal topics and metadata do not imply paths, HTML or URLs to fetch. */
export interface McapChannelType {
  readonly id: number;
  readonly schemaId: number;
  readonly topic: string;
  readonly encoding: string;
  readonly metadata: Readonly<Record<string, string>>;
}
/** id is a snapshot-local ordinal; sequence is the independent writer's sequence field. */
export interface McapMessageType {
  readonly id: number;
  readonly channelId: number;
  readonly sequence: number;
  readonly logTime: bigint;
  readonly publishTime: bigint;
  readonly size: number;
  readonly chunkId?: number;
}
/** Stored attachment names remain metadata, never traversal instructions. */
export interface McapAttachmentType {
  readonly id: number;
  readonly name: string;
  readonly mediaType: string;
  readonly logTime: bigint;
  readonly createTime: bigint;
  readonly size: number;
}
/** Each successful check names exactly the bytes it covers; CRC is not authentication. */
export interface McapIntegrityType {
  readonly scope: "summary" | "data" | "chunk" | "attachment";
  readonly status: "verified" | "pending" | "not-provided";
  readonly id?: number;
}
/** Count source work, retained metadata and framing independently. */
export interface McapWorkType extends ArchiveWorkType {
  readonly metadataBytes: number;
  readonly records: number;
}
/** Physical-order pagination can return an empty page with a continuing cursor. */
export interface McapPageOptionsType extends McapCallOptionsType {
  readonly cursor?: number;
  readonly limit?: number;
  readonly maxScanned?: number;
  readonly channelId?: number;
  readonly startLogTime?: bigint;
  readonly endLogTime?: bigint;
}
/** Scan count is independent of returned message count, including sparse filters. */
export interface McapPageType {
  readonly messages: readonly McapMessageType[];
  readonly scanned: number;
  readonly cursor?: number;
}
/** A selected read validates its whole containing CRC unit by default, if a CRC exists. */
export interface McapReadOptionsType extends McapCallOptionsType {
  readonly offset?: number;
  readonly length?: number;
  readonly verify?: boolean;
}
/** Returned bytes are owned. Work includes whole-unit checks, not only the selected interval. */
export interface McapReadType {
  readonly bytes: Uint8Array;
  readonly integrity: McapIntegrityType;
  readonly work: McapWorkType;
}
/** Explicit check scopes never imply that optional indexes or application payloads are semantically valid. */
export interface McapVerifyOptionsType extends McapCallOptionsType {
  readonly scope: "summary" | "data" | "chunk" | "attachment";
  readonly id?: number;
}
/** Complete physical message enumeration within this profile, not full MCAP conformance. */
export interface McapFileType {
  readonly profile: "mcap0-uncompressed";
  readonly library: string;
  readonly recordingProfile: string;
  readonly messageCount: number;
  readonly chunkCount: number;
  readonly work: McapWorkType;
  readonly integrity: McapIntegrityType;
  /** Optional index/statistics payloads remain unexamined. */ readonly diagnostics: readonly string[];
  readonly opaque: readonly { readonly opcode: number; readonly offset: number; readonly size: number }[];
  readonly schemas: readonly McapSchemaType[];
  readonly channels: readonly McapChannelType[];
  readonly attachments: readonly McapAttachmentType[];
  readonly metadata: readonly { readonly name: string; readonly values: Readonly<Record<string, string>> }[];
  messages(options?: McapPageOptionsType): McapPageType;
  read(id: number, options?: McapReadOptionsType): Promise<McapReadType>;
  readAttachment(id: number, options?: McapReadOptionsType): Promise<McapReadType>;
  /** A physical payload view carries no implicit CRC verification. */ source(
    id: number,
    options?: McapCallOptionsType,
  ): ByteSourceType;
  attachmentSource(id: number, options?: McapCallOptionsType): ByteSourceType;
  verify(
    options: McapVerifyOptionsType,
  ): Promise<{ readonly integrity: McapIntegrityType; readonly work: McapWorkType }>;
}
interface OwnerType {
  readonly identity: ArchiveLedgerType;
  readonly reserve: ArchiveLedgerType["reserve"];
}
interface AuthorityType {
  readonly owners: readonly OwnerType[];
  readonly signal: AbortSignal | undefined;
}
interface WorkType {
  sourceBytes: number;
  requests: number;
  decodedBytes: number;
  outputBytes: number;
  metadataBytes: number;
  records: number;
}
interface UnitType {
  offset: number;
  length: number;
  crc: number;
}
interface AttachmentType extends McapAttachmentType {
  offset: number;
  unit: UnitType;
}
interface ColumnsType {
  offset: Float64Array;
  size: Float64Array;
  channel: Uint32Array;
  sequence: Uint32Array;
  log: BigUint64Array;
  publish: BigUint64Array;
  chunk: Int32Array;
}
function fresh(): WorkType {
  return { sourceBytes: 0, requests: 0, decodedBytes: 0, outputBytes: 0, metadataBytes: 0, records: 0 };
}
function cap(n: number, max: number, label: string): void {
  if (n > max) throw new ArchiveError("budget-exceeded", `${label} exceeded.`);
}
function limit(n: number | undefined, defaultValue: number, hard: number, label: string): number {
  const value = n ?? defaultValue;
  integer(value, label);
  cap(value, hard, label);
  return value;
}
function safe(n: bigint): number {
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) unsupported("MCAP extent exceeds exact JavaScript addressing.");
  return Number(n);
}
function same(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((n, i) => n === b[i]);
}
function signals(a: AbortSignal | undefined, b: AbortSignal | undefined): AbortSignal | undefined {
  return a && b && a !== b ? AbortSignal.any([a, b]) : a ?? b;
}
/** Snapshot borrowed ledger methods and preserve every distinct ancestor, including local lifetime policy. */
function authority(options: McapCallOptionsType, parent?: AuthorityType): AuthorityType {
  const owners = [...(parent?.owners ?? [])];
  for (const ledger of [createArchiveLedger(options), ...(options.ledger ? [options.ledger] : [])]) {
    if (owners.some((o) => o.identity === ledger)) continue;
    const { reserve, inspect } = ledger;
    if (typeof reserve !== "function" || typeof inspect !== "function") {
      throw new TypeError("MCAP ledger requires reserve and inspect.");
    }
    owners.push({ identity: ledger, reserve: reserve.bind(ledger) });
  }
  cap(owners.length, 16, "MCAP inherited budget owners");
  return { owners, signal: signals(parent?.signal, options.signal) };
}
function charge(auth: AuthorityType, work: WorkType, kind: keyof ArchiveWorkType, n: number): void {
  integer(n, "MCAP work");
  auth.signal?.throwIfAborted();
  for (const owner of auth.owners) {
    owner.reserve(kind, n);
    auth.signal?.throwIfAborted();
  }
  work[kind] += n;
}

/** Index physical records without loading message bodies or trusting optional indexes. The source stays borrowed. */
export async function openMcap(input: ByteSourceType, inputOptions: McapOpenOptionsType): Promise<McapFileType> {
  const options = { ...inputOptions };
  if (options.profile !== "mcap0-uncompressed") throw new TypeError("Select mcap0-uncompressed explicitly.");
  const { size, identity, stability } = input, read = input.read.bind(input);
  integer(size, "MCAP source size");
  if (identity !== undefined && (typeof identity !== "string" || !identity.length)) {
    throw new TypeError("MCAP source identity must be nonempty.");
  }
  if (stability !== undefined && !["immutable", "provider", "caller"].includes(stability)) {
    throw new TypeError("Unknown MCAP source stability.");
  }
  if (stability === undefined && !options.allowUnverifiedSource) {
    unsupported("MCAP range composition requires stable source evidence or allowUnverifiedSource.");
  }
  const policy = {
    messages: limit(options.maxMessages, 100000, 1000000, "MCAP messages"),
    records: limit(options.maxRecords, 1000000, 4000000, "MCAP records"),
    metadata: limit(options.maxMetadataBytes, 8 << 20, 64 << 20, "MCAP metadata"),
    schema: limit(options.maxSchemaBytes, 1 << 20, 8 << 20, "MCAP schema"),
    string: limit(options.maxStringBytes, 64 << 10, 1 << 20, "MCAP string"),
    map: limit(options.maxMapEntries, 4096, 65536, "MCAP map entries"),
    chunk: limit(options.maxChunkBytes, 64 << 20, 256 << 20, "MCAP chunk"),
    verify: limit(options.maxVerifyBytes, 64 << 20, 256 << 20, "MCAP verification"),
    read: limit(options.maxReadBytes, 8 << 20, 64 << 20, "MCAP returned interval"),
  };
  const opening = authority(options), opened = fresh();
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const metadata = (n: number) => {
    integer(n, "MCAP metadata");
    cap(n, policy.metadata - opened.metadataBytes, "MCAP retained metadata");
    opened.metadataBytes += n;
  };
  /** Source counts are reserved before callbacks; copied bytes cannot change during a later await. */
  async function fetch(
    auth: AuthorityType,
    work: WorkType,
    offset: number,
    length: number,
    paid = false,
  ): Promise<Uint8Array> {
    integer(offset, "MCAP offset");
    integer(length, "MCAP length");
    auth.signal?.throwIfAborted();
    if (offset > size || length > size - offset) invalid("MCAP extent exceeds source.");
    if (!length) return new Uint8Array();
    if (!paid) {
      charge(auth, work, "sourceBytes", length);
      charge(auth, work, "requests", 1);
      charge(auth, work, "decodedBytes", length);
    }
    const value = await read(offset, length, auth.signal ? { signal: auth.signal } : {});
    auth.signal?.throwIfAborted();
    if (!isBytes(value)) invalid("MCAP source returned a non-byte extent.");
    const bytes = toView(value);
    if (bytes.byteLength !== length) invalid("MCAP source returned an incomplete extent.");
    return new Uint8Array(bytes);
  }
  /** A field cursor never treats a length prefix as permission to allocate unbounded metadata. */
  function cursor(offset: number, end: number) {
    let at = offset;
    async function bytes(n: number, retain = false): Promise<Uint8Array> {
      integer(n, "MCAP field length");
      if (n > end - at) invalid("MCAP field exceeds record.");
      if (retain) metadata(n);
      const result = await fetch(opening, opened, at, n);
      at += n;
      return result;
    }
    async function number(n: 2 | 4 | 8): Promise<number> {
      const b = await bytes(n);
      return n === 8
        ? safe(view(b).getBigUint64(0, true))
        : n === 4
        ? view(b).getUint32(0, true)
        : view(b).getUint16(0, true);
    }
    async function string(): Promise<string> {
      const n = await number(4);
      cap(n, policy.string, "MCAP UTF8 field");
      metadata(n);
      const b = await bytes(n, true);
      try {
        return text.decode(b);
      } catch {
        invalid("MCAP field is not valid UTF8.");
      }
    }
    async function map(): Promise<Readonly<Record<string, string>>> {
      const n = await number(4);
      if (n > end - at) invalid("MCAP map exceeds record.");
      const stop = at + n;
      const nested = cursor(at, stop);
      const result: Record<string, string> = Object.create(null);
      let count = 0;
      while (nested.position() < stop) {
        cap(++count, policy.map, "MCAP map entries");
        const key = await nested.string(), value = await nested.string();
        if (Object.hasOwn(result, key)) unsupported("MCAP duplicate map keys are ambiguous in this profile.");
        metadata(32);
        result[key] = value;
      }
      at = stop;
      return Object.freeze(result);
    }
    return {
      bytes,
      number,
      string,
      map,
      position: () => at,
      async tail() {
        return await bytes(end - at, true);
      },
    };
  }
  const schemas = new Map<number, McapSchemaType & { tail: Uint8Array }>(),
    channels = new Map<number, McapChannelType & { tail: Uint8Array }>();
  const chunks: UnitType[] = [],
    attachments: AttachmentType[] = [],
    columns: ColumnsType[] = [],
    opaque: { opcode: number; offset: number; size: number }[] = [],
    meta: { name: string; values: Readonly<Record<string, string>> }[] = [];
  let count = 0, recordCount = 0, library = "", profile = "", dataEnd = -1, dataCrc = 0;
  function descriptor(id: number): McapMessageType {
    integer(id, "MCAP message id");
    if (id >= count) throw new RangeError("Unknown MCAP message id.");
    const col = columns[Math.floor(id / 256)]!, i = id % 256, chunk = col.chunk[i]!;
    return Object.freeze({
      id,
      channelId: col.channel[i]!,
      sequence: col.sequence[i]!,
      logTime: col.log[i]!,
      publishTime: col.publish[i]!,
      size: col.size[i]!,
      ...(chunk < 0 ? {} : { chunkId: chunk }),
    });
  }
  function physical(id: number): { offset: number; length: number; chunk: number } {
    descriptor(id);
    const col = columns[Math.floor(id / 256)]!, i = id % 256;
    return { offset: col.offset[i]!, length: col.size[i]!, chunk: col.chunk[i]! };
  }
  function addMessage(offset: number, length: number, head: Uint8Array, chunk: number): void {
    cap(count + 1, policy.messages, "MCAP message count");
    const data = view(head), channel = data.getUint16(0, true);
    if (!channels.has(channel)) invalid("MCAP message precedes its Channel definition.");
    if (count % 256 === 0) {
      const n = Math.min(256, policy.messages - count);
      metadata(n * 44);
      columns.push({
        offset: new Float64Array(n),
        size: new Float64Array(n),
        channel: new Uint32Array(n),
        sequence: new Uint32Array(n),
        log: new BigUint64Array(n),
        publish: new BigUint64Array(n),
        chunk: new Int32Array(n),
      });
    }
    const col = columns[Math.floor(count / 256)]!, i = count % 256;
    col.offset[i] = offset;
    col.size[i] = length;
    col.channel[i] = channel;
    col.sequence[i] = data.getUint32(2, true);
    col.log[i] = data.getBigUint64(6, true);
    col.publish[i] = data.getBigUint64(14, true);
    col.chunk[i] = chunk;
    count++;
  }
  async function header(at: number, end: number): Promise<{ op: number; body: number; end: number; length: number }> {
    if (end - at < 9) invalid("Truncated MCAP record header.");
    cap(++recordCount, policy.records, "MCAP record visits");
    opened.records++;
    const h = await fetch(opening, opened, at, 9), length = safe(view(h).getBigUint64(1, true));
    if (!h[0]) invalid("MCAP opcode zero is invalid.");
    if (length > end - at - 9) invalid("MCAP record exceeds enclosing extent.");
    return { op: h[0]!, body: at + 9, end: at + 9 + length, length };
  }
  /** Definitions may repeat, but an ID never changes meaning after a message uses it. */
  async function definition(op: number, body: number, end: number): Promise<void> {
    const c = cursor(body, end), id = await c.number(2);
    metadata(96);
    if (op === 3 && id === 0) return;
    if (op === 3) {
      const name = await c.string(), encoding = await c.string(), length = await c.number(4);
      cap(length, policy.schema, "MCAP schema bytes");
      const data = await c.bytes(length, true), tail = await c.tail();
      const old = schemas.get(id);
      if (old && (old.name !== name || old.encoding !== encoding || !same(old.data, data) || !same(old.tail, tail))) {
        invalid("Conflicting MCAP Schema definitions.");
      }
      if (!old) schemas.set(id, { id, name, encoding, data, tail });
    } else {
      const schemaId = await c.number(2);
      if (schemaId && !schemas.has(schemaId)) invalid("MCAP Channel precedes its Schema definition.");
      const topic = await c.string(),
        encoding = await c.string(),
        values = await c.map(),
        tail = await c.tail(),
        old = channels.get(id);
      if (
        old &&
        (old.schemaId !== schemaId || old.topic !== topic || old.encoding !== encoding || !same(old.tail, tail) ||
          Object.keys(old.metadata).length !== Object.keys(values).length || Object.keys(values).some((k) =>
            old.metadata[k] !== values[k]
          ))
      ) invalid("Conflicting MCAP Channel definitions.");
      if (!old) channels.set(id, { id, schemaId, topic, encoding, metadata: values, tail });
    }
  }
  async function record(op: number, body: number, end: number, chunk = -1): Promise<void> {
    if (op === 3 || op === 4) {
      await definition(op, body, end);
      return;
    }
    if (op === 5) {
      if (end - body < 22) invalid("Truncated MCAP Message.");
      addMessage(body + 22, end - body - 22, await fetch(opening, opened, body, 22), chunk);
      return;
    }
    if (op === 6) {
      if (chunk >= 0) invalid("Nested MCAP Chunk.");
      const c = cursor(body, end);
      await c.bytes(16);
      const uncompressed = await c.number(8),
        crc = await c.number(4),
        compression = await c.string(),
        length = await c.number(8);
      if (compression !== "") unsupported("Compressed MCAP chunks are outside mcap0-uncompressed.");
      cap(length, policy.chunk, "MCAP uncompressed chunk extent");
      if (length !== uncompressed || length > end - c.position()) invalid("MCAP uncompressed Chunk size mismatch.");
      metadata(64);
      const id = chunks.length;
      chunks.push({ offset: c.position(), length, crc });
      let at = c.position();
      const stop = at + length;
      while (at < stop) {
        const h = await header(at, stop);
        if ([1, 2, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].includes(h.op)) {
          invalid("Record is not permitted inside an MCAP Chunk.");
        }
        await record(h.op, h.body, h.end, id);
        at = h.end;
      }
      return;
    }
    if (op === 9) {
      const c = cursor(body, end);
      const times = view(await c.bytes(16)),
        name = await c.string(),
        mediaType = await c.string(),
        length = await c.number(8),
        offset = c.position();
      if (length > end - offset - 4) invalid("MCAP Attachment exceeds its record.");
      const crc = view(await fetch(opening, opened, offset + length, 4)).getUint32(0, true);
      metadata(160);
      attachments.push({
        id: attachments.length,
        name,
        mediaType,
        logTime: times.getBigUint64(0, true),
        createTime: times.getBigUint64(8, true),
        size: length,
        offset,
        unit: { offset: body, length: offset + length - body, crc },
      });
      return;
    }
    if (op === 12) {
      const c = cursor(body, end);
      metadata(64);
      meta.push({ name: await c.string(), values: await c.map() });
      return;
    }
    if ([1, 2, 14, 15].includes(op)) invalid("MCAP structural record occurs in the wrong section.");
    metadata(32);
    opaque.push({ opcode: op, offset: body - 9, size: end - body + 9 });
  }
  if (size < 54) invalid("MCAP file is too short.");
  const magic = new Uint8Array([137, 77, 67, 65, 80, 48, 13, 10]);
  if (!same(await fetch(opening, opened, 0, 8), magic) || !same(await fetch(opening, opened, size - 8, 8), magic)) {
    invalid("MCAP major-0 magic mismatch.");
  }
  const footerAt = size - 37, footer = await header(footerAt, size - 8);
  if (footer.op !== 2 || footer.length !== 20 || footer.end !== size - 8) {
    invalid("MCAP Footer must be the final exact 20-byte record.");
  }
  const fd = view(await fetch(opening, opened, footer.body, 20)),
    summaryStart = safe(fd.getBigUint64(0, true)),
    offsetStart = safe(fd.getBigUint64(8, true)),
    summaryCrc = fd.getUint32(16, true);
  if (
    summaryStart > footerAt || offsetStart > footerAt || (!summaryStart && offsetStart) ||
    offsetStart && offsetStart < summaryStart
  ) invalid("MCAP Footer summary extents are inconsistent.");
  const first = await header(8, footerAt);
  if (first.op !== 1) invalid("MCAP Header must be first.");
  const hc = cursor(first.body, first.end);
  profile = await hc.string();
  library = await hc.string();
  let at = first.end;
  while (at < footerAt) {
    const h = await header(at, footerAt);
    if (h.op === 15) {
      if (h.length !== 4) invalid("MCAP DataEnd is exactly 4 bytes.");
      dataEnd = at;
      dataCrc = view(await fetch(opening, opened, h.body, 4)).getUint32(0, true);
      at = h.end;
      break;
    }
    if ([8, 10, 11, 13].includes(h.op)) invalid("MCAP summary-only record occurs in the data section.");
    await record(h.op, h.body, h.end);
    at = h.end;
  }
  if (dataEnd < 0) invalid("MCAP data section lacks DataEnd.");
  if (summaryStart ? at !== summaryStart : at !== footerAt) invalid("MCAP summary start does not follow DataEnd.");
  const groupStop = offsetStart || footerAt, seenGroups = new Set<number>();
  let group = -1;
  while (at < groupStop) {
    const h = await header(at, groupStop);
    if (![3, 4, 8, 10, 11, 13].includes(h.op)) invalid("Record is not permitted in MCAP summary.");
    if (h.op !== group) {
      if (seenGroups.has(h.op)) invalid("MCAP summary opcode group repeats.");
      seenGroups.add(h.op);
      group = h.op;
    }
    if (h.op === 3 || h.op === 4) {
      if (h.length < 2) invalid("Truncated MCAP summary definition.");
      const id = view(await fetch(opening, opened, h.body, 2)).getUint16(0, true);
      if (id !== 0 && h.op === 3 && !schemas.has(id) || h.op === 4 && !channels.has(id)) {
        invalid("MCAP summary definition is absent from the data section.");
      }
      await definition(h.op, h.body, h.end);
    } else {
      metadata(32);
      opaque.push({ opcode: h.op, offset: at, size: h.end - at });
    }
    at = h.end;
  }
  while (at < footerAt) {
    const h = await header(at, footerAt);
    if (h.op !== 14 || h.length < 17) invalid("Invalid MCAP SummaryOffset framing.");
    at = h.end;
  }
  /** Reserve full verification I/O before allocating its bounded scratch or selected result. */
  function reserve(auth: AuthorityType, work: WorkType, offset: number, length: number): void {
    if (offset > size || length > size - offset) invalid("MCAP check extent exceeds source.");
    cap(length, policy.verify, "MCAP whole CRC unit");
    charge(auth, work, "sourceBytes", length);
    charge(auth, work, "requests", Math.ceil(length / 65536));
    charge(auth, work, "decodedBytes", length);
  }
  async function check(
    auth: AuthorityType,
    work: WorkType,
    unit: UnitType,
    scope: McapIntegrityType["scope"],
    id?: number,
    paid = false,
  ): Promise<McapIntegrityType> {
    const result = { scope, ...(id === undefined ? {} : { id }) };
    auth.signal?.throwIfAborted();
    if (!unit.crc) return { ...result, status: "not-provided" };
    if (!paid) reserve(auth, work, unit.offset, unit.length);
    let state = 0xffffffff;
    for (let n = 0; n < unit.length; n += 65536) {
      state = crc32(await fetch(auth, work, unit.offset + n, Math.min(65536, unit.length - n), true), state);
      auth.signal?.throwIfAborted();
    }
    if (((state ^ 0xffffffff) >>> 0) !== unit.crc) {
      throw new ArchiveError("checksum-mismatch", `MCAP ${scope} CRC mismatch.`);
    }
    return { ...result, status: "verified" };
  }
  const summaryUnit = {
    offset: summaryStart || footerAt,
    length: footerAt + 25 - (summaryStart || footerAt),
    crc: summaryCrc,
  };
  const integrity = options.verifySummary === false
    ? { scope: "summary" as const, status: summaryCrc ? "pending" as const : "not-provided" as const }
    : await check(opening, opened, summaryUnit, "summary");
  const dataUnit = { offset: 0, length: dataEnd, crc: dataCrc };
  function attachment(id: number): AttachmentType {
    integer(id, "MCAP attachment id");
    const a = attachments[id];
    if (!a) throw new RangeError("Unknown MCAP attachment id.");
    return a;
  }
  function interval(length: number, call: McapReadOptionsType): { offset: number; length: number } {
    const offset = call.offset ?? 0, n = call.length ?? length - offset;
    integer(offset, "MCAP payload offset");
    integer(n, "MCAP payload length");
    if (offset > length || n > length - offset) throw new RangeError("MCAP payload interval exceeds selected record.");
    cap(n, policy.read, "MCAP returned interval");
    return { offset, length: n };
  }
  async function selected(id: number, call: McapReadOptionsType, isAttachment: boolean): Promise<McapReadType> {
    const auth = authority({ ...call }, opening),
      work = fresh(),
      p = isAttachment ? attachment(id) : physical(id),
      length = "size" in p ? p.size : p.length,
      part = interval(length, call);
    const unit = isAttachment
      ? (p as AttachmentType).unit
      : (p as { chunk: number }).chunk < 0
      ? dataUnit
      : chunks[(p as { chunk: number }).chunk]!;
    const scope = isAttachment ? "attachment" : (p as { chunk: number }).chunk < 0 ? "data" : "chunk";
    // An ordinary message does not trigger whole-recording CRC work implicitly.
    const verify = call.verify !== false && (isAttachment || scope === "chunk");
    if (verify && unit.crc) reserve(auth, work, unit.offset, unit.length);
    charge(auth, work, "sourceBytes", part.length);
    charge(auth, work, "requests", part.length ? 1 : 0);
    charge(auth, work, "decodedBytes", part.length);
    charge(auth, work, "outputBytes", part.length);
    const status: McapIntegrityType = verify
      ? await check(
        auth,
        work,
        unit,
        scope,
        isAttachment ? id : scope === "chunk" ? (p as { chunk: number }).chunk : undefined,
        true,
      )
      : { scope, status: unit.crc ? "pending" as const : "not-provided" as const };
    const bytes = await fetch(auth, work, p.offset + part.offset, part.length, true);
    return { bytes, integrity: status, work: { ...work } };
  }
  function payloadSource(id: number, call: McapCallOptionsType, isAttachment: boolean): ByteSourceType {
    const auth = authority({ ...call }, opening),
      p = isAttachment ? attachment(id) : physical(id),
      length = "size" in p ? p.size : p.length;
    return {
      size: length,
      ...(identity === undefined ? {} : { identity: JSON.stringify(["mcap0", identity, p.offset, length]) }),
      ...(stability === undefined ? {} : { stability }),
      async read(offset, n, readOptions = {}) {
        const child = authority({ ...readOptions }, auth), work = fresh();
        integer(offset, "MCAP source offset");
        integer(n, "MCAP source length");
        if (offset > length || n > length - offset) throw new RangeError("MCAP payload source range exceeds record.");
        cap(n, policy.read, "MCAP source interval");
        charge(child, work, "outputBytes", n);
        return await fetch(child, work, p.offset + offset, n);
      },
    };
  }
  const schemaOutput = [...schemas.values()].reduce((n, schema) => n + schema.data.length, 0);
  charge(opening, opened, "outputBytes", schemaOutput);
  const schemasPublic = Object.freeze(
    [...schemas.values()].map(({ tail: _, data, ...rest }) => Object.freeze({ ...rest, data: new Uint8Array(data) })),
  );
  const channelsPublic = Object.freeze([...channels.values()].map(({ tail: _, ...rest }) => Object.freeze(rest)));
  const attachmentsPublic = Object.freeze(attachments.map(({ offset: _, unit: __, ...rest }) => Object.freeze(rest)));
  opening.signal?.throwIfAborted();
  return Object.freeze({
    profile: "mcap0-uncompressed",
    library,
    recordingProfile: profile,
    messageCount: count,
    chunkCount: chunks.length,
    work: Object.freeze({ ...opened }),
    integrity: Object.freeze(integrity),
    diagnostics: Object.freeze([
      "Optional indexes and statistics are not payload authority and remain unexamined.",
      "Physical CRC checks do not authenticate or decode application payloads.",
    ]),
    opaque: Object.freeze(opaque.map((x) => Object.freeze(x))),
    schemas: schemasPublic,
    channels: channelsPublic,
    attachments: attachmentsPublic,
    metadata: Object.freeze(meta.map((x) => Object.freeze(x))),
    messages(call: McapPageOptionsType = {}) {
      const auth = authority({ ...call }, opening);
      auth.signal?.throwIfAborted();
      let at = call.cursor ?? 0;
      integer(at, "MCAP page cursor");
      if (at > count) throw new RangeError("MCAP page cursor exceeds messages.");
      const take = limit(call.limit, 256, 4096, "MCAP page results"),
        scan = limit(call.maxScanned, 8192, 65536, "MCAP page scan");
      if (!take || !scan) throw new RangeError("MCAP page limits must be positive.");
      if (call.channelId !== undefined) {
        integer(call.channelId, "MCAP channel filter");
        if (call.channelId > 65535) throw new RangeError("MCAP channel id exceeds uint16.");
      }
      for (
        const t of [call.startLogTime, call.endLogTime]
      ) {
        if (t !== undefined && (typeof t !== "bigint" || t < 0n || t > 0xffffffffffffffffn)) {
          throw new RangeError("MCAP time filter must be uint64 bigint.");
        }
      }
      if (
        call.startLogTime !== undefined && call.endLogTime !== undefined && call.endLogTime < call.startLogTime
      ) throw new RangeError("MCAP time interval is reversed.");
      const messages: McapMessageType[] = [];
      let scanned = 0;
      while (at < count && scanned < scan && messages.length < take) {
        auth.signal?.throwIfAborted();
        const d = descriptor(at++);
        scanned++;
        if (
          call.channelId !== undefined && d.channelId !== call.channelId ||
          call.startLogTime !== undefined && d.logTime < call.startLogTime ||
          call.endLogTime !== undefined && d.logTime >= call.endLogTime
        ) continue;
        messages.push(d);
      }
      return Object.freeze({ messages: Object.freeze(messages), scanned, ...(at < count ? { cursor: at } : {}) });
    },
    read(id: number, call: McapReadOptionsType = {}) {
      return selected(id, { ...call }, false);
    },
    readAttachment(id: number, call: McapReadOptionsType = {}) {
      return selected(id, { ...call }, true);
    },
    source(id: number, call: McapCallOptionsType = {}) {
      return payloadSource(id, call, false);
    },
    attachmentSource(id: number, call: McapCallOptionsType = {}) {
      return payloadSource(id, call, true);
    },
    async verify(inputCall: McapVerifyOptionsType) {
      const call = { ...inputCall };
      const auth = authority({ ...call }, opening), work = fresh();
      let unit: UnitType;
      if (call.scope === "summary") unit = summaryUnit;
      else if (call.scope === "data") unit = dataUnit;
      else if (call.scope === "attachment") unit = attachment(call.id!).unit;
      else if (call.scope === "chunk") {
        integer(call.id!, "MCAP chunk id");
        const found = chunks[call.id!];
        if (!found) throw new RangeError("Unknown MCAP chunk id.");
        unit = found;
      } else throw new TypeError("Unknown MCAP verification scope.");
      return { integrity: await check(auth, work, unit, call.scope, call.id), work: { ...work } };
    },
  });
}
