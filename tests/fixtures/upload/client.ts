/** Injected process-kill points belong to this test transport, never to production code. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import process from "node:process";
import type { UploadSessionType } from "../../../src/upload.ts";

const [moduleURL, phase, target, directory] = process.argv.slice(2);
if (!moduleURL || !phase || !target || !directory) throw new Error("Module URL, phase, target and directory required.");
if (!["append-kill", "finish-kill", "unknown", "replay"].includes(phase)) throw new Error("Unknown fixture phase.");
// The provider fixture supplies the actual candidate module; no untyped API escapes this import boundary.
const implementation: typeof import("../../../src/upload.ts") = await import(moduleURL);
const { createUploadClient, UploadSessionSchema, UploadError } = implementation;
const input = readFileSync(directory + "/input.bin");
const identity = "sha256:" + createHash("sha256").update(input).digest("hex");
const path = directory + "/checkpoint.json";

/** Source identity and admitted session are revalidated in every fresh process. */
interface CheckpointType {
  readonly session: UploadSessionType;
  readonly sourceIdentity: string;
  readonly acknowledgedOffset: number;
  readonly receipt?: { readonly status: number; readonly body: string };
}

/** Rename publishes one complete JSON record; this models process loss, not power-loss durability. */
function save(value: CheckpointType): void {
  writeFileSync(path + ".next", JSON.stringify(value));
  renameSync(path + ".next", path);
}

/** Parse saved JSON as unknown before handing session authority back to the production client. */
function readCheckpoint(): CheckpointType {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof value !== "object" || value === null) throw new Error("Invalid saved checkpoint.");
  if (!("sourceIdentity" in value) || typeof value.sourceIdentity !== "string") throw new Error("Invalid identity.");
  if (
    !("acknowledgedOffset" in value) || typeof value.acknowledgedOffset !== "number" ||
    !Number.isSafeInteger(value.acknowledgedOffset) || value.acknowledgedOffset < 0
  ) {
    throw new Error("Invalid saved offset.");
  }
  if (!("session" in value)) throw new Error("Missing saved session.");
  return {
    session: UploadSessionSchema.parse(value.session),
    sourceIdentity: value.sourceIdentity,
    acknowledgedOffset: value.acknowledgedOffset,
  };
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
      await new Promise<never>(() => {});
    }
    return reply;
  },
});
let checkpoint: CheckpointType;
if (phase === "append-kill") {
  const made = await client.create({ method: "POST", size: input.length });
  assert.equal(made.kind, "created");
  if (made.kind !== "created") throw new Error("Expected an upload resource.");
  checkpoint = { session: UploadSessionSchema.parse(made.session), sourceIdentity: identity, acknowledgedOffset: 0 };
  save(checkpoint);
} else checkpoint = readCheckpoint();
assert.equal(checkpoint.sourceIdentity, identity);
const upload = client.open(UploadSessionSchema.parse(checkpoint.session), {
  acknowledgedOffset: checkpoint.acknowledgedOffset,
});
if (phase === "unknown") {
  try {
    await upload.status();
    throw new Error("Expected unavailable upload.");
  } catch (reason) {
    assert.ok(reason instanceof UploadError);
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
    if (result.kind !== "ack") throw new Error("Unexpected early target response.");
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
