/**
 * Directory-tree helpers for the filesystem facade.
 *
 * These helpers create missing parents, build child paths and entries, walk a
 * tree lazily, and run child work with bounded concurrency. They take the adapter
 * or the facade as an argument and keep no state of their own.
 *
 * @module
 */
import { getAdapterSignalOptions } from "./options.ts";
import type { DirectoryEntryType, FileSystemType, WalkEntryType, WalkOptionsType } from "./types.ts";
import type { AdapterType } from "../adapter/definition.ts";
import type { EntryKindType } from "../schema/types.ts";
import type { FileDriverDirectoryEntryType } from "../driver/file.ts";
import { FileSystemError, throwIfAborted } from "../error.ts";
import { close } from "../close.ts";
import { dirname, isAncestorPath, joinPath, ROOT_PATH, splitPath, validateName } from "../path.ts";
import { EntryKindSchema } from "../schema/mod.ts";
import { DirectoryHandle, FileHandle } from "../handle.ts";

/**
 * Waits for every already-started mutation before propagating a failure.
 *
 * Recursive copy and clear must not release their tree lock while sibling writes
 * are still running, even when one sibling has already failed.
 */
export async function settleConcurrent(
  active: Set<Promise<void>>,
  failures: ChildFailureType[],
  prior?: { reason: unknown },
): Promise<void> {
  await Promise.allSettled([...active]);
  // A race can deliver one of these private event records. It is the same
  // recorded event, not a second failure with an equal error value.
  const raced = prior !== undefined && failures.some((event) => event === prior.reason);
  await close([], [
    ...(prior === undefined || raced ? [] : [prior.reason]),
    ...failures.map((event) => event.reason),
  ]);
}

/** One admitted child owns one failure event, even when reasons have equal values. */
export type ChildFailureType = { readonly reason: unknown };

/** Tracks an admitted child and immediately observes rejection until the tree owner joins it. */
export function trackConcurrent(
  active: Set<Promise<void>>,
  failures: ChildFailureType[],
  operation: Promise<void>,
): void {
  const tracked = operation.catch((error) => {
    const event: ChildFailureType = { reason: error };
    failures.push(event);
    throw event;
  }).finally(() => active.delete(tracked));
  active.add(tracked);
  void tracked.catch(() => undefined);
}

/**
 * Creates missing directory components from root to leaf.
 *
 * The walk checks each component before creation so a file in the middle of the
 * path produces a precise type mismatch instead of a backend-specific failure.
 */
export async function ensureParents(adapter: AdapterType, path: string, signal?: AbortSignal): Promise<void> {
  let current = ROOT_PATH;
  for (const part of splitPath(path)) {
    current = joinPath(current, part);
    throwIfAborted(signal, "mkdir", current);
    const stat = await adapter.stat(current, getAdapterSignalOptions(signal));
    if (stat?.kind === "file") {
      throw new FileSystemError(
        "type-mismatch",
        "mkdir",
        current,
        `Cannot create directory '${current}' because a file exists at that path.`,
      );
    }
    if (stat === null) await adapter.createDir(current, getAdapterSignalOptions(signal));
  }
}

/** Rejects adapter path injection before any recursive read or mutation. */
export function childPath(parent: string, name: string): string {
  try {
    validateName(name);
  } catch (cause) {
    throw new FileSystemError("invalid-path", "read-dir", parent, "Adapter entry is not one valid child name.", cause);
  }
  const path = joinPath(parent, name);
  if (dirname(path) !== parent || !isAncestorPath(parent, path)) {
    throw new FileSystemError("invalid-path", "read-dir", parent, "Adapter entry must be a strict direct child.");
  }
  return path;
}

/** Projects one adapter child into path metadata plus an OPFS-shaped facade handle. */
export function makeDirectoryEntry(
  fileSystem: FileSystemType,
  parent: string,
  entry: FileDriverDirectoryEntryType,
): DirectoryEntryType {
  const path = childPath(parent, entry.name);
  EntryKindSchema.parse(entry.kind);
  return {
    path,
    name: entry.name,
    kind: entry.kind,
    handle: entry.kind === "file" ? new FileHandle(fileSystem, path) : new DirectoryHandle(fileSystem, path),
  };
}

/** Resolved traversal policy shared by every recursive directory visit. */
export interface WalkStateType {
  /** Original operation options, including the caller cancellation signal. */
  readonly options: WalkOptionsType;
  /** Whether file entries are emitted. */
  readonly includeFiles: boolean;
  /** Whether directory entries are emitted. */
  readonly includeDirectories: boolean;
  /** Maximum depth below the requested walk root. */
  readonly maxDepth: number;
}

/**
 * Traverses descendants without hiding recursion inside `FileSystemFacade.walk`.
 *
 * The helper delegates each directory read back through the public facade. This
 * keeps cancellation, error normalization, and adapter semantics identical to a
 * direct `readDir()` call while the traversal itself remains lazy.
 */
export async function* walkChildren(
  fileSystem: FileSystemType,
  directory: string,
  depth: number,
  state: WalkStateType,
): AsyncIterableIterator<WalkEntryType> {
  for await (const entry of fileSystem.readDir(directory, state.options)) {
    const nextDepth = depth + 1;
    const include = entry.kind === "file" ? state.includeFiles : state.includeDirectories;
    if (include) yield { ...entry, depth: nextDepth };

    if (entry.kind === "directory" && nextDepth < state.maxDepth) {
      yield* walkChildren(fileSystem, entry.path, nextDepth, state);
    }
  }
}

/** Traverses raw adapter entries without creating public facade handles. */
export async function* walkAdapter(
  adapter: AdapterType,
  path: string,
  signal?: AbortSignal,
): AsyncIterableIterator<{ path: string; kind: EntryKindType }> {
  for await (const entry of adapter.readDir(path, getAdapterSignalOptions(signal))) {
    throwIfAborted(signal, "walk", path);
    const child = childPath(path, entry.name);
    EntryKindSchema.parse(entry.kind);
    yield { path: child, kind: entry.kind };
    if (entry.kind === "directory") yield* walkAdapter(adapter, child, signal);
  }
}

/** Removes one entry after the caller has acquired the structural tree lock. */
export async function removeEntry(
  adapter: AdapterType,
  path: string,
  recursive: boolean,
  signal?: AbortSignal,
): Promise<void> {
  const identity = await adapter.entry?.(path, getAdapterSignalOptions(signal));
  if (identity === "link" || identity === "foreign") {
    await adapter.remove(path, getAdapterSignalOptions(signal));
    return;
  }
  const stat = await adapter.stat(path, getAdapterSignalOptions(signal));
  if (stat === null) return;
  if (stat.kind === "directory") {
    const children: string[] = [];
    for await (
      const entry of (adapter.entries?.(path, getAdapterSignalOptions(signal)) ??
        adapter.readDir(path, getAdapterSignalOptions(signal)))
    ) {
      children.push(childPath(path, entry.name));
    }
    if (children.length > 0 && !recursive) {
      throw new FileSystemError(
        "invalid-operation",
        "remove",
        path,
        `Directory '${path}' is not empty. Set recursive to true.`,
      );
    }
    for (const child of children) await removeEntry(adapter, child, true, signal);
  }
  await adapter.remove(path, getAdapterSignalOptions(signal));
}
