import type { PathType } from "../path.ts";
import type { RecordType } from "../schema.ts";
import { defineRecordDriver, type RecordBackendType, type RecordDriverType } from "./record.ts";

/** In-memory record driver with test-friendly inspection helpers. */
export interface MemoryDriverType extends RecordDriverType {
  /** Removes every stored record. */
  clear(): void;
  /** Number of stored files and directories, excluding the implicit root. */
  readonly size: number;
}

/** Deterministic process-local record backend. */
class MemoryBackend implements RecordBackendType {
  readonly capabilities = {
    replacement: "atomic",
    binary: false,
    transactions: false,
  } as const;
  readonly #records = new Map<string, RecordType>();

  get size(): number {
    return this.#records.size;
  }

  clear(): void {
    this.#records.clear();
  }

  async get(path: PathType): Promise<RecordType | null> {
    const record = this.#records.get(path);
    return record === undefined ? null : structuredClone(record);
  }

  async set(record: RecordType): Promise<void> {
    this.#records.set(record.path, structuredClone(record));
  }

  async delete(path: PathType): Promise<void> {
    this.#records.delete(path);
  }

  async *list(parent: PathType): AsyncIterableIterator<RecordType> {
    for (const record of this.#records.values()) {
      if (record.parent === parent) yield structuredClone(record);
    }
  }
}

/** Creates a deterministic in-memory record driver. */
export function createMemoryDriver(): MemoryDriverType {
  const backend = new MemoryBackend();
  return {
    ...defineRecordDriver(backend, {
      name: "memory",
      ownership: "owned",
      requirements: [],
      limits: [],
      optimizations: [],
      capabilities: { replacement: "atomic" },
    }),
    get size() {
      return backend.size;
    },
    clear: () => backend.clear(),
  };
}
