/** Azure: Stream admission protects native branding, source ownership and retirement. */
import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { runInNewContext } from "node:vm";
import { createAzureClient } from "../../src/backend/azure/client.ts";
import { changeStreamPrototype } from "../stream.ts";
import { within } from "../gate.ts";
import { withReleases } from "../close.ts";
import { rejectedResponse } from "./fixture.ts";

describe("Azure native byte admission", () => {
  it("rejects invalid chunks without publishing an empty replacement", async () => {
    const previous = Uint8Array.of(17, 31, 47);
    let published = previous;
    let cancels = 0;
    let calls = 0;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        Reflect.apply(controller.enqueue, controller, [new DataView(new ArrayBuffer(1))]);
      },
      cancel() {
        cancels++;
      },
    });
    const client = createAzureClient({
      endpoint: "https://account.example.test",
      container: "owned",
      credential: { kind: "sas", token: "sig=authored" },
      fetch: async () => {
        calls++;
        published = new Uint8Array();
        return new Response(null, { status: 201 });
      },
    });
    expect(await rejectedResponse(client.put("destination", source))).toBeInstanceOf(TypeError);
    expect(calls).toBe(0);
    expect(published).toBe(previous);
    expect(cancels).toBe(1);
    expect(source.locked).toBe(false);
  });
});

describe("Azure body union admission across blockUpload", () => {
  for (const enabled of [false, true]) {
    for (const kind of ["ordinary", "tag", "duck", "getter"] as const) {
      it(`rejects ${kind} pretender before retirement under blockUpload=${enabled}`, async () => {
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
        const client = createAzureClient({
          endpoint: "https://account.example.test",
          container: "owned",
          credential: { kind: "sas", token: "sig=authored" },
          blockUpload: enabled,
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

    it(`preserves branded readable empty bytes across supported prototype changes under blockUpload=${enabled}`, async () => {
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
      const client = createAzureClient({
        endpoint: "https://account.example.test",
        container: "owned",
        credential: { kind: "sas", token: "sig=authored" },
        blockUpload: enabled,
        fetch: async (input, init) => {
          calls++;
          const request = new Request(input, init);
          const url = new URL(request.url);
          expect(url.searchParams.has("comp")).toBe(false);
          expect([...new Uint8Array(await request.arrayBuffer())]).toEqual([]);
          return new Response(null, { status: 201, headers: { etag: '"empty"' } });
        },
      });
      if (enabled) {
        const receipt = await client.put("destination", source);
        expect(receipt.size).toBe(0);
        expect(calls).toBe(1);
        expect(reads).toBe(1);
      } else {
        await expect(client.put("destination", source)).rejects.toBeInstanceOf(TypeError);
        expect(calls).toBe(0);
        expect(reads).toBe(0);
      }
      expect(cancels).toBe(0);
      expect(source.locked).toBe(false);
    });
  }
});

it("disabled Azure native-stream admission joins one real cancellation and retains its fault", async () => {
  await withReleases(async (releases) => {
    const entered = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    const cleanup = new Error("actual disabled native stream cancellation failure");
    let cancels = 0;
    let reads = 0;
    let calls = 0;
    const source = new ReadableStream<Uint8Array>({
      async cancel() {
        cancels++;
        entered.resolve();
        await held.promise;
        throw cleanup;
      },
    }, { highWaterMark: 0 });
    const acquire = source.getReader.bind(source);
    Object.defineProperty(source, "getReader", {
      value() {
        reads++;
        return acquire();
      },
    });
    const client = createAzureClient({
      endpoint: "https://account.example.test",
      container: "owned",
      credential: { kind: "sas", token: "sig=authored" },
      blockUpload: false,
      fetch: async () => {
        calls++;
        return new Response(null);
      },
    });
    let settled = false;
    const pending = client.put("destination", source).finally(() => settled = true);
    void pending.catch(() => {});
    releases.push(() => within(Promise.allSettled([pending]), "disabled native body fixture drain"));
    releases.push(() => held.resolve());
    await within(entered.promise, "disabled native body cancellation admission");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(cancels).toBe(1);
    expect(reads).toBe(0);
    expect(calls).toBe(0);
    held.resolve();
    const failure = await rejectedResponse(within(pending, "disabled native body retirement outcome"));
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw failure;
    expect(failure.errors).toHaveLength(2);
    expect(failure.errors[0]).toBeInstanceOf(TypeError);
    expect(failure.errors[1]).toBe(cleanup);
    expect(cancels).toBe(1);
    expect(source.locked).toBe(false);
  });
});

describe("Azure readable bytes across blockUpload", () => {
  for (const enabled of [false, true]) {
    it(`accepts genuine foreign bytes under blockUpload=${enabled}`, async () => {
      const bytes: unknown = runInNewContext("new Uint8Array([99,17,31,88]).subarray(1,3)");
      expect(ArrayBuffer.isView(bytes)).toBe(true);
      expect(bytes instanceof Uint8Array).toBe(false);
      let calls = 0;
      const client = createAzureClient({
        endpoint: "https://account.example.test",
        container: "owned",
        credential: { kind: "sas", token: "sig=authored" },
        blockUpload: enabled,
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
      it(`rejects ${kind} zero-length backing under blockUpload=${enabled}`, async () => {
        let calls = 0;
        const client = createAzureClient({
          endpoint: "https://account.example.test",
          container: "owned",
          credential: { kind: "sas", token: "sig=authored" },
          blockUpload: enabled,
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
