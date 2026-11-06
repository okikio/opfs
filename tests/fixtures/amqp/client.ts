/** Node owns invocation/receipt limits; the signed native SDK owns AMQP. */
import { ok } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import process, { argv, versions } from "node:process";

const MIB = 1024 * 1024;
function read(path: string, maximum = 4 * MIB): Uint8Array {
  const info = lstatSync(path);
  ok(info.isFile() && info.size <= maximum);
  return readFileSync(path);
}
function digest(path: string): string {
  return createHash("sha256").update(read(path)).digest("hex");
}
const operation = argv[2];
if (operation === undefined || operation === "inspect") {
  console.log(JSON.stringify({
    phase: "native-sdk-admission",
    oracle: "signed Debian rabbitmq-c through authored native C shim",
    node: versions,
    scripts: {
      "native.c": digest("/oracle/native.c"),
      "client.ts": digest("/oracle/client.ts"),
      native: digest("/oracle/native"),
    },
    debs: new TextDecoder().decode(read("/oracle/receipts/debs.sha256")),
    packages: new TextDecoder().decode(read("/oracle/receipts/packages.txt")),
  }));
  if (operation === undefined) {
    console.log("ORACLE_READY");
    const timer = setInterval(() => {}, 60_000);
    await new Promise<void>((done) => {
      process.on("SIGTERM", () => done());
      process.on("SIGINT", () => done());
    });
    clearInterval(timer);
  }
} else {
  ok(["init", "seed", "take", "count"].includes(operation) && argv.length === 3);
  if (operation === "seed") read("/oracle/value.bin", MIB);
  const child = spawnSync("/usr/bin/prlimit", [`--fsize=${4 * MIB}:${4 * MIB}`, "--", "/oracle/native", operation], {
    timeout: 15_000,
    killSignal: "SIGKILL",
    maxBuffer: 2 * MIB,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (child.error !== undefined || child.status !== 0 || child.signal !== null) {
    throw new Error(
      JSON.stringify({
        status: child.status,
        signal: child.signal,
        error: child.error?.message,
        stderr: child.stderr?.toString(),
      }),
    );
  }
  const text = child.stdout.toString();
  const lines = text.split(/\r?\n/u).filter(Boolean);
  ok(lines.length === 1 && lines[0]!.startsWith("RECEIPT:"), "Native SDK output must contain one complete receipt.");
  const receipt: unknown = JSON.parse(lines[0]!.slice(8));
  ok(typeof receipt === "object" && receipt !== null && !Array.isArray(receipt));
  console.log(lines[0]);
}
