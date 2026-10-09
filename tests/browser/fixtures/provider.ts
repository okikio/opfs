import { createS3Client } from "../../../src/s3.ts";
import { createAzureClient } from "../../../src/azure.ts";
import type { FetchType } from "../../../src/request.ts";
import { isStream } from "../../../src/body.ts";
import type { ProviderBodyOptionsType, ProviderBodyResultType } from "./api.ts";

/**
 * Calibrates this browser's actual native consumer independently of the guard.
 * The private two-byte source is finite and opens no caller reader or network.
 * Text conversion cannot satisfy the byte oracle even when construction succeeds.
 */
async function nativeStreamAdmission(): Promise<boolean> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([17, 31]));
      controller.close();
    },
  }, { highWaterMark: 0 });
  const init: RequestInit & { duplex: "half" } = { method: "POST", body: source, duplex: "half" };
  try {
    const request = new Request("https://storage.example/native-stream-calibration", init);
    const bytes = new Uint8Array(await request.arrayBuffer());
    return !request.headers.has("content-type") && bytes.length === 2 && bytes[0] === 17 && bytes[1] === 31;
  } catch {
    return false;
  }
}

/**
 * Transfers genuine same-origin iframe bodies to parent-realm provider clients.
 *
 * No prototype replacement simulates the realm. A capable custom transport
 * consumes stream bytes through their reader; native default controls consume
 * a native Request after its actual capability check. Both return finite REST
 * acknowledgements. This proves admission and ownership, not cloud networking.
 */
export async function providerBody(options: ProviderBodyOptionsType): Promise<ProviderBodyResultType> {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const originalFetch = globalThis.fetch;
  try {
    // Initial about:blank inherits the containing origin and owns fresh native constructors.
    const realm = frame.contentWindow as (Window & typeof globalThis) | null;
    if (realm === null) throw new Error("The same-origin iframe did not expose its realm.");
    if (options.body === "buffer" && options.route !== "request") {
      throw new TypeError("The raw ArrayBuffer fixture requires the low-level BodyInit route.");
    }
    // Exercise the actual iframe native feature, independently of production
    // admission and without assuming constructor options are implemented.
    const resizable = Object.getOwnPropertyDescriptor(realm.ArrayBuffer.prototype, "resizable")?.get;
    const resize = Object.getOwnPropertyDescriptor(realm.ArrayBuffer.prototype, "resize")?.value;
    let resizableSupported = false;
    if (resizable !== undefined && typeof resize === "function") {
      const probe = new realm.ArrayBuffer(0, { maxByteLength: 4 });
      if (Reflect.apply(resizable, probe, []) === true) {
        Reflect.apply(resize, probe, [1]);
        resizableSupported = probe.byteLength === 1;
      }
    }
    const raw = new realm.ArrayBuffer(options.empty ? 0 : 2, {
      ...(options.resizable && resizableSupported ? { maxByteLength: 4 } : {}),
    });
    if (!options.empty) new realm.Uint8Array(raw).set([17, 31]);
    const rawResizable = resizable !== undefined && Reflect.apply(resizable, raw, []) === true;
    const lengthBefore = raw.byteLength;
    const expected = new Uint8Array(options.empty ? [] : [17, 31]);
    const expectedSha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", expected))]
      .map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const hashes: Array<string | null> = [], wireFixed: boolean[] = [], borrowed: boolean[] = [];
    const backing = new realm.Uint8Array([99, 17, 31, 98]);
    const payload = options.empty ? new realm.Uint8Array() : backing.subarray(1, 3);
    let cancellations = 0, pulls = 0, credentialCalls = 0;
    const source = new realm.ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        if (!options.empty) controller.enqueue(payload);
        if (!(options.provider === "azure" && options.route === "put" && options.body === "stream" && !options.mode)) {
          controller.close();
        }
      },
      cancel() {
        cancellations++;
      },
    }, { highWaterMark: 0 });
    const locked = Object.getOwnPropertyDescriptor(ReadableStream.prototype, "locked")?.get;
    if (locked === undefined) throw new Error("Parent native stream lock getter is absent.");
    const intrinsicUnlocked = Reflect.apply(locked, source, []) === false;
    const body = options.body === "stream" ? source : options.body === "buffer" ? raw : payload;
    const foreign = options.body === "stream"
      ? !(body instanceof ReadableStream)
      : options.body === "buffer"
      ? !(body instanceof ArrayBuffer)
      : !(body instanceof Uint8Array);
    const requests: Array<ProviderBodyResultType["requests"][number]> = [];
    const transport: FetchType = async (input, init) => {
      if (options.body === "buffer") {
        // Mutate the original before native Request snapshots its admitted body.
        // A provider that forwards caller RAB storage now transmits different bytes.
        if (rawResizable) {
          if (typeof resize !== "function") throw new Error("Native resize disappeared after admission.");
          Reflect.apply(resize, raw, [4]);
          new realm.Uint8Array(raw).fill(9);
        }
        const fixed = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")?.get;
        wireFixed.push(fixed === undefined || Reflect.apply(fixed, init?.body, []) === false);
        borrowed.push(init?.body === raw);
        hashes.push(new Headers(init?.headers).get("x-amz-content-sha256"));
      }
      const streamed = isStream(init?.body);
      const custom = options.transport !== "default" && streamed;
      const request = new Request(input, custom ? { ...init, body: null } : init);
      let bytes: number[];
      if (custom) {
        if (!isStream(init?.body)) throw new Error("A custom streamed body lost its native admission.");
        const reader = init.body.getReader();
        bytes = [];
        try {
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            bytes.push(...next.value);
            if (bytes.length > 2) throw new Error("The finite provider fixture exceeded its byte bound.");
          }
        } finally {
          reader.releaseLock();
        }
      } else bytes = [...new Uint8Array(await request.arrayBuffer())];
      const query = new URL(request.url).searchParams;
      const stage = options.route === "request"
        ? "direct"
        : query.has("uploads")
        ? "allocate"
        : request.method === "DELETE"
        ? "abort"
        : query.has("partNumber") || query.get("comp") === "block"
        ? "part"
        : query.has("uploadId") || query.get("comp") === "blocklist"
        ? "commit"
        : "put";
      requests.push({
        stage,
        bytes,
        duplex: Reflect.get(init ?? {}, "duplex") === "half",
        // Browser Request guards can remove forbidden Content-Length. Inspect
        // client preparation separately from native Request body consumption.
        length: new Headers(init?.headers).get("content-length"),
      });
      if (options.route === "request") return new Response(null, { status: 503 });
      if (stage === "allocate") {
        return new Response(
          "<InitiateMultipartUploadResult><UploadId>fixture</UploadId></InitiateMultipartUploadResult>",
        );
      }
      if (stage === "commit" && options.provider === "s3") {
        return new Response('<CompleteMultipartUploadResult><ETag>"accepted"</ETag></CompleteMultipartUploadResult>');
      }
      return new Response(null, { status: options.provider === "azure" ? 201 : 200, headers: { etag: '"accepted"' } });
    };
    const nativeRequestStreams = await nativeStreamAdmission();
    // Keep default admission real while replacing only network dispatch with
    // finite native Request consumption. Explicit Fetch injection uses the
    // separately capable transport contract above.
    if (options.transport === "default") Reflect.set(globalThis, "fetch", transport);
    const fetchOptions = options.transport === "default" ? {} : { fetch: transport };
    const request = { retries: 4, minDelayMs: 0, maxDelayMs: 0, jitter: 0 };
    const client = options.provider === "s3"
      ? createS3Client({
        endpoint: "https://storage.example",
        bucket: "bucket",
        region: "us-east-1",
        credentials: () => {
          credentialCalls++;
          return { accessKeyId: "synthetic", secretAccessKey: "synthetic" };
        },
        delayedMultipart: options.mode,
        ...fetchOptions,
        request,
      })
      : createAzureClient({
        endpoint: "https://account.blob.core.windows.net",
        container: "container",
        credential: options.transport === "default"
          ? {
            kind: "headers",
            get: () => {
              credentialCalls++;
              return { authorization: "synthetic" };
            },
          }
          : { kind: "shared-key", account: "account", key: btoa("synthetic") },
        blockUpload: options.mode,
        ...fetchOptions,
        request,
      });
    let status: number | undefined;
    let size: number | undefined;
    let error: string | undefined;
    try {
      if (options.body === "buffer" && options.resizable && !resizableSupported) {
        // This realm has no admitted native RAB feature; retain explicit absence
        // observations without pretending a fixed buffer exercised that capability.
      } else if (options.route === "request") {
        const response = await client.request({
          method: "PUT",
          key: "realm.bin",
          body,
          ...(options.length ? { headers: { "content-length": String(payload.byteLength) } } : {}),
          ...(options.body === "buffer" ? { retry: false } : {}),
        });
        status = response.status;
      } else {
        // Raw ArrayBuffers belong to low-level BodyInit, not the public source union.
        size = (await client.put("realm.bin", options.body === "stream" ? source : payload, {
          size: payload.byteLength,
        })).size;
      }
    } catch (reason) {
      if (!(reason instanceof TypeError)) throw reason;
      error = reason.name;
    }
    return {
      foreign,
      intrinsicUnlocked,
      requests,
      locked: source.locked,
      cancellations,
      nativeRequestStreams,
      pulls,
      credentialCalls,
      ...(options.body === "buffer"
        ? {
          buffer: {
            resizableSupported,
            resizable: rawResizable,
            lengthBefore,
            lengthAfter: raw.byteLength,
            expectedSha256,
            hashes,
            wireFixed,
            borrowed,
          },
        }
        : {}),
      ...(status === undefined ? {} : { status }),
      ...(size === undefined ? {} : { size }),
      ...(error === undefined ? {} : { error }),
    };
  } finally {
    Reflect.set(globalThis, "fetch", originalFetch);
    frame.remove();
  }
}
