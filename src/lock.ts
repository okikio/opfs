import { FileSystemError, throwIfAborted } from "./error.ts";
import type { CoordinationModeType } from "./schema.ts";

/** Lock access required for one operation. */
type LockModeType = "shared" | "exclusive";

/** Explicit release contract used by file and tree operations. */
export interface HeldLockType {
  /** Releases the lock once. Repeated calls have no effect. */
  release(): void;
}

/** Internal lock provider implemented by Web Locks, local FIFO locks, or no-op mode. */
interface LockCoordinatorType {
  /** Acquires a named shared or exclusive lock and returns explicit release ownership. */
  acquire(name: string, mode: LockModeType, signal?: AbortSignal): Promise<HeldLockType>;
}

/** One local lock request waiting for grant or AbortSignal cancellation. */
interface PendingLockType {
  /** Requested reader or writer mode. */
  mode: LockModeType;
  /** Completes the waiting acquire call after the request is granted. */
  resolve: (lock: HeldLockType) => void;
  /** Rejects the waiting acquire call when cancellation removes it from the queue. */
  reject: (reason: FileSystemError) => void;
  /** Optional cancellation signal retained only while this request is queued. */
  signal?: AbortSignal;
  /** Listener removed at grant time so completed locks do not retain queued cancellation state. */
  onAbort?: () => void;
}

/** Reader/writer state for one in-realm lock name. */
interface LocalLockStateType {
  /** Number of currently granted shared readers. */
  readers: number;
  /** True while one exclusive writer owns this lock name. */
  writer: boolean;
  /** FIFO requests waiting behind current owners or an earlier exclusive waiter. */
  queue: PendingLockType[];
}

/**
 * Process-realm lock registry shared by every local coordinator instance.
 *
 * Sharing by lock name makes separately created filesystem facades coordinate
 * when they deliberately use the same `lockPrefix`. Empty states are removed.
 */
const localStates = new Map<string, LocalLockStateType>();

/** Returns the existing local state or creates its empty reader/writer queue. */
function getState(name: string): LocalLockStateType {
  let state = localStates.get(name);
  if (state === undefined) {
    state = { readers: 0, writer: false, queue: [] };
    localStates.set(name, state);
  }
  return state;
}

/** Converts lock cancellation into the package's stable aborted error. */
function getAbortError(signal: AbortSignal): FileSystemError {
  return new FileSystemError("aborted", "lock", undefined, "Lock acquisition was aborted.", signal.reason);
}

/** Tests current reader/writer occupancy without considering queued fairness. */
function canGrant(state: LocalLockStateType, mode: LockModeType): boolean {
  return mode === "exclusive" ? !state.writer && state.readers === 0 : !state.writer;
}

/** Deletes unused lock state so dynamic file paths do not grow the registry forever. */
function removeEmptyState(name: string, state: LocalLockStateType): void {
  if (!state.writer && state.readers === 0 && state.queue.length === 0) localStates.delete(name);
}

/** Grants one queued request and binds idempotent release to the same state. */
function grant(name: string, state: LocalLockStateType, pending: PendingLockType): void {
  if (pending.signal !== undefined && pending.onAbort !== undefined) {
    pending.signal.removeEventListener("abort", pending.onAbort);
  }
  if (pending.mode === "exclusive") state.writer = true;
  else state.readers += 1;

  let released = false;
  pending.resolve({
    release() {
      if (released) return;
      released = true;
      if (pending.mode === "exclusive") state.writer = false;
      else state.readers -= 1;
      drain(name, state);
      removeEmptyState(name, state);
    },
  });
}

/**
 * Grants queued readers until an exclusive request reaches the head.
 *
 * This FIFO rule prevents a steady stream of new readers from starving a queued
 * writer. It also makes abort removal deterministic because queue order remains
 * the only authority for pending requests.
 */
function drain(name: string, state: LocalLockStateType): void {
  if (state.writer || state.queue.length === 0) return;
  const first = state.queue[0];
  if (first === undefined) return;

  if (first.mode === "exclusive") {
    if (state.readers !== 0) return;
    state.queue.shift();
    grant(name, state, first);
    return;
  }

  while (!state.writer) {
    const pending = state.queue[0];
    if (pending === undefined || pending.mode !== "shared") break;
    state.queue.shift();
    grant(name, state, pending);
  }
}

/** In-realm FIFO reader/writer coordinator used when Web Locks are unavailable. */
class LocalLockCoordinator implements LockCoordinatorType {
  /**
   * Acquires one process-realm FIFO reader/writer lock.
   *
   * New readers do not bypass an already queued writer, which prevents writer
   * starvation. Aborted queued requests are removed before the queue drains.
   */
  async acquire(name: string, mode: LockModeType, signal?: AbortSignal): Promise<HeldLockType> {
    if (signal?.aborted) throw getAbortError(signal);
    const state = getState(name);

    return await new Promise<HeldLockType>((resolve, reject) => {
      const pending: PendingLockType = { mode, resolve, reject };
      if (signal !== undefined) {
        pending.signal = signal;
        pending.onAbort = () => {
          const index = state.queue.indexOf(pending);
          if (index < 0) return;
          state.queue.splice(index, 1);
          reject(getAbortError(signal));
          drain(name, state);
          removeEmptyState(name, state);
        };
        signal.addEventListener("abort", pending.onAbort, { once: true });
      }

      // New readers queue behind an exclusive waiter so a writer cannot starve.
      if (state.queue.length === 0 && canGrant(state, mode)) grant(name, state, pending);
      else state.queue.push(pending);
    });
  }
}

/** Structural Web Locks subset kept independent of browser-specific declaration versions. */
interface WebLocksType {
  /** Holds a browser Web Lock until the callback promise settles. */
  request<T>(
    name: string,
    options: { mode: LockModeType; signal?: AbortSignal },
    callback: () => Promise<T>,
  ): Promise<T>;
}

/** Resolves navigator.locks lazily so server imports stay side-effect free. */
function getWebLocks(): WebLocksType | undefined {
  const navigatorValue = Reflect.get(globalThis, "navigator") as { locks?: WebLocksType } | undefined;
  return navigatorValue?.locks;
}

/** Cross-tab/worker coordinator backed by the browser Web Locks API. */
class WebLockCoordinator implements LockCoordinatorType {
  /** Web Locks manager supplied by the current browser realm. */
  readonly #locks: WebLocksType;

  constructor(locks: WebLocksType) {
    this.#locks = locks;
  }

  /**
   * Acquires one process-realm FIFO reader/writer lock.
   *
   * New readers do not bypass an already queued writer, which prevents writer
   * starvation. Aborted queued requests are removed before the queue drains.
   */
  async acquire(name: string, mode: LockModeType, signal?: AbortSignal): Promise<HeldLockType> {
    throwIfAborted(signal, "lock");

    let markAcquired: (() => void) | undefined;
    const acquired = new Promise<void>((resolve) => { markAcquired = resolve; });
    let releaseRequest: (() => void) | undefined;
    const hold = new Promise<void>((resolve) => { releaseRequest = resolve; });
    const options: { mode: LockModeType; signal?: AbortSignal } = { mode };
    if (signal !== undefined) options.signal = signal;

    const request = this.#locks.request(name, options, async () => {
      markAcquired?.();
      await hold;
    });
    await Promise.race([acquired, request]);

    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        releaseRequest?.();
        void request.catch(() => undefined);
      },
    };
  }
}

/** Coordination mode that preserves cancellation checks but acquires no lock. */
class NoopLockCoordinator implements LockCoordinatorType {
  /** Returns an immediately released ownership token after preserving cancellation checks. */
  async acquire(_name: string, _mode: LockModeType, signal?: AbortSignal): Promise<HeldLockType> {
    throwIfAborted(signal, "lock");
    return { release() {} };
  }
}

/**
 * Coordinates facade mutations without making an adapter own application state.
 *
 * File operations take a shared tree gate plus an exclusive path lock. Tree
 * mutations take the tree gate exclusively. This permits independent file
 * writes while preventing recursive remove/copy/move from racing those writes.
 */
export class MutationLocks {
  /** Selected coordination backend for every lock name created by this facade. */
  readonly #coordinator: LockCoordinatorType;
  /** Shared lock name that coordinates recursive structure changes with file mutations. */
  readonly #treeName: string;
  /** Namespace used to derive stable file-lock names across cooperating facade instances. */
  readonly #prefix: string;

  constructor(mode: CoordinationModeType, prefix: string) {
    this.#prefix = prefix;
    this.#treeName = `${prefix}:tree`;
    const webLocks = getWebLocks();

    if (mode === "none") this.#coordinator = new NoopLockCoordinator();
    else if (mode === "local") this.#coordinator = new LocalLockCoordinator();
    else if (mode === "web-locks") {
      if (webLocks === undefined) {
        throw new FileSystemError(
          "unavailable",
          "configure-locks",
          undefined,
          "Web Locks were requested but are unavailable in this context.",
        );
      }
      this.#coordinator = new WebLockCoordinator(webLocks);
    } else {
      this.#coordinator = webLocks === undefined ? new LocalLockCoordinator() : new WebLockCoordinator(webLocks);
    }
  }

  /** Acquires the lock set used by one file mutation. */
  async acquireFile(path: string, signal?: AbortSignal): Promise<HeldLockType> {
    const tree = await this.#coordinator.acquire(this.#treeName, "shared", signal);
    try {
      const file = await this.#coordinator.acquire(`${this.#prefix}:file:${path}`, "exclusive", signal);
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          file.release();
          tree.release();
        },
      };
    } catch (error) {
      tree.release();
      throw error;
    }
  }

  /** Acquires exclusive access to recursive tree structure. */
  async acquireTree(signal?: AbortSignal): Promise<HeldLockType> {
    return await this.#coordinator.acquire(this.#treeName, "exclusive", signal);
  }
}
