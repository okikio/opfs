/** Candidate-free native interop10 process-loss oracle. No host network or candidate imports. */
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import process from "node:process";

/** Captured native wire answer; full bodies are base64 so the report stays JSON-safe. */
interface ReplyType {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}
interface TraceType extends ReplyType {
  readonly method: string;
  readonly path: string;
  readonly requestBytes: number;
}

/** IPC carries untrusted process messages; readiness and diagnostics use separate shapes. */
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid fixture IPC.");
  return value as Record<string, unknown>;
}

function location(reply: ReplyType): string {
  const value = reply.headers.location;
  if (typeof value !== "string") throw new Error("Native creation omitted Location.");
  return value;
}

const outputIndex = process.argv.indexOf("--output");
const output = outputIndex < 0 ? undefined : process.argv[outputIndex + 1];
if (!output || output.startsWith("--")) throw new Error("Explicit --output path required.");
const root = await mkdtemp(join(tmpdir(), "upload-oracle-"));
let child: ChildProcess | undefined;
const traces: TraceType[] = [];
const diagnostics: string[][] = [];
const streams: { readonly errors: Buffer[]; readonly stdout: Buffer[] }[] = [];
const deadline = setTimeout(() => {
  child?.kill("SIGKILL");
  console.error("Producer180s deadline.");
  process.exit(124);
}, 180000);
let primary: unknown[] = [];
async function start(): Promise<number> {
  child = fork(new URL("./server.ts", import.meta.url), [root], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const ownedChild = child;
  const errors: Buffer[] = [], stdout: Buffer[] = [];
  let retained = 0;
  for (const [stream, chunks] of [[child.stderr, errors], [child.stdout, stdout]] as const) {
    if (stream === null) throw new Error("Fixture child capture pipe missing.");
    stream.on("data", (chunk: Buffer) => {
      retained += chunk.length;
      if (retained > 65536) ownedChild.kill("SIGKILL");
      else chunks.push(chunk);
    });
  }
  streams.push({ errors, stdout });
  const ready = await Promise.race([
    once(child, "message").then(([value]: unknown[]) => record(value)),
    once(child, "exit").then(([code, signal]) => {
      throw new Error(`Server exited ${code}/${signal}: ${Buffer.concat(errors)}`);
    }),
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("Server readiness timeout.")), 15000);
      timer.unref();
    }),
  ]);
  if (typeof ready.port !== "number" || !Number.isInteger(ready.port) || ready.port < 1 || ready.port > 65535) {
    throw new Error("Fixture readiness omitted a valid TCP port.");
  }
  return ready.port;
}
async function collectDiagnostics(): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const reply = once(child, "message");
  child.send("failures");
  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error("Diagnostic IPC timeout.")), 3000);
    timer.unref();
  });
  const [message]: unknown[] = await Promise.race([reply, timeout]);
  const value = record(message);
  if (!Array.isArray(value.failures) || !value.failures.every((item): item is string => typeof item === "string")) {
    throw new Error("Invalid fixture diagnostics.");
  }
  diagnostics.push(value.failures);
}
async function stop(): Promise<void> {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  }
  child = undefined;
}
function http(
  port: number,
  method: string,
  path: string,
  fields: Readonly<Record<string, string>> = {},
  body: Uint8Array = Buffer.alloc(0),
): Promise<ReplyType> {
  return new Promise<ReplyType>((resolve, reject) => {
    const req = request({
      hostname: "127.0.0.1",
      port,
      method,
      path,
      headers: { "Upload-Draft-Interop-Version": "10", "Content-Length": body.length, ...fields },
    }, async (res) => {
      try {
        let size = 0;
        const parts: Uint8Array[] = [];
        for await (const chunk of res) {
          if (!(chunk instanceof Uint8Array)) throw new Error("Native response returned a non-byte chunk.");
          size += chunk.length;
          if (size > 65536) throw new Error("Native receipt too large.");
          parts.push(chunk);
        }
        if (res.statusCode === undefined) throw new Error("Native response omitted its status.");
        const reply = { status: res.statusCode, headers: res.headers, body: Buffer.concat(parts).toString("base64") };
        traces.push({ method, path, requestBytes: body.length, ...reply });
        resolve(reply);
      } catch (error) {
        reject(error);
      }
    });
    const totalDeadline = setTimeout(() => req.destroy(new Error("Native request total deadline.")), 15000);
    req.on("close", () => clearTimeout(totalDeadline));
    req.setTimeout(15000, () => req.destroy(new Error("Native request timed out.")));
    req.on("error", reject);
    req.end(body);
  });
}
try {
  let port = await start();
  const original = Buffer.from(Array.from({ length: 131089 }, (_, i) => (i * 31 + 17) % 251));
  const created = await http(port, "POST", "/create?key=main.bin", {
    "Upload-Complete": "?0",
    "Upload-Length": String(original.length),
  });
  assert.ok(created.status >= 200 && created.status < 300);
  const resource = location(created);
  const checkpoint = { url: resource, acknowledgedOffset: 0, size: original.length };
  await writeFile(join(root, "client-checkpoint.json"), JSON.stringify(checkpoint));
  const conflict = await http(port, "PATCH", resource, {
    "Upload-Offset": "1",
    "Upload-Complete": "?0",
    "Content-Type": "application/partial-upload",
  }, original.subarray(0, 1));
  assert.equal(conflict.status, 409);
  const first = await http(port, "PATCH", resource, {
    "Upload-Offset": "0",
    "Upload-Complete": "?0",
    "Content-Type": "application/partial-upload",
  }, original.subarray(0, 32768));
  assert.ok(first.status >= 200 && first.status < 300);
  // The remote ACK is deliberately not persisted. Kill the entire FS-backed server before reconstructing state.
  await collectDiagnostics();
  await stop();
  port = await start();
  const persisted = record(JSON.parse(await readFile(join(root, "client-checkpoint.json"), "utf8")));
  if (typeof persisted.url !== "string") throw new Error("Saved native checkpoint omitted its URL.");
  assert.equal(persisted.acknowledgedOffset, 0);
  const head = await http(port, "HEAD", persisted.url);
  assert.equal(head.status, 204);
  assert.equal(head.headers["upload-offset"], "32768");
  const rest = await http(port, "PATCH", persisted.url, {
    "Upload-Offset": "32768",
    "Upload-Complete": "?0",
    "Content-Type": "application/partial-upload",
  }, original.subarray(32768));
  assert.ok(rest.status >= 200 && rest.status < 300);
  const finish = await http(port, "PATCH", persisted.url, {
    "Upload-Offset": String(original.length),
    "Upload-Complete": "?1",
    "Content-Type": "application/partial-upload",
  });
  assert.ok(finish.status >= 200 && finish.status < 300);
  assert.equal(finish.headers["upload-complete"], "?1");
  const published = await readFile(join(root, "main.bin"));
  assert.deepEqual(published, original);
  const replay = await http(port, "PATCH", persisted.url, {
    "Upload-Offset": String(original.length),
    "Upload-Complete": "?1",
    "Content-Type": "application/partial-upload",
  });
  const empty = await http(port, "POST", "/create?key=empty.bin", { "Upload-Complete": "?0", "Upload-Length": "0" });
  assert.ok(empty.status >= 200 && empty.status < 300);
  const emptyFinish = await http(port, "PATCH", location(empty), {
    "Upload-Complete": "?1",
    "Upload-Offset": "0",
    "Content-Type": "application/partial-upload",
  });
  assert.ok(emptyFinish.status >= 200 && emptyFinish.status < 300);
  assert.equal((await readFile(join(root, "empty.bin"))).length, 0);
  const cancelled = await http(port, "POST", "/create?key=cancel.bin", {
    "Upload-Complete": "?0",
    "Upload-Length": "1",
  });
  assert.ok(cancelled.status >= 200 && cancelled.status < 300);
  const removal = await http(port, "DELETE", location(cancelled));
  assert.ok(removal.status >= 200 && removal.status < 300);
  const afterCancel = await http(port, "HEAD", location(cancelled));
  assert.ok(afterCancel.status >= 400);
  const unknownParameters = await http(port, "POST", "/create?key=parameter.bin", {
    "Upload-Complete": "?0; x=1",
    "Upload-Length": "1; x=1",
  });
  await collectDiagnostics();
  await writeFile(
    output,
    JSON.stringify(
      {
        upstream: "39a36a8970eea2652003271beb42b2d0319783b4",
        node: process.version,
        original: {
          length: original.length,
          sha256: createHash("sha256").update(original).digest("hex"),
          formula: "(i*31+17)%251",
        },
        publishedFullBytesEqual: true,
        checkpointBeforeKill: 0,
        recoveredOffset: 32768,
        scope:
          "canonical interop10; FSserver killed and checkpoint reloaded in surviving baseline process; not fresh-client-process, power-loss or complete draft15 conformance",
        diagnostics,
        streams: streams.map(({ errors, stdout }) => ({
          stderr: Buffer.concat(errors).toString(),
          stdout: Buffer.concat(stdout).toString(),
        })),
        replayEvidence: "observed status/headers/body only; no redelivery parity claim",
        replayStatus: replay.status,
        unknownParametersStatus: unknownParameters.status,
        traces,
      },
      null,
      2,
    ) + "\n",
  );
} catch (error) {
  primary = [error];
}
const failures = [...primary];
try {
  await stop();
} catch (error) {
  failures.push(error);
}
try {
  await rm(root, { recursive: true, force: true });
} catch (error) {
  failures.push(error);
}
clearTimeout(deadline);
if (failures.length === 1) throw failures[0];
if (failures.length > 1) throw new AggregateError(failures, "Native producer and cleanup failures.");
