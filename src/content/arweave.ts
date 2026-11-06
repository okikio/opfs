/** Scoped RSA Arweave transaction verification and complete owned data snapshots. @module */
import { z } from "zod";
import { decodeBase64Url, encodeBase64Url } from "@std/encoding/base64url";
import { isBytes, toView } from "../bytes.ts";
import { sourceRange } from "../source.ts";
import type { ByteSourceType } from "../source.ts";
import type { ArfsMetadataInputType } from "./arfs.ts";
import { createArchiveLedger, integer } from "../archive/record.ts";
import type { ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "../archive/record.ts";
export { createArchiveLedger } from "../archive/record.ts";

/** Cryptographic checks do not establish network inclusion or trusted human identity. */
export class ArweaveError extends Error {
  readonly code:
    | "invalid-transaction"
    | "unsupported-profile"
    | "budget-exceeded"
    | "id-mismatch"
    | "owner-mismatch"
    | "signature-mismatch"
    | "data-root-mismatch";
  constructor(code: ArweaveError["code"], message: string) {
    super(message);
    this.name = "ArweaveError";
    this.code = code;
  }
}
/** Local finite policies. Hash work and retained payload are distinct from returned range copies. */
export interface ArweaveLimitsType extends ArchiveLimitsType {
  /** Hash input bytes: default 64 MiB, hard 256 MiB, cumulative across this transaction. */ readonly maxHashBytes?:
    number;
  /** Digest calls: default 4096, hard 16384, cumulative across this transaction. */ readonly maxDigestCalls?: number;
  /** Retained verified payload: default 8 MiB, hard 16 MiB; metadata has its separate header cap. */ readonly maxMaterializedBytes?:
    number;
  /** Advanced composition: at most 16 distinct explicit owners across the inherited operation chain. */ readonly ledgers?:
    readonly ArchiveLedgerType[];
  readonly signal?: AbortSignal;
}
/** Explicit native crypto capability and selected historical writer profile; no global crypto acquisition. */
export interface ArweaveVerifyOptionsType extends ArweaveLimitsType {
  readonly expectedId: string;
  readonly expectedOwner?: string;
  readonly profile: "rsa4096-pss32-v2";
  readonly subtle: Pick<SubtleCrypto, "digest" | "importKey" | "verify">;
  /** Raw JSON: default 1 MiB, hard 4 MiB. */ readonly maxHeaderBytes?: number;
  /** Tag pairs: default 256, hard 2048. */ readonly maxTags?: number;
  /** All decoded binary tag bytes: default 64 KiB, hard 256 KiB. */ readonly maxTagBytes?: number;
  /** Decimal quantity/reward digits: default 128, hard 512. */ readonly maxDecimalDigits?: number;
}
/** Complete root proof uses one explicit writer's chunk partition; other valid partitions may differ. */
export interface ArweaveDataOptionsType extends ArweaveLimitsType {
  readonly chunkProfile: "arweave-js-1.15.7";
  /** Whole payload: default 8 MiB, hard 16 MiB. */ readonly maxDataBytes?: number;
}
/** An encoded binary pair. Original order and bytes participate in the signature. */
export interface ArweaveTagType {
  readonly name: string;
  readonly value: string;
}
/** Counts reserved work, including failed attempts; materializedBytes is retained payload, not a heap estimate. */
export interface ArweaveWorkType extends ArchiveWorkType {
  readonly hashBytes: number;
  readonly digestCalls: number;
  readonly keyImports: number;
  readonly signatureVerifications: number;
  readonly materializedBytes: number;
  readonly chunks: number;
}
/** Owned immutable bytes matched an authenticated root in the selected writer profile. Chain state is unexamined. */
export interface ArweaveDataType {
  readonly id: string;
  readonly owner: string;
  readonly integrity: "rsa-signature-and-data-root";
  readonly chunkProfile: "arweave-js-1.15.7";
  readonly chain: "not-checked";
  readonly source: ByteSourceType;
  readonly work: ArweaveWorkType;
  /** Decode signed tags as strict UTF8 and bind this verified snapshot for ArFS inspection. No pin is followed. */
  metadata(): ArfsMetadataInputType;
}
/** Signature-valid header only. The embedded data field has not been authenticated. */
export interface ArweaveTransactionType {
  readonly id: string;
  readonly owner: string;
  readonly dataSize: number;
  readonly dataRoot: string;
  readonly tags: readonly ArweaveTagType[];
  readonly profile: "rsa4096-pss32-v2";
  readonly integrity: "rsa-signature";
  readonly data: "not-checked";
  readonly chain: "not-checked";
  readonly work: ArweaveWorkType;
  verifyData(source: ByteSourceType, options: ArweaveDataOptionsType): Promise<ArweaveDataType>;
}

const tagSchema: z.ZodObject<{ name: z.ZodString; value: z.ZodString }> = z.strictObject({
  name: z.string(),
  value: z.string(),
});
/** Exact accepted JSON envelope. Unsupported denomination or signature grammars are not silently discarded. */
const transactionSchema: z.ZodObject<{
  format: z.ZodLiteral<2>;
  id: z.ZodString;
  last_tx: z.ZodString;
  owner: z.ZodString;
  tags: z.ZodArray<typeof tagSchema>;
  target: z.ZodString;
  quantity: z.ZodString;
  data: z.ZodOptional<z.ZodString>;
  data_size: z.ZodString;
  data_root: z.ZodString;
  reward: z.ZodString;
  signature: z.ZodString;
  denomination: z.ZodOptional<z.ZodLiteral<0>>;
}> = z.strictObject({
  format: z.literal(2),
  id: z.string(),
  last_tx: z.string(),
  owner: z.string(),
  tags: z.array(tagSchema),
  target: z.string(),
  quantity: z.string(),
  data: z.string().optional(),
  data_size: z.string(),
  data_root: z.string(),
  reward: z.string(),
  signature: z.string(),
  denomination: z.literal(0).optional(),
});
function invalid(message: string): never {
  throw new ArweaveError("invalid-transaction", message);
}
function unsupported(message: string): never {
  throw new ArweaveError("unsupported-profile", message);
}
function cap(n: number, max: number, label: string): void {
  if (n > max) throw new ArweaveError("budget-exceeded", `${label} exceeded.`);
}
function policy(n: number | undefined, fallback: number, hard: number, label: string): number {
  const value = n ?? fallback;
  integer(value, label);
  cap(value, hard, label);
  return value;
}
/** Canonical URL-safe base64 is admitted before decode allocation, including unused final bits. */
function decoded(text: string, max: number, label: string, length?: number): Uint8Array<ArrayBuffer> {
  if (
    typeof text !== "string" || text.length > Math.ceil(max * 4 / 3) || !/^[A-Za-z0-9_-]*$/.test(text) ||
    text.length % 4 === 1
  ) invalid(`Malformed ${label} base64url.`);
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64Url(text);
  } catch {
    invalid(`Malformed ${label} base64url.`);
  }
  if (encodeBase64Url(bytes) !== text || (length !== undefined && bytes.byteLength !== length)) {
    invalid(`Noncanonical ${label} extent.`);
  }
  cap(bytes.byteLength, max, label);
  return new Uint8Array(bytes);
}
/** Exported preflight prevents a malformed locator from becoming a relative gateway path. */
export function arweaveId(value: string): string {
  decoded(value, 32, "Arweave ID", 32);
  return value;
}
function decimal(text: string, max: number, label: string): void {
  if (typeof text !== "string" || text.length > max || !/^(?:0|[1-9][0-9]*)$/.test(text)) {
    invalid(`${label} requires canonical nonnegative decimal digits.`);
  }
}
function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
function joined(...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}
function signalOf(...signals: readonly (AbortSignal | undefined)[]): AbortSignal | undefined {
  const admitted = [...new Set(signals.filter((v): v is AbortSignal => v !== undefined))];
  return admitted.length === 0 ? undefined : admitted.length === 1 ? admitted[0] : AbortSignal.any(admitted);
}
interface GaugeType {
  hashBytes: number;
  digestCalls: number;
  materializedBytes: number;
  readonly hashMax: number;
  readonly digestMax: number;
  readonly materializedMax: number;
}
interface AuthorityType {
  readonly external: readonly ArchiveLedgerType[];
  readonly ledgers: readonly ArchiveLedgerType[];
  readonly gauges: readonly GaugeType[];
  readonly signal: AbortSignal | undefined;
}
function authority(options: ArweaveLimitsType, parent?: AuthorityType): AuthorityType {
  const gauge: GaugeType = {
    hashBytes: 0,
    digestCalls: 0,
    materializedBytes: 0,
    hashMax: policy(options.maxHashBytes, 64 * 1024 ** 2, 256 * 1024 ** 2, "Arweave hash bytes"),
    digestMax: policy(options.maxDigestCalls, 4096, 16384, "Arweave digest calls"),
    materializedMax: policy(options.maxMaterializedBytes, 8 * 1024 ** 2, 16 * 1024 ** 2, "Arweave retained payload"),
  };
  const supplied: ArchiveLedgerType[] = [];
  const list = options.ledgers;
  if (list !== undefined) {
    if (!Array.isArray(list)) throw new TypeError("Arweave ledgers must be a finite array.");
    const length = list.length;
    cap(length, 16, "Arweave explicit ledger count");
    for (let i = 0; i < length; i++) supplied.push(list[i]!);
  }
  const external = [
    ...new Set([...(parent?.external ?? []), ...(options.ledger ? [options.ledger] : []), ...supplied]),
  ];
  cap(external.length, 16, "Arweave inherited explicit ledger count");
  for (const owner of external) {
    if (!owner || typeof owner.reserve !== "function" || typeof owner.inspect !== "function") {
      throw new TypeError("Arweave ledger requires reserve and inspect.");
    }
  }
  return {
    external,
    ledgers: [...new Set([...(parent?.ledgers ?? []), createArchiveLedger(options), ...external])],
    gauges: [...(parent?.gauges ?? []), gauge],
    signal: signalOf(parent?.signal, options.signal),
  };
}
function workOf(): ArweaveWorkType {
  return {
    sourceBytes: 0,
    requests: 0,
    decodedBytes: 0,
    outputBytes: 0,
    hashBytes: 0,
    digestCalls: 0,
    keyImports: 0,
    signatureVerifications: 0,
    materializedBytes: 0,
    chunks: 0,
  };
}
/** Internal mutable counts never escape. Charge all inherited owners before admitted work starts. */
function meter(
  auth: AuthorityType,
): {
  work: { -readonly [K in keyof ArweaveWorkType]: ArweaveWorkType[K] };
  reserve(kind: keyof ArweaveWorkType, count: number): void;
} {
  const work = { ...workOf() };
  return {
    work,
    reserve(kind, count) {
      integer(count, "Arweave work");
      if (kind === "sourceBytes" || kind === "requests" || kind === "decodedBytes" || kind === "outputBytes") {
        for (const owner of auth.ledgers) owner.reserve(kind, count);
      }
      if (kind === "hashBytes" || kind === "digestCalls" || kind === "materializedBytes") {
        for (const owner of auth.gauges) {
          const maximum = kind === "hashBytes"
            ? owner.hashMax
            : kind === "digestCalls"
            ? owner.digestMax
            : owner.materializedMax;
          cap(count, maximum - owner[kind], `Arweave cumulative ${kind}`);
          owner[kind] += count;
        }
      }
      work[kind] += count;
    },
  };
}
/** The envelope is shallow; bounded grammar catches escaped duplicate keys and numeric rounding before Zod. */
function jsonOf(text: string): unknown {
  let at = 0, tokens = 0;
  const space = (): void => {
    while (/[ \t\n\r]/.test(text[at] ?? "x")) at++;
  };
  function string(): string {
    const start = at;
    if (text[at++] !== '"') invalid("Expected JSON string.");
    while (at < text.length) {
      const c = text[at++];
      if (c === "\\") {
        at++;
        continue;
      }
      if (c === '"') {
        let value: unknown;
        try {
          value = JSON.parse(text.slice(start, at));
        } catch {
          invalid("Malformed JSON string.");
        }
        if (typeof value !== "string" || !value.isWellFormed()) invalid("JSON strings require well-formed Unicode.");
        return value;
      }
    }
    invalid("Unterminated JSON string.");
  }
  function value(depth: number, key?: string): void {
    cap(depth, 8, "Arweave JSON depth");
    cap(++tokens, 200000, "Arweave JSON tokens");
    space();
    if (text[at] === "{") {
      at++;
      space();
      const seen = new Set<string>();
      if (text[at] === "}") {
        at++;
        return;
      }
      while (true) {
        space();
        const name = string();
        cap(++tokens, 200000, "Arweave JSON keys");
        if (seen.has(name)) invalid("Duplicate decoded transaction JSON key.");
        seen.add(name);
        space();
        if (text[at++] !== ":") invalid("Expected JSON colon.");
        value(depth + 1, depth === 0 ? name : undefined);
        space();
        const end = text[at++];
        if (end === "}") return;
        if (end !== ",") invalid("Expected JSON object delimiter.");
      }
    }
    if (text[at] === "[") {
      at++;
      space();
      if (text[at] === "]") {
        at++;
        return;
      }
      while (true) {
        value(depth + 1);
        space();
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
    if (at === start) invalid("Missing JSON value.");
    if (key === "format" && text.slice(start, at) !== "2") unsupported("Only exact format 2 is supported.");
    if (key === "denomination" && text.slice(start, at) !== "0") unsupported("Only zero denomination is supported.");
  }
  value(0);
  space();
  if (at !== text.length) invalid("Trailing JSON bytes.");
  try {
    return JSON.parse(text);
  } catch {
    invalid("Malformed transaction JSON.");
  }
}
/** SHA384 deep-hash has fixed shallow shape here; tags remain raw binary and ordered. */
type DeepType = Uint8Array | readonly DeepType[];
/** Signed SDK partition: rebalance a short tail, retain an empty leaf at exact multiples. */
function chunksOf(size: number): readonly { offset: number; length: number }[] {
  if (size === 0) return [];
  const result: { offset: number; length: number }[] = [];
  let offset = 0, rest = size;
  while (rest >= 262144) {
    const tail = rest - 262144, length = tail > 0 && tail < 32768 ? Math.ceil(rest / 2) : 262144;
    result.push({ offset, length });
    offset += length;
    rest -= length;
  }
  result.push({ offset, length: rest });
  cap(result.length, 128, "Arweave chunks");
  return result;
}
/** Merkle notes use 32-byte unsigned big-endian offsets, while this profile admits safe addressable integers. */
function note(value: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = value % 256;
    value = Math.floor(value / 256);
  }
  return out;
}

/** Verify a bounded raw JSON header against an expected ID. No embedded payload or chain state is verified. */
export async function verifyArweaveTransaction(
  raw: Uint8Array,
  options: ArweaveVerifyOptionsType,
): Promise<ArweaveTransactionType> {
  options = { ...options };
  if (options.profile !== "rsa4096-pss32-v2") {
    unsupported("Only the explicit RSA4096-PSS32 format 2 profile is supported.");
  }
  const expectedId = arweaveId(options.expectedId),
    expectedOwner = options.expectedOwner === undefined ? undefined : arweaveId(options.expectedOwner);
  const subtle = options.subtle;
  const digest = subtle.digest.bind(subtle),
    importKey = subtle.importKey.bind(subtle),
    verify = subtle.verify.bind(subtle);
  const headerMax = policy(options.maxHeaderBytes, 1048576, 4194304, "Arweave header"),
    tagsMax = policy(options.maxTags, 256, 2048, "Arweave tags"),
    tagBytesMax = policy(options.maxTagBytes, 65536, 262144, "Arweave decoded tags"),
    digitsMax = policy(options.maxDecimalDigits, 128, 512, "Arweave decimal digits");
  const lifetime = authority(options);
  lifetime.signal?.throwIfAborted();
  const metered = meter(lifetime);
  if (!isBytes(raw)) throw new TypeError("Arweave header must be a native byte view.");
  const view = toView(raw);
  cap(view.byteLength, headerMax, "Arweave raw header");
  metered.reserve("decodedBytes", view.byteLength);
  const owned = new Uint8Array(view);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(owned);
  } catch {
    invalid("Arweave JSON requires strict UTF8.");
  }
  if (text.charCodeAt(0) === 0xfeff) invalid("Arweave JSON BOM is unsupported.");
  const json = jsonOf(text);
  if (json !== null && typeof json === "object" && "tags" in json && Array.isArray(json.tags)) {
    cap(json.tags.length, tagsMax, "Arweave tag count");
  }
  const parsed = transactionSchema.safeParse(json);
  if (!parsed.success) unsupported("Transaction envelope is outside the selected format 2 zero-denomination profile.");
  const tx = parsed.data;
  if (tx.id !== expectedId) {
    throw new ArweaveError("id-mismatch", "Received transaction ID differs from the expected locator.");
  }
  cap(tx.tags.length, tagsMax, "Arweave tag count");
  decimal(tx.quantity, digitsMax, "Quantity");
  decimal(tx.reward, digitsMax, "Reward");
  decimal(tx.data_size, 16, "Data size");
  if (!Number.isSafeInteger(Number(tx.data_size))) unsupported("Transaction size exceeds safe address arithmetic.");
  const size = Number(tx.data_size);
  const modulus = decoded(tx.owner, 512, "RSA modulus", 512);
  if (modulus[0]! < 128 || (modulus[511]! & 1) === 0) unsupported("Only a full 4096-bit odd RSA modulus is supported.");
  const signature = decoded(tx.signature, 512, "RSA signature", 512);
  const root = decoded(tx.data_root, 32, "Data root", size === 0 ? 0 : 32);
  const target = decoded(tx.target, 32, "Target");
  if (target.length !== 0 && target.length !== 32) invalid("Target must be absent or 32 bytes.");
  const anchor = decoded(tx.last_tx, 48, "Anchor");
  if (![0, 32, 48].includes(anchor.length)) invalid("Anchor extent is outside the selected profile.");
  let totalTags = 0;
  const pairs: DeepType[] = [];
  const tags: ArweaveTagType[] = [];
  for (let i = 0; i < tx.tags.length; i++) {
    const pair = tx.tags[i]!;
    const name = decoded(pair.name, tagBytesMax - totalTags, "Tag name");
    const value = decoded(pair.value, tagBytesMax - totalTags - name.byteLength, "Tag value");
    totalTags += name.length + value.length;
    cap(totalTags, tagBytesMax, "Arweave aggregate decoded tags");
    pairs.push([name, value]);
    tags.push(Object.freeze({ name: pair.name, value: pair.value }));
  }
  const ascii = (value: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(value);
  const hashed = async (
    algorithm: "SHA-256" | "SHA-384",
    bytes: Uint8Array,
    op: ReturnType<typeof meter>,
    auth: AuthorityType,
    prepaid?: { bytes: number; calls: number },
  ): Promise<Uint8Array<ArrayBuffer>> => {
    auth.signal?.throwIfAborted();
    if (prepaid) {
      if (prepaid.calls < 1 || prepaid.bytes < bytes.byteLength) {
        throw Error("Arweave hash reservation invariant failed.");
      }
      prepaid.calls--;
      prepaid.bytes -= bytes.byteLength;
    } else {
      op.reserve("hashBytes", bytes.byteLength);
      op.reserve("digestCalls", 1);
    }
    const result = await digest(algorithm, new Uint8Array(bytes));
    auth.signal?.throwIfAborted();
    const out = new Uint8Array(result);
    if (out.length !== (algorithm === "SHA-256" ? 32 : 48)) {
      throw new TypeError("Digest capability returned an unexpected extent.");
    }
    return out;
  };
  const deep = async (value: DeepType): Promise<Uint8Array<ArrayBuffer>> => {
    if (Array.isArray(value)) {
      let acc = await hashed("SHA-384", ascii(`list${value.length}`), metered, lifetime);
      for (const child of value) acc = await hashed("SHA-384", joined(acc, await deep(child)), metered, lifetime);
      return acc;
    }
    const bytes = value as Uint8Array;
    return await hashed(
      "SHA-384",
      joined(
        await hashed("SHA-384", ascii(`blob${bytes.byteLength}`), metered, lifetime),
        await hashed("SHA-384", bytes, metered, lifetime),
      ),
      metered,
      lifetime,
    );
  };
  if (!same(await hashed("SHA-256", signature, metered, lifetime), decoded(expectedId, 32, "Expected ID", 32))) {
    throw new ArweaveError("id-mismatch", "Transaction ID does not hash the raw signature.");
  }
  const owner = encodeBase64Url(await hashed("SHA-256", modulus, metered, lifetime));
  if (expectedOwner !== undefined && owner !== expectedOwner) {
    throw new ArweaveError("owner-mismatch", "Computed owner differs from expected owner.");
  }
  const signatureData = await deep([
    ascii("2"),
    modulus,
    target,
    ascii(tx.quantity),
    ascii(tx.reward),
    anchor,
    pairs,
    ascii(tx.data_size),
    root,
  ]);
  lifetime.signal?.throwIfAborted();
  metered.reserve("keyImports", 1);
  const key = await importKey(
    "jwk",
    { kty: "RSA", e: "AQAB", n: tx.owner },
    { name: "RSA-PSS", hash: "SHA-256" },
    false,
    ["verify"],
  );
  lifetime.signal?.throwIfAborted();
  metered.reserve("signatureVerifications", 1);
  const valid = await verify(
    { name: "RSA-PSS", saltLength: 32 },
    key,
    new Uint8Array(signature),
    new Uint8Array(signatureData),
  );
  lifetime.signal?.throwIfAborted();
  if (!valid) {
    throw new ArweaveError(
      "signature-mismatch",
      "Transaction signature does not verify in the selected RSA-PSS32 profile.",
    );
  }
  const frozenTags = Object.freeze(tags);
  return Object.freeze({
    id: tx.id,
    owner,
    dataSize: size,
    dataRoot: tx.data_root,
    tags: frozenTags,
    profile: "rsa4096-pss32-v2",
    integrity: "rsa-signature",
    data: "not-checked",
    chain: "not-checked",
    work: Object.freeze({ ...metered.work }),
    async verifyData(input: ByteSourceType, call: ArweaveDataOptionsType): Promise<ArweaveDataType> {
      call = { ...call };
      if (call.chunkProfile !== "arweave-js-1.15.7") {
        unsupported("An explicit ArweaveJS 1.15.7 chunk profile is required.");
      }
      const maxData = policy(call.maxDataBytes, 8388608, 16777216, "Arweave full data");
      cap(size, maxData, "Arweave signed payload");
      const auth = authority(call, lifetime);
      auth.signal?.throwIfAborted();
      const op = meter(auth);
      const { size: inputSize, read } = input;
      integer(inputSize, "Arweave source size");
      if (inputSize !== size) invalid("Payload source size differs from signed data_size.");
      if (typeof read !== "function") throw new TypeError("Payload source requires read.");
      const readSource = read.bind(input);
      const chunks = chunksOf(size),
        count = chunks.length,
        calls = count === 0 ? 0 : 4 * (2 * count - 1),
        hashBytes = count === 0 ? 0 : size + 128 * count + 192 * (count - 1);
      op.reserve("sourceBytes", size);
      op.reserve("requests", Math.ceil(size / 262144));
      op.reserve("materializedBytes", size);
      op.reserve("hashBytes", hashBytes);
      op.reserve("digestCalls", calls);
      op.reserve("chunks", count);
      const bytes = new Uint8Array(size);
      for (let offset = 0; offset < size;) {
        auth.signal?.throwIfAborted();
        const length = Math.min(262144, size - offset),
          chunk = await readSource(offset, length, auth.signal ? { signal: auth.signal } : {});
        auth.signal?.throwIfAborted();
        if (!isBytes(chunk)) invalid("Payload source returned a non-byte extent.");
        const admitted = toView(chunk);
        if (admitted.byteLength !== length) invalid("Payload source returned a different extent.");
        bytes.set(admitted, offset);
        offset += length;
      }
      const prepaid = { bytes: hashBytes, calls };
      let layer: { hash: Uint8Array; end: number }[] = [];
      for (const chunk of chunks) {
        const dataHash = await hashed(
          "SHA-256",
          bytes.subarray(chunk.offset, chunk.offset + chunk.length),
          op,
          auth,
          prepaid,
        );
        layer.push({
          hash: await hashed(
            "SHA-256",
            joined(
              await hashed("SHA-256", dataHash, op, auth, prepaid),
              await hashed("SHA-256", note(chunk.offset + chunk.length), op, auth, prepaid),
            ),
            op,
            auth,
            prepaid,
          ),
          end: chunk.offset + chunk.length,
        });
      }
      while (layer.length > 1) {
        const next: typeof layer = [];
        for (let i = 0; i < layer.length; i += 2) {
          const left = layer[i]!, right = layer[i + 1];
          if (!right) {
            next.push(left);
            continue;
          }
          next.push({
            hash: await hashed(
              "SHA-256",
              joined(
                await hashed("SHA-256", left.hash, op, auth, prepaid),
                await hashed("SHA-256", right.hash, op, auth, prepaid),
                await hashed("SHA-256", note(left.end), op, auth, prepaid),
              ),
              op,
              auth,
              prepaid,
            ),
            end: right.end,
          });
        }
        layer = next;
      }
      if (prepaid.bytes !== 0 || prepaid.calls !== 0) throw Error("Arweave hash plan did not match exact work.");
      if (!same(layer[0]?.hash ?? new Uint8Array(), root)) {
        throw new ArweaveError(
          "data-root-mismatch",
          "Complete bytes differ from signed data_root in the selected writer chunk profile.",
        );
      }
      auth.signal?.throwIfAborted();
      const source: ByteSourceType = Object.freeze({
        size,
        identity: JSON.stringify(["arweave", tx.id, tx.data_root, size, "arweave-js-1.15.7"]),
        stability: "immutable",
        async read(offset: number, length: number, next: { readonly signal?: AbortSignal } = {}): Promise<Uint8Array> {
          const { signal: nextSignal } = next, signal = signalOf(auth.signal, nextSignal);
          signal?.throwIfAborted();
          sourceRange(size, offset, length);
          const copy = meter(auth);
          copy.reserve("outputBytes", length);
          const result = new Uint8Array(length);
          result.set(bytes.subarray(offset, offset + length));
          signal?.throwIfAborted();
          return result;
        },
      });
      return Object.freeze({
        id: tx.id,
        owner,
        integrity: "rsa-signature-and-data-root",
        chunkProfile: "arweave-js-1.15.7",
        chain: "not-checked",
        source,
        work: Object.freeze({ ...op.work }),
        metadata(): ArfsMetadataInputType {
          auth.signal?.throwIfAborted();
          const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
          const decodedTags = frozenTags.map((pair) =>
            Object.freeze({
              name: decoder.decode(decoded(pair.name, tagBytesMax, "Tag name")),
              value: decoder.decode(decoded(pair.value, tagBytesMax, "Tag value")),
            })
          );
          return Object.freeze({ transactionId: tx.id, owner, tags: Object.freeze(decodedTags), source });
        },
      });
    },
  });
}
