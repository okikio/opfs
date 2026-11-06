import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { createTusClient, TusError } from "../src/tus.ts";
import type { FetchType } from "../src/request.ts";
import { createTransferCheckpoint, resumeTransfer } from "../src/transfer.ts";

/** Authored protocol fixture; no hosted credentials or network connection. */
function fixture() {
  const bytes: number[] = [];
  const methods: string[] = [];
  let removed = false;
  const fetch: FetchType = async (_input, init = {}) => {
    const headers = new Headers(init.headers);
    const method = init.method ?? "GET";
    methods.push(method);
    if (method === "OPTIONS") {
      expect(headers.has("Tus-Resumable")).toBe(false);
      return new Response(null, {
        status: 204,
        headers: { "Tus-Version": "1.0.0", "Tus-Extension": "creation,termination", "Tus-Max-Size": "8" },
      });
    }
    expect(headers.get("Tus-Resumable")).toBe("1.0.0");
    const reply = { "Tus-Resumable": "1.0.0" };
    if (removed) return new Response(null, { status: 410, headers: reply });
    if (method === "POST") return new Response(null, { status: 201, headers: { ...reply, Location: "/upload/1" } });
    if (method === "HEAD") {
      return new Response(null, { headers: { ...reply, "Upload-Offset": String(bytes.length), "Upload-Length": "4" } });
    }
    if (method === "DELETE") {
      removed = true;
      return new Response(null, { status: 204, headers: reply });
    }
    if (method === "PATCH") {
      expect(headers.get("Content-Type")).toBe("application/offset+octet-stream");
      if (Number(headers.get("Upload-Offset")) !== bytes.length) {
        return new Response(null, { status: 409, headers: reply });
      }
      bytes.push(...new Uint8Array(await new Response(init.body).arrayBuffer()));
      return new Response(null, { status: 204, headers: { ...reply, "Upload-Offset": String(bytes.length) } });
    }
    throw new Error("Unexpected fixture method.");
  };
  return { fetch, bytes, methods };
}

describe("tus 1.0 client", () => {
  it("snapshots native byte extents before asynchronous authentication", async () => {
    const server = fixture();
    const input = new Uint8Array([1, 2]);
    let getters = 0;
    for (const name of ["byteLength", "byteOffset", "buffer", "length"]) {
      Object.defineProperty(input, name, {
        get() {
          getters++;
          throw new Error("Unexpected caller byte metadata access.");
        },
      });
    }
    const client = createTusClient({
      endpoint: "https://tus.example/uploads",
      fetch: server.fetch,
      async headers() {
        input[0] = 99;
        return {};
      },
    });
    expect(await client.write("/one", 0, input)).toBe(2);
    expect(server.bytes).toEqual([1, 2]);
    expect(getters).toBe(0);
  });
  it("creates, sends exact offsets, reconciles and explicitly terminates", async () => {
    const server = fixture();
    const client = createTusClient({ endpoint: "https://tus.example/uploads", fetch: server.fetch });
    const upload = await client.create(4, { filename: "hello.txt" });
    expect(upload.url).toBe("https://tus.example/upload/1");
    expect(await upload.write(0, new Uint8Array([1, 2]))).toBe(2);
    expect(await upload.status()).toEqual({ offset: 2, size: 4, complete: false });
    expect(await upload.write(2, new Uint8Array([3, 4]))).toBe(4);
    await upload.terminate?.();
    await expect(upload.status()).rejects.toMatchObject({ code: "missing", status: 410 });
    expect(server.bytes).toEqual([1, 2, 3, 4]);
    expect(server.methods).toEqual(["OPTIONS", "POST", "PATCH", "HEAD", "PATCH", "OPTIONS", "DELETE", "HEAD"]);
  });

  it("does not retry PATCH and exposes offset conflicts", async () => {
    const server = fixture();
    const client = createTusClient({ endpoint: "https://tus.example/uploads", fetch: server.fetch });
    await expect(client.write("/upload/1", 2, new Uint8Array([1]))).rejects.toMatchObject({ code: "conflict" });
    expect(server.methods).toEqual(["PATCH"]);
    expect(server.bytes).toEqual([]);
  });

  it("resumes after a transport failure whose PATCH already reached the server", async () => {
    const server = fixture();
    let lost = false;
    const failure = new Error("acknowledgment connection lost");
    const client = createTusClient({
      endpoint: "https://tus.example/uploads",
      fetch: async (input, init) => {
        const response = await server.fetch(input, init);
        if (init?.method === "PATCH" && !lost) {
          lost = true;
          throw failure;
        }
        return response;
      },
    });
    const source = {
      identity: "immutable-v1",
      size: 4,
      async read(offset: number, length: number) {
        return new Uint8Array([1, 2, 3, 4]).slice(offset, offset + length);
      },
    };
    const destination = await client.create(4);
    let checkpoint = createTransferCheckpoint(source, destination);
    const save = async (value: typeof checkpoint) => {
      checkpoint = value;
    };
    await expect(resumeTransfer({ source, destination, checkpoint, save, chunkBytes: 2 })).rejects.toBe(failure);
    expect(checkpoint.offset).toBe(0);
    expect(server.bytes).toEqual([1, 2]);
    const result = await resumeTransfer({ source, destination, checkpoint, save, chunkBytes: 2 });
    expect(result.state).toBe("completed");
    expect(server.bytes).toEqual([1, 2, 3, 4]);
    expect(server.methods).toEqual(["OPTIONS", "POST", "HEAD", "PATCH", "HEAD", "PATCH", "HEAD"]);
  });

  it("rejects unadvertised creation and termination before remote mutation", async () => {
    const methods: string[] = [];
    const client = createTusClient({
      endpoint: "https://tus.example/uploads",
      fetch: async (_input, init) => {
        methods.push(init?.method ?? "GET");
        return new Response(null, { status: 204, headers: { "Tus-Version": "1.0.0" } });
      },
    });
    await expect(client.create(1)).rejects.toMatchObject({ code: "unsupported" });
    await expect(client.terminate("/one")).rejects.toMatchObject({ code: "unsupported" });
    expect(methods).toEqual(["OPTIONS", "OPTIONS"]);
  });

  it("blocks unapproved upload locations before sending credentials there", async () => {
    const targets: string[] = [];
    const client = createTusClient({
      endpoint: "https://tus.example/uploads",
      headers: { Authorization: "Bearer test" },
      fetch: async (input, init) => {
        targets.push(String(input));
        expect(init?.redirect).toBe("error");
        expect(init?.credentials).toBe("omit");
        return init?.method === "OPTIONS"
          ? new Response(null, { status: 204, headers: { "Tus-Version": "1.0.0", "Tus-Extension": "creation" } })
          : new Response(null, {
            status: 201,
            headers: { "Tus-Resumable": "1.0.0", Location: "https://other.example/steal" },
          });
      },
    });
    await expect(client.create(1)).rejects.toBeInstanceOf(TypeError);
    expect(targets).toEqual(["https://tus.example/uploads", "https://tus.example/uploads"]);
    expect(() => client.open("https://other.example/upload")).toThrow(TypeError);
  });

  it("rejects malformed offsets and missing version confirmation", async () => {
    for (const offset of ["-1", "1.5", "9007199254740992"]) {
      const client = createTusClient({
        endpoint: "https://tus.example",
        fetch: async () =>
          new Response(null, {
            headers: {
              "Tus-Resumable": "1.0.0",
              "Upload-Length": "4",
              "Upload-Offset": offset,
            },
          }),
      });
      await expect(client.status("/one")).rejects.toBeInstanceOf(TusError);
    }
    const client = createTusClient({
      endpoint: "https://tus.example",
      fetch: async () => new Response(null, { headers: { "Upload-Length": "4", "Upload-Offset": "0" } }),
    });
    await expect(client.status("/one")).rejects.toMatchObject({ code: "protocol" });
  });

  it("cancels unexpected response bodies instead of buffering them", async () => {
    let closed = 0;
    const client = createTusClient({
      endpoint: "https://tus.example",
      fetch: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              closed++;
            },
          }),
          {
            headers: { "Tus-Resumable": "1.0.0", "Upload-Length": "4", "Upload-Offset": "0" },
          },
        ),
    });
    expect(await client.status("/one")).toEqual({ offset: 0, size: 4, complete: false });
    expect(closed).toBe(1);
  });

  it("retains protocol failure beside failed response retirement", async () => {
    const cleanup = new Error("response cleanup failure");
    const client = createTusClient({
      endpoint: "https://tus.example",
      fetch: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              throw cleanup;
            },
          }),
        ),
    });
    let caught: unknown;
    try {
      await client.status("/one");
    } catch (reason) {
      caught = reason;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    const aggregate = caught as AggregateError;
    expect(aggregate.errors[0]).toBeInstanceOf(TusError);
    expect(aggregate.errors[1]).toBe(cleanup);
    expect(aggregate.cause).toBe(aggregate.errors[0]);
  });
});
