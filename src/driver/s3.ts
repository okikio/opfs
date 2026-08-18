import { createS3Client, type S3ClientOptionsType, type S3ClientType } from "../s3.ts";
import type { DriverOwnershipType } from "../schema.ts";
import { defineObjectDriver, type ObjectDriverType } from "./object.ts";

/** Options for the configured S3 object driver. */
export interface S3DriverOptionsType extends S3ClientOptionsType {}

/** Adds backend-driver metadata to one configured S3 protocol client. */
function createDriver(client: S3ClientType, ownership: DriverOwnershipType): ObjectDriverType {
  const limits = client.limits ?? {};
  return defineObjectDriver(client, {
    name: client.name,
    ownership,
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
 * Creates an S3 backend driver from direct protocol-client options.
 *
 * The client remains independently usable for protocol-specific operations.
 * The driver adds storage requirements, limit provenance, and optimization
 * metadata consumed by adapters and filesystem inspection.
 */
export function createS3Driver(options: S3DriverOptionsType): ObjectDriverType {
  return createDriver(createS3Client(options), "owned");
}

/** Attaches driver metadata to an already configured S3 client. */
export function createS3DriverFromClient(client: S3ClientType): ObjectDriverType {
  return createDriver(client, "borrowed");
}
