/** S3: Materialized byte views preserve admitted extents across realms and backing changes. */
import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { Buffer } from "node:buffer";
import { runInNewContext } from "node:vm";
import { createS3Client } from "../../src/backend/s3/client.ts";
import { credentials } from "./fixture.ts";

describe("S3 materialized put byte admission", () => {
  const positive = [
    ["empty", () => new Uint8Array(0), []],
    ["shared empty", () => new Uint8Array(new SharedArrayBuffer(0)), []],
    ["shared offset", () => {
      const view = new Uint8Array(new SharedArrayBuffer(4));
      view.set([99, 17, 31, 98]);
      return view.subarray(1, 3);
    }, [17, 31]],
    ["offset", () => Uint8Array.of(99, 17, 31, 88).subarray(1, 3), [17, 31]],
    ["Buffer offset", () => Buffer.from([99, 17, 31, 88]).subarray(1, 3), [17, 31]],
    ["subclass", () => {
      class Bytes extends Uint8Array {}
      return new Bytes([17, 31]);
    }, [17, 31]],
    ["foreign realm offset", () => {
      const bytes: unknown = runInNewContext("new Uint8Array([99,17,31,88]).subarray(1,3)");
      expect(ArrayBuffer.isView(bytes)).toBe(true);
      expect(bytes instanceof Uint8Array).toBe(false);
      return bytes;
    }, [17, 31]],
    ["resizable offset", () => {
      const backing = new ArrayBuffer(4, { maxByteLength: 8 });
      const view = new Uint8Array(backing);
      view.set([99, 17, 31, 88]);
      return view.subarray(1, 3);
    }, [17, 31]],
    ["resizable tracking empty", () => {
      const backing = new ArrayBuffer(2, { maxByteLength: 4 });
      const view = new Uint8Array(backing);
      backing.resize(0);
      return view;
    }, []],
  ] as const;
  for (const [kind, create, expected] of positive) {
    it(`accepts genuine readable ${kind} with exact request bytes`, async () => {
      let calls = 0;
      let observed: number[] | undefined;
      const client = createS3Client({
        endpoint: "https://s3.example.test",
        bucket: "owned",
        region: "us-east-1",
        credentials,
        fetch: async (input, init) => {
          calls++;
          const request = new Request(input, init);
          observed = [...new Uint8Array(await request.arrayBuffer())];
          return new Response(null, { headers: { etag: '"accepted"' } });
        },
      });
      const bytes: unknown = create();
      await Reflect.apply(client.put, client, ["destination", bytes]);
      expect(calls).toBe(1);
      expect(observed).toEqual(expected);
    });
  }

  const invalid = [
    ["detached zero-length view", () => {
      const bytes = Uint8Array.of(17);
      structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
      expect(bytes.byteLength).toBe(0);
      return bytes;
    }],
    ["out-of-bounds zero-length view", () => {
      const backing = new ArrayBuffer(4, { maxByteLength: 8 });
      const bytes = new Uint8Array(backing, 2, 2);
      backing.resize(1);
      expect(bytes.byteLength).toBe(0);
      return bytes;
    }],
    ["Int8Array", () => new Int8Array([17])],
    ["Uint16Array", () => new Uint16Array([17])],
    ["DataView", () => new DataView(new ArrayBuffer(1))],
    ["tag spoof", () => ({ [Symbol.toStringTag]: "Uint8Array", byteLength: 0 })],
    ["ordinary object", () => ({ byteLength: 0 })],
  ] as const;
  for (const [kind, create] of invalid) {
    it(`rejects ${kind} before request or remote allocation`, async () => {
      let calls = 0;
      const client = createS3Client({
        endpoint: "https://s3.example.test",
        bucket: "owned",
        region: "us-east-1",
        credentials,
        fetch: async () => {
          calls++;
          return new Response(null, { headers: { etag: '"unexpected"' } });
        },
      });
      const bytes: unknown = create();
      await expect(Reflect.apply(client.put, client, ["destination", bytes])).rejects.toBeInstanceOf(TypeError);
      expect(calls).toBe(0);
    });
  }
});

describe("S3 materialized part byte admission", () => {
  const positive = [
    ["empty", () => new Uint8Array(0), []],
    ["shared empty", () => new Uint8Array(new SharedArrayBuffer(0)), []],
    ["shared offset", () => {
      const view = new Uint8Array(new SharedArrayBuffer(4));
      view.set([99, 17, 31, 98]);
      return view.subarray(1, 3);
    }, [17, 31]],
    ["offset", () => Uint8Array.of(99, 17, 31, 88).subarray(1, 3), [17, 31]],
    ["Buffer offset", () => Buffer.from([99, 17, 31, 88]).subarray(1, 3), [17, 31]],
    ["subclass", () => {
      class Bytes extends Uint8Array {}
      return new Bytes([17, 31]);
    }, [17, 31]],
    ["foreign realm offset", () => {
      const bytes: unknown = runInNewContext("new Uint8Array([99,17,31,88]).subarray(1,3)");
      expect(ArrayBuffer.isView(bytes)).toBe(true);
      expect(bytes instanceof Uint8Array).toBe(false);
      return bytes;
    }, [17, 31]],
    ["resizable offset", () => {
      const backing = new ArrayBuffer(4, { maxByteLength: 8 });
      const view = new Uint8Array(backing);
      view.set([99, 17, 31, 88]);
      return view.subarray(1, 3);
    }, [17, 31]],
    ["resizable tracking empty", () => {
      const backing = new ArrayBuffer(2, { maxByteLength: 4 });
      const view = new Uint8Array(backing);
      backing.resize(0);
      return view;
    }, []],
  ] as const;
  for (const [kind, create, expected] of positive) {
    it(`accepts genuine readable ${kind} with exact request bytes`, async () => {
      let calls = 0;
      let observed: number[] | undefined;
      const client = createS3Client({
        endpoint: "https://s3.example.test",
        bucket: "owned",
        region: "us-east-1",
        credentials,
        fetch: async (input, init) => {
          calls++;
          const request = new Request(input, init);
          observed = [...new Uint8Array(await request.arrayBuffer())];
          return new Response(null, { headers: { etag: '"accepted"' } });
        },
      });
      const bytes: unknown = create();
      await Reflect.apply(client.uploadPart, client, [{ key: "destination", id: "caller-owned" }, 1, bytes]);
      expect(calls).toBe(1);
      expect(observed).toEqual(expected);
    });
  }

  const invalid = [
    ["detached zero-length view", () => {
      const bytes = Uint8Array.of(17);
      structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
      expect(bytes.byteLength).toBe(0);
      return bytes;
    }],
    ["out-of-bounds zero-length view", () => {
      const backing = new ArrayBuffer(4, { maxByteLength: 8 });
      const bytes = new Uint8Array(backing, 2, 2);
      backing.resize(1);
      expect(bytes.byteLength).toBe(0);
      return bytes;
    }],
    ["Int8Array", () => new Int8Array([17])],
    ["Uint16Array", () => new Uint16Array([17])],
    ["DataView", () => new DataView(new ArrayBuffer(1))],
    ["tag spoof", () => ({ [Symbol.toStringTag]: "Uint8Array", byteLength: 0 })],
    ["ordinary object", () => ({ byteLength: 0 })],
  ] as const;
  for (const [kind, create] of invalid) {
    it(`rejects ${kind} before request or remote allocation`, async () => {
      let calls = 0;
      const client = createS3Client({
        endpoint: "https://s3.example.test",
        bucket: "owned",
        region: "us-east-1",
        credentials,
        fetch: async () => {
          calls++;
          return new Response(null, { headers: { etag: '"unexpected"' } });
        },
      });
      const bytes: unknown = create();
      await expect(Reflect.apply(client.uploadPart, client, [{ key: "destination", id: "caller-owned" }, 1, bytes]))
        .rejects.toBeInstanceOf(TypeError);
      expect(calls).toBe(0);
    });
  }
});

describe("S3 intrinsic byte metadata", () => {
  for (const poisoned of [false, true]) {
    it(`uses the two native bytes despite ${poisoned ? "throwing range getters" : "a shadowed zero length"}`, async () => {
      const bytes = Uint8Array.of(99, 7, 8, 98).subarray(1, 3);
      Object.defineProperty(bytes, "byteLength", { value: 0 });
      if (poisoned) {
        for (const name of ["buffer", "byteOffset", "subarray", Symbol.iterator]) {
          Object.defineProperty(bytes, name, {
            get() {
              throw new Error("Borrowed metadata was consulted.");
            },
          });
        }
      }
      let calls = 0;
      const client = createS3Client({
        endpoint: "https://s3.example.test",
        bucket: "owned",
        region: "us-east-1",
        credentials,
        fetch: async (input, init) => {
          calls++;
          const request = new Request(input, init);
          expect([...new Uint8Array(await request.arrayBuffer())]).toEqual([7, 8]);
          const digest = await crypto.subtle.digest("SHA-256", Uint8Array.of(7, 8));
          const expectedHash = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
          expect(request.headers.get("x-amz-content-sha256")).toBe(expectedHash);
          return new Response(null, { status: 200, headers: { etag: '"accepted"' } });
        },
      });
      const receipt = await client.put("destination", bytes);
      expect(receipt.size).toBe(2);
      expect(calls).toBe(1);
      await expect(client.put("destination", bytes, { size: 0 })).rejects.toBeInstanceOf(RangeError);
      expect(calls).toBe(1);
    });
  }
});

for (const kind of ["shared", "resizable"] as const) {
  it(`captures ${kind} wire bytes and receipt size before credential-time source changes`, async () => {
    const backing = kind === "shared" ? new SharedArrayBuffer(4) : new ArrayBuffer(4, { maxByteLength: 8 });
    const whole = new Uint8Array(backing);
    whole.set([99, 7, 8, 98]);
    const bytes = whole.subarray(1, 3);
    let authorizations = 0;
    const change = () => {
      authorizations++;
      if (backing instanceof ArrayBuffer) backing.resize(0);
      else whole.set([0, 9, 10, 0]);
    };
    const client = createS3Client({
      endpoint: "https://s3.example.test",
      bucket: "owned",
      region: "us-east-1",
      credentials: () => {
        change();
        return credentials;
      },
      fetch: async (input, init) => {
        const request = new Request(input, init);
        expect([...new Uint8Array(await request.arrayBuffer())]).toEqual([7, 8]);
        const digest = await crypto.subtle.digest("SHA-256", Uint8Array.of(7, 8));
        const hash = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
        expect(request.headers.get("x-amz-content-sha256")).toBe(hash);
        return new Response(null, { status: 200, headers: { etag: '"accepted"' } });
      },
    });
    const receipt = await client.put("destination", bytes, { size: 2 });
    expect(receipt.size).toBe(2);
    expect(authorizations).toBe(1);
  });
}
