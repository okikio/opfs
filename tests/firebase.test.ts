import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { FirebaseClient, FirebaseError, FirebasePublicationError } from "../src/firebase.ts";
import type { FirebaseOptionsType, FirebaseSessionType } from "../src/firebase.ts";
const bucket = "demo-opfs.appspot.com";
const item = (name = "folder/file", size = 3) => ({
  bucket,
  name,
  size: String(size),
  generation: "9007199254740993",
  metageneration: "1",
  contentType: "text/plain",
});
const json = (value: unknown, headers?: HeadersInit) =>
  new Response(JSON.stringify(value), headers === undefined ? {} : { headers });
const options = (
  fetch: FirebaseOptionsType["fetch"],
  rest: Partial<FirebaseOptionsType> = {},
): FirebaseOptionsType => ({
  bucket,
  fetch: fetch!,
  credentials: () => ({ idToken: "id-token", appCheckToken: "app-check" }),
  ...rest,
});
const session = (size = 3): FirebaseSessionType => ({
  bucket,
  name: "folder/file",
  size,
  url: `https://firebasestorage.googleapis.com/v0/b/${bucket}/o?name=folder%2Ffile&upload_id=secret`,
});
describe("native Firebase Storage", () => {
  it("keeps literal names and Firebase credentials distinct from GCS OAuth", async () => {
    const client = new FirebaseClient(options(async (input, init) => {
      expect(new URL(input.toString()).pathname).toBe(`/v0/b/${bucket}/o/a%2F..%2Fb%252Fc`);
      expect(new Headers(init?.headers).get("authorization")).toBe("Firebase id-token");
      expect(new Headers(init?.headers).get("X-Firebase-AppCheck")).toBe("app-check");
      expect(init?.redirect).toBe("manual");
      expect(init?.credentials).toBe("omit");
      return json(item("a/../b%2Fc"));
    }));
    expect((await client.stat("a/../b%2Fc")).generation).toBe("9007199254740993");
  });
  it("refuses invalid names, sizes and preabort before acquiring credentials", async () => {
    let calls = 0;
    const client = new FirebaseClient({
      bucket,
      credentials: () => {
        calls++;
        return {};
      },
    });
    expect(() => client.stat("x".repeat(1025))).toThrow();
    expect(() => client.stat("..")).toThrow();
    await expect(client.read("file", { at: Number.MAX_SAFE_INTEGER, length: 2 })).rejects.toThrow();
    const controller = new AbortController();
    controller.abort("stop");
    await expect(client.stat("file", controller.signal)).rejects.toBe("stop");
    expect(calls).toBe(0);
    expect(await client.read("file", { length: 0 })).toEqual(new Uint8Array());
  });
  it("does not silently overwrite duplicate metadata authority or round generations", async () => {
    const client = new FirebaseClient(
      options(async () =>
        new Response(
          `{"bucket":"${bucket}","name":"folder/file","name":"other","size":"3","generation":"1","metageneration":"1"}`,
        )
      ),
    );
    await expect(client.stat("folder/file")).rejects.toThrow("Malformed");
  });
  it("validates delimiter pages and detects repeated continuation tokens", async () => {
    const client = new FirebaseClient(
      options(async () =>
        json({ items: [{ name: "folder/file", bucket }], prefixes: ["folder/nested/"], nextPageToken: "again" })
      ),
    );
    const iterator = client.list("folder/");
    expect((await iterator.next()).value?.items).toEqual(["folder/file"]);
    await expect(iterator.next()).rejects.toThrow("does not advance");
    const bad = new FirebaseClient(options(async () => json({ items: [{ name: "other/file" }] })));
    await expect(bad.listPage("folder/")).rejects.toThrow("escapes");
  });
  it("returns exact selected bytes and waits for actual EOF", async () => {
    const client = new FirebaseClient(options(async (input, init) => {
      if (!new URL(input.toString()).searchParams.has("alt")) return json(item());
      expect(new Headers(init?.headers).get("range")).toBe("bytes=1-2");
      return new Response(new Uint8Array([2, 3]), {
        status: 206,
        headers: { "Content-Range": "bytes 1-2/3", "Content-Length": "2" },
      });
    }));
    expect(await client.read("folder/file", { at: 1, length: 2 })).toEqual(new Uint8Array([2, 3]));
  });
  it("rejects ignored or wrong ranges and truncated/extra media", async () => {
    for (
      const response of [
        new Response(new Uint8Array([1, 2, 3])),
        new Response(new Uint8Array([1]), { status: 206, headers: { "Content-Range": "bytes 1-2/3" } }),
        new Response(new Uint8Array([1, 2, 3]), { status: 206, headers: { "Content-Range": "bytes 1-2/3" } }),
      ]
    ) {
      const client = new FirebaseClient(
        options(async (input) => new URL(input.toString()).searchParams.has("alt") ? response : json(item())),
      );
      await expect(client.read("folder/file", { at: 1, length: 2 })).rejects.toThrow();
    }
  });
  it("preserves a terminal native read failure exactly once", async () => {
    const failure = new Error("native source failed");
    const client = new FirebaseClient(options(async (input) => {
      if (!new URL(input.toString()).searchParams.has("alt")) return json(item());
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(failure);
          },
        }),
      );
    }));
    await expect(client.read("folder/file")).rejects.toBe(failure);
  });
  it("retains a distinct cancellation failure after an invalid media extent", async () => {
    const cleanup = new Error("native cancellation failed");
    const client = new FirebaseClient(options(async (input) => {
      if (!new URL(input.toString()).searchParams.has("alt")) return json(item());
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(4));
          },
          cancel() {
            throw cleanup;
          },
        }),
      );
    }));
    let failure: unknown;
    try {
      await client.read("folder/file");
    } catch (reason) {
      failure = reason;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    const errors = (failure as AggregateError).errors;
    expect(errors.length).toBe(2);
    expect(errors[0]).toBeInstanceOf(TypeError);
    expect(errors[1]).toBe(cleanup);
  });
  it("copies upload bytes and metadata before awaited credentials", async () => {
    const bytes = new Uint8Array([1, 2, 3]), value = { contentType: "text/plain" };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = new FirebaseClient(options(async (_input, init) => {
      const body = new Uint8Array(await new Response(init?.body).arrayBuffer());
      expect(new TextDecoder().decode(body)).toContain("text/plain");
      const suffix = new TextEncoder().encode("\r\n--opfs_firebase_multipart_20261105--");
      expect(Array.from(body.slice(-suffix.length - 3, -suffix.length))).toEqual([1, 2, 3]);
      return json(item());
    }, {
      credentials: async () => {
        await gate;
        return {};
      },
    }));
    const pending = client.upload("folder/file", bytes, value);
    bytes.fill(9);
    value.contentType = "changed";
    release();
    expect((await pending).size).toBe(3);
  });
  it("rejects MIME header injection and matches full publication receipt", async () => {
    let calls = 0;
    const client = new FirebaseClient(options(async () => {
      calls++;
      return json(item("wrong"));
    }));
    expect(() => client.upload("folder/file", new Uint8Array(3), { contentType: "text/plain\r\nInjected: yes" }))
      .toThrow();
    await expect(client.upload("folder/file", new Uint8Array(3))).rejects.toBeInstanceOf(FirebasePublicationError);
    expect(calls).toBe(1);
  });
  it("never retries unknown dispatched writes or redirects", async () => {
    let calls = 0;
    const client = new FirebaseClient(options(async () => {
      calls++;
      return new Response(null, { status: 307, headers: { location: "https://foreign.invalid/" } });
    }));
    await expect(client.deleteObject("file")).rejects.toBeInstanceOf(FirebasePublicationError);
    expect(calls).toBe(1);
    await expect(client.stat("file")).rejects.toBeInstanceOf(FirebaseError);
    expect(calls).toBe(2);
  });
  it("returns token download authority only through the explicit link operation", async () => {
    const client = new FirebaseClient(options(async () => json({ ...item(), downloadTokens: "secret,other" })));
    const link = await client.getDownloadLink("folder/file");
    expect(new URL(link!).searchParams.get("token")).toBe("secret");
  });
  it("rejects foreign or re-targeted sessions before credentials", async () => {
    let calls = 0;
    const client = new FirebaseClient({
      bucket,
      credentials: () => {
        calls++;
        return {};
      },
    });
    for (
      const url of [
        session().url.replace("firebasestorage.googleapis.com", "foreign.invalid"),
        session().url.replace("folder%2Ffile", "other"),
        session().url + "&token=credential",
      ]
    ) expect(() => client.statusUpload({ ...session(), url })).toThrow();
    expect(calls).toBe(0);
  });
  it("distinguishes an active full offset, final query status and a metadata receipt", async () => {
    let final = false;
    const client = new FirebaseClient(options(async (_input, init) => {
      const command = new Headers(init?.headers).get("X-Goog-Upload-Command");
      if (command === "query") {
        return new Response(null, {
          headers: { "X-Goog-Upload-Status": final ? "final" : "active", "X-Goog-Upload-Size-Received": "3" },
        });
      }
      final = true;
      return json(item(), { "X-Goog-Upload-Status": "final" });
    }));
    expect((await client.statusUpload(session())).state).toBe("active");
    const receipt = await client.writeUpload(session(), 3, new Uint8Array(), { finalize: true });
    expect(receipt.state).toBe("published");
    expect(await client.statusUpload(session())).toEqual({
      state: "final",
      offset: 3,
      size: 3,
      evidence: "session-status",
    });
  });
  it("captures resumable target, bytes and finality before token acquisition", async () => {
    const selected = { ...session() }, bytes = new Uint8Array([1, 2, 3]), settings = { finalize: true };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = new FirebaseClient(options(async (input, init) => {
      expect(new URL(input.toString()).searchParams.get("name")).toBe("folder/file");
      expect(new Headers(init?.headers).get("X-Goog-Upload-Command")).toBe("upload, finalize");
      expect(new Uint8Array(await new Response(init?.body).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
      return json(item(), { "X-Goog-Upload-Status": "final" });
    }, {
      credentials: async () => {
        await gate;
        return {};
      },
    }));
    const result = client.writeUpload(selected, 0, bytes, settings);
    selected.name = "other";
    selected.url = "https://foreign.invalid/";
    bytes.fill(9);
    settings.finalize = false;
    release();
    expect((await result).state).toBe("published");
  });
  it("rejects oversized caller metadata before acquiring credentials", () => {
    const client = new FirebaseClient({ bucket });
    const customMetadata = Object.fromEntries(Array.from({ length: 129 }, (_, at) => [String(at), "value"]));
    expect(() => client.updateMetadata("file", { customMetadata })).toThrow("allocation budget");
  });
  it("validates resumable chunk alignment and does not infer receipt from a bare final status", async () => {
    const client = new FirebaseClient(
      options(async () => new Response(null, { headers: { "X-Goog-Upload-Status": "final" } })),
    );
    expect(() => client.writeUpload(session(262145), 0, new Uint8Array(3), { finalize: false })).toThrow();
    await expect(client.writeUpload(session(), 0, new Uint8Array(3), { finalize: true })).rejects.toBeInstanceOf(
      FirebasePublicationError,
    );
  });
});
