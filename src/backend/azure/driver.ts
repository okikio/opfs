import { type AzureClientType } from "./client.ts";
import { defineObjectDriver, type ObjectDriverType } from "../../driver/object.ts";

/** Adds backend-driver metadata to one configured Azure Blob protocol client. */
function createDriver(client: AzureClientType): ObjectDriverType<AzureClientType> {
  const limits = client.limits ?? {};
  return defineObjectDriver(client, {
    name: client.name,
    ownership: "borrowed",
    requirements: [{ code: "azure-blob-endpoint", state: "available" }],
    limits: [
      ...(limits.maxFileBytes === undefined ? [] : [{
        code: "file-bytes",
        kind: "hard" as const,
        source: "provider" as const,
        unit: "bytes" as const,
        value: limits.maxFileBytes,
      }]),
      ...(limits.maxPartBytes === undefined ? [] : [{
        code: "block-max-bytes",
        kind: "hard" as const,
        source: "provider" as const,
        unit: "bytes" as const,
        value: limits.maxPartBytes,
      }]),
      ...(limits.maxParts === undefined ? [] : [{
        code: "blocks",
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
        code: "block-upload",
        enabled: client.optimizations.blockUpload,
        changesBehavior: true,
        disableable: true,
        detail: "Uses staged Azure blocks for large or streamed blobs instead of one Put Blob request.",
      },
      {
        code: "server-copy",
        enabled: client.optimizations.serverCopy,
        changesBehavior: true,
        disableable: true,
        detail: "Keeps supported copy work inside Azure instead of routing bytes through JavaScript.",
      },
    ],
  });
}

/**
 * Creates the Azure driver over an Azure Blob client that you made.
 *
 * The driver borrows the client: closing the driver or a filesystem built on it
 * leaves the client, its credentials and its transport open, so you can keep
 * using the client for calls the filesystem does not model. Adds Azure's block and blob limits to `inspect()`.
 *
 * @example
 * ```ts
 * const client = createAzureClient({ endpoint, container, credential });
 * const driver = createAzureDriver(client);
 * ```
 */
export function createAzureDriver(client: AzureClientType): ObjectDriverType<AzureClientType> {
  return createDriver(client);
}
