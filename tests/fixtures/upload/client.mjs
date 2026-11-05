/** Injected process-kill points belong to this test transport, never to production code. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
const [moduleURL, phase, target, directory] = process.argv.slice(2);
const { createUploadClient, UploadSessionSchema } = await import(moduleURL);
const input = readFileSync(directory + "/input.bin");
const identity = "sha256:" + createHash("sha256").update(input).digest("hex");
const path = directory + "/checkpoint.json";
function save(value) {
  writeFileSync(path + ".next", JSON.stringify(value));
  renameSync(path + ".next", path);
}
const client = createUploadClient({
  profile: "draft-15",
  target,
  fetch: async (url, init) => {
    const reply = await globalThis.fetch(url, init);
    const complete = new Headers(init?.headers).get("Upload-Complete");
    if (
      init?.method === "PATCH" &&
      ((phase === "append-kill" && complete === "?0") ||
        (phase === "finish-kill" && reply.headers.get("Upload-Complete") === "?1"))
    ) {
      process.kill(process.pid, "SIGKILL");
      await new Promise(() => {});
    }
    return reply;
  },
});
let checkpoint;
if (phase === "append-kill") {
  const made = await client.create({ method: "POST", size: input.length });
  assert.equal(made.kind, "created");
  checkpoint = { session: UploadSessionSchema.parse(made.session), sourceIdentity: identity, acknowledgedOffset: 0 };
  save(checkpoint);
} else checkpoint = JSON.parse(readFileSync(path, "utf8"));
assert.equal(checkpoint.sourceIdentity, identity);
const upload = client.open(UploadSessionSchema.parse(checkpoint.session), {
  acknowledgedOffset: checkpoint.acknowledgedOffset,
});
if (phase === "unknown") {
  try {
    await upload.status();
    throw new Error("Expected unavailable upload.");
  } catch (reason) {
    assert.equal(reason.code, "http");
    assert.equal(reason.status, 404);
  }
  console.log(JSON.stringify({ state: "publication-unknown", savedOffset: checkpoint.acknowledgedOffset }));
} else {
  const remote = await upload.status();
  let offset = remote.offset;
  if (phase === "finish-kill") assert.equal(offset, 32768);
  while (offset < input.length) {
    const result = await upload.append(offset, input.subarray(offset, Math.min(offset + 32768, input.length)));
    assert.equal(result.kind, "ack");
    offset = result.offset;
    checkpoint = { ...checkpoint, acknowledgedOffset: offset };
    save(checkpoint);
  }
  const receipt = await upload.finish();
  assert.equal(receipt.terminal, true);
  assert.equal(receipt.status, 200);
  save({ ...checkpoint, receipt: { status: receipt.status, body: Buffer.from(receipt.body).toString("base64") } });
  console.log(JSON.stringify({ state: "target-response", status: receipt.status, offset }));
}
