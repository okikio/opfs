import { describe, it } from "node:test";
import { webcrypto } from "node:crypto";
import { runInNewContext } from "node:vm";
import { expect } from "@std/expect";
import { contentHash, DropboxClient, DropboxError, DropboxPublicationError } from "../src/dropbox.ts";
import type { FetchType } from "../src/request.ts";

const rev = "abcdef012345";
const resource = (overrides: Record<string, unknown> = {}) => ({
  name: "note.txt",
  id: "id:one",
  rev,
  size: 3,
  ...overrides,
});
const client = (fetch: FetchType, options = {}) => new DropboxClient({ token: () => "secret", fetch, ...options });
const download = (
  body: BodyInit | null = "abc",
  metadata = resource(),
  headers: Record<string, string> = {},
  status = 200,
) => new Response(body, { status, headers: { "Dropbox-API-Result": JSON.stringify(metadata), ...headers } });
const target = { path: "/note.txt", mode: "add" } as const;
const bytes = () => new TextEncoder().encode("abc");

describe("Dropbox native metadata and authority", () => {
  it("has no construction effects and snapshots explicit account headers", async () => {
    let calls = 0;
    const options = { namespaceId: "123", selectUser: "dbmid:person" };
    const files = client((input, init) => {
      calls++;
      expect(String(input)).toBe("https://api.dropboxapi.com/2/files/get_metadata");
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer secret");
      expect(headers.get("Dropbox-API-Path-Root")).toBe('{".tag":"namespace_id","namespace_id":"123"}');
      expect(headers.get("Dropbox-API-Select-User")).toBe("dbmid:person");
      expect(init?.redirect).toBe("manual");
      return Promise.resolve(Response.json({ ".tag": "file", ...resource() }));
    }, options);
    options.namespaceId = "999";
    expect(calls).toBe(0);
    expect(await files.stat("id:one")).toEqual({ kind: "file", name: "note.txt", id: "id:one", rev, size: 3 });
    await expect(files.stat("id:other")).rejects.toThrow("another");
    expect(calls).toBe(2);
  });
  it("uses ASCII header JSON and never URL arguments, including Unicode names", async () => {
    const files = client((input, init) => {
      expect(new URL(String(input)).search).toBe("");
      const arg = new Headers(init?.headers).get("Dropbox-API-Arg")!;
      expect(arg).toContain("\\u00e9");
      expect(arg).toContain("\\ud83d\\ude80");
      expect(JSON.parse(arg).path).toBe("/café🚀");
      return Promise.resolve(download());
    });
    expect(new TextDecoder().decode(await files.read("/café🚀"))).toBe("abc");
  });
  it("bounds pages/entries, preserves change tags and rejects cursor loops", async () => {
    let calls = 0;
    const files = client((_input, init) => {
      const arg = JSON.parse(String(init?.body));
      if (calls++ === 0) expect(arg.path).toBe("");
      else expect(arg.cursor).toBe("cursor");
      return Promise.resolve(
        Response.json({ entries: [{ ".tag": "deleted", name: "old" }], cursor: "cursor", has_more: true }),
      );
    });
    const iterator = files.list();
    expect((await iterator.next()).value?.kind).toBe("deleted");
    await iterator.next();
    await expect(iterator.next()).rejects.toThrow("repeated");
    const bound = client(() => Promise.resolve(Response.json({ entries: [], cursor: "x", has_more: true })), {
      maxPages: 1,
    });
    await expect(bound.list().next()).rejects.toThrow("page budget");
    const entryBound = client(
      () =>
        Promise.resolve(Response.json({ entries: [{ ".tag": "deleted", name: "a" }], cursor: "x", has_more: false })),
      { maxEntries: 0 },
    );
    await expect(entryBound.listPage()).rejects.toThrow();
  });
  it("rejects redirects without sending credentials to their target", async () => {
    let calls = 0;
    const files = client(() => {
      calls++;
      return Promise.resolve(new Response(null, { status: 302, headers: { location: "https://evil.test/secret" } }));
    });
    await expect(files.stat("/a")).rejects.toBeInstanceOf(DropboxError);
    expect(calls).toBe(1);
    expect(() => client(() => Promise.resolve(new Response()), { endpoint: "https://api.test/2/?secret=x" })).toThrow(
      "endpoint",
    );
  });
  it("refuses pre-aborted and oversized requests before OAuth", async () => {
    let tokens = 0;
    const files = new DropboxClient({
      token: () => {
        tokens++;
        return "secret";
      },
      maxBytes: 2,
      fetch: () => {
        throw new Error("unexpected fetch");
      },
    });
    await expect(files.upload(target, bytes())).rejects.toThrow("byte budget");
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(files.stat("/a", controller.signal)).rejects.toThrow("stop");
    expect(tokens).toBe(0);
    await expect(files.stat("/".repeat(8193))).rejects.toThrow("address");
  });
  it("uses native byte extents even when a caller shadows view properties", async () => {
    const data = bytes();
    Object.defineProperty(data, "byteLength", { value: 0 });
    const files = client(() => {
      throw new Error("unexpected transport");
    }, { maxBytes: 2 });
    await expect(files.upload(target, data)).rejects.toThrow("byte budget");
    await expect(contentHash(data, { subtle: webcrypto.subtle, maxBytes: 2 })).rejects.toThrow("budget");
    const foreign: Uint8Array = runInNewContext("new Uint8Array([97,98,99])");
    const good = client(async (_input, init) => {
      expect(await new Response(init?.body).text()).toBe("abc");
      return Response.json(resource());
    });
    expect((await good.upload(target, foreign)).size).toBe(3);
    expect(await contentHash(new Uint8Array(new SharedArrayBuffer(0)), { subtle: webcrypto.subtle })).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

describe("Dropbox exact response bytes", () => {
  it("requires exact 206 evidence and matching response revision and total", async () => {
    const files = client((_input, init) => {
      expect(new Headers(init?.headers).get("range")).toBe("bytes=1-2");
      return Promise.resolve(download("bc", resource(), { "content-range": "bytes 1-2/3" }, 206));
    });
    expect(new TextDecoder().decode(await files.read(`rev:${rev}`, { at: 1, length: 2 }))).toBe("bc");
    await expect(client(() => Promise.resolve(download())).read("/a", { at: 1, length: 2 })).rejects.toThrow("206");
    await expect(
      client(() => Promise.resolve(download("bc", resource({ size: 4 }), { "content-range": "bytes 1-2/3" }, 206)))
        .read("/a", { at: 1, length: 2 }),
    ).rejects.toThrow("total");
    await expect(client(() => Promise.resolve(download())).read("rev:ffffffffffff")).rejects.toThrow("another");
    await expect(client(() => Promise.resolve(download("abc", resource(), { "content-encoding": "gzip" }))).read("/a"))
      .rejects.toThrow("Encoded");
  });
  it("checks declared and actual extent lengths, including EOF truncation", async () => {
    await expect(client(() => Promise.resolve(download("ab"))).read("/a")).rejects.toThrow("truncated");
    await expect(client(() => Promise.resolve(download("abcd"))).read("/a")).rejects.toThrow("exceeds");
    await expect(client(() => Promise.resolve(download("abc", resource(), { "content-length": "2" }))).read("/a"))
      .rejects.toThrow("declared");
    await expect(client(() => Promise.resolve(download(null))).read("/a")).rejects.toThrow("missing");
    expect(
      (await client(() => {
        throw new Error("unexpected");
      }).read("/a", { length: 0 })).length,
    ).toBe(0);
  });
  it("retains primary rejection beside failed upstream cancellation", async () => {
    const cleanup = new Error("cleanup failed");
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(bytes());
      },
      cancel() {
        throw cleanup;
      },
    });
    const files = client(() => Promise.resolve(download(body, resource(), {}, 200)));
    const result = await files.download("/a");
    const reader = result.bytes.getReader();
    await reader.read();
    try {
      await reader.read();
      throw new Error("missing failure");
    } catch (reason) {
      expect(reason).toBeInstanceOf(AggregateError);
      const errors = (reason as AggregateError).errors;
      expect(String(errors[0])).toContain("exceeds");
      expect(errors).toContain(cleanup);
    } finally {
      reader.releaseLock();
    }
  });
  it("preserves a producer read error without inventing a second cancellation failure", async () => {
    const reason = new Error("producer failed");
    const files = client(() =>
      Promise.resolve(download(
        new ReadableStream({
          start(controller) {
            controller.error(reason);
          },
        }),
      ))
    );
    const result = await files.download("/a");
    await expect(new Response(result.bytes).text()).rejects.toBe(reason);
  });
  it("cancels idle downloads on caller abort and refuses large finite reads before accumulation", async () => {
    let cancellations = 0;
    const files = client(() =>
      Promise.resolve(download(
        new ReadableStream({
          cancel() {
            cancellations++;
          },
        }),
      ))
    );
    const controller = new AbortController();
    const result = await files.download("/a", { signal: controller.signal });
    const reason = new Error("cancelled");
    controller.abort(reason);
    try {
      await new Response(result.bytes).text();
      throw new Error("missing abort");
    } catch (failure) {
      // The shared stream owner preserves both its classified aborted result
      // and independently observed producer/cleanup failures.
      expect(failure).toBeInstanceOf(Error);
      const failures = failure instanceof AggregateError ? failure.errors : [failure];
      expect(failures.some((error) => error === reason || error?.cause === reason)).toBe(true);
    }
    expect(cancellations).toBe(1);
    await expect(
      client(() =>
        Promise.resolve(download(
          new ReadableStream({
            cancel() {
              cancellations++;
            },
          }),
        )), { maxBytes: 2 }).read("/a"),
    ).rejects.toThrow("byte budget");
    expect(cancellations).toBe(2);
  });
});

describe("Dropbox upload evidence", () => {
  it("snapshots bytes and nested update revision before awaiting OAuth", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const data = bytes();
    const mode = { update: rev };
    const files = new DropboxClient({
      token: async () => {
        await pending;
        return "token";
      },
      fetch: async (_input, init) => {
        const arg = JSON.parse(new Headers(init?.headers).get("Dropbox-API-Arg")!);
        expect(arg.mode).toEqual({ ".tag": "update", update: rev });
        expect(arg.strict_conflict).toBe(true);
        expect(arg.autorename).toBe(false);
        expect(await new Response(init?.body).text()).toBe("abc");
        return Response.json(resource());
      },
    });
    const result = files.upload({ path: "id:one", mode }, data);
    data.fill(0);
    mode.update = "ffffffffffff";
    release();
    expect((await result).id).toBe("id:one");
  });
  it("never retries dispatched unknown mutations and checks final receipt identity/size/hash", async () => {
    let calls = 0;
    const unknown = client(() => {
      calls++;
      return Promise.reject(new Error("lost receipt"));
    }, { request: { retries: 5 } });
    await expect(unknown.upload(target, bytes())).rejects.toBeInstanceOf(DropboxPublicationError);
    expect(calls).toBe(1);
    await expect(client(() => Promise.resolve(Response.json(resource({ size: 4 })))).upload(target, bytes())).rejects
      .toBeInstanceOf(DropboxPublicationError);
    await expect(
      client(() => Promise.resolve(Response.json(resource()))).upload({ path: "id:other", mode: "overwrite" }, bytes()),
    ).rejects.toBeInstanceOf(DropboxPublicationError);
    await expect(
      client(() => Promise.resolve(Response.json(resource()))).upload(target, bytes(), { contentHash: "0".repeat(64) }),
    ).rejects.toBeInstanceOf(DropboxPublicationError);
    await expect(
      client(() =>
        Promise.resolve(Response.json({ error: { ".tag": "path", path: { ".tag": "conflict" } } }, { status: 409 }))
      ).upload(target, bytes()),
    ).rejects.toBeInstanceOf(DropboxError);
  });
  it("keeps sequential acknowledgements, offset conflicts and final publication distinct", async () => {
    const routes: string[] = [];
    const files = client((input, init) => {
      const path = new URL(String(input)).pathname;
      routes.push(path);
      const arg = JSON.parse(new Headers(init?.headers).get("Dropbox-API-Arg")!);
      if (path.endsWith("/start")) {
        expect(arg.session_type).toBe("sequential");
        return Promise.resolve(Response.json({ session_id: "session-secret" }));
      }
      if (path.endsWith("/append_v2")) {
        if (arg.cursor.offset !== 0) {
          return Promise.resolve(
            Response.json({ error: { ".tag": "incorrect_offset", correct_offset: 0 } }, { status: 409 }),
          );
        }
        return Promise.resolve(Response.json(null));
      }
      expect(path.endsWith("/finish")).toBe(true);
      expect(arg.cursor.offset).toBe(3);
      expect(arg.content_hash).toBeUndefined();
      return Promise.resolve(Response.json(resource()));
    });
    const opened = await files.startUpload();
    expect(opened.offset).toBe(0);
    try {
      await files.appendUpload({ ...opened, offset: 2 }, bytes());
      throw new Error("missing conflict");
    } catch (reason) {
      expect(reason).toBeInstanceOf(DropboxError);
      expect((reason as DropboxError).correctOffset).toBe(0);
    }
    const advanced = await files.appendUpload(opened, bytes());
    expect(advanced.offset).toBe(3);
    await expect(files.finishUpload(advanced, target, { size: 2 })).rejects.toThrow("complete acknowledged");
    expect((await files.finishUpload(advanced, target, { size: 3 })).size).toBe(3);
    expect(routes.length).toBe(4);
  });
});

describe("Dropbox content-hash construction", () => {
  it("uses independent fixed hash vectors and never acquires ambient crypto", async () => {
    // Python hashlib independently produced these constants using the published
    // Dropbox 4 MiB block construction; candidate code did not produce them.
    expect(await contentHash(new Uint8Array(), { subtle: webcrypto.subtle })).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(await contentHash(bytes(), { subtle: webcrypto.subtle })).toBe(
      "4f8b42c22dd3729b519ba6f68d2da7cc5b2d606d05daed5ad5128cc03e6c6358",
    );
    const multiblock = new Uint8Array(4 * 1024 * 1024 + 1);
    for (let at = 0; at < multiblock.length; at++) multiblock[at] = at % 251;
    expect(await contentHash(multiblock, { subtle: webcrypto.subtle })).toBe(
      "4a6cc0a344febaa07772e7c974834b2fb1d24594d4ba15f27c97a54699709f44",
    );
  });
  it("bounds and snapshots hash input before awaiting borrowed digest capability", async () => {
    const data = bytes();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const subtle = {
      async digest(algorithm: AlgorithmIdentifier, input: BufferSource): Promise<ArrayBuffer> {
        await gate;
        const bytes = ArrayBuffer.isView(input)
          ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
          : new Uint8Array(input);
        return await webcrypto.subtle.digest(algorithm, bytes);
      },
    };
    const pending = contentHash(data, { subtle });
    data.fill(0);
    release();
    expect(await pending).toBe("4f8b42c22dd3729b519ba6f68d2da7cc5b2d606d05daed5ad5128cc03e6c6358");
    await expect(contentHash(bytes(), { subtle, maxBytes: 2 })).rejects.toThrow("budget");
  });
});
