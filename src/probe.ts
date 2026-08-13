import { getOpfsContext } from "./context.ts";
import { getErrorMessage, getErrorName } from "./error.ts";
import type { OpfsContextType } from "./schema.ts";

/** A platform error captured while probing OPFS without throwing. */
export interface OpfsProbeErrorType {
  /** DOMException or Error name reported by the runtime. */
  readonly name: string;
  /** Runtime-provided diagnostic text. */
  readonly message: string;
}

/** Storage quota information returned by `navigator.storage.estimate()`. */
export interface OpfsStorageEstimateType {
  /** Approximate bytes currently used by the storage key. */
  readonly usage?: number;
  /** Approximate byte quota assigned to the storage key. */
  readonly quota?: number;
}

/**
 * Concrete browser capabilities observed by {@link probeOpfs}.
 *
 * The probe reports observable capabilities instead of trying to identify
 * private/incognito browsing. Browsers can change private-storage behavior,
 * iframe partitioning, and quota policy independently of this package.
 */
export interface OpfsCapabilitiesType {
  /** Browser execution context that owns the probe. */
  readonly context: OpfsContextType;
  /** Whether the runtime reports a secure context, or null when unavailable. */
  readonly secureContext: boolean | null;
  /** Current origin string when exposed by the runtime. */
  readonly origin: string | null;
  /** Whether the current document is embedded, or null outside Window. */
  readonly embedded: boolean | null;
  /** Whether an embedded document can prove the top document has the same origin. */
  readonly sameOriginTop: boolean | null;
  /** Whether `navigator.storage.getDirectory()` completed successfully. */
  readonly rootAvailable: boolean;
  /** Failure returned by root acquisition, when rootAvailable is false. */
  readonly rootError?: OpfsProbeErrorType;
  /** Whether the Web Locks API is exposed in the current realm. */
  readonly webLocksAvailable: boolean;
  /** Whether `createSyncAccessHandle()` is visible on the runtime prototype. */
  readonly syncAccessHandleExposed: boolean;
  /** Whether the execution context is allowed to use sync access handles. */
  readonly syncAccessHandleAllowedByContext: boolean;
  /** Whether the document exposes `requestStorageAccess()`. */
  readonly storageAccessApiAvailable: boolean;
  /** Optional quota estimate. */
  readonly storageEstimate?: OpfsStorageEstimateType;
  /** Whether storage is already persisted, when the browser exposes that diagnostic. */
  readonly persistentStorage?: boolean;
}

/** StorageManager methods used by diagnostics without requiring a specific lib.dom revision. */
interface StorageManagerType {
  /** Browser OPFS root acquisition entrypoint. */
  getDirectory?: () => Promise<FileSystemDirectoryHandle>;
  /** Optional storage quota diagnostic. */
  estimate?: () => Promise<{ readonly quota?: number; readonly usage?: number }>;
  /** Optional diagnostic that reports whether browser storage is already persisted. */
  persisted?: () => Promise<boolean>;
}

/** Navigator fields relevant to OPFS and cross-context mutation coordination. */
interface NavigatorType {
  /** Storage manager exposed by the current navigator. */
  readonly storage?: StorageManagerType;
  /** Web Locks manager presence used only as a capability signal. */
  readonly locks?: unknown;
}

/** Window document fields used to diagnose iframe placement and Storage Access support. */
interface DocumentType {
  /** Storage Access API presence used for unpartitioned iframe diagnostics. */
  readonly requestStorageAccess?: unknown;
  /** Window reference used to compare embedded and top-level origins when readable. */
  readonly defaultView?: {
    readonly top?: unknown;
    readonly location?: { readonly origin?: string };
  };
}

/** Reads navigator without creating a hard Window dependency for server/worker imports. */
function getNavigator(): NavigatorType | undefined {
  return Reflect.get(globalThis, "navigator") as NavigatorType | undefined;
}

/** Reads document structurally so worker and server imports remain valid. */
function getDocument(): DocumentType | undefined {
  return Reflect.get(globalThis, "document") as DocumentType | undefined;
}

/** Returns the current serialized origin when the runtime exposes location. */
function getOrigin(): string | null {
  const location = Reflect.get(globalThis, "location") as { readonly origin?: string } | undefined;
  return typeof location?.origin === "string" ? location.origin : null;
}

/**
 * Diagnoses iframe placement without treating cross-origin access failure as an OPFS result.
 *
 * A SecurityError while reading top.location only proves that the top document
 * has a different origin. Storage partitioning still has to be observed by the
 * actual `getDirectory()` probe.
 */
function getEmbedding(): { readonly embedded: boolean | null; readonly sameOriginTop: boolean | null } {
  const view = getDocument()?.defaultView;
  if (view === undefined) return { embedded: null, sameOriginTop: null };

  try {
    const top = view.top;
    const embedded = top !== view;
    if (!embedded) return { embedded: false, sameOriginTop: true };
    const topOrigin = (top as { readonly location?: { readonly origin?: string } } | null)?.location?.origin;
    const currentOrigin = view.location?.origin;
    return {
      embedded: true,
      sameOriginTop: typeof topOrigin === "string" && typeof currentOrigin === "string"
        ? topOrigin === currentOrigin
        : null,
    };
  } catch {
    // Reading top.location across origins throws. That proves a cross-origin top
    // document but does not prove whether storage is partitioned or granted.
    return { embedded: true, sameOriginTop: false };
  }
}

/** Checks API exposure separately from the DedicatedWorker placement requirement. */
function hasSyncAccessHandle(): boolean {
  const constructor = Reflect.get(globalThis, "FileSystemFileHandle");
  if (typeof constructor !== "function") return false;
  const prototype = Reflect.get(constructor, "prototype");
  return typeof prototype === "object" &&
    prototype !== null &&
    typeof Reflect.get(prototype, "createSyncAccessHandle") === "function";
}

/**
 * Probes OPFS and related coordination/storage capabilities without throwing.
 *
 * Use this function for diagnostics and feature selection. Do not use it as a
 * permanent permission check. A later filesystem operation can still fail due
 * to quota, storage eviction, iframe policy, native locking, or browser state.
 *
 * @example Show a useful message before opening storage.
 * ```ts
 * import { probeOpfs } from "@okikio/opfs";
 *
 * const capabilities = await probeOpfs();
 * if (!capabilities.rootAvailable) {
 *   console.warn(capabilities.rootError);
 * }
 * ```
 */
export async function probeOpfs(): Promise<OpfsCapabilitiesType> {
  const navigatorValue = getNavigator();
  const storage = navigatorValue?.storage;
  const context = getOpfsContext();
  const embedding = getEmbedding();

  let rootAvailable = false;
  let rootError: OpfsProbeErrorType | undefined;
  if (typeof storage?.getDirectory === "function") {
    try {
      await storage.getDirectory();
      rootAvailable = true;
    } catch (error) {
      rootError = { name: getErrorName(error), message: getErrorMessage(error) };
    }
  } else {
    rootError = {
      name: "NotSupportedError",
      message: "navigator.storage.getDirectory() is unavailable in this context.",
    };
  }

  let storageEstimate: OpfsStorageEstimateType | undefined;
  if (typeof storage?.estimate === "function") {
    try {
      const estimate = await storage.estimate();
      const result: { usage?: number; quota?: number } = {};
      if (typeof estimate.usage === "number") result.usage = estimate.usage;
      if (typeof estimate.quota === "number") result.quota = estimate.quota;
      storageEstimate = result;
    } catch {
      // Quota diagnostics do not control whether root acquisition succeeded.
    }
  }

  let persistentStorage: boolean | undefined;
  if (typeof storage?.persisted === "function") {
    try {
      persistentStorage = await storage.persisted();
    } catch {
      // Persistence is an optional diagnostic and can fail independently.
    }
  }

  return {
    context,
    secureContext: typeof Reflect.get(globalThis, "isSecureContext") === "boolean"
      ? Reflect.get(globalThis, "isSecureContext") as boolean
      : null,
    origin: getOrigin(),
    embedded: embedding.embedded,
    sameOriginTop: embedding.sameOriginTop,
    rootAvailable,
    ...(rootError === undefined ? {} : { rootError }),
    webLocksAvailable: navigatorValue?.locks !== undefined,
    syncAccessHandleExposed: hasSyncAccessHandle(),
    syncAccessHandleAllowedByContext: context === "dedicated-worker",
    storageAccessApiAvailable: typeof getDocument()?.requestStorageAccess === "function",
    ...(storageEstimate === undefined ? {} : { storageEstimate }),
    ...(persistentStorage === undefined ? {} : { persistentStorage }),
  };
}
