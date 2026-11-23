import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { DatabaseSync } from "node:sqlite";
import { encodeBase64 } from "@std/encoding/base64";
import { createD1Driver, D1_FILE_BYTES, D1Error, D1MutationError } from "../src/driver/d1.ts";
import type { D1BindingType, D1ParameterType, D1StatementType } from "../src/driver/d1.ts";
import { createD1Adapter } from "../src/adapter/d1.ts";
import { createFileSystem } from "../mod.ts";
import { withReleases } from "./close.ts";
import { normalizePath, ROOT_PATH } from "../src/path.ts";
import type { RecordType } from "../src/schema.ts";

/** Independent native SQLite engine; D1 result envelopes are authored and do not prove deployed D1 behavior. */
function fixture() {
  const db = new DatabaseSync(":memory:");
  const calls: { sql: string; values: readonly D1ParameterType[] }[] = [];
  const hooks = { failure: "", afterMutation: false, rows: undefined as readonly unknown[] | undefined };
  const binding: D1BindingType = {
    prepare(sql) {
      const statement = db.prepare(sql);
      function bound(values: D1ParameterType[]): D1StatementType {
        return {
          bind: (...parameters) => bound([...parameters]),
          async all() {
            calls.push({ sql, values });
            if (hooks.failure && sql.startsWith(hooks.failure)) {
              return { success: false, error: "authored D1 read rejection" };
            }
            return { success: true, results: hooks.rows ?? statement.all(...values) };
          },
          async run() {
            calls.push({ sql, values });
            if (hooks.failure && sql.startsWith(hooks.failure)) {
              return { success: false, error: "authored D1 mutation rejection" };
            }
            statement.run(...values);
            if (hooks.afterMutation) throw new Error("lost acknowledgement after actual SQLite commit");
            return { success: true, results: [] };
          },
        };
      }
      return bound([]);
    },
  };
  return { db, binding, calls, hooks };
}
function file(name = "a", data = "AQID"): Extract<RecordType, { kind: "file" }> {
  return {
    version: 1,
    path: normalizePath(`/${name}`),
    parent: ROOT_PATH,
    name,
    kind: "file",
    data,
    size: data.length / 4 * 3,
    mediaType: "application/octet-stream",
    lastModified: 1,
  };
}
describe("D1 version-one record layout on native SQLite", () => {
  it("writes, reads and removes files through the full adapter path without owning the database", async () =>
    await withReleases(async (releases) => {
      const f = fixture();
      releases.push(() => f.db.close());
      const fs = createFileSystem(await createD1Adapter(f.binding), { coordination: "local" });
      releases.push(() => fs.close());
      await fs.writeFile("/dir/a.bin", new Uint8Array([1, 2, 3]), { parents: true });
      expect(await fs.readFile("/dir/a.bin")).toEqual(new Uint8Array([1, 2, 3]));
      await fs.remove("/dir/a.bin");
      await expect(fs.readFile("/dir/a.bin")).rejects.toMatchObject({ code: "not-found" });
      await fs.close();
      expect(f.db.prepare("SELECT count(*) AS n FROM opfs_d1_v1").get()?.n).toBeGreaterThan(0);
    }));
  it("uses indexed metadata-only keyset pages, including non-BMP names in SQLite BINARY order", async () =>
    await withReleases(async (releases) => {
      const f = fixture();
      releases.push(() => f.db.close());
      const driver = await createD1Driver(f.binding, { pageSize: 1 });
      await driver.set({
        version: 1,
        path: ROOT_PATH,
        parent: ROOT_PATH,
        name: "",
        kind: "directory",
        lastModified: 1,
      });
      for (const name of ["😀", "\ue000", "a"]) await driver.set(file(name));
      const before = f.calls.length;
      const names = [];
      for await (const record of driver.list(ROOT_PATH)) names.push(record.name);
      expect(names).toEqual(["a", "\ue000", "😀"]);
      const pages = f.calls.slice(before);
      expect(pages.length).toBe(4);
      for (const page of pages) {
        expect(page.sql).not.toMatch(/\bdata\b/);
        expect(page.sql).toContain("LIMIT ?");
        expect(page.values.length).toBe(3);
      }
      const plan = f.db.prepare(
        "EXPLAIN QUERY PLAN SELECT path FROM opfs_d1_v1 WHERE parent_path=? AND path>? COLLATE BINARY ORDER BY path COLLATE BINARY LIMIT ?",
      ).all("/", "", 1);
      expect(String(plan[0]?.detail)).toContain("opfs_d1_v1_parent_path");
    }));
  it("does not acquire another page after early iteration return", async () =>
    await withReleases(async (releases) => {
      const f = fixture();
      releases.push(() => f.db.close());
      const driver = await createD1Driver(f.binding, { pageSize: 1 });
      await driver.set(file("a"));
      await driver.set(file("b"));
      const before = f.calls.length;
      for await (const _record of driver.list(ROOT_PATH)) break;
      expect(f.calls.length - before).toBe(1);
    }));
  it("throws instead of silently truncating directory budgets and admits an exactly full directory", async () =>
    await withReleases(async (releases) => {
      const f = fixture();
      releases.push(() => f.db.close());
      const driver = await createD1Driver(f.binding, { pageSize: 2, maxListEntries: 1 });
      await driver.set(file("a"));
      const list = async () => {
        const result = [];
        for await (const item of driver.list(ROOT_PATH)) result.push(item);
        return result;
      };
      expect((await list()).length).toBe(1);
      await driver.set(file("b"));
      await expect(list()).rejects.toThrow(RangeError);
    }));
  it("checks success=false for initialization, reads, replacements and deletion", async () =>
    await withReleases(async (releases) => {
      const f = fixture();
      releases.push(() => f.db.close());
      f.hooks.failure = "CREATE";
      await expect(createD1Driver(f.binding)).rejects.toBeInstanceOf(D1Error);
      f.hooks.failure = "";
      const driver = await createD1Driver(f.binding);
      f.hooks.failure = "SELECT";
      await expect(driver.get(normalizePath("/a"))).rejects.toBeInstanceOf(D1Error);
      f.hooks.failure = "INSERT";
      await expect(driver.set(file())).rejects.toBeInstanceOf(D1MutationError);
      f.hooks.failure = "DELETE";
      await expect(driver.delete(normalizePath("/a"))).rejects.toBeInstanceOf(D1MutationError);
    }));
  it("retains uncertainty when a native mutation committed before acknowledgement loss", async () =>
    await withReleases(async (releases) => {
      const f = fixture();
      releases.push(() => f.db.close());
      const driver = await createD1Driver(f.binding);
      f.hooks.afterMutation = true;
      await expect(driver.set(file())).rejects.toMatchObject({ outcome: "unknown" });
      f.hooks.afterMutation = false;
      expect(await driver.get(normalizePath("/a"))).toEqual(file());
      expect(f.calls.filter((call) => call.sql.startsWith("INSERT")).length).toBe(1);
    }));
  it("rejects malformed persisted identities, base64 and unsafe numeric metadata", async () =>
    await withReleases(async (releases) => {
      const f = fixture();
      releases.push(() => f.db.close());
      const driver = await createD1Driver(f.binding);
      await driver.set(file());
      for (
        const sql of [
          "UPDATE opfs_d1_v1 SET data='!!!!'",
          "UPDATE opfs_d1_v1 SET last_modified=9007199254740992",
          "UPDATE opfs_d1_v1 SET name='other'",
        ]
      ) {
        await driver.set(file());
        f.db.exec(sql);
        await expect(driver.get(normalizePath("/a"))).rejects.toThrow();
      }
    }));
  it("bounds parameter text, encoded payloads and lower file policy before binding execution", async () =>
    await withReleases(async (releases) => {
      const f = fixture();
      releases.push(() => f.db.close());
      const driver = await createD1Driver(f.binding, { maxFileBytes: 2 });
      const before = f.calls.length;
      expect(driver.plan({ operation: "write", size: 3 }).supported).toBe(false);
      expect(() => driver.set(file())).toThrow();
      await expect(driver.get(normalizePath(`/${"a".repeat(4097)}`))).rejects.toThrow();
      expect(f.calls.length).toBe(before);
      expect(driver.limits).toContainEqual({
        code: "file-bytes",
        kind: "hard",
        source: "implementation",
        unit: "bytes",
        value: D1_FILE_BYTES,
      });
    }));
  it("admits the exact decoded/base64 profile boundary and rejects one more byte before execution", async () =>
    await withReleases(async (releases) => {
      const f = fixture();
      releases.push(() => f.db.close());
      const driver = await createD1Driver(f.binding);
      const bytes = new Uint8Array(D1_FILE_BYTES);
      bytes[0] = 255;
      const admitted = { ...file(), data: encodeBase64(bytes), size: bytes.byteLength };
      await driver.set(admitted);
      expect(f.db.prepare("SELECT length(data) AS encoded, size FROM opfs_d1_v1 WHERE path='/a'").get()).toMatchObject({
        encoded: 1_398_104,
        size: D1_FILE_BYTES,
      });
      expect(await driver.get(normalizePath("/a"))).toEqual(admitted);
      const before = f.calls.length;
      expect(() =>
        driver.set({ ...admitted, data: encodeBase64(new Uint8Array(D1_FILE_BYTES + 1)), size: D1_FILE_BYTES + 1 })
      ).toThrow();
      expect(f.calls.length).toBe(before);
    }));
  it("checks returned page cardinality and prevents foreign-parent or nonadvancing cursor receipts", async () =>
    await withReleases(async (releases) => {
      const f = fixture();
      releases.push(() => f.db.close());
      const driver = await createD1Driver(f.binding, { pageSize: 1 });
      await driver.set(file());
      const row = f.db.prepare(
        "SELECT version,path,parent_path,name,kind,size,last_modified,media_type FROM opfs_d1_v1",
      ).get();
      const list = async () => {
        for await (const _entry of driver.list(ROOT_PATH)) { /* Consume admitted metadata. */ }
      };
      f.hooks.rows = [row, row];
      await expect(list()).rejects.toThrow();
      f.hooks.rows = [row];
      await expect(list()).rejects.toThrow();
      f.hooks.rows = [{ ...row, parent_path: "/other" }];
      await expect(list()).rejects.toThrow();
    }));
  it("requires explicit schema ownership and never interpolates arbitrary identifiers", async () =>
    await withReleases(async (releases) => {
      const f = fixture();
      releases.push(() => f.db.close());
      await expect(createD1Driver(f.binding, { table: 'entries";DROP TABLE x' })).rejects.toThrow();
      expect(f.calls).toEqual([]);
      await expect(createD1Driver(f.binding, { initialize: false })).rejects.toThrow();
    }));
});
