/** Real loopback Fetch proves direct-client and driver range admission and wire headers. @module */
import { describe, it } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { expect } from "@std/expect";
import { createS3Client } from "../src/s3.ts";
import { createAzureClient } from "../src/azure.ts";
import { createS3DriverFromClient } from "../src/driver/s3.ts";
import { createAzureDriverFromClient } from "../src/driver/azure.ts";
import type { ObjectBackendType, ObjectGetOptionsType } from "../src/driver/object.ts";
import { withReleases } from "./close.ts";
import { within } from "./gate.ts";

/** Assertion records failure presence independently of an undefined caller reason. */
async function refused(action: () => Promise<unknown>): Promise<unknown> {
  const result = await action().then(
    () => ({ ok: true as const }),
    (reason: unknown) => ({ ok: false as const, reason }),
  );
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected range admission refusal.");
  return result.reason;
}

for (const provider of ["s3", "azure"] as const) {
  describe(provider + " direct GET range ownership", () => {
    it(
      "preserves actual bytes and range headers with finite local admission before authorization",
      { timeout: 10000 },
      async () => {
        await withReleases(async (releases) => {
          const observed: (string | undefined)[] = [];
          const bytes = new TextEncoder().encode("abcdef");
          const server = createServer((request, response) => {
            const header = request.headers[provider === "s3" ? "range" : "x-ms-range"];
            if (Array.isArray(header)) {
              response.writeHead(400).end();
              return;
            }
            observed.push(header);
            if (header === undefined) {
              response.end(bytes);
              return;
            }
            const match = /^bytes=(\d+)-(\d*)$/u.exec(header);
            if (match === null) {
              response.writeHead(400).end();
              return;
            }
            const start = Number(match[1]);
            if (start >= bytes.length) {
              response.writeHead(416, { "content-type": "application/xml" }).end(
                "<Error><Code>InvalidRange</Code></Error>",
              );
              return;
            }
            const end = match[2] === "" ? bytes.length : Number(match[2]) + 1;
            response.writeHead(206).end(bytes.subarray(start, end));
          });
          releases.push(async () => {
            server.closeAllConnections();
            if (server.listening) {
              await new Promise<void>((resolve, reject) =>
                server.close((reason) => reason ? reject(reason) : resolve())
              );
            }
          });
          const listening = once(server, "listening");
          server.listen(0, "127.0.0.1");
          await listening;
          const address = server.address();
          if (address === null || typeof address === "string") throw new Error("Loopback server has no address.");
          let credentials = 0;
          const endpoint = `http://127.0.0.1:${address.port}`;
          const owners: Pick<ObjectBackendType, "get">[] = [];
          if (provider === "s3") {
            const client = createS3Client({
              endpoint,
              bucket: "range",
              region: "us-east-1",
              credentials: () => {
                credentials++;
                return { accessKeyId: "local-range", secretAccessKey: "local-range-secret" };
              },
              request: { retries: 0 },
            });
            owners.push(client, createS3DriverFromClient(client));
          } else {
            const client = createAzureClient({
              endpoint,
              container: "range",
              credential: {
                kind: "headers",
                get: () => {
                  credentials++;
                  return { authorization: "local-range" };
                },
              },
              request: { retries: 0 },
            });
            owners.push(client, createAzureDriverFromClient(client));
          }
          for (const owner of owners) {
            const before = observed.length, authorized = credentials;
            for (const at of [0, 6, Number.MAX_SAFE_INTEGER]) {
              const stream = await owner.get("missing", { at, length: 0 });
              expect(new Uint8Array(await new Response(stream).arrayBuffer())).toEqual(new Uint8Array());
            }
            for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
              for (const options of [{ at: value }, { length: value }]) {
                expect(await refused(() => owner.get("file", options))).toBeInstanceOf(RangeError);
              }
            }
            expect(await refused(() => owner.get("file", { at: Number.MAX_SAFE_INTEGER, length: 2 }))).toBeInstanceOf(
              RangeError,
            );
            for (const reason of [undefined, null, new Error("cancel range")]) {
              const abort = new AbortController();
              abort.abort();
              Object.defineProperty(abort.signal, "reason", { value: reason });
              let offsets = 0;
              const options: ObjectGetOptionsType = {
                signal: abort.signal,
                get at() {
                  offsets++;
                  return 0;
                },
                length: 0,
              };
              expect(await refused(() => owner.get("file", options))).toBe(reason);
              expect(offsets).toBe(0);
            }
            expect(observed.length).toBe(before);
            expect(credentials).toBe(authorized);
            const cases: { options: ObjectGetOptionsType; header: string | undefined; text: string }[] = [
              { options: {}, header: undefined, text: "abcdef" },
              { options: { at: 2 }, header: "bytes=2-", text: "cdef" },
              { options: { length: 1 }, header: "bytes=0-0", text: "a" },
              { options: { at: 1, length: 3 }, header: "bytes=1-3", text: "bcd" },
              { options: { at: 5, length: 10 }, header: "bytes=5-14", text: "f" },
            ];
            for (const scenario of cases) {
              expect(await new Response(await within(owner.get("file", scenario.options), "range acquisition")).text())
                .toBe(scenario.text);
              expect(observed.at(-1)).toBe(scenario.header);
            }
            const fault = await refused(() => owner.get("file", { at: 6, length: 1 }));
            expect(fault).toMatchObject({ status: 416 });
            expect(observed.at(-1)).toBe("bytes=6-6");
            expect(credentials - authorized).toBe(cases.length + 1);
          }
        });
      },
    );
  });
}
