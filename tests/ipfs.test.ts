import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { openIpfsSource } from "../src/ipfs.ts";
import type { FetchType } from "../src/request.ts";

const hello = "f015512202cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
const dag = "bafyreihyrpefhacm6kkp4ql6j6udakdit7g3dmkzfriqfykhjw6cad5lrm";
const encode = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text);

describe("IPFS gateway trust boundaries", () => {
  it("hashes a whole raw response before exposing immutable range slices", async () => {
    let requests = 0;
    const fetch: FetchType = (input, init) => {
      requests++;
      expect(new URL(String(input)).searchParams.get("format")).toBe("raw");
      expect(new Headers(init?.headers).get("accept")).toBe("application/vnd.ipld.raw");
      expect(init?.redirect).toBe("manual");
      return Promise.resolve(
        new Response(encode("hello"), { headers: { "content-type": "application/vnd.ipld.raw" } }),
      );
    };
    const source = await openIpfsSource(hello, { gateway: "https://gateway.invalid/", mode: "verified-raw", fetch });
    expect(source.verification).toBe("sha2-256");
    expect(source.stability).toBe("immutable");
    expect(new TextDecoder().decode(await source.read(1, 3))).toBe("ell");
    expect(new TextDecoder().decode(await source.read(0, 5))).toBe("hello");
    expect(requests).toBe(1);
  });
  it("rejects verified nonraw roots and unsupported hashes before Fetch", async () => {
    let calls = 0;
    for (const cid of [dag, "f0155000161"]) {
      await expect(openIpfsSource(cid, {
        gateway: "https://gateway.invalid",
        mode: "verified-car",
        fetch: () => {
          calls++;
          throw new Error("unexpected");
        },
      })).rejects.toThrow();
    }
    expect(calls).toBe(0);
  });
  it("keeps trusted gateway representations distinct from CID-verified bytes", async () => {
    const source = await openIpfsSource(dag, {
      gateway: "https://gateway.invalid/base/",
      mode: "trusted",
      path: ["hello world"],
      fetch: (input, init) => {
        expect(new URL(String(input)).pathname.endsWith("/hello%20world")).toBe(true);
        if (init?.method === "HEAD") {
          return Promise.resolve(new Response(null, { headers: { "content-length": "5", etag: '"revision"' } }));
        }
        expect(new Headers(init?.headers).get("if-match")).toBe('"revision"');
        return Promise.resolve(
          new Response(encode("ell"), {
            status: 206,
            headers: { "content-range": "bytes 1-3/5", "content-length": "3", etag: '"revision"' },
          }),
        );
      },
    });
    expect(source.verification).toBe("gateway");
    expect(source.identity).toBeUndefined();
    expect(source.stability).toBe("provider");
    expect(new TextDecoder().decode(await source.read(1, 3))).toBe("ell");
  });
  it("rejects wrong bytes and truncated response framing", async () => {
    const options = { gateway: "https://gateway.invalid", mode: "verified-raw" as const };
    await expect(
      openIpfsSource(hello, {
        ...options,
        fetch: () =>
          Promise.resolve(new Response(encode("other"), { headers: { "content-type": "application/vnd.ipld.raw" } })),
      }),
    ).rejects.toThrow("digest mismatch");
    await expect(
      openIpfsSource(hello, {
        ...options,
        fetch: () =>
          Promise.resolve(
            new Response(encode("hello"), {
              headers: { "content-type": "application/vnd.ipld.raw", "content-length": "6" },
            }),
          ),
      }),
    ).rejects.toThrow("Content-Length");
  });
  it("retires rejected bodies and enforces actual response bytes without trusting Content-Length", async () => {
    for (const kind of ["wrong-type", "redirect", "declared-limit", "stream-limit"]) {
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(encode("hello"));
        },
        cancel() {
          cancelled = true;
        },
      }, { highWaterMark: 0 });
      await expect(
        openIpfsSource(hello, {
          gateway: "https://gateway.invalid",
          mode: "verified-raw",
          maxResponseBytes: 4,
          fetch: () =>
            Promise.resolve(
              new Response(body, {
                status: kind === "redirect" ? 302 : 200,
                headers: {
                  "content-type": kind === "wrong-type" ? "text/html" : "application/vnd.ipld.raw",
                  ...(kind === "declared-limit" ? { "content-length": "5" } : {}),
                },
              }),
            ),
        }),
      ).rejects.toThrow();
      expect(cancelled).toBe(true);
      expect(body.locked).toBe(false);
    }
  });
  it("refuses invalid trust/path settings and pre-aborted work before Fetch", async () => {
    let calls = 0;
    const fetch: FetchType = () => {
      calls++;
      throw new Error("unexpected");
    };
    const abort = new AbortController();
    abort.abort("stop");
    await expect(
      openIpfsSource(hello, { gateway: "https://gateway.invalid", mode: "verified-raw", fetch, signal: abort.signal }),
    ).rejects.toBe("stop");
    for (const path of [[".."], ["a/b"], ["file"]]) {
      await expect(openIpfsSource(hello, { gateway: "https://gateway.invalid", mode: "verified-raw", fetch, path }))
        .rejects.toThrow();
    }
    expect(calls).toBe(0);
  });
  it("cancels an in-flight body and awaits its release", async () => {
    const abort = new AbortController();
    let finish!: () => void;
    const entered = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull() {
        finish();
      },
      async cancel() {
        await Promise.resolve();
        cancelled = true;
      },
    }, { highWaterMark: 0 });
    const pending = openIpfsSource(hello, {
      gateway: "https://gateway.invalid",
      mode: "verified-raw",
      signal: abort.signal,
      fetch: () => Promise.resolve(new Response(body, { headers: { "content-type": "application/vnd.ipld.raw" } })),
    });
    await entered;
    abort.abort("stop");
    await expect(pending).rejects.toBeDefined();
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });
});
