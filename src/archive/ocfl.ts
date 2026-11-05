/** OCFL 1.1 inventory inspection and selected-content fixity over caller-supplied files. @module */
import { z } from "zod";
import type { ByteSourceType } from "../source.ts";
import { sourceRange } from "../source.ts";
import { ArchiveBudget, ArchiveError, createArchiveLedger, integer, invalid, unsupported } from "./record.ts";
import type { ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "./record.ts";
export { ArchiveError, createArchiveLedger } from "./record.ts";
export type { ArchiveErrorCodeType, ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "./record.ts";

// Schemas enforce only the serialized shape. Cross-record path and digest invariants follow below.
const userSchema: z.ZodObject<{ name: z.ZodString; address: z.ZodOptional<z.ZodString> }> = z.strictObject({
  name: z.string(),
  address: z.string().optional(),
});
const versionSchema: z.ZodObject<{
  created: z.ZodString;
  state: z.ZodRecord<z.ZodString, z.ZodArray<z.ZodString>>;
  message: z.ZodOptional<z.ZodString>;
  user: z.ZodOptional<typeof userSchema>;
}> = z.strictObject({
  created: z.string(),
  state: z.record(z.string(), z.array(z.string())),
  message: z.string().optional(),
  user: userSchema.optional(),
});
const inventorySchema: z.ZodObject<{
  id: z.ZodString;
  type: z.ZodLiteral<"https://ocfl.io/1.1/spec/#inventory">;
  digestAlgorithm: z.ZodEnum<{ sha256: "sha256"; sha512: "sha512" }>;
  head: z.ZodString;
  contentDirectory: z.ZodOptional<z.ZodString>;
  manifest: z.ZodRecord<z.ZodString, z.ZodArray<z.ZodString>>;
  versions: z.ZodRecord<z.ZodString, typeof versionSchema>;
  fixity: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodRecord<z.ZodString, z.ZodArray<z.ZodString>>>>;
}> = z.strictObject({
  id: z.string().min(1),
  type: z.literal("https://ocfl.io/1.1/spec/#inventory"),
  digestAlgorithm: z.enum(["sha256", "sha512"]),
  head: z.string(),
  contentDirectory: z.string().optional(),
  manifest: z.record(z.string(), z.array(z.string())),
  versions: z.record(z.string(), versionSchema),
  fixity: z.record(z.string(), z.record(z.string(), z.array(z.string()))).optional(),
});
/** Validated metadata keeps unsupported fixity algorithm labels inert. */
export type OcflInventoryType = z.infer<typeof inventorySchema>;
/** Literal object-relative paths; the reader never discovers files or follows links. */
export interface OcflInputType {
  readonly path: string;
  readonly source: ByteSourceType;
}
/** Source evidence applies to one physical file, not an atomic snapshot of the object. */
export interface OcflFileType {
  readonly path: string;
  readonly size: number;
  readonly identity?: string;
  readonly stability: "immutable" | "provider" | "caller" | "unverified";
}
/** Logical state and physical copies are separate. The manifest array has no preferred replica. */
export interface OcflEntryType {
  readonly version: string;
  readonly path: string;
  readonly digest: string;
  readonly copies: readonly { readonly path: string; readonly file?: OcflFileType }[];
}
/** These diagnostics cover supplied files only. Historical inventories remain unexamined. */
export interface OcflCoverageType {
  readonly scope: "supplied-object-files";
  readonly issues: readonly {
    readonly code:
      | "missing-content"
      | "unlisted-content"
      | "declaration-missing"
      | "declaration-mismatch"
      | "sidecar-missing"
      | "sidecar-mismatch"
      | "head-inventory-missing"
      | "head-inventory-mismatch";
    readonly path: string;
  }[];
  readonly headInventory: "equal" | "missing" | "different";
  readonly historicalInventories: "unexamined";
}
/** Ceilings are reader policy, not OCFL format limits. All counts are finite safe integers. */
export interface OcflOpenOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
  readonly allowUnverifiedSource?: boolean;
  /** Default 10000. */ readonly maxFiles?: number;
  /** Default 1000. */ readonly maxVersions?: number;
  /** Total manifest/state/fixity path references and diagnostics; default 100000. */ readonly maxReferences?: number;
  /** Default 1 MiB, hard 16 MiB. */ readonly maxInventoryBytes?: number;
  /** UTF8 path bytes, default 8192. */ readonly maxPathBytes?: number;
  /** Retained raw JSON, source names and metadata estimate, default 16 MiB; not a JS heap bound. */ readonly maxMetadataBytes?:
    number;
  /** JSON nesting default 16, hard 64. */ readonly maxJsonDepth?: number;
  /** JSON tokens default 500000. */ readonly maxJsonTokens?: number;
  /** UTF8 bytes per decoded JSON string, default 65536. */ readonly maxStringBytes?: number;
  /** Physical read chunk default 4096, maximum 65536. */ readonly maxChunkBytes?: number;
}
/** An explicit copy is required when a digest has more than one manifest path. */
export interface OcflSelectOptionsType extends ArchiveLimitsType {
  readonly contentPath?: string;
  readonly signal?: AbortSignal;
}
/** Whole-buffer WebCrypto is deliberately bounded, not presented as a streaming hash. */
export interface OcflVerifyOptionsType extends OcflSelectOptionsType {
  readonly subtle: Pick<SubtleCrypto, "digest">;
  /** Default 1 MiB, hard 16 MiB per verification. */ readonly maxVerifyBytes?: number;
}
/** Verification concerns exact cached inventory bytes or one selected physical content copy. */
export interface OcflVerificationType {
  readonly scope: "inventory-digest" | "selected-content";
  readonly algorithm: "sha256" | "sha512";
  readonly digest: string;
  readonly path: string;
  readonly file: OcflFileType;
  readonly version?: string;
  readonly logicalPath?: string;
  readonly work: ArchiveWorkType;
}
/** No resource ownership transfers. Sources stay valid only as long as caller-owned resources do. */
export interface OcflArchiveType {
  readonly inventory: OcflInventoryType;
  readonly files: readonly OcflFileType[];
  readonly coverage: OcflCoverageType;
  readonly work: ArchiveWorkType;
  entries(version: string): readonly OcflEntryType[];
  source(version: string, path: string, options?: OcflSelectOptionsType): ByteSourceType;
  read(
    version: string,
    path: string,
    options?: OcflSelectOptionsType,
  ): Promise<{ readonly bytes: Uint8Array; readonly integrity: "none"; readonly work: ArchiveWorkType }>;
  verifyInventory(options: OcflVerifyOptionsType): Promise<OcflVerificationType>;
  verifyContent(version: string, path: string, options: OcflVerifyOptionsType): Promise<OcflVerificationType>;
}

/** Preflight allocation and metadata counters before producing arrays or encoded strings. */
function cap(value: number, maximum: number, label: string): void {
  if (value > maximum) throw new ArchiveError("budget-exceeded", `${label} limit exceeded.`);
}
function utf8(value: string, maximum: number, label: string): number {
  cap(value.length, maximum, label);
  // TextEncoder otherwise silently replaces unpaired surrogates, creating aliases.
  if (!value.isWellFormed()) invalid(`${label} has an unpaired surrogate.`);
  const bytes = new TextEncoder().encode(value).length;
  cap(bytes, maximum, label);
  return bytes;
}
function pathOf(value: string, maximum: number): void {
  if (typeof value !== "string") invalid("OCFL paths must be strings.");
  utf8(value, maximum, "OCFL path bytes");
  const controls = Array.from(value).some((character) =>
    character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
  );
  if (
    !value || controls || value.includes("\\") || /^[A-Za-z]:/.test(value) ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    invalid("OCFL paths must be safe literal relative paths without empty or dot components.");
  }
}
/** Append a separator before sorting so punctuation cannot hide a file/descendant conflict. */
function nonconflicting(paths: readonly string[]): void {
  const ordered = paths.map((path) => path + "/").sort();
  for (let index = 1; index < ordered.length; index++) {
    if (ordered[index]!.startsWith(ordered[index - 1]!)) invalid("Duplicate or conflicting OCFL file paths.");
  }
}

function hex(value: string, length?: number): string {
  if (!/^[0-9a-fA-F]+$/.test(value) || (length !== undefined && value.length !== length)) {
    invalid("Malformed OCFL hexadecimal digest.");
  }
  return value.toLowerCase();
}
/** Parse duplicate-aware JSON before JSON.parse discards overwritten keys, including escaped duplicates. */
function jsonOf(text: string, depth: number, tokens: number, stringBytes: number): unknown {
  let at = 0;
  let count = 0;
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
        cap(at - start - 2, stringBytes * 6, "JSON encoded string bytes");
        let value: unknown;
        try {
          value = JSON.parse(text.slice(start, at));
        } catch {
          invalid("Malformed JSON string.");
        }
        if (typeof value !== "string") invalid("Malformed JSON string.");
        utf8(value, stringBytes, "JSON string bytes");
        return value;
      }
    }
    invalid("Unterminated JSON string.");
  }
  function value(level: number, scope: "root" | "fixity" | "other" = "other"): void {
    cap(level, depth, "JSON depth");
    cap(++count, tokens, "JSON tokens");
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
        cap(++count, tokens, "JSON tokens");
        whitespace();
        const key = string();
        if (keys.has(key)) invalid("Duplicate decoded JSON object key.");
        // Zod intentionally discards this dictionary key. Reject it where it is not an inert algorithm label.
        if (key === "__proto__" && scope !== "fixity") invalid("Reserved JSON dictionary key in OCFL metadata.");
        keys.add(key);
        whitespace();
        if (text[at++] !== ":") invalid("Expected JSON colon.");
        value(level + 1, scope === "root" && key === "fixity" ? "fixity" : "other");
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
  }
  value(0, "root");
  whitespace();
  if (at !== text.length) invalid("Trailing JSON bytes.");
  try {
    return JSON.parse(text);
  } catch {
    invalid("Malformed inventory JSON.");
  }
}
/** RFC3339 profile admits calendar-valid dates and zones, but refuses leap seconds without a leap-second table. */
function timestamp(value: string): void {
  const m = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!m) invalid("OCFL created requires an RFC3339 timestamp with seconds and zone.");
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  if (second === 60) unsupported("OCFL timestamp leap seconds are outside this reader profile.");
  const days = [
    31,
    year! % 4 === 0 && (year! % 100 !== 0 || year! % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (
    month! < 1 || month! > 12 || day! < 1 || day! > days[month! - 1]! || hour! > 23 || minute! > 59 || second! > 59 ||
    (m[7] && (+m[8]! > 23 || +m[9]! > 59))
  ) invalid("Invalid OCFL timestamp calendar or zone.");
}
function ledgerOf(options: ArchiveLimitsType): ArchiveLedgerType {
  const local = createArchiveLedger(options);
  const outer = options.ledger;
  return {
    reserve(kind, count) {
      local.reserve(kind, count);
      outer?.reserve(kind, count);
    },
    inspect: () => local.inspect(),
  };
}
/** Reserve whole-buffer and physical acquisition before allocation; internal reads do not double-charge the outer ledger. */
async function bytesOf(
  source: ByteSourceType,
  offset: number,
  length: number,
  options: OcflSelectOptionsType,
  chunk: number,
  decoded: boolean,
): Promise<{ bytes: Uint8Array; work: ArchiveWorkType }> {
  sourceRange(source.size, offset, length);
  options.signal?.throwIfAborted();
  const outer = options.ledger;
  const work = new ArchiveBudget(source, {
    ...options,
    ...(outer
      ? {
        ledger: {
          reserve(kind, count) {
            if (kind !== "sourceBytes" && kind !== "requests") outer.reserve(kind, count);
          },
          inspect: () => outer.inspect(),
        },
      }
      : {}),
  }, options.signal);
  cap(length, work.limits.maxSourceBytes, "OCFL source bytes");
  cap(Math.ceil(length / chunk), work.limits.maxRequests, "OCFL requests");
  outer?.reserve("sourceBytes", length);
  outer?.reserve("requests", Math.ceil(length / chunk));
  if (decoded) work.decoded(length);
  else work.output(length);
  const bytes = new Uint8Array(length);
  for (let written = 0; written < length;) {
    const part = await work.read(offset + written, Math.min(chunk, length - written));
    bytes.set(part, written);
    written += part.length;
  }
  options.signal?.throwIfAborted();
  return { bytes, work: work.inspect() };
}
/** Parse one explicitly supplied OCFL 1.1 object inventory. No write, migration, discovery or fetch occurs. */
export async function openOcfl(
  input: readonly OcflInputType[],
  options: OcflOpenOptionsType = {},
): Promise<OcflArchiveType> {
  options = { ...options };
  const policy = {
    files: options.maxFiles ?? 10000,
    versions: options.maxVersions ?? 1000,
    refs: options.maxReferences ?? 100000,
    inventory: options.maxInventoryBytes ?? 1024 * 1024,
    path: options.maxPathBytes ?? 8192,
    metadata: options.maxMetadataBytes ?? 16 * 1024 * 1024,
    depth: options.maxJsonDepth ?? 16,
    tokens: options.maxJsonTokens ?? 500000,
    string: options.maxStringBytes ?? 65536,
    chunk: options.maxChunkBytes ?? 4096,
  };
  for (const [key, value] of Object.entries(policy)) integer(value, key);
  if (policy.inventory > 16 * 1024 * 1024 || policy.depth > 64 || policy.chunk < 1 || policy.chunk > 65536) {
    throw new RangeError("OCFL inventory/depth/chunk implementation ceiling exceeded.");
  }
  if (!Array.isArray(input)) throw new TypeError("OCFL requires an explicit file inventory array.");
  cap(input.length, policy.files, "OCFL files");
  const sources = new Map<string, ByteSourceType>();
  const provenance = new Map<string, OcflFileType>();
  let retained = 0;
  let references = 0;
  function retain(count: number): void {
    cap(count, policy.metadata - retained, "OCFL metadata");
    retained += count;
  }
  function reference(path: string): void {
    cap(++references, policy.refs, "OCFL references");
    pathOf(path, policy.path);
    retain(128 + utf8(path, policy.path, "OCFL path bytes"));
  }
  for (const item of input) {
    pathOf(item.path, policy.path);
    if (sources.has(item.path)) invalid("Duplicate supplied OCFL file.");
    retain(128 + utf8(item.path, policy.path, "OCFL path bytes"));
    const { size, identity, stability } = item.source;
    integer(size, "OCFL source size");
    if (stability !== undefined && !["immutable", "provider", "caller"].includes(stability)) {
      throw new TypeError("Unknown OCFL source stability.");
    }
    if (!stability && !options.allowUnverifiedSource) {
      unsupported("OCFL requires stable sources or explicit unverified-source acceptance.");
    }
    sources.set(item.path, {
      size,
      read: item.source.read.bind(item.source),
      ...(identity === undefined ? {} : { identity }),
      ...(stability === undefined ? {} : { stability }),
    });
    provenance.set(
      item.path,
      Object.freeze({
        path: item.path,
        size,
        ...(identity === undefined ? {} : { identity }),
        stability: stability ?? "unverified",
      }),
    );
  }
  nonconflicting([...sources.keys()]);
  const ledger = ledgerOf(options);
  async function metadata(path: string, maximum: number): Promise<Uint8Array> {
    const source = sources.get(path);
    if (!source) invalid(`Missing OCFL metadata: ${path}.`);
    cap(source.size, maximum, "OCFL metadata file bytes");
    retain(source.size * 4);
    return (await bytesOf(source, 0, source.size, { ...options, ledger }, policy.chunk, true)).bytes;
  }
  const raw = await metadata("inventory.json", policy.inventory);
  if (raw[0] === 239 && raw[1] === 187 && raw[2] === 191) invalid("OCFL inventory UTF8 must not have a BOM.");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    invalid("OCFL inventory is not UTF8.");
  }
  const candidate: unknown = jsonOf(text, policy.depth, policy.tokens, policy.string);
  const parsed = inventorySchema.safeParse(candidate);
  if (!parsed.success) invalid("OCFL inventory shape or version is outside the strict 1.1 profile.");
  const inventory = parsed.data;
  // Preserve an inert algorithm named __proto__ without giving it object-prototype authority.
  // Its skipped block must be validated separately before restoration to the admitted metadata.
  const rawFixity = (candidate as { fixity?: Record<string, unknown> }).fixity;
  if (rawFixity && Object.hasOwn(rawFixity, "__proto__")) {
    const block = z.record(z.string(), z.array(z.string())).safeParse(rawFixity["__proto__"]);
    if (!block.success) invalid("Malformed OCFL fixity algorithm block.");
    Object.defineProperty(inventory.fixity!, "__proto__", { value: block.data, enumerable: true, configurable: true });
  }
  const digestLength = inventory.digestAlgorithm === "sha256" ? 64 : 128;
  const directory = inventory.contentDirectory ?? "content";
  pathOf(directory, policy.path);
  if (directory.includes("/")) invalid("OCFL contentDirectory must be one component.");
  const versions = Object.keys(inventory.versions);
  cap(versions.length, policy.versions, "OCFL versions");
  if (!versions.length) invalid("OCFL inventory needs at least one version.");
  // The specification's E011 rule forbids a padded sequence from exhausting its leading zero.
  // For example, v0001..v0100 is valid, while v001..v100 crosses the forbidden boundary.
  const padded = /^v0/.test(inventory.head);
  const width = inventory.head.length;
  const ordered = versions.map((name) => {
    if (
      !/^v[0-9]+$/.test(name) ||
      (padded ? name.length !== width || !name.startsWith("v0") : !/^v[1-9][0-9]*$/.test(name))
    ) invalid("Mixed or invalid OCFL version padding.");
    const index = BigInt(name.slice(1));
    if (index < 1n || index > BigInt(versions.length)) {
      invalid("OCFL version sequence has gaps or exceeds admitted versions.");
    }
    return { name, index: Number(index) };
  }).sort((a, b) => a.index - b.index);
  for (let i = 0; i < ordered.length; i++) {
    if (ordered[i]!.index !== i + 1) invalid("OCFL versions must be continuous.");
  }
  if (ordered.at(-1)!.name !== inventory.head) invalid("OCFL head must name the highest version.");
  const versionNames = new Set(versions);
  const manifest = new Map<string, readonly string[]>();
  const physical = new Set<string>();
  for (const [digest, paths] of Object.entries(inventory.manifest)) {
    const canonical = hex(digest, digestLength);
    if (manifest.has(canonical)) invalid("Case-colliding OCFL manifest digests.");
    if (!paths.length) invalid("Empty OCFL manifest copy array.");
    for (const path of paths) {
      reference(path);
      const parts = path.split("/");
      if (!versionNames.has(parts[0]!) || parts[1] !== directory || parts.length < 3) {
        invalid("OCFL content path is outside an admitted version content directory.");
      }
      if (physical.has(path)) invalid("OCFL physical content paths must be globally unique.");
      physical.add(path);
    }
    manifest.set(canonical, Object.freeze(paths));
  }
  nonconflicting([...physical]);
  const copyRecords = new Map(
    [...manifest].map(([digest, paths]) => [
      digest,
      Object.freeze(
        paths.map((path) => Object.freeze({ path, ...(provenance.has(path) ? { file: provenance.get(path)! } : {}) })),
      ),
    ]),
  );
  const usedDigests = new Set<string>();
  const states = new Map<string, Map<string, OcflEntryType>>();
  for (const { name } of ordered) {
    const version = inventory.versions[name]!;
    timestamp(version.created);
    const entries = new Map<string, OcflEntryType>();
    const stateDigests = new Set<string>();
    for (const [digest, paths] of Object.entries(version.state)) {
      const canonical = hex(digest, digestLength);
      if (stateDigests.has(canonical)) invalid("Case-colliding OCFL state digests.");
      stateDigests.add(canonical);
      const copies = manifest.get(canonical);
      if (!copies) invalid("OCFL state refers to an unknown manifest digest.");
      if (!paths.length) invalid("Empty OCFL state path array.");
      usedDigests.add(canonical);
      for (const path of paths) {
        reference(path);
        if (entries.has(path)) invalid("Duplicate OCFL logical path in version.");
        entries.set(
          path,
          Object.freeze({ version: name, path, digest: canonical, copies: copyRecords.get(canonical)! }),
        );
      }
    }
    nonconflicting([...entries.keys()]);
    states.set(name, entries);
  }
  for (const digest of manifest.keys()) {
    if (!usedDigests.has(digest)) invalid("OCFL manifest digest is not used in any version state.");
  }
  for (const [algorithm, block] of Object.entries(inventory.fixity ?? {})) {
    const seen = new Set<string>();
    const pathsSeen = new Set<string>();
    const length = new Map<string, number>([["md5", 32], ["sha1", 40], ["sha256", 64], ["sha512", 128], [
      "blake2b-512",
      128,
    ]]).get(algorithm);
    for (const [digest, paths] of Object.entries(block)) {
      const canonical = hex(digest, length);
      if (seen.has(canonical)) invalid("Case-colliding OCFL fixity digests.");
      seen.add(canonical);
      for (const path of paths) {
        reference(path);
        if (!physical.has(path) || pathsSeen.has(path)) {
          invalid("OCFL fixity must refer once to manifested content paths.");
        }
        pathsSeen.add(path);
      }
    }
  }
  // Freeze the serialized metadata recursively so callers cannot change later selection or integrity authority.
  function freeze(value: unknown): void {
    if (value && typeof value === "object") {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
  }
  freeze(inventory);
  const issues: { code: OcflCoverageType["issues"][number]["code"]; path: string }[] = [];
  function issue(code: OcflCoverageType["issues"][number]["code"], path: string): void {
    reference(path);
    issues.push(Object.freeze({ code, path }));
  }
  for (const path of physical) if (!sources.has(path)) issue("missing-content", path);
  for (const path of sources.keys()) {
    const parts = path.split("/");
    if (versionNames.has(parts[0]!) && parts[1] === directory && !physical.has(path)) issue("unlisted-content", path);
  }
  const declaration = "0=ocfl_object_1.1";
  if (!sources.has(declaration)) issue("declaration-missing", declaration);
  else {
    const actual = await metadata(declaration, 64);
    const wanted = new TextEncoder().encode("ocfl_object_1.1\n");
    if (actual.length !== wanted.length || !actual.every((byte, index) => byte === wanted[index])) {
      issue("declaration-mismatch", declaration);
    }
  }
  const sidecar = "inventory.json." + inventory.digestAlgorithm;
  let expected: string | undefined;
  if (!sources.has(sidecar)) issue("sidecar-missing", sidecar);
  else {
    const bytes = await metadata(sidecar, 1024);
    let sideText: string;
    try {
      sideText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      invalid("OCFL sidecar must be UTF8.");
    }
    const match = /^([0-9a-fA-F]+)[ \t]+inventory\.json(?:\r?\n)?$/.exec(sideText);
    if (!match || match[1]!.length !== digestLength) issue("sidecar-mismatch", sidecar);
    else expected = match[1]!.toLowerCase();
  }
  const headPath = inventory.head + "/inventory.json";
  let headInventory: OcflCoverageType["headInventory"] = "missing";
  if (!sources.has(headPath)) issue("head-inventory-missing", headPath);
  else {
    const head = await metadata(headPath, policy.inventory);
    headInventory = head.length === raw.length && head.every((b, i) => b === raw[i]) ? "equal" : "different";
    if (headInventory === "different") issue("head-inventory-mismatch", headPath);
  }
  const coverage: OcflCoverageType = Object.freeze({
    scope: "supplied-object-files",
    issues: Object.freeze(issues),
    headInventory,
    historicalInventories: "unexamined",
  });
  const files = Object.freeze([...provenance.values()]);
  function selection(
    version: string,
    path: string,
    selected?: string,
  ): { entry: OcflEntryType; source: ByteSourceType; file: OcflFileType } {
    const state = states.get(version);
    if (!state) throw new RangeError("Unknown OCFL version.");
    const entry = state.get(path);
    if (!entry) throw new RangeError("Unknown OCFL logical file.");
    if (selected === undefined && entry.copies.length !== 1) {
      throw new TypeError("OCFL contentPath is required for multiple physical copies.");
    }
    const chosen = selected ?? entry.copies[0]!.path;
    if (!entry.copies.some((copy) => copy.path === chosen)) {
      throw new RangeError("Selected OCFL copy does not belong to logical file digest.");
    }
    const source = sources.get(chosen);
    const file = provenance.get(chosen);
    if (!source || !file) invalid("Selected OCFL content source is missing.");
    return { entry, source, file };
  }
  function operation(call: OcflSelectOptionsType): OcflSelectOptionsType {
    const local = createArchiveLedger(call);
    const extra = call.ledger;
    return {
      ...call,
      ledger: {
        reserve(kind, count) {
          local.reserve(kind, count);
          ledger.reserve(kind, count);
          if (extra && extra !== options.ledger) extra.reserve(kind, count);
        },
        inspect: () => local.inspect(),
      },
      ...(call.signal ? { signal: call.signal } : options.signal ? { signal: options.signal } : {}),
    };
  }
  async function verify(bytes: Uint8Array, checksum: string, call: OcflVerifyOptionsType): Promise<void> {
    const result = await call.subtle.digest(
      inventory.digestAlgorithm === "sha256" ? "SHA-256" : "SHA-512",
      bytes.buffer as ArrayBuffer,
    );
    call.signal?.throwIfAborted();
    const actual = Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (actual !== checksum) {
      throw new ArchiveError("checksum-mismatch", "OCFL digest does not match exact selected bytes.");
    }
  }
  function verifyLimit(length: number, call: OcflVerifyOptionsType): void {
    const maximum = call.maxVerifyBytes ?? 1024 * 1024;
    integer(maximum, "maxVerifyBytes");
    if (maximum > 16 * 1024 * 1024) throw new RangeError("OCFL whole-buffer verification hard ceiling is 16 MiB.");
    cap(length, maximum, "OCFL whole-buffer verifier bytes");
  }
  return Object.freeze({
    inventory,
    files,
    coverage,
    work: ledger.inspect(),
    entries(version: string) {
      const state = states.get(version);
      if (!state) throw new RangeError("Unknown OCFL version.");
      return Object.freeze([...state.values()]);
    },
    source(version: string, path: string, call: OcflSelectOptionsType = {}): ByteSourceType {
      const chosen = selection(version, path, call.contentPath);
      const captured = operation({ ...call });
      return Object.freeze({
        size: chosen.source.size,
        ...(chosen.source.identity === undefined ? {} : { identity: chosen.source.identity }),
        ...(chosen.source.stability === undefined ? {} : { stability: chosen.source.stability }),
        async read(offset: number, length: number, readOptions: { signal?: AbortSignal } = {}) {
          const signal = captured.signal && readOptions.signal
            ? AbortSignal.any([captured.signal, readOptions.signal])
            : readOptions.signal ?? captured.signal;
          return (await bytesOf(
            chosen.source,
            offset,
            length,
            { ...captured, ...(signal ? { signal } : {}) },
            policy.chunk,
            false,
          )).bytes;
        },
      });
    },
    async read(version: string, path: string, call: OcflSelectOptionsType = {}) {
      const chosen = selection(version, path, call.contentPath);
      const result = await bytesOf(chosen.source, 0, chosen.source.size, operation(call), policy.chunk, false);
      return { ...result, integrity: "none" as const };
    },
    async verifyContent(version: string, path: string, call: OcflVerifyOptionsType): Promise<OcflVerificationType> {
      call = { ...call };
      const chosen = selection(version, path, call.contentPath);
      verifyLimit(chosen.source.size, call);
      const resolved = operation(call);
      const result = await bytesOf(chosen.source, 0, chosen.source.size, resolved, policy.chunk, true);
      await verify(result.bytes, chosen.entry.digest, { ...call, ...resolved });
      return {
        scope: "selected-content",
        algorithm: inventory.digestAlgorithm,
        digest: chosen.entry.digest,
        path: chosen.file.path,
        file: chosen.file,
        version,
        logicalPath: path,
        work: result.work,
      };
    },
    async verifyInventory(call: OcflVerifyOptionsType): Promise<OcflVerificationType> {
      call = { ...call };
      if (!expected) invalid("OCFL root inventory has no admitted matching sidecar.");
      verifyLimit(raw.length, call);
      const resolved = operation(call);
      resolved.signal?.throwIfAborted();
      const work = new ArchiveBudget(
        {
          size: 0,
          async read() {
            return new Uint8Array();
          },
        },
        resolved,
        resolved.signal,
      );
      work.decoded(raw.length);
      await verify(raw, expected, { ...call, ...resolved });
      return {
        scope: "inventory-digest",
        algorithm: inventory.digestAlgorithm,
        digest: expected,
        path: "inventory.json",
        file: provenance.get("inventory.json")!,
        work: work.inspect(),
      };
    },
  });
}
