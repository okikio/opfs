/** Exact upstream storage-js artifact; hash admission precedes native tar extraction. @module */
import { ok } from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
const response = await fetch("https://registry.npmjs.org/@supabase/storage-js/-/storage-js-2.12.2.tgz", {
  signal: AbortSignal.timeout(60_000),
});
ok(response.ok && response.body);
const chunks: Uint8Array[] = [];
let count = 0;
for await (const chunk of response.body) {
  count += chunk.length;
  ok(count <= 32 * 1024 * 1024);
  chunks.push(chunk);
}
const bytes = Buffer.concat(chunks);
ok(
  createHash("sha512").update(bytes).digest("base64") ===
    "SiySHxi3q7gia7NBYpsYRu8gyI0NhFwSORMxbZIxJ/zAVkN6QpwDRan158CJ+UdzD4WB/rQMAGRqIJQP+7ccAQ==",
);
await writeFile("sdk.tgz", bytes, { flag: "wx" });
