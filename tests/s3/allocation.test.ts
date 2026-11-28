/** S3: Multipart allocation remains owned until transfer or joined cleanup. */
import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { createS3Client, S3_LIMITS } from "../../src/backend/s3/client.ts";
import { within } from "../gate.ts";
import { withReleases } from "../close.ts";
import { credentials, xml } from "./fixture.ts";

describe("validated multipart allocation ownership", () => {
  for (const route of ["direct", "put", "copy"] as const) {
    for (const abortFails of [false, true]) {
      it(`${route} retains acquired allocation through failed response retirement and ${abortFails ? "failed" : "successful"} abort`, async () => {
        await withReleases(async (releases) => {
          const retirement = new Error("actual initialization reader release failure");
          const abortFault = new Error("actual remote abort response retirement failure");
          const inputRetiring = Promise.withResolvers<void>();
          const inputReleased = Promise.withResolvers<void>();
          const abortRetiring = Promise.withResolvers<void>();
          const abortReleased = Promise.withResolvers<void>();
          let aborted = 0;
          let parts = 0;
          let completed = 0;
          const client = createS3Client({
            endpoint: "https://s3.example.test",
            bucket: "owned",
            region: "us-east-1",
            credentials,
            delayedMultipart: false,
            request: { retries: 0 },
            fetch: async (input, init) => {
              const request = new Request(input, init);
              const url = new URL(request.url);
              if (request.method === "HEAD") {
                return new Response(null, {
                  headers: {
                    "content-length": String(S3_LIMITS.maxCopyBytes + 1),
                    etag: '"source"',
                  },
                });
              }
              if (url.searchParams.has("uploads")) {
                const response = xml(
                  "<InitiateMultipartUploadResult><UploadId>owned+opaque</UploadId></InitiateMultipartUploadResult>",
                );
                const acquire = response.body!.getReader.bind(response.body);
                Object.defineProperty(response.body, "getReader", {
                  value() {
                    const reader = acquire();
                    const release = reader.releaseLock.bind(reader);
                    reader.releaseLock = () => {
                      release();
                      throw retirement;
                    };
                    return reader;
                  },
                });
                return response;
              }
              if (request.method === "DELETE") {
                aborted++;
                expect(url.searchParams.get("uploadId")).toBe("owned+opaque");
                expect(request.signal.aborted).toBe(false);
                if (route === "put") expect(source?.locked).toBe(false);
                return new Response(
                  new ReadableStream<Uint8Array>({
                    async cancel() {
                      abortRetiring.resolve();
                      await abortReleased.promise;
                      if (abortFails) throw abortFault;
                    },
                  }, { highWaterMark: 0 }),
                );
              }
              if (url.searchParams.has("partNumber")) parts++;
              else completed++;
              throw new Error("Initialization failure must not admit parts or publication");
            },
          });
          const source = new ReadableStream<Uint8Array>({
            async cancel() {
              inputRetiring.resolve();
              await inputReleased.promise;
            },
          }, { highWaterMark: 0 });
          const pending = route === "direct"
            ? client.createUpload("destination")
            : route === "put"
            ? client.put("destination", source)
            : client.copy("source", "destination");
          let settled = false;
          const observed = pending.then(
            () => {
              settled = true;
              throw new Error("Expected initialization retirement failure");
            },
            (reason: unknown) => {
              settled = true;
              return reason;
            },
          );
          void observed.catch(() => {});
          releases.push(async () => {
            await within(Promise.allSettled([observed]), "allocation owner fixture drain");
          });
          releases.push(() => {
            inputReleased.resolve();
            abortReleased.resolve();
          });
          if (route === "put") {
            await within(inputRetiring.promise, "allocation failed initialization input drain");
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            expect(aborted).toBe(0);
            expect(settled).toBe(false);
            inputReleased.resolve();
          }
          await within(abortRetiring.promise, "allocation abort body retirement");
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          expect(settled).toBe(false);
          expect(aborted).toBe(1);
          abortReleased.resolve();
          const failure = await within(observed, "allocation owner terminal outcome");
          if (abortFails) expect(failure).toMatchObject({ errors: [retirement, abortFault] });
          else expect(failure).toBe(retirement);
          expect(parts).toBe(0);
          expect(completed).toBe(0);
          expect(aborted).toBe(1);
        });
      });
    }
  }

  for (
    const payload of [
      "<Other><UploadId>not-owned</UploadId></Other>",
      "<InitiateMultipartUploadResult><UploadId>one</UploadId><UploadId>two</UploadId></InitiateMultipartUploadResult>",
      "<InitiateMultipartUploadResult><Nested><UploadId>not-owned</UploadId></Nested></InitiateMultipartUploadResult>",
    ]
  ) {
    it(`does not invent allocation from malformed identity ${payload}`, async () => {
      let requests = 0;
      const client = createS3Client({
        endpoint: "https://s3.example.test",
        bucket: "owned",
        region: "us-east-1",
        credentials,
        fetch: async () => {
          requests++;
          return xml(payload);
        },
      });
      await expect(client.createUpload("destination")).rejects.toBeInstanceOf(SyntaxError);
      expect(requests).toBe(1);
    });
  }

  it("transfers a successfully retired public allocation unchanged without aborting it", async () => {
    let requests = 0;
    const client = createS3Client({
      endpoint: "https://s3.example.test",
      bucket: "owned",
      region: "us-east-1",
      credentials,
      fetch: async () => {
        requests++;
        return xml("<InitiateMultipartUploadResult><UploadId>owned+opaque</UploadId></InitiateMultipartUploadResult>");
      },
    });
    expect(await client.createUpload("destination")).toEqual({ key: "destination", id: "owned+opaque" });
    expect(requests).toBe(1);
  });
});
