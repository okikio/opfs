import type { AdapterType, FileSystemOptionsType } from "./definition.ts";
import { createFileAdapter } from "./file.ts";
import { createFileSystem, type FileSystemType } from "../filesystem.ts";
import { FileSystemError, toFileSystemError } from "../error.ts";
import { createOpfsDriver, type OpfsDriverType } from "../driver/opfs.ts";

/** OPFS adapter with the native root retained for advanced browser interop. */
export interface OpfsAdapterType extends AdapterType {
  readonly driver: OpfsDriverType;
  readonly nativeRoot: FileSystemDirectoryHandle;
}

/** Options for opening the current origin-private filesystem. */
export type OpenFileSystemOptionsType = FileSystemOptionsType;

/** Creates the thin OPFS adapter over an already acquired native root. */
export function createOpfsAdapter(root: FileSystemDirectoryHandle): OpfsAdapterType {
  const driver = createOpfsDriver(root);
  const adapter = createFileAdapter(driver) as OpfsAdapterType;
  Object.defineProperty(adapter, "nativeRoot", { value: root, enumerable: true });
  return adapter;
}

/**
 * Opens the current origin-private filesystem and returns the portable facade.
 *
 * Storage access starts only when this function runs. Unsupported or denied
 * contexts fail at the call site and preserve the native cause.
 */
export async function openFileSystem(options: OpenFileSystemOptionsType = {}): Promise<FileSystemType> {
  const navigatorValue = Reflect.get(globalThis, "navigator") as
    | { storage?: { getDirectory?: () => Promise<FileSystemDirectoryHandle> } }
    | undefined;
  if (typeof navigatorValue?.storage?.getDirectory !== "function") {
    throw new FileSystemError(
      "unavailable",
      "open",
      undefined,
      "navigator.storage.getDirectory() is unavailable in this context.",
    );
  }
  try {
    const root = await navigatorValue.storage.getDirectory();
    return createFileSystem(createOpfsAdapter(root), options);
  } catch (error) {
    throw toFileSystemError(error, "open");
  }
}
