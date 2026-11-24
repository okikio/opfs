/**
 * Option, receipt and page types for the Glacier client.
 *
 * @module
 */
import {
  type GlacierCredentialsType,
  type GlacierJobType,
  type GlacierPartType,
  type GlacierUploadType,
} from "./schema.ts";
import type { FetchType, RequestPolicyType } from "../../request.ts";
import type { ByteSourceType } from "../../source.ts";

/** A supplier is called again for each admitted attempt. */
export type GlacierCredentialSourceType =
  | GlacierCredentialsType
  | (() => GlacierCredentialsType | PromiseLike<GlacierCredentialsType>);

/** Operations borrow cancellation; stopping a request cannot cancel a remote retrieval job. */
export interface GlacierOperationOptionsType {
  readonly signal?: AbortSignal;
}

/** No Fetch, crypto, credential, or clock capability is acquired implicitly. */
export interface GlacierOptionsType {
  readonly endpoint: string | URL;
  readonly account: string;
  readonly vault: string;
  readonly region: string;
  readonly credentials: GlacierCredentialSourceType;
  readonly fetch: FetchType;
  readonly subtle: SubtleCrypto;
  readonly now: () => Date;
  readonly requestPolicy?: RequestPolicyType;
  /** Allocation ceiling, default 16 MiB; separate from the provider's part limit. */
  readonly maxBodyBytes?: number;
}

/** Retains the completed job and its original archive coordinate. Availability may expire even though identity is stable. */
export interface GlacierOutputSourceType extends ByteSourceType {
  readonly job: GlacierJobType;
  readonly archiveOffset: number | null;
}

/** Opaque receipt must be persisted by the application; descriptions cannot recover a lost ID. */
export interface GlacierReceiptType {
  readonly id: string;
  readonly location: string;
  readonly requestId?: string;
}

/** Native multipart listings retain their nullable terminal marker. */
export interface GlacierPartsType {
  readonly parts: readonly GlacierPartType[];
  readonly marker: string | null;
}

/** Native upload listing is metadata only; it does not prove a completed publication. */
export interface GlacierUploadsType {
  readonly uploads: readonly GlacierUploadType[];
  readonly marker: string | null;
}
