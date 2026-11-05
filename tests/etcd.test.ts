import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { encodeBase64 } from "@std/encoding/base64";
import { createEtcdClient, EtcdCursorSchema, EtcdError, EtcdPublicationError } from "../src/etcd.ts";
import type { EtcdClientOptionsType, EtcdPutType } from "../src/etcd.ts";
const bytes = (value: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(value);
const encoded = (value: string) => encodeBase64(bytes(value));
const header = (revision = "10", cluster_id = "18446744073709551615") => ({
  cluster_id,
  member_id: "9007199254740993",
  revision,
  raft_term: "2",
});
const entry = (key = "key", value = "original", mod_revision = "10") => ({
  key: encoded(key),
  value: encoded(value),
  create_revision: "1",
  mod_revision,
  version: "1",
});
const client = (options: Partial<EtcdClientOptionsType> = {}) =>
  createEtcdClient({ endpoint: "https://etcd.test/prefix/", ...options });
const applied = (revision = "11") =>
  Response.json({ header: header(revision), succeeded: true, responses: [{ response_put: { header: { revision } } }] });
describe("native etcd JSON gateway", () => {
  it("admits genuine revision-only nested receipts while rejecting mismatched nested authority", async () => {
    const genuine = client({ fetch: async () => applied() });
    expect((await genuine.put(bytes("key"), bytes("value"), { create: true })).applied).toBe(true);
    for (
      const nested of [{ revision: "12" }, { revision: "11", cluster_id: "1" }, { revision: "11", member_id: "1" }, {
        revision: "11",
        raft_term: "3",
      }]
    ) {
      const api = client({
        fetch: async () =>
          Response.json({ header: header("11"), succeeded: true, responses: [{ response_put: { header: nested } }] }),
      });
      await expect(api.put(bytes("key"), bytes("value"), { create: true })).rejects.toBeInstanceOf(
        EtcdPublicationError,
      );
    }
  });
  it("retains uint64/int64 string authority, native empty values and exact byte keys", async () => {
    const api = client({
      fetch: async () =>
        Response.json({
          header: header("9007199254740993"),
          kvs: [{ ...entry("key", "", "9007199254740993"), value: undefined }],
          count: "1",
        }),
    });
    const result = await api.get(bytes("key"));
    expect(result.header.member_id).toBe("9007199254740993");
    expect(result.entry?.modRevision).toBe("9007199254740993");
    expect(result.entry?.value).toEqual(new Uint8Array());
    const absent = client({ fetch: async () => Response.json({ header: header() }) });
    expect((await absent.get(bytes("absent"))).entry).toBe(null);
    const foreign = client({
      fetch: async () => Response.json({ header: header(), kvs: [entry("other")], count: "1" }),
    });
    await expect(foreign.get(bytes("key"))).rejects.toThrow("different key");
  });
  it("bounds revisions/numbers and refuses noncanonical base64 before exposing native data", async () => {
    for (const revision of ["9223372036854775808", "01", "-1", "1e2"]) {
      const api = client({ fetch: async () => Response.json({ header: header(revision) }) });
      await expect(api.get(bytes("key"))).rejects.toThrow();
    }
    const large = client({
      fetch: async () =>
        new Response('{"header":{"cluster_id":"1","member_id":"1","revision":9007199254740991.1,"raft_term":"1"}}'),
    });
    await expect(large.get(bytes("key"))).rejects.toThrow("Malformed");
    const duplicate = client({ fetch: async () => new Response('{"header":{},"header":{}}') });
    await expect(duplicate.get(bytes("key"))).rejects.toThrow("Malformed");
    const bad = client({
      fetch: async () => Response.json({ header: header(), kvs: [{ ...entry(), value: "YR==" }], count: "1" }),
    });
    await expect(bad.get(bytes("key"))).rejects.toThrow("base64");
  });
  it("snapshots byte inputs and native lease/CAS authority before awaiting detached credentials", async () => {
    const key = bytes("key"), value = bytes("original"), options = { modRevision: "10", lease: "preserve" as const };
    const api = client({
      credentials: async (url) => {
        url.host = "foreign.test";
        key.fill(0);
        value.fill(0);
        options.modRevision = "20";
        return "fixture-token";
      },
      fetch: async (input, init) => {
        expect(String(input)).toBe("https://etcd.test/prefix/v3/kv/txn");
        expect(init?.redirect).toBe("manual");
        expect(init?.credentials).toBe("omit");
        expect(new Headers(init?.headers).get("authorization")).toBe("fixture-token");
        const body = JSON.parse(String(init?.body));
        expect(body.compare[0]).toEqual({ key: encoded("key"), result: "EQUAL", target: "MOD", mod_revision: "10" });
        expect(body.success).toEqual([{
          request_put: { key: encoded("key"), value: encoded("original"), ignore_lease: true },
        }]);
        return applied();
      },
    });
    expect((await api.put(key, value, options)).applied).toBe(true);
  });
  it("requires an explicit creation/replacement condition and explicit lease detachment", async () => {
    let calls = 0;
    const api = client({
      fetch: async (_, init) => {
        calls++;
        const body = JSON.parse(String(init?.body));
        expect(body.success[0].request_put.lease).toBe("0");
        return applied();
      },
    });
    await expect(api.put(bytes("key"), bytes("value"), {} as EtcdPutType)).rejects.toThrow("condition");
    await expect(api.put(bytes("key"), bytes("value"), { modRevision: "10" } as EtcdPutType)).rejects.toThrow("lease");
    expect((await api.put(bytes("key"), bytes("value"), { modRevision: "10", lease: "none" })).applied).toBe(true);
    expect((await api.put(bytes("key"), new Uint8Array(), { create: true })).applied).toBe(true);
    expect(calls).toBe(2);
  });
  it("treats a failed compare as an acknowledged outcome and never retries it", async () => {
    let calls = 0;
    const api = client({
      fetch: async () => {
        calls++;
        return Response.json({ header: header() });
      },
    });
    expect((await api.put(bytes("key"), bytes("new"), { create: true })).applied).toBe(false);
    expect(calls).toBe(1);
  });
  it("pins ordered pagination to the original cluster/revision and protects its independent cursor", async () => {
    let calls = 0;
    const api = client({
      fetch: async (_, init) => {
        calls++;
        const body = JSON.parse(String(init?.body));
        if (calls === 1) {
          expect(body.range_end).toBe(encoded("p0"));
          return Response.json({ header: header(), kvs: [entry("p/a")], count: "2", more: true });
        }
        expect(body.key).toBe(encodeBase64(new Uint8Array([...bytes("p/a"), 0])));
        expect(body.revision).toBe("10");
        return Response.json({ header: header("12"), kvs: [entry("p/b", "b")], count: "1" });
      },
    });
    const first = await api.list(bytes("p/"), { limit: 1 });
    expect(first.next?.revision).toBe("10");
    first.entries[0]!.key.fill(0);
    const next = await api.list(bytes("p/"), { limit: 1, cursor: first.next! });
    expect(next.revision).toBe("10");
    expect(next.header.revision).toBe("12");
    expect(next.entries[0]?.key).toEqual(bytes("p/b"));
    expect(next.next).toBeUndefined();
    expect(EtcdCursorSchema.safeParse({ ...first.next, start: "bad" }).success).toBe(false);
    await expect(api.list(bytes("other"), { cursor: first.next! })).rejects.toThrow("different prefix");
    expect(calls).toBe(2);
  });
  it("rejects prefix escape, duplicate ordering and cluster rebinding", async () => {
    for (const values of [[entry("other")], [entry("p/a"), entry("p/a")]]) {
      const api = client({
        fetch: async () => Response.json({ header: header(), kvs: values, count: String(values.length) }),
      });
      await expect(api.list(bytes("p/"))).rejects.toThrow("ordered range");
    }
    const api = client({
      fetch: async () => Response.json({ header: header("10", "2"), kvs: [entry("p/b")], count: "1" }),
    });
    await expect(
      api.list(bytes("p/"), {
        cursor: { prefix: encoded("p/"), start: encoded("p/a"), revision: "10", cluster_id: "1" },
      }),
    ).rejects.toThrow("different cluster");
  });
  it("validates exact deletion receipts and preserves uncertain lost/malformed acknowledgements", async () => {
    const good = client({
      fetch: async (_, init) => {
        const body = JSON.parse(String(init?.body));
        expect(body.success).toEqual([{ request_delete_range: { key: encoded("key") } }]);
        return Response.json({
          header: header("11"),
          succeeded: true,
          responses: [{ response_delete_range: { deleted: "1" } }],
        });
      },
    });
    expect((await good.remove(bytes("key"), { modRevision: "10" })).applied).toBe(true);
    for (
      const fetch of [
        async () => {
          throw new Error("lost acknowledgement");
        },
        async () => Response.json({ header: header(), succeeded: true, responses: [] }),
        async () =>
          Response.json({
            header: header("11"),
            succeeded: true,
            responses: [{ response_delete_range: { deleted: "2" } }],
          }),
      ]
    ) {
      await expect(client({ fetch }).remove(bytes("key"), { modRevision: "10" })).rejects.toBeInstanceOf(
        EtcdPublicationError,
      );
    }
  });
  it("preserves native refusal even if body retirement also fails", async () => {
    const cleanup = new Error("cleanup");
    const api = client({
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              throw cleanup;
            },
          }),
          { status: 403 },
        ),
    });
    try {
      await api.put(bytes("key"), bytes("value"), { create: true });
      throw new Error("expected refusal");
    } catch (reason) {
      expect(reason).toBeInstanceOf(AggregateError);
      expect(reason).not.toBeInstanceOf(EtcdPublicationError);
      const errors = (reason as AggregateError).errors as unknown[];
      expect(errors.some((e) => e instanceof EtcdError && e.status === 403)).toBe(true);
      expect(errors.includes(cleanup)).toBe(true);
    }
  });
  it("refuses preaborted/oversized calls before credentials and transport", async () => {
    let calls = 0;
    const api = client({
      maxBytes: 2,
      credentials: () => {
        calls++;
        return undefined;
      },
      fetch: async () => {
        calls++;
        return applied();
      },
    });
    const c = new AbortController();
    c.abort("stop");
    await expect(api.get(bytes("key"), { signal: c.signal })).rejects.toBe("stop");
    await expect(api.put(bytes("key"), bytes("big"), { create: true })).rejects.toThrow();
    await expect(api.get(new Uint8Array())).rejects.toThrow();
    expect(calls).toBe(0);
  });
});
