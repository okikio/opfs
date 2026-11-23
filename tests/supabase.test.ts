import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { SupabaseClient, SupabaseError, SupabasePublicationError } from "../src/supabase.ts";
import type { SupabaseOptionsType } from "../src/supabase.ts";
const endpoint = "https://storage.invalid/storage/v1/", bucket = "notes", key = "folder/note.txt";
const bytes = new TextEncoder().encode("hello\n");
const info = {
  id: "native-object-id",
  name: key,
  bucket_id: bucket,
  version: "opaque-version",
  size: bytes.length,
  content_type: "text/plain",
  etag: '"native-etag"',
  metadata: { label: "inert" },
};
const json = (value: unknown) => new Response(JSON.stringify(value));
const client = (fetch: NonNullable<SupabaseOptionsType["fetch"]>, extra: Partial<SupabaseOptionsType> = {}) =>
  new SupabaseClient({ endpoint, bucket, fetch, ...extra });
describe("native Supabase Storage REST", () => {
  it("uses exact standalone and hosted API-root paths without double slashes or dropping prefixes", async () => {
    for (
      const [endpoint, prefix] of [["https://storage.invalid/", ""], [
        "https://storage.invalid/storage/v1/",
        "/storage/v1",
      ]] as const
    ) {
      let calls = 0;
      const files = client(async (input) => {
        const target = new URL(input.toString());
        if (++calls === 1) {
          expect(target.pathname).toBe(prefix + "/object/info/notes/folder/note.txt");
          return json(info);
        }
        if (calls === 2) {
          expect(target.pathname).toBe(prefix + "/object/authenticated/notes/folder/note.txt");
          return new Response(new Uint8Array(bytes));
        }
        expect(target.pathname).toBe(prefix + "/object/sign/notes/folder/note.txt");
        return calls === 3
          ? json({ signedURL: "/object/sign/notes/folder/note.txt?token=signed" })
          : new Response(new Uint8Array(bytes));
      }, { endpoint, signedOrigins: ["https://storage.invalid"] });
      expect((await files.info(key)).size).toBe(6);
      expect(await files.read(key, { access: "authenticated" })).toEqual(bytes);
      const capability = await files.createSignedUrl(key, { expiresIn: 60 });
      expect(await files.readSigned(key, capability)).toEqual(bytes);
      expect(calls).toBe(4);
    }
  });
  it("retains native identity evidence without claiming immutable bytes", async () => {
    const files = client(async (input, init) => {
      expect(new URL(input.toString()).pathname).toBe("/storage/v1/object/info/notes/folder/note.txt");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer access-token");
      expect(new Headers(init?.headers).get("apikey")).toBe("gateway-key");
      expect(init?.redirect).toBe("manual");
      expect(init?.credentials).toBe("omit");
      return json(info);
    }, { credentials: () => ({ accessToken: "access-token", apiKey: "gateway-key" }) });
    const result = await files.info(key);
    expect(result.version).toBe("opaque-version");
    expect(result.size).toBe(6);
    expect("stability" in result).toBe(false);
    for (const change of [{ name: "other" }, { bucket_id: "other" }, { size: 9007199254740992 }]) {
      await expect(client(async () => json({ ...info, ...change })).info(key)).rejects.toThrow();
    }
  });
  it("distinguishes native prefix placeholders and object entries on bounded offset pages", async () => {
    const files = client(async (_input, init) => {
      expect(JSON.parse(init!.body as string)).toEqual({
        prefix: "folder/",
        offset: 3,
        limit: 2,
        sortBy: { column: "name", order: "asc" },
      });
      return json([{ name: "child", id: null, metadata: null }, {
        name: "note.txt",
        id: "native-id",
        metadata: { size: 6 },
      }]);
    });
    expect((await files.listPage("folder/", { offset: 3, limit: 2 })).items).toEqual([
      { kind: "prefix", name: "child" },
      { kind: "object", name: "note.txt", id: "native-id", metadata: { size: 6 } },
    ]);
    await expect(files.listPage("folder", { limit: 0 })).rejects.toThrow();
    await expect(client(async () => json([{ name: "same", id: null }, { name: "same", id: "id" }])).listPage(""))
      .rejects.toThrow("repeats");
  });
  it("keeps public reads free of API credential acquisition and authenticated reads explicit", async () => {
    let credentials = 0, calls = 0;
    const files = client(async (input, init) => {
      const target = new URL(input.toString()), headers = new Headers(init?.headers);
      if (++calls === 1) {
        expect(target.pathname).toContain("/object/public/");
        expect(headers.has("Authorization")).toBe(false);
        expect(headers.has("apikey")).toBe(false);
      } else {
        expect(target.pathname).toContain("/object/authenticated/");
        expect(headers.get("Authorization")).toBe("Bearer jwt");
      }
      return new Response(new Uint8Array(bytes), { headers: { "Content-Length": "6" } });
    }, {
      credentials: () => {
        credentials++;
        return { accessToken: "jwt", apiKey: "secret" };
      },
    });
    expect(await files.read(key, { access: "public" })).toEqual(bytes);
    expect(credentials).toBe(0);
    expect(await files.read(key, { access: "authenticated" })).toEqual(bytes);
    expect(credentials).toBe(1);
  });
  it("resolves native signed URLs against the API root and never forwards credentials on signed hops", async () => {
    let credentials = 0, calls = 0;
    const files = client(async (input, init) => {
      if (++calls === 1) return json({ signedURL: "/object/sign/notes/folder/note.txt?token=signed-token" });
      const target = new URL(input.toString());
      expect(target.pathname).toBe("/storage/v1/object/sign/notes/folder/note.txt");
      expect(target.searchParams.get("token")).toBe("signed-token");
      expect(new Headers(init?.headers).has("Authorization")).toBe(false);
      expect(new Headers(init?.headers).has("apikey")).toBe(false);
      return new Response(new Uint8Array(bytes));
    }, {
      credentials: () => {
        credentials++;
        return { accessToken: "jwt" };
      },
      signedOrigins: ["https://storage.invalid"],
    });
    const signed = await files.createSignedUrl(key, { expiresIn: 60 });
    expect(await files.readSigned(key, signed)).toEqual(bytes);
    expect(credentials).toBe(1);
  });
  it("rejects ungranted/mismatched/aliased signed routes before Fetch or credentials", async () => {
    let calls = 0;
    const files = client(async () => {
      calls++;
      return new Response("x");
    }, {
      signedOrigins: ["https://storage.invalid"],
      credentials: () => {
        calls++;
        return {};
      },
    });
    for (
      const capability of [
        "https://foreign.invalid/storage/v1/object/sign/notes/folder/note.txt?token=x",
        "https://storage.invalid/storage/v1/object/sign/other/folder/note.txt?token=x",
        "https://storage.invalid/storage/v1/object/sign/notes/folder/other.txt?token=x",
        "https://storage.invalid/storage/v1/object/sign/notes/folder/x/../note.txt?token=x",
        "https://storage.invalid/storage/v1/object/sign/notes/folder/%2e/note.txt?token=x",
        "https://storage.invalid/storage/v1/object/sign/notes/folder/note.txt?token=x&token=y",
        "https://storage.invalid/storage/v1/object/sign/notes/folder/note.txt?token=x&other=y",
      ]
    ) await expect(files.downloadSigned(key, capability)).rejects.toThrow();
    await expect(
      client(async () => {
        calls++;
        return new Response("x");
      }).downloadSigned(key, "https://storage.invalid/storage/v1/object/sign/notes/folder/note.txt?token=x"),
    ).rejects.toThrow();
    expect(calls).toBe(0);
  });
  it("refuses signed receipt aliases and malformed JSON authority", async () => {
    for (
      const signedURL of [
        "https://storage.invalid/storage/v1/object/sign/notes/folder/note.txt?token=x",
        "/object/sign/notes/folder/x/../note.txt?token=x",
        "/object/sign/notes/folder/note.txt?token=x&token=y",
      ]
    ) await expect(client(async () => json({ signedURL })).createSignedUrl(key, { expiresIn: 60 })).rejects.toThrow();
    await expect(client(async () => new Response('{"id":"first","id":"second"}')).info(key)).rejects.toThrow("JSON");
  });
  it("copies upload bytes and captures target/options before awaiting API credentials", async () => {
    const source = new Uint8Array(bytes),
      options: { mode: "create" | "upsert"; mediaType: string } = { mode: "create", mediaType: "text/plain" };
    const files = client(async (input, init) => {
      expect(new URL(input.toString()).pathname).toBe("/storage/v1/object/notes/folder/note.txt");
      expect(new Headers(init?.headers).get("x-upsert")).toBe("false");
      expect(new Headers(init?.headers).get("Content-Type")).toBe("text/plain");
      expect(new Uint8Array(init?.body as Uint8Array)).toEqual(bytes);
      return json({ Key: "notes/folder/note.txt", Id: "native-id" });
    }, {
      credentials: async () => {
        source.fill(0);
        options.mode = "upsert";
        options.mediaType = "changed";
        return { accessToken: "jwt" };
      },
    });
    expect((await files.upload(key, source, options)).state).toBe("acknowledged");
  });
  it("preflights upload budget and invalid names before credential acquisition", async () => {
    let calls = 0;
    const files = client(async () => {
      calls++;
      return json({});
    }, {
      maxBytes: 5,
      credentials: () => {
        calls++;
        return {};
      },
    });
    await expect(files.upload(key, bytes, { mode: "create" })).rejects.toThrow();
    for (const value of ["../x", "a//x", "a/./x", "a\\x", "a/\ud800"]) {
      await expect(files.info(value)).rejects.toThrow();
    }
    expect(calls).toBe(0);
  });
  it("reports only returned exact-key deletions and leaves omitted keys unresolved", async () => {
    const files = client(async (_input, init) => {
      expect(JSON.parse(init!.body as string)).toEqual({ prefixes: [key, "hidden.txt"] });
      return json([{ id: "removed-id", name: key, bucket_id: bucket, version: "opaque" }]);
    });
    expect(await files.remove([key, "hidden.txt"])).toEqual([{ key, id: "removed-id", version: "opaque" }]);
    expect(await client(async () => json([])).remove([key])).toEqual([]);
    await expect(client(async () => json([{ id: "id", name: "foreign", bucket_id: bucket }])).remove([key])).rejects
      .toBeInstanceOf(SupabasePublicationError);
  });
  it("does not retry dispatched mutations with conflicts, invalid receipts or lost acknowledgements", async () => {
    let calls = 0;
    for (
      const fetch of [async () => {
        calls++;
        return new Response(null, { status: 409 });
      }, async () => {
        calls++;
        return json({ Key: "other/path" });
      }, async () => {
        calls++;
        throw new Error("wire failure");
      }]
    ) {
      await expect(client(fetch).upload(key, bytes, { mode: "create" })).rejects.toBeInstanceOf(
        SupabasePublicationError,
      );
    }
    expect(calls).toBe(3);
  });
  it("validates exact range responses and rejects ignored or short extents", async () => {
    expect(
      await client(async (_input, init) => {
        expect(new Headers(init?.headers).get("Range")).toBe("bytes=1-3");
        return new Response("ell", { status: 206, headers: { "Content-Range": "bytes 1-3/6" } });
      }).read(key, { access: "public", at: 1, length: 3 }),
    ).toEqual(new TextEncoder().encode("ell"));
    for (
      const response of [
        new Response("ell"),
        new Response("ell", { status: 206, headers: { "Content-Range": "bytes 2-4/6" } }),
        new Response("el", { status: 206, headers: { "Content-Range": "bytes 1-3/6" } }),
      ]
    ) await expect(client(async () => response).read(key, { access: "public", at: 1, length: 3 })).rejects.toThrow();
  });
  it("checks declared lengths, real EOF and materialization bounds", async () => {
    for (
      const response of [
        new Response("short", { headers: { "Content-Length": "6" } }),
        new Response("too long", { headers: { "Content-Length": "6" } }),
        new Response("x", { headers: { "Content-Encoding": "gzip" } }),
      ]
    ) await expect(client(async () => response).read(key, { access: "public" })).rejects.toThrow();
    await expect(
      client(async () => new Response(new Uint8Array(bytes)), { maxBytes: 5 }).read(key, { access: "public" }),
    ).rejects.toThrow();
  });
  it("preserves native terminal read failure identity and independent cleanup faults", async () => {
    const failure = new Error("native read failed");
    await expect(
      client(async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.error(failure);
            },
          }),
        )
      ).read(key, { access: "public" }),
    ).rejects.toBe(failure);
    const cleanup = new Error("cleanup failed");
    try {
      await client(async () =>
        new Response(
          new ReadableStream({
            cancel() {
              throw cleanup;
            },
          }),
          { status: 302 },
        )
      ).download(key, { access: "public" });
      throw new Error("Expected failure");
    } catch (reason) {
      expect(reason).toBeInstanceOf(AggregateError);
      expect((reason as AggregateError).errors).toContain(cleanup);
    }
  });
  it("admits zero-length reads locally and respects cancellation before API credentials", async () => {
    let calls = 0;
    const files = client(async () => {
      calls++;
      return new Response("x");
    }, {
      credentials: () => {
        calls++;
        return {};
      },
    });
    expect(await files.read(key, { access: "authenticated", length: 0 })).toEqual(new Uint8Array());
    expect(calls).toBe(0);
    await expect(files.info(key, AbortSignal.abort("stop"))).rejects.toBe("stop");
    expect(calls).toBe(0);
    await expect(client(async () => new Response(null, { status: 403 })).info(key)).rejects.toBeInstanceOf(
      SupabaseError,
    );
  });
  it("captures caller cancellation and native credential getters once", async () => {
    let signals = 0, tokens = 0;
    const signal = new AbortController().signal;
    const files = client(async (_input, init) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer first-token");
      return new Response(new Uint8Array(bytes));
    }, {
      credentials: () => ({
        get accessToken() {
          return ++tokens === 1 ? "first-token" : "changed-token";
        },
      }),
    });
    const options = {
      access: "authenticated" as const,
      get signal() {
        return ++signals === 1 ? signal : AbortSignal.abort("changed");
      },
    };
    expect(await files.read(key, options)).toEqual(bytes);
    expect(signals).toBe(1);
    expect(tokens).toBe(1);
  });
  it("preserves extent failure and an independently rejected underlying cancellation", async () => {
    const cleanup = new Error("independent cancellation failure");
    const files = client(async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(bytes));
          },
          cancel() {
            throw cleanup;
          },
        }),
        { headers: { "Content-Length": "1" } },
      )
    );
    try {
      await files.read(key, { access: "public" });
      throw new Error("Expected failure");
    } catch (reason) {
      expect(reason).toBeInstanceOf(AggregateError);
      expect((reason as AggregateError).errors).toContain(cleanup);
      expect((reason as AggregateError).errors.some((error) => error instanceof TypeError)).toBe(true);
    }
  });
});
