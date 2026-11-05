import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { ResticClient, ResticError, ResticObjectSchema, ResticPublicationError } from "../src/restic.ts";
import type { ResticClientOptionsType, ResticObjectType } from "../src/restic.ts";

const id = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const object: ResticObjectType = { kind: "data", id };
const endpoint = "https://backup.example/repository/";
function open(fetch: NonNullable<ResticClientOptionsType["fetch"]>, options: Partial<ResticClientOptionsType> = {}) {
  return new ResticClient({ endpoint, fetch, subtle: crypto.subtle, ...options });
}
function bytes(value = "abc", status = 200, headers: HeadersInit = {}) {
  const admitted = new Headers(headers);
  admitted.set("content-length", String(new TextEncoder().encode(value).length));
  return new Response(value, { status, headers: admitted });
}
function listing(value: string, media = "application/vnd.x.restic.rest.v2") {
  return new Response(value, { headers: { "content-type": media } });
}

describe("restic opaque native REST repository objects", () => {
  it("hash-addresses copied saves with the independent SHA256 abc vector", async () => {
    const client = open(async (input, init) => {
      expect(String(input)).toBe(`${endpoint}data/${id}`);
      expect(init!.method).toBe("POST");
      expect(init!.redirect).toBe("manual");
      expect(init!.credentials).toBe("omit");
      expect(new Headers(init!.headers).get("accept")).toBe("application/vnd.x.restic.rest.v2");
      expect(await new Response(init!.body).text()).toBe("abc");
      return new Response(null);
    });
    expect(await client.save("data", new TextEncoder().encode("abc"))).toEqual({ id, size: 3 });
  });
  it("verifies complete bytes, refuses hash mismatch and distinguishes unhashed config", async () => {
    expect(await open(async () => bytes()).readVerified(object)).toEqual(new TextEncoder().encode("abc"));
    await expect(open(async () => bytes("abd")).readVerified(object)).rejects.toBeInstanceOf(TypeError);
    const client = open(async () => {
      throw Error("unexpected request");
    });
    await expect(client.readVerified({ kind: "config" })).rejects.toBeInstanceOf(TypeError);
    await expect(client.remove({ kind: "config" })).rejects.toBeInstanceOf(TypeError);
    expect(ResticObjectSchema.safeParse({ kind: "data", id: "abc" }).success).toBe(false);
    expect(ResticObjectSchema.safeParse({ kind: "config", id }).success).toBe(false);
  });
  it("captures a single bound digest method before HTTP and returns private verified bytes", async () => {
    let gets = 0, calls = 0;
    const transferred = new TextEncoder().encode("abc");
    let authority: SubtleCrypto["digest"] = function (this: Pick<SubtleCrypto, "digest">, algorithm, data) {
      expect(this).toBe(subtle);
      calls++;
      return crypto.subtle.digest(algorithm, data);
    };
    const subtle = {
      get digest(): SubtleCrypto["digest"] {
        gets++;
        return authority;
      },
      set digest(value: SubtleCrypto["digest"]) {
        authority = value;
      },
    };
    const client = open(async () => {
      await Promise.resolve();
      subtle.digest = async () => {
        throw Error("replaced digest must not acquire authority");
      };
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(transferred);
            controller.close();
          },
        }),
        { headers: { "content-length": "3" } },
      );
    }, { subtle });
    const verified = await client.readVerified(object);
    transferred.fill(0);
    expect(verified).toEqual(new TextEncoder().encode("abc"));
    expect(gets).toBe(1);
    expect(calls).toBe(1);
  });
  it("retains abort authority after an awaited digest before upload dispatch", async () => {
    const controller = new AbortController(),
      primary = Error("aborted digest"),
      input = new TextEncoder().encode("abc");
    const client = open(async () => {
      throw Error("unexpected dispatch");
    }, {
      subtle: {
        async digest(algorithm, data) {
          const result = await crypto.subtle.digest(algorithm, data);
          controller.abort(primary);
          return result;
        },
      },
    });
    await expect(client.save("data", input, { signal: controller.signal })).rejects.toBe(primary);
  });
  it("does not discover a digest capability for verified reads or saves", async () => {
    const client = new ResticClient({
      endpoint,
      fetch: async () => {
        throw Error("unexpected request");
      },
    });
    await expect(client.readVerified(object)).rejects.toBeInstanceOf(TypeError);
    await expect(client.save("data", new Uint8Array())).rejects.toBeInstanceOf(TypeError);
  });
  it("accepts bounded V2 listings in either native key order without inventing continuation", async () => {
    const second = "f".repeat(64);
    expect(await open(async () => listing(`[ {"size":3,"name":"${id}"}, {"name":"${second}","size":0} ]`)).list("data"))
      .toEqual([{ id, size: 3 }, { id: second, size: 0 }]);
    expect(await open(async () => listing("[]")).list("locks")).toEqual([]);
  });
  it("rejects duplicate fields/IDs, unsafe numeric lexemes, unknown fields, trailing data and V1 evidence", async () => {
    for (
      const text of [
        `[{"name":"${id}","name":"${id}"}]`,
        `[{"name":"${id}","size":9007199254740992}]`,
        `[{"name":"${id}","size":3,"extra":0}]`,
        `[{"name":"${id}","size":3},{"name":"${id}","size":3}]`,
        `[{"name":"${id}","size":1e2}]`,
        "[] true",
      ]
    ) {
      await expect(open(async () => listing(text)).list("data")).rejects.toThrow();
    }
    await expect(open(async () => listing("[]", "application/json")).list("data")).rejects.toBeInstanceOf(TypeError);
    await expect(open(async () => listing(`[{"name":"${id}","size":3}]`), { maxEntries: 0 }).list("data")).rejects
      .toBeInstanceOf(RangeError);
  });
  it("checks metadata and retains missing evidence", async () => {
    expect(await open(async () => bytes()).stat(object)).toEqual({ size: 3 });
    expect(await open(async () => new Response(null, { status: 404 })).stat(object)).toBeNull();
    for (const raw of ["-1", "1e2", "9007199254740992"]) {
      await expect(open(async () => new Response(null, { headers: { "content-length": raw } })).stat(object)).rejects
        .toThrow();
    }
  });
  it("enforces exact partial evidence and permits provider EOF clamping", async () => {
    const client = open(async (_input, init) => {
      expect(new Headers(init!.headers).get("range")).toBe("bytes=1-99");
      return bytes("bc", 206, { "content-range": "bytes 1-2/3" });
    });
    expect(new TextDecoder().decode(await client.read(object, { at: 1, length: 99 }))).toBe("bc");
    for (
      const response of [
        bytes(),
        bytes("bc", 206, { "content-range": "bytes 0-1/3" }),
        bytes("bc", 206, { "content-range": "bytes 1-2/3", "content-encoding": "gzip" }),
      ]
    ) {
      await expect(open(async () => response).read(object, { at: 1, length: 2 })).rejects.toBeInstanceOf(TypeError);
    }
  });
  it("refuses truncated/long actual extents and preserves native terminal read errors once", async () => {
    for (const actual of ["ab", "abcd"]) {
      await expect(open(async () => new Response(actual, { headers: { "content-length": "3" } })).read(object)).rejects
        .toBeInstanceOf(TypeError);
    }
    const primary = Error("native read failure");
    await expect(
      open(async () =>
        new Response(
          new ReadableStream({
            pull() {
              throw primary;
            },
          }),
          { headers: { "content-length": "3" } },
        )
      ).read(object),
    ).rejects.toBe(primary);
  });
  it("releases the native body exactly once when the caller cancels a partially consumed download", async () => {
    const reason = Error("caller stopped preview");
    let cancellations = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
      },
      cancel(actual) {
        expect(actual).toBe(reason);
        cancellations++;
      },
    });
    const download = await open(async () => new Response(body, { headers: { "content-length": "3" } })).download(
      object,
    );
    const reader = download.bytes.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([1, 2, 3]));
    await reader.cancel(reason);
    await reader.cancel(reason);
    reader.releaseLock();
    expect(cancellations).toBe(1);
    expect(body.locked).toBe(false);
  });
  it("retires oversized materialized responses before collecting bytes", async () => {
    let retired = 0;
    const client = open(async () =>
      new Response(
        new ReadableStream({
          cancel() {
            retired++;
          },
        }),
        { headers: { "content-length": "3" } },
      ), { maxBytes: 2 });
    await expect(client.read(object)).rejects.toBeInstanceOf(RangeError);
    expect(retired).toBe(1);
  });
  it("returns empty local extents without credentials or existence evidence", async () => {
    const client = open(async () => {
      throw Error("unexpected request");
    }, {
      credentials: () => {
        throw Error("unexpected token");
      },
    });
    expect(await client.read(object, { at: 1000, length: 0 })).toEqual(new Uint8Array());
  });
  it("captures bytes and locators before awaited digest or credential callbacks", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const source = new TextEncoder().encode("abc");
    const client = open(async (_input, init) => {
      expect(await new Response(init!.body).text()).toBe("abc");
      return new Response(null);
    }, {
      subtle: {
        async digest(algorithm, data) {
          await gate;
          return await crypto.subtle.digest(algorithm, data);
        },
      },
    });
    const pending = client.save("data", source);
    source.fill(0);
    release();
    expect((await pending).id).toBe(id);
    const mutable = { kind: "data" as const, id };
    const captured = open(async (input) => {
      expect(String(input)).toBe(`${endpoint}data/${id}`);
      return bytes();
    }, {
      credentials(url) {
        url.pathname = "/outside";
        mutable.id = "f".repeat(64);
        return "Basic fixture";
      },
    });
    expect(await captured.stat(mutable)).toEqual({ size: 3 });
  });
  it("pre-aborts before credentials and suppresses dispatch after credential abort", async () => {
    const primary = Error("stop");
    const controller = new AbortController();
    let calls = 0;
    const client = open(async () => {
      throw Error("unexpected dispatch");
    }, {
      credentials() {
        calls++;
        controller.abort(primary);
        return "Basic fixture";
      },
    });
    await expect(client.remove(object, { signal: AbortSignal.abort(primary) })).rejects.toBe(primary);
    expect(calls).toBe(0);
    await expect(client.remove(object, { signal: controller.signal })).rejects.toBe(primary);
    expect(calls).toBe(1);
  });
  it("retains uncertain object context after a dispatched mutation and never retries", async () => {
    let count = 0;
    const primary = Error("lost acknowledgement");
    const client = open(async () => {
      count++;
      throw primary;
    });
    try {
      await client.remove(object);
      throw Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ResticPublicationError);
      expect((error as ResticPublicationError).object).toEqual(object);
      expect((error as Error).cause).toBe(primary);
    }
    expect(count).toBe(1);
  });
  it("rejects redirected/partial mutation responses and retains cleanup failures", async () => {
    for (const status of [302, 207, 403]) {
      let retired = 0;
      const client = open(async () =>
        new Response(
          new ReadableStream({
            cancel() {
              retired++;
            },
          }),
          { status },
        )
      );
      try {
        await client.remove(object);
        throw Error("expected failure");
      } catch (error) {
        expect(error).toBeInstanceOf(ResticPublicationError);
        expect((error as Error).cause).toBeInstanceOf(ResticError);
      }
      expect(retired).toBe(1);
    }
    const primary = Error("retirement failed");
    const client = open(async () =>
      new Response(
        new ReadableStream({
          cancel() {
            throw primary;
          },
        }),
      )
    );
    try {
      await client.remove(object);
      throw Error("expected failure");
    } catch (error) {
      expect((error as Error).cause).toBe(primary);
    }
  });
  it("restricts endpoint scope before URL normalization and refuses reserved repository components", () => {
    for (
      const value of [
        "http://backup.example/",
        "https://user:secret@backup.example/",
        "https://backup.example/a/../",
        "https://backup.example/%2e/",
        "https://backup.example/data/",
        "https://backup.example/repo/?secret=hidden",
      ]
    ) {
      expect(() => new ResticClient({ endpoint: value })).toThrow();
    }
  });
  it("creates only the native repository scaffold", async () => {
    const client = open(async (input, init) => {
      expect(String(input)).toBe(`${endpoint}?create=true`);
      expect(init!.method).toBe("POST");
      return new Response(null);
    });
    await client.createRepository();
  });
});
