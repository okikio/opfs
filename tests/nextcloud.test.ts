import { describe, it } from "node:test";
import { expect } from "@std/expect";
import {
  NEXTCLOUD_MIN_CHUNK_BYTES,
  NextcloudClient,
  NextcloudError,
  NextcloudPublicationError,
  NextcloudUploadSchema,
} from "../src/nextcloud.ts";
import type { NextcloudUploadType } from "../src/nextcloud.ts";

const endpoint = "https://cloud.example/installation/";
const descriptor: NextcloudUploadType = {
  protocol: "nextcloud-chunks",
  endpoint,
  user: "alice",
  name: "session-1",
  target: "notes/a %.txt",
  size: 3,
  chunkSize: NEXTCLOUD_MIN_CHUNK_BYTES,
  overwrite: false,
};
function open(
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  credentials: () => string | Promise<string> = () => "Basic fixture",
) {
  return new NextcloudClient({ endpoint, user: "alice", credentials, fetch });
}

describe("Nextcloud native chunk wire profile", () => {
  it("uses scoped routes, literal targets and explicit create-only MOVE", async () => {
    const requests: Array<{ url: string; method: string; headers: Headers; bytes: number[] }> = [];
    const client = open(async (input, init) => {
      requests.push({
        url: String(input),
        method: init!.method!,
        headers: new Headers(init!.headers),
        bytes: init!.body ? Array.from(new Uint8Array(await new Response(init!.body).arrayBuffer())) : [],
      });
      expect(init!.redirect).toBe("manual");
      expect(init!.credentials).toBe("omit");
      return new Response(null, { status: init!.method === "DELETE" ? 204 : 201 });
    });
    const upload = await client.createUpload("session-1", descriptor.target, 3, {
      chunkSize: NEXTCLOUD_MIN_CHUNK_BYTES,
    });
    const part = await client.putPart(upload, 1, new Uint8Array([1, 2, 3]));
    expect(await client.finishUpload(upload, [part])).toEqual({ status: 201, upload });
    await client.abortUpload(upload);
    expect(requests.map((r) => r.method)).toEqual(["MKCOL", "PUT", "MOVE", "DELETE"]);
    expect(requests[1]!.url).toBe(`${endpoint}remote.php/dav/uploads/alice/session-1/00001`);
    expect(requests[1]!.bytes).toEqual([1, 2, 3]);
    expect(requests[0]!.headers.get("destination")).toBe(`${endpoint}remote.php/dav/files/alice/notes/a%20%25.txt`);
    expect(requests[2]!.headers.get("overwrite")).toBe("F");
    expect(requests[3]!.headers.has("destination")).toBe(false);
  });

  it("validates saved session scope and finite shape without I/O", () => {
    const client = open(async () => {
      throw Error("unexpected I/O");
    });
    expect(client.openUpload(JSON.parse(JSON.stringify(descriptor)))).toEqual(descriptor);
    for (
      const invalid of [
        null,
        { ...descriptor, endpoint: "https://other.example/" },
        { ...descriptor, user: "bob" },
        { ...descriptor, name: "../escape" },
        { ...descriptor, target: "a/../b" },
        { ...descriptor, target: "a\\b" },
        { ...descriptor, size: 0 },
        { ...descriptor, size: Number.MAX_SAFE_INTEGER },
        { ...descriptor, extra: true },
      ]
    ) {
      expect(() => client.openUpload(invalid)).toThrow();
    }
    expect(Object.isFrozen(client.openUpload(descriptor))).toBe(true);
    expect(NextcloudUploadSchema.safeParse({ ...descriptor, target: "a/../b" }).success).toBe(false);
    expect(NextcloudUploadSchema.safeParse({ ...descriptor, size: Number.MAX_SAFE_INTEGER }).success).toBe(false);
  });

  it("rejects endpoint aliases, embedded credentials and insecure defaults", () => {
    for (
      const invalid of [
        "http://cloud.example/",
        "https://u:secret@cloud.example/",
        "https://cloud.example/a/../",
        "https://cloud.example/%2e/",
        "https://cloud.example/?token=secret",
        "https://cloud.example/no-slash",
      ]
    ) {
      expect(() => new NextcloudClient({ endpoint: invalid, user: "alice", credentials: () => "x" })).toThrow();
    }
  });

  it("refuses incomplete or incorrectly ordered acknowledgements before credentials", async () => {
    let calls = 0;
    const client = open(async () => new Response(null, { status: 201 }), () => {
      calls++;
      return "x";
    });
    for (
      const ledger of [[], [{ part: 2, size: 3 }], [{ part: 1, size: 2 }], [{ part: 1, size: 3 }, { part: 1, size: 3 }]]
    ) {
      await expect(client.finishUpload(descriptor, ledger)).rejects.toBeInstanceOf(TypeError);
    }
    await expect(client.putPart(descriptor, 1, new Uint8Array(2))).rejects.toBeInstanceOf(RangeError);
    await expect(client.putPart(descriptor, 0, new Uint8Array(3))).rejects.toBeInstanceOf(RangeError);
    expect(calls).toBe(0);
  });

  it("copies bytes and session/options before awaited authentication", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const input = new Uint8Array([1, 2, 3]), mutable = { ...descriptor }, options: { signal?: AbortSignal } = {};
    const client = open(async (_input, init) => {
      expect(new Headers(init!.headers).get("destination")).toContain("notes/a%20%25.txt");
      expect(Array.from(new Uint8Array(await new Response(init!.body).arrayBuffer()))).toEqual([1, 2, 3]);
      return new Response(null, { status: 201 });
    }, async () => {
      await gate;
      return "x";
    });
    const pending = client.putPart(mutable, 1, input, options);
    input.fill(9);
    mutable.target = "changed";
    options.signal = AbortSignal.abort();
    release();
    expect(await pending).toEqual({ part: 1, size: 3 });
  });

  it("pre-abort and token failures preserve their primary failure without dispatch", async () => {
    const primary = Error("caller cancellation");
    let callbacks = 0;
    const client = open(async () => {
      throw Error("unexpected dispatch");
    }, () => {
      callbacks++;
      throw primary;
    });
    await expect(client.abortUpload(descriptor, { signal: AbortSignal.abort(primary) })).rejects.toBe(primary);
    expect(callbacks).toBe(0);
    await expect(client.abortUpload(descriptor)).rejects.toBe(primary);
    expect(callbacks).toBe(1);
  });

  it("cancels after the token await before dispatch", async () => {
    const controller = new AbortController(), primary = Error("during credentials");
    const client = open(async () => {
      throw Error("unexpected dispatch");
    }, () => {
      controller.abort(primary);
      return "x";
    });
    await expect(client.abortUpload(descriptor, { signal: controller.signal })).rejects.toBe(primary);
  });

  it("keeps an uncertain final target/session and never retries", async () => {
    const primary = Error("lost MOVE acknowledgement");
    let requests = 0;
    const client = open(async () => {
      requests++;
      throw primary;
    });
    try {
      await client.finishUpload(descriptor, [{ part: 1, size: 3 }]);
      throw Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(NextcloudPublicationError);
      const publication = error as NextcloudPublicationError;
      expect(publication.cause).toBe(primary);
      expect(publication.upload).toEqual(descriptor);
      expect(publication.outcome).toBe("unknown");
    }
    expect(requests).toBe(1);
  });

  it("rejects redirects/partial acknowledgements and cancels response bodies", async () => {
    for (const status of [302, 207, 412, 500]) {
      let cancellations = 0;
      const client = open(async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancellations++;
            },
          }),
          { status, headers: { location: "https://other.example/?secret=hidden" } },
        )
      );
      try {
        await client.finishUpload(descriptor, [{ part: 1, size: 3 }]);
        throw Error("expected failure");
      } catch (error) {
        expect(error).toBeInstanceOf(NextcloudPublicationError);
        expect((error as Error).cause).toBeInstanceOf(NextcloudError);
        expect((error as Error).message).not.toContain("secret");
      }
      expect(cancellations).toBe(1);
    }
  });

  it("does not hide a failed response retirement behind successful status", async () => {
    const cleanup = Error("response retirement");
    const client = open(async () =>
      new Response(
        new ReadableStream({
          cancel() {
            throw cleanup;
          },
        }),
        { status: 201 },
      )
    );
    try {
      await client.createUpload("one", "file", 3);
      throw Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(NextcloudPublicationError);
      expect((error as Error).cause).toBe(cleanup);
    }
  });
});
