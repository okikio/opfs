/** Azure: Publications retain their own result, revision and failure disposition. */
import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { AzureError, createAzureClient } from "../../src/backend/azure/client.ts";
import { streamBytes } from "../stream.ts";
import { within } from "../gate.ts";
import { withReleases } from "../close.ts";
import { latestBlocks, rejectedResponse, xml } from "./fixture.ts";

describe("Azure publication contracts", () => {
  const options = {
    endpoint: "https://account.blob.core.windows.net",
    container: "data",
    credential: { kind: "sas" as const, token: "sig=test" },
  };

  it("returns the publishing response identity without observing a peer's HEAD", async () => {
    const methods: string[] = [];
    const client = createAzureClient({
      ...options,
      fetch: async (_input, init) => {
        methods.push(init!.method!);
        return new Response(null, { status: 201, headers: { etag: '"own"', "x-ms-request-id": "own-request" } });
      },
    });
    expect(await client.put("value", new Uint8Array([1, 2]), { mediaType: "text/plain", metadata: { owner: "first" } }))
      .toMatchObject({
        size: 2,
        etag: '"own"',
        requestId: "own-request",
        mediaType: "text/plain",
        metadata: { owner: "first" },
      });
    expect(methods).toEqual(["PUT"]);
  });

  it("never combines blocks from overlapping upload attempts", async () =>
    await withReleases(async (releases) => {
      const blocks = new Map<string, Uint8Array>();
      const identities = new Set<string>();
      let staged = 0;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => {
        release = resolve;
      });
      let uploads: Promise<unknown>[] = [];
      releases.push(async () => {
        release();
        await within(Promise.allSettled(uploads), "Concurrent Azure publication teardown");
      });
      let published = new Uint8Array();
      const client = createAzureClient({
        ...options,
        blockSize: 2,
        fetch: async (input, init) => {
          const request = new Request(input, init);
          const url = new URL(request.url);
          if (url.searchParams.get("comp") === "block") {
            const id = url.searchParams.get("blockid")!;
            identities.add(id);
            blocks.set(id, new Uint8Array(await request.arrayBuffer()));
            if (++staged === 4) release();
            return new Response(null, { status: 201 });
          }
          await ready;
          const ids = latestBlocks(await request.text());
          if (ids.some((id) => !blocks.has(id))) return new Response(null, { status: 400 });
          published = new Uint8Array(ids.flatMap((id) => Array.from(blocks.get(id)!)));
          blocks.clear();
          return new Response(null, { status: 201, headers: { etag: '"own"' } });
        },
      });
      uploads = [
        client.put("same", streamBytes([new Uint8Array([1, 1, 1, 1])])),
        client.put("same", streamBytes([new Uint8Array([2, 2, 2, 2])])),
      ];
      const settled = Promise.allSettled(uploads);
      const results = await within(
        settled,
        "Concurrent Azure publication",
      );
      expect(identities.size).toBe(4);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(published[0] === 1 || published[0] === 2).toBe(true);
      expect(Array.from(published)).toEqual(Array(4).fill(published[0]));
    }));

  it("reports a lost dispatched acknowledgement without replaying publication", async () => {
    const cause = new Error("response lost after server commit");
    let calls = 0;
    const client = createAzureClient({
      ...options,
      fetch: async () => {
        calls++;
        throw cause;
      },
    });
    await expect(client.put("value", new Uint8Array([1]))).rejects.toMatchObject({
      effect: "unknown",
      key: "value",
      cause,
    });
    expect(calls).toBe(1);
  });

  it("keeps an authorization failure distinct from an unknown publication", async () => {
    const cause = new Error("token unavailable");
    const client = createAzureClient({
      ...options,
      credential: {
        kind: "bearer",
        token: () => {
          throw cause;
        },
      },
      fetch: async () => {
        throw new Error("must not dispatch");
      },
    });
    await expect(client.put("value", new Uint8Array([1]))).rejects.toBe(cause);
  });

  it("rejects nonzero declarations on empty streams before publishing", async () => {
    let calls = 0;
    const client = createAzureClient({
      ...options,
      fetch: async () => {
        calls++;
        return new Response(null, { status: 201 });
      },
    });
    await expect(client.put("value", streamBytes([]), { size: 1 })).rejects.toBeInstanceOf(RangeError);
    expect(calls).toBe(0);
  });

  it("preserves literal and explicitly encoded listing identities and opaque markers", async () => {
    const client = createAzureClient({
      ...options,
      fetch: async () =>
        xml(
          '<EnumerationResults><Blobs><Blob><Name> value </Name><Properties><Content-Length>1</Content-Length></Properties></Blob><Blob><Name Encoded="true">%20%2F%25%20</Name><Properties><Content-Length>0</Content-Length></Properties></Blob><BlobPrefix><Name> prefix/ </Name></BlobPrefix></Blobs><NextMarker> marker%20 </NextMarker></EnumerationResults>',
        ),
    });
    const page = await client.list({ prefix: "" });
    expect(page.objects.map((object) => object.key)).toEqual([" value ", " /% "]);
    expect(page.prefixes).toEqual([" prefix/ "]);
    expect(page.cursor).toBe(" marker%20 ");
  });

  it("rejects Fetch-normalized key paths before dispatch or source consumption", async () => {
    let calls = 0;
    let pulls = 0;
    const client = createAzureClient({
      ...options,
      fetch: async () => {
        calls++;
        return new Response();
      },
    });
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.close();
      },
    }, { highWaterMark: 0 });
    await expect(client.put("a/../b", body)).rejects.toBeInstanceOf(TypeError);
    await expect(client.copy("source", "a/./b")).rejects.toBeInstanceOf(TypeError);
    expect({ calls, pulls }).toEqual({ calls: 0, pulls: 0 });
    await body.cancel();
  });
  it("pins every copied range to the source revision admitted by HEAD", async () => {
    const reads: Headers[] = [];
    let headHeaders: Headers | undefined;
    const client = createAzureClient({
      ...options,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (request.method === "HEAD") {
          headHeaders = request.headers;
          return new Response(null, {
            status: 200,
            headers: { "content-length": "314572800", etag: '"source-version"' },
          });
        }
        if (request.headers.has("x-ms-source-if-match")) reads.push(request.headers);
        return new Response(null, { status: 201, headers: { etag: "own" } });
      },
    });
    const receipt = await client.copy("source", "destination", { sourceIfMatch: "*" });
    expect(headHeaders!.get("if-match")).toBe("*");
    expect(reads.length).toBeGreaterThan(1);
    expect(reads.every((headers) => headers.get("x-ms-source-if-match") === '"source-version"')).toBe(true);
    expect(receipt).toMatchObject({ size: 314572800, etag: "own" });
  });

  it("rejects known impossible physical routes without provider I/O", () => {
    const client = createAzureClient({
      ...options,
      blockUpload: false,
      version: "2015-04-05",
      fetch: async () => {
        throw new Error("preflight must not dispatch");
      },
    });
    expect(client.admit!({ operation: "write", source: "bytes", path: "/value", size: 68157440 }).supported).toBe(
      false,
    );
    expect(client.admit!({ operation: "write", source: "stream", path: "/value" }).supported).toBe(false);
  });
  it("copies the immutable source version when the provider identifies it", async () => {
    let address: string | null = null;
    const client = createAzureClient({
      ...options,
      fetch: async (_input, init) => {
        if (init!.method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: { "content-length": "1", etag: "source", "x-ms-version-id": "source+version" },
          });
        }
        address = new Headers(init!.headers).get("x-ms-copy-source");
        return new Response(null, { status: 201, headers: { etag: "own", "x-ms-copy-status": "success" } });
      },
    });
    expect(await client.copy("source", "destination")).toMatchObject({ size: 1, etag: "own" });
    expect(new URL(address!).searchParams.get("versionid")).toBe("source+version");
  });

  for (const route of ["bytes", "stream"] as const) {
    it(`${route} publication owns its metadata and conditions before asynchronous work`, async () => {
      const policy = { metadata: { owner: "original" }, mediaType: "text/plain", ifNoneMatch: "*", size: 1 };
      const headers: Headers[] = [];
      const client = createAzureClient({
        ...options,
        blockSize: 1,
        fetch: async (input, init) => {
          const url = new URL(String(input));
          headers.push(new Headers(init!.headers));
          policy.metadata.owner = "mutated";
          policy.mediaType = "application/json";
          policy.ifNoneMatch = "peer";
          expect(url.pathname.endsWith("/value")).toBe(true);
          return new Response(null, { status: 201, headers: { etag: "own" } });
        },
      });
      const bytes = new Uint8Array([1]);
      const receipt = await client.put("value", route === "bytes" ? bytes : streamBytes([bytes]), policy);
      expect(receipt).toMatchObject({ size: 1, mediaType: "text/plain", metadata: { owner: "original" } });
      const published = headers.filter((header) => header.has("x-ms-meta-owner"));
      expect(published.length).toBe(1);
      expect(published[0]!.get("x-ms-meta-owner")).toBe("original");
      expect(headers.at(-1)!.get("if-none-match")).toBe("*");
      policy.metadata.owner = "later";
      expect(receipt.metadata).toEqual({ owner: "original" });
    });
  }
  it("owns mutable source dates through property lookup and copy", async () => {
    const date = new Date("2024-01-01T00:00:00Z");
    const expected = date.toUTCString();
    let copied: string | null = null;
    const client = createAzureClient({
      ...options,
      fetch: async (_input, init) => {
        if (init!.method === "HEAD") {
          expect(new Headers(init!.headers).get("if-unmodified-since")).toBe(expected);
          date.setFullYear(2030);
          return new Response(null, { headers: { "content-length": "1", etag: "source" } });
        }
        copied = new Headers(init!.headers).get("x-ms-source-if-unmodified-since");
        return new Response(null, { status: 201, headers: { etag: "own", "x-ms-copy-status": "success" } });
      },
    });
    await client.copy("source", "destination", { sourceIfUnmodifiedSince: date });
    expect(copied).toBe(expected);
  });

  it("attributes normalized wire metadata and configured defaults to the publication", async () => {
    const client = createAzureClient({
      ...options,
      headers: { "x-ms-meta-owner": " default ", "x-ms-blob-content-type": " text/plain " },
      fetch: async (_input, init) => {
        const headers = new Headers(init!.headers);
        expect(headers.get("x-ms-meta-owner")).toBe("before");
        expect(headers.get("x-ms-blob-content-type")).toBe("text/plain");
        return new Response(null, { status: 201, headers: { etag: "own" } });
      },
    });
    const receipt = await client.put("value", new Uint8Array([1]), { metadata: { OWNER: " before " } });
    expect(receipt).toMatchObject({ size: 1, mediaType: "text/plain", metadata: { owner: "before" } });
  });

  it("treats a server/proxy publication failure as uncertain without replay", async () => {
    let requests = 0;
    const client = createAzureClient({
      ...options,
      fetch: async () => {
        requests++;
        return new Response("gateway lost the upstream response", { status: 504 });
      },
    });
    let failure: unknown;
    try {
      await client.put("value", new Uint8Array([1]));
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ effect: "unknown", key: "value", cause: { status: 504 } });
    expect((failure as Error).cause).toBeInstanceOf(AzureError);
    expect(requests).toBe(1);
  });
});

describe("Azure invocation-owned publication and input", () => {
  const options = {
    endpoint: "https://account.example.test",
    container: "owned",
    credential: { kind: "sas" as const, token: "sig=authored" },
  };
  it("does not borrow known HTTP refusal from a foreign transport AzureError", async () => {
    const foreign = new AzureError("foreign transport reason", new Response(null, { status: 403 }));
    let calls = 0;
    const client = createAzureClient({
      ...options,
      fetch: async () => {
        calls++;
        throw foreign;
      },
    });
    expect(await rejectedResponse(client.put("destination", Uint8Array.of(17)))).toMatchObject({
      effect: "unknown",
      cause: foreign,
    });
    expect(calls).toBe(1);
  });

  it("joins failed block work and interrupts pending input without a final block list", async () => {
    const stalled = Promise.withResolvers<void>();
    const cleanup = new Error("actual Azure source cancel fault");
    let reads = 0;
    let cancels = 0;
    let commits = 0;
    let native: ReadableStreamDefaultController<Uint8Array> | undefined;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        native = controller;
      },
      pull(controller) {
        if (reads++ === 0) controller.enqueue(Uint8Array.of(17));
        else stalled.resolve();
      },
      cancel() {
        cancels++;
        throw cleanup;
      },
    }, { highWaterMark: 0 });
    const client = createAzureClient({
      ...options,
      blockSize: 1,
      concurrency: 2,
      request: { retries: 0 },
      fetch: async (input) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if (url.searchParams.get("comp") === "block") {
          await stalled.promise;
          return new Response("<Error><Code>AuthenticationFailed</Code></Error>", { status: 403 });
        }
        commits++;
        return new Response(null, { status: 201 });
      },
    });
    const pending = client.put("destination", source);
    void pending.catch(() => {});
    try {
      await within(stalled.promise, "Azure pending input");
      const failure = await rejectedResponse(within(pending, "Azure owned input retirement"));
      expect(failure).toBeInstanceOf(AggregateError);
      if (!(failure instanceof AggregateError)) throw failure;
      expect(failure.errors[0]).toMatchObject({ errors: [expect.any(AzureError)] });
      expect(failure.errors[1]).toBe(cleanup);
      expect(commits).toBe(0);
      expect(cancels).toBe(1);
      expect(source.locked).toBe(false);
    } finally {
      stalled.resolve();
      native?.error(new Error("Azure stalled-input fixture teardown"));
      await within(Promise.allSettled([pending]), "Azure stalled-input cleanup");
    }
  });

  it("retains refusal and failed source retirement when streamed blocks are disabled", async () => {
    const cleanup = new Error("disabled Azure source retirement failed");
    let calls = 0;
    const source = new ReadableStream<Uint8Array>({
      cancel() {
        throw cleanup;
      },
    }, { highWaterMark: 0 });
    const client = createAzureClient({
      ...options,
      blockUpload: false,
      fetch: async () => {
        calls++;
        return new Response(null);
      },
    });
    const failure = await rejectedResponse(client.put("destination", source));
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw failure;
    expect(failure.errors[0]).toBeInstanceOf(TypeError);
    expect(failure.errors[1]).toBe(cleanup);
    expect(calls).toBe(0);
  });
});

it("uses disjoint staged block identities for interleaved uploads to one blob", async () => {
  const staged = new Map<string, Uint8Array>();
  const commits: string[][] = [];
  const bodies: number[][] = [];
  const client = createAzureClient({
    endpoint: "https://storage.example",
    container: "container",
    credential: { kind: "sas", token: "sig=test" },
    blockSize: 1,
    concurrency: 1,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.searchParams.get("comp") === "block") {
        staged.set(url.searchParams.get("blockid")!, new Uint8Array(await request.arrayBuffer()));
        await Promise.resolve();
      } else if (url.searchParams.get("comp") === "blocklist") {
        const ids = latestBlocks(await request.text());
        commits.push(ids);
        bodies.push(ids.flatMap((id) => [...staged.get(id)!]));
      }
      return new Response(null, { status: 201 });
    },
  });
  await Promise.all([
    client.put("same", streamBytes([new Uint8Array([1, 2])])),
    client.put("same", streamBytes([new Uint8Array([3, 4])])),
  ]);
  expect(commits).toHaveLength(2);
  expect(commits[0]!.some((id) => commits[1]!.includes(id))).toBe(false);
  expect(bodies.sort((a, b) => a[0]! - b[0]!)).toEqual([[1, 2], [3, 4]]);
});
