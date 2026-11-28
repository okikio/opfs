/** S3: Stream admission protects native branding, source ownership and retirement. */
import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { runInNewContext } from "node:vm";
import { createS3Client } from "../../src/backend/s3/client.ts";
import { changeStreamPrototype } from "../stream.ts";
import { isStream } from "../../src/body.ts";
import { credentials, rejectedResponse, xml } from "./fixture.ts";

describe("S3 source admission precedes publication", () => {
  it("rejects an invalid byte chunk, retires input, and leaves the destination unchanged", async () => {
    const destination = Uint8Array.of(17, 31, 47);
    let published = destination;
    let cancels = 0;
    let aborts = 0;
    let completions = 0;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        Reflect.apply(controller.enqueue, controller, ["not bytes"]);
      },
      cancel() {
        cancels++;
      },
    });
    const client = createS3Client({
      endpoint: "https://s3.example.test",
      bucket: "owned",
      region: "us-east-1",
      credentials,
      delayedMultipart: false,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.searchParams.has("uploads")) {
          return xml("<InitiateMultipartUploadResult><UploadId>owned</UploadId></InitiateMultipartUploadResult>");
        }
        if (request.method === "DELETE") {
          aborts++;
          return new Response(null, { status: 204 });
        }
        completions++;
        published = new Uint8Array();
        return new Response(null);
      },
    });
    expect(await rejectedResponse(client.put("destination", source))).toBeInstanceOf(TypeError);
    expect(published).toBe(destination);
    expect(completions).toBe(0);
    expect(aborts).toBe(1);
    expect(cancels).toBe(1);
    expect(source.locked).toBe(false);
  });

  it("retires already acquired input beside failed multipart initialization", async () => {
    const primary = new Error("actual initiation transport failure");
    const cleanup = new Error("actual input cancellation failure");
    let cancels = 0;
    let calls = 0;
    const source = new ReadableStream<Uint8Array>({
      cancel() {
        cancels++;
        throw cleanup;
      },
    }, { highWaterMark: 0 });
    const client = createS3Client({
      endpoint: "https://s3.example.test",
      bucket: "owned",
      region: "us-east-1",
      credentials,
      delayedMultipart: false,
      fetch: async () => {
        calls++;
        throw primary;
      },
    });
    expect(await rejectedResponse(client.put("destination", source))).toMatchObject({ errors: [primary, cleanup] });
    expect(cancels).toBe(1);
    expect(calls).toBe(1);
    expect(source.locked).toBe(false);
  });
});

describe("S3 body union admission across delayedMultipart", () => {
  for (const enabled of [false, true]) {
    for (const kind of ["ordinary", "tag", "duck", "getter"] as const) {
      it(`rejects ${kind} pretender before retirement under delayedMultipart=${enabled}`, async () => {
        let effects = 0;
        let calls = 0;
        const bytes: unknown = kind === "ordinary"
          ? { byteLength: 0 }
          : kind === "tag"
          ? { [Symbol.toStringTag]: "Uint8Array", byteLength: 0 }
          : kind === "duck"
          ? {
            getReader() {
              effects++;
              throw new Error("Borrowed reader must not be acquired");
            },
            cancel() {
              effects++;
              throw new Error("Borrowed cancellation must not be called");
            },
          }
          : Object.defineProperties({}, {
            getReader: {
              get() {
                effects++;
                throw new Error("Pretender getter must not be evaluated");
              },
            },
            cancel: {
              get() {
                effects++;
                throw new Error("Pretender cancellation getter must not be evaluated");
              },
            },
          });
        const client = createS3Client({
          endpoint: "https://s3.example.test",
          bucket: "owned",
          region: "us-east-1",
          credentials,
          delayedMultipart: enabled,
          fetch: async () => {
            calls++;
            return new Response(null);
          },
        });
        const failure = await rejectedResponse(Reflect.apply(client.put, client, ["destination", bytes]));
        expect(failure).toBeInstanceOf(TypeError);
        expect(failure).not.toBeInstanceOf(AggregateError);
        expect(effects).toBe(0);
        expect(calls).toBe(0);
      });
    }

    it(`preserves branded readable empty bytes across supported prototype changes under delayedMultipart=${enabled}`, async () => {
      let reads = 0;
      let cancels = 0;
      let calls = 0;
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
        cancel() {
          cancels++;
        },
      }, { highWaterMark: 0 });
      const foreign: unknown = runInNewContext("({})");
      if (typeof foreign !== "object" || foreign === null) {
        throw new Error("Foreign prototype fixture must be an object");
      }
      expect(foreign instanceof Object).toBe(false);
      const detached = changeStreamPrototype(source, foreign);
      expect(source instanceof ReadableStream).toBe(!detached);
      const acquire = source.getReader.bind(source);
      Object.defineProperty(source, "getReader", {
        value() {
          reads++;
          return acquire();
        },
      });
      const client = createS3Client({
        endpoint: "https://s3.example.test",
        bucket: "owned",
        region: "us-east-1",
        credentials,
        delayedMultipart: enabled,
        fetch: async (input, init) => {
          calls++;
          const request = new Request(input, init);
          const url = new URL(request.url);
          if (url.searchParams.has("uploads")) {
            return xml(
              "<InitiateMultipartUploadResult><UploadId>owned-empty</UploadId></InitiateMultipartUploadResult>",
            );
          }
          if (request.method === "DELETE") return new Response(null, { status: 204 });
          expect([...new Uint8Array(await request.arrayBuffer())]).toEqual([]);
          return new Response(null, { headers: { etag: '"empty"' } });
        },
      });
      const receipt = await client.put("destination", source);
      expect(receipt.size).toBe(0);
      expect(calls).toBe(enabled ? 1 : 3);
      expect(reads).toBe(1);
      expect(cancels).toBe(0);
      expect(source.locked).toBe(false);
    });
  }
});

describe("S3 readable bytes across delayedMultipart", () => {
  for (const enabled of [false, true]) {
    it(`accepts genuine foreign bytes under delayedMultipart=${enabled}`, async () => {
      const bytes: unknown = runInNewContext("new Uint8Array([99,17,31,88]).subarray(1,3)");
      expect(ArrayBuffer.isView(bytes)).toBe(true);
      expect(bytes instanceof Uint8Array).toBe(false);
      let calls = 0;
      const client = createS3Client({
        endpoint: "https://s3.example.test",
        bucket: "owned",
        region: "us-east-1",
        credentials,
        delayedMultipart: enabled,
        fetch: async (input, init) => {
          calls++;
          const request = new Request(input, init);
          expect([...new Uint8Array(await request.arrayBuffer())]).toEqual([17, 31]);
          return new Response(null, { status: 201, headers: { etag: '"bytes"' } });
        },
      });
      const receipt = await Reflect.apply(client.put, client, ["destination", bytes]);
      expect(receipt.size).toBe(2);
      expect(calls).toBe(1);
    });
    for (const kind of ["detached", "out-of-bounds"] as const) {
      it(`rejects ${kind} zero-length backing under delayedMultipart=${enabled}`, async () => {
        let calls = 0;
        const client = createS3Client({
          endpoint: "https://s3.example.test",
          bucket: "owned",
          region: "us-east-1",
          credentials,
          delayedMultipart: enabled,
          fetch: async () => {
            calls++;
            return new Response(null);
          },
        });
        const backing = new ArrayBuffer(4, { maxByteLength: 8 });
        const bytes = new Uint8Array(backing, 2, 2);
        if (kind === "detached") structuredClone(backing, { transfer: [backing] });
        else backing.resize(1);
        expect(bytes.byteLength).toBe(0);
        const failure = await rejectedResponse(client.put("destination", bytes));
        expect(failure).toBeInstanceOf(TypeError);
        expect(failure).not.toBeInstanceOf(AggregateError);
        expect(calls).toBe(0);
      });
    }
  }
});

it("native body admission does not acquire, pull, cancel or evaluate a shadowed locked getter", async () => {
  let reads = 0;
  let pulls = 0;
  let cancels = 0;
  let getters = 0;
  const source = new ReadableStream<Uint8Array>({
    pull() {
      pulls++;
    },
    cancel() {
      cancels++;
    },
  }, { highWaterMark: 0 });
  const acquire = source.getReader.bind(source);
  Object.defineProperty(source, "getReader", {
    value() {
      reads++;
      return acquire();
    },
  });
  Object.defineProperty(source, "locked", {
    get() {
      getters++;
      throw new Error("Shadowed stream getter must not establish brand");
    },
  });
  try {
    expect(isStream(source)).toBe(true);
    expect(isStream({
      getReader() {
        reads++;
      },
      cancel() {
        cancels++;
      },
    })).toBe(false);
    expect(reads).toBe(0);
    expect(pulls).toBe(0);
    expect(cancels).toBe(0);
    expect(getters).toBe(0);
  } finally {
    await source.cancel();
  }
});
