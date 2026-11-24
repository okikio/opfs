/**
 * Storage service versions and the limits each version allows.
 *
 * Azure raised its block, put-blob and copy limits in later service versions.
 * These helpers pick the limit for the version a client sends.
 *
 * @module
 */
import type { AzureLimitsType, AzureStorageVersionType } from "./types.ts";
import { z } from "zod";

/** Current fully deployed Azure Storage REST service version used by default. */
export const AZURE_STORAGE_VERSION = "2026-04-06";

/** Date-shaped Azure Storage REST service version sent through `x-ms-version` and SAS `api-version`. */
export const AzureStorageVersionSchema: z.ZodType<AzureStorageVersionType, AzureStorageVersionType> = z.string().regex(
  /^\d{4}-\d{2}-\d{2}$/,
);

/** Public Azure Blob size/count limits used by request planning and tests. */
export const AZURE_LIMITS: AzureLimitsType = Object.freeze({
  /** Maximum block count a `Put Block List` can publish in one block blob. */
  maxCommittedBlocks: 50_000,
  /** Maximum uncommitted blocks Azure retains for one blob before commit. */
  maxUncommittedBlocks: 100_000,
  /** Maximum source size for synchronous `Copy Blob From URL`. */
  copyBlobBytes: 256 * 1024 * 1024,
  /** `Put Block` maximum used by service versions before 2016-05-31. */
  legacyBlockBytes: 4 * 1024 * 1024,
  /** `Put Block` maximum used from 2016-05-31 through the pre-2019 limit. */
  midBlockBytes: 100 * 1024 * 1024,
  /** Current `Put Block` and modern URL-copy range maximum. */
  currentBlockBytes: 4_000 * 1024 * 1024,
  /** Single `Put Blob` maximum used by older service versions. */
  legacyPutBlobBytes: 64 * 1024 * 1024,
  /** Single `Put Blob` maximum used by 2016-era service versions. */
  midPutBlobBytes: 256 * 1024 * 1024,
  /** Current single `Put Blob` maximum. */
  currentPutBlobBytes: 5_000 * 1024 * 1024,
});

/** Earliest Blob service version covered by this client's Shared Key string format. */
export const SHARED_KEY_VERSION = "2009-09-19" as AzureStorageVersionType;

/** Last service version that signs a zero Content-Length as the literal `0`. */
export const ZERO_CONTENT_LENGTH_VERSION = "2014-02-14" as AzureStorageVersionType;

/** First service version that retains empty `x-ms-*` headers during canonicalization. */
export const EMPTY_HEADER_VERSION = "2016-05-31" as AzureStorageVersionType;

/** Earliest service version with Put Block From URL / Copy Blob From URL. */
export const URL_COPY_VERSION = "2018-03-28" as AzureStorageVersionType;

/** Earliest service version with 4,000 MiB Put Block From URL ranges. */
export const LARGE_URL_BLOCK_VERSION = "2020-04-08" as AzureStorageVersionType;

/** Earliest service version with source Microsoft Entra authorization headers. */
export const SOURCE_BEARER_VERSION = "2020-10-02" as AzureStorageVersionType;

/** Compares Azure's ISO-date service versions without local-time conversion. */
export function atLeast(version: AzureStorageVersionType, required: AzureStorageVersionType): boolean {
  return version >= required;
}

/** Returns the Put Block limit for the selected REST service version. */
export function getBlockLimit(version: AzureStorageVersionType): number {
  if (atLeast(version, "2019-12-12")) return AZURE_LIMITS.currentBlockBytes;
  if (atLeast(version, "2016-05-31")) return AZURE_LIMITS.midBlockBytes;
  return AZURE_LIMITS.legacyBlockBytes;
}

/** Returns the single Put Blob limit for the selected REST service version. */
export function getPutBlobLimit(version: AzureStorageVersionType): number {
  if (atLeast(version, "2019-12-12")) return AZURE_LIMITS.currentPutBlobBytes;
  if (atLeast(version, "2016-05-31")) return AZURE_LIMITS.midPutBlobBytes;
  return AZURE_LIMITS.legacyPutBlobBytes;
}

/** Returns the Put Block From URL range limit for the selected version. */
export function getCopyBlockLimit(version: AzureStorageVersionType): number {
  return atLeast(version, LARGE_URL_BLOCK_VERSION) ? AZURE_LIMITS.currentBlockBytes : AZURE_LIMITS.midBlockBytes;
}
