/** Test-only loopback transport around immutable, unmodified upstream interop10 and FS store. */
import { createServer } from "node:http";
import { once } from "node:events";
import { createUploadHandler } from "/tool/source/src/upload.ts";
import { fsUploadStore } from "/tool/source/src/fs.ts";

const root = process.argv[2];
if (!root) throw new Error("Explicit fixture root required.");
const failures = [];
let diagnosticBytes = 0;
function diagnostic(error) {
  const text = String(error).slice(0, 4096);
  diagnosticBytes += text.length;
  if (failures.length < 64 && diagnosticBytes <= 65536) failures.push(text);
}
const handler = createUploadHandler(fsUploadStore({ root }), {
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
  onError: (error) => {
    diagnostic(error);
  },
});
const server = createServer(async (incoming, outgoing) => {
  try {
    const chunks = [];
    let total = 0;
    for await (const chunk of incoming) {
      total += chunk.byteLength;
      if (total > 2 * 1024 * 1024) throw new Error("Fixture request limit.");
      chunks.push(chunk);
    }
    const method = incoming.method ?? "GET";
    const request = new Request("http://127.0.0.1" + incoming.url, {
      method,
      headers: incoming.headers,
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
    outgoing.destroy(error);
  }
});
const publicFixture = process.argv[3] === "--public-fixture";
server.listen(publicFixture ? 8080 : 0, publicFixture ? "0.0.0.0" : "127.0.0.1");
await once(server, "listening");
process.send?.({ port: server.address().port, node: process.version });
if (!process.send) console.log("upload-fixture-ready:" + server.address().port);
process.on("message", (message) => {
  if (message === "failures") process.send?.({ failures });
});
