import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { openHttpSource } from "../src/http.ts";
import type { FetchType } from "../src/request.ts";

/** Independent representation bytes and HTTP range arithmetic, separate from the source implementation. */
function service(): { fetch: FetchType; calls: RequestInit[]; replace(): void } {
  const calls: RequestInit[] = [];
  let etag = '"first"';
  const bytes = new TextEncoder().encode("abcdef");
  return {
    calls,
    replace() {
      etag = '"next"';
    },
    async fetch(_input, init = {}) {
      calls.push(init);
      const headers = new Headers(init.headers);
      if (init.method === "HEAD") return new Response(null, { headers: { "content-length": "6", etag } });
      if (headers.get("if-match") !== etag) return new Response(null, { status: 412 });
      const match = /^bytes=(\d+)-(\d+)$/.exec(headers.get("range") ?? "");
      if (!match) throw new Error("Expected exact range");
      const start = Number(match[1]), end = Number(match[2]);
      return new Response(bytes.slice(start, end + 1), {
        status: 206,
        headers: { etag, "content-range": `bytes ${start}-${end}/6`, "content-length": String(end - start + 1) },
      });
    },
  };
}

describe("HTTP single-resource source", () => {
  it("binds selected bytes to one strong validator without inventing a tree or replay identity", async () => {
    const server = service();
    const source = await openHttpSource("https://files.example/data?id=one", { fetch: server.fetch });
    expect(source.identity).toBeUndefined();
    expect(source.stability).toBe("provider");
    expect(new TextDecoder().decode(await source.read(2, 3))).toBe("cde");
    expect(await source.read(6, 0)).toEqual(new Uint8Array());
    expect(server.calls.length).toBe(2);
    expect(server.calls[1]?.credentials).toBe("omit");
    expect(server.calls[1]?.redirect).toBe("manual");
    expect(new Headers(server.calls[1]?.headers).get("if-match")).toBe('"first"');
    server.replace();
    await expect(source.read(0, 1)).rejects.toMatchObject({ status: 412 });
  });

  it("lets the caller bind replay identity and refresh credentials without replacing protocol headers", async () => {
    const server = service();
    let credentials = 0;
    const source = await openHttpSource("https://files.example/item?token=secret", {
      fetch: server.fetch,
      identity: "account-one/object-one/v1",
      headers: () => {
        credentials++;
        return { authorization: "Bearer short-lived", range: "bytes=0-999", "if-match": '"wrong"' };
      },
    });
    expect(source.identity).toContain("account-one/object-one/v1");
    expect(source.identity).not.toContain("secret");
    expect(await source.read(0, 1)).toEqual(new Uint8Array([97]));
    expect(credentials).toBe(2);
    expect(new Headers(server.calls[1]?.headers).get("range")).toBe("bytes=0-0");
  });

  it("removes caller routing, framing and conditional authority on HEAD and each GET attempt", async () => {
    const supplied = {
      authorization: "Bearer caller-owned",
      "x-tenant": "tenant-a",
      host: "other.example",
      "content-length": "99",
      "transfer-encoding": "chunked",
      range: "bytes=3-5",
      "if-range": '"old"',
      "if-match": '"wrong"',
      "if-none-match": "*",
      "if-modified-since": "Wed, 01 Jan 2020 00:00:00 GMT",
      "if-unmodified-since": "Wed, 01 Jan 2020 00:00:00 GMT",
      "accept-encoding": "gzip",
    };
    for (const headers of [supplied, () => supplied]) {
      let gets = 0;
      const source = await openHttpSource("https://files.example/data", {
        headers,
        policy: { retries: 1, minDelayMs: 0, maxDelayMs: 0 },
        fetch: async (input, init) => {
          expect(new URL(String(input)).host).toBe("files.example");
          const sent = new Headers(init?.headers);
          for (
            const name of [
              "host",
              "content-length",
              "transfer-encoding",
              "if-range",
              "if-none-match",
              "if-modified-since",
              "if-unmodified-since",
            ]
          ) expect(sent.has(name), name).toBe(false);
          expect(sent.get("authorization")).toBe("Bearer caller-owned");
          expect(sent.get("x-tenant")).toBe("tenant-a");
          expect(sent.get("accept-encoding")).toBe("identity");
          if (init?.method === "HEAD") {
            expect(sent.has("range")).toBe(false);
            expect(sent.has("if-match")).toBe(false);
            return new Response(null, { headers: { "content-length": "6", etag: '"first"' } });
          }
          expect(sent.get("range")).toBe("bytes=1-2");
          expect(sent.get("if-match")).toBe('"first"');
          if (++gets === 1) return new Response(null, { status: 503 });
          return new Response("bc", {
            status: 206,
            headers: { "content-range": "bytes 1-2/6", "content-length": "2", etag: '"first"' },
          });
        },
      });
      expect(await source.read(1, 2)).toEqual(new TextEncoder().encode("bc"));
      expect(gets).toBe(2);
      expect(supplied["if-none-match"]).toBe("*");
    }
  });
  it("does not inherit caller conditions for explicitly stable resources without an ETag", async () => {
    const source = await openHttpSource("https://files.example/data", {
      assumeStable: true,
      headers: { "if-match": '"caller"', "if-none-match": "*", "if-range": '"caller"' },
      fetch: async (_input, init) => {
        const sent = new Headers(init?.headers);
        for (const field of ["if-match", "if-none-match", "if-range"]) expect(sent.has(field)).toBe(false);
        return init?.method === "HEAD"
          ? new Response(null, { headers: { "content-length": "3" } })
          : new Response("b", { status: 206, headers: { "content-range": "bytes 1-1/3", "content-length": "1" } });
      },
    });
    expect(await source.read(1, 1)).toEqual(new TextEncoder().encode("b"));
  });
  it("requires a known safe size and strong revision unless stability is explicitly asserted", async () => {
    for (
      const headers of [{}, { "content-length": "1.5" }, { "content-length": "9007199254740992" }, {
        "content-length": "6",
        etag: 'W/"one"',
      }]
    ) {
      await expect(openHttpSource("https://files.example/item", { fetch: async () => new Response(null, { headers }) }))
        .rejects.toThrow();
    }
    const asserted = await openHttpSource("https://files.example/item", {
      assumeStable: true,
      fetch: async () => new Response(null, { headers: { "content-length": "6" } }),
    });
    expect(asserted.stability).toBe("caller");
  });

  it("refuses invalid URLs and pre-aborts before credential acquisition", async () => {
    let credentials = 0;
    const options = {
      headers: () => {
        credentials++;
        return {};
      },
    };
    for (
      const url of ["file:///private/data", "https://user:pass@files.example/data", "https://files.example/data#part"]
    ) await expect(openHttpSource(url, options)).rejects.toThrow();
    const controller = new AbortController();
    controller.abort("cancel admission");
    await expect(openHttpSource("https://files.example/data", { ...options, signal: controller.signal })).rejects.toBe(
      "cancel admission",
    );
    expect(credentials).toBe(0);
  });

  it("retires redirects and does not forward authentication to their Location", async () => {
    let requests = 0, cancelled = 0;
    await expect(openHttpSource("https://files.example/data", {
      headers: { authorization: "Bearer private" },
      fetch: async (_url, init) => {
        requests++;
        expect(init?.redirect).toBe("manual");
        return new Response(
          new ReadableStream({
            cancel() {
              cancelled++;
            },
          }),
          { status: 302, headers: { location: "https://other.example/data" } },
        );
      },
    })).rejects.toMatchObject({ status: 302 });
    expect(requests).toBe(1);
    expect(cancelled).toBe(1);
  });

  it("rejects encoded or ignored ranges and retires their response bodies", async () => {
    for (const mode of ["encoded", "ignored", "revision"] as const) {
      let cancelled = 0;
      const source = await openHttpSource("https://files.example/data", {
        fetch: async (_url, init) => {
          if (init?.method === "HEAD") {
            return new Response(null, { headers: { "content-length": "6", etag: '"first"' } });
          }
          const headers = new Headers({
            "content-range": "bytes 0-0/6",
            etag: mode === "revision" ? '"next"' : '"first"',
          });
          if (mode === "encoded") headers.set("content-encoding", "gzip");
          return new Response(
            new ReadableStream({
              cancel() {
                cancelled++;
              },
            }),
            { status: mode === "ignored" ? 200 : 206, headers },
          );
        },
      });
      await expect(source.read(0, 1)).rejects.toThrow();
      expect(cancelled).toBe(1);
    }
  });
});
