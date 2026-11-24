import { describe, it } from "node:test";
import { expect } from "@std/expect";

import { createFileSystem, FileSystemError } from "../mod.ts";
import { createExtensionAdapter, getStorageArea, watchStorageArea } from "../src/backend/extension/adapter.ts";
import type { StorageAreaEventType } from "../src/backend/extension/watch.ts";
import type { StorageAreaType, StorageChangeListenerType, StorageChangeType } from "../src/backend/extension/area.ts";

/** Quota constants that a fake area reports, matching one real browser area. */
interface QuotaType {
  readonly QUOTA_BYTES?: number;
  readonly QUOTA_BYTES_PER_ITEM?: number;
  readonly MAX_ITEMS?: number;
  readonly MAX_WRITE_OPERATIONS_PER_MINUTE?: number;
  readonly MAX_WRITE_OPERATIONS_PER_HOUR?: number;
}

/**
 * In-memory WebExtensions `StorageArea`.
 *
 * Values are copied through JSON, as the browser does, so a test fails if the
 * driver stores something the browser would change. Per-item quota is enforced
 * with Chrome's error message. `keys: false` removes `getKeys()` to model
 * browsers older than Chrome 130, Firefox 143 and Safari 18.4.
 */
class FakeArea implements StorageAreaType {
  readonly values = new Map<string, string>();
  readonly listeners = new Set<StorageChangeListenerType>();
  writes = 0;
  readonly getKeys?: () => Promise<string[]>;
  readonly onChanged = {
    addListener: (listener: StorageChangeListenerType) => void this.listeners.add(listener),
    removeListener: (listener: StorageChangeListenerType) => void this.listeners.delete(listener),
  };
  readonly QUOTA_BYTES?: number;
  readonly QUOTA_BYTES_PER_ITEM?: number;
  readonly MAX_ITEMS?: number;
  readonly MAX_WRITE_OPERATIONS_PER_MINUTE?: number;
  readonly MAX_WRITE_OPERATIONS_PER_HOUR?: number;

  constructor(quota: QuotaType = {}, keys = true) {
    Object.assign(this, quota);
    if (keys) this.getKeys = async () => [...this.values.keys()];
  }

  async get(keys?: string | readonly string[] | null): Promise<Record<string, unknown>> {
    const list = keys === null || keys === undefined
      ? [...this.values.keys()]
      : typeof keys === "string"
      ? [keys]
      : keys;
    const result: Record<string, unknown> = {};
    for (const key of list) {
      const value = this.values.get(key);
      if (value !== undefined) result[key] = JSON.parse(value);
    }
    return result;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    const changes: Record<string, StorageChangeType> = {};
    for (const [key, value] of Object.entries(items)) {
      const json = JSON.stringify(value);
      if (this.QUOTA_BYTES_PER_ITEM !== undefined && key.length + json.length > this.QUOTA_BYTES_PER_ITEM) {
        throw new Error("QUOTA_BYTES_PER_ITEM quota exceeded");
      }
      const old = this.values.get(key);
      this.values.set(key, json);
      changes[key] = old === undefined
        ? { newValue: JSON.parse(json) }
        : { oldValue: JSON.parse(old), newValue: JSON.parse(json) };
    }
    this.writes++;
    for (const listener of this.listeners) listener(changes);
  }

  async remove(keys: string | readonly string[]): Promise<void> {
    const changes: Record<string, StorageChangeType> = {};
    for (const key of typeof keys === "string" ? [keys] : keys) {
      const old = this.values.get(key);
      if (old === undefined) continue;
      this.values.delete(key);
      changes[key] = { oldValue: JSON.parse(old) };
    }
    for (const listener of this.listeners) listener(changes);
  }

  async getBytesInUse(): Promise<number> {
    let bytes = 0;
    for (const [key, value] of this.values) bytes += key.length + value.length;
    return bytes;
  }
}

/** Chrome's `storage.sync` constants. */
const SYNC: QuotaType = {
  QUOTA_BYTES: 102400,
  QUOTA_BYTES_PER_ITEM: 8192,
  MAX_ITEMS: 512,
  MAX_WRITE_OPERATIONS_PER_MINUTE: 120,
  MAX_WRITE_OPERATIONS_PER_HOUR: 1800,
};

describe("extension storage", () => {
  for (const keys of [true, false]) {
    it(`writes, lists and removes files ${keys ? "with" : "without"} getKeys()`, async () => {
      const area = new FakeArea({ QUOTA_BYTES: 10485760 }, keys);
      area.values.set("app:setting", JSON.stringify("keep"));
      const fs = createFileSystem(createExtensionAdapter(area, { area: "local" }));
      try {
        await fs.mkdir("/notes");
        await fs.writeFile("/notes/today.md", "# Today");
        await fs.writeFile("/notes/later.md", "# Later");
        expect(await fs.readText("/notes/today.md")).toBe("# Today");
        const names = [];
        for await (const entry of await fs.getDirectoryHandle("/notes").then((dir) => dir.keys())) names.push(entry);
        expect(names.sort()).toEqual(["later.md", "today.md"]);
        await fs.remove("/notes", { recursive: true });
        expect([...area.values.keys()]).toEqual(["app:setting"]);
      } finally {
        await fs.close();
      }
    });
  }

  it("stores JSON values under URL-encoded keys", async () => {
    const area = new FakeArea();
    const fs = createFileSystem(createExtensionAdapter(area, { area: "session", prefix: "tmp:" }));
    try {
      await fs.writeFile("/a b.txt", "hi");
      const value = JSON.parse(area.values.get("tmp:%2Fa%20b.txt")!);
      expect(value).toMatchObject({ kind: "file", path: "/a b.txt", data: btoa("hi"), size: 2 });
    } finally {
      await fs.close();
    }
  });

  it("reports the area's quota constants as limits", async () => {
    const fs = createFileSystem(createExtensionAdapter(new FakeArea(SYNC), { area: "sync" }));
    try {
      const limits = Object.fromEntries(fs.adapter.driver.limits.map((limit) => [limit.code, limit.value]));
      expect(limits).toMatchObject({
        "quota-bytes": 102400,
        "item-bytes": 8192,
        "file-bytes": 6144,
        "item-count": 512,
        "writes-per-minute": 120,
        "writes-per-hour": 1800,
      });
    } finally {
      await fs.close();
    }
  });

  it("drops the local byte quota with unlimitedStorage", async () => {
    const fs = createFileSystem(
      createExtensionAdapter(new FakeArea({ QUOTA_BYTES: 10485760 }), { area: "local", unlimitedStorage: true }),
    );
    try {
      expect(fs.adapter.driver.limits.some((limit) => limit.code === "quota-bytes")).toBe(false);
    } finally {
      await fs.close();
    }
  });

  it("refuses an item over QUOTA_BYTES_PER_ITEM before calling the browser", async () => {
    const area = new FakeArea(SYNC);
    const fs = createFileSystem(createExtensionAdapter(area, { area: "sync" }));
    try {
      await fs.writeFile("/small", "x".repeat(1000));
      const before = area.writes;
      const error = await fs.writeFile("/big", "x".repeat(6100)).catch((reason) => reason);
      expect(error).toBeInstanceOf(FileSystemError);
      expect(error.code).toBe("quota-exceeded");
      expect(area.writes).toBe(before);
      expect(await fs.exists("/big")).toBe(false);
    } finally {
      await fs.close();
    }
  });

  it("maps a browser quota rejection to quota-exceeded", async () => {
    const area = new FakeArea();
    area.set = async () => {
      throw new Error("QUOTA_BYTES quota exceeded");
    };
    const fs = createFileSystem(createExtensionAdapter(area, { area: "local" }));
    try {
      const error = await fs.writeFile("/file", "x").catch((reason) => reason);
      expect(error).toBeInstanceOf(FileSystemError);
      expect(error.code).toBe("quota-exceeded");
    } finally {
      await fs.close();
    }
  });

  it("keeps managed storage read only", async () => {
    const area = new FakeArea();
    area.values.set(
      "opfs:%2Fpolicy.json",
      JSON.stringify({
        version: 1,
        kind: "file",
        path: "/policy.json",
        parent: "/",
        name: "policy.json",
        lastModified: 0,
        data: btoa("{}"),
        size: 2,
        mediaType: "application/json",
      }),
    );
    const fs = createFileSystem(createExtensionAdapter(area, { area: "managed", readOnly: false }));
    try {
      expect(await fs.readText("/policy.json")).toBe("{}");
      const error = await fs.writeFile("/policy.json", "[]").catch((reason) => reason);
      expect(error).toBeInstanceOf(FileSystemError);
      // The repository reports a read-only driver as `not-supported`.
      expect(error.code).toBe("not-supported");
    } finally {
      await fs.close();
    }
  });

  it("returns the area from fs.backend", async () => {
    const area = new FakeArea();
    const fs = createFileSystem(createExtensionAdapter(area, { area: "local" }));
    try {
      const backend: StorageAreaType = fs.backend;
      expect(backend).toBe(area);
      await fs.writeFile("/file", "x");
      expect(await fs.backend.getBytesInUse!(null)).toBeGreaterThan(0);
    } finally {
      await fs.close();
    }
  });

  it("emits changes from another context and stops after unsubscribe", async () => {
    const area = new FakeArea();
    const events: StorageAreaEventType[] = [];
    const subscription = watchStorageArea(area).subscribe((event) => events.push(event));
    const fs = createFileSystem(createExtensionAdapter(area, { area: "local" }));
    try {
      await area.set({ "app:other": 1 });
      await fs.writeFile("/file", "x");
      await fs.remove("/file");
      expect(events).toEqual([
        { path: "/file", change: "write", kind: "file" },
        { path: "/file", change: "remove", kind: "file" },
      ]);
      subscription.unsubscribe();
      expect(area.listeners.size).toBe(0);
    } finally {
      await fs.close();
    }
  });

  it("refuses to watch an area without onChanged", () => {
    const area = new FakeArea();
    Object.defineProperty(area, "onChanged", { value: undefined });
    expect(() => watchStorageArea(area)).toThrow(FileSystemError);
  });

  it("reads browser globals only when called", () => {
    const scope = globalThis as { chrome?: unknown };
    const area = new FakeArea();
    expect(getStorageArea("local")).toBeUndefined();
    scope.chrome = { storage: { local: area } };
    try {
      expect(getStorageArea("local")).toBe(area);
      expect(getStorageArea("managed")).toBeUndefined();
    } finally {
      delete scope.chrome;
    }
  });
});
