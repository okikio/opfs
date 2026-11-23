/** Bounded BagIt 1.0 metadata and selected-file fixity over an explicit inventory. @module */
import type { ByteSourceType } from "../source.ts";
import { sourceRange } from "../source.ts";
import { ArchiveBudget, ArchiveError, createArchiveLedger, integer, invalid, unsupported } from "./record.ts";
import type { ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "./record.ts";
export { ArchiveError, createArchiveLedger } from "./record.ts";
export type { ArchiveErrorCodeType, ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "./record.ts";

/** Literal decoded inventory names, not host paths. Directories make an empty data/ explicit. */
export type BagitInputType = { readonly kind: "file"; readonly path: string; readonly source: ByteSourceType } | {
  readonly kind: "directory";
  readonly path: string;
};
/** Per-file provenance cannot establish an atomic snapshot across the entire bag. */
export interface BagitFileType {
  readonly path: string;
  readonly size: number;
  readonly identity?: string;
  readonly stability: "immutable" | "provider" | "caller" | "unverified";
}
/** A digest declaration remains untrusted, including when its syntax is valid. */
export interface BagitRowType {
  readonly path: string;
  readonly encodedPath: string;
  readonly checksum: string;
}
/** Unknown algorithm labels are inspectable but never mapped optimistically to WebCrypto. */
export interface BagitManifestType {
  readonly id: number;
  readonly path: string;
  readonly kind: "payload" | "tag";
  readonly algorithm: string;
  readonly rows: readonly BagitRowType[];
}
/** Bag-info values retain continuation line breaks normalized to LF; indentation is excluded. */
export interface BagitFieldType {
  readonly label: string;
  readonly value: string;
}
/** A fetch declaration has no executable URL or allocation authority. Length stays an exact decimal string. */
export interface BagitFetchType {
  readonly url: string;
  readonly length: string | null;
  readonly path: string;
}
/** Coverage refers only to this supplied inventory; it is neither RFC-wide validity nor authentication. */
export interface BagitCoverageType {
  readonly scope: "supplied-inventory";
  readonly dataDirectoryPresent: boolean;
  readonly issues: readonly {
    readonly code:
      | "missing-file"
      | "unlisted-payload"
      | "missing-tag-reference"
      | "fetch-not-manifested"
      | "fetch-size-mismatch"
      | "oxum-mismatch";
    readonly path: string;
    readonly manifest?: string;
  }[];
}
/** All values are implementation/policy ceilings, not limits imposed by BagIt. */
export interface BagitOpenOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
  readonly allowUnverifiedSource?: boolean;
  /** Default 10000 inventory records, including directories. */
  readonly maxFiles?: number;
  /** Default 64 total payload and tag manifests. */
  readonly maxManifests?: number;
  /** Default 100000 total manifest/fetch/metadata rows. */
  readonly maxRows?: number;
  /** Default 1 MiB per parsed tag file. */
  readonly maxTagBytes?: number;
  /** Default 8 MiB total parsed tag bytes. */
  readonly maxTotalTagBytes?: number;
  /** Default 8 KiB UTF8 path bytes. */
  readonly maxPathBytes?: number;
  /** Default 16 KiB UTF8 physical line bytes. */
  readonly maxLineBytes?: number;
  /** Accounted tag/path bytes plus 128 bytes per retained record; default 16 MiB. */
  readonly maxMetadataBytes?: number;
  /** Default 4096, admitted range 1..65536. */
  readonly maxChunkBytes?: number;
}
/** Buffered raw bytes do not inherit manifest fixity from a separate verification call. */
export interface BagitReadType {
  readonly bytes: Uint8Array;
  readonly integrity: "none";
  readonly work: ArchiveWorkType;
}
export interface BagitReadOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
  readonly offset?: number;
  readonly length?: number;
}
/** Explicit whole-file hashing, independent of raw preview reads. */
export interface BagitVerifyOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
  readonly subtle: Pick<SubtleCrypto, "digest">;
  /** Default 1 MiB, hard maximum 16 MiB. WebCrypto may allocate additional internal copies. */
  readonly maxVerifyBytes?: number;
}
/** One file against one manifest entry, never a whole-bag or author assertion. */
export interface BagitVerificationType {
  readonly scope: "selected-file";
  readonly integrity: "manifest-digest";
  readonly manifest: string;
  readonly file: BagitFileType;
  readonly algorithm: "SHA-256" | "SHA-512";
  readonly checksum: string;
  readonly work: ArchiveWorkType;
}
/** A frozen metadata view backed by captured, borrowed file capabilities. */
export interface BagitArchiveType {
  readonly version: "1.0";
  readonly encoding: "UTF-8";
  readonly files: readonly BagitFileType[];
  readonly manifests: readonly BagitManifestType[];
  readonly info: readonly BagitFieldType[];
  readonly fetch: readonly BagitFetchType[];
  readonly coverage: BagitCoverageType;
  readonly work: ArchiveWorkType;
  read(path: string, options?: BagitReadOptionsType): Promise<BagitReadType>;
  /** Cumulative limits cover all reads through this wrapper; no disposal ownership transfers. */
  source(path: string, options?: ArchiveLimitsType & { readonly signal?: AbortSignal }): ByteSourceType;
  verify(manifestId: number, path: string, options: BagitVerifyOptionsType): Promise<BagitVerificationType>;
}

function cap(count: number, maximum: number, label: string): void {
  if (count > maximum) throw new ArchiveError("budget-exceeded", `${label} limit exceeded.`);
}

/** Percent decoding is deliberately one pass and covers ONLY the three BagIt escapes. */
function decodePath(value: string): string {
  return value.replace(/%([\s\S]{0,2})/g, (_match, digits: string) => {
    if (/^0a$/i.test(digits)) return "\n";
    if (/^0d$/i.test(digits)) return "\r";
    if (digits === "25") return "%";
    invalid("BagIt paths may percent-encode only CR, LF and percent.");
  });
}

/** No host-path interpretation, normalization, symlink expansion or alias fallback is permitted. */
function admitPath(value: string, maximum: number): void {
  if (typeof value !== "string") invalid("BagIt paths must be literal Unicode strings.");
  // UTF8 takes at least one byte per UTF16 code unit for well-formed strings.
  cap(value.length, maximum, "BagIt path bytes");
  if (
    !value || !value.isWellFormed() || value.includes("\\") || value.includes("\0") || value.startsWith("/") ||
    /^[A-Za-z]:/.test(value) || value.startsWith("~")
  ) invalid("Unsafe BagIt relative path.");
  cap(new TextEncoder().encode(value).length, maximum, "BagIt path bytes");
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || /^[ \t]|[ \t]$/.test(part))) {
    unsupported("Empty, dot and ambiguous whitespace path components are outside this profile.");
  }
}

/** An explicit combined owner makes multi-file reads share one physical work limit. */
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

/** Exact buffered reads admit the full allocation and physical request count before starting. */
async function bytesOf(
  source: ByteSourceType,
  offset: number,
  length: number,
  options: ArchiveLimitsType & { readonly signal?: AbortSignal },
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
  cap(length, work.limits.maxSourceBytes, "BagIt source bytes");
  cap(Math.ceil(length / chunk), work.limits.maxRequests, "BagIt requests");
  // Reserve the entire verifier/preview acquisition before allocating, including aggregate limits.
  outer?.reserve("sourceBytes", length);
  outer?.reserve("requests", Math.ceil(length / chunk));
  if (decoded) work.decoded(length);
  else work.output(length);
  options.signal?.throwIfAborted();
  const bytes = new Uint8Array(length);
  for (let written = 0; written < length;) {
    const part = await work.read(offset + written, Math.min(chunk, length - written));
    bytes.set(part, written);
    written += part.length;
  }
  options.signal?.throwIfAborted();
  return { bytes, work: work.inspect() };
}

/** Parse a bounded UTF8 BagIt 1.0 metadata profile without discovering or fetching any resources. */
export async function openBagit(
  input: readonly BagitInputType[],
  options: BagitOpenOptionsType = {},
): Promise<BagitArchiveType> {
  options = { ...options };
  const policy = {
    files: options.maxFiles ?? 10000,
    manifests: options.maxManifests ?? 64,
    rows: options.maxRows ?? 100000,
    tag: options.maxTagBytes ?? 1024 * 1024,
    total: options.maxTotalTagBytes ?? 8 * 1024 * 1024,
    path: options.maxPathBytes ?? 8192,
    line: options.maxLineBytes ?? 16384,
    metadata: options.maxMetadataBytes ?? 16 * 1024 * 1024,
    chunk: options.maxChunkBytes ?? 4096,
  };
  for (const [name, value] of Object.entries(policy)) integer(value, name);
  if (policy.chunk < 1 || policy.chunk > 65536) throw new RangeError("maxChunkBytes must be 1..65536.");
  if (!Array.isArray(input)) throw new TypeError("BagIt requires an explicit inventory array.");
  cap(input.length, policy.files, "BagIt inventory records");
  const sources = new Map<string, ByteSourceType>();
  const paths = new Map<string, "file" | "directory">();
  const files: BagitFileType[] = [];
  let retained = 0;
  function retain(bytes: number): void {
    cap(bytes, policy.metadata - retained, "BagIt metadata");
    retained += bytes;
  }
  for (const entry of input) {
    admitPath(entry.path, policy.path);
    if (paths.has(entry.path)) invalid("Duplicate BagIt inventory path.");
    if (entry.kind !== "file" && entry.kind !== "directory") {
      throw new TypeError("BagIt inventory entries must be files or directories.");
    }
    paths.set(entry.path, entry.kind);
    retain(new TextEncoder().encode(entry.path).length + 128);
    if (entry.kind === "file") {
      const { size, identity, stability } = entry.source;
      integer(size, "BagIt file size");
      if (stability !== undefined && !["immutable", "provider", "caller"].includes(stability)) {
        throw new TypeError("Unknown source stability evidence.");
      }
      if (!stability && !options.allowUnverifiedSource) {
        unsupported("BagIt needs stable file sources or explicit unverified-source acceptance.");
      }
      const captured: ByteSourceType = {
        size,
        read: entry.source.read.bind(entry.source),
        ...(identity === undefined ? {} : { identity }),
        ...(stability === undefined ? {} : { stability }),
      };
      sources.set(entry.path, captured);
      files.push(
        Object.freeze({
          path: entry.path,
          size,
          ...(identity === undefined ? {} : { identity }),
          stability: stability ?? "unverified",
        }),
      );
    }
  }
  for (const name of paths.keys()) {
    const components = name.split("/");
    for (let index = 1; index < components.length; index++) {
      if (paths.get(components.slice(0, index).join("/")) === "file") {
        invalid("BagIt inventory contains a file/directory ancestor collision.");
      }
    }
  }
  options.signal?.throwIfAborted();
  const ledger = ledgerOf(options);
  let totalTag = 0;
  let rows = 0;
  function row(): void {
    cap(++rows, policy.rows, "BagIt rows");
    retain(128);
  }
  async function lines(path: string): Promise<string[]> {
    const source = sources.get(path);
    if (!source) invalid(`Required BagIt tag file is absent: ${path}`);
    cap(source.size, policy.tag, "BagIt tag bytes");
    cap(source.size, policy.total - totalTag, "BagIt total tag bytes");
    totalTag += source.size;
    retain(source.size);
    const result = await bytesOf(source, 0, source.size, { ...options, ledger }, policy.chunk, true);
    const bytes = result.bytes;
    if (bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191) invalid("UTF8 BagIt tag files must not have a BOM.");
    // Admit physical lines before split() can allocate one string slot per newline.
    let physicalLines = 0;
    let lineStart = 0;
    for (let index = 0; index < bytes.length; index++) {
      if (bytes[index] === 13 || bytes[index] === 10) {
        cap(index - lineStart, policy.line, "BagIt physical line bytes");
        cap(++physicalLines, Math.max(2, policy.rows), "BagIt tag physical lines");
        if (bytes[index] === 13 && bytes[index + 1] === 10) index++;
        lineStart = index + 1;
      }
    }
    if (lineStart < bytes.length) {
      cap(bytes.length - lineStart, policy.line, "BagIt physical line bytes");
      cap(++physicalLines, Math.max(2, policy.rows), "BagIt tag physical lines");
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      invalid("Malformed UTF8 in BagIt tag metadata.");
    }
    const resultLines = text.split(/\r\n|\r|\n/);
    if (resultLines.at(-1) === "") resultLines.pop();
    return resultLines;
  }
  const declaration = await lines("bagit.txt");
  if (
    declaration.length !== 2 || !/^BagIt-Version: /i.test(declaration[0]!) ||
    !/^Tag-File-Character-Encoding: /i.test(declaration[1]!)
  ) invalid("BagIt declaration requires exactly two ordered declaration fields.");
  if (declaration[0]!.slice(15) !== "1.0") unsupported("Only BagIt version 1.0 is supported.");
  if (declaration[1]!.slice(29).toLowerCase() !== "utf-8") unsupported("Only UTF-8 BagIt tag encoding is supported.");
  const manifestNames = files.filter((file) =>
    !file.path.includes("/") && /^(?:tag)?manifest-[a-z0-9]+\.txt$/.test(file.path)
  );
  cap(manifestNames.length, policy.manifests, "BagIt manifests");
  // Names beginning the reserved manifest prefixes may not hide malformed algorithms as opaque tags.
  for (const file of files) {
    if (
      !file.path.includes("/") && /^(?:tag)?manifest-/.test(file.path) &&
      !manifestNames.some((manifest) => manifest.path === file.path)
    ) invalid("Malformed BagIt manifest filename.");
  }
  if (!manifestNames.some((file) => file.path.startsWith("manifest-"))) {
    invalid("BagIt requires at least one payload manifest.");
  }
  const manifests: BagitManifestType[] = [];
  for (const file of manifestNames) {
    const tag = file.path.startsWith("tagmanifest-");
    const algorithm = file.path.slice(tag ? 12 : 9, -4);
    const entries: BagitRowType[] = [];
    const seen = new Set<string>();
    for (const line of await lines(file.path)) {
      row();
      const match = /^([0-9a-fA-F]+)[ \t]+(.+)$/.exec(line);
      if (!match) invalid("Malformed BagIt manifest row.");
      const encodedPath = match[2]!;
      const path = decodePath(encodedPath);
      admitPath(path, policy.path);
      if (seen.has(path)) invalid("Duplicate decoded path in a BagIt manifest.");
      seen.add(path);
      if (!tag && !path.startsWith("data/")) invalid("Payload manifest reference must remain inside data/.");
      if (tag && (path === "data" || path.startsWith("data/") || /^tagmanifest-[a-z0-9]+\.txt$/.test(path))) {
        invalid("Tag manifests must not reference payload or tagmanifest files.");
      }
      const checksum = match[1]!.toLowerCase();
      if ((algorithm === "sha256" && checksum.length !== 64) || (algorithm === "sha512" && checksum.length !== 128)) {
        invalid("Incorrect BagIt checksum length.");
      }
      if (paths.get(path) === "directory") invalid("BagIt manifests must not reference directories.");
      entries.push(Object.freeze({ path, encodedPath, checksum }));
    }
    manifests.push(
      Object.freeze({
        id: manifests.length,
        path: file.path,
        kind: tag ? "tag" : "payload",
        algorithm,
        rows: Object.freeze(entries),
      }),
    );
  }
  const pendingInfo: { label: string; values: string[] }[] = [];
  if (sources.has("bag-info.txt")) {
    for (const line of await lines("bag-info.txt")) {
      row();
      if (/^[ \t]/.test(line)) {
        if (!pendingInfo.length) invalid("BagIt metadata continuation has no preceding field.");
        pendingInfo[pendingInfo.length - 1]!.values.push(line.replace(/^[ \t]+/, ""));
      } else {
        const match = /^([^:\r\n]+):[ \t](.*)$/.exec(line);
        if (!match || /^[ \t]|[ \t]$/.test(match[1]!)) invalid("Malformed BagIt metadata field.");
        pendingInfo.push({ label: match[1]!, values: [match[2]!] });
      }
    }
  }
  const info: BagitFieldType[] = pendingInfo.map((field) => ({ label: field.label, value: field.values.join("\n") }));
  const oxum = info.filter((field) => field.label.toLowerCase() === "payload-oxum");
  if (oxum.length > 1 || (oxum.length && !/^\d+\.\d+$/.test(oxum[0]!.value))) {
    invalid("Payload-Oxum must be a single decimal byte-count.file-count value.");
  }
  const fetch: BagitFetchType[] = [];
  const fetched = new Set<string>();
  if (sources.has("fetch.txt")) {
    for (const line of await lines("fetch.txt")) {
      row();
      const match = /^(\S+)[ \t]+(\d+|-)[ \t]+(.+)$/.exec(line);
      if (
        !match || !/^[a-zA-Z][a-zA-Z0-9+.-]*:[A-Za-z0-9\-._~:/?\[\]@!$&'()*+,;=%]*$/.test(match[1]!) ||
        /%(?![0-9A-Fa-f]{2})/.test(match[1]!)
      ) {
        invalid("Malformed BagIt fetch declaration.");
      }
      const path = decodePath(match[3]!);
      admitPath(path, policy.path);
      if (!path.startsWith("data/") || paths.get(path) === "directory" || fetched.has(path)) {
        invalid("Fetch entries must have distinct payload paths.");
      }
      fetched.add(path);
      fetch.push(Object.freeze({ url: match[1]!, length: match[2] === "-" ? null : match[2]!, path }));
    }
  }
  const issues: { code: BagitCoverageType["issues"][number]["code"]; path: string; manifest?: string }[] = [];
  function issue(code: BagitCoverageType["issues"][number]["code"], path: string, manifest?: string): void {
    row();
    issues.push(Object.freeze({ code, path, ...(manifest === undefined ? {} : { manifest }) }));
  }
  const payload = files.filter((file) => file.path.startsWith("data/"));
  const payloadManifests = manifests.filter((manifest) => manifest.kind === "payload");
  const listedPaths = manifests.map((manifest) => new Set(manifest.rows.map((entry) => entry.path)));
  for (const manifest of manifests) {
    const listed = listedPaths[manifest.id]!;
    for (const entry of manifest.rows) if (!sources.has(entry.path)) issue("missing-file", entry.path, manifest.path);
    if (manifest.kind === "payload") {
      for (const file of payload) if (!listed.has(file.path)) issue("unlisted-payload", file.path, manifest.path);
    } else {
      for (const required of payloadManifests) {
        if (!listed.has(required.path)) issue("missing-tag-reference", required.path, manifest.path);
      }
    }
  }
  for (const entry of fetch) {
    for (const manifest of payloadManifests) {
      if (!listedPaths[manifest.id]!.has(entry.path)) {
        issue("fetch-not-manifested", entry.path, manifest.path);
      }
    }
    const source = sources.get(entry.path);
    if (source && entry.length !== null && BigInt(source.size) !== BigInt(entry.length)) {
      issue("fetch-size-mismatch", entry.path);
    }
  }
  if (oxum.length) {
    const bytes = payload.reduce((sum, file) => sum + BigInt(file.size), 0n);
    const [declaredBytes, declaredFiles] = oxum[0]!.value.split(".");
    if (BigInt(declaredBytes!) !== bytes || BigInt(declaredFiles!) !== BigInt(payload.length)) {
      issue("oxum-mismatch", "bag-info.txt");
    }
  }
  const frozenFiles = Object.freeze(files);
  function at(path: string): ByteSourceType {
    const source = sources.get(path);
    if (!source) throw new RangeError("BagIt file is absent from the supplied inventory.");
    return source;
  }
  return {
    version: "1.0",
    encoding: "UTF-8",
    files: frozenFiles,
    manifests: Object.freeze(manifests),
    info: Object.freeze(info.map((field) => Object.freeze(field))),
    fetch: Object.freeze(fetch),
    coverage: Object.freeze({
      scope: "supplied-inventory",
      dataDirectoryPresent: paths.get("data") === "directory",
      issues: Object.freeze(issues),
    }),
    work: ledger.inspect(),
    async read(path, readOptions = {}) {
      const source = at(path);
      const offset = readOptions.offset ?? 0;
      const result = await bytesOf(
        source,
        offset,
        readOptions.length ?? source.size - offset,
        readOptions,
        policy.chunk,
        false,
      );
      return { ...result, integrity: "none" };
    },
    source(path, readOptions = {}) {
      const source = at(path);
      const budgetOptions = { ...readOptions };
      const ledger = ledgerOf(budgetOptions);
      return Object.freeze({
        size: source.size,
        ...(source.identity === undefined ? {} : { identity: source.identity }),
        ...(source.stability === undefined ? {} : { stability: source.stability }),
        async read(offset: number, length: number, request: { readonly signal?: AbortSignal } = {}) {
          const signal = request.signal && budgetOptions.signal
            ? AbortSignal.any([request.signal, budgetOptions.signal])
            : request.signal ?? budgetOptions.signal;
          const result = await bytesOf(
            source,
            offset,
            length,
            { ...budgetOptions, ledger, ...(signal === undefined ? {} : { signal }) },
            policy.chunk,
            false,
          );
          return result.bytes;
        },
      });
    },
    async verify(manifestId, path, verifyOptions) {
      integer(manifestId, "Manifest ordinal");
      const manifest = manifests[manifestId];
      if (!manifest) throw new RangeError("BagIt manifest ordinal does not exist.");
      const row = manifest.rows.find((row) => row.path === path);
      if (!row) throw new RangeError("Selected file is not listed in the selected manifest.");
      if (manifest.algorithm !== "sha256" && manifest.algorithm !== "sha512") {
        unsupported("Verification supports SHA256/SHA512 only; other algorithms are inert metadata.");
      }
      const source = at(path);
      const maximum = verifyOptions.maxVerifyBytes ?? 1024 * 1024;
      integer(maximum, "maxVerifyBytes");
      if (maximum > 16 * 1024 * 1024) throw new RangeError("Whole-file verification ceiling cannot exceed 16 MiB.");
      cap(source.size, maximum, "BagIt whole-file verification");
      const result = await bytesOf(source, 0, source.size, verifyOptions, policy.chunk, true);
      const algorithm = manifest.algorithm === "sha256" ? "SHA-256" : "SHA-512";
      const digest = new Uint8Array(await verifyOptions.subtle.digest(algorithm, result.bytes.buffer as ArrayBuffer));
      verifyOptions.signal?.throwIfAborted();
      const checksum = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
      if (checksum !== row.checksum) {
        throw new ArchiveError("checksum-mismatch", "Selected BagIt file checksum does not match its manifest row.");
      }
      return {
        scope: "selected-file",
        integrity: "manifest-digest",
        manifest: manifest.path,
        file: frozenFiles.find((file) => file.path === path)!,
        algorithm,
        checksum,
        work: result.work,
      };
    },
  };
}
