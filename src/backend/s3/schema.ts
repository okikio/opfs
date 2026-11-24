/**
 * Option schemas and service limits for the S3 client.
 *
 * @module
 */
import type { S3AddressingType, S3CredentialsType, S3LimitsType, S3ListEncodingType } from "./types.ts";
import { z } from "zod";

/** S3 URL addressing shape used when constructing signed request URLs. */
export const S3AddressingSchema: z.ZodType<S3AddressingType, S3AddressingType> = z.enum(["path", "virtual"]);

/** Validates an explicit compatible-provider identity policy rather than guessing from key contents. */
export const S3ListEncodingSchema: z.ZodType<S3ListEncodingType, S3ListEncodingType> = z.enum(["percent", "form"]);

/** AWS Signature Version 4 credentials. */
export const S3CredentialsSchema: z.ZodType<S3CredentialsType, S3CredentialsType> = z.object({
  /** Public access-key identifier placed in the SigV4 credential scope. */
  accessKeyId: z.string().min(1),
  /** Secret key used only as input to the SigV4 HMAC key-derivation chain. */
  secretAccessKey: z.string().min(1),
  /** Temporary-credential token signed through `x-amz-security-token` when present. */
  sessionToken: z.string().min(1).optional(),
});

/**
 * S3 limits that affect the client's upload and copy planning.
 *
 * The multipart values come from the Amazon S3 multipart specification. The
 * single-request copy and PUT limits are the documented 5 GB REST limits,
 * which are decimal gigabytes rather than 5 GiB. The object-size value is the
 * exact multipart ceiling of 10,000 x 5 GiB (48.8 TiB,
 * approximately 53.7 TB), even though AWS often rounds that limit to 50 TB in
 * product documentation.
 */
export const S3_LIMITS: S3LimitsType = Object.freeze({
  /** Exact multipart-derived S3 object ceiling: 10,000 parts x 5 GiB. */
  maxObjectBytes: 53_687_091_200_000,
  /** Largest body sent through one `PutObject` request. */
  maxPutBytes: 5_000_000_000,
  /** Largest source copied through one `CopyObject` request. */
  maxCopyBytes: 5_000_000_000,
  /** Smallest legal non-final multipart upload/copy part. */
  minPartBytes: 5 * 1024 * 1024,
  /** Largest legal multipart upload/copy part. */
  maxPartBytes: 5 * 1024 * 1024 * 1024,
  /** Maximum part count accepted by one multipart upload. */
  maxParts: 10_000,
});
