import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { once } from "node:events";
import { close } from "../src/close.ts";
import { createWebhdfsClient } from "../src/webhdfs.ts";
import { createWebhdfsDriverFromClient } from "../src/driver/webhdfs.ts";
import { createWebhdfsAdapter } from "../src/adapter/webhdfs.ts";
import { createFileSystem } from "../mod.ts";

/** A protocol fixture, not an HDFS emulator or proof of provider conformance. */
describe("WebHDFS two-origin HTTP protocol", () => {
  it("runs native/client/driver/facade operations without forwarding NameNode credentials", async () => {
    const files = new Map<string, Uint8Array>();
    const directories = new Set(["/workspace"]);
    const methods: string[] = [];
    let dataOrigin = "";
    const canonical = (url: URL): string => decodeURIComponent(url.pathname.slice("/webhdfs/v1".length));
    const nativeStatus = (name: string, isDirectory: boolean, size: number) => ({
      pathSuffix: name,
      type: isDirectory ? "DIRECTORY" : "FILE",
      length: size,
      modificationTime: 123,
    });
    const data = createServer(async (request, response) => {
      try {
        const url = new URL(request.url!, "http://fixture.invalid");
        expect(request.headers.authorization).toBe("DataNode-only");
        expect(url.searchParams.get("delegation")).toBe("explicit-data-token");
        const path = canonical(url);
        const operation = url.searchParams.get("op");
        methods.push(`data:${operation}`);
        if (operation === "OPEN") {
          const bytes = files.get(path);
          if (bytes === undefined) {
            response.writeHead(404);
            response.end();
            return;
          }
          const offset = Number(url.searchParams.get("offset") ?? 0);
          const length = Number(url.searchParams.get("length") ?? bytes.length);
          const selected = bytes.subarray(offset, offset + length);
          response.writeHead(200, { "content-length": String(selected.length) });
          response.end(selected);
          return;
        }
        const chunks: Uint8Array[] = [];
        for await (const chunk of request) chunks.push(new Uint8Array(chunk));
        const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        if (operation === "CREATE") {
          if (files.has(path) && url.searchParams.get("overwrite") !== "true") {
            response.writeHead(403);
            response.end();
            return;
          }
          files.set(path, bytes);
          response.writeHead(201);
          response.end();
          return;
        }
        if (operation === "APPEND") {
          const previous = files.get(path);
          if (previous === undefined) {
            response.writeHead(404);
            response.end();
            return;
          }
          const combined = new Uint8Array(previous.length + bytes.length);
          combined.set(previous);
          combined.set(bytes, previous.length);
          files.set(path, combined);
          response.writeHead(200);
          response.end();
          return;
        }
        response.writeHead(400);
        response.end();
      } catch (reason) {
        response.destroy(reason as Error);
      }
    });
    const name = createServer((request, response) => {
      try {
        const url = new URL(request.url!, "http://fixture.invalid");
        expect(request.headers.authorization).toBe("NameNode-only");
        expect(url.searchParams.get("delegation")).toBe("name-token");
        const path = canonical(url);
        const operation = url.searchParams.get("op")!;
        methods.push(`name:${operation}`);
        const json = (value: unknown) => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(value));
        };
        if (["OPEN", "CREATE", "APPEND"].includes(operation)) {
          if ((operation === "OPEN" || operation === "APPEND") && !files.has(path)) {
            response.writeHead(404);
            response.end();
            return;
          }
          const next = new URL(`${dataOrigin}${url.pathname}${url.search}`);
          next.searchParams.set("delegation", "server-issued-token-must-not-forward");
          next.searchParams.set("namenoderpcaddress", "name:8020");
          response.writeHead(307, { location: String(next) });
          response.end();
          return;
        }
        if (operation === "GETFILESTATUS") {
          if (!files.has(path) && !directories.has(path)) {
            response.writeHead(404);
            response.end();
            return;
          }
          json({ FileStatus: nativeStatus("", directories.has(path), files.get(path)?.length ?? 0) });
          return;
        }
        if (operation === "LISTSTATUS_BATCH") {
          const prefix = `${path}/`;
          const names = [...directories, ...files.keys()].filter((key) =>
            key.startsWith(prefix) && !key.slice(prefix.length).includes("/")
          ).map((key) => key.slice(prefix.length)).sort();
          const after = url.searchParams.get("startAfter") ?? "";
          const pending = names.filter((name) => name > after);
          const selected = pending.slice(0, 2);
          json({
            DirectoryListing: {
              partialListing: {
                FileStatuses: {
                  FileStatus: selected.map((name) =>
                    nativeStatus(name, directories.has(`${prefix}${name}`), files.get(`${prefix}${name}`)?.length ?? 0)
                  ),
                },
              },
              remainingEntries: pending.length - selected.length,
            },
          });
          return;
        }
        if (operation === "DELETE") {
          const descendants = [...directories, ...files.keys()].filter((key) => key.startsWith(`${path}/`));
          if (descendants.length && url.searchParams.get("recursive") !== "true") {
            response.writeHead(403);
            response.end();
            return;
          }
          for (const key of [path, ...descendants]) {
            files.delete(key);
            directories.delete(key);
          }
          json({ boolean: true });
          return;
        }
        if (operation === "MKDIRS") {
          const parts = path.slice(1).split("/");
          let parent = "";
          for (const part of parts) {
            parent += `/${part}`;
            directories.add(parent);
          }
          json({ boolean: true });
          return;
        }
        if (operation === "RENAME") {
          let destination = url.searchParams.get("destination")!;
          if (directories.has(destination)) destination += `/${path.split("/").at(-1)}`;
          const bytes = files.get(path);
          if (bytes === undefined) {
            json({ boolean: false });
            return;
          }
          files.set(destination, bytes);
          files.delete(path);
          json({ boolean: true });
          return;
        }
        response.writeHead(400);
        response.end();
      } catch (reason) {
        response.destroy(reason as Error);
      }
    });
    const start = async (server: Server): Promise<string> => {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("Missing fixture port");
      return `http://127.0.0.1:${address.port}`;
    };
    const stop = async (server: Server): Promise<void> => {
      if (!server.listening) return;
      const stopped = new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve())
      );
      server.closeAllConnections();
      await stopped;
    };
    let primary: readonly unknown[] = [];
    try {
      dataOrigin = await start(data);
      const nameOrigin = await start(name);
      const client = createWebhdfsClient({
        endpoint: `${nameOrigin}/webhdfs/v1`,
        root: "/workspace",
        dataOrigins: [dataOrigin],
        policy: { retries: 0 },
        auth: (_url, target) => ({
          headers: { authorization: target === "namenode" ? "NameNode-only" : "DataNode-only" },
          query: { delegation: target === "namenode" ? "name-token" : "explicit-data-token" },
        }),
      });
      await client.mkdir("/native/parents");
      expect(directories.has("/workspace/native/parents")).toBe(true);
      const driver = createWebhdfsDriverFromClient(client);
      await driver.writeFile("/one", new Uint8Array([1, 2]), { mode: "replace" });
      await driver.writeFile("/one", new Uint8Array([3]), { mode: "append" });
      expect(await driver.readFile("/one", { at: 1, length: 2 })).toEqual(new Uint8Array([2, 3]));
      // A known APPEND 404 enters exclusive CREATE, never an unprotected overwrite.
      await driver.writeFile("/new", new Uint8Array([7]), { mode: "append" });
      expect(await driver.readFile("/new")).toEqual(new Uint8Array([7]));
      const fileSystem = createFileSystem(createWebhdfsAdapter(client));
      try {
        await fileSystem.writeFile("/facade", new Uint8Array([4, 5]));
        expect(await fileSystem.readFile("/facade")).toEqual(new Uint8Array([4, 5]));
        const names: string[] = [];
        for await (const entry of fileSystem.readDir("/")) names.push(entry.name);
        expect(names.sort()).toEqual(["facade", "native", "new", "one"]);
        const before = methods.length;
        await expect(fileSystem.mkdir("/refused")).rejects.toMatchObject({ code: "not-supported" });
        expect(methods.length).toBe(before);
        await fileSystem.remove("/facade");
        expect(files.has("/workspace/facade")).toBe(false);
      } finally {
        await fileSystem.close();
      }
      await client.rename("/one", "/renamed");
      expect(files.has("/workspace/renamed")).toBe(true);
      await expect(driver.remove("/native")).rejects.toMatchObject({ code: "permission-denied" });
      expect(directories.has("/workspace/native/parents")).toBe(true);
      await client.remove("/native", { recursive: true });
      expect(directories.has("/workspace/native/parents")).toBe(false);
    } catch (reason) {
      primary = [reason];
    }
    await close([() => stop(name), () => stop(data)], primary);
  });
});
