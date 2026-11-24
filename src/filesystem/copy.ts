/**
 * Copy and move for the filesystem facade.
 *
 * Copy picks the cheapest safe route for each file: the adapter's native copy,
 * a stream copy, or a buffered copy capped at `maxBufferedWriteBytes`. Move uses
 * the adapter's native move when it has one and falls back to copy then remove.
 * That fallback is not atomic.
 *
 * These functions do not take locks. The facade holds the structural tree lock
 * around each call, so an emulated move owns both of its phases.
 *
 * @module
 */
import {
  type ChildFailureType,
  ensureParents,
  removeEntry,
  settleConcurrent,
  trackConcurrent,
  walkAdapter,
} from "./tree.ts";
import { getAdapterSignalOptions, getConcurrency } from "./options.ts";
import type { CopyOptionsType, MoveOptionsType, SignalOptionsType, StatType } from "./types.ts";
import type { DriverPlanInputType } from "../driver/definition.ts";
import type { AdapterType } from "../adapter/definition.ts";
import { FileSystemError, toFileSystemError } from "../error.ts";
import { close } from "../close.ts";
import type { MutationLocks } from "../lock.ts";
import { dirname, isAncestorPath, joinPath, normalizePath } from "../path.ts";
import type { OptimizationType } from "../schema/types.ts";
import { getSupport } from "../capability.ts";
import type { Metrics } from "../metrics.ts";
import { getDriverInput } from "../plan.ts";
import { collectBytes, retire, withAbortSignal } from "../stream/mod.ts";

/** What copy and move need from the facade that calls them. */
export interface CopyContextType {
  /** Adapter that stores the entries. */
  readonly adapter: AdapterType;
  /** Native routes the caller allows. */
  readonly optimizations: OptimizationType;
  /** Largest body a buffered copy may hold in memory. */
  readonly maxBufferedWriteBytes: number;
  /** Metrics book that records each copy and move. */
  readonly metrics: Metrics;
  /** Locks that a native move takes around its checks and its publication. */
  readonly locks: MutationLocks;
  /** Refuses an operation the adapter cannot run, before any work starts. */
  admit(input: DriverPlanInputType): void;
  /** Reads an entry's stat through the facade, with its checks and metrics. */
  stat(path: string, options: SignalOptionsType): Promise<StatType>;
}

/**
 * Copies a file or directory tree. The caller holds the structural tree lock,
 * so an emulated move can own both its copy and its remove phase.
 *
 * Source and destination must not overlap. Recursive file copies run with the
 * configured concurrency, and every started copy settles before this returns.
 */
export async function copyEntry(
  context: CopyContextType,
  source: string,
  destination: string,
  options: CopyOptionsType,
): Promise<void> {
  const from = normalizePath(source);
  const to = normalizePath(destination);
  if (from === to || isAncestorPath(from, to) || isAncestorPath(to, from)) {
    throw new FileSystemError(
      "invalid-operation",
      "copy",
      from,
      `Copy source '${from}' and destination '${to}' must not overlap.`,
    );
  }
  context.admit(
    getDriverInput(
      {
        operation: "copy",
        path: from,
        destination: to,
        overwrite: options.overwrite,
        preserve: options.preserve,
        exclusive: options.exclusive,
      },
      context.adapter,
      context.optimizations,
    ),
  );
  const concurrency = getConcurrency(options.concurrency);
  const started = context.metrics.start();
  const metricSupport = context.adapter.hostProfile !== undefined && options.preserve === false
    ? "emulated"
    : getSupport(context.adapter, context.optimizations).copy;
  let metricBytes: number | undefined;
  let failed = true;
  try {
    const sourceEntry = await context.adapter.entry?.(from, getAdapterSignalOptions(options.signal));
    if (sourceEntry === "link" || sourceEntry === "foreign") {
      throw new FileSystemError(
        "not-supported",
        "copy",
        from,
        "Portable copy requires an ordinary file or directory; links are physical entries.",
      );
    }
    const sourceStat = await context.stat(from, options);
    if (
      options.exclusive && !options.overwrite &&
      (sourceStat.kind !== "file" || !context.optimizations.nativeCopy || !context.adapter.capabilities.nativeCopy ||
        (context.adapter.publication?.copyNoReplace ?? context.adapter.publication?.noReplace) !== "atomic")
    ) {
      throw new FileSystemError(
        "not-supported",
        "copy",
        to,
        "This physical copy route cannot guarantee atomic no-replace; omit exclusive for cooperating-owner behavior.",
      );
    }
    if (sourceStat.kind === "file") metricBytes = sourceStat.size;
    const destinationStat = await context.adapter.stat(to, getAdapterSignalOptions(options.signal));
    if (destinationStat !== null) {
      if (!options.overwrite) {
        throw new FileSystemError("already-exists", "copy", to, `Destination '${to}' already exists.`);
      }
      if (destinationStat.kind !== "file" || sourceStat.kind !== "file") {
        if (options.preserve !== false) {
          throw new FileSystemError(
            "not-supported",
            "copy",
            to,
            "Replacing an existing tree or changing entry kind requires application generation publication, or explicit preserve:false for best-effort recursion.",
          );
        }
        await removeEntry(context.adapter, to, true, options.signal);
      }
      if (
        options.preserve !== false && context.adapter.publication?.copy !== "preserve" &&
        context.adapter.publication?.move !== "preserve"
      ) {
        throw new FileSystemError(
          "not-supported",
          "copy",
          to,
          "This adapter has no failure-preserving replacement; explicitly set preserve:false for best-effort overwrite.",
        );
      }
    }
    await ensureParents(context.adapter, dirname(to), options.signal);

    if (sourceStat.kind === "file") {
      if (
        options.preserve !== false &&
        (!context.optimizations.nativeCopy || context.adapter.publication?.copy !== "preserve") &&
        context.adapter.move !== undefined && context.adapter.publication?.move === "preserve"
      ) {
        const stage = joinPath(dirname(to), `.opfs-${crypto.randomUUID()}.part`);
        if (context.adapter.reserve === undefined) {
          throw new FileSystemError(
            "not-supported",
            "copy",
            to,
            "Preserving copy fallback requires exclusive stage reservation.",
          );
        }
        await context.adapter.reserve(stage, getAdapterSignalOptions(options.signal));
        let consumed = false;
        let failure: { readonly reason: unknown } | undefined;
        try {
          await copyFile(context, from, stage, options.signal, true);
          await context.adapter.move(stage, to, {
            overwrite: options.overwrite ?? false,
            ...getAdapterSignalOptions(options.signal),
          });
          consumed = true;
        } catch (reason) {
          failure = { reason };
        }
        // A successful move consumes this exact stage name. Removing that
        // name afterward could unlink a different entry created there later.
        await close(
          consumed ? [] : [async () => {
            try {
              await context.adapter.remove(stage);
            } catch (reason) {
              if (toFileSystemError(reason, "remove", stage).code !== "not-found") throw reason;
            }
          }],
          failure === undefined ? [] : [failure.reason],
        );
      } else {
        await copyFile(
          context,
          from,
          to,
          options.signal,
          options.overwrite ?? false,
          options.exclusive,
          options.preserve,
        );
      }
      failed = false;
      return;
    }
    await context.adapter.createDir(to, getAdapterSignalOptions(options.signal));
    const active = new Set<Promise<void>>();
    const failures: ChildFailureType[] = [];
    let prior: { reason: unknown } | undefined;

    try {
      for await (const entry of walkAdapter(context.adapter, from, options.signal)) {
        if (failures.length > 0) break;
        const relative = entry.path.slice(from.length).replace(/^\//, "");
        const target = joinPath(to, relative);
        if (entry.kind === "directory") {
          await context.adapter.createDir(target, getAdapterSignalOptions(options.signal));
        } else {
          while (active.size >= concurrency) await Promise.race(active);
          if (failures.length > 0) break;
          trackConcurrent(
            active,
            failures,
            copyFile(context, entry.path, target, options.signal, false, undefined, options.preserve),
          );
        }
      }
    } catch (error) {
      prior = { reason: error };
    }
    await settleConcurrent(active, failures, prior);
    failed = false;
  } catch (error) {
    throw toFileSystemError(error, "copy", from);
  } finally {
    context.metrics.record("copy", {
      support: metricSupport,
      ...(metricBytes === undefined ? {} : { bytes: metricBytes }),
      started,
      failed,
    });
  }
}

/**
 * Copies one file. The caller holds the structural tree lock.
 *
 * Uses the adapter's native copy when the optimizations allow it, then a
 * stream copy, then a buffered copy capped at `maxBufferedWriteBytes`.
 */
export async function copyFile(
  context: CopyContextType,
  source: string,
  destination: string,
  signal?: AbortSignal,
  overwrite = true,
  exclusive?: boolean,
  preserve = true,
): Promise<void> {
  if (
    !(context.adapter.hostProfile !== undefined && !preserve) && context.optimizations.nativeCopy &&
    context.adapter.capabilities.nativeCopy && context.adapter.copy !== undefined
  ) {
    await context.adapter.copy(source, destination, {
      overwrite,
      ...(exclusive === undefined ? {} : { exclusive }),
      ...getAdapterSignalOptions(signal),
    });
    return;
  }

  const stat = await context.adapter.stat(source, getAdapterSignalOptions(signal));
  if (stat?.kind !== "file") {
    throw new FileSystemError("type-mismatch", "copy", source, `Copy source '${source}' is not a file.`);
  }
  const writeOptions = {
    mode: "replace" as const,
    ...(stat.mediaType.length === 0 ? {} : { mediaType: stat.mediaType }),
    ...getAdapterSignalOptions(signal),
  };
  const streamRead = context.optimizations.streamRead && context.adapter.capabilities.streamRead &&
    context.adapter.openReadStream !== undefined;
  const streamWrite = context.optimizations.streamWrite &&
    context.adapter.capabilities.streamWriteModes.includes("replace") &&
    context.adapter.writeStream !== undefined;

  if (streamRead) {
    if (!streamWrite && stat.size > context.maxBufferedWriteBytes) {
      throw new FileSystemError(
        "too-large",
        "copy",
        source,
        `Copy fallback must materialize ${stat.size} bytes, above maxBufferedWriteBytes ${context.maxBufferedWriteBytes}.`,
      );
    }
    const stream = await context.adapter.openReadStream!(source, getAdapterSignalOptions(signal));
    if (streamWrite) {
      const input = withAbortSignal(stream, signal, source, "copy");
      try {
        await context.adapter.writeStream!(destination, input, writeOptions);
      } catch (reason) {
        await close([() => retire(input, reason)], [reason]);
      }
      return;
    }

    const bytes = await collectBytes(stream, context.maxBufferedWriteBytes, signal, "copy", source);
    context.metrics.buffer(bytes.byteLength);
    try {
      await context.adapter.writeFile(destination, bytes, writeOptions);
    } finally {
      context.metrics.buffer(-bytes.byteLength);
    }
    return;
  }

  if (stat.size > context.maxBufferedWriteBytes) {
    throw new FileSystemError(
      "too-large",
      "copy",
      source,
      `Copy fallback must materialize ${stat.size} bytes, above maxBufferedWriteBytes ${context.maxBufferedWriteBytes}.`,
    );
  }
  const bytes = await context.adapter.readFile(source, getAdapterSignalOptions(signal));
  if (bytes.byteLength > context.maxBufferedWriteBytes) {
    throw new FileSystemError("too-large", "copy", source, "Observed copy bytes exceed maxBufferedWriteBytes.");
  }
  context.metrics.buffer(bytes.byteLength);
  try {
    await context.adapter.writeFile(destination, bytes, writeOptions);
  } finally {
    context.metrics.buffer(-bytes.byteLength);
  }
}

/**
 * Moves an entry with the adapter's native move when available.
 *
 * Adapters without native move use copy-then-remove. That fallback is
 * deliberately non-atomic and is documented as such for callers.
 */
export async function moveEntry(
  context: CopyContextType,
  source: string,
  destination: string,
  options: MoveOptionsType,
): Promise<void> {
  const from = normalizePath(source);
  const to = normalizePath(destination);
  if (from === to) return;
  if (isAncestorPath(from, to) || isAncestorPath(to, from)) {
    throw new FileSystemError(
      "invalid-operation",
      "move",
      from,
      `Move source '${from}' and destination '${to}' must not overlap.`,
    );
  }

  context.admit(
    getDriverInput(
      {
        operation: "move",
        path: from,
        destination: to,
        overwrite: options.overwrite,
        preserve: options.preserve,
        exclusive: options.exclusive,
      },
      context.adapter,
      context.optimizations,
    ),
  );
  const started = context.metrics.start();
  const support = getSupport(context.adapter, context.optimizations).move;
  try {
    if (
      context.optimizations.nativeMove && context.adapter.capabilities.nativeMove && context.adapter.move !== undefined
    ) {
      const lock = await context.locks.acquireTree(options.signal);
      try {
        if (
          await context.adapter.stat(from, getAdapterSignalOptions(options.signal)) === null &&
          await context.adapter.entry?.(from, getAdapterSignalOptions(options.signal)) == null
        ) {
          throw new FileSystemError("not-found", "move", from, `Source '${from}' does not exist.`);
        }
        if (
          !options.overwrite &&
          (await context.adapter.entry?.(to, getAdapterSignalOptions(options.signal)) ??
              await context.adapter.stat(to, getAdapterSignalOptions(options.signal))) !== null
        ) {
          throw new FileSystemError("already-exists", "move", to, `Destination '${to}' already exists.`);
        }
        const destinationEntry = await context.adapter.stat(to, getAdapterSignalOptions(options.signal));
        if (
          options.overwrite && destinationEntry !== null && options.preserve !== false &&
          context.adapter.publication?.move !== "preserve"
        ) {
          throw new FileSystemError(
            "not-supported",
            "move",
            to,
            "This native move route cannot preserve an existing destination before publication; explicitly choose preserve:false for best-effort replacement.",
          );
        }
        if (options.overwrite && options.preserve === false) {
          await removeEntry(context.adapter, to, true, options.signal);
        }
        await ensureParents(context.adapter, dirname(to), options.signal);
        await context.adapter.move(from, to, {
          overwrite: options.overwrite ?? false,
          ...(options.preserve === undefined ? {} : { preserve: options.preserve }),
          ...(options.exclusive === undefined ? {} : { exclusive: options.exclusive }),
          ...getAdapterSignalOptions(options.signal),
        });
      } finally {
        lock.release();
      }
    } else {
      context.admit({ operation: "remove", path: from });
      const lock = await context.locks.acquireTree(options.signal);
      try {
        // Storage publication remains non-atomic, but queued facade mutations
        // cannot enter between copying the source and removing that same tree.
        await copyEntry(context, from, to, options);
        await removeEntry(context.adapter, from, true, options.signal);
      } finally {
        lock.release();
      }
    }
    context.metrics.record("move", { support, started });
  } catch (error) {
    context.metrics.record("move", { support, started, failed: true });
    throw toFileSystemError(error, "move", from);
  }
}
