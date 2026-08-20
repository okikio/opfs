/// <reference lib="webworker" />
import type { OpfsDirectoryHandleType, OpfsFileHandleType } from "../../../src/driver/opfs.ts";

/** Fails compilation when `Actual` cannot be used where the worker OPFS driver expects `Expected`. */
type AssertAssignable<Expected, Actual extends Expected> = Actual;

/**
 * A worker-native file handle includes `createSyncAccessHandle()`, so this check
 * also proves that TypeScript's `FileSystemSyncAccessHandle` satisfies the
 * package's optional synchronous-file contract.
 */
export type NativeWorkerFileHandleCompatibility = AssertAssignable<OpfsFileHandleType, FileSystemFileHandle>;

/** Worker OPFS directory roots must satisfy the same portable directory contract as Window roots. */
export type NativeWorkerDirectoryHandleCompatibility = AssertAssignable<
  OpfsDirectoryHandleType,
  FileSystemDirectoryHandle
>;
