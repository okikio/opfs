import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { CmisPublicationError, createCmisClient } from "../src/cmis.ts";
import type { CmisClientOptionsType } from "../src/cmis.ts";

const BASE = {
  repository: "A1",
  repositoryUrl: "https://cmis.test/browser/A1",
  rootUrl: "https://cmis.test/browser/A1/root",
};
function prop(id: string, type: string, value: unknown, cardinality = "single"): unknown {
  return { id, type, cardinality, value };
}
function document(id = "doc", size = 3, extra = {}): unknown {
  return {
    properties: {
      "cmis:objectId": prop("cmis:objectId", "id", id),
      "cmis:name": prop("cmis:name", "string", "a.bin"),
      "cmis:baseTypeId": prop("cmis:baseTypeId", "id", "cmis:document"),
      "cmis:contentStreamLength": prop("cmis:contentStreamLength", "integer", size),
      "cmis:changeToken": prop("cmis:changeToken", "string", "token-old"),
      ...extra,
    },
  };
}
function repository(updates = "anytime"): unknown {
  return {
    A1: {
      repositoryId: "A1",
      rootFolderId: "root",
      repositoryUrl: "https://ungranted.test/repo",
      rootFolderUrl: "https://ungranted.test/root",
      cmisVersionSupported: "1.1",
      capabilities: { capabilityContentStreamUpdatability: updates },
    },
  };
}
function client(options: Partial<CmisClientOptionsType> = {}) {
  return createCmisClient({ ...BASE, policy: { retries: 0 }, ...options });
}

describe("CMIS native Browser Binding finite profile", () => {
  it("keeps discovery URLs inert and credentials on detached explicitly granted URLs", async () => {
    const calls: string[] = [];
    const api = client({
      credentials: (url) => {
        url.hostname = "mutated.test";
        return { authorization: "Basic fixture" };
      },
      fetch: async (input, init) => {
        calls.push(String(input));
        expect(new Headers(init?.headers).get("authorization")).toBe("Basic fixture");
        expect(init?.redirect).toBe("manual");
        expect(init?.credentials).toBe("omit");
        return Response.json(calls.length === 1 ? repository() : document());
      },
    });
    expect((await api.repository()).rootUrl).toBe("https://ungranted.test/root");
    expect((await api.get("doc")).id).toBe("doc");
    expect(calls.every((url) => new URL(url).origin === "https://cmis.test")).toBe(true);
  });
  it("retains exact numeric lexemes, cardinality, unset state, multiline text and version facets", async () => {
    const data = document("doc", 3, {
      integer: prop("integer", "integer", "BIG"),
      decimal: prop("decimal", "decimal", "DECIMAL"),
      text: prop("text", "string", ["line\ntext", "second"], "multi"),
      unset: prop("unset", "id", null),
      "cmis:versionSeriesId": prop("cmis:versionSeriesId", "id", "series"),
    });
    const raw = JSON.stringify(data).replace('"BIG"', "900719925474099123456789").replace(
      '"DECIMAL"',
      "1.0000000000000000000000000000001e-50",
    );
    const result = await client({ fetch: async () => new Response(raw) }).get("doc");
    expect(result.properties.integer?.values).toEqual(["900719925474099123456789"]);
    expect(result.properties.decimal?.values).toEqual(["1.0000000000000000000000000000001e-50"]);
    expect(result.properties.text?.values).toEqual(["line\ntext", "second"]);
    expect(result.properties.unset?.values).toBe(null);
    expect(result.properties["cmis:versionSeriesId"]?.values).toEqual(["series"]);
    expect(Object.isFrozen(result.properties.text?.values)).toBe(true);
  });
  it("rejects duplicate authority keys, lossy counts, malformed properties and mismatched IDs", async () => {
    const valid = JSON.stringify(document());
    for (
      const raw of [
        valid.replace('"properties":', '"properties":{},"properties":'),
        JSON.stringify(document("other")),
        JSON.stringify(document("doc", 3, { wrong: prop("wrong", "boolean", "true") })),
        JSON.stringify(document("doc", 3, { wrong: prop("wrong", "id", ["single"]) })),
        JSON.stringify(document("doc", 3, { date: prop("date", "datetime", "BAD") })).replace(
          '"BAD"',
          "9007199254740991.1",
        ),
      ]
    ) {
      await expect(client({ fetch: async () => new Response(raw) }).get("doc")).rejects.toThrow();
    }
    const page = '{"objects":[],"hasMoreItems":false,"numItems":9007199254740991.1}';
    await expect(client({ fetch: async () => new Response(page) }).list("root")).rejects.toThrow();
  });
  it("bounds and advances only an explicit child page without path projection", async () => {
    const api = client({
      fetch: async (input) => {
        const url = new URL(String(input));
        expect(url.searchParams.get("skipCount")).toBe("3");
        expect(url.searchParams.get("maxItems")).toBe("1");
        return Response.json({ objects: [{ object: document() }], hasMoreItems: true, numItems: 8 });
      },
    });
    expect(await api.list("root", { skip: 3, limit: 1 })).toMatchObject({ more: true, next: 4, total: 8 });
    await expect(client({ fetch: async () => Response.json({ objects: [], hasMoreItems: true }) }).list("root")).rejects
      .toThrow("does not advance");
  });
  it("reads exact complete current bytes and rejects wrong lengths/encoding before exposing bytes", async () => {
    const bytes = new Uint8Array([0, 255, 3]);
    expect(await client({ fetch: async () => new Response(bytes, { headers: { "content-length": "3" } }) }).read("doc"))
      .toEqual(bytes);
    for (const headers of [{ "content-length": "4" }, { "content-encoding": "gzip" }, { "content-length": "3.0" }]) {
      await expect(client({ fetch: async () => new Response(bytes, { headers }) }).read("doc")).rejects.toThrow();
    }
  });
  it("enforces actual byte budgets and preserves terminal stream failure identity", async () => {
    let canceled = 0;
    await expect(
      client({
        maxBytes: 1,
        fetch: async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array([1, 2]));
              },
              cancel() {
                canceled++;
              },
            }),
          ),
      }).read("doc"),
    ).rejects.toThrow();
    expect(canceled).toBe(1);
    const failure = new Error("content stream failed");
    await expect(
      client({
        fetch: async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(failure);
              },
            }),
          ),
      }).read("doc"),
    ).rejects.toBe(failure);
  });
  it("copies uploads and captures options before credential awaits", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const options = { versioningState: "none" as const, mediaType: "application/octet-stream" };
    const api = client({
      credentials: async () => {
        bytes.fill(9);
        options.mediaType = "text/plain";
        return undefined;
      },
      fetch: async (_input, init) => {
        const form = init?.body as FormData;
        expect(form.get("versioningState")).toBe("none");
        const content = form.get("content") as File;
        expect(content.type).toBe("application/octet-stream");
        expect(new Uint8Array(await content.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
        return Response.json(document(), { status: 201 });
      },
    });
    expect((await api.create("root", "a.bin", bytes, options)).id).toBe("doc");
  });
  it("requires native anytime capability and snapshots change tokens before discovery", async () => {
    let posts = 0;
    const options = { changeToken: "original" };
    const api = client({
      credentials: () => {
        options.changeToken = "mutated";
        return undefined;
      },
      fetch: async (input, init) => {
        const extra = { "cmis:versionSeriesId": prop("cmis:versionSeriesId", "id", "series") };
        if (init?.method === "GET") {
          return Response.json(
            new URL(String(input)).searchParams.get("cmisselector") === "object"
              ? document("doc", 3, extra)
              : repository(),
          );
        }
        posts++;
        expect((init?.body as FormData).get("changeToken")).toBe("original");
        return Response.json(document("version-new", 3, extra), { status: 201 });
      },
    });
    expect((await api.replace("doc", new Uint8Array([1, 2, 3]), options)).id).toBe("version-new");
    expect(posts).toBe(1);
    await expect(
      client({ fetch: async () => Response.json(repository("pwconly")) }).replace("doc", new Uint8Array(), {
        changeToken: "t",
      }),
    ).rejects.toThrow("anytime");
  });
  it("preserves native conflicts but marks lost, server-error and malformed receipts unknown without retry", async () => {
    for (
      const response of [
        undefined,
        Response.json({ exception: "runtime" }, { status: 500 }),
        Response.json(document("doc", 8), { status: 201 }),
        new Response("invalid", { status: 201 }),
      ]
    ) {
      let calls = 0;
      const api = client({
        fetch: async () => {
          calls++;
          if (response === undefined) throw new Error("lost acknowledgement");
          return response;
        },
      });
      await expect(api.create("root", "a.bin", new Uint8Array([1, 2, 3]), { versioningState: "none" })).rejects
        .toBeInstanceOf(CmisPublicationError);
      expect(calls).toBe(1);
    }
    await expect(
      client({ fetch: async () => Response.json({ exception: "updateConflict", message: "secret" }, { status: 409 }) })
        .create("root", "a.bin", new Uint8Array(), { versioningState: "none" }),
    ).rejects.toMatchObject({ status: 409, exception: "updateConflict" });
  });
  it("refuses unrelated same-size replacement receipts without inventing a version-series relationship", async () => {
    for (
      const [oldSeries, newSeries] of [[undefined, undefined], ["old-series", "other-series"], [
        "old-series",
        undefined,
      ]] as const
    ) {
      let posts = 0;
      const extra = (value: string | undefined) =>
        value === undefined ? {} : { "cmis:versionSeriesId": prop("cmis:versionSeriesId", "id", value) };
      const api = client({
        fetch: async (input, init) => {
          if (init?.method === "GET") {
            return Response.json(
              new URL(String(input)).searchParams.get("cmisselector") === "object"
                ? document("doc", 3, extra(oldSeries))
                : repository(),
            );
          }
          posts++;
          return Response.json(document("unrelated", 3, extra(newSeries)), { status: 201 });
        },
      });
      await expect(api.replace("doc", new Uint8Array([1, 2, 3]), { changeToken: "old" })).rejects.toBeInstanceOf(
        CmisPublicationError,
      );
      expect(posts).toBe(1);
    }
  });
  it("refuses redirects and pre-aborted operations without granting discovery authority", async () => {
    let credentials = 0, calls = 0;
    const api = client({
      credentials: () => {
        credentials++;
        return undefined;
      },
      fetch: async () => {
        calls++;
        return new Response(null, { status: 307, headers: { location: "https://foreign.test/login" } });
      },
    });
    const controller = new AbortController(), reason = new Error("stop");
    controller.abort(reason);
    await expect(api.get("doc", { signal: controller.signal })).rejects.toBe(reason);
    expect(credentials).toBe(0);
    await expect(api.get("doc")).rejects.toMatchObject({ status: 307 });
    expect(calls).toBe(1);
    expect(credentials).toBe(1);
    expect(() => client({ rootUrl: "https://user:secret@cmis.test/root" })).toThrow();
  });
  it("refuses an upload canceled during credential acquisition before any publication dispatch", async () => {
    const controller = new AbortController(), reason = new Error("credential cancellation");
    let calls = 0;
    const api = client({
      credentials: () => {
        controller.abort(reason);
        return { authorization: "Basic fixture" };
      },
      fetch: async () => {
        calls++;
        return Response.json(document(), { status: 201 });
      },
    });
    await expect(api.create("root", "a.bin", new Uint8Array([1, 2, 3]), {
      versioningState: "none",
      signal: controller.signal,
    })).rejects.toBe(reason);
    expect(calls).toBe(0);
  });
});
