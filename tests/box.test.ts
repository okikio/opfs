import { describe, it } from "node:test";
import { webcrypto } from "node:crypto";
import { expect } from "@std/expect";
import { BoxClient, BoxError, BoxPendingError, BoxPublicationError } from "../src/box.ts";
import type { BoxPartType, BoxUploadType } from "../src/box.ts";
import type { FetchType } from "../src/request.ts";

const abc = "a9993e364706816aba3e25717850c26c9cd0d89d";
const abcdef = "1f8ac10f23c5b5bc1167bda84b833e5c057a77d2";
const def = "589c22335a381f122d129225f5c0ba3056ed5811";
const resource = (overrides: Record<string, unknown> = {}) => ({
  type: "file",
  id: "123",
  name: "note.txt",
  size: 3,
  sha1: abc,
  file_version: { id: "987" },
  parent: { id: "0" },
  ...overrides,
});
const receipt = (overrides: Record<string, unknown> = {}, status = 201) =>
  Response.json({ total_count: 1, entries: [resource(overrides)] }, { status });
const body = () => new TextEncoder().encode("abc");
const target = { kind: "create", folderId: "0", name: "note.txt" } as const;
const client = (fetch: FetchType, options = {}) => new BoxClient({ token: () => "secret", fetch, ...options });
const base = "https://upload.box.com/api/2.0/files/upload_sessions/SESSION";
const upload: BoxUploadType = {
  id: "SESSION",
  size: 6,
  partSize: 3,
  totalParts: 2,
  expires: "2026-11-07T00:00:00Z",
  target,
  endpoint: base,
};
const part1: BoxPartType = { id: "PART1", offset: 0, size: 3, sha1: abc };
const part2: BoxPartType = { id: "PART2", offset: 3, size: 3, sha1: def };
const wire = (part: BoxPartType) => ({ part_id: part.id, offset: part.offset, size: part.size, sha1: part.sha1 });
const session = (overrides: Record<string, unknown> = {}) => ({
  id: "SESSION",
  type: "upload_session",
  session_expires_at: upload.expires,
  part_size: 3,
  total_parts: 2,
  num_parts_processed: 0,
  session_endpoints: {
    upload_part: base,
    status: base,
    abort: base,
    commit: `${base}/commit`,
    list_parts: `${base}/parts`,
  },
  ...overrides,
});

describe("Box native identity and authority", () => {
  it("has no construction effects and keeps precision-safe IDs/version fields", async () => {
    let calls = 0;
    const files = client((input, init) => {
      calls++;
      const url = new URL(String(input));
      expect(url.pathname).toBe("/2.0/files/123");
      expect(url.searchParams.get("fields")).toContain("file_version");
      expect(new Headers(init?.headers).get("as-user")).toBe("999");
      return Promise.resolve(Response.json(resource()));
    }, { asUser: "999" });
    expect(calls).toBe(0);
    expect(await files.statFile("123")).toEqual({
      id: "123",
      kind: "file",
      name: "note.txt",
      size: 3,
      sha1: abc,
      parentId: "0",
      versionId: "987",
    });
    await expect(files.statFile("../123")).rejects.toThrow("ID");
    expect(calls).toBe(1);
    await expect(client(() => Promise.resolve(Response.json(resource({ id: "456" })))).statFile("123")).rejects.toThrow(
      "selected",
    );
  });
  it("uses marker pages with bounds and never fabricates paths for web links", async () => {
    let calls = 0;
    const files = client((input) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("usemarker")).toBe("true");
      expect(url.searchParams.has("offset")).toBe(false);
      return Promise.resolve(
        Response.json({
          entries: [{ id: "5", type: "web_link", name: "site" }],
          next_marker: calls++ === 0 ? "next" : null,
        }),
      );
    });
    const found = [];
    for await (const item of files.list("0")) found.push(item);
    expect(found.map((item) => item.kind)).toEqual(["web_link", "web_link"]);
    const loop = client(() => Promise.resolve(Response.json({ entries: [], next_marker: "same" })));
    await expect(loop.list("0").next()).rejects.toThrow("repeated");
    const bound = client(() => Promise.resolve(Response.json({ entries: [], next_marker: "more" })), { maxPages: 1 });
    await expect(bound.list("0").next()).rejects.toThrow("page budget");
  });
  it("pins version routes and strips OAuth/account headers across every capability hop", async () => {
    const tokens: string[] = [];
    let hop = 0;
    const files = new BoxClient({
      token: (url) => {
        tokens.push(url.href);
        return "secret";
      },
      asUser: "999",
      downloadOrigins: ["https://api.box.com", "https://dl.boxcloud.com"],
      fetch: (input, init) => {
        const url = new URL(String(input)), headers = new Headers(init?.headers);
        if (url.pathname.endsWith("/versions/987")) {
          return Promise.resolve(Response.json({ type: "file_version", id: "987", size: 3, sha1: abc }));
        }
        if (url.pathname === "/2.0/files/123/content") {
          expect(url.searchParams.get("version")).toBe("987");
          expect(headers.get("authorization")).toBe("Bearer secret");
          return Promise.resolve(
            new Response(null, { status: 302, headers: { location: "https://api.box.com/capability?secret=one" } }),
          );
        }
        expect(headers.has("authorization")).toBe(false);
        expect(headers.has("as-user")).toBe(false);
        expect(headers.get("range")).toBe("bytes=1-2");
        if (hop++ === 0) {
          return Promise.resolve(
            new Response(null, { status: 302, headers: { location: "https://dl.boxcloud.com/capability?secret=two" } }),
          );
        }
        return Promise.resolve(new Response("bc", { status: 206, headers: { "content-range": "bytes 1-2/3" } }));
      },
    });
    expect(new TextDecoder().decode(await files.read("123", { versionId: "987", at: 1, length: 2 }))).toBe("bc");
    expect(tokens.length).toBe(2);
    expect(tokens.every((url) => !url.includes("secret="))).toBe(true);
  });
  it("rejects ungranted/looped capability URLs and preserves exact extent evidence", async () => {
    const untrusted = client((input) =>
      Promise.resolve(
        new URL(String(input)).pathname.endsWith("/content")
          ? new Response(null, { status: 302, headers: { location: "https://evil.test/?secret=do-not-print" } })
          : Response.json(resource()),
      )
    );
    await expect(untrusted.read("123")).rejects.toThrow("admitted authority");
    const repeated = client(
      (input) =>
        Promise.resolve(
          new URL(String(input)).pathname.endsWith("/123")
            ? Response.json(resource())
            : new Response(null, { status: 302, headers: { location: "https://dl.boxcloud.com/same" } }),
        ),
      { downloadOrigins: ["https://dl.boxcloud.com"] },
    );
    await expect(repeated.read("123")).rejects.toThrow("repeats");
    const ignored = client((input) =>
      Promise.resolve(
        new URL(String(input)).pathname.endsWith("/123") ? Response.json(resource()) : new Response("abc"),
      )
    );
    await expect(ignored.read("123", { at: 1, length: 2 })).rejects.toThrow("206");
  });
  it("detects actual truncated/extra bytes and rejects pending downloads explicitly", async () => {
    for (const content of ["ab", "abcd"]) {
      const files = client((input) =>
        Promise.resolve(
          new URL(String(input)).pathname.endsWith("/123") ? Response.json(resource()) : new Response(content),
        )
      );
      await expect(files.read("123")).rejects.toThrow(content.length < 3 ? "truncated" : "exceeds");
    }
    const pending = client((input) =>
      Promise.resolve(
        new URL(String(input)).pathname.endsWith("/123")
          ? Response.json(resource())
          : new Response(null, { status: 202, headers: { "retry-after": "5" } }),
      )
    );
    await expect(pending.read("123")).rejects.toBeInstanceOf(BoxPendingError);
  });
  it("cancels failed range bodies and idle streams without replacing primary errors", async () => {
    const cleanup = new Error("cleanup failed");
    let cancelled = 0;
    const files = client((input) =>
      Promise.resolve(
        new URL(String(input)).pathname.endsWith("/123") ? Response.json(resource()) : new Response(
          new ReadableStream({
            cancel() {
              cancelled++;
              throw cleanup;
            },
          }),
        ),
      )
    );
    try {
      await files.download("123", { at: 1, length: 2 });
      throw new Error("missing failure");
    } catch (reason) {
      expect(reason).toBeInstanceOf(AggregateError);
      expect((reason as AggregateError).errors).toContain(cleanup);
      expect(String((reason as AggregateError).errors[0])).toContain("206");
    }
    expect(cancelled).toBe(1);
    const controller = new AbortController();
    const idle = client((input) =>
      Promise.resolve(
        new URL(String(input)).pathname.endsWith("/123") ? Response.json(resource()) : new Response(
          new ReadableStream({
            cancel() {
              cancelled++;
            },
          }),
        ),
      )
    );
    const opened = await idle.download("123", { signal: controller.signal });
    controller.abort(new Error("stop"));
    await expect(new Response(opened.bytes).text()).rejects.toThrow();
    expect(cancelled).toBe(2);
  });
  it("refuses pre-aborted operations before credentials and retires bounded control bodies", async () => {
    let tokens = 0, cancelled = 0;
    const files = new BoxClient({
      token: () => {
        tokens++;
        return "secret";
      },
      fetch: () =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              pull(controller) {
                controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
              },
              cancel() {
                cancelled++;
              },
            }),
          ),
        ),
    });
    const controller = new AbortController();
    controller.abort(new Error("pre-aborted"));
    await expect(files.statFile("123", controller.signal)).rejects.toThrow("pre-aborted");
    expect(tokens).toBe(0);
    await expect(files.statFile("123")).rejects.toThrow("control body");
    expect(tokens).toBe(1);
    expect(cancelled).toBe(1);
  });
});

describe("Box native upload publication", () => {
  it("owns multipart bytes/target before OAuth and preserves attributes-before-file order", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const selected = { kind: "create" as const, folderId: "0", name: "note.txt" }, bytes = body();
    const files = new BoxClient({
      token: async () => {
        await gate;
        return "secret";
      },
      fetch: async (_input, init) => {
        const form = init?.body as FormData;
        expect([...form.keys()]).toEqual(["attributes", "file"]);
        expect(JSON.parse(String(form.get("attributes")))).toEqual({ name: "note.txt", parent: { id: "0" } });
        expect(await (form.get("file") as Blob).text()).toBe("abc");
        expect(new Headers(init?.headers).get("content-md5")).toBe(abc);
        return receipt();
      },
    });
    const pending = files.upload(selected, bytes, { sha1: abc });
    selected.name = "other";
    bytes.fill(0);
    release();
    expect((await pending).id).toBe("123");
    const replacement = client((_input, init) => {
      expect(new Headers(init?.headers).get("if-match")).toBe("native-etag");
      return Promise.resolve(receipt({}, 200));
    });
    expect(
      (await replacement.upload({ kind: "replace", fileId: "123", ifMatch: "native-etag" }, body(), {
        name: "note.txt",
      })).id,
    ).toBe("123");
  });
  it("refuses native-byte budget bypass and never retries unknown upload outcomes", async () => {
    let calls = 0;
    const bytes = body();
    Object.defineProperty(bytes, "byteLength", { value: 0 });
    await expect(
      client(() => {
        throw new Error("unexpected fetch");
      }, { maxBytes: 2 }).upload(target, bytes),
    ).rejects.toThrow("budget");
    const files = client(() => {
      calls++;
      return Promise.reject(new Error("lost response"));
    }, { request: { retries: 4 } });
    await expect(files.upload(target, body())).rejects.toBeInstanceOf(BoxPublicationError);
    expect(calls).toBe(1);
    await expect(client(() => Promise.resolve(receipt({ size: 4 }))).upload(target, body())).rejects.toBeInstanceOf(
      BoxPublicationError,
    );
    await expect(
      client(() => Promise.resolve(receipt({ id: "456" }, 200))).upload({ kind: "replace", fileId: "123" }, body(), {
        name: "note.txt",
      }),
    ).rejects.toBeInstanceOf(BoxPublicationError);
  });
  it("validates every session endpoint before any follow-up credential grant", async () => {
    let tokens = 0;
    const files = new BoxClient({
      token: () => {
        tokens++;
        return "secret";
      },
      fetch: () =>
        Promise.resolve(
          Response.json(
            session({
              session_endpoints: {
                upload_part: base,
                status: base,
                abort: base,
                commit: "https://evil.test/api/2.0/files/upload_sessions/SESSION/commit",
                list_parts: `${base}/parts`,
              },
            }),
            { status: 201 },
          ),
        ),
    });
    await expect(files.startUpload(target, 6)).rejects.toBeInstanceOf(BoxPublicationError);
    expect(tokens).toBe(1);
    await expect(files.statusUpload({ ...upload, endpoint: base.replace("SESSION", "OTHER") })).rejects.toThrow("ID");
    expect(tokens).toBe(1);
    const valid = client(() => Promise.resolve(Response.json(session(), { status: 201 })));
    expect(await valid.startUpload(target, 6)).toEqual(upload);
  });
  it("keeps processing count separate from native noncontiguous part extents", async () => {
    const files = client((input) =>
      Promise.resolve(
        new URL(String(input)).pathname.endsWith("/parts")
          ? Response.json({ entries: [wire(part2)], offset: 0, limit: 1000, total_count: 1 })
          : Response.json(session({ num_parts_processed: 1 })),
      )
    );
    expect((await files.statusUpload(upload)).processedParts).toBe(1);
    expect(await files.listParts(upload)).toEqual([part2]);
    await expect(
      client(() =>
        Promise.resolve(
          Response.json({
            entries: [wire(part1), wire({ ...part1, id: "duplicate" })],
            offset: 0,
            limit: 1000,
            total_count: 2,
          }),
        )
      ).listParts(upload),
    ).rejects.toThrow("overlap");
  });
  it("hashes owned part bytes and validates full part receipts before acknowledging", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bytes = body();
    const subtle = {
      async digest(algorithm: AlgorithmIdentifier, value: BufferSource): Promise<ArrayBuffer> {
        await gate;
        return await webcrypto.subtle.digest(
          algorithm,
          new Uint8Array(
            value instanceof ArrayBuffer ? value : new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
          ),
        );
      },
    };
    const files = client(async (_input, init) => {
      expect(new Headers(init?.headers).get("digest")).toBe("sha=qZk+NkcGgWq6PiVxeFDCbJzQ2J0=");
      expect(new Headers(init?.headers).get("content-range")).toBe("bytes 0-2/6");
      expect(await new Response(init?.body).text()).toBe("abc");
      return Response.json({ part: wire(part1) });
    });
    const pending = files.uploadPart(upload, 0, bytes, { subtle });
    bytes.fill(0);
    release();
    expect(await pending).toEqual(part1);
    await expect(files.uploadPart(upload, 1, body(), { subtle })).rejects.toThrow("alignment");
    await expect(
      client(() => Promise.resolve(Response.json({ part: wire({ ...part1, sha1: def }) }))).uploadPart(
        upload,
        0,
        body(),
        { subtle: webcrypto.subtle },
      ),
    ).rejects.toBeInstanceOf(BoxPublicationError);
  });
  it("requires complete parts and whole-file digest, with pending202 distinct from publication", async () => {
    let calls = 0;
    const files = client((_input, init) => {
      calls++;
      expect(new Headers(init?.headers).get("digest")).toBe("sha=H4rBDyPFtbwRZ72oS4M+XAV6d9I=");
      const parsed = JSON.parse(String(init?.body));
      expect(parsed.parts.map((part: { offset: number }) => part.offset)).toEqual([0, 3]);
      return Promise.resolve(
        calls === 1
          ? new Response(null, { status: 202, headers: { "retry-after": "3" } })
          : receipt({ size: 6, sha1: abcdef }),
      );
    });
    await expect(files.commitUpload(upload, [part1], { sha1: abcdef })).rejects.toThrow("complete");
    expect(calls).toBe(0);
    expect(await files.commitUpload(upload, [part2, part1], { sha1: abcdef })).toEqual({
      complete: false,
      retryAfterSeconds: 3,
    });
    expect(calls).toBe(1);
    expect((await files.commitUpload(upload, [part1, part2], { sha1: abcdef })).complete).toBe(true);
    await expect(
      client(() => Promise.resolve(new Response(null, { status: 202, headers: { "retry-after": "99999999" } })))
        .commitUpload(upload, [part1, part2], { sha1: abcdef }),
    ).rejects.toBeInstanceOf(BoxPublicationError);
  });
  it("snapshots the complete commit list before token awaits and keeps abort explicit", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const part = { ...part1 }, parts = [part, part2];
    const files = new BoxClient({
      token: async () => {
        await gate;
        return "secret";
      },
      fetch: (_input, init) => {
        expect(JSON.parse(String(init?.body)).parts[0].part_id).toBe("PART1");
        return Promise.resolve(receipt({ size: 6, sha1: abcdef }));
      },
    });
    const pending = files.commitUpload(upload, parts, { sha1: abcdef });
    part.id = "changed";
    parts.length = 0;
    release();
    expect((await pending).complete).toBe(true);
    await client((_input, init) => {
      expect(init?.method).toBe("DELETE");
      return Promise.resolve(new Response(null, { status: 204 }));
    }).abortUpload(upload);
    await expect(client(() => Promise.resolve(new Response(null, { status: 404 }))).abortUpload(upload)).rejects
      .toBeInstanceOf(BoxError);
  });
});
