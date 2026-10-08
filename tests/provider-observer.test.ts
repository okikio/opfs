import { describe, it } from "node:test";
import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { createServer, request } from "node:http";
import type { Server } from "node:http";
import { once } from "node:events";
import { observeProvider } from "../bench/provider-contract.ts";
import { within } from "./gate.ts";
import { withReleases } from "./close.ts";

/** Opens one explicitly owned loopback authority and always closes its connections. */
async function fixture<Value>(
  server: Server,
  operation: (endpoint: string, releases: Array<() => void | Promise<unknown>>) => Promise<Value>,
): Promise<Value> {
  return await withReleases(async (releases) => {
    releases.push(async () => {
      server.closeAllConnections();
      if (server.listening) {
        await new Promise<void>((resolve, reject) => server.close((reason) => reason ? reject(reason) : resolve()));
      }
    });
    const listening = once(server, "listening");
    server.listen(0, "127.0.0.1");
    await listening;
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("The owned HTTP fixture has no address.");
    return await within(operation(`http://127.0.0.1:${address.port}`, releases), "observer transport", 5000);
  });
}

/** Large nonzero data makes truncation, EOF and both stream directions observable. */
const bytes = Uint8Array.from({ length: 6 * 1024 * 1024 }, (_, index) => (index * 17 + 31) % 251);

describe("Untimed provider observation transport", () => {
  it("separates the loopback listener from a fixed gateway-shaped upstream", async () => {
    await withReleases(async (releases) => {
      // No request dials this address. The actual nested fixture proves gateway reachability separately.
      const observer = await observeProvider("http://172.17.0.1:32123/devstoreaccount1");
      releases.push(() => observer.close());
      const endpoint = new URL(observer.endpoint);
      strictEqual(endpoint.hostname, "127.0.0.1");
      strictEqual(endpoint.pathname, "/devstoreaccount1");
      const first = observer.close();
      strictEqual(observer.close(), first);
      await first;
    });
  });

  it("rejects unsupported endpoint components instead of discarding them", async () => {
    for (
      const endpoint of [
        "https://127.0.0.1:32123",
        "http://user@127.0.0.1:32123",
        "http://user:password@127.0.0.1:32123",
        "http://@127.0.0.1:32123",
        "http://127.0.0.1:32123/devstoreaccount1?account=other",
        "http://127.0.0.1:32123/devstoreaccount1?",
        "http://127.0.0.1:32123/devstoreaccount1#other",
        "http://127.0.0.1:32123/devstoreaccount1#",
        "not an endpoint",
      ]
    ) {
      await withReleases(async (releases) => {
        await rejects(async () => {
          // If admission regresses, an acquired observer is still immediately retired.
          const observer = await observeProvider(endpoint);
          releases.push(() => observer.close());
        }, TypeError);
      });
    }
  });

  it("signed Host cannot redirect the fixed upstream or duplicate its account path", async () => {
    const path = "/devstoreaccount1/bucket/a%2Fb%20%252F?owned=1";
    const payload = bytes.subarray(0, 31 * 1024);
    let upstreamPath: string | undefined;
    let upstreamHost: string | undefined;
    let upstreamBytes: Uint8Array | undefined;
    let borrowedCalls = 0;
    const upstream = createServer((incoming, response) => {
      upstreamPath = incoming.url;
      upstreamHost = incoming.headers.host;
      const chunks: Uint8Array[] = [];
      incoming.on("data", (chunk: Uint8Array) => chunks.push(chunk));
      incoming.on("end", () => {
        upstreamBytes = new Uint8Array(Buffer.concat(chunks));
        response.end(payload);
      });
    });
    const other = createServer((_incoming, response) => {
      borrowedCalls++;
      response.end("wrong upstream");
    });
    await fixture(upstream, async (endpoint, releases) => {
      await fixture(other, async (otherEndpoint) => {
        const signedHost = new URL(otherEndpoint).host;
        const observer = await observeProvider(`${endpoint}/devstoreaccount1`);
        releases.push(() => observer.close());
        strictEqual(new URL(observer.endpoint).pathname, "/devstoreaccount1");
        const actual = await observer.check("fixed upstream authority", () => {
          const client = request(new URL(path, observer.endpoint), {
            method: "PUT",
            headers: { host: signedHost },
          });
          releases.push(() => {
            client.destroy();
          });
          return new Promise<Uint8Array>((resolve, reject) => {
            client.once("error", reject);
            client.once("response", (response) => {
              const chunks: Uint8Array[] = [];
              response.on("data", (chunk: Uint8Array) => chunks.push(chunk));
              response.once("error", reject);
              response.once("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
            });
            client.end(payload);
          });
        }, { "PUT object": 1 });
        strictEqual(borrowedCalls, 0);
        strictEqual(upstreamPath, path);
        strictEqual(upstreamHost, signedHost);
        deepStrictEqual(upstreamBytes, payload);
        deepStrictEqual(actual, payload);
      });
    });
  });

  it("retains exact bytes beyond stream high-water marks in both directions", async () => {
    const path = "/bucket/a%2Fb%20%252F?owned=1";
    const server = createServer((incoming, response) => {
      strictEqual(incoming.url, path);
      strictEqual(incoming.headers.host, "signed.fixture.invalid");
      const chunks: Uint8Array[] = [];
      incoming.on("data", (value: Uint8Array) => chunks.push(value));
      incoming.on("end", () => {
        deepStrictEqual(Buffer.concat(chunks), Buffer.from(bytes));
        response.end(bytes);
      });
    });
    await fixture(server, async (endpoint, releases) => {
      const observer = await observeProvider(endpoint);
      releases.push(() => observer.close());
      const actual = await observer.check("bidirectional bytes", () => {
        // Fetch forbids Host, so native HTTP owns this signed-header control.
        // https://fetch.spec.whatwg.org/#forbidden-request-header
        const client = request(new URL(path, observer.endpoint).href, {
          method: "PUT",
          headers: { host: "signed.fixture.invalid" },
        });
        releases.push(() => {
          client.destroy();
        });
        return new Promise<Uint8Array>((resolve, reject) => {
          client.once("error", reject);
          client.once("response", (response) => {
            const chunks: Uint8Array[] = [];
            response.on("data", (value: Uint8Array) => chunks.push(value));
            response.once("error", reject);
            response.once("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
          });
          client.end(bytes);
        });
      }, { "PUT object": 1 });
      deepStrictEqual(actual, bytes);
    });
  });

  it("consumer cancellation releases the provider response and poisons late reuse", async () => {
    let acknowledge: (() => void) | undefined;
    const disconnected = new Promise<void>((resolve) => acknowledge = resolve);
    const server = createServer((incoming, response) => {
      // Bun can omit ServerResponse.close after actual peer disconnection.
      incoming.socket.on("close", () => acknowledge?.());
      response.writeHead(200);
      response.write(bytes.subarray(0, 1024));
    });
    await fixture(server, async (endpoint, releases) => {
      const observer = await observeProvider(endpoint);
      const controller = new AbortController();
      releases.push(() => observer.close());
      await rejects(observer.check("consumer abort", async () => {
        const response = await fetch(observer.endpoint, { method: "PUT", signal: controller.signal });
        const body = response.arrayBuffer();
        controller.abort(new Error("Owned consumer abort."));
        await body;
      }, { "PUT object": 1 }));
      await within(disconnected, "provider sees consumer close");
      let reused = false;
      await rejects(observer.check("late reuse", async () => reused = true, {}));
      strictEqual(reused, false);
    });
  });

  it("provider disconnect releases both response streams", async () => {
    const server = createServer((_incoming, response) => {
      response.on("error", () => {});
      response.writeHead(200, { "content-length": bytes.length });
      response.write(bytes.subarray(0, 1024));
      response.destroy(new Error("Owned provider disconnect."));
    });
    await fixture(server, async (endpoint, releases) => {
      const observer = await observeProvider(endpoint);
      releases.push(() => observer.close());
      await rejects(observer.check("provider disconnect", async () => {
        const response = await fetch(observer.endpoint, { method: "PUT" });
        await response.arrayBuffer();
      }, { "PUT object": 1 }));
    });
  });

  it("operational expiry rejects an uncooperative operation and retains partial calls", async () => {
    let acknowledge: (() => void) | undefined;
    const disconnected = new Promise<void>((resolve) => acknowledge = resolve);
    let announce: (() => void) | undefined;
    const arrived = new Promise<void>((resolve) => announce = resolve);
    const server = createServer((incoming, _response) => {
      incoming.socket.on("close", () => acknowledge?.());
      announce?.();
    });
    await fixture(server, async (endpoint, releases) => {
      const deadlines = new Set<() => void>();
      const observer = await observeProvider(endpoint, {
        watchdog(expire) {
          deadlines.add(expire);
          return () => deadlines.delete(expire);
        },
      });
      releases.push(() => observer.close());
      const rejected = rejects(
        observer.check("forced expiry", async () => {
          // Start a physical request, then deliberately provide no completion authority.
          void fetch(observer.endpoint, { method: "PUT" }).catch(() => {});
          await new Promise<void>(() => {});
        }, { "PUT object": 1 }),
        (reason: unknown) => {
          if (!(reason instanceof Error)) return false;
          deepStrictEqual(reason.cause, { code: "OPFS_PROVIDER_OBSERVATION_TIMEOUT", calls: { "PUT object": 1 } });
          return true;
        },
      );
      await within(arrived, "request arrival before expiry");
      for (const expire of Array.from(deadlines)) expire();
      await rejected;
      await within(disconnected, "provider sees expired request close");
      let reused = false;
      await rejects(observer.check("late reuse", async () => reused = true, {}));
      strictEqual(reused, false);
      strictEqual(deadlines.size, 0);
    });
  });

  it("terminal close rejects an active uncooperative callback and prevents new work", async () => {
    await fixture(createServer((_incoming, response) => response.end()), async (endpoint, releases) => {
      const observer = await observeProvider(endpoint);
      releases.push(() => observer.close());
      const pending = observer.check("close active", () => new Promise<void>(() => {}), {});
      const rejected = rejects(pending);
      const first = observer.close();
      strictEqual(observer.close(), first);
      await first;
      await rejected;
      let ran = false;
      await rejects(observer.check("closed work", async () => ran = true, {}));
      strictEqual(ran, false);
    });
  });

  it("close releases a pending request after physical body admission", async () => {
    let announce: (() => void) | undefined;
    let acknowledge: (() => void) | undefined;
    const arrived = new Promise<void>((resolve) => announce = resolve);
    const disconnected = new Promise<void>((resolve) => acknowledge = resolve);
    const server = createServer((incoming, _response) => {
      incoming.on("error", () => {});
      incoming.socket.on("close", () => acknowledge?.());
      incoming.once("data", () => announce?.());
    });
    await fixture(server, async (endpoint, releases) => {
      const observer = await observeProvider(endpoint);
      releases.push(() => observer.close());
      const client = request(observer.endpoint, { method: "PUT", headers: { "content-length": bytes.length } });
      client.on("error", () => {});
      releases.push(() => {
        client.destroy();
      });
      const pending = observer.check("pending request close", async () => {
        client.write(bytes.subarray(0, 1024));
        await arrived;
      }, { "PUT object": 1 });
      const rejected = rejects(pending);
      await within(arrived, "request chunk admission");
      await observer.close();
      await rejected;
      await within(disconnected, "provider sees pending request close");
    });
  });

  it("close wins after response headers while owned response forwarding remains pending", async () => {
    let acknowledge: (() => void) | undefined;
    const disconnected = new Promise<void>((resolve) => acknowledge = resolve);
    const server = createServer((incoming, response) => {
      incoming.socket.on("close", () => acknowledge?.());
      response.writeHead(200);
      response.write(bytes.subarray(0, 1024));
    });
    await fixture(server, async (endpoint, releases) => {
      const observer = await observeProvider(endpoint);
      releases.push(() => observer.close());
      let announce: (() => void) | undefined;
      const arrived = new Promise<void>((resolve) => announce = resolve);
      const pending = observer.check("pending response close", async () => {
        const response = await fetch(observer.endpoint, { method: "PUT" });
        // A SDK can expose headers before its transport body is fully forwarded.
        void response.arrayBuffer().catch(() => {});
        announce?.();
      }, { "PUT object": 1 });
      const rejected = rejects(pending);
      await within(arrived, "response header admission");
      await observer.close();
      await rejected;
      await within(disconnected, "provider sees pending response close");
    });
  });

  it("admission overflow fails even when the caller accepts the final503 response", async () => {
    await fixture(createServer((_incoming, response) => response.end()), async (endpoint, releases) => {
      const observer = await observeProvider(endpoint);
      releases.push(() => observer.close());
      await rejects(
        observer.check("bounded admission", async () => {
          for (let index = 0; index < 65; index++) {
            const response = await fetch(observer.endpoint, { method: "PUT" });
            await response.arrayBuffer();
            strictEqual(response.status, index === 64 ? 503 : 200);
          }
        }, { "PUT object": 64 }),
        (reason: unknown) => reason instanceof AggregateError,
      );
    });
  });
});
