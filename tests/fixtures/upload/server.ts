/** Test-only loopback transport around immutable, unmodified upstream interop10 and FS store. */
import { createServer } from "node:http";
import { once } from "node:events";
import { Buffer } from "node:buffer";
import process from "node:process";

/** Only the exercised upstream options cross this container-only import boundary. */
interface NativeOptionsType {
  readonly key: (creation: { readonly request: Request }) => string;
  readonly location: (token: string) => string;
  readonly resolveToken: (request: Request) => string | undefined;
  readonly policy: { readonly maxSize: number };
  readonly graceMs: number;
  readonly onError: (error: unknown) => void;
}

// These exact modules are reconstructed from verified inert Git blobs by the owning provider fixture.
const uploadURL = new URL("./source/src/upload.ts", import.meta.url).href;
const storeURL = new URL("./source/src/fs.ts", import.meta.url).href;
const native: {
  createUploadHandler(store: unknown, options: NativeOptionsType): (request: Request) => Promise<Response>;
} = await import(uploadURL);
const storage: { fsUploadStore(options: { readonly root: string }): unknown } = await import(storeURL);
const root = process.argv[2];
if (!root) throw new Error("Explicit fixture root required.");
const failures: string[] = [];
let diagnosticBytes = 0;
/** Bound diagnostic retention independently of payload admission. */
function diagnostic(error: unknown): void {
  const text = String(error).slice(0, 4096);
  diagnosticBytes += text.length;
  if (failures.length < 64 && diagnosticBytes <= 65536) failures.push(text);
}
const handler = native.createUploadHandler(storage.fsUploadStore({ root }), {
  key: ({ request }) => {
    const key = new URL(request.url).searchParams.get("key");
    if (!key || !/^[a-z0-9-]+\.bin$/.test(key)) throw new Error("Fixture key rejected.");
    return key;
  },
  location: (token) => "/uploads/" + token,
  resolveToken: (request) => {
    const path = new URL(request.url).pathname;
    return path.startsWith("/uploads/") ? path.slice(9) : undefined;
  },
  policy: { maxSize: 2 * 1024 * 1024 },
  graceMs: 0,
  onError: diagnostic,
});
const server = createServer(async (incoming, outgoing) => {
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const value of incoming) {
      if (!(value instanceof Uint8Array)) throw new Error("Fixture request returned a non-byte chunk.");
      total += value.byteLength;
      if (total > 2 * 1024 * 1024) throw new Error("Fixture request limit.");
      chunks.push(value);
    }
    const method = incoming.method ?? "GET";
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (Array.isArray(value)) { for (const member of value) headers.append(name, member); }
      else if (value !== undefined) headers.set(name, value);
    }
    const request = new Request("http://127.0.0.1" + incoming.url, {
      method,
      headers,
      ...(["HEAD", "GET"].includes(method) ? {} : { body: Buffer.concat(chunks) }),
    });
    const answer = await handler(request);
    outgoing.writeHead(answer.status, Object.fromEntries(answer.headers));
    if (answer.body) {
      const reader = answer.body.getReader();
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          if (!outgoing.write(next.value)) await once(outgoing, "drain");
        }
      } finally {
        reader.releaseLock();
      }
    }
    outgoing.end();
  } catch (error) {
    diagnostic(error);
    outgoing.destroy(error instanceof Error ? error : new Error(String(error)));
  }
});
const publicFixture = process.argv[3] === "--public-fixture";
server.listen(publicFixture ? 8080 : 0, publicFixture ? "0.0.0.0" : "127.0.0.1");
await once(server, "listening");
const address = server.address();
if (address === null || typeof address === "string") throw new Error("Fixture did not acquire a TCP port.");
process.send?.({ port: address.port, node: process.version });
if (!process.send) console.log("upload-fixture-ready:" + address.port);
process.on("message", (message) => {
  if (message === "failures") process.send?.({ failures });
});
