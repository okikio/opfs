/**
 * The filesystem facade: one OPFS-shaped API over one adapter.
 *
 * {@link createFileSystem} returns a {@link FileSystemType}. The facade owns
 * path rules, locks, cancellation, limits and metrics, and sends storage work to
 * the adapter. Option and entry types are in `./types.ts`, option parsing is in
 * `./options.ts`, tree helpers are in `./tree.ts`, and copy and move are in
 * `./copy.ts`.
 *
 * @module
 */
import { type CopyContextType, copyEntry, moveEntry } from "./copy.ts";
import {
  type ChildFailureType,
  childPath,
  ensureParents,
  makeDirectoryEntry,
  removeEntry,
  settleConcurrent,
  trackConcurrent,
  walkChildren,
} from "./tree.ts";
import {
  DEFAULT_LOCK_PREFIX,
  getAdapterSignalOptions,
  getBufferLimit,
  getConcurrency,
  getOptimizations,
  getWriteSize,
  parseOption,
} from "./options.ts";
import type {
  CopyOptionsType,
  DirectoryEntryType,
  DirectoryOptionsType,
  DirectoryStatType,
  EmptyDirectoryOptionsType,
  ExistsOptionsType,
  FileOptionsType,
  FileStatType,
  FileSystemType,
  MakeDirectoryOptionsType,
  MoveOptionsType,
  OpenSyncFileOptionsType,
  OpenWritableFileOptionsType,
  ReadOptionsType,
  ReadTextOptionsType,
  RemoveOptionsType,
  SignalOptionsType,
  StatType,
  WalkEntryType,
  WalkOptionsType,
  WriteOptionsType,
} from "./types.ts";
import { assertInteger } from "../check.ts";
import type { DriverPlanInputType } from "../driver/definition.ts";
import { validateWritableOptions } from "../driver/writable.ts";
import type { AdapterType, FileSystemOptionsType } from "../adapter/definition.ts";
import { FileSystemError, throwIfAborted, toFileSystemError } from "../error.ts";
import { close } from "../close.ts";
import { MutationLocks } from "../lock.ts";
import { basename, dirname, normalizePath, ROOT_PATH } from "../path.ts";
import { CoordinationModeSchema, EntryKindSchema, MetricsModeSchema, WriteModeSchema } from "../schema/mod.ts";
import type { MetricsModeType, OptimizationType, SupportModeType } from "../schema/types.ts";
import { getSupport, type InspectionType } from "../capability.ts";
import { Metrics, type MetricsType } from "../metrics.ts";
import { createPlan, type PlanInputType, type PlanType } from "../plan.ts";
import {
  collectBytes,
  isAsyncIterable,
  isReadableStream,
  observeBytes,
  retire,
  toBytes,
  toByteStream,
  withAbortSignal,
  type WriteDataType,
} from "../stream.ts";
import { ManagedSyncFile, type SyncFileType } from "../sync.ts";
import { ManagedWritableFile, type WritableFileType } from "../writable.ts";
import { DirectoryHandle, type DirectoryHandleType, FileHandle, type FileHandleType } from "../handle.ts";

/**
 * Concrete facade that owns coordination and delegates persistence to one adapter.
 *
 * It is intentionally not exported as a class. Consumers depend on
 * {@link FileSystemType} and create instances through {@link createFileSystem},
 * which keeps adapter selection and lifecycle policy explicit.
 */
class FileSystemFacade<Backend = unknown> implements FileSystemType<Backend> {
  /** Persistence adapter that implements this facade's backend operations. */
  readonly adapter: AdapterType<Backend>;
  /** Stable OPFS-shaped handle for the virtual root directory. */
  readonly root: DirectoryHandleType;
  /** Hard limit used before a value-oriented adapter may materialize streamed input. */
  readonly maxBufferedWriteBytes: number;
  /** Resolved native-route policy. Every route defaults to enabled. */
  readonly optimizations: OptimizationType;
  /** Configured instrumentation detail. */
  readonly metricsMode: MetricsModeType;

  /** The driver's borrowed client, database or store; see {@link FileSystemType.backend}. */
  get backend(): Backend {
    return this.adapter.driver.backend as Backend;
  }

  /** Adapter, policy and coordination that copy and move borrow from this facade. */
  readonly #context: CopyContextType;
  /** Mutable metrics book hidden behind detached public snapshots. */
  readonly #metrics: Metrics;
  /** Coordinates file mutations and structural tree changes for this facade. */
  readonly #locks: MutationLocks;
  /** Records whether facade disposal also transfers disposal to the adapter. */
  readonly #disposeAdapter: boolean;
  /** Terminal facade state. A closed facade never reopens. */
  #closed = false;
  /** All terminal callers join the same physical adapter disposal outcome. */
  #closing: Promise<void> | undefined;

  /** Acquires facade coordination state while borrowing or owning the selected adapter as configured. */
  constructor(adapter: AdapterType<Backend>, options: FileSystemOptionsType) {
    this.adapter = adapter;
    this.maxBufferedWriteBytes = getBufferLimit(options.maxBufferedWriteBytes);
    this.optimizations = getOptimizations(options.optimizations);
    this.metricsMode = parseOption(MetricsModeSchema, options.metrics ?? "basic", "metrics mode");
    this.#metrics = new Metrics(this.metricsMode);
    this.#locks = new MutationLocks(
      parseOption(CoordinationModeSchema, options.coordination ?? "auto", "coordination mode"),
      options.lockPrefix ?? DEFAULT_LOCK_PREFIX,
    );
    this.#disposeAdapter = options.disposeAdapter ?? false;
    this.root = new DirectoryHandle(this, ROOT_PATH);
    this.#context = {
      adapter,
      optimizations: this.optimizations,
      maxBufferedWriteBytes: this.maxBufferedWriteBytes,
      metrics: this.#metrics,
      locks: this.#locks,
      admit: (input) => this.#admit(input),
      stat: (path, options) => this.stat(path, options),
    };
  }

  /** Returns effective support, configured limits, policy, and a current metrics snapshot. */
  inspect(): InspectionType {
    this.#assertOpen();
    const driverMetrics = this.adapter.driver.getMetrics?.();
    return structuredClone({
      driver: this.adapter.driver.inspect(),
      adapter: {
        name: this.adapter.name,
        native: this.adapter.capabilities,
        ...(this.adapter.publication === undefined ? {} : { publication: { ...this.adapter.publication } }),
        ...(this.adapter.hostProfile === undefined
          ? {}
          : { hostProfile: { ...this.adapter.hostProfile, writeModes: [...this.adapter.hostProfile.writeModes] } }),
        ...(this.adapter.limits === undefined ? {} : { limits: this.adapter.limits }),
        ...(this.adapter.partition === undefined ? {} : { partition: this.adapter.partition }),
      },
      support: getSupport(this.adapter, this.optimizations),
      optimizations: this.optimizations,
      maxBufferedWriteBytes: this.maxBufferedWriteBytes,
      metricsMode: this.metricsMode,
      metrics: this.#metrics.snapshot(),
      ...(driverMetrics === undefined ? {} : { driverMetrics }),
    });
  }

  /** Hard backend admission runs before locks, metadata, parents, or source ownership. */
  #admit(input: DriverPlanInputType): void {
    if (
      !this.adapter.capabilities.write &&
      (input.operation === "write" || input.operation === "copy" || input.operation === "move" ||
        input.operation === "remove")
    ) {
      throw new FileSystemError(
        "not-supported",
        input.operation,
        input.path,
        `Adapter '${this.adapter.name}' is read-only.`,
      );
    }
    const admitted = this.adapter.admit?.(input);
    if (admitted !== undefined && !admitted.supported) {
      throw new FileSystemError(
        "not-supported",
        input.intent ?? input.operation,
        input.path,
        admitted.problems.map((problem) => problem.message).join(" "),
        admitted,
      );
    }
  }

  /** Creates a deterministic preflight plan without touching the backend. */
  plan(input: PlanInputType): PlanType {
    this.#assertOpen();
    return createPlan(input, {
      adapter: this.adapter,
      optimizations: this.optimizations,
      maxBufferedWriteBytes: this.maxBufferedWriteBytes,
    });
  }

  /** Returns a detached metrics snapshot suitable for diagnostics and benchmark output. */
  getMetrics(): MetricsType {
    return this.#metrics.snapshot();
  }

  /** Selects partitioned accounting only when facade emulation did not already define the route. */
  #support(route: SupportModeType, bytes?: number): SupportModeType {
    // Facade materialization is the most important logical cost to report. The
    // nested driver plan still describes any partitioned physical layout used
    // after the buffer has been materialized.
    if (route === "emulated") return route;
    const partition = this.adapter.partition;
    if (partition === undefined || partition.mode === "never" || bytes === undefined) return route;
    return partition.mode === "always" || bytes > (partition.thresholdBytes ?? partition.partBytes)
      ? "partitioned"
      : route;
  }

  /** Rejects all operations after the caller closes this facade. */
  #assertOpen(): void {
    if (this.#closed) {
      throw new FileSystemError(
        "invalid-operation",
        "filesystem",
        undefined,
        "Filesystem is already closed.",
      );
    }
  }

  /**
   * Opens or creates a directory after validating parent and entry-kind invariants.
   *
   * Creation holds the structural tree lock so another facade mutation cannot
   * replace an ancestor while this method creates the requested directory.
   */
  async getDirectoryHandle(path: string, options: DirectoryOptionsType = {}): Promise<DirectoryHandleType> {
    this.#assertOpen();
    const normalized = normalizePath(path);
    if (normalized === ROOT_PATH) return this.root;
    throwIfAborted(options.signal, "get-directory", normalized);

    if (options.create || options.recursive) {
      this.#admit({ operation: "write", path: normalized });
      const lock = await this.#locks.acquireTree(options.signal);
      try {
        if (options.recursive) await ensureParents(this.adapter, normalized, options.signal);
        else {
          const parent = await this.adapter.stat(dirname(normalized), getAdapterSignalOptions(options.signal));
          if (parent?.kind !== "directory") {
            throw new FileSystemError(
              "not-found",
              "get-directory",
              normalized,
              `Parent directory '${dirname(normalized)}' does not exist.`,
            );
          }
          const existing = await this.adapter.stat(normalized, getAdapterSignalOptions(options.signal));
          if (existing?.kind === "file") {
            throw new FileSystemError(
              "type-mismatch",
              "get-directory",
              normalized,
              `'${normalized}' is a file.`,
            );
          }
          if (existing === null) await this.adapter.createDir(normalized, getAdapterSignalOptions(options.signal));
        }
      } finally {
        lock.release();
      }
      return new DirectoryHandle(this, normalized);
    }

    const stat = await this.adapter.stat(normalized, getAdapterSignalOptions(options.signal));
    if (stat === null) {
      throw new FileSystemError(
        "not-found",
        "get-directory",
        normalized,
        `Directory '${normalized}' does not exist.`,
      );
    }
    if (stat.kind !== "directory") {
      throw new FileSystemError("type-mismatch", "get-directory", normalized, `'${normalized}' is a file.`);
    }
    return new DirectoryHandle(this, normalized);
  }

  /**
   * Opens or creates a file and returns an OPFS-shaped facade handle.
   *
   * File creation takes the file mutation lock and rechecks storage after the
   * lock is acquired so two creators cannot both assume the path is missing.
   * The recheck also classifies entry kind: an existing file is preserved, while
   * a directory refuses file admission and releases the acquired lock.
   */
  async getFileHandle(path: string, options: FileOptionsType = {}): Promise<FileHandleType> {
    this.#assertOpen();
    const normalized = normalizePath(path);
    if (normalized === ROOT_PATH) {
      throw new FileSystemError("type-mismatch", "get-file", normalized, "The virtual root is a directory.");
    }
    throwIfAborted(options.signal, "get-file", normalized);

    if (options.create) this.#admit({ operation: "write", path: normalized, mode: "replace" });
    let stat = await this.adapter.stat(normalized, getAdapterSignalOptions(options.signal));
    if (stat?.kind === "directory") {
      throw new FileSystemError("type-mismatch", "get-file", normalized, `'${normalized}' is a directory.`);
    }
    if (stat === null && options.create) {
      const lock = await this.#locks.acquireFile(normalized, options.signal);
      try {
        if (options.parents) await ensureParents(this.adapter, dirname(normalized), options.signal);
        const parent = await this.adapter.stat(dirname(normalized), getAdapterSignalOptions(options.signal));
        if (parent?.kind !== "directory") {
          throw new FileSystemError(
            "not-found",
            "get-file",
            normalized,
            `Parent directory '${dirname(normalized)}' does not exist.`,
          );
        }
        stat = await this.adapter.stat(normalized, getAdapterSignalOptions(options.signal));
        if (stat?.kind === "directory") {
          throw new FileSystemError("type-mismatch", "get-file", normalized, `'${normalized}' is a directory.`);
        }
        if (stat === null) {
          await this.adapter.writeFile(normalized, new Uint8Array(), {
            mode: "replace",
            ...getAdapterSignalOptions(options.signal),
          });
        }
      } finally {
        lock.release();
      }
    } else if (stat === null) {
      throw new FileSystemError("not-found", "get-file", normalized, `File '${normalized}' does not exist.`);
    }
    return new FileHandle(this, normalized);
  }

  /** Returns a fresh Web `File` snapshot built from the adapter's current bytes and metadata. */
  async getFile(path: string, options: SignalOptionsType = {}): Promise<File> {
    const normalized = normalizePath(path);
    const stat = await this.stat(normalized, options);
    if (stat.kind !== "file") {
      throw new FileSystemError("type-mismatch", "get-file", normalized, `'${normalized}' is a directory.`);
    }
    const bytes = await this.readFile(normalized, options);
    return new File([new Uint8Array(bytes)], stat.name, { lastModified: stat.lastModified, type: stat.mediaType });
  }

  /** Returns normalized file or directory metadata and rejects a missing path. */
  async stat(path: string, options: SignalOptionsType = {}): Promise<StatType> {
    this.#assertOpen();
    const normalized = normalizePath(path);
    throwIfAborted(options.signal, "stat", normalized);
    const started = this.#metrics.start();
    if (normalized === ROOT_PATH) {
      this.#metrics.record("stat", { support: "native", started });
      return { kind: "directory", path: ROOT_PATH, name: "" };
    }

    try {
      const stat = await this.adapter.stat(normalized, getAdapterSignalOptions(options.signal));
      if (stat === null) {
        throw new FileSystemError("not-found", "stat", normalized, `Entry '${normalized}' does not exist.`);
      }
      if (stat.kind === "file") {
        const output: FileStatType = {
          kind: "file",
          path: normalized,
          name: basename(normalized),
          size: stat.size,
          lastModified: stat.lastModified,
          mediaType: stat.mediaType,
          ...(stat.revision === undefined ? {} : { revision: { ...stat.revision } }),
        };
        this.#metrics.record("stat", { support: "native", started });
        return output;
      }
      const output: DirectoryStatType = { kind: "directory", path: normalized, name: basename(normalized) };
      const result = stat.lastModified !== undefined ? { ...output, lastModified: stat.lastModified } : output;
      this.#metrics.record("stat", { support: "native", started });
      return result;
    } catch (error) {
      this.#metrics.record("stat", { support: "native", started, failed: true });
      throw toFileSystemError(error, "stat", normalized);
    }
  }

  /**
   * Performs an advisory existence check.
   *
   * Callers must not use this result as a write precondition because another
   * context can mutate the path before the next operation starts.
   */
  async exists(path: string, options: ExistsOptionsType = {}): Promise<boolean> {
    this.#assertOpen();
    const normalized = normalizePath(path);
    throwIfAborted(options.signal, "exists", normalized);
    const kind = options.kind === undefined ? undefined : EntryKindSchema.parse(options.kind);
    if (normalized === ROOT_PATH) return kind === undefined || kind === "directory";
    try {
      const stat = await this.adapter.stat(normalized, getAdapterSignalOptions(options.signal));
      return stat !== null && (kind === undefined || stat.kind === kind);
    } catch (error) {
      const normalizedError = toFileSystemError(error, "exists", normalized);
      if (normalizedError.code === "not-found") return false;
      throw normalizedError;
    }
  }

  /** Creates one directory, optionally creating missing ancestors under the tree lock. */
  async mkdir(path: string, options: MakeDirectoryOptionsType = {}): Promise<void> {
    this.#assertOpen();
    const normalized = normalizePath(path);
    this.#admit({ operation: "write", path: normalized });
    if (normalized === ROOT_PATH) return;
    const lock = await this.#locks.acquireTree(options.signal);
    try {
      if (options.recursive) {
        await ensureParents(this.adapter, normalized, options.signal);
        return;
      }
      const existing = await this.adapter.stat(normalized, getAdapterSignalOptions(options.signal));
      if (existing !== null) {
        throw new FileSystemError("already-exists", "mkdir", normalized, `Entry '${normalized}' already exists.`);
      }
      const parent = await this.adapter.stat(dirname(normalized), getAdapterSignalOptions(options.signal));
      if (parent?.kind !== "directory") {
        throw new FileSystemError(
          "not-found",
          "mkdir",
          normalized,
          `Parent directory '${dirname(normalized)}' does not exist.`,
        );
      }
      await this.adapter.createDir(normalized, getAdapterSignalOptions(options.signal));
    } finally {
      lock.release();
    }
  }

  /** Ensures every directory segment exists without replacing a file at any segment. */
  async ensureDir(path: string, options: SignalOptionsType = {}): Promise<void> {
    this.#assertOpen();
    this.#admit({ operation: "write", path: normalizePath(path) });
    const lock = await this.#locks.acquireTree(options.signal);
    try {
      await ensureParents(this.adapter, normalizePath(path), options.signal);
    } finally {
      lock.release();
    }
  }

  /** Creates an empty file only when the path is missing and never truncates an existing file. */
  async ensureFile(path: string, options: SignalOptionsType = {}): Promise<void> {
    await this.getFileHandle(path, { create: true, parents: true, ...getAdapterSignalOptions(options.signal) });
  }

  /**
   * Lazily yields direct children from the adapter.
   *
   * The iterator does not collect the full directory, which keeps memory use
   * proportional to the adapter's own iteration strategy.
   */
  async *readDir(path = ROOT_PATH, options: SignalOptionsType = {}): AsyncIterableIterator<DirectoryEntryType> {
    this.#assertOpen();
    const normalized = normalizePath(path);
    const physical = await this.adapter.entry?.(normalized, getAdapterSignalOptions(options.signal));
    if (physical === "link" || physical === "foreign") {
      throw new FileSystemError(
        "type-mismatch",
        "read-dir",
        normalized,
        "Only an ordinary directory can be listed; links and foreign entries cannot be traversed.",
      );
    }
    const stat = await this.stat(normalized, options);
    if (stat.kind !== "directory") {
      throw new FileSystemError("type-mismatch", "read-dir", normalized, `'${normalized}' is a file.`);
    }

    try {
      for await (const entry of this.adapter.readDir(normalized, getAdapterSignalOptions(options.signal))) {
        throwIfAborted(options.signal, "read-dir", normalized);
        yield makeDirectoryEntry(this, normalized, entry);
      }
    } catch (error) {
      throw toFileSystemError(error, "read-dir", normalized);
    }
  }

  /** Lazily traverses the tree while applying depth and entry-kind filters during traversal. */
  async *walk(path = ROOT_PATH, options: WalkOptionsType = {}): AsyncIterableIterator<WalkEntryType> {
    this.#assertOpen();
    const root = normalizePath(path);
    const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY;
    if (maxDepth < 0) return;
    if (Number.isFinite(maxDepth)) assertInteger(maxDepth, "maxDepth");
    const includeFiles = options.includeFiles ?? true;
    const includeDirectories = options.includeDirectories ?? true;

    const rootStat = await this.stat(root, options);
    if (options.includeRoot) {
      const include = rootStat.kind === "file" ? includeFiles : includeDirectories;
      if (include) {
        yield {
          path: root,
          name: basename(root),
          kind: rootStat.kind,
          handle: rootStat.kind === "file" ? new FileHandle(this, root) : new DirectoryHandle(this, root),
          depth: 0,
        };
      }
    }
    if (rootStat.kind === "file" || maxDepth === 0) return;

    yield* walkChildren(this, root, 0, { options, includeFiles, includeDirectories, maxDepth });
  }

  /** Materializes a file or requested byte range after validating offsets and cancellation. */
  async readFile(path: string, options: ReadOptionsType = {}): Promise<Uint8Array> {
    this.#assertOpen();
    const normalized = normalizePath(path);
    if (options.at !== undefined) assertInteger(options.at, "at");
    if (options.length !== undefined) assertInteger(options.length, "length");
    throwIfAborted(options.signal, "read", normalized);
    const ranged = options.at !== undefined || options.length !== undefined;
    const support = ranged ? getSupport(this.adapter, this.optimizations).rangeRead : "native";
    const started = this.#metrics.start();
    try {
      let bytes: Uint8Array;
      if (ranged && this.adapter.capabilities.rangeRead && !this.optimizations.rangeRead) {
        const complete = await this.adapter.readFile(normalized, getAdapterSignalOptions(options.signal));
        const at = options.at ?? 0;
        const end = options.length === undefined
          ? complete.byteLength
          : Math.min(complete.byteLength, at + options.length);
        bytes = complete.subarray(Math.min(at, complete.byteLength), end);
      } else {
        bytes = await this.adapter.readFile(normalized, {
          ...(options.at === undefined ? {} : { at: options.at }),
          ...(options.length === undefined ? {} : { length: options.length }),
          ...getAdapterSignalOptions(options.signal),
        });
      }
      this.#metrics.record("read", { support, bytes: bytes.byteLength, started });
      return bytes;
    } catch (error) {
      this.#metrics.record("read", { support, started, failed: true });
      throw toFileSystemError(error, "read", normalized);
    }
  }

  /** Reads bytes and decodes them with the requested `TextDecoder` encoding. */
  async readText(path: string, options: ReadTextOptionsType = {}): Promise<string> {
    const bytes = await this.readFile(path, options);
    return new TextDecoder(options.encoding).decode(bytes);
  }

  /**
   * Opens an abortable byte stream.
   *
   * Streaming adapters stay incremental. Value-oriented adapters expose one
   * materialized chunk because they cannot supply a native byte stream. Their
   * open promise owns materialization before the stream is published. Aborted
   * native acquisition joins the acquired stream's retirement before rejecting.
   */
  async openReadStream(path: string, options: ReadOptionsType = {}): Promise<ReadableStream<Uint8Array>> {
    this.#assertOpen();
    const normalized = normalizePath(path), signal = options.signal;
    throwIfAborted(signal, "read", normalized);
    const at = options.at;
    throwIfAborted(signal, "read", normalized);
    const length = options.length;
    throwIfAborted(signal, "read", normalized);
    if (at !== undefined) assertInteger(at, "at");
    if (length !== undefined) assertInteger(length, "length");
    const adapterOptions = {
      ...(at === undefined ? {} : { at }),
      ...(length === undefined ? {} : { length }),
      ...getAdapterSignalOptions(signal),
    };
    let nativeStream = false;
    let acquired: ReadableStream<Uint8Array> | undefined;
    try {
      const open = this.optimizations.streamRead && this.adapter.capabilities.streamRead
        ? this.adapter.openReadStream
        : undefined;
      nativeStream = open !== undefined;
      throwIfAborted(signal, "read", normalized);
      if (open !== undefined) {
        acquired = await open.call(this.adapter, normalized, adapterOptions);
      } else {
        // Materialization belongs to acquisition, not an unowned async start.
        // Publishing a stream while this signal-aware read is pending creates
        // two abort actors and hides the actual source operation's lifetime.
        const read = this.adapter.readFile;
        throwIfAborted(signal, "read", normalized);
        const bytes = await read.call(this.adapter, normalized, adapterOptions);
        throwIfAborted(signal, "read", normalized);
        acquired = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        });
      }
      // Native acquisition can settle after cancellation. Until the wrapper
      // accepts ownership, this facade must retire that acquired resource.
      throwIfAborted(signal, "read", normalized);
      const stream = withAbortSignal(acquired, signal, normalized);
      this.#metrics.record("read-stream", { support: nativeStream ? "native" : "emulated" });
      return stream;
    } catch (error) {
      this.#metrics.record("read-stream", {
        support: nativeStream ? "native" : "emulated",
        failed: true,
      });
      try {
        const source = acquired;
        if (source !== undefined) await close([() => retire(source, error)], [error]);
      } catch (retirement) {
        throw toFileSystemError(retirement, "read", normalized);
      }
      throw toFileSystemError(error, "read", normalized);
    }
  }

  /**
   * Writes bytes under the file mutation lock.
   *
   * Native streaming adapters receive streams directly. Other adapters must
   * materialize them below `maxBufferedWriteBytes` or the operation fails.
   */
  async writeFile(path: string, data: WriteDataType, options: WriteOptionsType = {}): Promise<void> {
    this.#assertOpen();
    const normalized = normalizePath(path);
    if (normalized === ROOT_PATH) {
      throw new FileSystemError("type-mismatch", "write", normalized, "The virtual root is a directory.");
    }
    const mode = WriteModeSchema.parse(options.mode ?? "replace");
    if (options.at !== undefined) assertInteger(options.at, "at");
    // Refuse before any lock or source work: an adapter that cannot hold the condition must not write unconditionally.
    if (options.ifRevision !== undefined && this.adapter.capabilities.revisions !== true) {
      throw new FileSystemError(
        "not-supported",
        "write",
        normalized,
        `${this.adapter.name} cannot condition a write on a revision.`,
      );
    }
    this.#admit({
      operation: "write",
      path: normalized,
      mode,
      source: isReadableStream(data) || isAsyncIterable(data) ? "stream" : "bytes",
    });
    const lock = await this.#locks.acquireFile(normalized, options.signal);
    const started = this.#metrics.start();
    let metricSupport: SupportModeType = "native";
    let metricBytes: number | undefined;
    let buffered = 0;

    try {
      if (options.parents) await ensureParents(this.adapter, dirname(normalized), options.signal);
      const parent = await this.adapter.stat(dirname(normalized), getAdapterSignalOptions(options.signal));
      if (parent?.kind !== "directory") {
        throw new FileSystemError(
          "not-found",
          "write",
          normalized,
          `Parent directory '${dirname(normalized)}' does not exist.`,
        );
      }
      // Only an already materialized binary replacement can delegate admission.
      // Encoding strings, materializing Blobs, and acquiring stream producers
      // must still follow destination validation. The adapter keeps its fresh
      // provider revision check; no metadata survives between operations.
      const stream = isReadableStream(data) || isAsyncIterable(data);
      const delegated = mode === "replace" && this.optimizations.writeAdmission &&
        this.adapter.capabilities.validatesReplacement === true && !stream &&
        (ArrayBuffer.isView(data) || data instanceof ArrayBuffer);
      const existing = delegated ? null : await this.adapter.stat(normalized, getAdapterSignalOptions(options.signal));
      if (existing?.kind === "directory") {
        throw new FileSystemError("type-mismatch", "write", normalized, `'${normalized}' is a directory.`);
      }
      const currentSize = existing?.kind === "file" ? existing.size : 0;

      const adapterOptions = {
        mode,
        ...(options.at === undefined ? {} : { at: options.at }),
        ...(options.truncate === undefined ? {} : { truncate: options.truncate }),
        ...(options.mediaType === undefined ? {} : { mediaType: options.mediaType }),
        ...(options.ifRevision === undefined ? {} : { ifRevision: { ...options.ifRevision } }),
        ...getAdapterSignalOptions(options.signal),
      };

      const nativeStream = stream && this.optimizations.streamWrite &&
        this.adapter.capabilities.streamWriteModes.includes(mode) && this.adapter.writeStream !== undefined;
      if (nativeStream) {
        metricSupport = getSupport(this.adapter, this.optimizations).streamWrite[mode];
        // Bind cancellation before metrics starts pulling or driver acquisition
        // awaits. Those steps can otherwise leave the original producer active
        // when the driver rejects before it acquires its own reader.
        let source = withAbortSignal(toByteStream(data), options.signal, normalized, "write");
        if (this.metricsMode !== "none") {
          source = observeBytes(
            source,
            (chunk) => {
              metricBytes = (metricBytes ?? 0) + chunk.byteLength;
            },
            normalized,
            "write",
          );
        }
        try {
          await this.adapter.writeStream!(normalized, source, adapterOptions);
        } catch (error) {
          // Acquisition can fail before the driver reads the source. Join the
          // exact input owner instead of canceling an already-errored pipeline
          // again, and retain independent retirement faults beside this failure.
          await close([() => retire(source, error)], [error]);
          throw error;
        }
      } else if (stream) {
        metricSupport = "emulated";
        const bytes = await collectBytes(
          toByteStream(data),
          this.maxBufferedWriteBytes,
          options.signal,
          "write",
          normalized,
        );
        metricBytes = bytes.byteLength;
        buffered = bytes.byteLength;
        this.#metrics.buffer(buffered);
        metricSupport = this.#support(
          metricSupport,
          getWriteSize(currentSize, bytes.byteLength, mode, options.at, options.truncate ?? false),
        );
        await this.adapter.writeFile(normalized, bytes, adapterOptions);
      } else {
        const bytes = await toBytes(data);
        metricBytes = bytes.byteLength;
        metricSupport = this.#support(
          "native",
          getWriteSize(currentSize, bytes.byteLength, mode, options.at, options.truncate ?? false),
        );
        await this.adapter.writeFile(normalized, bytes, adapterOptions);
      }
      this.#metrics.record("write", {
        support: metricSupport,
        ...(metricBytes === undefined ? {} : { bytes: metricBytes }),
        started,
      });
    } catch (error) {
      this.#metrics.record("write", {
        support: metricSupport,
        ...(metricBytes === undefined ? {} : { bytes: metricBytes }),
        started,
        failed: true,
      });
      // Normalize the observed terminal result. A later signal cannot replace
      // an independent provider/producer failure or an uncertain publication.
      throw toFileSystemError(error, "write", normalized);
    } finally {
      if (buffered > 0) this.#metrics.buffer(-buffered);
      lock.release();
    }
  }

  /**
   * Copies a file or directory tree while holding the structural tree lock.
   *
   * Recursive file-body work is concurrency-limited. Source/destination overlap
   * is rejected before overwrite removal can destroy source data.
   */
  async copy(source: string, destination: string, options: CopyOptionsType = {}): Promise<void> {
    this.#assertOpen();
    const lock = await this.#locks.acquireTree(options.signal);
    try {
      await copyEntry(this.#context, source, destination, options);
    } finally {
      lock.release();
    }
  }

  /**
   * Moves an entry with the adapter's native move when available.
   *
   * Adapters without native move use copy-then-remove. That fallback is
   * deliberately non-atomic and is documented as such for callers.
   */
  async move(source: string, destination: string, options: MoveOptionsType = {}): Promise<void> {
    this.#assertOpen();
    await moveEntry(this.#context, source, destination, options);
  }

  /** Removes a path idempotently and holds the tree lock for recursive structure changes. */
  async remove(path: string, options: RemoveOptionsType = {}): Promise<void> {
    this.#assertOpen();
    const normalized = normalizePath(path);
    this.#admit({ operation: "remove", path: normalized });
    if (normalized === ROOT_PATH) {
      throw new FileSystemError(
        "invalid-operation",
        "remove",
        normalized,
        "The virtual root cannot be removed. Use emptyDir('/') instead.",
      );
    }
    const started = this.#metrics.start();
    let failed = true;
    const lock = await this.#locks.acquireTree(options.signal);
    try {
      await removeEntry(this.adapter, normalized, options.recursive ?? false, options.signal);
      failed = false;
    } finally {
      this.#metrics.record("remove", { support: "native", started, failed });
      lock.release();
    }
  }

  /**
   * Removes every child while preserving the requested directory.
   *
   * Direct-child removals are concurrency-limited, and already-started
   * removals settle before this method releases the structural tree lock.
   */
  async emptyDir(path = ROOT_PATH, options: EmptyDirectoryOptionsType = {}): Promise<void> {
    this.#assertOpen();
    const normalized = normalizePath(path);
    this.#admit({ operation: "remove", path: normalized });
    const physical = await this.adapter.entry?.(normalized, getAdapterSignalOptions(options.signal));
    if (physical === "link" || physical === "foreign") {
      throw new FileSystemError(
        "type-mismatch",
        "empty-dir",
        normalized,
        "Only an ordinary directory can be emptied; links are removed as entries.",
      );
    }
    const stat = await this.stat(normalized, options);
    if (stat.kind !== "directory") {
      throw new FileSystemError("type-mismatch", "empty-dir", normalized, `'${normalized}' is a file.`);
    }
    const concurrency = getConcurrency(options.concurrency);
    const lock = await this.#locks.acquireTree(options.signal);
    const active = new Set<Promise<void>>();
    const failures: ChildFailureType[] = [];
    let prior: { reason: unknown } | undefined;
    try {
      try {
        const children: string[] = [];
        for await (
          const entry of (this.adapter.entries?.(normalized, getAdapterSignalOptions(options.signal)) ??
            this.adapter.readDir(normalized, getAdapterSignalOptions(options.signal)))
        ) {
          children.push(childPath(normalized, entry.name));
        }
        for (const child of children) {
          if (failures.length > 0) break;
          while (active.size >= concurrency) await Promise.race(active);
          if (failures.length > 0) break;
          trackConcurrent(active, failures, removeEntry(this.adapter, child, true, options.signal));
        }
      } catch (error) {
        prior = { reason: error };
      }
      await settleConcurrent(active, failures, prior);
    } catch (reason) {
      throw toFileSystemError(reason, "empty-dir", normalized);
    } finally {
      lock.release();
    }
  }

  /**
   * Opens long-lived asynchronous positional writes and transfers the file lock to the returned resource.
   *
   * This operation is capability-gated rather than emulated with repeated
   * `writeFile(..., { mode: "update" })` calls. Record-oriented backends would
   * otherwise rematerialize an increasingly large file for each chunk, which
   * can turn a linear media write into quadratic work.
   */
  async openWritableFile(
    path: string,
    options: OpenWritableFileOptionsType = {},
  ): Promise<WritableFileType> {
    this.#assertOpen();
    validateWritableOptions(options);
    const normalized = normalizePath(path);
    if (normalized === ROOT_PATH) {
      throw new FileSystemError("type-mismatch", "open-writable-file", normalized, "The virtual root is a directory.");
    }
    throwIfAborted(options.signal, "open-writable-file", normalized);
    if (
      !this.adapter.capabilities.write || !this.adapter.capabilities.positionalWrite ||
      this.adapter.openWritableFile === undefined
    ) {
      throw new FileSystemError(
        "not-supported",
        "open-writable-file",
        normalized,
        `Adapter '${this.adapter.name}' does not provide long-lived positional writes.`,
      );
    }

    const lock = await this.#locks.acquireFile(normalized, options.signal);
    try {
      let stat = await this.adapter.stat(normalized, getAdapterSignalOptions(options.signal));
      if (stat?.kind === "directory") {
        throw new FileSystemError("type-mismatch", "open-writable-file", normalized, `'${normalized}' is a directory.`);
      }
      if (stat === null) {
        if (!options.create) {
          throw new FileSystemError(
            "not-found",
            "open-writable-file",
            normalized,
            `File '${normalized}' does not exist.`,
          );
        }
        if (options.parents) await ensureParents(this.adapter, dirname(normalized), options.signal);
        const parent = await this.adapter.stat(dirname(normalized), getAdapterSignalOptions(options.signal));
        if (parent?.kind !== "directory") {
          throw new FileSystemError(
            "not-found",
            "open-writable-file",
            normalized,
            `Parent directory '${dirname(normalized)}' does not exist.`,
          );
        }
        await this.adapter.writeFile(normalized, new Uint8Array(), {
          mode: "replace",
          ...getAdapterSignalOptions(options.signal),
        });
        stat = await this.adapter.stat(normalized, getAdapterSignalOptions(options.signal));
        if (stat?.kind !== "file") {
          throw new FileSystemError(
            "unknown",
            "open-writable-file",
            normalized,
            `Adapter '${this.adapter.name}' did not expose the file after creating it.`,
          );
        }
      }

      const file = await this.adapter.openWritableFile(normalized, options);
      return new ManagedWritableFile(normalized, file, lock, options.signal);
    } catch (error) {
      lock.release();
      throw toFileSystemError(error, "open-writable-file", normalized);
    }
  }

  /**
   * Opens synchronous random access and transfers the file mutation lock to the returned resource.
   *
   * The caller must close the returned file. Closing it releases both the
   * adapter-native resource and the facade lock.
   */
  async openSyncFile(path: string, options: OpenSyncFileOptionsType = {}): Promise<SyncFileType> {
    this.#assertOpen();
    const normalized = normalizePath(path);
    if (normalized === ROOT_PATH) {
      throw new FileSystemError("type-mismatch", "open-sync-file", normalized, "The virtual root is a directory.");
    }
    throwIfAborted(options.signal, "open-sync-file", normalized);
    if (
      !this.adapter.capabilities.write || !this.adapter.capabilities.syncAccess ||
      this.adapter.openSyncFile === undefined
    ) {
      throw new FileSystemError(
        "not-supported",
        "open-sync-file",
        normalized,
        `Adapter '${this.adapter.name}' does not provide synchronous file access.`,
      );
    }

    const lock = await this.#locks.acquireFile(normalized, options.signal);
    try {
      let stat = await this.adapter.stat(normalized, getAdapterSignalOptions(options.signal));
      if (stat?.kind === "directory") {
        throw new FileSystemError("type-mismatch", "open-sync-file", normalized, `'${normalized}' is a directory.`);
      }
      if (stat === null) {
        if (!options.create) {
          throw new FileSystemError("not-found", "open-sync-file", normalized, `File '${normalized}' does not exist.`);
        }
        if (options.parents) await ensureParents(this.adapter, dirname(normalized), options.signal);
        const parent = await this.adapter.stat(dirname(normalized), getAdapterSignalOptions(options.signal));
        if (parent?.kind !== "directory") {
          throw new FileSystemError(
            "not-found",
            "open-sync-file",
            normalized,
            `Parent directory '${dirname(normalized)}' does not exist.`,
          );
        }
        await this.adapter.writeFile(normalized, new Uint8Array(), {
          mode: "replace",
          ...getAdapterSignalOptions(options.signal),
        });
        stat = await this.adapter.stat(normalized, getAdapterSignalOptions(options.signal));
        if (stat?.kind !== "file") {
          throw new FileSystemError(
            "unknown",
            "open-sync-file",
            normalized,
            `Adapter '${this.adapter.name}' did not expose the file after creating it.`,
          );
        }
      }

      const file = await this.adapter.openSyncFile(normalized);
      return new ManagedSyncFile(normalized, file, lock);
    } catch (error) {
      lock.release();
      throw toFileSystemError(error, "open-sync-file", normalized);
    }
  }

  /**
   * Closes this facade once and optionally disposes the injected adapter.
   *
   * `disposeAdapter` controls ownership transfer. Borrowed adapters remain live
   * after the facade closes. Every terminal caller joins the actual disposal,
   * including a rejected disposal. Close stops admission; callers still own
   * returned streams and file resources and must settle their work before
   * disposing an adapter that they transferred to this facade.
   */
  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing;
    this.#closed = true;
    this.#closing = Promise.resolve().then(async () => {
      if (this.#disposeAdapter) await this.adapter.dispose?.();
    });
    return this.#closing;
  }

  /** Enables `await using` to apply the same ownership rules as {@link close}. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

/**
 * Creates the OPFS-shaped facade over any filesystem adapter.
 *
 * This is the point where the architecture becomes user-facing. The selected
 * driver still owns native requirements, limits, metrics, and disposal rules.
 * The adapter still owns the primitive translation. This function only adds the
 * portable OPFS-shaped behavior above those layers.
 *
 * @example Deno-backed frontend
 * ```ts
 * import { createFileSystem } from "@okikio/opfs";
 * import { createDenoAdapter } from "@okikio/opfs/adapter/deno";
 *
 * const fs = createFileSystem(createDenoAdapter({ root: "./data" }));
 * const file = await fs.root.getFileHandle("hello.txt", { create: true });
 * const writable = await file.createWritable();
 * await writable.write("hello");
 * await writable.close();
 * ```
 */
export function createFileSystem<Backend = unknown>(
  adapter: AdapterType<Backend>,
  options: FileSystemOptionsType = {},
): FileSystemType<Backend> {
  return new FileSystemFacade(adapter, options);
}
