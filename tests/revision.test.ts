import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { createS3Client } from "../src/s3.ts";
import { createAzureClient } from "../src/azure.ts";
import { createObjectAdapter } from "../src/adapter/object.ts";
import { defineObjectDriver, type ObjectBackendType, type ObjectPutOptionsType } from "../src/driver/object.ts";

describe("native revision preconditions", () => {
  for (const provider of ["s3", "azure"] as const) {
    it(`${provider} binds reads/deletes to ETags and refuses generations before I/O`, async () => {
      const requests: Request[] = [];
      const fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(new Request(input, init));
        return Promise.resolve(new Response(null, { status: 200 }));
      };
      const client = provider === "s3"
        ? createS3Client({
          endpoint: "https://s3.example.test",
          bucket: "fixture",
          region: "us-east-1",
          credentials: { accessKeyId: "fixture", secretAccessKey: "fixture-secret" },
          fetch,
        })
        : createAzureClient({
          endpoint: "https://blob.example.test",
          container: "fixture",
          credential: { kind: "sas", token: "sig=fixture" },
          fetch,
        });
      const revision = { kind: "etag", value: '"original"' } as const;
      await (await client.get("one", { revision }))?.cancel();
      await client.delete("one", { revision });
      expect(requests.map((request) => request.headers.get("if-match"))).toEqual(['"original"', '"original"']);
      const wrong = { kind: "generation", value: "9007199254740993" } as const;
      for (
        const operation of [
          () => client.get("one", { revision: wrong }),
          () => client.delete("one", { revision: wrong }),
          () => client.put("one", new Uint8Array(), { revision: wrong }),
          () => client.copy!("one", "two", { sourceRevision: wrong }),
          () => client.copy!("one", "two", { revision: wrong }),
        ]
      ) await expect(operation()).rejects.toThrow(TypeError);
      expect(requests.length).toBe(2);
    });
  }

  it("passes a GCS generation through replacement without putting it in ifMatch", async () => {
    const generation = "18446744073709551614";
    let put: ObjectPutOptionsType | undefined;
    const backend: ObjectBackendType = {
      name: "generation-fixture",
      capabilities: { rangeRead: true, streamRead: true, streamWrite: false, copy: false, conditionalWrite: true },
      head: (key) =>
        Promise.resolve(
          key === "one"
            ? { size: 1, etag: "different-metadata-tag", revision: { kind: "generation", value: generation } }
            : null,
        ),
      get: () => Promise.resolve(new Blob([new Uint8Array([1])]).stream()),
      list: () => Promise.resolve({ objects: [], prefixes: [] }),
      put: (_key, _body, options) => {
        put = options;
        return Promise.resolve({ size: 1, revision: { kind: "generation", value: "18446744073709551615" } });
      },
      delete: () => Promise.resolve(),
    };
    const adapter = createObjectAdapter(defineObjectDriver(backend, { name: backend.name }));
    await adapter.writeFile("/one", new Uint8Array([2]), { mode: "replace" });
    expect(put?.revision).toEqual({ kind: "generation", value: generation });
    expect(put?.ifMatch).toBeUndefined();
  });
});
