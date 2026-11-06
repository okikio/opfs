/** Independent libcurl STOR/RETR and confinement oracle; no candidate protocol code. */
import { equal, ok } from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { argv, stdout } from "node:process";

const BASE = "ftp://127.0.0.1:2121/";
/** Upload bytes go through stdin rather than shell interpolation or a host file. */
function curl(options: readonly string[], input?: Buffer, refusal = false): string {
  const child = spawnSync("curl", [
    "--silent",
    "--show-error",
    "--fail",
    "--max-time",
    "10",
    "--user",
    "fixture:test-only-password",
    ...options,
  ], {
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    timeout: 15_000,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024,
  });
  if (child.error !== undefined || child.status === null || child.signal !== null) {
    throw new Error(JSON.stringify({ error: child.error?.message, signal: child.signal }));
  }
  if (refusal) {
    ok(child.status !== 0, "Native server accepted an outside-home operation.");
    equal(child.stdout.toString(), "550", "Outside-home refusal must be a native FTP550 response.");
  } else if (child.status !== 0) {
    throw new Error(JSON.stringify({ options, status: child.status, stderr: child.stderr.toString() }));
  }
  return child.stdout.toString();
}
const [action, value] = argv.slice(2);
if (action === "seed") {
  ok(value !== undefined && value.length <= 64 * 1024);
  const bytes = Buffer.from(value, "base64");
  equal(bytes.toString("base64"), value);
  curl(["--upload-file", "-", `${BASE}producer.txt`], bytes);
  curl(["--quote", "MKD folder", "--list-only", BASE]);
} else if (action === "read") {
  ok(
    value !== undefined && /^[a-zA-Z0-9._/-]{1,256}$/u.test(value) && !value.startsWith("/") &&
      !value.split("/").includes(".."),
  );
  stdout.write(curl([BASE + value.split("/").map(encodeURIComponent).join("/")]));
} else if (action === "deny-outside") {
  const response = ["--output", "/dev/null", "--write-out", "%{response_code}"];
  curl([...response, "--quote", "CWD /tmp", "--list-only", BASE], undefined, true);
  curl([...response, "--ftp-method", "nocwd", `${BASE}%2Fetc/passwd`], undefined, true);
  curl(
    [...response, "--ftp-method", "nocwd", "--upload-file", "-", `${BASE}%2Ftmp/opfs-ftp-outside.txt`],
    Buffer.from("must be refused"),
    true,
  );
  stdout.write("native DIRS/READ/WRITE outside-home refusals verified");
} else throw new TypeError("Expected seed, read, or deny-outside action.");
