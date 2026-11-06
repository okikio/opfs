import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { createWebhdfsClient, WebhdfsPublicationError } from "../src/webhdfs.ts";
import { collectBytes } from "../src/stream.ts";
import { createWebhdfsDriverFromClient } from "../src/driver/webhdfs.ts";
import { createWebhdfsAdapter } from "../src/adapter/webhdfs.ts";
import { createFileSystem } from "../mod.ts";

const payload = new TextEncoder().encode("hello");
const json = (value: unknown): Response => Response.json(value);
const status = (name = "", type = "FILE") => ({ pathSuffix: name, type, length: 5, modificationTime: 123 });
const redirected = (url: URL, modify?: (next: URL) => void): Response => {
  const next = new URL(url);
  next.host = "data.invalid";
  modify?.(next);
  return new Response(null, { status: 307, headers: { location: String(next) } });
};

describe("native WebHDFS authority", () => {
  it("performs no construction I/O and bounds JSON status fields", async () => {
    let calls = 0;
    const client = createWebhdfsClient({
      endpoint: "https://name.invalid/webhdfs/v1",
      root: "/tenant",
      dataOrigins: [],
      fetch: (input) => {
        calls++;
        expect(new URL(String(input)).pathname).toBe("/webhdfs/v1/tenant/file");
        return Promise.resolve(json({ FileStatus: status() }));
      },
    });
    expect(calls).toBe(0);
    expect((await client.stat("/file"))?.size).toBe(5);
    const invalid = createWebhdfsClient({
      endpoint: "https://name.invalid/webhdfs/v1",
      dataOrigins: [],
      fetch: () => Promise.resolve(json({ FileStatus: { ...status(), length: Number.MAX_SAFE_INTEGER + 1 } })),
    });
    await expect(invalid.stat("/file")).rejects.toThrow("safe integer");
  });
  it("uses OPEN offset/length query with HTTP200 and independent DataNode credentials", async () => {
    const targets: string[] = [];
    const client = createWebhdfsClient({
      endpoint: "https://name.invalid/webhdfs/v1",
      dataOrigins: ["https://data.invalid"],
      auth: (_url, target) => {
        targets.push(target);
        return { headers: { authorization: target }, query: { delegation: `${target}-token` } };
      },
      fetch: (input, init) => {
        const url = new URL(String(input));
        const headers = new Headers(init?.headers);
        expect(init?.redirect).toBe("manual");
        expect(init?.credentials).toBe("omit");
        expect(url.searchParams.get("offset")).toBe("1");
        expect(url.searchParams.get("length")).toBe("3");
        if (url.hostname === "name.invalid") {
          return Promise.resolve(
            redirected(url, (next) => next.searchParams.set("delegation", "redirect-issued-token")),
          );
        }
        expect(headers.get("authorization")).toBe("datanode");
        expect(url.searchParams.get("delegation")).toBe("datanode-token");
        return Promise.resolve(new Response(payload.slice(1, 4), { headers: { "content-length": "3" } }));
      },
    });
    expect(await collectBytes(await client.get("/file", { at: 1, length: 3 }), 3, undefined, "read", "/file")).toEqual(
      payload.slice(1, 4),
    );
    expect(targets).toEqual(["namenode", "datanode"]);
  });
  it("does not forward NameNode or server-issued token queries without an explicit DataNode callback", async () => {
    let dataSeen = false;
    const client = createWebhdfsClient({
      endpoint: "https://name.invalid/webhdfs/v1",
      dataOrigins: ["https://data.invalid"],
      auth: (_url, target) =>
        target === "namenode" ? { headers: { authorization: "secret" }, query: { delegation: "secret" } } : {},
      fetch: (input, init) => {
        const url = new URL(String(input));
        if (url.hostname === "name.invalid") return Promise.resolve(redirected(url));
        dataSeen = true;
        expect(url.searchParams.has("delegation")).toBe(false);
        expect(new Headers(init?.headers).has("authorization")).toBe(false);
        return Promise.resolve(new Response(payload));
      },
    });
    await collectBytes(await client.get("/file"), 5, undefined, "read", "/file");
    expect(dataSeen).toBe(true);
  });
  it("rejects redirect origin/path/query changes before DataNode credentials or payload dispatch", async () => {
    for (
      const modify of [(url: URL) => {
        url.host = "evil.invalid";
      }, (url: URL) => {
        url.pathname += "/other";
      }, (url: URL) => {
        url.searchParams.set("offset", "2");
      }, (url: URL) => {
        url.searchParams.append("op", "OPEN");
      }, (url: URL) => {
        url.searchParams.set("unknown", "true");
      }, (url: URL) => {
        url.protocol = "http:";
      }]
    ) {
      let calls = 0;
      let authCalls = 0;
      const client = createWebhdfsClient({
        endpoint: "https://name.invalid/webhdfs/v1",
        dataOrigins: ["https://data.invalid", "http://data.invalid"],
        auth: () => {
          authCalls++;
          return {};
        },
        fetch: (input) => {
          calls++;
          return Promise.resolve(redirected(new URL(String(input)), modify));
        },
      });
      await expect(client.get("/file", { at: 1, length: 3 })).rejects.toThrow();
      expect(calls).toBe(1);
      expect(authCalls).toBe(1);
    }
  });
  it("sends materialized CREATE/APPEND bodies only in the second stage and does not retry ambiguous append", async () => {
    const bodies: (BodyInit | null | undefined)[] = [];
    let fail = false;
    const client = createWebhdfsClient({
      endpoint: "https://name.invalid/webhdfs/v1",
      dataOrigins: ["https://data.invalid"],
      policy: { retries: 3 },
      fetch: (input, init) => {
        const url = new URL(String(input));
        bodies.push(init?.body);
        if (url.hostname === "name.invalid") {
          if (url.searchParams.get("op") === "CREATE") {
            expect(url.searchParams.get("overwrite")).toBe("false");
            expect(url.searchParams.get("createparent")).toBe("false");
          }
          return Promise.resolve(redirected(url, (next) => {
            if (url.searchParams.get("op") === "CREATE") next.searchParams.set("createflag", "");
          }));
        }
        expect(new Uint8Array(init?.body as Uint8Array)).toEqual(payload);
        if (fail) return Promise.reject(new Error("lost acknowledgement"));
        return Promise.resolve(new Response(null, { status: url.searchParams.get("op") === "CREATE" ? 201 : 200 }));
      },
    });
    await client.put("/file", payload);
    expect(bodies[0]).toBeUndefined();
    expect(bodies.length).toBe(2);
    fail = true;
    await expect(client.append("/file", payload)).rejects.toBeInstanceOf(WebhdfsPublicationError);
    expect(bodies.length).toBe(4);
  });
  it("admits bounded paginated native kinds and rejects repeated cursors, entries, pages and malformed children", async () => {
    let page = 0;
    const client = createWebhdfsClient({
      endpoint: "https://name.invalid/webhdfs/v1",
      dataOrigins: [],
      fetch: (input) => {
        const cursor = new URL(String(input)).searchParams.get("startAfter");
        expect(cursor).toBe(page === 0 ? "" : "first");
        return Promise.resolve(
          json({
            DirectoryListing: {
              partialListing: { FileStatuses: { FileStatus: [status(page++ === 0 ? "first" : "second", "SYMLINK")] } },
              remainingEntries: page === 1 ? 1 : 0,
            },
          }),
        );
      },
    });
    expect((await client.list("/")).map((entry) => entry.kind)).toEqual(["link", "link"]);
    for (const options of [{ maxPages: 1 }, { maxEntries: 0 }, {}]) {
      const broken = createWebhdfsClient({
        endpoint: "https://name.invalid/webhdfs/v1",
        dataOrigins: [],
        ...options,
        fetch: () =>
          Promise.resolve(
            json({
              DirectoryListing: {
                partialListing: { FileStatuses: { FileStatus: [status("same")] } },
                remainingEntries: 1,
              },
            }),
          ),
      });
      await expect(broken.list("/")).rejects.toThrow();
    }
  });
  it("defaults DELETE to recursive=false and keeps native recursive/rename/mkdir explicit", async () => {
    const operations: URL[] = [];
    const client = createWebhdfsClient({
      endpoint: "https://name.invalid/webhdfs/v1",
      root: "/tenant",
      dataOrigins: [],
      fetch: (input) => {
        operations.push(new URL(String(input)));
        return Promise.resolve(json({ boolean: true }));
      },
    });
    await client.remove("/directory");
    expect(operations[0]?.searchParams.get("recursive")).toBe("false");
    await client.remove("/directory", { recursive: true });
    expect(operations[1]?.searchParams.get("recursive")).toBe("true");
    await client.rename("/from", "/to");
    expect(operations[2]?.searchParams.get("destination")).toBe("/tenant/to");
    await client.mkdir("/parents/child");
    expect(operations[3]?.searchParams.get("op")).toBe("MKDIRS");
  });
  it("bounds actual OPEN bytes and retires header/stream failures", async () => {
    for (const declared of ["99", undefined]) {
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(payload);
        },
        cancel() {
          cancelled = true;
        },
      }, { highWaterMark: 0 });
      const client = createWebhdfsClient({
        endpoint: "https://name.invalid/webhdfs/v1",
        dataOrigins: [],
        fetch: () =>
          Promise.resolve(
            new Response(stream, { headers: declared === undefined ? {} : { "content-length": declared } }),
          ),
      });
      await expect(
        (async () => collectBytes(await client.get("/file", { length: 3 }), 10, undefined, "read", "/file"))(),
      ).rejects.toThrow();
      expect(cancelled).toBe(true);
      expect(stream.locked).toBe(false);
    }
    const short = createWebhdfsClient({
      endpoint: "https://name.invalid/webhdfs/v1",
      dataOrigins: [],
      fetch: () => Promise.resolve(new Response(payload, { headers: { "content-length": "6" } })),
    });
    await expect(collectBytes(await short.get("/file"), 10, undefined, "read", "/file")).rejects.toThrow(
      "Content-Length",
    );
  });
  it("refuses invalid paths, slot-spoofed upload sizes and aborted work before credentials", async () => {
    let calls = 0;
    const client = createWebhdfsClient({
      endpoint: "https://name.invalid/webhdfs/v1",
      dataOrigins: [],
      maxWriteBytes: 2,
      auth: () => {
        calls++;
        return {};
      },
    });
    const spoofed = new Uint8Array(5);
    Object.defineProperty(spoofed, "byteLength", { value: 1 });
    await expect(client.put("/file", spoofed)).rejects.toThrow("maxWriteBytes");
    await expect(client.get("/../file")).rejects.toThrow();
    const abort = new AbortController();
    abort.abort("stop");
    await expect(client.get("/file", { signal: abort.signal })).rejects.toBe("stop");
    expect(calls).toBe(0);
  });
  it("hard-refuses canonical mkdir/update/stream/copy/move before I/O, including direct driver calls", async () => {
    let calls = 0;
    const client = createWebhdfsClient({
      endpoint: "https://name.invalid/webhdfs/v1",
      dataOrigins: [],
      fetch: () => {
        calls++;
        throw new Error("unexpected");
      },
    });
    const driver = createWebhdfsDriverFromClient(client);
    await expect(driver.createDir("/new")).rejects.toMatchObject({ code: "not-supported" });
    await expect(driver.writeFile("/new", payload, { mode: "update" })).rejects.toMatchObject({
      code: "not-supported",
    });
    const fileSystem = createFileSystem(createWebhdfsAdapter(client));
    try {
      await expect(fileSystem.mkdir("/new", { recursive: true })).rejects.toMatchObject({ code: "not-supported" });
      await expect(fileSystem.writeFile("/new", new Blob([payload]).stream())).rejects.toMatchObject({
        code: "not-supported",
      });
      await expect(fileSystem.copy("/one", "/two")).rejects.toMatchObject({ code: "not-supported" });
      await expect(fileSystem.move("/one", "/two")).rejects.toMatchObject({ code: "not-supported" });
    } finally {
      await fileSystem[Symbol.asyncDispose]();
    }
    expect(calls).toBe(0);
  });
  it("keeps malformed namespace acknowledgements uncertain and maps known native HTTP errors", async () => {
    const rejected = createWebhdfsClient({
      endpoint: "https://name.invalid/webhdfs/v1",
      dataOrigins: [],
      fetch: () => Promise.resolve(json({ boolean: false })),
    });
    await expect(createWebhdfsDriverFromClient(rejected).remove("/entry")).rejects.toMatchObject({
      code: "invalid-operation",
      cause: { name: "WebhdfsRejectionError" },
    });
    for (const value of [null, [], {}, { boolean: "true" }]) {
      const client = createWebhdfsClient({
        endpoint: "https://name.invalid/webhdfs/v1",
        dataOrigins: [],
        fetch: () => Promise.resolve(json(value)),
      });
      await expect(client.mkdir("/new")).rejects.toBeInstanceOf(WebhdfsPublicationError);
    }
    const client = createWebhdfsClient({
      endpoint: "https://name.invalid/webhdfs/v1",
      dataOrigins: [],
      fetch: () => Promise.resolve(new Response(null, { status: 403 })),
    });
    await expect(createWebhdfsDriverFromClient(client).remove("/entry")).rejects.toMatchObject({
      code: "permission-denied",
      cause: { status: 403 },
    });
  });
});
