import { type AzureClientOptionsType, type AzureClientType, createAzureClient } from "../azure.ts";
import type { DriverOwnershipType } from "../schema.ts";
import { defineObjectDriver, type ObjectDriverType } from "./object.ts";

/** Options for the configured Azure Blob object driver. */
export interface AzureDriverOptionsType extends AzureClientOptionsType {}

/** Adds backend-driver metadata to one configured Azure Blob protocol client. */
function createDriver(client: AzureClientType, ownership: DriverOwnershipType): ObjectDriverType {
  const limits = client.limits ?? {};
  return defineObjectDriver(client, {
    name: client.name,
    ownership,
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

/** Creates an Azure Blob driver from direct protocol-client options. */
export function createAzureDriver(options: AzureDriverOptionsType): ObjectDriverType {
  return createDriver(createAzureClient(options), "owned");
}

/** Attaches driver metadata to an already configured Azure Blob client. */
export function createAzureDriverFromClient(client: AzureClientType): ObjectDriverType {
  return createDriver(client, "borrowed");
}
