import { createS3Client } from "../../../src/s3.ts";
import { createAzureClient } from "../../../src/azure.ts";
import type { FetchType } from "../../../src/request.ts";
import type { ProviderBodyOptionsType, ProviderBodyResultType } from "./api.ts";

/**
 * Transfers genuine same-origin iframe bodies to parent-realm provider clients.
 *
 * No prototype replacement simulates the realm. The injected transport consumes
 * a parent-native Request, then supplies finite REST acknowledgements. This
 * proves browser admission and ownership, not live cloud interoperability.
 */
export async function providerBody(options: ProviderBodyOptionsType): Promise<ProviderBodyResultType> {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  try {
    // Initial about:blank inherits the containing origin and owns fresh native constructors.
    const realm = frame.contentWindow as (Window & typeof globalThis) | null;
    if (realm === null) throw new Error("The same-origin iframe did not expose its realm.");
    const backing = new realm.Uint8Array([99, 17, 31, 98]);
    const payload = options.empty ? new realm.Uint8Array() : backing.subarray(1, 3);
    let cancellations = 0;
    const source = new realm.ReadableStream<Uint8Array>({
      start(controller) {
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
    const body = options.body === "stream" ? source : payload;
    const foreign = options.body === "stream" ? !(body instanceof ReadableStream) : !(body instanceof Uint8Array);
    const requests: Array<ProviderBodyResultType["requests"][number]> = [];
    const transport: FetchType = async (input, init) => {
      const request = new Request(input, init);
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
        bytes: [...new Uint8Array(await request.arrayBuffer())],
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
    const request = { retries: 4, minDelayMs: 0, maxDelayMs: 0, jitter: 0 };
    const client = options.provider === "s3"
      ? createS3Client({
        endpoint: "https://storage.example",
        bucket: "bucket",
        region: "us-east-1",
        credentials: { accessKeyId: "synthetic", secretAccessKey: "synthetic" },
        delayedMultipart: options.mode,
        fetch: transport,
        request,
      })
      : createAzureClient({
        endpoint: "https://account.blob.core.windows.net",
        container: "container",
        credential: { kind: "shared-key", account: "account", key: btoa("synthetic") },
        blockUpload: options.mode,
        fetch: transport,
        request,
      });
    let status: number | undefined;
    let size: number | undefined;
    let error: string | undefined;
    try {
      if (options.route === "request") {
        const response = await client.request({
          method: "PUT",
          key: "realm.bin",
          body: source,
          ...(options.length ? { headers: { "content-length": String(payload.byteLength) } } : {}),
        });
        status = response.status;
      } else {
        size = (await client.put("realm.bin", body, { size: payload.byteLength })).size;
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
      ...(status === undefined ? {} : { status }),
      ...(size === undefined ? {} : { size }),
      ...(error === undefined ? {} : { error }),
    };
  } finally {
    frame.remove();
  }
}
