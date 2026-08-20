import type { OpfsAdapterType } from "../../src/adapter/opfs.ts";
import type {
  OpfsDirectoryHandleType,
  OpfsDriverType,
  OpfsFileHandleType,
  OpfsWritableFileStreamType,
} from "../../src/driver/opfs.ts";

/**
 * The Playwright fixture API must stay opt-in instead of becoming an ambient Window member.
 *
 * `check:browser` type-checks this file together with the fixture modules. If any
 * of them adds a global `Window.opfsTest` augmentation, this expected error becomes
 * unused and the check fails.
 */
// @ts-expect-error The fixture API is intentionally not declared on the global Window interface.
export type FixtureApiMustNotBeAmbient = typeof window.opfsTest;

/** Fails compilation when `Actual` cannot be used where the package expects `Expected`. */
type AssertAssignable<Expected, Actual extends Expected> = Actual;

/** Exact-type comparison used to prove generic factories preserve a caller's native root type. */
type IsExact<Left, Right> = [Left] extends [Right] ? [Right] extends [Left] ? true : false : false;

/** Fails compilation unless one exact-type comparison remains true. */
type AssertTrue<Value extends true> = Value;

/** TypeScript's Window writable stream must implement every operation used by the OPFS driver. */
export type NativeWritableCompatibility = AssertAssignable<
  OpfsWritableFileStreamType,
  FileSystemWritableFileStream
>;

/** TypeScript's Window file handle must implement every operation used by the OPFS driver. */
export type NativeFileHandleCompatibility = AssertAssignable<OpfsFileHandleType, FileSystemFileHandle>;

/** TypeScript's Window directory handle must implement every operation used by the OPFS driver. */
export type NativeDirectoryHandleCompatibility = AssertAssignable<
  OpfsDirectoryHandleType,
  FileSystemDirectoryHandle
>;

/** The actual OPFS root returned by `StorageManager.getDirectory()` must satisfy the package contract. */
export type StorageManagerRootCompatibility = AssertAssignable<
  OpfsDirectoryHandleType,
  Awaited<ReturnType<StorageManager["getDirectory"]>>
>;

/** Passing a native root through the driver must preserve the complete native root type. */
export type NativeDriverRootPreservation = AssertTrue<
  IsExact<OpfsDriverType<FileSystemDirectoryHandle>["nativeRoot"], FileSystemDirectoryHandle>
>;

/** Passing a native root through the adapter must preserve the complete native root type. */
export type NativeAdapterRootPreservation = AssertTrue<
  IsExact<OpfsAdapterType<FileSystemDirectoryHandle>["nativeRoot"], FileSystemDirectoryHandle>
>;
