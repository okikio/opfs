import { committed, IndexedDbBackend, openIndexedDbDriver, result } from "../../../src/driver/indexeddb.ts";
import { FileSystemError } from "../../../src/error.ts";
import type { FileRecordType } from "../../../src/schema.ts";
import type { FileDriverWriteOptionsType } from "../../../src/driver/file.ts";
import type { IndexedDbOpenOptionsType } from "../../../src/driver/indexeddb.ts";
import { withReleases } from "../../close.ts";

/** Each lane changes actual acquired native capabilities; no fake transaction is substituted. */
export type LaneType =
  | "success"
  | "setup-before"
  | "setup-after"
  | "store-before"
  | "store-after"
  | "request-before"
  | "request-after"
  | "signal-before"
  | "signal-after"
  | "signal-abort-throw"
  | "effect-abort"
  | "effect-abort-throw"
  | "abort-before"
  | "detach"
  | "two-detaches"
  | "primary-detaches"
  | "primary-abort"
  | "result-getter"
  | "state-getter";

/** Restores the exact own descriptor, including the absence of an own property. */
function patch(target: object, key: PropertyKey, descriptor: PropertyDescriptor): () => void {
  const previous = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, ...descriptor });
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    if (previous) Object.defineProperty(target, key, previous);
    else Reflect.deleteProperty(target, key);
  };
}

/** Independent fixed input used by native persistence checks, not a candidate round trip. */
function record(data = "YQ=="): FileRecordType {
  return {
    version: 1,
    path: "/a",
    parent: "/",
    name: "a",
    kind: "file",
    data,
    size: 1,
    lastModified: 7,
    mediaType: "text/plain",
  };
}

/** Native fixture acquisition uses attributes; the candidate uses separate owned listeners. */
function open(name: string): Promise<IDBDatabase> {
  const request = indexedDB.open(name, 1);
  request.onupgradeneeded = () => {
    const store = request.result.createObjectStore("entries", { keyPath: "path" });
    store.createIndex("parent", "parent");
  };
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function remove(name: string): Promise<void> {
  const request = indexedDB.deleteDatabase(name);
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Fixture still owns an open database."));
  });
}

/** Actual independent request and commit observations for setup and final persistence. */
function stored(database: IDBDatabase, value?: FileRecordType): Promise<unknown> {
  const transaction = database.transaction("entries", value ? "readwrite" : "readonly");
  const request = value ? transaction.objectStore("entries").put(value) : transaction.objectStore("entries").get("/a");
  let output: unknown;
  request.onsuccess = () => {
    output = request.result;
  };
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve(output);
    transaction.onabort = () => reject(transaction.error);
  });
}

/** Raw failure presence remains separate from its value, including undefined. */
function reasons(failure: { reason: unknown } | undefined): readonly unknown[] {
  if (!failure) return [];
  return failure.reason instanceof AggregateError ? failure.reason.errors : [failure.reason];
}

export interface ObservationType {
  readonly events: readonly string[];
  readonly removed: readonly string[];
  readonly faults: readonly string[];
  readonly persisted: unknown;
  readonly callerCause: boolean;
  /** Native request acquisition identity is represented by its unique array entry. */
  readonly requests: readonly { operation: "get" | "put"; installed: readonly string[]; removed: readonly string[] }[];
}

/**
 * Installs before/after effect refusals on actual transactions, requests and signals.
 * Native terminal listeners use an independent captured method and are joined
 * before reading persistence. Fixtures always restore borrowed capabilities.
 */
export async function run(
  lane: LaneType,
  kind: "undefined" | "null" | "error",
  operation: "write" | "get" | "set" | "delete" | "list" = "write",
): Promise<ObservationType> {
  return await withReleases(async (releases) => {
    const name = `opfs-idb-${crypto.randomUUID()}`;
    releases.push(() => remove(name));
    const database = await open(name);
    releases.push(() => database.close());
    await stored(database, record());
    const primary = kind === "undefined" ? undefined : kind === "null" ? null : new Error("fixture primary");
    // Equal-valued occurrences intentionally remain distinguishable by their count.
    const secondary = primary;
    const events: string[] = [];
    const nativeFailures: unknown[] = [];
    const removed: string[] = [];
    const requests: Array<{ operation: "get" | "put"; installed: string[]; removed: string[] }> = [];
    const acquiredRequests = new WeakSet<object>();
    const nativeAdd = EventTarget.prototype.addEventListener;
    const nativeRemove = EventTarget.prototype.removeEventListener;
    const transactionMethod = database.transaction;
    const controller = new AbortController();
    let terminal: Promise<void> | undefined;
    const restores: Array<() => void> = [];
    releases.push(() => {
      for (const restore of restores.toReversed()) restore();
    });
    restores.push(patch(database, "transaction", {
      value: (...args: Parameters<IDBDatabase["transaction"]>) => {
        const transaction = Reflect.apply(transactionMethod, database, args) as IDBTransaction;
        terminal = new Promise<void>((resolve) => {
          nativeAdd.call(transaction, "complete", () => {
            events.push("complete");
            resolve();
          }, { once: true });
          nativeAdd.call(transaction, "abort", () => {
            events.push("abort");
            if (transaction.error !== null) nativeFailures.push(transaction.error);
            resolve();
          }, { once: true });
        });
        const add = transaction.addEventListener;
        restores.push(patch(transaction, "addEventListener", {
          value: (
            type: string,
            callback: EventListenerOrEventListenerObject | null,
            options?: boolean | AddEventListenerOptions,
          ) => {
            if (type === "complete" && lane === "setup-before") throw primary;
            if (callback !== null) add.call(transaction, type, callback, options);
            if (type === "complete" && lane === "setup-after") throw primary;
          },
        }));
        restores.push(patch(transaction, "removeEventListener", {
          value: (
            type: string,
            callback: EventListenerOrEventListenerObject | null,
            options?: boolean | EventListenerOptions,
          ) => {
            removed.push(type);
            if (callback !== null) nativeRemove.call(transaction, type, callback, options);
            if (type === "complete" && ["detach", "two-detaches", "primary-detaches"].includes(lane)) throw primary;
            if (type === "abort" && ["two-detaches", "primary-detaches"].includes(lane)) throw secondary;
          },
        }));
        const objectStore = transaction.objectStore;
        restores.push(patch(transaction, "objectStore", {
          value: (store: string) => {
            if (["store-before", "primary-detaches", "primary-abort", "abort-before"].includes(lane)) throw primary;
            const output = objectStore.call(transaction, store);
            if (lane === "store-after") throw primary;
            const observe = <T>(request: IDBRequest<T>, operation: "get" | "put"): IDBRequest<T> => {
              if (acquiredRequests.has(request)) throw new Error("Fixture repeated one native request acquisition.");
              acquiredRequests.add(request);
              const receipt = { operation, installed: [] as string[], removed: [] as string[] };
              requests.push(receipt);
              nativeAdd.call(request, "error", () => {
                nativeFailures.push(request.error);
              }, { once: true });
              const add = request.addEventListener;
              restores.push(patch(request, "addEventListener", {
                value: (
                  type: string,
                  callback: EventListenerOrEventListenerObject | null,
                  options?: boolean | AddEventListenerOptions,
                ) => {
                  if (type === "success" && lane === "request-before") throw primary;
                  if (callback !== null) {
                    add.call(request, type, callback, options);
                    receipt.installed.push(type);
                  }
                  if (type === "success" && lane === "request-after") throw primary;
                },
              }));
              restores.push(patch(request, "removeEventListener", {
                value: (
                  type: string,
                  callback: EventListenerOrEventListenerObject | null,
                  options?: boolean | EventListenerOptions,
                ) => {
                  removed.push(type);
                  receipt.removed.push(type);
                  if (callback !== null) nativeRemove.call(request, type, callback, options);
                },
              }));
              if (lane === "state-getter") {
                restores.push(patch(request, "readyState", {
                  get: () => {
                    throw primary;
                  },
                }));
              }
              if (lane === "result-getter") {
                restores.push(patch(request, "result", {
                  get: () => {
                    throw primary;
                  },
                }));
              }
              return request;
            };
            const get = output.get;
            const put = output.put;
            restores.push(patch(output, "get", {
              value: (key: IDBValidKey | IDBKeyRange) => observe(get.call(output, key), "get"),
            }));
            restores.push(patch(output, "put", {
              value: (...args: Parameters<IDBObjectStore["put"]>) =>
                observe(Reflect.apply(put, output, args) as IDBRequest<IDBValidKey>, "put"),
            }));
            return output;
          },
        }));
        if (lane === "primary-abort" || lane === "abort-before") {
          const abort = transaction.abort;
          restores.push(patch(transaction, "abort", {
            value: () => {
              if (lane !== "abort-before") abort.call(transaction);
              throw secondary;
            },
          }));
        }
        return transaction;
      },
    }));
    if (lane.startsWith("signal-")) {
      const add = controller.signal.addEventListener;
      restores.push(patch(controller.signal, "addEventListener", {
        value: (
          type: string,
          callback: EventListenerOrEventListenerObject | null,
          options?: boolean | AddEventListenerOptions,
        ) => {
          if (lane === "signal-before") throw primary;
          if (callback !== null) add.call(controller.signal, type, callback, options);
          if (lane === "signal-abort-throw") controller.abort(primary);
          throw primary;
        },
      }));
    }
    if (lane.startsWith("signal-") || lane.startsWith("effect-")) {
      restores.push(patch(controller.signal, "removeEventListener", {
        value: (
          type: string,
          callback: EventListenerOrEventListenerObject | null,
          options?: boolean | EventListenerOptions,
        ) => {
          removed.push(`signal:${type}`);
          if (callback !== null) nativeRemove.call(controller.signal, type, callback, options);
        },
      }));
    }
    const backend = new IndexedDbBackend(database, {});
    let failure: { reason: unknown } | undefined;
    try {
      if (operation === "get") await backend.get("/a");
      else if (operation === "set") await backend.set(record("Yg=="));
      else if (operation === "delete") await backend.delete("/a");
      else if (operation === "list") await Array.fromAsync(backend.list("/"));
      else {
        const options: FileDriverWriteOptionsType = {
          mode: "replace",
          ...(lane.startsWith("signal-") || lane.startsWith("effect-") ? { signal: controller.signal } : {}),
        };
        if (lane.startsWith("effect-")) {
          // Define on the admitted object. Spreading a getter object would run
          // this before writeFile acquires its transaction and test preabort instead.
          Object.defineProperty(options, "mediaType", {
            get: () => {
              controller.abort(primary);
              if (lane === "effect-abort-throw") throw primary;
              return "text/plain";
            },
          });
        }
        await backend.writeFile("/a", new Uint8Array([98]), options);
      }
    } catch (reason) {
      failure = { reason };
    }
    // This is independent physical completion, not inference from candidate return.
    await terminal;
    for (const restore of restores.splice(0).toReversed()) restore();
    const faults = reasons(failure);
    const callerCause = faults.some((reason) =>
      reason instanceof FileSystemError && reason.cause === controller.signal.reason
    );
    return {
      events,
      removed,
      faults: faults.map((reason) =>
        reason instanceof FileSystemError
          ? "caller"
          : reason === primary
          ? "primary"
          : nativeFailures.includes(reason)
          ? "native"
          : "unexpected"
      ),
      persisted: await stored(database),
      callerCause,
      requests,
    };
  });
}

/** A canceled native request error is not an aborted transaction. Caller handlers remain installed. */
export async function recovered(): Promise<unknown> {
  return await withReleases(async (releases) => {
    const name = `opfs-idb-recover-${crypto.randomUUID()}`;
    releases.push(() => remove(name));
    const database = await open(name);
    releases.push(() => database.close());
    await stored(database, record());
    const transaction = database.transaction("entries", "readwrite");
    let callerComplete = 0;
    let callerError = 0;
    transaction.oncomplete = () => {
      callerComplete++;
    };
    transaction.onerror = (event) => {
      event.preventDefault();
      callerError++;
    };
    const done = committed(transaction);
    transaction.objectStore("entries").add(record());
    const request = transaction.objectStore("entries").put(record("Yg=="));
    let callerSuccess = 0;
    request.onsuccess = () => {
      callerSuccess++;
    };
    await result(request);
    await done;
    return { callerComplete, callerError, callerSuccess, persisted: await stored(database) };
  });
}

/** Actual open/upgrade acquisition rollback, with native handle and close receipts. */
export async function opening(
  lane:
    | "upgrade"
    | "upgrade-abort-before"
    | "upgrade-abort-after"
    | "detach"
    | "create"
    | "close"
    | "setup-before"
    | "setup-after"
    | "setup-prior"
    | "setup-both-after"
    | "setup-async"
    | "setup-release-work"
    | "setup-then-getter"
    | "setup-then-after"
    | "setup-then-reject-throw"
    | "setup-state-getter"
    | "setup-state-detach",
  kind: "undefined" | "null" | "error",
): Promise<unknown> {
  return await withReleases(async (releases) => {
    const name = `opfs-idb-open-${crypto.randomUUID()}`;
    releases.push(() => remove(name));
    const primary = kind === "undefined" ? undefined : kind === "null" ? null : new Error("open primary");
    if (lane.startsWith("setup-")) {
      const seed = await open(name);
      seed.close();
    }
    const factoryOpen = indexedDB.open;
    const add = EventTarget.prototype.addEventListener;
    const nativeRemove = EventTarget.prototype.removeEventListener;
    const restores: Array<() => void> = [];
    releases.push(() => {
      for (const restore of restores.toReversed()) restore();
    });
    let closes = 0;
    let abortCalls = 0;
    let nativeFailure: { reason: unknown } | undefined;
    let opened: IDBOpenDBRequest | undefined;
    let priorCalls = 0;
    const released = Promise.withResolvers<void>();
    const prior = () => {
      priorCalls++;
      if (lane === "setup-prior") throw primary;
      if (lane === "setup-async") return Promise.reject(primary);
      if (lane === "setup-release-work") return released.promise;
      if (lane === "setup-then-getter") {
        return {
          get then() {
            throw primary;
          },
        };
      }
      if (lane === "setup-then-after") {
        return {
          then(resolve: () => void) {
            resolve();
            throw primary;
          },
        };
      }
      if (lane === "setup-then-reject-throw") {
        return {
          then(_resolve: () => void, reject: (reason: unknown) => void) {
            reject(primary);
            throw primary;
          },
        };
      }
    };
    let observedTerminal: Promise<void> | undefined;
    const restoreOpen = patch(indexedDB, "open", {
      value: (...args: Parameters<IDBFactory["open"]>) => {
        const request = Reflect.apply(factoryOpen, indexedDB, args) as IDBOpenDBRequest;
        opened = request;
        const acquire = () => {
          const database = request.result;
          const close = database.close;
          restores.push(patch(database, "close", {
            value: () => {
              closes++;
              close.call(database);
              released.resolve();
              if (lane === "close") throw primary;
            },
          }));
          if (lane.startsWith("upgrade")) {
            const transaction = request.transaction!;
            const abort = transaction.abort;
            restores.push(patch(transaction, "abort", {
              value: () => {
                abortCalls++;
                if (lane === "upgrade-abort-before") throw primary;
                abort.call(transaction);
                if (lane === "upgrade-abort-after") throw primary;
              },
            }));
            const create = database.createObjectStore;
            restores.push(patch(database, "createObjectStore", {
              value: (
                ...values: Parameters<IDBDatabase["createObjectStore"]>
              ) => {
                Reflect.apply(create, database, values);
                throw primary;
              },
            }));
          }
        };
        if (lane.startsWith("setup-")) {
          observedTerminal = new Promise<void>((resolve) => {
            add.call(request, "success", () => {
              acquire();
              resolve();
            }, { once: true });
            add.call(request, "error", () => resolve(), { once: true });
          });
          request.onsuccess = prior;
          if (lane === "setup-state-getter" || lane === "setup-state-detach") {
            restores.push(patch(request, "readyState", {
              get: () => {
                throw primary;
              },
            }));
          }
          const ownAdd = request.addEventListener;
          restores.push(patch(request, "addEventListener", {
            value: (
              type: string,
              callback: EventListenerOrEventListenerObject | null,
              options?: boolean | AddEventListenerOptions,
            ) => {
              if (type === "success" && lane !== "setup-after" && !lane.startsWith("setup-state-")) throw primary;
              if (callback !== null) ownAdd.call(request, type, callback, options);
              if (type === "success" && lane === "setup-after") throw primary;
            },
          }));
          if (lane === "setup-both-after") {
            const getter = Object.getOwnPropertyDescriptor(IDBRequest.prototype, "onsuccess")!;
            restores.push(patch(request, "onsuccess", {
              get: () => getter.get!.call(request),
              set: (value: unknown) => {
                getter.set!.call(request, value);
                throw primary;
              },
            }));
          }
        } else {
          // Native upgrade acquisition precedes candidate schema effects.
          add.call(request, "upgradeneeded", acquire, { once: true });
        }
        add.call(request, "error", () => {
          nativeFailure = { reason: request.error };
        }, { once: true });
        restores.push(patch(request, "removeEventListener", {
          value: (
            type: string,
            callback: EventListenerOrEventListenerObject | null,
            options?: boolean | EventListenerOptions,
          ) => {
            if (callback !== null) nativeRemove.call(request, type, callback, options);
            if (type === "success" && (lane === "detach" || lane === "close" || lane === "setup-state-detach")) {
              throw primary;
            }
          },
        }));
        return request;
      },
    });
    restores.push(restoreOpen);
    let failure: { reason: unknown } | undefined;
    try {
      const options: IndexedDbOpenOptionsType = { name };
      if (lane === "create") {
        Object.defineProperty(options, "readOnly", {
          get: () => {
            throw primary;
          },
        });
      }
      await openIndexedDbDriver(options);
    } catch (reason) {
      failure = { reason };
    }
    await observedTerminal;
    // A Promise resolved by the first native listener can resume between native
    // listeners. Keep fixture instrumentation until the whole event dispatched.
    await checkpoint();
    const handlerRestored = opened?.onsuccess === (lane.startsWith("setup-") ? prior : null);
    for (const restore of restores.splice(0).toReversed()) restore();
    // Upgrade failure rolls the schema version back; other failures retain the
    // committed schema but must release the unpublished connection for deletion.
    let oldVersion: number | undefined;
    const request = factoryOpen.call(indexedDB, name, 1);
    request.onupgradeneeded = (event) => {
      oldVersion = event.oldVersion;
    };
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return {
      faults: reasons(failure).map((reason) =>
        reason === primary ? "primary" : nativeFailure && reason === nativeFailure.reason ? "native" : "unexpected"
      ),
      closes,
      abortCalls,
      schemaRolledBack: oldVersion === 0,
      priorCalls,
      handlerRestored,
    };
  });
}

/** Fallback preserves a real request handler's false return and its native cancellation effect. */
export async function canceled(kind: "undefined" | "null" | "error"): Promise<unknown> {
  return await withReleases(async (releases) => {
    const name = `opfs-idb-false-${crypto.randomUUID()}`;
    releases.push(() => remove(name));
    const database = await open(name);
    releases.push(() => database.close());
    await stored(database, record());
    const primary = kind === "undefined" ? undefined : kind === "null" ? null : new Error("request setup");
    const transaction = database.transaction("entries", "readwrite");
    const done = committed(transaction);
    // Observe rejection now, before issuing further native requests.
    void done.catch(() => undefined);
    const request = transaction.objectStore("entries").add(record());
    let callerCalls = 0;
    const caller = () => {
      callerCalls++;
      return false;
    };
    request.onerror = caller;
    let nativeReason: unknown;
    const nativeAdd = EventTarget.prototype.addEventListener;
    nativeAdd.call(request, "error", () => {
      nativeReason = request.error;
    }, { once: true });
    const restore = patch(request, "addEventListener", {
      value: (
        type: string,
        callback: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions,
      ) => {
        if (type === "error") throw primary;
        if (callback !== null) nativeAdd.call(request, type, callback, options);
      },
    });
    releases.push(restore);
    const failed = result(request).then(() => undefined, (reason) => ({ reason }));
    const replacement = result(transaction.objectStore("entries").put(record("Yg==")));
    const [failure] = await Promise.all([failed, replacement, done]);
    const restored = request.onerror === caller;
    restore();
    return {
      faults: reasons(failure).map((reason) =>
        reason === primary ? "primary" : reason === nativeReason ? "native" : "unexpected"
      ),
      callerCalls,
      restored,
      persisted: await stored(database),
    };
  });
}

/** Actual completed native requests are acquired after both request and transaction events. */
export async function completed(
  lane:
    | "success"
    | "error"
    | "state-getter"
    | "error-getter"
    | "result-getter"
    | "shadow-error"
    | "detach"
    | "error-detach",
  kind: "undefined" | "null" | "error",
): Promise<{
  state: IDBRequestReadyState;
  reads: readonly number[];
  removed: readonly string[];
  faults: readonly string[];
  value: unknown;
  persisted: unknown;
}> {
  return await withReleases(async (releases) => {
    const name = `opfs-idb-completed-${crypto.randomUUID()}`;
    releases.push(() => remove(name));
    const database = await open(name);
    releases.push(() => database.close());
    await stored(database, record());
    const nativeError = lane === "error" || lane === "error-detach";
    const transaction = database.transaction("entries", nativeError ? "readwrite" : "readonly");
    const store = transaction.objectStore("entries");
    const request = nativeError ? store.add(record()) : store.get("/a");
    const terminal = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
    // A duplicate-key error is genuinely completed; preventing its default abort
    // allows the independently observed transaction to finish normally.
    request.onerror = (event) => event.preventDefault();
    await terminal;
    const state = request.readyState;
    const originalError = request.error;
    const originalValue = originalError === null ? request.result : undefined;
    const primary = kind === "undefined" ? undefined : kind === "null" ? null : new Error("borrowed field refusal");
    const reads = [0, 0, 0];
    const restores: Array<() => void> = [];
    releases.push(() => {
      for (const restore of restores.toReversed()) restore();
    });
    restores.push(patch(request, "readyState", {
      get: () => {
        reads[0]!++;
        if (lane === "state-getter") throw primary;
        return state;
      },
    }));
    restores.push(patch(request, "error", {
      get: () => {
        reads[1]!++;
        if (lane === "error-getter") throw primary;
        return lane === "shadow-error" ? primary : originalError;
      },
    }));
    restores.push(patch(request, "result", {
      get: () => {
        reads[2]!++;
        if (lane === "result-getter") throw primary;
        return originalValue;
      },
    }));
    const removed: string[] = [];
    const nativeRemove = request.removeEventListener;
    restores.push(patch(request, "removeEventListener", {
      value: (
        type: string,
        callback: EventListenerOrEventListenerObject | null,
        options?: boolean | EventListenerOptions,
      ) => {
        removed.push(type);
        if (callback !== null) nativeRemove.call(request, type, callback, options);
        if (type === "success" && (lane === "detach" || lane === "error-detach")) throw primary;
      },
    }));
    let failure: { reason: unknown } | undefined;
    let value: unknown;
    try {
      value = await result(request);
    } catch (reason) {
      failure = { reason };
    }
    for (const restore of restores.splice(0).toReversed()) restore();
    return {
      state,
      reads,
      removed,
      faults: reasons(failure).map((reason) =>
        reason === originalError && originalError !== null ? "native" : reason === primary ? "primary" : "unexpected"
      ),
      value,
      persisted: await stored(database),
    };
  });
}

/** Native task dispatch follows the current event's Promise reactions without a timing threshold. */
function checkpoint(): Promise<void> {
  const channel = new MessageChannel();
  return new Promise((resolve) => {
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

/** A real fallback handler chooses nested settlement before subsequent resolve/reject attempts. */
export async function nested(
  lane: "fulfill" | "reject" | "throw" | "reject-throw",
  kind: "undefined" | "null" | "error",
): Promise<unknown> {
  return await withReleases(async (releases) => {
    const name = `opfs-idb-nested-${crypto.randomUUID()}`;
    releases.push(() => remove(name));
    const seed = await open(name);
    seed.close();
    const primary = kind === "undefined" ? undefined : kind === "null" ? null : new Error("nested handler settlement");
    const held = Promise.withResolvers<void>();
    releases.push(() => held.resolve());
    const nativeThen = held.promise.then;
    // This independent native observer does not pass through the candidate's
    // declared then getter and prevents an abandoned fixture rejection escaping.
    void nativeThen.call(held.promise, () => undefined, () => undefined);
    let adopted = 0;
    releases.push(patch(held.promise, "then", {
      value: (
        ...args: Parameters<Promise<void>["then"]>
      ): Promise<unknown> => {
        adopted++;
        return Reflect.apply(nativeThen, held.promise, args) as Promise<unknown>;
      },
    }));
    const closed = Promise.withResolvers<void>();
    const detached = Promise.withResolvers<void>();
    let closes = 0;
    const removed: string[] = [];
    const factoryOpen = indexedDB.open;
    const nativeAdd = EventTarget.prototype.addEventListener;
    const nativeRemove = EventTarget.prototype.removeEventListener;
    const prior = () => ({
      then(resolve: (value?: unknown) => void, reject: (reason: unknown) => void) {
        resolve(held.promise);
        // The first requested settlement keeps its adopted value. These later
        // requests are not additional failures, unlike the actual invocation throw.
        reject(new Error("ignored settlement"));
        resolve("ignored settlement");
        if (lane === "throw" || lane === "reject-throw") throw primary;
      },
    });
    let request: IDBOpenDBRequest | undefined;
    releases.push(patch(indexedDB, "open", {
      value: (...args: Parameters<IDBFactory["open"]>) => {
        const opened = Reflect.apply(factoryOpen, indexedDB, args) as IDBOpenDBRequest;
        request = opened;
        nativeAdd.call(opened, "success", () => {
          const database = opened.result;
          const close = database.close;
          releases.push(patch(database, "close", {
            value: () => {
              closes++;
              close.call(database);
              closed.resolve();
            },
          }));
        }, { once: true });
        opened.onsuccess = prior;
        releases.push(patch(opened, "addEventListener", {
          value: (
            type: string,
            callback: EventListenerOrEventListenerObject | null,
            options?: boolean | AddEventListenerOptions,
          ) => {
            if (type === "success") throw primary;
            if (callback !== null) nativeAdd.call(opened, type, callback, options);
          },
        }));
        releases.push(patch(opened, "removeEventListener", {
          value: (
            type: string,
            callback: EventListenerOrEventListenerObject | null,
            options?: boolean | EventListenerOptions,
          ) => {
            removed.push(type);
            if (callback !== null) nativeRemove.call(opened, type, callback, options);
            if (type === "upgradeneeded") detached.resolve();
          },
        }));
        return opened;
      },
    }));
    let settled = false;
    let failure: { reason: unknown } | undefined;
    const outcome = openIndexedDbDriver({ name }).then(() => {
      settled = true;
    }, (reason) => {
      failure = { reason };
      settled = true;
    });
    await Promise.all([closed.promise, detached.promise]);
    await checkpoint();
    const before = { settled, adopted, closes, removed: [...removed], restored: request?.onsuccess === prior };
    if (lane === "reject" || lane === "reject-throw") held.reject(primary);
    else held.resolve();
    await outcome;
    return {
      before,
      settled,
      faults: reasons(failure).map((reason) => reason === primary ? "primary" : "unexpected"),
    };
  });
}
