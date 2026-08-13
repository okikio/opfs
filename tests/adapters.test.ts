import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createFileSystem, FileSystemError, probeOpfs } from "../mod.ts";
import { createMemoryAdapter } from "../src/adapter/memory.ts";
import { defineAdapter } from "../src/adapter/definition.ts";
import { createNodeAdapter } from "../src/adapter/node.ts";
import { createUnstorageAdapter } from "../src/adapter/unstorage.ts";
import { createUnstorageDriver } from "../src/driver/unstorage.ts";
import { createRxDbAdapter, RxDbRecordJsonSchema } from "../src/adapter/rxdb.ts";
import { createDb0Adapter } from "../src/adapter/db0.ts";
import { createDrizzleAdapter } from "../src/adapter/drizzle.ts";
import { basename, dirname, isAncestorPath, joinPath, normalizePath, splitPath } from "../src/path.ts";

function memoryFileSystem(name = crypto.randomUUID(), options = {}) {
  return createFileSystem(createMemoryAdapter(), {
    coordination: "local",
    lockPrefix: `test:${name}`,
    ...options,
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function waitFor(predicate, timeout = 1000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

class MemoryUnstorage {
  #values = new Map();
  disposed = false;
  async getItem(key) { return structuredClone(this.#values.get(key) ?? null); }
  async setItem(key, value) { this.#values.set(key, structuredClone(value)); }
  async removeItem(key) { this.#values.delete(key); }
  async getKeys(base = "") { return [...this.#values.keys()].filter((key) => key.startsWith(base)); }
  async dispose() { this.disposed = true; }
}

class FakeRxDocument {
  constructor(record, remove) { this.record = record; this.remove = remove; }
  toJSON() { return structuredClone(this.record); }
  async incrementalRemove() { this.remove(); }
}

class FakeRxCollection {
  #records = new Map();
  findOne(path) {
    return { exec: async () => {
      const record = this.#records.get(path);
      return record === undefined ? null : new FakeRxDocument(record, () => this.#records.delete(path));
    } };
  }
  find({ selector }) {
    return { exec: async () => [...this.#records.values()]
      .filter((record) => record.parent === selector.parent)
      .map((record) => new FakeRxDocument(record, () => this.#records.delete(record.path))) };
  }
  async incrementalUpsert(record) { this.#records.set(record.path, structuredClone(record)); }
}

class SqliteDb0Database {
  dialect = "sqlite";
  #database = new DatabaseSync(":memory:");

  prepare(sql) {
    const statement = this.#database.prepare(sql);
    return {
      all: async (...params) => statement.all(...params),
      get: async (...params) => statement.get(...params),
      run: async (...params) => ({ success: true, ...statement.run(...params) }),
    };
  }

  async dispose() {
    this.#database.close();
  }
}

class FakeDb0Database {
  constructor(dialect) { this.dialect = dialect; }
  #rows = new Map();
  prepared = [];
  disposed = false;
  prepare(sql) {
    this.prepared.push(sql);
    const rows = this.#rows;
    if (sql.startsWith("CREATE TABLE")) {
      return { all: async () => [], get: async () => undefined, run: async () => ({ success: true }) };
    }
    if (sql.startsWith("SELECT") && sql.includes("WHERE id")) {
      return { all: async () => [], get: async (id) => rows.get(id), run: async () => ({ success: true }) };
    }
    if (sql.startsWith("SELECT") && sql.includes("WHERE parent_path")) {
      return {
        all: async (parent) => [...rows.values()].filter((row) => row.parent_path === parent),
        get: async () => undefined,
        run: async () => ({ success: true }),
      };
    }
    if (sql.startsWith("INSERT")) {
      return {
        all: async () => [],
        get: async () => undefined,
        run: async (id, path, parent_path, name, kind, data, size, last_modified, media_type) => {
          rows.set(id, { path, parent_path, name, kind, data, size, last_modified, media_type });
          return { success: true };
        },
      };
    }
    if (sql.startsWith("DELETE")) {
      return { all: async () => [], get: async () => undefined, run: async (id) => { rows.delete(id); return { success: true }; } };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }
  async dispose() { this.disposed = true; }
}

function createFakeDrizzle() {
  const table = {
    path: { name: "path" }, parent: { name: "parent" }, name: { name: "name" }, kind: { name: "kind" },
    data: { name: "data" }, size: { name: "size" }, lastModified: { name: "lastModified" }, mediaType: { name: "mediaType" },
  };
  const rows = [];
  const database = {
    select() {
      return {
        from() {
          return {
            where(condition) {
              const selected = () => rows.filter((row) => row[condition.column.name] === condition.value).map((row) => ({ ...row }));
              return {
                then(resolve, reject) { return Promise.resolve(selected()).then(resolve, reject); },
                limit(count) { return Promise.resolve(selected().slice(0, count)); },
              };
            },
          };
        },
      };
    },
    delete() {
      return {
        where(condition) {
          for (let index = rows.length - 1; index >= 0; index -= 1) {
            if (rows[index][condition.column.name] === condition.value) rows.splice(index, 1);
          }
          return Promise.resolve();
        },
      };
    },
    insert() {
      return { values(value) { rows.push({ ...value }); return Promise.resolve(); } };
    },
  };
  return { database, table, rows };
}

async function exerciseRecordBackend(fileSystem) {
  await fileSystem.writeFile("/records/a.txt", "A", { parents: true });
  await fileSystem.writeFile("/records/b.txt", "B", { parents: true });
  assert.equal(await fileSystem.readText("/records/a.txt"), "A");
  const names = [];
  for await (const entry of fileSystem.readDir("/records")) names.push(entry.name);
  names.sort();
  assert.deepEqual(names, ["a.txt", "b.txt"]);
  await fileSystem.move("/records/a.txt", "/records/c.txt");
  assert.equal(await fileSystem.exists("/records/a.txt"), false);
  assert.equal(await fileSystem.readText("/records/c.txt"), "A");
}

test("adapter and facade schemas reject invalid runtime contracts", async () => {
  const valid = createMemoryAdapter();
  assert.throws(() => defineAdapter({ ...valid, name: "" }));
  assert.throws(
    () => defineAdapter({ ...valid, capabilities: { ...valid.capabilities, streamRead: "yes" } }),
  );
  assert.throws(() => createFileSystem(valid, { coordination: "invalid" }));

  const fs = memoryFileSystem();
  await assert.rejects(fs.writeFile("/invalid.txt", "data", { mode: "invalid" }));
});

test("web-lock coordination requests shared tree and exclusive file locks", async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const requests = [];
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      locks: {
        async request(name, options, callback) {
          requests.push({ name, mode: options.mode });
          await callback();
        },
      },
    },
  });

  try {
    const fs = createFileSystem(createMemoryAdapter(), {
      coordination: "web-locks",
      lockPrefix: "test:web-locks",
    });
    await fs.writeFile("/locked.txt", "data", { parents: true });
    assert.deepEqual(requests, [
      { name: "test:web-locks:tree", mode: "shared" },
      { name: "test:web-locks:file:/locked.txt", mode: "exclusive" },
    ]);
  } finally {
    if (originalNavigator === undefined) delete globalThis.navigator;
    else Object.defineProperty(globalThis, "navigator", originalNavigator);
  }
});

test("path helpers normalize virtual paths and reject root escape", () => {
  assert.equal(normalizePath("a/./b/../c"), "/a/c");
  assert.equal(joinPath("/a", "b", "../c"), "/a/c");
  assert.deepEqual(splitPath("/a/c"), ["a", "c"]);
  assert.equal(dirname("/a/c"), "/a");
  assert.equal(basename("/a/c"), "c");
  assert.equal(isAncestorPath("/a", "/a/c"), true);
  assert.throws(() => normalizePath("../../escape"), (error) => error instanceof FileSystemError && error.code === "invalid-path");
  assert.throws(() => normalizePath("a\\b"), (error) => error instanceof FileSystemError && error.code === "invalid-path");
});

test("memory adapter preserves replace, append, update, range, and stat semantics", async () => {
  const fs = memoryFileSystem();
  await fs.writeFile("/data.txt", "hello", { parents: true });
  await fs.writeFile("/data.txt", " world", { mode: "append" });
  await fs.writeFile("/data.txt", "OPFS", { mode: "update", at: 6 });
  assert.equal(await fs.readText("/data.txt"), "hello OPFSd");
  assert.deepEqual([...await fs.readFile("/data.txt", { at: 6, length: 4 })], [...new TextEncoder().encode("OPFS")]);
  const stat = await fs.stat("/data.txt");
  assert.equal(stat.kind, "file");
  assert.equal(stat.size, 11);
});

test("openWritableFile creates and owns one file lock until terminal cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "opfs-positional-create-"));
  const adapter = createNodeAdapter({ root });
  const fs = createFileSystem(adapter, { coordination: "local", disposeAdapter: true });
  try {
    const file = await fs.openWritableFile("/nested/output.bin", { create: true, parents: true });
    await file.write(new TextEncoder().encode("AB"), { at: 0 });
    const queued = fs.writeFile("/nested/output.bin", "after");
    let settled = false;
    void queued.finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(settled, false);
    await file.close();
    await queued;
    assert.equal(await fs.readText("/nested/output.bin"), "after");
  } finally {
    await fs.close();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

test("openSyncFile creates and owns one file lock until close", async () => {
  const root = await mkdtemp(join(tmpdir(), "opfs-sync-create-"));
  const adapter = createNodeAdapter({ root });
  const fs = createFileSystem(adapter, { coordination: "local", disposeAdapter: true });
  try {
    const file = await fs.openSyncFile("/nested/sync.bin", { create: true, parents: true });
    file.writeAll(new TextEncoder().encode("AB"), { at: 0 });
    const queued = fs.writeFile("/nested/sync.bin", "after");
    let settled = false;
    void queued.finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(settled, false);
    file.close();
    await queued;
    assert.equal(await fs.readText("/nested/sync.bin"), "after");
  } finally {
    await fs.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("record backends reject long-lived positional files instead of emulating them", async () => {
  const fs = memoryFileSystem();
  await fs.ensureFile("/media.bin");
  await assert.rejects(
    fs.openWritableFile("/media.bin"),
    (error) => error instanceof FileSystemError && error.code === "not-supported",
  );
});

test("OPFS-shaped handles work over a non-OPFS memory backend", async () => {
  const fs = memoryFileSystem();
  const directory = await fs.root.getDirectoryHandle("docs", { create: true });
  const file = await directory.getFileHandle("note.txt", { create: true });
  const writable = await file.createWritable();
  await writable.write(new Blob(["blob"]));
  await writable.write({ type: "write", position: 4, data: " data" });
  await writable.close();
  assert.equal(await (await file.getFile()).text(), "blob data");
  assert.equal(await file.isSameEntry(await directory.getFileHandle("note.txt")), true);
  assert.deepEqual(await fs.root.resolve(file), ["docs", "note.txt"]);
  const entries = [];
  for await (const [name, child] of directory) entries.push([name, child.kind]);
  assert.deepEqual(entries, [["note.txt", "file"]]);
});

test("staged writable abort discards bytes", async () => {
  const fs = memoryFileSystem();
  await fs.writeFile("/file.txt", "before", { parents: true });
  const file = await fs.getFileHandle("/file.txt");
  const writable = await file.createWritable({ keepExistingData: true });
  const writer = writable.getWriter();
  await writer.write({ type: "write", position: 0, data: "after" });
  await writer.abort("discard");
  writer.releaseLock();
  assert.equal(await fs.readText("/file.txt"), "before");
});

test("record adapters cap streamed writes and cancel the producer", async () => {
  const fs = memoryFileSystem(undefined, { maxBufferedWriteBytes: 4 });
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); controller.enqueue(new Uint8Array([4, 5])); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(fs.writeFile("/large.bin", stream, { parents: true }), (error) => error instanceof FileSystemError && error.code === "too-large");
  assert.equal(cancelled, true);
  assert.equal(await fs.exists("/large.bin"), false);
});

test("copy replaces stale trees and fallback move removes the source", async () => {
  const fs = memoryFileSystem();
  await fs.writeFile("/source/nested/a.txt", "A", { parents: true });
  await fs.writeFile("/source/b.txt", "B", { parents: true });
  await fs.writeFile("/destination/stale.txt", "stale", { parents: true });
  await fs.copy("/source", "/destination", { overwrite: true, concurrency: 2 });
  assert.equal(await fs.readText("/destination/nested/a.txt"), "A");
  assert.equal(await fs.exists("/destination/stale.txt"), false);
  await fs.move("/destination", "/moved", { concurrency: 2 });
  assert.equal(await fs.exists("/destination"), false);
  assert.equal(await fs.readText("/moved/b.txt"), "B");
});

test("overlap is rejected before destructive overwrite", async () => {
  const fs = memoryFileSystem();
  await fs.writeFile("/a/b/file.txt", "safe", { parents: true });
  await assert.rejects(fs.copy("/a", "/a/c", { overwrite: true }), (error) => error instanceof FileSystemError && error.code === "invalid-operation");
  await assert.rejects(fs.copy("/a/b/file.txt", "/a", { overwrite: true }), (error) => error instanceof FileSystemError && error.code === "invalid-operation");
  assert.equal(await fs.readText("/a/b/file.txt"), "safe");
});

test("aborted queued write does not poison later same-file mutations", async () => {
  const fs = memoryFileSystem();
  const releaseFirst = deferred();
  let firstStarted = false;
  async function* firstData() { firstStarted = true; yield new TextEncoder().encode("first"); await releaseFirst.promise; }
  const first = fs.writeFile("/queue.txt", firstData(), { parents: true });
  await waitFor(() => firstStarted);
  const controller = new AbortController();
  const second = fs.writeFile("/queue.txt", "second", { signal: controller.signal });
  controller.abort("cancel queued write");
  await assert.rejects(second, (error) => error instanceof FileSystemError && error.code === "aborted");
  const third = fs.writeFile("/queue.txt", "third");
  releaseFirst.resolve();
  await first;
  await third;
  assert.equal(await fs.readText("/queue.txt"), "third");
});

test("independent file writes can progress concurrently", async () => {
  const fs = memoryFileSystem();
  const releaseFirst = deferred();
  let firstStarted = false;
  async function* firstData() {
    firstStarted = true;
    yield new TextEncoder().encode("first");
    await releaseFirst.promise;
  }

  const first = fs.writeFile("/parallel/a.txt", firstData(), { parents: true });
  await waitFor(() => firstStarted);
  await fs.writeFile("/parallel/b.txt", "second", { parents: true });
  assert.equal(await fs.readText("/parallel/b.txt"), "second");
  releaseFirst.resolve();
  await first;
});

test("tree mutation waits for an active file write", async () => {
  const fs = memoryFileSystem();
  const release = deferred();
  let started = false;
  async function* data() { started = true; yield new TextEncoder().encode("data"); await release.promise; }
  const write = fs.writeFile("/tree/file.txt", data(), { parents: true });
  await waitFor(() => started);
  let emptied = false;
  const empty = fs.emptyDir("/tree").then(() => { emptied = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(emptied, false);
  release.resolve();
  await write;
  await empty;
  assert.equal(await fs.exists("/tree/file.txt"), false);
});

test("openReadStream propagates AbortSignal after the stream opens", async () => {
  const fs = memoryFileSystem();
  await fs.writeFile("/abort.bin", new Uint8Array(1024), { parents: true });
  const controller = new AbortController();
  const stream = await fs.openReadStream("/abort.bin", { signal: controller.signal });
  controller.abort("stop");
  await assert.rejects(new Response(stream).arrayBuffer(), (error) => error instanceof FileSystemError && error.code === "aborted");
});

test("unstorage adapter uses the high-level Storage contract and owns it only when requested", async () => {
  const storage = new MemoryUnstorage();
  const adapter = createUnstorageAdapter(storage, { disposeStorage: true });
  const fs = createFileSystem(adapter, { coordination: "local", disposeAdapter: true });
  await exerciseRecordBackend(fs);
  await fs.close();
  assert.equal(storage.disposed, true);
});

test("reverse unstorage driver can expose any filesystem backend", async () => {
  const fs = memoryFileSystem();
  const driver = createUnstorageDriver(fs);
  await driver.setItem("cache:item", "value", {});
  assert.equal(await driver.getItem("cache:item"), "value");
  assert.deepEqual(await driver.getKeys("cache", { maxDepth: 2 }), ["cache:item"]);
  await driver.setItemRaw("cache:binary", new Uint8Array([1, 2, 3]), {});
  assert.deepEqual([...await driver.getItemRaw("cache:binary", {})], [1, 2, 3]);
  await driver.setItem("odd% key/part:item?", "encoded", {});
  await driver.setItem("odd~25:item", "tilde", {});
  await driver.setItem("prefix", "parent-value", {});
  await driver.setItem("prefix:child", "child-value", {});
  assert.equal(await driver.getItem("prefix"), "parent-value");
  assert.equal(await driver.getItem("prefix:child"), "child-value");
  assert.equal(await driver.getItem("odd% key/part:item?"), "encoded");
  assert.equal(await driver.getItem("odd~25:item"), "tilde");
  const encodedKeys = await driver.getKeys("", { maxDepth: 4 });
  assert.equal(encodedKeys.includes("odd% key/part:item?"), true);
  assert.equal(encodedKeys.includes("odd~25:item"), true);
  assert.equal(encodedKeys.includes("prefix"), true);
  assert.equal(encodedKeys.includes("prefix:child"), true);
  await driver.removeItem("cache:item", {});
  assert.equal(await driver.hasItem("cache:item", {}), false);
  await driver.removeItem("cache:missing", {});
  await driver.clear("cache:missing", {});
  assert.deepEqual(await driver.getKeys("odd% key/part:item?:", { maxDepth: 1 }), []);
  await driver.clear("prefix:", {});
  assert.equal(await driver.getItem("prefix"), "parent-value");
  assert.equal(await driver.getItem("prefix:child"), null);
});

test("RxDB bridge targets RxCollection and therefore remains storage-engine agnostic", async () => {
  assert.equal(RxDbRecordJsonSchema.primaryKey, "path");
  assert.deepEqual(RxDbRecordJsonSchema.indexes, ["parent"]);
  assert.equal(RxDbRecordJsonSchema.oneOf.length, 2);
  assert.deepEqual(RxDbRecordJsonSchema.oneOf[1].required, ["kind", "data", "size", "mediaType"]);
  const fs = createFileSystem(createRxDbAdapter(new FakeRxCollection()), { coordination: "local" });
  await exerciseRecordBackend(fs);
});

for (const dialect of ["sqlite", "libsql", "postgresql", "mysql"]) {
  test(`db0 bridge executes portable record operations for ${dialect}`, async () => {
    const database = new FakeDb0Database(dialect);
    const adapter = await createDb0Adapter(database, { disposeDatabase: true });
    const fs = createFileSystem(adapter, { coordination: "local", disposeAdapter: true });
    await exerciseRecordBackend(fs);
    await fs.close();
    assert.equal(database.disposed, true);
    assert.equal(database.prepared.some((sql) => sql.startsWith("CREATE TABLE")), true);
    assert.equal(database.prepared.some((sql) => sql.includes("?")), true);
    if (dialect === "mysql") assert.equal(database.prepared.some((sql) => sql.includes("ON DUPLICATE KEY UPDATE")), true);
  });
}

test("db0 SQLite SQL executes against a real SQLite engine", async () => {
  const database = new SqliteDb0Database();
  const adapter = await createDb0Adapter(database, { disposeDatabase: true });
  const fs = createFileSystem(adapter, { coordination: "local", disposeAdapter: true });
  await exerciseRecordBackend(fs);
  await fs.close();
});

test("Drizzle bridge uses caller-provided dialect schema and common CRUD builders", async () => {
  const { database, table } = createFakeDrizzle();
  const fs = createFileSystem(createDrizzleAdapter({ database, table }), { coordination: "local" });
  await exerciseRecordBackend(fs);
});

test("Node adapter performs real streaming, native move, and synchronous random access", async () => {
  const root = await mkdtemp(join(tmpdir(), "okikio-opfs-"));
  try {
    const adapter = createNodeAdapter({ root });
    const fs = createFileSystem(adapter, { coordination: "local" });
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("stream")); controller.close(); } });
    await fs.writeFile("/nested/file.txt", stream, { parents: true });
    assert.equal(await fs.readText("/nested/file.txt"), "stream");
    await fs.move("/nested/file.txt", "/nested/moved.txt");
    assert.equal(await fs.exists("/nested/file.txt"), false);

    await fs.ensureFile("/nested/positional.bin");
    const positional = await fs.openWritableFile("/nested/positional.bin");
    await positional.write(new TextEncoder().encode("CD"), { at: 2 });
    await positional.write(new TextEncoder().encode("AB"), { at: 0 });
    await positional.flush();
    assert.equal(await fs.readText("/nested/positional.bin"), "ABCD");

    let queuedPositionalWriteCompleted = false;
    const queuedPositionalWrite = fs.writeFile("/nested/positional.bin", "after-positional")
      .then(() => { queuedPositionalWriteCompleted = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(queuedPositionalWriteCompleted, false);
    await positional.close();
    await positional.close();
    await queuedPositionalWrite;
    assert.equal(await fs.readText("/nested/positional.bin"), "after-positional");

    const sync = await fs.openSyncFile("/nested/moved.txt");
    sync.writeAll(new TextEncoder().encode("NODE"), { at: 0 });
    sync.flush();

    let queuedWriteCompleted = false;
    const queuedWrite = fs.writeFile("/nested/moved.txt", "after-sync")
      .then(() => { queuedWriteCompleted = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(queuedWriteCompleted, false);

    sync.close();
    await queuedWrite;
    assert.equal(await fs.readText("/nested/moved.txt"), "after-sync");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("filesystem disposal follows explicit adapter ownership", async () => {
  let disposed = 0;
  const adapter = createMemoryAdapter();
  adapter.dispose = async () => { disposed += 1; };
  const borrowed = createFileSystem(adapter, { coordination: "local" });
  await borrowed.close();
  assert.equal(disposed, 0);
  const owned = createFileSystem(adapter, { coordination: "local", disposeAdapter: true });
  await owned.close();
  await owned.close();
  assert.equal(disposed, 1);
});

test("probeOpfs is non-throwing outside a browser OPFS context", async () => {
  const capabilities = await probeOpfs();
  assert.equal(typeof capabilities.rootAvailable, "boolean");
  if (!capabilities.rootAvailable) assert.equal(typeof capabilities.rootError?.name, "string");
});
