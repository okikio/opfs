import { type S3ClientType } from "./client.ts";
import { defineObjectDriver, type ObjectDriverType } from "../../driver/object.ts";

/** Adds backend-driver metadata to one configured S3 protocol client. */
function createDriver(client: S3ClientType): ObjectDriverType<S3ClientType> {
  const limits = client.limits ?? {};
  return defineObjectDriver(client, {
    name: client.name,
    ownership: "borrowed",
    requirements: [{ code: "s3-endpoint", state: "available" }],
    limits: [
      ...(limits.maxFileBytes === undefined ? [] : [{
        code: "file-bytes",
        kind: "hard" as const,
        source: "provider" as const,
        unit: "bytes" as const,
        value: limits.maxFileBytes,
      }]),
      ...(limits.minPartBytes === undefined ? [] : [{
        code: "part-min-bytes",
        kind: "hard" as const,
        source: "provider" as const,
        unit: "bytes" as const,
        value: limits.minPartBytes,
      }]),
      ...(limits.maxPartBytes === undefined ? [] : [{
        code: "part-max-bytes",
        kind: "hard" as const,
        source: "provider" as const,
        unit: "bytes" as const,
        value: limits.maxPartBytes,
      }]),
      ...(limits.maxParts === undefined ? [] : [{
        code: "parts",
        kind: "hard" as const,
        source: "provider" as const,
        unit: "count" as const,
        value: limits.maxParts,
      }]),
    ],
    getMetrics: () => {
      const metrics = client.getMetrics();
      return {
        requests: metrics.requests,
        retries: metrics.retries,
        failures: metrics.failures,
        responses: metrics.responses,
        durationMs: metrics.durationMs,
      };
    },
    optimizations: [
      {
        code: "delayed-multipart",
        enabled: client.optimizations.delayedMultipart,
        changesBehavior: true,
        disableable: true,
        detail: "Buffers the first part so small unknown-length streams can use one PutObject request.",
      },
      {
        code: "signing-key-cache",
        enabled: client.optimizations.signingKeyCache,
        changesBehavior: false,
        disableable: true,
        detail: "Caches credential/date/region/service-derived SigV4 signing material within the client.",
      },
    ],
  });
}

/**
 * Creates the S3 driver over an S3 or S3-compatible client that you made.
 *
 * The driver borrows the client: closing the driver or a filesystem built on it
 * leaves the client, its credentials and its transport open, so you can keep
 * using the client for calls the filesystem does not model. Adds S3's part-size and object-size limits and the signing-key cache to `inspect()`.
 *
 * @example
 * ```ts
 * const client = createS3Client({ endpoint, bucket, region, credentials });
 * const driver = createS3Driver(client);
 * ```
 */
export function createS3Driver(client: S3ClientType): ObjectDriverType<S3ClientType> {
  return createDriver(client);
}
