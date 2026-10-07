import { it } from "node:test";
import { withReleases } from "../close.ts";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createFileSystem } from "../../mod.ts";
import { createMemoryAdapter } from "../../src/adapter/memory.ts";
import { createUnstorageAdapter } from "../../src/adapter/unstorage.ts";
import { createUnstorageBridge } from "../../src/bridge/unstorage.ts";
import { createDb0Adapter } from "../../src/adapter/db0.ts";
import { createDrizzleAdapter } from "../../src/adapter/drizzle.ts";
import { createRxDbAdapter, RxDbRecordJsonSchema } from "../../src/adapter/rxdb.ts";
import { expectBytes, fixtureBytes, verifyBytes } from "../reliability.ts";

// The task installs pinned upstream libraries into a disposable consumer directory.
const upstreamRoot = process.env.OPFS_ECOSYSTEM_ROOT;
if (!upstreamRoot) {
  throw new Error("Run deno task test:ecosystems to install the pinned upstream fixture and set OPFS_ECOSYSTEM_ROOT.");
}
const upstreamRequire = createRequire(join(upstreamRoot, "package.json"));
const upstream = (specifier) => import(pathToFileURL(upstreamRequire.resolve(specifier)).href);

for (const backend of ["memory", "fs"]) {
  it(`actual unstorage ${backend} storage preserves the byte oracle and borrowed ownership`, async () =>
    await withReleases(async (releases) => {
      const { createStorage } = await upstream("unstorage");
      const { default: createDriver } = await upstream(`unstorage/drivers/${backend}`);
      const directory = await mkdtemp(join(tmpdir(), "opfs-unstorage-"));
      releases.push(() => rm(directory, { recursive: true, force: true }));
      const storage = createStorage({ driver: createDriver({ base: directory }) });
      releases.push(() => storage.dispose());
      const fileSystem = createFileSystem(createUnstorageAdapter(storage), { disposeAdapter: true });
      releases.push(() => fileSystem.close());
      await verifyBytes(fileSystem);
      await fileSystem.writeFile("/ownership.txt", "retained after facade close");
      await fileSystem.close();
      const reopened = createFileSystem(createUnstorageAdapter(storage));
      releases.push(() => reopened.close());
      try {
        assert.equal(await reopened.readText("/ownership.txt"), "retained after facade close");
      } finally {
        await reopened.close();
      }
      await storage.setItem("caller:alive", "yes");
      assert.equal(await storage.getItem("caller:alive"), "yes");
    }));
}

it("actual unstorage consumes the reverse bridge with JSON, raw bytes, prefix keys and borrowed ownership", async () =>
  await withReleases(async (releases) => {
    const { createStorage } = await upstream("unstorage");
    const fileSystem = createFileSystem(createMemoryAdapter(), { disposeAdapter: true });
    releases.push(() => fileSystem.close());
    const storage = createStorage({ driver: createUnstorageBridge(fileSystem) });
    releases.push(() => storage.dispose());
    await storage.setItem("config", { version: 1, enabled: true });
    assert.deepEqual(await storage.getItem("config"), { version: 1, enabled: true });
    await storage.setItem("config:child", "descendant");
    const bytes = fixtureBytes(65537);
    await storage.setItemRaw("binary:世界", bytes);
    expectBytes(await storage.getItemRaw("binary:世界"), bytes);
    assert.deepEqual(await storage.getKeys("config:"), ["config:child"]);
    await storage.clear("config:");
    assert.deepEqual(await storage.getItem("config"), { version: 1, enabled: true });
    // Upstream clear(base) clears mounted drivers below base; the root mount
    // is outside config:. Clearing the complete root invokes our callback.
    assert.equal(await storage.getItem("config:child"), "descendant");
    await storage.clear();
    assert.equal(await storage.getItem("config"), null);
    assert.equal(await storage.getItem("config:child"), null);
    await storage.dispose();
    await fileSystem.writeFile("/alive", "yes");
    assert.equal(await fileSystem.readText("/alive"), "yes");
  }));

it("actual unstorage reads, lists, replaces and removes persisted legacy hierarchical records", async () =>
  await withReleases(async (releases) => {
    const { createStorage } = await upstream("unstorage");
    const storage = createStorage();
    releases.push(() => storage.dispose());
    await storage.setItem("opfs:entry", {
      version: 1,
      path: "/",
      parent: "/",
      name: "",
      kind: "directory",
      lastModified: 1,
    });
    await storage.setItem("opfs:entry:old", {
      version: 1,
      path: "/old",
      parent: "/",
      name: "old",
      kind: "file",
      lastModified: 1,
      data: "b2xk",
      size: 3,
      mediaType: "",
    });
    const fileSystem = createFileSystem(createUnstorageAdapter(storage), { disposeAdapter: true });
    releases.push(() => fileSystem.close());
    assert.equal(await fileSystem.readText("/old"), "old");
    await fileSystem.writeFile("/old", "current");
    assert.equal(await fileSystem.readText("/old"), "current");
    assert.deepEqual((await Array.fromAsync(fileSystem.readDir("/"))).map((entry) => entry.name), ["old"]);
    await fileSystem.remove("/old");
    assert.equal(await storage.getItem("opfs:entry:old"), null);
    assert.equal(await fileSystem.exists("/old"), false);
  }));

it("actual db0 node-sqlite connector preserves bytes and honors borrowed database ownership", async () =>
  await withReleases(async (releases) => {
    const { createDatabase } = await upstream("db0");
    const { default: connector } = await upstream("db0/connectors/node-sqlite");
    const database = createDatabase(connector({ name: ":memory:" }));
    releases.push(() => database.dispose());
    const fileSystem = createFileSystem(await createDb0Adapter(database), { disposeAdapter: true });
    releases.push(() => fileSystem.close());
    await verifyBytes(fileSystem);
    await fileSystem.close();
    assert.equal((await database.prepare("SELECT 41 + 1 AS answer").get()).answer, 42);
  }));

it("actual Drizzle SQLite query builders preserve the oracle on a real SQLite engine", async () =>
  await withReleases(async (releases) => {
    const { sqliteTable, text, integer } = await upstream("drizzle-orm/sqlite-core");
    const { drizzle } = await upstream("drizzle-orm/sqlite-proxy");
    const sqlite = new DatabaseSync(":memory:");
    releases.push(() => sqlite.close());
    sqlite.exec(
      "CREATE TABLE entries (path TEXT PRIMARY KEY, parent TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, data TEXT, size INTEGER NOT NULL, modified INTEGER NOT NULL, media TEXT)",
    );
    const table = sqliteTable("entries", {
      path: text("path").primaryKey(),
      parent: text("parent").notNull(),
      name: text("name").notNull(),
      kind: text("kind").notNull(),
      data: text("data"),
      size: integer("size").notNull(),
      lastModified: integer("modified").notNull(),
      mediaType: text("media"),
    });
    const database = drizzle(async (sql, parameters, method) => {
      const statement = sqlite.prepare(sql);
      statement.setReturnArrays(true);
      if (method === "run") {
        statement.run(...parameters);
        return { rows: [] };
      }
      return { rows: method === "get" ? statement.get(...parameters) : statement.all(...parameters) };
    });
    const fileSystem = createFileSystem(createDrizzleAdapter({ database, table }), { disposeAdapter: true });
    releases.push(() => fileSystem.close());
    await verifyBytes(fileSystem);
    await fileSystem.close();
    assert.equal(sqlite.prepare("SELECT 42").get()["42"], 42);
  }));

it("actual RxDB memory storage accepts the exported collection schema and preserves the byte oracle", async () =>
  await withReleases(async (releases) => {
    const { createRxDatabase } = await upstream("rxdb");
    const { getRxStorageMemory } = await upstream("rxdb/plugins/storage-memory");
    const database = await createRxDatabase({
      name: `opfs${crypto.randomUUID().replaceAll("-", "")}`,
      storage: getRxStorageMemory(),
      multiInstance: false,
    });
    releases.push(() => database.remove());
    const { entries } = await database.addCollections({ entries: { schema: RxDbRecordJsonSchema } });
    const fileSystem = createFileSystem(createRxDbAdapter(entries), { disposeAdapter: true });
    releases.push(() => fileSystem.close());
    await verifyBytes(fileSystem);
    await fileSystem.writeFile("/ownership.txt", "retained after facade close");
    await fileSystem.close();
    assert.ok(await entries.findOne("/ownership.txt").exec());
  }));
