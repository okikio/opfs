import { describe, it } from "node:test";
import { expect } from "@std/expect";

import { AZURE_LIMITS, AzureError, createAzureClient } from "../src/azure.ts";
import { createAzureDriver, createAzureDriverFromClient } from "../src/driver/azure.ts";
import { RequestCapture } from "./http.ts";
import { streamBytes } from "./stream.ts";
import { within } from "./gate.ts";
import { withReleases } from "./close.ts";

/** Creates one Azure-style XML response without coupling tests to an HTTP server. */
function xml(value: string, init: ResponseInit = {}): Response {
  return new Response(value, {
    status: 200,
    headers: { "content-type": "application/xml", ...(init.headers ?? {}) },
    ...init,
  });
}

/** Refreshable bearer source used to prove per-request token resolution. */
class BearerTokenSource {
  /** Number of token requests observed. */
  calls = 0;

  /** Returns one token value that identifies its refresh call. */
  get(): string {
    this.calls += 1;
    return `token-${this.calls}`;
  }
}

describe("Azure Blob client", () => {
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
  it("reports direct clients as owned and injected clients as borrowed", () => {
    const options = {
      endpoint: "https://account.blob.core.windows.net",
      container: "data",
      credential: { kind: "sas" as const, token: "?sig=secret" },
      fetch: async () => new Response(null, { status: 200 }),
    };
    const client = createAzureClient(options);

    expect(createAzureDriver(options).inspect().ownership).toBe("owned");
    expect(createAzureDriverFromClient(client).inspect().ownership).toBe("borrowed");
  });

  it("rejects invalid Azure metadata before provider I/O", async () => {
    let requests = 0;
    const client = createAzureClient({
      endpoint: "https://account.blob.core.windows.net",
      container: "data",
      credential: { kind: "sas", token: "?sig=secret" },
      fetch: async () => {
        requests += 1;
        return new Response(null, { status: 201 });
      },
    });

    for (
      const metadata of [
        { "bad-key": "value" },
        { valid_key: "caf\u00e9" },
        { Duplicate: "first", duplicate: "second" },
      ]
    ) {
      try {
        await client.put("metadata.bin", new Uint8Array([1]), { metadata });
        throw new Error("expected Azure metadata validation failure");
      } catch (error) {
        expect(error).toBeInstanceOf(TypeError);
      }
    }

    expect(requests).toBe(0);
  });

  it("keeps SAS authorization on the source URL during provider-side copy", async () => {
    const requests: Request[] = [];
    const client = createAzureClient({
      endpoint: "https://account.blob.core.windows.net",
      container: "data",
      credential: { kind: "sas", token: "?sv=2026-04-06&sig=secret" },
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.method === "HEAD") {
          return new Response(null, { status: 200, headers: { "content-length": "4", etag: '"etag"' } });
        }
        return new Response(null, { status: 202, headers: { "x-ms-copy-status": "success" } });
      },
    });

    await client.copy!("source.txt", "copy.txt");

    const copy = requests.find((request) => request.method === "PUT");
    expect(copy?.headers.get("x-ms-copy-source")).toContain("/data/source.txt?");
    expect(copy?.headers.get("x-ms-copy-source")).toContain("sig=secret");
    expect(new URL(copy!.headers.get("x-ms-copy-source")!).searchParams.get("api-version")).toBe("2026-04-06");
    expect(copy?.headers.get("x-ms-requires-sync")).toBe("true");
  });

  it("exposes behavior-changing Azure optimizations as independent switches", async () => {
    const client = createAzureClient({
      endpoint: "https://account.blob.core.windows.net",
      container: "data",
      credential: { kind: "sas", token: "?sig=secret" },
      blockUpload: false,
      serverCopy: false,
      fetch: async () => new Response(null, { status: 500 }),
    });

    expect(client.optimizations).toEqual({ blockUpload: false, serverCopy: false });
    expect(client.capabilities.streamWrite).toBe(false);
    expect(client.capabilities.copy).toBe(false);

    await expect(client.put("stream.bin", streamBytes([new Uint8Array([1])]))).rejects.toThrow(TypeError);
    await expect(client.copy!("source.bin", "copy.bin")).rejects.toThrow(TypeError);
  });

  it("uses Put Block From URL for blobs above the 256 MiB synchronous copy limit", async () => {
    const requests: Request[] = [];
    const size = 256 * 1024 * 1024 + 1;
    const client = createAzureClient({
      endpoint: "https://account.blob.core.windows.net",
      container: "data",
      credential: { kind: "bearer", token: "token" },
      blockSize: 100 * 1024 * 1024,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        const url = new URL(request.url);
        if (request.method === "HEAD" && url.pathname.endsWith("/source.bin")) {
          return new Response(null, {
            status: 200,
            headers: { "content-length": String(size), etag: '"source-etag"' },
          });
        }
        if (request.method === "HEAD") {
          return new Response(null, { status: 200, headers: { "content-length": String(size), etag: '"copy-etag"' } });
        }
        return new Response(null, { status: 201 });
      },
    });

    await client.copy!("source.bin", "copy.bin", { sourceIfMatch: '"source-etag"' });

    const blocks = requests.filter((request) => new URL(request.url).searchParams.get("comp") === "block").sort(
      (left, right) =>
        Number(left.headers.get("x-ms-source-range")?.match(/^bytes=(\d+)/)?.[1]) -
        Number(right.headers.get("x-ms-source-range")?.match(/^bytes=(\d+)/)?.[1]),
    );
    expect(blocks).toHaveLength(3);
    const blockBytes = 100 * 1024 * 1024;
    for (const [index, block] of blocks.entries()) {
      expect(block.headers.get("x-ms-source-range")).toBe(
        `bytes=${index * blockBytes}-${Math.min(size, (index + 1) * blockBytes) - 1}`,
      );
      expect(block.headers.get("x-ms-copy-source-authorization")).toBe("Bearer token");
      expect(block.headers.get("x-ms-source-if-match")).toBe('"source-etag"');
    }
    expect(requests.some((request) => new URL(request.url).searchParams.get("comp") === "blocklist")).toBe(true);
  });

  it("rejects direct server-side copy before provider I/O when the service version predates the API", async () => {
    let fetches = 0;
    const client = createAzureClient({
      endpoint: "https://account.blob.core.windows.net",
      container: "data",
      credential: { kind: "sas", token: "?sig=secret" },
      version: "2017-11-09",
      fetch: async () => {
        fetches += 1;
        return new Response(null, { status: 500 });
      },
    });

    await expect(client.copy!("source.bin", "copy.bin")).rejects.toMatchObject({ name: "AzureError", status: 400 });
    expect(fetches).toBe(0);
  });

  it("parses Azure list responses with prefixes and continuation markers", async () => {
    const client = createAzureClient({
      endpoint: "https://account.blob.core.windows.net",
      container: "data",
      credential: { kind: "sas", token: "?sig=secret" },
      fetch: async () =>
        xml(`
        <EnumerationResults>
          <Blobs>
            <Blob>
              <Name>root/a.txt</Name>
              <Properties>
                <Content-Length>4</Content-Length>
                <Content-Type>text/plain</Content-Type>
                <Etag>&quot;e&quot;</Etag>
              </Properties>
            </Blob>
            <BlobPrefix><Name>root/nested/</Name></BlobPrefix>
          </Blobs>
          <NextMarker>next</NextMarker>
        </EnumerationResults>`),
    });

    const page = await client.list({ prefix: "root/", delimiter: "/" });
    expect(page.objects[0]?.key).toBe("root/a.txt");
    expect(page.objects[0]?.mediaType).toBe("text/plain");
    expect(page.prefixes).toEqual(["root/nested/"]);
    expect(page.cursor).toBe("next");
  });

  it("retains Azure request IDs and service codes on failures", async () => {
    const client = createAzureClient({
      endpoint: "https://account.blob.core.windows.net",
      container: "data",
      credential: { kind: "sas", token: "?sig=secret" },
      fetch: async () =>
        xml("<Error><Code>AuthorizationFailure</Code><Message>denied</Message></Error>", {
          status: 403,
          headers: { "x-ms-request-id": "request-1" },
        }),
    });

    try {
      await client.get("private.txt");
      throw new Error("expected Azure failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AzureError);
      if (error instanceof AzureError) {
        expect(error.code).toBe("AuthorizationFailure");
        expect(error.requestId).toBe("request-1");
      }
    }
  });
  it("creates the documented Azurite Shared Key canonical signature", async () => {
    let request: Request | undefined;
    const client = createAzureClient({
      endpoint: "http://127.0.0.1:10000/devstoreaccount1",
      container: "opfs-test",
      credential: {
        kind: "shared-key",
        account: "devstoreaccount1",
        key: "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==",
      },
      now: () => new Date("2026-08-14T12:00:00.000Z"),
      fetch: async (input, init) => {
        request = new Request(input, init);
        return new Response(null, { status: 201 });
      },
    });

    await client.request({ method: "PUT", query: { restype: "container" } });

    expect(request?.headers.get("authorization")).toBe(
      "SharedKey devstoreaccount1:h5gDRN/kZdrsO5FfUgKPNZGwb9UgFzqZvIDC5iVFi94=",
    );
    expect(request?.headers.get("x-ms-date")).toBe("Fri, 14 Aug 2026 12:00:00 GMT");
    expect(request?.headers.get("content-length")).toBe("0");
  });

  it("rejects Shared Key service versions older than the implemented signing format", () => {
    expect(() =>
      createAzureClient({
        endpoint: "http://127.0.0.1:10000/devstoreaccount1",
        container: "opfs-test",
        credential: {
          kind: "shared-key",
          account: "devstoreaccount1",
          key: "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==",
        },
        version: "2009-07-17",
      })
    ).toThrow(RangeError);
  });

  it("signs zero Content-Length according to the selected Shared Key service version", async () => {
    const oldCapture = new RequestCapture();
    const modernCapture = new RequestCapture();
    const credential = {
      kind: "shared-key" as const,
      account: "devstoreaccount1",
      key: "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==",
    };
    const options = {
      endpoint: "http://127.0.0.1:10000/devstoreaccount1",
      container: "opfs-test",
      credential,
      now: () => new Date("2026-08-14T12:00:00.000Z"),
    };

    await createAzureClient({ ...options, version: "2014-02-14", fetch: oldCapture.fetch.bind(oldCapture) }).request({
      method: "PUT",
      key: "zero.bin",
      body: new Uint8Array(),
    });
    await createAzureClient({ ...options, version: "2015-02-21", fetch: modernCapture.fetch.bind(modernCapture) })
      .request({
        method: "PUT",
        key: "zero.bin",
        body: new Uint8Array(),
      });

    expect(oldCapture.latest?.headers.get("authorization")).toBe(
      "SharedKey devstoreaccount1:l0m1mkwouin+1Fe6pBOf3LgSCgsrZMzD4luPiqfRonQ=",
    );
    expect(modernCapture.latest?.headers.get("authorization")).toBe(
      "SharedKey devstoreaccount1:JHL00B0fQHliBPS7Gz7O2DcsyB3DwEnHjFUUxfTKvIY=",
    );
  });

  it("omits empty x-ms headers before 2016-05-31 and signs them from that version onward", async () => {
    const credential = {
      kind: "shared-key" as const,
      account: "devstoreaccount1",
      key: "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==",
    };
    const base = {
      endpoint: "http://127.0.0.1:10000/devstoreaccount1",
      container: "opfs-test",
      credential,
      now: () => new Date("2026-08-14T12:00:00.000Z"),
    };

    const legacyEmpty = new RequestCapture();
    const legacyAbsent = new RequestCapture();
    await createAzureClient({ ...base, version: "2015-02-21", fetch: legacyEmpty.fetch.bind(legacyEmpty) }).request({
      method: "HEAD",
      key: "value",
      headers: { "x-ms-meta-empty": "" },
    });
    await createAzureClient({ ...base, version: "2015-02-21", fetch: legacyAbsent.fetch.bind(legacyAbsent) }).request({
      method: "HEAD",
      key: "value",
    });

    const modernEmpty = new RequestCapture();
    const modernAbsent = new RequestCapture();
    await createAzureClient({ ...base, version: "2016-05-31", fetch: modernEmpty.fetch.bind(modernEmpty) }).request({
      method: "HEAD",
      key: "value",
      headers: { "x-ms-meta-empty": "" },
    });
    await createAzureClient({ ...base, version: "2016-05-31", fetch: modernAbsent.fetch.bind(modernAbsent) }).request({
      method: "HEAD",
      key: "value",
    });

    expect(legacyEmpty.latest?.headers.get("authorization")).toBe(legacyAbsent.latest?.headers.get("authorization"));
    expect(modernEmpty.latest?.headers.get("authorization")).not.toBe(
      modernAbsent.latest?.headers.get("authorization"),
    );
  });

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
      const ids = [...(await commit!.text()).matchAll(/<Latest>(.*?)<\/Latest>/g)].map((match) => match[1]!);
      expect(new Set(ids).size).toBe(20);
      // Opaque provider IDs are interpreted only through independently captured request bodies.
      expect(new Uint8Array(ids.flatMap((id) => Array.from(payloads.get(id) ?? [])))).toEqual(bytes);
    }));

  it("rejects source bearer copy authorization before service version 2020-10-02", async () => {
    const client = createAzureClient({
      endpoint: "https://account.blob.core.windows.net",
      container: "data",
      credential: { kind: "bearer", token: "token" },
      version: "2019-12-12",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (request.method === "HEAD") {
          return new Response(null, { status: 200, headers: { "content-length": "4", etag: '"source"' } });
        }
        return new Response(null, { status: 201 });
      },
    });

    await expect(client.copy!("source.bin", "copy.bin")).rejects.toBeInstanceOf(AzureError);
  });

  it("canonicalizes Shared Key query fields independently from insertion order", async () => {
    const first = new RequestCapture();
    const second = new RequestCapture();
    const credential = {
      kind: "shared-key" as const,
      account: "devstoreaccount1",
      key: "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==",
    };
    const base = {
      endpoint: "http://127.0.0.1:10000/devstoreaccount1",
      container: "opfs-test",
      credential,
      now: () => new Date("2026-08-14T12:00:00.000Z"),
    };

    await createAzureClient({ ...base, fetch: first.fetch.bind(first) }).request({
      method: "GET",
      query: { restype: "container", comp: "list", prefix: "root/" },
    });
    await createAzureClient({ ...base, fetch: second.fetch.bind(second) }).request({
      method: "GET",
      query: { prefix: "root/", comp: "list", restype: "container" },
    });

    expect(first.latest?.headers.get("authorization")).toBe(second.latest?.headers.get("authorization"));
  });

  it("collapses unquoted Shared Key whitespace without changing quoted-string whitespace", async () => {
    const now = () => new Date("2026-08-14T12:00:00.000Z");
    const credential = {
      kind: "shared-key" as const,
      account: "devstoreaccount1",
      key: "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==",
    };
    const compact = new RequestCapture();
    const spaced = new RequestCapture();
    const quoted = new RequestCapture();

    await createAzureClient({
      endpoint: "http://127.0.0.1:10000/devstoreaccount1",
      container: "opfs-test",
      credential,
      now,
      fetch: compact.fetch.bind(compact),
    }).request({ method: "HEAD", key: "value", headers: { "x-ms-meta-note": 'alpha beta "two spaces"' } });

    await createAzureClient({
      endpoint: "http://127.0.0.1:10000/devstoreaccount1",
      container: "opfs-test",
      credential,
      now,
      fetch: spaced.fetch.bind(spaced),
    }).request({ method: "HEAD", key: "value", headers: { "x-ms-meta-note": 'alpha   beta "two spaces"' } });

    await createAzureClient({
      endpoint: "http://127.0.0.1:10000/devstoreaccount1",
      container: "opfs-test",
      credential,
      now,
      fetch: quoted.fetch.bind(quoted),
    }).request({ method: "HEAD", key: "value", headers: { "x-ms-meta-note": 'alpha beta "two  spaces"' } });

    expect(compact.latest?.headers.get("authorization")).toBe(spaced.latest?.headers.get("authorization"));
    expect(compact.latest?.headers.get("authorization")).not.toBe(quoted.latest?.headers.get("authorization"));
  });

  it("keeps HTTP evidence when a proxy returns a malformed non-Azure failure body", async () => {
    const client = createAzureClient({
      endpoint: "https://account.blob.core.windows.net",
      container: "data",
      credential: { kind: "sas", token: "?sig=secret" },
      fetch: async () =>
        new Response("upstream gateway failed", {
          status: 502,
          headers: { "x-ms-request-id": "gateway-request" },
        }),
    });

    try {
      await client.get("state.bin");
      throw new Error("expected gateway failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AzureError);
      if (error instanceof AzureError) {
        expect(error.status).toBe(502);
        expect(error.requestId).toBe("gateway-request");
        expect(error.code).toBeUndefined();
        expect(error.message).toContain("HTTP 502");
      }
    }
  });

  it("uses SAS query authorization without adding an Authorization header", async () => {
    const capture = new RequestCapture();
    const client = createAzureClient({
      endpoint: "https://account.blob.core.windows.net",
      container: "data",
      credential: { kind: "sas", token: "?sv=2026-04-06&sig=secret" },
      fetch: capture.fetch.bind(capture),
    });

    await client.request({ method: "HEAD", key: "state.bin" });

    expect(capture.latest?.headers.has("authorization")).toBe(false);
    expect(new URL(capture.latest!.url).searchParams.get("sig")).toBe("secret");
  });

  for (const version of [undefined, "2018-03-28"] as const) {
    it(`uses the ${version ?? "default"} client operation version independently from SAS signing fields`, async () => {
      const capture = new RequestCapture();
      const client = createAzureClient({
        endpoint: "https://account.blob.core.windows.net",
        container: "data",
        ...(version === undefined ? {} : { version }),
        credential: {
          kind: "sas",
          token: "?sv=2015-04-05&sig=a%2Bb%2Fc%3D&sp=r&api-version=2016-05-31&api-version=2017-07-29",
        },
        fetch: capture.fetch.bind(capture),
      });

      await client.request({
        method: "HEAD",
        key: "state.bin",
        query: { "api-version": "2020-10-02" },
        headers: { "x-ms-version": "2020-10-02" },
      });

      const request = capture.latest!;
      const query = new URL(request.url).searchParams;
      expect(query.getAll("api-version")).toEqual([version ?? "2026-04-06"]);
      expect(request.headers.get("x-ms-version")).toBe(version ?? "2026-04-06");
      expect(query.get("sv")).toBe("2015-04-05");
      expect(query.get("sig")).toBe("a+b/c=");
      expect(query.get("sp")).toBe("r");
      expect(request.headers.has("authorization")).toBe(false);
    });
  }

  it("resolves a bearer token immediately before every request", async () => {
    const token = new BearerTokenSource();
    const capture = new RequestCapture();
    const client = createAzureClient({
      endpoint: "https://account.blob.core.windows.net",
      container: "data",
      credential: { kind: "bearer", token: token.get.bind(token) },
      fetch: capture.fetch.bind(capture),
    });

    await client.request({ method: "HEAD", key: "one" });
    await client.request({ method: "HEAD", key: "two" });

    expect(token.calls).toBe(2);
    expect(capture.requests[0]?.headers.get("authorization")).toBe("Bearer token-1");
    expect(capture.requests[1]?.headers.get("authorization")).toBe("Bearer token-2");
  });

  it("does not advertise server-side copy for caller-defined authorization headers", () => {
    const client = createAzureClient({
      endpoint: "https://account.blob.core.windows.net",
      container: "data",
      credential: { kind: "headers", get: () => ({ authorization: "Provider token" }) },
    });

    expect(client.capabilities.copy).toBe(false);
  });

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

describe("Azure request policy", () => {
  it("retries replayable 503 responses and rebuilds authorization per attempt", async () => {
    let attempts = 0;
    let authCalls = 0;
    const client = createAzureClient({
      endpoint: "https://account.blob.core.windows.net",
      container: "container",
      credential: {
        kind: "headers",
        get: () => ({ authorization: `test-${++authCalls}` }),
      },
      request: { retries: 1, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      fetch: async (_input, init) => {
        attempts += 1;
        expect(init?.redirect).toBe("manual");
        return new Response(null, { status: attempts === 1 ? 503 : 200 });
      },
    });

    const response = await client.request({ method: "PUT", key: "retry.bin", body: new Uint8Array([1]) });

    expect(response.status).toBe(200);
    expect(attempts).toBe(2);
    expect(authCalls).toBe(2);
    expect(client.getMetrics().retries).toBe(1);
  });

  it("retries a replayable Fetch transport failure and returns the next response", async () => {
    let attempts = 0;
    const client = createAzureClient({
      endpoint: "https://account.blob.core.windows.net",
      container: "container",
      credential: { kind: "sas", token: "sv=test&sig=test" },
      request: { retries: 1, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      fetch: async () => {
        attempts += 1;
        if (attempts === 1) throw new TypeError("temporary network failure");
        return new Response(null, { status: 200 });
      },
    });

    const response = await client.request({ method: "GET", key: "retry-network.bin" });

    expect(response.status).toBe(200);
    expect(attempts).toBe(2);
    expect(client.getMetrics().retries).toBe(1);
    expect(client.getMetrics().failures).toBe(0);
  });

  it("does not retry deterministic authorization failures", async () => {
    let authCalls = 0;
    let fetches = 0;
    const client = createAzureClient({
      endpoint: "https://account.blob.core.windows.net",
      container: "container",
      credential: {
        kind: "headers",
        get: () => {
          authCalls += 1;
          throw new TypeError("invalid authorization input");
        },
      },
      request: { retries: 4, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      fetch: async () => {
        fetches += 1;
        return new Response(null, { status: 200 });
      },
    });

    await expect(client.request({ method: "GET", key: "key" })).rejects.toThrow("invalid authorization input");
    expect(authCalls).toBe(1);
    expect(fetches).toBe(0);
  });

  it("lets a low-level caller disable retry for a replayable request", async () => {
    let attempts = 0;
    const client = createAzureClient({
      endpoint: "https://account.blob.core.windows.net",
      container: "container",
      credential: { kind: "sas", token: "sv=test&sig=test" },
      request: { retries: 4, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      fetch: async () => {
        attempts += 1;
        return new Response(null, { status: 503 });
      },
    });

    const response = await client.request({ method: "PUT", key: "once.bin", body: new Uint8Array([1]), retry: false });
    expect(response.status).toBe(503);
    expect(attempts).toBe(1);
  });

  it("does not retry a one-shot streamed request body", async () => {
    let attempts = 0;
    const client = createAzureClient({
      endpoint: "https://account.blob.core.windows.net",
      container: "container",
      credential: { kind: "sas", token: "sv=test&sig=test" },
      request: { retries: 4, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      fetch: async () => {
        attempts += 1;
        return new Response(null, { status: 503 });
      },
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });

    const response = await client.request({ method: "PUT", key: "stream.bin", body });

    expect(response.status).toBe(503);
    expect(attempts).toBe(1);
  });
});

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
          const ids = [...(await request.text()).matchAll(/<Latest>(.*?)<\/Latest>/g)].map((match) => match[1]!);
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
