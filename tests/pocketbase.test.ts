import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { PocketbaseClient, PocketbaseError, PocketbasePublicationError } from "../src/pocketbase.ts";
import type { PocketbaseOptionsType } from "../src/pocketbase.ts";
const endpoint = "https://pb.invalid/", id = "record123", name = "note_server.txt";
const bytes = new TextEncoder().encode("hello\n");
const record = (files: string | string[] = [name], overrides: Record<string, unknown> = {}) => ({
  id,
  collectionId: "collection123",
  collectionName: "notes",
  documents: files,
  ...overrides,
});
const json = (value: unknown) => new Response(JSON.stringify(value));
const client = (fetch: NonNullable<PocketbaseOptionsType["fetch"]>, extra: Partial<PocketbaseOptionsType> = {}) =>
  new PocketbaseClient({ endpoint, collection: "notes", field: "documents", fetch, ...extra });
describe("native PocketBase record files", () => {
  it("keeps API authorization and explicit protected-file tokens separate", async () => {
    let credentials = 0, requests = 0;
    const files = client(async (input, init) => {
      const target = new URL(input.toString()), headers = new Headers(init?.headers);
      expect(init?.redirect).toBe("manual");
      expect(init?.credentials).toBe("omit");
      if (++requests === 1) {
        expect(headers.get("Authorization")).toBe("native-token");
        return json(record());
      }
      expect(headers.has("Authorization")).toBe(false);
      expect(target.pathname).toBe(`/api/files/notes/${id}/${name}`);
      expect(target.searchParams.get("token")).toBe("file-token");
      return new Response(new Uint8Array(bytes), { headers: { "Content-Length": "6" } });
    }, {
      credentials: () => {
        credentials++;
        return "native-token";
      },
    });
    expect((await files.getRecord(id)).files).toEqual([name]);
    expect(await files.read(id, name, { token: "file-token" })).toEqual(bytes);
    expect(credentials).toBe(1);
  });
  it("uses literal encoded components and refuses normalizing aliases before credentials", async () => {
    let calls = 0;
    const files = client(async (input) => {
      calls++;
      expect(new URL(input.toString()).pathname).toContain("a%23%3F%25.txt");
      return new Response("x");
    });
    expect(await files.read(id, "a#?%.txt")).toEqual(new TextEncoder().encode("x"));
    for (const name of ["..", ".", "a/b", "a\\b", "a\0b", "\ud800"]) {
      await expect(files.read(id, name)).rejects.toThrow();
    }
    expect(calls).toBe(1);
    expect(() => client(async () => json(record()), { field: "documents+" })).toThrow();
  });
  it("rejects conflicting/missing record identity and malformed configured field", async () => {
    for (
      const value of [
        record([], { id: "other" }),
        record([], { collectionId: "x", collectionName: "y" }),
        record([], { documents: null }),
        record([name, name]),
      ]
    ) {
      await expect(client(async () => json(value)).getRecord(id)).rejects.toThrow();
    }
    expect((await client(async () => json(record(""))).getRecord(id)).files).toEqual([]);
  });
  it("bounds duplicate-aware JSON before promoting record authority", async () => {
    for (
      const text of [
        JSON.stringify(record()).replace('"id":"record123"', '"id":"other","id":"record123"'),
        JSON.stringify(record()).replace('"documents"', '"__proto__":{},"documents"'),
      ]
    ) {
      await expect(client(async () => new Response(text)).getRecord(id)).rejects.toThrow("JSON");
    }
  });
  it("checks finite native pages without claiming snapshot totals", async () => {
    const files = client(async (input) => {
      const target = new URL(input.toString());
      expect(target.searchParams.get("sort")).toBe("id");
      return json({ page: 2, perPage: 1, totalItems: 4, totalPages: 4, items: [record()] });
    });
    expect((await files.listPage({ page: 2, perPage: 1 })).items[0]!.id).toBe(id);
    await expect(files.listPage({ page: 0 })).rejects.toThrow();
    await expect(files.listPage({ perPage: 501 })).rejects.toThrow();
    await expect(files.listPage()).rejects.toThrow("extent");
  });
  it("bounds scalar field traversal before invoking excess values or acquiring credentials", async () => {
    const data: Record<string, string> = {};
    for (let at = 0; at < 64; at++) data[`field${at}`] = "value";
    let excessRead = false, credentials = false;
    Object.defineProperty(data, "excess", {
      enumerable: true,
      get() {
        excessRead = true;
        throw new Error("Should not read excess metadata");
      },
    });
    await expect(
      client(async () => json(record()), {
        credentials: () => {
          credentials = true;
          return undefined;
        },
      }).createRecord([], { data }),
    ).rejects.toThrow("field count");
    expect(excessRead).toBe(false);
    expect(credentials).toBe(false);
    await expect(client(async () => json(record())).createRecord([], { data: { title: Number.MAX_VALUE } })).rejects
      .toThrow("scalar");
  });
  it("validates requested ranges and actual EOF before accepting their extent", async () => {
    const files = client(async (_input, init) => {
      expect(new Headers(init?.headers).get("Range")).toBe("bytes=1-3");
      return new Response("ell", { status: 206, headers: { "Content-Range": "bytes 1-3/6" } });
    });
    expect(new TextDecoder().decode(await files.read(id, name, { at: 1, length: 3 }))).toBe("ell");
    for (
      const response of [
        new Response("ell"),
        new Response("ell", { status: 206, headers: { "Content-Range": "bytes 2-4/6" } }),
        new Response("el", { status: 206, headers: { "Content-Range": "bytes 1-3/6" } }),
      ]
    ) {
      await expect(client(async () => response).read(id, name, { at: 1, length: 3 })).rejects.toThrow();
    }
  });
  it("refuses encoded, truncated and excess full bodies", async () => {
    for (
      const response of [
        new Response("hello", { headers: { "Content-Length": "6" } }),
        new Response("hello!!", { headers: { "Content-Length": "6" } }),
        new Response("x", { headers: { "Content-Encoding": "gzip" } }),
        new Response("x", { headers: { "Content-Length": "9007199254740993" } }),
      ]
    ) await expect(client(async () => response).read(id, name)).rejects.toThrow();
  });
  it("retains native terminal stream errors without duplicate cancellation errors", async () => {
    const failure = new Error("independent native read failure");
    const files = client(async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.error(failure);
          },
        }),
      )
    );
    await expect(files.read(id, name)).rejects.toBe(failure);
  });
  it("retires a rejected body and preserves independent cleanup failure", async () => {
    const cleanup = new Error("cleanup failure");
    const response = new Response(
      new ReadableStream({
        cancel() {
          throw cleanup;
        },
      }),
      { status: 302, headers: { Location: "https://foreign.invalid/?secret=capability" } },
    );
    try {
      await client(async () => response).download(id, name);
      throw new Error("Expected failure");
    } catch (reason) {
      expect(reason).toBeInstanceOf(AggregateError);
      expect((reason as AggregateError).errors).toContain(cleanup);
    }
  });
  it("preflights bytes/budgets and captures multipart inputs before awaited authorization", async () => {
    const source = new Uint8Array(bytes), part = { name: "local.txt", bytes: source }, data = { title: "before" };
    let credentials = 0;
    const files = client(async (_input, init) => {
      const body = init?.body as FormData;
      expect(body.get("title")).toBe("before");
      const blob = body.get("documents") as File;
      expect(blob.name).toBe("local.txt");
      expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
      return json(record());
    }, {
      credentials: async () => {
        credentials++;
        source.fill(0);
        part.name = "after.txt";
        data.title = "after";
        return "native-token";
      },
    });
    await files.createRecord([part], { data });
    expect(credentials).toBe(1);
    await expect(
      client(async () => json(record()), {
        maxBytes: 5,
        credentials: () => {
          credentials++;
          return undefined;
        },
      }).createRecord([{ name, bytes }]),
    ).rejects.toThrow();
    expect(credentials).toBe(1);
  });
  it("uses distinct native append/replacement/deletion operations without record-delete fallback", async () => {
    const seen: string[] = [];
    const files = client(async (_input, init) => {
      seen.push(init!.method!);
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (typeof init?.body === "string") expect(JSON.parse(init.body)).toEqual({ "documents-": [name] });
      else {
        const body = init?.body as FormData;
        expect([...body.keys()]).toEqual([seen.length === 1 ? "documents+" : "documents"]);
      }
      return json(record());
    });
    await files.uploadFiles(id, [{ name, bytes }], { mode: "append" });
    await files.uploadFiles(id, [{ name, bytes }], { mode: "replace" });
    await files.deleteFiles(id, [name]);
    await files.deleteRecord(id);
    expect(seen).toEqual(["PATCH", "PATCH", "PATCH", "DELETE"]);
  });
  it("captures each byte capability once and refuses lossy Unicode metadata before credentials", async () => {
    let reads = 0, credentials = 0;
    const part = {
      name: "input.txt",
      get bytes() {
        return ++reads === 1 ? bytes : new Uint8Array([0]);
      },
    };
    const files = client(async (_input, init) => {
      const blob = (init!.body as FormData).get("documents") as File;
      expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
      return json(record());
    }, {
      credentials: () => {
        credentials++;
        expect(reads).toBe(1);
        return undefined;
      },
    });
    await files.createRecord([part]);
    expect(reads).toBe(1);
    await expect(files.createRecord([], { data: { title: "\ud800" } })).rejects.toThrow("Unicode");
    expect(credentials).toBe(1);
  });
  it("requests file tokens explicitly and never fetches media or caches tokens automatically", async () => {
    let calls = 0;
    const files = client(async (input, init) => {
      calls++;
      expect(new URL(input.toString()).pathname).toBe("/api/files/token");
      expect(init?.method).toBe("POST");
      return json({ token: "file-token" });
    });
    expect(await files.fileToken()).toBe("file-token");
    expect(calls).toBe(1);
  });
  it("preserves native Bearer API spelling without admitting it as a query file token", async () => {
    let calls = 0;
    const files = client(async (_input, init) => {
      calls++;
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer native-token");
      return json({ token: "file-token" });
    }, { credentials: () => "Bearer native-token" });
    expect(await files.fileToken()).toBe("file-token");
    await expect(files.download(id, name, { token: "Bearer file-token" })).rejects.toThrow("token");
    expect(calls).toBe(1);
    await expect(
      client(async () => json(record()), { credentials: () => "Bearer native-token\r\nInjected: yes" }).getRecord(id),
    ).rejects.toThrow("authorization");
  });
  it("captures the protected token once rather than rereading a changing accessor", async () => {
    let reads = 0;
    const files = client(async (input) => {
      expect(new URL(input.toString()).searchParams.get("token")).toBe("first-token");
      return new Response("x");
    });
    const response = await files.download(id, name, {
      get token() {
        return ++reads === 1 ? "first-token" : "second-token";
      },
    });
    await response.bytes.cancel();
    expect(reads).toBe(1);
  });
  it("reports unknown mutation outcomes after invalid receipts or transport failures and never retries", async () => {
    const failure = new Error("wire failure");
    let calls = 0;
    for (
      const fetch of [async () => {
        calls++;
        throw failure;
      }, async () => {
        calls++;
        return json(record([], { id: "other" }));
      }]
    ) {
      await expect(client(fetch).uploadFiles(id, [{ name, bytes }], { mode: "replace" })).rejects.toBeInstanceOf(
        PocketbasePublicationError,
      );
    }
    expect(calls).toBe(2);
    await expect(client(async () => new Response(null, { status: 403 })).getRecord(id)).rejects.toBeInstanceOf(
      PocketbaseError,
    );
  });
  it("does not dispatch preaborted or zero-length reads and bounds materialization", async () => {
    let calls = 0;
    const aborted = AbortSignal.abort("stop");
    const files = client(async () => {
      calls++;
      return new Response(new Uint8Array(bytes), { headers: { "Content-Length": "6" } });
    }, { maxBytes: 5 });
    await expect(files.read(id, name, { signal: aborted })).rejects.toBe("stop");
    expect(await files.read(id, name, { at: 99, length: 0 })).toEqual(new Uint8Array());
    expect(calls).toBe(0);
    await expect(files.read(id, name)).rejects.toBeInstanceOf(RangeError);
    expect(calls).toBe(1);
  });
});
