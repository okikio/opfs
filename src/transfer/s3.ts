import { z } from "zod";
import { isBytes, toView } from "../bytes.ts";
import { S3_LIMITS, S3Error } from "../s3.ts";
import type { S3ClientType, S3StoredPartType } from "../s3.ts";
import type { UploadDestinationType, UploadRequestOptionsType, UploadStatusType } from "../transfer.ts";

/** Refuse replacement encoding, so a persisted key cannot alias a different UTF-8 object name. */
function name(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) return false;
  }
  return new TextEncoder().encode(value).byteLength <= 1024;
}

/** Persist this descriptor atomically before uploading the first part. It contains no credentials. */
export const S3SessionSchema: z.ZodObject<{
  version: z.ZodLiteral<1>;
  backend: z.ZodString;
  key: z.ZodString;
  id: z.ZodString;
  token: z.ZodString;
  size: z.ZodNumber;
  partBytes: z.ZodNumber;
}, z.core.$strict> = z.strictObject({
  version: z.literal(1),
  backend: z.string().min(1).max(8192),
  key: z.string().min(1).max(1024).refine(name, "S3 session key must fit 1024 bytes without Unicode replacement."),
  id: z.string().min(1).max(8192),
  token: z.string().regex(/^[A-Za-z0-9_-]{22,128}$/),
  size: z.number().int().positive().max(S3_LIMITS.maxObjectBytes),
  partBytes: z.number().int().min(S3_LIMITS.minPartBytes).max(64 * 1024 * 1024),
}).refine((value) => Math.ceil(value.size / value.partBytes) <= S3_LIMITS.maxParts, "Too many S3 parts.");

/** Versioned session identity and fixed part layout, independent from the transfer checkpoint. */
export type S3SessionType = z.infer<typeof S3SessionSchema>;

/** Admission before remote allocation. The caller supplies a fresh, unpredictable token for each new upload. */
export interface S3SessionOptionsType {
  readonly key: string;
  readonly size: number;
  /** 22–128 URL-safe characters, never reused across sessions or copied to another object. */
  readonly token: string;
  /** Use this same value as resumeTransfer.chunkBytes. Defaults to 8 MiB; maximum 64 MiB. */
  readonly partBytes?: number;
  readonly mediaType?: string;
  readonly signal?: AbortSignal;
}

/** Creates an exclusively owned multipart session; a lost creation receipt requires caller cleanup. */
export async function createS3Session(client: S3ClientType, options: S3SessionOptionsType): Promise<S3SessionType> {
  const session = S3SessionSchema.parse({
    version: 1,
    backend: client.identity,
    key: options.key,
    id: "not-allocated",
    token: options.token,
    size: options.size,
    partBytes: options.partBytes ?? 8 * 1024 * 1024,
  });
  const upload = await client.createUpload(session.key, {
    metadata: { "opfs-session": session.token },
    ...(options.mediaType === undefined ? {} : { mediaType: options.mediaType }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (upload.key !== session.key || upload.id.length === 0) {
    throw new TypeError("S3 returned an incompatible session identity; inspect remote allocations before retrying.");
  }
  return { ...session, id: upload.id };
}

/**
 * Reopens one persisted multipart session without provider I/O.
 *
 * The caller must exclude every other writer to this key and upload ID, keep
 * the replay source immutable, and never copy/reuse the session token. Only
 * those conditions let retained parts and final object metadata establish this
 * continuation's progress. No ETag is interpreted as a content hash. Closing a
 * source or aborting a request does not remove the upload; terminate() does.
 */
export function createS3UploadDestination(client: S3ClientType, value: S3SessionType): UploadDestinationType {
  const session = S3SessionSchema.parse(value);
  if (client.identity !== session.backend) throw new TypeError("S3 session belongs to a different backend.");
  const upload = { key: session.key, id: session.id };
  // This URL is an opaque checkpoint identity, not a network endpoint or bearer URL.
  const url = `https://opfs.invalid/s3-session/${encodeURIComponent(JSON.stringify(session))}`;

  /** Bound the retained index to 10,000 parts; reject gaps and changed layouts before another write. */
  async function inspect(options: UploadRequestOptionsType): Promise<{
    status: UploadStatusType;
    parts: S3StoredPartType[];
  }> {
    options.signal?.throwIfAborted();
    const parts: S3StoredPartType[] = [];
    let cursor = 0;
    let offset = 0;
    try {
      for (let pages = 0; pages < S3_LIMITS.maxParts; pages++) {
        const page = await client.listParts(upload, cursor, options.signal);
        for (const part of page.parts) {
          const expected = Math.min(session.partBytes, session.size - offset);
          if (
            part.number !== parts.length + 1 || expected <= 0 || part.size !== expected ||
            !part.etag || parts.length >= S3_LIMITS.maxParts
          ) {
            throw new TypeError("Retained S3 parts conflict with the persisted session layout.");
          }
          parts.push(part);
          offset += part.size;
        }
        if (page.cursor === undefined) {
          // Some compatible servers retain an empty ListParts result after
          // completion. Empty staging alone is never publication authority.
          if (offset === 0) {
            const stat = await client.head(session.key, options);
            if (stat?.size === session.size && stat.metadata?.["opfs-session"] === session.token) {
              return { parts: [], status: { offset: session.size, size: session.size, complete: true } };
            }
          }
          return { parts, status: { offset, size: session.size, complete: false } };
        }
        if (!Number.isSafeInteger(page.cursor) || page.cursor <= cursor || page.cursor >= S3_LIMITS.maxParts) {
          throw new TypeError("S3 part pagination did not advance.");
        }
        cursor = page.cursor;
      }
      throw new RangeError("S3 part pagination exceeded the bounded part-number space.");
    } catch (error) {
      if (!(error instanceof S3Error) || error.status !== 404 || error.code !== "NoSuchUpload") throw error;
      const stat = await client.head(session.key, options);
      if (stat?.size !== session.size || stat.metadata?.["opfs-session"] !== session.token) {
        throw new TypeError("S3 session disappeared without attributable final publication.", { cause: error });
      }
      return { parts: [], status: { offset: session.size, size: session.size, complete: true } };
    }
  }

  return {
    protocol: "s3-multipart-v1",
    url,
    async status(options = {}) {
      return (await inspect(options)).status;
    },
    async write(offset, bytes, options = {}) {
      if (!isBytes(bytes)) throw new TypeError("S3 continuation requires readable byte views.");
      const view = toView(bytes);
      if (
        !Number.isSafeInteger(offset) || offset < 0 || offset >= session.size || offset % session.partBytes !== 0 ||
        view.byteLength !== Math.min(session.partBytes, session.size - offset)
      ) {
        throw new RangeError("S3 continuation writes must use the persisted part size and exact remaining extent.");
      }
      // Own the admitted image before awaiting reconciliation; caller mutation
      // during a network listing must not change the bytes attributed to this part.
      const owned = new Uint8Array(view);
      const current = await inspect(options);
      if (current.status.complete || current.status.offset !== offset) {
        throw new TypeError("Reconcile the S3 session before writing at a changed offset.");
      }
      await client.uploadPart(upload, current.parts.length + 1, owned, options.signal);
      return offset + owned.byteLength;
    },
    async finish(options = {}) {
      const current = await inspect(options);
      if (current.status.complete) return current.status;
      if (current.status.offset !== session.size) throw new TypeError("S3 multipart session is not fully staged.");
      await client.completeUpload(upload, current.parts, {
        expectedSize: session.size,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      return { offset: session.size, size: session.size, complete: true };
    },
    async terminate(options = {}) {
      // AbortMultipartUpload never deletes a published object, including an ambiguous prior completion.
      await client.abortUpload(upload, options.signal);
    },
  };
}
