/** Azure: Raw Fetch bodies preserve native backing storage without invoking borrowed metadata. */
import { it } from "node:test";
import { expect } from "@std/expect";
import { runInNewContext } from "node:vm";
import { createAzureClient } from "../../src/backend/azure/client.ts";
import { isBuffer, toRequestBuffer, toRequestBytes } from "../../src/bytes.ts";

it("retains raw BodyInit view kinds while ignoring borrowed range metadata", async () => {
  for (const kind of ["DataView", "Uint16Array"] as const) {
    const backing = Uint8Array.of(7, 8).buffer;
    const bytes = kind === "DataView" ? new DataView(backing) : new Uint16Array(backing);
    for (const name of ["buffer", "byteOffset", "byteLength"]) {
      Object.defineProperty(bytes, name, {
        get() {
          throw new Error("Borrowed BodyInit metadata was consulted.");
        },
      });
    }
    let calls = 0;
    const client = createAzureClient({
      endpoint: "https://account.example.test",
      container: "owned",
      credential: { kind: "sas", token: "sig=authored" },
      fetch: async (input, init) => {
        calls++;
        const request = new Request(input, init);
        expect([...new Uint8Array(await request.arrayBuffer())]).toEqual([7, 8]);
        expect(request.headers.get("content-length")).toBe("2");
        return new Response(null);
      },
    });
    const response = await client.request({ method: "PUT", key: "raw", body: bytes });
    expect(response.ok).toBe(true);
    expect(calls).toBe(1);
  }
});

/** Creates actual raw buffers; own fields cannot describe their native wire range. */
function rawBuffer(realm: "same" | "foreign", resizable: boolean, empty = false): ArrayBuffer {
  const size = empty ? 0 : 3;
  const value = realm === "foreign"
    ? runInNewContext(
      `new ArrayBuffer(${size}, ${resizable ? `{maxByteLength:${size + 3}}` : "undefined"})`,
    ) as ArrayBuffer
    : resizable
    ? new ArrayBuffer(size, { maxByteLength: size + 3 })
    : new ArrayBuffer(size);
  if (!empty) new Uint8Array(value).set([1, 2, 3]);
  for (const name of ["byteLength", "resizable", "maxByteLength", "resize"]) {
    Object.defineProperty(value, name, {
      get() {
        throw new Error("Borrowed raw-buffer metadata was consulted.");
      },
    });
  }
  Object.defineProperty(value, Symbol.toStringTag, { value: "BorrowedBufferTag" });
  return value;
}

for (const realm of ["same", "foreign"] as const) {
  it(`captures ${realm} fixed raw buffers with own metadata`, () => {
    const value = rawBuffer(realm, false);
    expect(isBuffer(value)).toBe(true);
    const wire = toRequestBuffer(value);
    expect(wire).not.toBe(value);
    expect([...new Uint8Array(wire)]).toEqual([1, 2, 3]);
    expect([...new Uint8Array(value)]).toEqual([1, 2, 3]);
  });
}

it("does not widen raw BodyInit buffer admission to shared buffers, proxies or tags", () => {
  expect(isBuffer(new SharedArrayBuffer(3))).toBe(false);
  expect(isBuffer(new Proxy(new ArrayBuffer(3), {}))).toBe(false);
  expect(isBuffer({ [Symbol.toStringTag]: "ArrayBuffer", byteLength: 3 })).toBe(false);
});

for (const realm of ["same", "foreign"] as const) {
  for (const empty of [false, true]) {
    for (const seam of ["caller", "authorization"] as const) {
      it(`captures ${realm} ${empty ? "empty" : "payload"} raw RAB before ${seam} mutation`, async () => {
        const value = rawBuffer(realm, true, empty);
        const expected = empty ? [] : [1, 2, 3];
        expect(value instanceof ArrayBuffer).toBe(realm === "same");
        let mutations = 0, authorizations = 0, dispatches = 0;
        const mutate = () => {
          mutations++;
          ArrayBuffer.prototype.resize.call(value, empty ? 2 : 4);
          new Uint8Array(value).fill(9);
        };
        const client = createAzureClient({
          endpoint: "https://account.example.test",
          container: "owned",
          credential: {
            kind: "headers",
            get: ({ headers }) => {
              authorizations++;
              expect(headers.get("content-length")).toBe(String(expected.length));
              if (seam === "authorization") mutate();
              return { authorization: "synthetic" };
            },
          },
          fetch: async (input, init) => {
            dispatches++;
            expect(init?.body).not.toBe(value);
            const headers = new Headers(init?.headers);
            expect(headers.get("content-length")).toBe(String(expected.length));
            expect(headers.get("authorization")).toBe("synthetic");
            const request = new Request(input, init);
            expect([...new Uint8Array(await request.arrayBuffer())]).toEqual(expected);
            return new Response(null, { status: 201 });
          },
        });
        const writing = client.request({ method: "PUT", key: "raw", body: value, retry: false });
        if (seam === "caller") mutate();
        expect((await writing).status).toBe(201);
        expect({ mutations, authorizations, dispatches }).toEqual({ mutations: 1, authorizations: 1, dispatches: 1 });
        expect([...new Uint8Array(value)]).toEqual(empty ? [9, 9] : [9, 9, 9, 9]);
      });
    }
  }

  for (const shape of ["fixed", "resizable", "empty"] as const) {
    it(`signs exact ${realm} ${shape} raw BodyInit bytes through retries`, async () => {
      const empty = shape === "empty";
      const resizable = shape === "resizable";
      const value = rawBuffer(realm, resizable, empty);
      const expected = empty ? [] : [1, 2, 3];
      expect(value instanceof ArrayBuffer).toBe(realm === "same");
      // Calibrate the native consumer with clean authored storage. A host may
      // read hostile raw metadata; the provider must isolate the original input
      // below rather than requiring native Request to ignore those properties.
      const calibration = Uint8Array.from(expected).buffer;
      const native = new Request("https://calibration.example.test", { method: "PUT", body: calibration });
      expect([...new Uint8Array(await native.arrayBuffer())]).toEqual(expected);
      let dispatches = 0;
      let wire: unknown;
      const transport = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        dispatches++;
        const headers = new Headers(init?.headers);
        expect(headers.get("content-length")).toBe(String(expected.length));
        expect(headers.get("authorization")?.startsWith("SharedKey account:")).toBe(true);
        if (dispatches === 1) {
          wire = init?.body;
          expect(wire).not.toBe(value);
          if (resizable) ArrayBuffer.prototype.resize.call(value, 0);
        } else expect(init?.body).toBe(wire);
        const request = new Request(input, init);
        expect([...new Uint8Array(await request.arrayBuffer())]).toEqual(expected);
        return new Response(null, { status: dispatches === 1 ? 503 : 201 });
      };
      const client = createAzureClient({
        endpoint: "https://account.example.test",
        container: "owned",
        credential: { kind: "shared-key", account: "account", key: btoa("synthetic") },
        request: { retries: 1, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
        fetch: transport,
      });
      const response = await client.request({ method: "PUT", key: "raw", body: value });
      expect(response.status).toBe(201);
      expect(dispatches).toBe(2);
    });
  }

  it(`refuses a detached ${realm} raw buffer before credentials or transport`, async () => {
    const value = rawBuffer(realm, false);
    structuredClone(value, { transfer: [value] });
    let authorizations = 0;
    let dispatches = 0;
    const client = createAzureClient({
      endpoint: "https://account.example.test",
      container: "owned",
      credential: {
        kind: "headers",
        get: () => {
          authorizations++;
          return {};
        },
      },
      fetch: async () => {
        dispatches++;
        return new Response(null);
      },
    });
    await expect(client.request({ method: "PUT", key: "raw", body: value })).rejects.toBeInstanceOf(TypeError);
    expect(authorizations).toBe(0);
    expect(dispatches).toBe(0);
  });
}

for (const backingKind of ["local", "foreign", "detached flag", "detached getter", "custom prototype"] as const) {
  for (const route of ["raw", "view"] as const) {
    it(`isolates ${route} ${backingKind} backing before native wire extraction`, async () => {
      const size = route === "raw" ? 3 : 5;
      const backing: ArrayBuffer = backingKind === "foreign"
        ? runInNewContext(`new ArrayBuffer(${size})`) as ArrayBuffer
        : new ArrayBuffer(size);
      const whole = new Uint8Array(backing);
      whole.set(route === "raw" ? [1, 2, 3] : [99, 1, 2, 3, 98]);
      let getterReads = 0, dispatches = 0;
      const hostile = () => {
        getterReads++;
        throw new Error("Borrowed backing detached metadata was consulted.");
      };
      if (backingKind === "detached flag") Object.defineProperty(backing, "detached", { value: true });
      if (backingKind === "detached getter") Object.defineProperty(backing, "detached", { get: hostile });
      if (backingKind === "custom prototype") {
        Object.setPrototypeOf(backing, Object.create(ArrayBuffer.prototype, { detached: { get: hostile } }));
      }
      expect(backing instanceof ArrayBuffer).toBe(backingKind !== "foreign");
      const source = route === "raw" ? backing : new Uint8Array(backing, 1, 3);
      const prepared = route === "raw" ? toRequestBuffer(backing) : toRequestBytes(new Uint8Array(backing, 1, 3));
      const preparedBacking = ArrayBuffer.isView(prepared) ? prepared.buffer : prepared;
      expect(preparedBacking === backing).toBe(backingKind === "local");
      expect(Object.getPrototypeOf(preparedBacking)).toBe(ArrayBuffer.prototype);
      expect(Reflect.ownKeys(preparedBacking)).toEqual([]);
      expect(getterReads).toBe(0);
      const client = createAzureClient({
        endpoint: "https://account.example.test",
        container: "owned",
        credential: { kind: "shared-key", account: "account", key: btoa("synthetic") },
        fetch: async (input, init) => {
          dispatches++;
          const body = init?.body;
          if (!(body instanceof ArrayBuffer) && !ArrayBuffer.isView(body)) {
            throw new Error("A genuine byte source lost its materialized wire body.");
          }
          const wireBacking = ArrayBuffer.isView(body) ? body.buffer : body;
          expect(wireBacking === backing).toBe(backingKind === "local");
          expect(Object.getPrototypeOf(wireBacking)).toBe(ArrayBuffer.prototype);
          expect(Reflect.ownKeys(wireBacking)).toEqual([]);
          if (backingKind !== "local") whole.fill(9);
          expect(new Headers(init?.headers).get("content-length")).toBe("3");
          const request = new Request(input, init);
          expect([...new Uint8Array(await request.arrayBuffer())]).toEqual([1, 2, 3]);
          return new Response(null, { status: 201 });
        },
      });
      expect((await client.request({ method: "PUT", key: "wire", body: source, retry: false })).status).toBe(201);
      expect({ dispatches, getterReads }).toEqual({ dispatches: 1, getterReads: 0 });
    });
  }
}
