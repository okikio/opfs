/** Public ArFS 0.15 metadata and selected file bytes over an explicit supplied inventory. @module */
import { z } from "zod";
import { isBytes, toView } from "../bytes.ts";
import { sourceRange } from "../source.ts";
import type { ByteSourceType } from "../source.ts";
import { ArchiveError, createArchiveLedger, integer } from "../archive/record.ts";
import type { ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "../archive/record.ts";
export { ArchiveError, createArchiveLedger } from "../archive/record.ts";

/** Tags are already decoded caller assertions, not verified transaction headers. */
export interface ArfsTagType {
  readonly name: string;
  readonly value: string;
}
/** The caller selects exactly one metadata revision for each logical entity. Sources are borrowed. */
export interface ArfsMetadataInputType {
  readonly transactionId: string;
  readonly owner: string;
  readonly tags: readonly ArfsTagType[];
  readonly source: ByteSourceType;
}
/** Explicit selected data binding. Supplying an ID asserts provenance; it does not authenticate the bytes. */
export interface ArfsDataInputType {
  readonly transactionId: string;
  readonly source: ByteSourceType;
}
/** Only this inventory is inspected. Neither discovery nor revision selection occurs. */
export interface ArfsInputType {
  readonly drive: ArfsMetadataInputType;
  readonly entities: readonly ArfsMetadataInputType[];
}
/** Local safety policies, not Arweave provider maxima. Opening limits remain lifetime authority. */
export interface ArfsOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
  /** Per metadata source: default 1 MiB, hard 4 MiB. */ readonly maxMetadataBytes?: number;
  /** All raw metadata bytes: default 16 MiB, hard 64 MiB. */ readonly maxTotalMetadataBytes?: number;
  /** Selected non-drive entities: default 10000, hard 65536. */ readonly maxEntities?: number;
  /** Retained raw text, tags and index estimate: default 16 MiB, hard 64 MiB; not a JS heap guarantee. */ readonly maxIndexBytes?:
    number;
  /** Per entity: default 64, hard 256. */ readonly maxTags?: number;
  /** Per decoded tag field: default 4096 UTF8 bytes, hard 65536. */ readonly maxTagBytes?: number;
  /** Aggregate decoded tag bytes per entity: default 16384, hard 65536. */ readonly maxTagTotalBytes?: number;
  /** UTF8 literal display names: default 4096 bytes, hard 65536. Names are never paths. */ readonly maxNameBytes?:
    number;
  /** Default 16, hard 64. */ readonly maxJsonDepth?: number;
  /** JSON values and keys per metadata document: default 100000, hard 1000000. */ readonly maxJsonTokens?: number;
}
/** A later call narrows opening authority. It cannot replace the opening signal or ledger. */
export interface ArfsCallOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
}
/** Buffered exact range; remaining file by default. Returned allocation hard ceiling is 16 MiB. */
export interface ArfsReadOptionsType extends ArfsCallOptionsType {
  readonly offset?: number;
  readonly length?: number;
}
/** Exact selected range. No signature, chain inclusion or data-root check has occurred. */
export interface ArfsReadType {
  readonly bytes: Uint8Array;
  readonly integrity: "caller-supplied-data";
  readonly scope: "selected-file-range";
  readonly work: ArchiveWorkType;
}
/** Immutable metadata copies retain raw authority for inspection, including original UUID spelling. */
export interface ArfsEntityType {
  readonly kind: "drive" | "folder" | "file";
  /** UUID normalized to lowercase for logical equality. Raw UUID tags remain in tags. */ readonly id: string;
  readonly driveId: string;
  readonly transactionId: string;
  readonly owner: string;
  readonly name: string;
  readonly parentId?: string;
  readonly isHidden: boolean;
  /** Seconds since Unix epoch; does not establish revision order. */ readonly unixTime: number;
  readonly tags: readonly ArfsTagType[];
  /** Full strict UTF8 JSON, including inert unknown fields. */ readonly metadataJson: string;
  /** Captured evidence for these bytes, not proof of signed transaction identity. */
  readonly metadataSource: {
    readonly size: number;
    readonly identity: string;
    readonly stability: "immutable" | "provider" | "caller";
  };
}
/** Drive root identity is a logical folder UUID, not a transaction ID. */
export interface ArfsDriveType extends ArfsEntityType {
  readonly kind: "drive";
  readonly rootFolderId: string;
}
/** Literal folder identity; no host directory or path is created. */
export interface ArfsFolderType extends ArfsEntityType {
  readonly kind: "folder";
}
/** Public file metadata may pin another owner's data. All data acquisition remains explicit. */
export interface ArfsFileType extends ArfsEntityType {
  readonly kind: "file";
  readonly size: number;
  readonly dataTxId: string;
  readonly dataContentType: string;
  /** Milliseconds since Unix epoch. */ readonly lastModifiedDate: number;
  readonly pinnedDataOwner?: string;
  read(data: ArfsDataInputType, options?: ArfsReadOptionsType): Promise<ArfsReadType>;
  /** Borrow the explicitly supplied data source. No acquisition occurs until its read method is called. */
  source(data: ArfsDataInputType, options?: ArfsCallOptionsType): ByteSourceType;
}
/** Missing references describe this supplied subset, not absence from Arweave. */
export interface ArfsIssueType {
  readonly code: "missing-root-folder" | "missing-parent";
  readonly id: string;
}
/** Supplied selected revisions only; no latest-state, complete-drive or universal ArFS reader claim. */
export interface ArfsViewType {
  readonly profile: "public-0.15";
  readonly scope: "supplied-selected-revisions";
  readonly integrity: "caller-supplied-metadata";
  readonly drive: ArfsDriveType;
  readonly entities: readonly (ArfsFolderType | ArfsFileType)[];
  readonly issues: readonly ArfsIssueType[];
  readonly work: ArchiveWorkType;
  /** Literal normalized UUID lookup; missing selected revisions throw. */ file(id: string): ArfsFileType;
  /** Hidden children are included: visibility is application policy. No target data is read. */
  list(
    folderId: string,
  ): { readonly scope: "supplied-selected-revisions"; readonly entries: readonly (ArfsFolderType | ArfsFileType)[] };
}

/** Schemas own serialized authority; unknown JSON remains available only as inert original text. */
const entitySchema: z.ZodObject<{ name: z.ZodString; isHidden: z.ZodOptional<z.ZodBoolean> }> = z.object({
  name: z.string(),
  isHidden: z.boolean().optional(),
});
const driveSchema: z.ZodObject<{ rootFolderId: z.ZodString }> = z.object({ rootFolderId: z.string() });
const fileSchema: z.ZodObject<
  {
    size: z.ZodNumber;
    dataTxId: z.ZodString;
    dataContentType: z.ZodString;
    lastModifiedDate: z.ZodNumber;
    pinnedDataOwner: z.ZodOptional<z.ZodString>;
  }
> = z.object({
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  dataTxId: z.string(),
  dataContentType: z.string(),
  lastModifiedDate: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  pinnedDataOwner: z.string().optional(),
});
function invalid(message: string): never {
  throw new ArchiveError("invalid-archive", message);
}
function unsupported(message: string): never {
  throw new ArchiveError("unsupported-profile", message);
}
function cap(value: number, maximum: number, name: string): void {
  if (value > maximum) throw new ArchiveError("budget-exceeded", `${name} exceeded.`);
}
/** Preflight UTF16 before UTF8 encoding so malicious caller strings cannot force unbounded temporary allocations. */
function utf8(value: string, maximum: number, name: string): number {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string.`);
  cap(value.length, maximum, name);
  if (!value.isWellFormed()) invalid(`${name} has unpaired UTF16 surrogates.`);
  const length = new TextEncoder().encode(value).byteLength;
  cap(length, maximum, name);
  return length;
}
function uuid(value: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) {
    invalid("ArFS requires a UUID, not a path or encrypted sentinel.");
  }
  return value.toLowerCase();
}
/** A canonical 32-byte base64url identifier remains an assertion without transaction verification. */
function txid(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value)) {
    invalid("ArFS transaction/owner ID requires canonical 32-byte base64url.");
  }
  return value;
}
/** Snapshot the foreign descriptor once. The identifier's existence does not upgrade its evidence. */
interface StableSourceType extends ByteSourceType {
  readonly identity: string;
  readonly stability: "immutable" | "provider" | "caller";
}
function capture(source: ByteSourceType): StableSourceType {
  const { size, identity, stability, read } = source;
  integer(size, "ArFS source size");
  if (
    typeof identity !== "string" || !identity.length ||
    (stability !== "immutable" && stability !== "provider" && stability !== "caller")
  ) unsupported("ArFS requires explicit stable source identity and evidence.");
  utf8(identity, 65536, "ArFS source identity");
  if (typeof read !== "function") throw new TypeError("ArFS source must provide read.");
  return Object.freeze({ size, identity, stability, read: read.bind(source) });
}
/** Preserve every parent ledger exactly once; counts reserve before library-owned output allocation. */
function authority(options: ArchiveLimitsType, parents: readonly ArchiveLedgerType[] = []): ArchiveLedgerType[] {
  return [...new Set([...parents, createArchiveLedger(options), ...(options.ledger ? [options.ledger] : [])])];
}
function combined(signals: readonly (AbortSignal | undefined)[]): AbortSignal | undefined {
  const values = [...new Set(signals.filter((s): s is AbortSignal => s !== undefined))];
  return values.length === 0 ? undefined : values.length === 1 ? values[0] : AbortSignal.any(values);
}
/** Exact chunked collection has finite caller-visible counts. Foreign source work and allocation remain opaque. */
async function collect(
  source: ByteSourceType,
  offset: number,
  length: number,
  ledgers: readonly ArchiveLedgerType[],
  signal: AbortSignal | undefined,
  metadata: boolean,
): Promise<ArfsReadType> {
  signal?.throwIfAborted();
  sourceRange(source.size, offset, length);
  cap(length, metadata ? 4 * 1024 * 1024 : 16 * 1024 * 1024, "ArFS collected extent");
  const work = {
    sourceBytes: length,
    requests: Math.ceil(length / 65536),
    decodedBytes: metadata ? length : 0,
    outputBytes: metadata ? 0 : length,
  };
  for (const [kind, count] of Object.entries(work)) {
    for (const ledger of ledgers) ledger.reserve(kind as keyof ArchiveWorkType, count);
  }
  const bytes = new Uint8Array(length);
  for (let at = 0; at < length;) {
    signal?.throwIfAborted();
    const count = Math.min(65536, length - at);
    const value = await source.read(offset + at, count, signal ? { signal } : {});
    signal?.throwIfAborted();
    if (!isBytes(value)) invalid("ArFS source returned a non-byte extent.");
    const view = toView(value);
    if (view.byteLength !== count) invalid("ArFS source returned a different extent.");
    bytes.set(view, at);
    at += count;
  }
  signal?.throwIfAborted();
  return { bytes, integrity: "caller-supplied-data", scope: "selected-file-range", work };
}
/** Bound recursive grammar and duplicate decoded keys before JSON.parse can discard overwritten authority. */
function jsonOf(text: string, depth: number, tokens: number, stringBytes: number, fileAuthority: boolean): unknown {
  let at = 0, count = 0;
  const whitespace = (): void => {
    while (/[ \t\r\n]/.test(text[at] ?? "x")) at++;
  };
  function string(): string {
    if (text[at++] !== '"') invalid("Expected JSON string.");
    const start = at - 1;
    while (at < text.length) {
      const c = text[at++];
      if (c === "\\") {
        at++;
        continue;
      }
      if (c === '"') {
        cap(at - start - 2, stringBytes * 6, "ArFS encoded JSON string");
        let value: unknown;
        try {
          value = JSON.parse(text.slice(start, at));
        } catch {
          invalid("Malformed JSON string.");
        }
        if (typeof value !== "string") invalid("Malformed JSON string.");
        utf8(value, stringBytes, "ArFS JSON string");
        return value;
      }
    }
    invalid("Unterminated JSON string.");
  }
  function value(level: number, authorityKey?: string): void {
    cap(level, depth, "ArFS JSON depth");
    cap(++count, tokens, "ArFS JSON tokens");
    whitespace();
    if (text[at] === "{") {
      at++;
      whitespace();
      const keys = new Set<string>();
      if (text[at] === "}") {
        at++;
        return;
      }
      while (true) {
        cap(++count, tokens, "ArFS JSON keys");
        whitespace();
        const key = string();
        if (keys.has(key)) invalid("Duplicate decoded JSON object key.");
        if (key === "__proto__") invalid("Reserved JSON dictionary key.");
        keys.add(key);
        whitespace();
        if (text[at++] !== ":") invalid("Expected JSON colon.");
        value(level + 1, level === 0 ? key : undefined);
        whitespace();
        const end = text[at++];
        if (end === "}") return;
        if (end !== ",") invalid("Expected JSON object delimiter.");
      }
    }
    if (text[at] === "[") {
      at++;
      whitespace();
      if (text[at] === "]") {
        at++;
        return;
      }
      while (true) {
        value(level + 1);
        whitespace();
        const end = text[at++];
        if (end === "]") return;
        if (end !== ",") invalid("Expected JSON array delimiter.");
      }
    }
    if (text[at] === '"') {
      string();
      return;
    }
    const start = at;
    while (at < text.length && !/[ \t\r\n,}\]]/.test(text[at]!)) at++;
    if (start === at) invalid("Missing JSON value.");
    // Number() would round fractions/underflow to valid-looking integer authority.
    // Only these direct root fields use the narrower decimal-integer writer profile.
    if (fileAuthority && (authorityKey === "size" || authorityKey === "lastModifiedDate")) {
      const token = text.slice(start, at), maximum = "9007199254740991";
      if (
        !/^(?:0|[1-9][0-9]*)$/.test(token) || token.length > maximum.length ||
        (token.length === maximum.length && token > maximum)
      ) {
        invalid(`ArFS ${authorityKey} requires an exact safe decimal integer token.`);
      }
    }
  }
  value(0);
  whitespace();
  if (at !== text.length) invalid("Trailing JSON bytes.");
  try {
    return JSON.parse(text);
  } catch {
    invalid("Malformed ArFS JSON.");
  }
}

/** Inspect explicitly selected public ArFS 0.15 revisions without acquiring a gateway or file payload. */
export async function openArfs(input: ArfsInputType, options: ArfsOptionsType = {}): Promise<ArfsViewType> {
  options = { ...options };
  const policy = {
    metadata: options.maxMetadataBytes ?? 1048576,
    total: options.maxTotalMetadataBytes ?? 16777216,
    entities: options.maxEntities ?? 10000,
    index: options.maxIndexBytes ?? 16777216,
    tags: options.maxTags ?? 64,
    tag: options.maxTagBytes ?? 4096,
    tagTotal: options.maxTagTotalBytes ?? 16384,
    name: options.maxNameBytes ?? 4096,
    depth: options.maxJsonDepth ?? 16,
    tokens: options.maxJsonTokens ?? 100000,
  };
  const hard = {
    metadata: 4194304,
    total: 67108864,
    entities: 65536,
    index: 67108864,
    tags: 256,
    tag: 65536,
    tagTotal: 65536,
    name: 65536,
    depth: 64,
    tokens: 1000000,
  };
  for (const [key, n] of Object.entries(policy)) {
    integer(n, key);
    cap(n, hard[key as keyof typeof hard], `ArFS ${key} policy ceiling`);
  }
  options.signal?.throwIfAborted();
  const { drive: driveInput, entities: selected } = input;
  if (!Array.isArray(selected)) throw new TypeError("ArFS requires a finite selected inventory array.");
  const entityCount = selected.length;
  cap(entityCount, policy.entities, "ArFS selected entities");
  const records: {
    transactionId: string;
    owner: string;
    tags: readonly ArfsTagType[];
    source: StableSourceType;
    authority: Map<string, string>;
  }[] = [];
  let retained = 0, total = 0;
  const retain = (count: number): void => {
    cap(count, policy.index - retained, "ArFS retained index estimate");
    retained += count;
  };
  const txids = new Set<string>();
  // Authority fields are singular even when a repeated value is identical. Unknown tags can repeat inertly.
  const singular = new Set([
    "ArFS",
    "App-Name",
    "App-Version",
    "Content-Type",
    "Entity-Type",
    "Unix-Time",
    "Drive-Id",
    "Folder-Id",
    "File-Id",
    "Parent-Folder-Id",
    "Drive-Privacy",
    "Cipher",
    "Cipher-IV",
    "Drive-Auth-Mode",
    "Drive-Signature",
    "Signature-Type",
    "Pinned-Data-Tx",
  ]);
  for (let descriptorIndex = 0; descriptorIndex <= entityCount; descriptorIndex++) {
    const descriptor = descriptorIndex === 0 ? driveInput : selected[descriptorIndex - 1]!;
    const { transactionId, owner, tags, source } = descriptor;
    txid(transactionId);
    txid(owner);
    if (txids.has(transactionId)) invalid("Duplicate selected metadata transaction ID.");
    txids.add(transactionId);
    if (!Array.isArray(tags)) throw new TypeError("ArFS decoded tags must be an array.");
    const tagCount = tags.length;
    cap(tagCount, policy.tags, "ArFS tags");
    let tagBytes = 0;
    const values = new Map<string, string>();
    const copied: ArfsTagType[] = [];
    for (let tagIndex = 0; tagIndex < tagCount; tagIndex++) {
      const { name, value } = tags[tagIndex]!;
      tagBytes += utf8(name, policy.tag, "ArFS tag name") + utf8(value, policy.tag, "ArFS tag value");
      cap(tagBytes, policy.tagTotal, "ArFS aggregate tags");
      if (singular.has(name) && values.has(name)) invalid(`Duplicate ArFS authority tag ${name}.`);
      values.set(name, value);
      copied.push(Object.freeze({ name, value }));
    }
    const snapshot = capture(source);
    cap(snapshot.size, policy.metadata, "ArFS metadata bytes");
    total += snapshot.size;
    cap(total, policy.total, "ArFS aggregate metadata bytes");
    retain(
      512 + snapshot.size * 4 + tagBytes * 2 + tagCount * 64 +
        utf8(snapshot.identity, 65536, "ArFS source identity") * 2,
    );
    records.push({ transactionId, owner, tags: Object.freeze(copied), source: snapshot, authority: values });
  }
  const lifetime = authority(options);
  // Entire known metadata cost is admitted before the first source callback or raw text buffer allocation.
  const planned = {
    sourceBytes: total,
    requests: records.reduce((sum, r) => sum + Math.ceil(r.source.size / 65536), 0),
    decodedBytes: total,
    outputBytes: 0,
  };
  for (const [kind, count] of Object.entries(planned)) {
    for (const ledger of lifetime) ledger.reserve(kind as keyof ArchiveWorkType, count);
  }
  const work = { sourceBytes: 0, requests: 0, decodedBytes: 0, outputBytes: 0 };
  const output: (ArfsDriveType | ArfsFolderType | ArfsFileType)[] = [];
  const logical = new Set<string>();
  for (const [index, record] of records.entries()) {
    const tag = (name: string): string => {
      const value = record.authority.get(name);
      if (value === undefined) invalid(`Missing ArFS ${name} tag.`);
      return value;
    };
    if (tag("ArFS") !== "0.15") unsupported("Only explicitly selected ArFS 0.15 metadata is supported.");
    if (
      tag("Content-Type") !== "application/json" || record.authority.has("Cipher") || record.authority.has("Cipher-IV")
    ) unsupported("Only unencrypted public ArFS JSON is supported.");
    const kind = tag("Entity-Type");
    if (!["drive", "folder", "file"].includes(kind)) {
      unsupported("ArFS snapshots, state and other entity types are not this profile.");
    }
    if ((index === 0) !== (kind === "drive")) {
      invalid("ArFS inventory must select one drive followed by folder/file revisions.");
    }
    if (kind === "drive" && tag("Drive-Privacy") !== "public") {
      unsupported("Private drives require a separate authenticated decryption profile.");
    }
    const driveId = uuid(tag("Drive-Id"));
    const id = kind === "drive" ? driveId : uuid(tag(kind === "file" ? "File-Id" : "Folder-Id"));
    if (logical.has(id)) invalid("Duplicate selected logical UUID (case-insensitive).");
    logical.add(id);
    const rawTime = tag("Unix-Time");
    if (!/^(?:0|[1-9][0-9]*)$/.test(rawTime) || !Number.isSafeInteger(Number(rawTime))) {
      invalid("ArFS Unix-Time must be nonnegative safe integer seconds.");
    }
    // Pre-reserved opening work is charged only once; collection still validates all native byte extents.
    const collected = await collect(record.source, 0, record.source.size, [], options.signal, true);
    for (const key of Object.keys(work) as (keyof ArchiveWorkType)[]) work[key] += collected.work[key];
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(collected.bytes);
    } catch {
      invalid("ArFS metadata requires strict UTF8.");
    }
    if (text.charCodeAt(0) === 0xfeff) invalid("ArFS JSON BOM is outside this profile.");
    const parsed = jsonOf(text, policy.depth, policy.tokens, policy.metadata, kind === "file");
    const base = entitySchema.safeParse(parsed);
    if (!base.success) invalid("Malformed ArFS name or isHidden field.");
    utf8(base.data.name, policy.name, "ArFS literal name");
    const parentRaw = record.authority.get("Parent-Folder-Id");
    const parentId = parentRaw === undefined ? undefined : uuid(parentRaw);
    const common = {
      id,
      driveId,
      transactionId: record.transactionId,
      owner: record.owner,
      name: base.data.name,
      isHidden: base.data.isHidden ?? false,
      unixTime: Number(rawTime),
      tags: record.tags,
      metadataJson: text,
      metadataSource: Object.freeze({
        size: record.source.size,
        identity: record.source.identity,
        stability: record.source.stability,
      }),
      ...(parentId === undefined ? {} : { parentId }),
    };
    if (kind === "drive") {
      if (parentId !== undefined) invalid("Drive metadata cannot select a parent folder.");
      const drive = driveSchema.safeParse(parsed);
      if (!drive.success) invalid("ArFS drive requires rootFolderId.");
      output.push(Object.freeze({ ...common, kind: "drive", rootFolderId: uuid(drive.data.rootFolderId) }));
    } else if (kind === "folder") output.push(Object.freeze({ ...common, kind: "folder" }));
    else {
      if (parentId === undefined) invalid("ArFS file requires Parent-Folder-Id.");
      const file = fileSchema.safeParse(parsed);
      if (!file.success) invalid("Malformed public ArFS file authority fields.");
      txid(file.data.dataTxId);
      utf8(file.data.dataContentType, policy.tag, "ArFS data content type");
      if (file.data.pinnedDataOwner !== undefined) txid(file.data.pinnedDataOwner);
      const pin = record.authority.get("Pinned-Data-Tx");
      if (pin !== undefined && txid(pin) !== file.data.dataTxId) invalid("Pinned-Data-Tx differs from file dataTxId.");
      const { pinnedDataOwner, ...fields } = file.data;
      // File data admission does not acquire bytes and cannot infer provenance from an ID.
      const binding = (data: ArfsDataInputType): StableSourceType => {
        options.signal?.throwIfAborted();
        if (txid(data.transactionId) !== fields.dataTxId) {
          invalid("Explicit data transaction ID differs from selected metadata.");
        }
        const source = capture(data.source);
        if (source.size !== fields.size) invalid("Explicit data size differs from selected metadata.");
        return source;
      };
      const read = async (
        source: ByteSourceType,
        call: ArfsReadOptionsType,
        parents: readonly ArchiveLedgerType[],
        signal: AbortSignal | undefined,
      ): Promise<ArfsReadType> => {
        const offset = call.offset ?? 0, length = call.length ?? source.size - offset;
        return await collect(source, offset, length, authority(call, parents), combined([signal, call.signal]), false);
      };
      const entity: ArfsFileType = Object.freeze({
        ...common,
        kind: "file",
        ...fields,
        ...(pinnedDataOwner === undefined ? {} : { pinnedDataOwner }),
        async read(data: ArfsDataInputType, call: ArfsReadOptionsType = {}): Promise<ArfsReadType> {
          call = { ...call };
          return await read(binding(data), call, lifetime, options.signal);
        },
        source(data: ArfsDataInputType, call: ArfsCallOptionsType = {}): ByteSourceType {
          call = { ...call };
          const source = binding(data);
          const ledgers = authority(call, lifetime), signal = combined([options.signal, call.signal]);
          signal?.throwIfAborted();
          return Object.freeze({
            size: source.size,
            identity: JSON.stringify([record.transactionId, fields.dataTxId, source.identity, source.size]),
            stability: source.stability,
            async read(
              offset: number,
              length: number,
              next: { readonly signal?: AbortSignal } = {},
            ): Promise<Uint8Array> {
              const { signal: childSignal } = next;
              return (await read(
                source,
                { offset, length, ...(childSignal ? { signal: childSignal } : {}) },
                ledgers,
                signal,
              )).bytes;
            },
          });
        },
      });
      output.push(entity);
    }
  }
  const drive = output[0];
  if (drive?.kind !== "drive") invalid("Missing selected drive.");
  const entities = output.slice(1) as (ArfsFolderType | ArfsFileType)[];
  const byId = new Map(entities.map((e) => [e.id, e]));
  const issues: ArfsIssueType[] = [];
  const root = byId.get(drive.rootFolderId);
  if (!root) issues.push(Object.freeze({ code: "missing-root-folder", id: drive.rootFolderId }));
  else if (root.kind !== "folder" || root.parentId !== undefined) invalid("Selected root must be a parentless folder.");
  // Linear coloring bounds parent traversal even when the supplied inventory contains a long chain.
  const done = new Set<string>();
  for (const entity of entities) {
    if (entity.driveId !== drive.id || entity.owner !== drive.owner) {
      invalid("Selected entity belongs to a different drive or metadata owner.");
    }
    if (entity.kind === "folder" && entity.id !== drive.rootFolderId && entity.parentId === undefined) {
      invalid("Nonroot folder requires a parent.");
    }
    if (entity.parentId && !byId.has(entity.parentId)) {
      issues.push(Object.freeze({ code: "missing-parent", id: entity.id }));
    }
    const path = new Set<string>();
    let current: ArfsFolderType | ArfsFileType | undefined = entity;
    while (current && !done.has(current.id)) {
      if (path.has(current.id)) invalid("Cycle in supplied ArFS folder references.");
      path.add(current.id);
      const parent: ArfsFolderType | ArfsFileType | undefined = current.parentId === undefined
        ? undefined
        : byId.get(current.parentId);
      if (parent && parent.kind !== "folder") invalid("ArFS parent identity selects a file.");
      current = parent;
    }
    for (const id of path) done.add(id);
  }
  const frozen = Object.freeze(entities);
  return Object.freeze({
    profile: "public-0.15",
    scope: "supplied-selected-revisions",
    integrity: "caller-supplied-metadata",
    drive,
    entities: frozen,
    issues: Object.freeze(issues),
    work: Object.freeze(work),
    file(id: string): ArfsFileType {
      options.signal?.throwIfAborted();
      const entity = byId.get(uuid(id));
      if (entity?.kind !== "file") invalid("File UUID has no selected file revision.");
      return entity;
    },
    list(folderId: string) {
      options.signal?.throwIfAborted();
      const id = uuid(folderId);
      if (byId.get(id)?.kind !== "folder") invalid("Folder UUID has no selected folder revision.");
      return Object.freeze({
        scope: "supplied-selected-revisions" as const,
        entries: Object.freeze(frozen.filter((e) => e.parentId === id)),
      });
    },
  });
}
