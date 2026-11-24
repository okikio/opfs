/**
 * How the Deno KV driver lays out records.
 *
 * A small file is one inline record. A larger file is a manifest that names one
 * generation of numbered parts. These helpers build the record, list and part
 * keys, and read the manifest schema.
 *
 * @module
 */
import type { DenoKvEntryType, DenoKvKeyType } from "./types.ts";
import { z } from "zod";
import { type RecordListType } from "../../driver/record.ts";
import { basename, dirname } from "../../path.ts";
import { PathSchema, RecordMetadataSchema, type RecordType } from "../../schema/mod.ts";

/** File metadata retained in the small manifest committed after all body parts. */
export const DenoKvFileSchema = z.object({
  version: z.literal(1),
  path: PathSchema,
  parent: PathSchema,
  name: z.string(),
  kind: z.literal("file"),
  size: z.number().int().nonnegative(),
  lastModified: z.number().int().nonnegative(),
  mediaType: z.string(),
}).strict().refine(
  (record) => record.path !== "/" && RecordMetadataSchema.safeParse(record).success,
  "Partition file path, parent and name must agree.",
);

/** Durable pointer to one generation of raw Deno KV body parts. */
export const DenoKvManifestSchema = z.object({
  storage: z.literal("deno-kv-parts-v3"),
  generation: z.string().min(1).max(128),
  parts: z.number().int().positive(),
  partBytes: z.number().int().positive(),
  file: DenoKvFileSchema,
}).strict().refine(
  (manifest) => manifest.parts === Math.max(1, Math.ceil(manifest.file.size / manifest.partBytes)),
  { message: "Partition count must match the logical file size and physical part size." },
);

/** Validated private manifest that publishes one complete partition generation. */
export type DenoKvManifestType = z.output<typeof DenoKvManifestSchema>;

/** Physical value stored at one logical entry key: inline record or partition manifest. */
export type DenoKvStoredType = RecordType | DenoKvManifestType;

/** Parsed logical entry plus the Deno KV version that protects its visibility mutation. */
export type DenoKvStoredEntryType = DenoKvEntryType<DenoKvStoredType>;

/** Maps one exact virtual path to a Deno KV entry key derived from its parent and name. */
export function key(prefix: string, path: string): DenoKvKeyType {
  return [prefix, "entry", dirname(path), basename(path)];
}

/** Prefix whose entries are exactly the direct children of one canonical parent path. */
export function listKey(prefix: string, parent: string): DenoKvKeyType {
  return [prefix, "entry", parent];
}

/** Maps one logical file generation and part number to a separate raw binary key. */
export function partKey(prefix: string, path: string, generation: string, index: number): DenoKvKeyType {
  return [prefix, "part", path, generation, index];
}

/** Returns true when a stored value is the private partition manifest rather than a public record. */
export function isManifest(value: unknown): value is DenoKvManifestType {
  return typeof value === "object" && value !== null && (value as { storage?: unknown }).storage === "deno-kv-parts-v3";
}

/** Projects a manifest to listing metadata without reading any body part. */
export function manifestList(manifest: DenoKvManifestType): RecordListType {
  return manifest.file;
}

/** Creates one new generation identifier without depending on Deno globals. */
export function generation(): string {
  return `${Date.now().toString(36)}-${crypto.randomUUID()}`;
}
