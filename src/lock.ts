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

/** One local lock request waiting for grant or cancellation. */
interface PendingLockType {
  /** Requested reader or writer mode. */
  mode: LockModeType;
  /** Completes the waiting acquire call after the request is granted. */
  resolve: (lock: HeldLockType) => void;
  /** Rejects the waiting acquire call when cancellation removes it from the queue. */
  reject: (reason: FileSystemError) => void;
  /** Cancellation signal retained only while this request is queued. */
  signal?: AbortSignal;
  /** Listener removed at grant time so granted locks retain no queued cancellation state. */
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
 * when they deliberately use the same `lockPrefix`. Empty states are removed
 * so dynamic file paths cannot grow this registry without limit.
 */
const localStates = new Map<string, LocalLockStateType>();

/** Returns the existing local state or creates an empty reader/writer queue. */
function getState(name: string): LocalLockStateType {
  let state = localStates.get(name);
  if (state === undefined) {
    state = { readers: 0, writer: false, queue: [] };
    localStates.set(name, state);
  }
  return state;
}

/** Converts lock cancellation into the package's stable aborted failure. */
function getAbortError(signal: AbortSignal): FileSystemError {
  return new FileSystemError("aborted", "lock", undefined, "Lock acquisition was aborted.", signal.reason);
}

/** Tests current reader/writer occupancy without considering queued fairness. */
function canGrant(state: LocalLockStateType, mode: LockModeType): boolean {
  return mode === "exclusive" ? !state.writer && state.readers === 0 : !state.writer;
}

/** Deletes unused lock state after the final owner and waiter leave. */
function removeEmptyState(name: string, state: LocalLockStateType): void {
  if (!state.writer && state.readers === 0 && state.queue.length === 0) localStates.delete(name);
}

/** Idempotent ownership token for one granted in-realm reader or writer. */
class LocalHeldLock implements HeldLockType {
  /** Lock registry name whose state must be updated at release. */
  readonly #name: string;
  /** Shared mutable state that records readers, writer, and waiters. */
  readonly #state: LocalLockStateType;
  /** Mode granted to this owner. */
  readonly #mode: LockModeType;
  /** Prevents a repeated release from decrementing state twice. */
  #released = false;

  /** Records the exact state and mode whose ownership this token represents. */
  constructor(name: string, state: LocalLockStateType, mode: LockModeType) {
    this.#name = name;
    this.#state = state;
    this.#mode = mode;
  }

  /** Releases once, then drains FIFO waiters against the updated occupancy. */
  release(): void {
    if (this.#released) return;
    this.#released = true;
    if (this.#mode === "exclusive") this.#state.writer = false;
    else this.#state.readers -= 1;
    drain(this.#name, this.#state);
    removeEmptyState(this.#name, this.#state);
  }
}

/** Grants one queued request and transfers release ownership to its waiter. */
function grant(name: string, state: LocalLockStateType, pending: PendingLockType): void {
  if (pending.signal !== undefined && pending.onAbort !== undefined) {
    pending.signal.removeEventListener("abort", pending.onAbort);
  }
  if (pending.mode === "exclusive") state.writer = true;
  else state.readers += 1;
  pending.resolve(new LocalHeldLock(name, state, pending.mode));
}

/** Removes one still-pending request after its AbortSignal fires. */
function cancelPending(
  name: string,
  state: LocalLockStateType,
  pending: PendingLockType,
  signal: AbortSignal,
): void {
  const index = state.queue.indexOf(pending);
  if (index < 0) return;
  state.queue.splice(index, 1);
  pending.reject(getAbortError(signal));
  drain(name, state);
  removeEmptyState(name, state);
}

/** Creates, wires, and either grants or queues one local lock request. */
function enqueuePending(
  name: string,
  state: LocalLockStateType,
  mode: LockModeType,
  signal: AbortSignal | undefined,
  resolve: (lock: HeldLockType) => void,
  reject: (reason: FileSystemError) => void,
): void {
  const pending: PendingLockType = { mode, resolve, reject };
  if (signal !== undefined) {
    pending.signal = signal;
    pending.onAbort = () => cancelPending(name, state, pending, signal);
    signal.addEventListener("abort", pending.onAbort, { once: true });
  }

  // New readers queue behind an exclusive waiter so a writer cannot starve.
  if (state.queue.length === 0 && canGrant(state, mode)) grant(name, state, pending);
  else state.queue.push(pending);
}

/**
 * Grants queued readers until an exclusive request reaches the head.
 *
 * FIFO order prevents a steady stream of readers from starving a queued writer.
 * It also makes cancellation deterministic because queue order remains the only
 * authority for requests that do not yet own the lock.
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
   * Acquires one in-realm FIFO reader/writer lock.
   *
   * New readers do not bypass an already queued writer. Aborted queued requests
   * are removed before the queue drains, while an already granted owner retains
   * the lock until its explicit release.
   */
  async acquire(name: string, mode: LockModeType, signal?: AbortSignal): Promise<HeldLockType> {
    if (signal?.aborted) throw getAbortError(signal);
    const state = getState(name);
    return await new Promise((resolve, reject) => enqueuePending(name, state, mode, signal, resolve, reject));
  }
}

/** Structural Web Locks subset kept independent of browser declaration versions. */
interface WebLocksType {
  /** Holds a browser Web Lock until the callback promise settles. */
  request<T>(
    name: string,
    options: { mode: LockModeType; signal?: AbortSignal },
    callback: () => Promise<T>,
  ): Promise<T>;
}

/** Resolves `navigator.locks` lazily so server imports stay side-effect free. */
function getWebLocks(): WebLocksType | undefined {
  const navigatorValue = Reflect.get(globalThis, "navigator") as { locks?: WebLocksType } | undefined;
  return navigatorValue?.locks;
}

/** Ownership token that releases a held Web Lock by settling its hold promise. */
class WebHeldLock implements HeldLockType {
  /** Resolves the promise awaited by the Web Locks callback. */
  readonly #releaseRequest: () => void;
  /** Browser request promise observed after release for late failures. */
  readonly #request: Promise<void>;
  /** Prevents repeated release from resolving the hold more than once. */
  #released = false;

  /** Captures the hold resolver and browser request that share one lifetime. */
  constructor(releaseRequest: () => void, request: Promise<void>) {
    this.#releaseRequest = releaseRequest;
    this.#request = request;
  }

  /** Releases exactly once and consumes any later Web Locks request rejection. */
  release(): void {
    if (this.#released) return;
    this.#released = true;
    this.#releaseRequest();
    void this.#request.catch(() => undefined);
  }
}

/** Cross-tab/worker coordinator backed by the browser Web Locks API. */
class WebLockCoordinator implements LockCoordinatorType {
  /** Web Locks manager supplied by the current browser realm. */
  readonly #locks: WebLocksType;

  /** Borrows the realm's Web Locks manager without changing its lifecycle. */
  constructor(locks: WebLocksType) {
    this.#locks = locks;
  }

  /**
   * Acquires one browser-managed shared or exclusive lock.
   *
   * The request callback waits on an explicit hold promise. The returned token
   * resolves that promise, which makes the Web Locks API release ownership.
   */
  async acquire(name: string, mode: LockModeType, signal?: AbortSignal): Promise<HeldLockType> {
    throwIfAborted(signal, "lock");

    const acquired = Promise.withResolvers<void>();
    const hold = Promise.withResolvers<void>();
    const options: { mode: LockModeType; signal?: AbortSignal } = { mode };
    if (signal !== undefined) options.signal = signal;

    const request = this.#locks.request(name, options, async () => {
      acquired.resolve();
      await hold.promise;
    });
    await Promise.race([acquired.promise, request]);
    return new WebHeldLock(hold.resolve, request);
  }
}

/** No-op ownership token used only when coordination is explicitly disabled. */
class NoopHeldLock implements HeldLockType {
  /** No resource exists to release in `none` coordination mode. */
  release(): void {}
}

/** Coordination mode that preserves cancellation checks but acquires no lock. */
class NoopLockCoordinator implements LockCoordinatorType {
  /** Returns a no-op token after preserving the ordinary acquisition abort check. */
  async acquire(_name: string, _mode: LockModeType, signal?: AbortSignal): Promise<HeldLockType> {
    throwIfAborted(signal, "lock");
    return new NoopHeldLock();
  }
}

/** Lock token that owns a file path lock and its shared tree lock together. */
class FileHeldLock implements HeldLockType {
  /** Exclusive file lock released before tree ownership. */
  readonly #file: HeldLockType;
  /** Shared tree lock released after the file lock. */
  readonly #tree: HeldLockType;
  /** Prevents repeated release from forwarding twice. */
  #released = false;

  /** Takes ownership of both locks acquired for one file mutation. */
  constructor(file: HeldLockType, tree: HeldLockType) {
    this.#file = file;
    this.#tree = tree;
  }

  /** Releases file ownership first, then the shared structural gate. */
  release(): void {
    if (this.#released) return;
    this.#released = true;
    this.#file.release();
    this.#tree.release();
  }
}

/**
 * Coordinates facade mutations without making an adapter own application state.
 *
 * File operations take a shared tree gate plus an exclusive path lock. Tree
 * mutations take the tree gate exclusively. This permits independent file
 * writes while preventing recursive remove, copy, or move from racing them.
 */
export class MutationLocks {
  /** Selected coordination backend for every lock name created by this facade. */
  readonly #coordinator: LockCoordinatorType;
  /** Shared lock name that coordinates recursive structure changes with file mutations. */
  readonly #treeName: string;
  /** Namespace used to derive stable file-lock names across cooperating facade instances. */
  readonly #prefix: string;

  /** Selects no-op, in-realm, Web Locks, or automatic coordination once. */
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

  /** Acquires the shared tree gate plus exclusive lock for one canonical file path. */
  async acquireFile(path: string, signal?: AbortSignal): Promise<HeldLockType> {
    const tree = await this.#coordinator.acquire(this.#treeName, "shared", signal);
    try {
      const file = await this.#coordinator.acquire(`${this.#prefix}:file:${path}`, "exclusive", signal);
      return new FileHeldLock(file, tree);
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
