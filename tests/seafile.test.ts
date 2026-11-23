import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { SeafileClient, SeafileError } from "../src/seafile.ts";
import type { FetchType } from "../src/request.ts";
const origin = "https://seafile.example.test";
const library = "c854e71b-cf14-46b3-9353-e675c131a5d7";
const metadata = { id: library, name: "fixture", encrypted: false, permission: "rw", head_commit_id: "native-head" };
const link = `${origin}/seafhttp/files/secret/file.bin`;
const upload = `${origin}/seafhttp/upload-api/secret`;
function client(fetch: FetchType, options: { maxBytes?: number } = {}): SeafileClient {
  return new SeafileClient({
    endpoint: origin,
    library,
    token: "user-token",
    fetch,
    downloadGrants: [{ origin, prefix: "/seafhttp/" }],
    uploadGrants: [{ origin, prefix: "/seafhttp/" }],
    ...options,
  });
}
function isLibrary(input: RequestInfo | URL): boolean {
  return new URL(String(input)).pathname === `/api2/repos/${library}/`;
}

describe("Seafile native library and capability profile", () => {
  it("isolates native API credentials from same-origin download capabilities and redirects", async () => {
    let data = 0;
    const files = client(async (input, init) => {
      const url = new URL(String(input)), headers = new Headers(init?.headers);
      expect(init?.redirect).toBe("manual");
      expect(init?.credentials).toBe("omit");
      if (url.pathname.startsWith("/api")) {
        expect(headers.get("authorization")).toBe("Token user-token");
        return Response.json(isLibrary(input) ? metadata : link);
      }
      expect(headers.has("authorization")).toBe(false);
      expect(headers.get("range")).toBe("bytes=1-2");
      if (data++ === 0) {
        return new Response(null, { status: 302, headers: { location: "/seafhttp/files/second/file.bin" } });
      }
      return new Response(new Uint8Array([2, 3]), {
        status: 206,
        headers: { "content-range": "bytes 1-2/3", "content-length": "2" },
      });
    });
    expect(await files.read("/file.bin", { at: 1, length: 2 })).toEqual(new Uint8Array([2, 3]));
    expect(data).toBe(2);
  });
  it("refuses ungranted origins and path aliases without data requests", async () => {
    for (
      const target of [
        "https://foreign.example/seafhttp/file",
        `${origin}/api2/private`,
        `${origin}/seafhttp/%2fapi2/private`,
      ]
    ) {
      let data = 0;
      const files = client(async (input) => {
        if (!new URL(String(input)).pathname.startsWith("/api")) data++;
        return Response.json(isLibrary(input) ? metadata : target);
      });
      await expect(files.read("/file.bin")).rejects.toBeInstanceOf(TypeError);
      expect(data).toBe(0);
    }
  });
  it("snapshots upload bytes and replace intent before credentials and returns actual collision name", async () => {
    const bytes = new Uint8Array([1, 2, 3]), options = { replace: false };
    const files = new SeafileClient({
      endpoint: origin,
      library,
      token: async () => {
        bytes.fill(9);
        options.replace = true;
        return "token";
      },
      uploadGrants: [{ origin, prefix: "/seafhttp/" }],
      fetch: async (input, init) => {
        if (isLibrary(input)) return Response.json(metadata);
        const url = new URL(String(input));
        if (url.pathname.startsWith("/api")) {
          expect(url.searchParams.get("replace")).toBe("0");
          return Response.json(upload);
        }
        expect(new Headers(init?.headers).has("authorization")).toBe(false);
        const form = init?.body as FormData;
        expect(form.get("replace")).toBe("0");
        expect(form.get("parent_dir")).toBe("/");
        expect(new Uint8Array(await (form.get("file") as Blob).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
        return Response.json([{ id: "native-id", name: "file (1).bin", size: 3 }]);
      },
    });
    expect(await files.upload("/", "file.bin", bytes, options)).toEqual({
      id: "native-id",
      name: "file (1).bin",
      parent: "/",
      size: 3,
    });
  });
  it("refuses encrypted libraries before links and leaves metadata inspectable", async () => {
    let calls = 0;
    const files = client(async (input) => {
      calls++;
      expect(isLibrary(input)).toBe(true);
      return Response.json({ ...metadata, encrypted: true });
    });
    expect((await files.getLibrary()).encrypted).toBe(true);
    await expect(files.read("/file.bin")).rejects.toBeInstanceOf(TypeError);
    await expect(files.upload("/", "file.bin", new Uint8Array([1]))).rejects.toBeInstanceOf(TypeError);
    expect(calls).toBe(3);
  });
  it("validates complete one-directory listing and refuses duplicate or escaped children", async () => {
    const entry = { id: "native", name: "file.bin", parent_dir: "/", type: "file", size: 3 };
    for (const list of [[entry, entry], [{ ...entry, name: "../file" }], [{ ...entry, parent_dir: "/other" }]]) {
      const files = client(async (input) => Response.json(isLibrary(input) ? metadata : { dirent_list: list }));
      await expect(files.list()).rejects.toThrow();
    }
    const files = client(async (input) => Response.json(isLibrary(input) ? metadata : { dirent_list: [entry] }));
    expect((await files.list())[0]).toMatchObject({ kind: "file", size: 3, name: "file.bin" });
  });
  it("rejects wrong-size and unsafe-name receipts as unknown publication", async () => {
    for (
      const receipt of [{ id: "native", name: "file.bin", size: 2 }, { id: "native", name: "../file.bin", size: 3 }]
    ) {
      const files = client(async (input) =>
        Response.json(
          isLibrary(input) ? metadata : new URL(String(input)).pathname.startsWith("/api") ? upload : [receipt],
        )
      );
      await expect(files.upload("/", "file.bin", new Uint8Array([1, 2, 3]))).rejects.toMatchObject({
        outcome: "unknown",
        requestedName: "file.bin",
        parent: "/",
        library,
      });
    }
  });
  it("does not replay dispatched uploads and preserves the primary transport error", async () => {
    let writes = 0;
    const reason = new Error("ack lost");
    const files = client(async (input) => {
      if (isLibrary(input)) return Response.json(metadata);
      if (new URL(String(input)).pathname.startsWith("/api")) return Response.json(upload);
      writes++;
      throw reason;
    });
    await expect(files.upload("/", "file.bin", new Uint8Array([1]))).rejects.toMatchObject({
      name: "SeafilePublicationError",
      cause: reason,
    });
    expect(writes).toBe(1);
  });
  it("retains known API status without forwarding credentials to a redirect", async () => {
    const files = client(async () => new Response(null, { status: 403 }));
    await expect(files.getLibrary()).rejects.toBeInstanceOf(SeafileError);
  });
  it("refuses lossy or duplicate numeric authority fields before schema selection", async () => {
    for (const size of ["9007199254740991.1", "1e-324", '3,"size":2']) {
      const files = client(async (input) =>
        isLibrary(input) ? Response.json(metadata) : new Response(
          `{"type":"file","repo_id":"${library}","parent_dir":"/","obj_name":"file.bin","obj_id":"native","size":${size}}`,
        )
      );
      await expect(files.stat("/file.bin")).rejects.toBeInstanceOf(TypeError);
    }
  });
  it("admits bounds, path profile and abort before any token request", async () => {
    let tokens = 0;
    const files = new SeafileClient({
      endpoint: origin,
      library,
      token: () => {
        tokens++;
        return "token";
      },
      maxBytes: 1,
    });
    await expect(files.upload("/", "file.bin", new Uint8Array([1, 2]))).rejects.toBeInstanceOf(RangeError);
    await expect(files.read("/../file.bin")).rejects.toBeInstanceOf(TypeError);
    await expect(files.read("/file.bin", { at: -1 })).rejects.toBeInstanceOf(RangeError);
    const controller = new AbortController(), reason = new Error("cancelled");
    controller.abort(reason);
    await expect(files.getLibrary({ signal: controller.signal })).rejects.toBe(reason);
    expect(await files.read("/file.bin", { length: 0 })).toEqual(new Uint8Array());
    expect(tokens).toBe(0);
  });
  it("validates body extent and preserves native read rejection identity", async () => {
    for (const body of [new Uint8Array([1]), new Uint8Array([1, 2, 3])]) {
      const files = client(async (input) => {
        if (isLibrary(input)) return Response.json(metadata);
        if (new URL(String(input)).pathname.startsWith("/api")) return Response.json(link);
        return new Response(body, { headers: { "content-length": "2" } });
      });
      await expect(files.read("/file.bin")).rejects.toThrow();
    }
    const reason = new Error("read failed");
    const files = client(async (input) =>
      isLibrary(input)
        ? Response.json(metadata)
        : new URL(String(input)).pathname.startsWith("/api")
        ? Response.json(link)
        : new Response(
          new ReadableStream({
            pull() {
              throw reason;
            },
          }),
          { headers: { "content-length": "3" } },
        )
    );
    await expect(files.read("/file.bin")).rejects.toBe(reason);
  });
  it("retires rejected ranges and bounds materialization without consuming the whole body", async () => {
    let cancelled = 0;
    const files = client(async (input) => {
      if (isLibrary(input)) return Response.json(metadata);
      if (new URL(String(input)).pathname.startsWith("/api")) return Response.json(link);
      return new Response(
        new ReadableStream({
          cancel() {
            cancelled++;
          },
        }, { highWaterMark: 0 }),
        { headers: { "content-length": "3" } },
      );
    }, { maxBytes: 1 });
    await expect(files.read("/file.bin")).rejects.toBeInstanceOf(RangeError);
    await expect(files.download("/file.bin", { at: 1, length: 1 })).rejects.toThrow();
    expect(cancelled).toBe(2);
  });
});
