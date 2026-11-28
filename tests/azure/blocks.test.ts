/** Azure: Block writes retain logical order, service limits and cancellation. */
import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { AZURE_LIMITS, createAzureClient } from "../../src/backend/azure/client.ts";
import { streamBytes } from "../stream.ts";
import { within } from "../gate.ts";
import { withReleases } from "../close.ts";
import { latestBlocks, rejectedResponse } from "./fixture.ts";

describe("Azure Blob client", () => {
  it("keeps mapper-only cancellation while an owned azure part response retires", async () => {
    await withReleases(async (releases) => {
      const reason = new Error("Authored cancellation after a part acknowledgement.");
      const controller = new AbortController();
      const admitted = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      let pulls = 0;
      let cancellations = 0;
      let retirements = 0;
      let parts = 0;
      let completed = 0;
      let aborted = 0;
      let settled = false;
      const source = new ReadableStream<Uint8Array>({
        pull(stream) {
          if (pulls++ === 0) stream.enqueue(new Uint8Array(4));
        },
        cancel() {
          cancellations++;
        },
      }, { highWaterMark: 0 });
      const client = createAzureClient({
        endpoint: "https://account.blob.core.windows.net",
        container: "data",
        credential: { kind: "sas", token: "?sig=test" },
        blockSize: 4,
        concurrency: 1,
        request: { retries: 0 },
        fetch: async (input, init) => {
          const request = new Request(input, init);
          const url = new URL(request.url);
          if (url.searchParams.get("comp") === "block") {
            parts++;
            controller.abort(reason);
            return new Response(
              new ReadableStream<Uint8Array>({
                async cancel() {
                  retirements++;
                  admitted.resolve();
                  await finish.promise;
                  throw reason;
                },
              }, { highWaterMark: 0 }),
              { status: 201 },
            );
          }
          if (url.searchParams.get("comp") === "blocklist") completed++;
          if (request.method === "DELETE") aborted++;
          return new Response(null, { status: 204 });
        },
      });
      const pending = rejectedResponse(client.put("mapper-cancel.bin", source, { signal: controller.signal }))
        .finally(() => {
          settled = true;
        });
      releases.push(() => pending);
      releases.push(() => finish.resolve());
      releases.push(() => controller.abort(reason));
      await within(admitted.promise, "owned part response retirement admission");
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);
      // Input cancellation can finish while the acquired response still has
      // real cleanup pending; the public operation must join both owners.
      expect(source.locked).toBe(false);
      expect(cancellations).toBe(1);
      expect(completed).toBe(0);
      finish.resolve();
      const failure = await within(pending, "owned part response retirement settlement");
      if (!(failure instanceof AggregateError)) {
        throw new Error("Expected the actual operation-owned mapper aggregate.");
      }
      expect(failure.errors).toHaveLength(1);
      expect(failure.errors[0]).toBe(reason);
      expect(parts).toBe(1);
      expect(retirements).toBe(1);
      expect(completed).toBe(0);
      expect(aborted).toBe(0);
      expect(pulls).toBe(1);
      expect(cancellations).toBe(1);
      expect(source.locked).toBe(false);
    });
  });

  for (const failure of ["producer", "caller"] as const) {
    it(`preserves the ${failure} reason after admitted Azure chunks drain`, async () => {
      const reason = new Error(`${failure} terminal reason`);
      const controller = new AbortController();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let requests = 0;
      let completed = 0;
      let aborted = 0;
      let cancelled = 0;
      let pulls = 0;
      const source = new ReadableStream<Uint8Array>({
        pull(stream) {
          if (pulls++ === 0) stream.enqueue(new Uint8Array(4));
          else if (failure === "producer") stream.error(reason);
        },
        cancel() {
          cancelled += 1;
        },
      }, { highWaterMark: 0 });
      const client = createAzureClient({
        endpoint: "https://account.blob.core.windows.net",
        container: "data",
        credential: { kind: "sas", token: "?sig=test" },
        blockSize: 4,
        concurrency: 2,
        request: { retries: 0 },
        fetch: async (input, init) => {
          const request = new Request(input, init);
          const url = new URL(request.url);

          if (url.searchParams.get("comp") === "block") {
            requests += 1;
            entered.resolve();
            if (failure === "caller") controller.abort(reason);
            await release.promise;
            return new Response(null, { status: 200, headers: { etag: '"part"' } });
          }
          if (url.searchParams.get("comp") === "blocklist") completed += 1;
          if (request.method === "DELETE") aborted += 1;
          return new Response(null, { status: 204 });
        },
      });
      const pending = client.put("failure.bin", source, { signal: controller.signal });
      void pending.catch(() => {});
      try {
        await within(entered.promise, "provider chunk admission");
        release.resolve();
        await expect(within(pending, "provider source failure")).rejects.toBe(reason);
        expect(requests).toBe(1);
        expect(completed).toBe(0);
        expect(source.locked).toBe(false);
        if (failure === "caller") expect(cancelled).toBe(1);
        expect(aborted).toBe(0);
      } finally {
        controller.abort(reason);
        release.resolve();
        await within(Promise.allSettled([pending]), "provider fixture drain");
      }
    });
  }

  it("validates block size against the selected Azure REST service version", () => {
    expect(() =>
      createAzureClient({
        endpoint: "https://account.blob.core.windows.net",
        container: "data",
        credential: { kind: "sas", token: "?sig=secret" },
        version: "2015-04-05",
        blockSize: AZURE_LIMITS.legacyBlockBytes + 1,
      })
    ).toThrow(RangeError);
  });

  it("keeps conditions at publication and commits logical bytes despite reversed block responses", async () =>
    await withReleases(async (releases) => {
      const bytes = Uint8Array.from({ length: 80 }, (_, index) => index + 1);
      const payloads = new Map<string, Uint8Array>();
      const responses: Array<{ first: number; release: () => void; done: Promise<void> }> = [];
      const completed: number[] = [];
      let admit!: () => void;
      const admitted = new Promise<void>((resolve) => admit = resolve);
      const requests: Request[] = [];
      const owned: { upload?: Promise<unknown> } = {};
      let releasing = false;
      // Release every admitted transport before draining the upload on failure.
      releases.push(async () => {
        releasing = true;
        for (const response of responses.toReversed()) response.release();
        if (owned.upload !== undefined) await within(Promise.allSettled([owned.upload]), "Azure block-order teardown");
      });
      const client = createAzureClient({
        endpoint: "https://account.blob.core.windows.net",
        container: "data",
        credential: { kind: "sas", token: "?sig=secret" },
        blockSize: 4,
        concurrency: 20,
        fetch: async (input, init) => {
          const request = new Request(input, init);
          requests.push(request);
          const url = new URL(request.url);
          if (url.searchParams.get("comp") === "block") {
            const payload = new Uint8Array(await request.arrayBuffer());
            payloads.set(url.searchParams.get("blockid")!, payload);
            let release!: () => void;
            const paused = new Promise<void>((resolve) => release = resolve);
            let finish!: () => void;
            const done = new Promise<void>((resolve) => finish = resolve);
            responses.push({ first: payload[0]!, release, done });
            if (responses.length === 20) admit();
            if (releasing) release();
            await paused;
            completed.push(payload[0]!);
            finish();
          }
          return new Response(null, { status: 201 });
        },
      });
      const upload = owned.upload = client.put("stream.bin", streamBytes([bytes]), {
        ifNoneMatch: "*",
        size: bytes.length,
      });
      void upload.catch(() => {});
      await within(admitted, "twenty Azure block requests admitted");
      // Observe each released response before admitting the next; promise
      // resolution order alone does not determine continuation order.
      for (const response of responses.toSorted((a, b) => b.first - a.first)) {
        response.release();
        await within(response.done, "Azure block response completion");
      }
      await within(upload, "Azure reversed block responses");
      const blocks = requests.filter((request) => new URL(request.url).searchParams.get("comp") === "block");
      const commit = requests.find((request) => new URL(request.url).searchParams.get("comp") === "blocklist");
      expect(blocks).toHaveLength(20);
      expect(blocks.every((request) => !request.headers.has("if-none-match"))).toBe(true);
      expect(completed).toEqual(Array.from({ length: 20 }, (_, index) => 77 - index * 4));
      expect(commit?.headers.get("if-none-match")).toBe("*");
      const ids = latestBlocks(await commit!.text());
      expect(new Set(ids).size).toBe(20);
      // Opaque provider IDs are interpreted only through independently captured request bodies.
      expect(new Uint8Array(ids.flatMap((id) => Array.from(payloads.get(id) ?? [])))).toEqual(bytes);
    }));

  it("expands a known streamed block size to stay within 50,000 committed blocks", async () => {
    const requests: Request[] = [];
    const client = createAzureClient({
      endpoint: "https://account.blob.core.windows.net",
      container: "data",
      credential: { kind: "sas", token: "?sig=secret" },
      blockSize: 1,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return new Response(null, { status: 201 });
      },
    });

    await expect(client.put(
      "planned.bin",
      streamBytes([new Uint8Array([1, 2, 3, 4])]),
      { size: AZURE_LIMITS.maxCommittedBlocks + 1 },
    )).rejects.toThrow(RangeError);

    const blocks = requests.filter((request) => new URL(request.url).searchParams.get("comp") === "block");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.headers.get("content-length")).toBe("2");
    expect(blocks[1]?.headers.get("content-length")).toBe("2");
    expect(requests.some((request) => new URL(request.url).searchParams.get("comp") === "blocklist")).toBe(false);
  });

  it("rejects a declared blob larger than the selected service-version block plan before Fetch", async () => {
    let fetches = 0;
    const client = createAzureClient({
      endpoint: "https://account.blob.core.windows.net",
      container: "data",
      credential: { kind: "sas", token: "?sig=secret" },
      fetch: async () => {
        fetches += 1;
        return new Response(null, { status: 500 });
      },
    });
    const max = AZURE_LIMITS.currentBlockBytes * AZURE_LIMITS.maxCommittedBlocks;

    await expect(client.put(
      "too-large.bin",
      streamBytes([new Uint8Array([1])]),
      { size: max + 1 },
    )).rejects.toThrow(RangeError);
    expect(fetches).toBe(0);
  });
});
