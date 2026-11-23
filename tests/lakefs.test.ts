import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { LakefsClient, LakefsError } from "../src/lakefs.ts";

const endpoint = "https://lakefs.example.test/prefix/";
const native = { path: "a/b?c", path_type: "object", size_bytes: 3, checksum: "native-etag", mtime: 2 };
const publication = { id: "commit1", parents: ["parent1"], message: "save", committer: "fixture", creation_date: 3 };

describe("native lakeFS repository operations", () => {
  it("keeps literal ref and object names distinct from transport paths and ignores physical addresses", async () => {
    const client = new LakefsClient({
      endpoint,
      repository: "repo",
      credentials: (url) => {
        expect(url.pathname).toBe("/prefix/api/v1/repositories/repo/refs/a%2Fb/objects/stat");
        return "Basic authority";
      },
      fetch: async (input, init) => {
        expect(new URL(String(input)).searchParams.get("path")).toBe("a/b?c");
        expect(new URL(String(input)).searchParams.get("presign")).toBe("false");
        expect(init?.redirect).toBe("manual");
        expect(init?.credentials).toBe("omit");
        return Response.json({ ...native, physical_address: "https://secret.example/?token=do-not-return" });
      },
    });
    expect(await client.stat("a/b", native.path)).toEqual({
      path: native.path,
      kind: "object",
      size: 3,
      checksum: "native-etag",
      modified: 2000,
    });
  });
  it("snapshots staging bytes, target and conditions before awaited credentials", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const options = { ifNoneMatch: "*" as const };
    const client = new LakefsClient({
      endpoint,
      repository: "repo",
      credentials: async () => {
        bytes.fill(9);
        Object.assign(options, { ifNoneMatch: "replaced" });
        return "Bearer token";
      },
      fetch: async (_input, init) => {
        expect(new Uint8Array(await new Response(init?.body).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
        expect(new Headers(init?.headers).get("if-none-match")).toBe("*");
        return Response.json(native, { status: 201 });
      },
    });
    expect((await client.put("main", native.path, bytes, options)).size).toBe(3);
  });
  it("retains staging identity when success names different bytes or a different object", async () => {
    for (const response of [{ ...native, size_bytes: 2 }, { ...native, path: "different" }]) {
      const client = new LakefsClient({
        endpoint,
        repository: "repo",
        fetch: async () => Response.json(response, { status: 201 }),
      });
      await expect(client.put("main", native.path, new Uint8Array([1, 2, 3]))).rejects.toMatchObject({
        name: "LakefsPublicationError",
        operation: "stage",
        ref: "main",
        path: native.path,
        outcome: "unknown",
      });
    }
  });
  it("does not replay dispatched mutations or infer failed commits are absent", async () => {
    let calls = 0;
    const reason = new Error("lost acknowledgement");
    const client = new LakefsClient({
      endpoint,
      repository: "repo",
      policy: { retries: 3 },
      fetch: async () => {
        calls++;
        throw reason;
      },
    });
    await expect(client.commit("main", "save")).rejects.toMatchObject({
      operation: "commit",
      cause: reason,
      outcome: "unknown",
    });
    expect(calls).toBe(1);
  });
  it("keeps known native write-condition refusals separate from uncertain publication", async () => {
    const client = new LakefsClient({
      endpoint,
      repository: "repo",
      fetch: async () => new Response(null, { status: 412 }),
    });
    await expect(client.put("main", native.path, new Uint8Array([1]), { ifNoneMatch: "*" })).rejects.toBeInstanceOf(
      LakefsError,
    );
  });
  it("rejects injection, invalid byte ranges and pre-abort before credentials", async () => {
    let tokens = 0;
    const client = new LakefsClient({
      endpoint,
      repository: "repo",
      credentials: () => {
        tokens++;
        return "token";
      },
    });
    await expect(client.stat("..", native.path)).rejects.toThrow();
    await expect(client.stat("main", "\ud800")).rejects.toThrow();
    await expect(client.read("main", native.path, { at: -1 })).rejects.toThrow();
    await expect(client.put("main", native.path, new Uint8Array([1]), { ifMatch: "a" as never }))
      .rejects
      .toThrow();
    const reason = new Error("aborted");
    const controller = new AbortController();
    controller.abort(reason);
    await expect(client.commit("main", "save", { signal: controller.signal })).rejects.toBe(reason);
    expect(tokens).toBe(0);
  });
  it("validates native range headers and actual EOF, including final read failures", async () => {
    for (const body of [new Uint8Array([2]), new Uint8Array([2, 3, 4])]) {
      const client = new LakefsClient({
        endpoint,
        repository: "repo",
        fetch: async () =>
          new Response(body, {
            status: 206,
            headers: { "content-range": "bytes 1-2/3", "content-length": "2" },
          }),
      });
      await expect(client.read("main", native.path, { at: 1, length: 2 })).rejects.toThrow();
    }
    const failure = new Error("native read failure");
    const client = new LakefsClient({
      endpoint,
      repository: "repo",
      fetch: async () =>
        new Response(
          new ReadableStream({
            pull() {
              throw failure;
            },
          }),
          { headers: { "content-length": "3" } },
        ),
    });
    await expect(client.read("main", native.path)).rejects.toBe(failure);
  });
  it("retires ignored ranges and redirects without following credential authority", async () => {
    for (const status of [200, 302]) {
      let cancelled = 0, calls = 0;
      const client = new LakefsClient({
        endpoint,
        repository: "repo",
        fetch: async () => {
          calls++;
          return new Response(
            new ReadableStream({
              cancel() {
                cancelled++;
              },
            }, { highWaterMark: 0 }),
            {
              status,
              headers: { location: "https://other.example/secret", "content-length": "3" },
            },
          );
        },
      });
      await expect(client.download("main", native.path, { at: 1, length: 1 })).rejects.toThrow();
      expect(calls).toBe(1);
      expect(cancelled).toBe(1);
    }
  });
  it("keeps byte cancellation caller-owned and refuses materialization beyond policy", async () => {
    let cancelled = 0;
    const client = new LakefsClient({
      endpoint,
      repository: "repo",
      maxBytes: 2,
      fetch: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled++;
            },
          }, { highWaterMark: 0 }),
          { headers: { "content-length": "3" } },
        ),
    });
    await expect(client.read("main", native.path)).rejects.toBeInstanceOf(RangeError);
    expect(cancelled).toBe(1);
    const result = await client.download("main", native.path);
    await result.bytes.cancel();
    expect(cancelled).toBe(2);
  });
  it("validates page limits, duplicate paths and continuation progress", async () => {
    for (
      const data of [
        { results: [native, native], pagination: { has_more: false, next_offset: "" } },
        { results: [native], pagination: { has_more: true, next_offset: "cursor" } },
        {
          results: [{ ...native, size_bytes: Number.MAX_SAFE_INTEGER + 1 }],
          pagination: { has_more: false, next_offset: "" },
        },
      ]
    ) {
      const client = new LakefsClient({ endpoint, repository: "repo", fetch: async () => Response.json(data) });
      await expect(client.listPage("main", { cursor: "cursor" })).rejects.toThrow();
    }
  });
  it("refuses lossy numeric lexemes and duplicate authority fields before schema selection", async () => {
    for (
      const raw of [
        '{"path":"a/b?c","path_type":"object","size_bytes":9007199254740991.1,"checksum":"x"}',
        '{"path":"a/b?c","path_type":"object","size_bytes":1e-324,"checksum":"x"}',
        '{"path":"a/b?c","path_type":"object","size_bytes":3,"size_bytes":2,"checksum":"x"}',
        '{"path":"a/b?c","path_type":"object","size_bytes":3,"checksum":"x","__proto__":{}}',
      ]
    ) {
      const client = new LakefsClient({ endpoint, repository: "repo", fetch: async () => new Response(raw) });
      await expect(client.stat("main", native.path)).rejects.toBeInstanceOf(TypeError);
    }
  });
  it("accepts the native plain branch receipt and preserves failed control-body reads", async () => {
    const branch = new LakefsClient({
      endpoint,
      repository: "repo",
      fetch: async () => new Response("native-reference", { status: 201 }),
    });
    expect(await branch.createBranch("new", "source")).toBe("native-reference");
    const reason = new Error("metadata transport failed");
    const client = new LakefsClient({
      endpoint,
      repository: "repo",
      fetch: async () =>
        new Response(
          new ReadableStream({
            pull() {
              throw reason;
            },
          }),
        ),
    });
    await expect(client.stat("main", native.path)).rejects.toBe(reason);
  });
  it("returns commits independently of staged upload receipts and validates ref attribution", async () => {
    const client = new LakefsClient({
      endpoint,
      repository: "repo",
      fetch: async (_input, init) => Response.json(publication, { status: init?.method === "POST" ? 201 : 200 }),
    });
    expect(await client.commit("main", "save")).toEqual({
      id: "commit1",
      parents: ["parent1"],
      message: "save",
      committer: "fixture",
      created: 3000,
    });
    expect((await client.getCommit("commit1")).id).toBe("commit1");
    await expect(client.getCommit("different")).rejects.toThrow();
  });
});
