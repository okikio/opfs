import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { createUploadClient, UploadSessionSchema } from "../src/upload.ts";
import { readDictionary, readField } from "../src/transfer/fields.ts";
import type { FetchType } from "../src/request.ts";

import { encodeBase32 } from "@std/encoding/base32";
import numberCases from "./fixtures/upload/structured/number.json" with { type: "json" };
import booleanCases from "./fixtures/upload/structured/boolean.json" with { type: "json" };
import dictionaryCases from "./fixtures/upload/structured/dictionary.json" with { type: "json" };
import itemCases from "./fixtures/upload/structured/item.json" with { type: "json" };
import parameterCases from "./fixtures/upload/structured/param-dict.json" with { type: "json" };
import displayCases from "./fixtures/upload/structured/display-string.json" with { type: "json" };
import dateCases from "./fixtures/upload/structured/date.json" with { type: "json" };
import binaryCases from "./fixtures/upload/structured/binary.json" with { type: "json" };
import type { FieldType } from "../src/transfer/fields.ts";

const target = "https://upload.example/documents/one";
function fixture() {
  const bytes: number[] = [], methods: string[] = [];
  let terminal = false;
  const fetch: FetchType = async (_url, init = {}) => {
    const method = init.method ?? "GET", h = new Headers(init.headers);
    methods.push(method);
    expect(h.get("Upload-Draft-Interop-Version")).toBe("10");
    expect(init.redirect).toBe("manual");
    if (method === "POST") return new Response(null, { status: 201, headers: { Location: "/uploads/one" } });
    if (method === "HEAD") return new Response(null, { headers: { "Upload-Offset": String(bytes.length) } });
    if (method === "DELETE") return new Response(null, { status: 204 });
    expect(method).toBe("PATCH");
    expect(h.get("Content-Type")).toBe("application/partial-upload");
    expect(Number(h.get("Upload-Offset"))).toBe(bytes.length);
    if (h.get("Upload-Complete") === "?1") {
      terminal = true;
      return new Response("application receipt", { status: 202, headers: { "Upload-Complete": "?1" } });
    }
    bytes.push(...new Uint8Array(await new Response(init.body).arrayBuffer()));
    return new Response(null, { status: 204, headers: { "Upload-Complete": '?0; ext="a,b;\\"c"' } });
  };
  return {
    bytes,
    methods,
    fetch,
    get terminal() {
      return terminal;
    },
  };
}
async function resource(fetch: FetchType, size = 4) {
  const client = createUploadClient({ profile: "draft-15", target, fetch });
  const result = await client.create({ method: "POST", size });
  if (result.kind !== "created") throw new Error("Expected incomplete creation.");
  return { client, session: result.session, upload: client.open(result.session) };
}

describe("bounded upload structured fields", () => {
  it("admits complete unknown parameter grammar without treating numeric kinds alike", () => {
    expect(() => readField("42; a=(bad)")).toThrow(SyntaxError);
  });
  it("keeps valid nested dictionary values inert and final duplicate authority", () => {
    const out = readDictionary('max-size=4, extra=(1 2; x=?1); p=@42, max-size=8; text=%"%c3%bc"');
    expect(out.get("max-size")).toEqual({ kind: "integer", value: 8 });
    expect(out.get("extra")?.kind).toBe("inner");
    expect(readField('42; x="a,b;\\"c"; d=1.0; t=@42; b=:YQ:')).toEqual({ kind: "integer", value: 42 });
    expect(readField('%"%ef%bb%bfname"')).toEqual({ kind: "display", value: "\uFEFFname" });
    expect(readField("1.0").kind).toBe("decimal");
    expect(readField("@1").kind).toBe("date");
  });
  it("rejects malformed suffixes and finite parser work", () => {
    for (const input of ["?1, ?0", "1; x=(1)", "1e0", "1000000000000000", "1.0000", '%"%FF"', "1; X=?0"]) {
      expect(() => readField(input)).toThrow();
    }
    expect(() => readDictionary("a=1,")).toThrow();
    expect(() => readField("1" + ";a".repeat(64))).toThrow(RangeError);
    expect(() => readField(" ".repeat(8193))).toThrow(RangeError);
  });
});

describe("draft15 interop10 upload client", () => {
  it("creates, preserves absent optional HEAD fields, acknowledges chunks, and explicitly finishes", async () => {
    const server = fixture(), { upload, session } = await resource(server.fetch);
    expect(UploadSessionSchema.parse(JSON.parse(JSON.stringify(session)))).toEqual(session);
    expect(await upload.status()).toEqual({ offset: 0 });
    expect(await upload.append(0, new Uint8Array([1, 2]))).toEqual({ kind: "ack", offset: 2 });
    expect(await upload.append(2, new Uint8Array([3, 4]))).toEqual({ kind: "ack", offset: 4 });
    expect(server.terminal).toBe(false);
    const receipt = await upload.finish();
    expect(receipt.status).toBe(202);
    expect(new TextDecoder().decode(receipt.body)).toBe("application receipt");
    expect(server.bytes).toEqual([1, 2, 3, 4]);
    expect(server.methods).toEqual(["POST", "HEAD", "PATCH", "PATCH", "PATCH"]);
  });
  it("reconciles a lost acknowledgement and refuses decreasing acknowledged offsets", async () => {
    const server = fixture(), failure = new Error("lost reply");
    let lost = false;
    const { client, session, upload } = await resource(async (url, init) => {
      const result = await server.fetch(url, init);
      if (init?.method === "PATCH" && !lost) {
        lost = true;
        throw failure;
      }
      return result;
    });
    await upload.status();
    await expect(upload.append(0, new Uint8Array([1, 2]))).rejects.toBe(failure);
    await expect(upload.append(0, new Uint8Array([1, 2]))).rejects.toMatchObject({ code: "state" });
    const reopened = client.open(session, { acknowledgedOffset: 0 });
    expect(await reopened.status()).toEqual({ offset: 2 });
    expect(await reopened.append(2, new Uint8Array([3, 4]))).toEqual({ kind: "ack", offset: 4 });
    await expect(client.open(session, { acknowledgedOffset: 4 }).status()).resolves.toEqual({ offset: 4 });
    server.bytes.length = 0;
    await expect(reopened.status()).rejects.toMatchObject({ code: "protocol" });
  });
  it("admits resource URLs before credentials and confines substituted persisted targets", async () => {
    let auth = 0;
    const client = createUploadClient({
      profile: "draft-15",
      target,
      headers() {
        auth++;
        return {};
      },
      fetch: async () => new Response(null, { status: 201, headers: { Location: "https://evil.example/one" } }),
    });
    await expect(client.create({ method: "POST", size: 1 })).rejects.toThrow("outside");
    expect(auth).toBe(1);
    expect(() =>
      client.open({
        version: 1,
        draft: 15,
        interop: 10,
        method: "POST",
        target: "https://evil.example/",
        url: "https://evil.example/",
        size: 1,
      })
    ).toThrow("target");
    expect(auth).toBe(1);
  });
  it("copies native byte extents before asynchronous authentication", async () => {
    const server = fixture(), input = new Uint8Array([1, 2]);
    let getters = 0;
    for (const name of ["byteLength", "length", "buffer", "byteOffset"]) {
      Object.defineProperty(input, name, {
        get() {
          getters++;
          throw new Error("shadow");
        },
      });
    }
    const client = createUploadClient({
      profile: "draft-15",
      target,
      fetch: server.fetch,
      async headers() {
        input[0] = 9;
        return {};
      },
    });
    const created = await client.create({ method: "POST", size: 2 });
    if (created.kind !== "created") throw new Error("creation");
    const upload = client.open(created.session);
    await upload.status();
    input[0] = 1;
    await upload.append(0, input);
    expect(server.bytes).toEqual([1, 2]);
    expect(getters).toBe(0);
  });
  it("retains terminal application errors and terminal body failures without retry", async () => {
    const result = await createUploadClient({
      profile: "draft-15",
      target,
      fetch: async () => new Response("rejected", { status: 422, headers: { "Upload-Complete": "?1" } }),
    }).create({ method: "POST", size: 4 });
    expect(result.kind).toBe("terminal");
    if (result.kind === "terminal") expect(result.receipt.status).toBe(422);
    const failure = new Error("receipt failed");
    await expect(
      createUploadClient({
        profile: "draft-15",
        target,
        fetch: async () =>
          new Response(
            new ReadableStream({
              start(c) {
                c.error(failure);
              },
            }),
            { headers: { "Upload-Complete": "?1" } },
          ),
      }).create({ method: "POST", size: 4 }),
    ).rejects.toMatchObject({ terminal: true, cause: failure });
  });
  it("does not let a fresh child signal override opening cancellation", async () => {
    const server = fixture(), { client, session } = await resource(server.fetch);
    const controller = new AbortController(), reason = new Error("opening aborted");
    const upload = client.open(session, { signal: controller.signal });
    controller.abort(reason);
    await expect(upload.status({ signal: new AbortController().signal })).rejects.toBe(reason);
    expect(server.methods).toEqual(["POST"]);
  });
  it("bounds empty receipt chunks and releases the owned body", async () => {
    let cancelled = 0;
    await expect(
      createUploadClient({
        profile: "draft-15",
        target,
        maxResponseChunks: 2,
        fetch: async () =>
          new Response(
            new ReadableStream({
              pull(c) {
                c.enqueue(new Uint8Array());
              },
              cancel() {
                cancelled++;
              },
            }),
            { headers: { "Upload-Complete": "?1" } },
          ),
      }).create({ method: "POST", size: 0 }),
    ).rejects.toMatchObject({ terminal: true });
    expect(cancelled).toBe(1);
  });
  it("rejects contradictory interop and ignores malformed optional HEAD integers", async () => {
    const server = fixture();
    const { client, session } = await resource(server.fetch);
    const malformed = createUploadClient({
      profile: "draft-15",
      target,
      fetch: async () => new Response(null, { headers: { "Upload-Offset": "0; ext=?1", "Upload-Length": "4.0" } }),
    });
    expect(await malformed.open(session).status()).toEqual({ offset: 0 });
    const other = createUploadClient({
      profile: "draft-15",
      target,
      fetch: async () =>
        new Response(null, { status: 201, headers: { Location: "/one", "Upload-Draft-Interop-Version": "9" } }),
    });
    await expect(other.create({ method: "POST", size: 4 })).rejects.toMatchObject({ code: "protocol" });
    expect(() => client.open({ ...session, interop: 9 } as never)).toThrow();
  });
  it("does not treat acknowledged EOF or an absent append completeness field as terminal", async () => {
    const server = fixture();
    const { session } = await resource(server.fetch);
    let calls = 0;
    const client = createUploadClient({
      profile: "draft-15",
      target,
      fetch: async (_url, init) => {
        calls++;
        return new Response(null, { headers: init?.method === "HEAD" ? { "Upload-Offset": "4" } : {} });
      },
    });
    const upload = client.open(session);
    await upload.status();
    await expect(upload.finish()).rejects.toMatchObject({ code: "http" });
    await expect(upload.finish()).rejects.toMatchObject({ code: "state" });
    expect(calls).toBe(2);
    const unacknowledged = createUploadClient({
      profile: "draft-15",
      target,
      fetch: async (_url, init) =>
        new Response(null, { headers: init?.method === "HEAD" ? { "Upload-Offset": "0" } : {} }),
    }).open(session);
    await unacknowledged.status();
    await expect(unacknowledged.append(0, new Uint8Array([1]))).rejects.toMatchObject({ code: "http" });
  });
  it("charges attempted requests before authentication and enforces local and server chunk policy before I/O", async () => {
    let auth = 0, requests = 0;
    const { session } = await resource(fixture().fetch);
    const client = createUploadClient({
      profile: "draft-15",
      target,
      maxRequests: 1,
      maxChunkBytes: 1,
      headers() {
        auth++;
        return {};
      },
      fetch: async () => {
        requests++;
        return new Response(null, { headers: { "Upload-Offset": "0", "Upload-Limit": "max-append-size=1" } });
      },
    });
    const upload = client.open(session);
    await upload.status();
    await expect(upload.append(0, new Uint8Array([1, 2]))).rejects.toMatchObject({ code: "limit" });
    await expect(upload.append(0, new Uint8Array([1]))).rejects.toMatchObject({ code: "limit" });
    expect(auth).toBe(1);
    expect(requests).toBe(1);
  });
  it("retains a protocol refusal and unused-body cleanup failure together", async () => {
    const cleanup = new Error("cancel failed");
    await expect(
      createUploadClient({
        profile: "draft-15",
        target,
        fetch: async () =>
          new Response(
            new ReadableStream({
              cancel() {
                throw cleanup;
              },
            }),
            { status: 201 },
          ),
      }).create({ method: "POST", size: 1 }),
    ).rejects.toBeInstanceOf(AggregateError);
  });
});

/** The adapter discards parameter retention only; all parameter grammar must still be accepted or refused correctly. */
function primaryValue(value: FieldType): unknown {
  if (value.kind === "inner") return value.value.map(primaryValue);
  if (value.kind === "bytes") return { __type: "binary", value: encodeBase32(value.value) };
  if (value.kind === "token" || value.kind === "date" || value.kind === "display") {
    return { __type: value.kind === "display" ? "displaystring" : value.kind, value: value.value };
  }
  return value.value;
}
function primaryItem(value: unknown): unknown {
  if (!Array.isArray(value)) throw new TypeError("Invalid primary item fixture.");
  const bare: unknown = value[0];
  return Array.isArray(bare) ? bare.map(primaryItem) : bare;
}
interface PrimaryCaseType {
  readonly name: string;
  readonly raw: readonly string[];
  readonly header_type: string;
  readonly expected?: unknown;
  readonly must_fail?: boolean;
  readonly can_fail?: boolean;
}
describe("HTTPWG structured-field tests 10781e4 item/dictionary projection", () => {
  for (
    const [file, cases] of [
      ["number", numberCases],
      ["boolean", booleanCases],
      ["dictionary", dictionaryCases],
      ["item", itemCases],
      ["param-dict", parameterCases],
      ["display-string", displayCases],
      ["date", dateCases],
      ["binary", binaryCases],
    ] as const
  ) {
    for (const input of cases) {
      const example = input as PrimaryCaseType;
      if (example.header_type === "list") continue; // This internal profile exports item/dictionary, not list parsing.
      it(file + ".json / " + example.name, () => {
        const parse = () => {
          const raw = example.raw.join(", ");
          if (example.header_type === "dictionary") {
            return [...readDictionary(raw)].map(([key, value]) => [key, primaryValue(value)]);
          }
          return primaryValue(readField(raw));
        };
        if (example.must_fail) {
          expect(parse).toThrow();
          return;
        }
        let actual: unknown;
        try {
          actual = parse();
        } catch (reason) {
          if (example.can_fail) return;
          throw reason;
        }
        const expected = example.header_type === "dictionary"
          ? (example.expected as readonly (readonly [string, unknown])[]).map((
            [key, value],
          ) => [key, primaryItem(value)])
          : primaryItem(example.expected);
        expect(actual).toEqual(expected);
      });
    }
  }
});
