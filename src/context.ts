import type { OpfsContextType } from "./schema.ts";

/**
 * Small structural view of browser globals used for context classification.
 *
 * The library intentionally avoids browser-name checks. Runtime placement is
 * inferred from the globals that define Window and Worker execution models.
 */
export interface BrowserGlobalType {
  /** Window document marker. */
  readonly document?: object;
  /** ServiceWorker registration marker. */
  readonly registration?: unknown;
  /** ServiceWorker clients marker. */
  readonly clients?: unknown;
  /** SharedWorker connection-handler marker. */
  readonly onconnect?: unknown;
  /** Classic Worker script-loader marker. */
  readonly importScripts?: unknown;
  /** Runtime constructor name used when the concrete worker global exists. */
  readonly constructor?: { readonly name?: string };
}

/**
 * Returns the browser execution context that owns the current call.
 *
 * The result describes runtime placement. It does not imply that OPFS is
 * available. Call `probeOpfs()` when availability, storage partitioning, or
 * synchronous-access support matters.
 *
 * @example Detect whether synchronous OPFS can be attempted.
 * ```ts
 * import { getOpfsContext } from "@okikio/opfs";
 *
 * if (getOpfsContext() === "dedicated-worker") {
 *   // A DedicatedWorker can expose createSyncAccessHandle().
 * }
 * ```
 */
export function getOpfsContext(value: BrowserGlobalType = globalThis as BrowserGlobalType): OpfsContextType {
  if (typeof value.document === "object") return "window";

  const constructorName = value.constructor?.name;
  if (constructorName === "DedicatedWorkerGlobalScope") return "dedicated-worker";
  if (constructorName === "SharedWorkerGlobalScope") return "shared-worker";
  if (constructorName === "ServiceWorkerGlobalScope") return "service-worker";

  if ("registration" in value && "clients" in value) return "service-worker";
  if ("onconnect" in value && typeof value.importScripts === "function") return "shared-worker";
  if (typeof value.importScripts === "function") return "worker";
  return "unknown";
}
