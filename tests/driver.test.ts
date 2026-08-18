import { describe, it } from "node:test";
import { expect } from "@std/expect";

import { defineDriver } from "../src/driver/definition.ts";
import { defineRecordDriver, type RecordBackendType } from "../src/driver/record.ts";
import type { PathType } from "../src/schema.ts";
import type { RecordType } from "../src/schema.ts";

/** Minimal deterministic record backend used to prove the public driver extension seam. */
class TestRecordBackend implements RecordBackendType {
  /** In-memory records keyed by canonical virtual path. */
  readonly #records = new Map<PathType, RecordType>();
  disposed = false;

  /** Returns one exact record. */
  async get(path: PathType): Promise<RecordType | null> {
    return this.#records.get(path) ?? null;
  }

  /** Replaces one exact record. */
  async set(record: RecordType): Promise<void> {
    this.#records.set(record.path, record);
  }

  /** Removes one exact record. */
  async delete(path: PathType): Promise<void> {
    this.#records.delete(path);
  }

  /** Iterates only records whose stored parent matches the requested directory. */
  async *list(parent: PathType): AsyncIterableIterator<RecordType> {
    for (const record of this.#records.values()) {
      if (record.parent === parent) yield record;
    }
  }

  /** Marks disposal so ownership tests can distinguish borrowed and owned backends. */
  dispose(): void {
    this.disposed = true;
  }
}

describe("driver contract", () => {
  it("keeps requirements, limits, and optimizations as structured inspectable data", () => {
    const driver = defineDriver({
      name: "fixture",
      kind: "record",
      provides: ["get", "set", "list"],
      ownership: "borrowed",
      requirements: [{ code: "database", state: "available" }],
      limits: [
        { code: "value-bytes", kind: "hard", source: "provider", unit: "bytes", value: 64 * 1024 },
        {
          code: "quota-bytes",
          kind: "dynamic",
          source: "probe",
          unit: "bytes",
          detail: "Probe storage quota before admission.",
        },
      ],
      optimizations: [
        { code: "partition", enabled: true, changesBehavior: true, disableable: true },
      ],
    });

    expect(driver.inspect()).toMatchObject({
      name: "fixture",
      kind: "record",
      provides: ["get", "set", "list"],
      ownership: "borrowed",
      requirements: [{ code: "database", state: "available" }],
      limits: [
        { code: "value-bytes", kind: "hard", source: "provider" },
        { code: "quota-bytes", kind: "dynamic", source: "probe" },
      ],
      optimizations: [{ code: "partition", enabled: true, changesBehavior: true, disableable: true }],
    });
  });

  it("rejects a behavior-changing optimization that cannot be disabled", () => {
    expect(() =>
      defineDriver({
        name: "unsafe",
        kind: "object",
        optimizations: [{ code: "cache", enabled: true, changesBehavior: true, disableable: false }],
      })
    ).toThrow(TypeError);
  });

  it("lets a third-party record driver preflight logical size before an adapter exists", () => {
    const driver = defineRecordDriver(new TestRecordBackend(), {
      name: "records",
      limits: [{ code: "file-bytes", kind: "policy", source: "user", unit: "bytes", value: 8 }],
    });

    expect(driver.plan({ operation: "write", path: "/small.bin", size: 8, source: "bytes", mode: "replace" }))
      .toMatchObject({
        supported: true,
        support: "native",
      });
    expect(driver.plan({ operation: "write", path: "/large.bin", size: 9, source: "bytes", mode: "replace" }))
      .toMatchObject({
        supported: false,
        support: "unsupported",
        problems: [{ code: "file-too-large", layer: "driver", severity: "error" }],
        actions: [{ kind: "reduce-input" }, { kind: "select-driver" }],
      });
  });

  it("enforces read-only policy at the driver seam before an adapter exists", () => {
    const backend = new TestRecordBackend();
    const driver = defineRecordDriver(backend, {
      name: "read-only",
      readOnly: true,
    });
    const record: RecordType = {
      version: 1,
      path: "/value" as PathType,
      parent: "/" as PathType,
      name: "value",
      kind: "directory",
      lastModified: 0,
    };

    expect(driver.capabilities.write).toBe(false);
    expect(driver.provides.includes("set")).toBe(false);
    expect(driver.provides.includes("delete")).toBe(false);
    expect(driver.plan({ operation: "write", path: "/value", size: 0, source: "bytes", mode: "replace" }))
      .toMatchObject({
        supported: false,
        problems: [{ code: "read-only", layer: "driver", severity: "error" }],
      });
    expect(() => driver.set(record)).toThrow();
  });

  it("disposes a borrowed backend only when ownership is transferred", async () => {
    const borrowed = new TestRecordBackend();
    const borrowedDriver = defineRecordDriver(borrowed, { name: "borrowed" });
    expect(borrowedDriver.dispose).toBeUndefined();
    expect(borrowed.disposed).toBe(false);

    const owned = new TestRecordBackend();
    const ownedDriver = defineRecordDriver(owned, { name: "owned", disposeBackend: true });
    await ownedDriver.dispose?.();
    expect(owned.disposed).toBe(true);
  });
});
