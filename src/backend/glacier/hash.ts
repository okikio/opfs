/**
 * Glacier SHA-256 tree hashes.
 *
 * Glacier checks each archive and each upload part with a tree hash: SHA-256 over
 * every 1 MiB chunk, then over each pair of child hashes up to one root.
 *
 * @module
 */
import {
  GLACIER_LIMITS,
  GLACIER_MIB,
  GlacierPartSchema,
  type GlacierPartType,
  GlacierUploadSchema,
  type GlacierUploadType,
  HashSchema,
  SizeSchema,
} from "./schema.ts";
import { hex, sha256 } from "../../sigv4.ts";
import { isBytes, toView } from "../../bytes.ts";

/** Decode only an admitted digest; never hash the textual hex as a tree node. */
export function digestBytes(value: string): Uint8Array<ArrayBuffer> {
  const hash = HashSchema.parse(value);
  return Uint8Array.from({ length: 32 }, (_, index) => parseInt(hash.slice(index * 2, index * 2 + 2), 16));
}

/** Pair raw digests. This allocation is constant-sized, independent of the archive. */
export async function pair(
  subtle: SubtleCrypto,
  left: Uint8Array,
  right: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = new Uint8Array(64);
  bytes.set(left);
  bytes.set(right, 32);
  return await sha256(subtle, bytes);
}

/** Carry equal-height subtrees; occupied levels require O(log leaf count) retained digests. */
export async function carry(
  subtle: SubtleCrypto,
  spine: (Uint8Array<ArrayBuffer> | undefined)[],
  node: Uint8Array<ArrayBuffer>,
): Promise<void> {
  let level = 0;
  while (spine[level] !== undefined) {
    node = await pair(subtle, spine[level]!, node);
    spine[level++] = undefined;
  }
  spine[level] = node;
}

/** Lower levels are the right remainder; promote odd nodes without hashing them twice. */
export async function root(
  subtle: SubtleCrypto,
  spine: readonly (Uint8Array<ArrayBuffer> | undefined)[],
): Promise<string> {
  let result: Uint8Array<ArrayBuffer> | undefined;
  for (const node of spine) {
    if (node !== undefined) {
      result = result === undefined ? node : await pair(subtle, node, result);
    }
  }
  return hex(result ?? await sha256(subtle, new Uint8Array()));
}

/** Computes the Glacier tree checksum over a copied byte image. Callers own allocation policy; empty input follows official SDK semantics. */
export async function glacierTreeHash(bytes: Uint8Array, subtle: SubtleCrypto): Promise<string> {
  if (!isBytes(bytes)) throw new TypeError("Tree hash requires Uint8Array bytes.");
  const image = new Uint8Array(toView(bytes));
  return await treeImage(image, subtle);
}

/** Already-owned request/output images need no second full snapshot. Digest temporaries remain owned by WebCrypto. */
export async function treeImage(image: Uint8Array<ArrayBuffer>, subtle: SubtleCrypto): Promise<string> {
  const spine: (Uint8Array<ArrayBuffer> | undefined)[] = [];
  for (let at = 0; at < image.length; at += GLACIER_MIB) {
    await carry(subtle, spine, await sha256(subtle, image.subarray(at, at + GLACIER_MIB)));
  }
  return await root(subtle, spine);
}

/** Checks complete ordered coverage before computing the tree of native part roots. Does not perform provider I/O. */
export async function glacierMultipartHash(
  upload: GlacierUploadType,
  parts: readonly GlacierPartType[],
  size: number,
  subtle: SubtleCrypto,
): Promise<string> {
  GlacierUploadSchema.parse(upload);
  partSize(upload.partSize);
  SizeSchema.positive().parse(size);
  if (parts.length === 0 || parts.length > GLACIER_LIMITS.maxParts) {
    throw new RangeError("Multipart completion requires 1–10000 parts.");
  }
  const admitted = parts.map((value) => GlacierPartSchema.parse(value));
  let at = 0;
  for (let index = 0; index < admitted.length; index++) {
    const part = admitted[index]!;
    const length = part.end - part.start + 1;
    if (
      part.start !== at || length <= 0 || length > upload.partSize ||
      (index < admitted.length - 1 && length !== upload.partSize) || part.end >= size
    ) throw new RangeError("Multipart extents must cover the archive exactly in order with fixed nonfinal parts.");
    at = part.end + 1;
  }
  if (at !== size) throw new RangeError("Multipart extents do not cover the declared archive size.");
  const spine: (Uint8Array<ArrayBuffer> | undefined)[] = [];
  for (const part of admitted) await carry(subtle, spine, digestBytes(part.treeHash));
  return await root(subtle, spine);
}

/** Fixed full parts are power-of-two MiB subtrees; only the final part may be shorter. */
export function partSize(value: number): number {
  SizeSchema.parse(value);
  const units = value / GLACIER_MIB;
  if (value < GLACIER_MIB || value > GLACIER_LIMITS.maxPartBytes || !Number.isInteger(Math.log2(units))) {
    throw new RangeError("Glacier part size must be a power-of-two MiB from 1 MiB through 4 GiB.");
  }
  return value;
}
