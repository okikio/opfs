/** Author mboxo/mboxrd controls and qualify mboxrd with native Git mailsplit.
 *
 * No candidate reader is imported. The mboxo bytes are authored controls, not
 * a replacement for the historical Python mailbox producer/consumer receipt.
 * @module
 */
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { output: { type: "string" }, git: { type: "string", default: "git" } } });
ok(values.output, "Supply a new --output JSON path.");
const git = values.git;
ok(git, "Supply a Git executable.");
const messages = [
  Buffer.from(
    "Subject: quotes\nMessage-ID: <same>\nContent-Type: text/plain\n\nFrom body\n>From original\n>>From original twice\nlast\n\n",
  ),
  Buffer.from(
    'Subject: attachment\nMessage-ID: <same>\nContent-Type: application/octet-stream\nContent-Transfer-Encoding: base64\nContent-Disposition: attachment; filename="test.bin"\n\nAAECA/8=\n',
  ),
];
const envelope = Buffer.from("From test@example.test Thu Jan  1 00:00:00 1970\n");
const historicalPath = new URL("./independent.json", import.meta.url);
ok(statSync(historicalPath).size <= 1024 * 1024, "Historical MBOX input exceeds its bound.");
const historicalBytes = readFileSync(historicalPath);
const historical: { original: string[] } = JSON.parse(historicalBytes.toString("utf8"));
deepStrictEqual(messages.map((bytes) => bytes.toString("base64")), historical.original);

/** The newline is retained on each line. Only rd quotes every existing >From prefix. */
function mailbox(kind: "mboxo" | "mboxrd"): Buffer {
  const parts: Buffer[] = [];
  for (const message of messages) {
    parts.push(envelope);
    const lines = message.toString("utf8").match(/[^\n]*\n|[^\n]+$/gu) ?? [];
    for (const line of lines) {
      if ((kind === "mboxrd" ? /^>*From /u : /^From /u).test(line)) parts.push(Buffer.from(">"));
      parts.push(Buffer.from(line));
    }
    parts.push(Buffer.from("\n"));
  }
  return Buffer.concat(parts);
}

/** Only a normally exited native process can supply independent consumer evidence. */
function consume(args: string[]) {
  const result = spawnSync(git, args, {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.signal || result.status === null) {
    throw new Error("Git did not reach a native format verdict.", {
      cause: { error: result.error, signal: result.signal, status: result.status },
    });
  }
  equal(result.status, 0, result.stderr.toString("utf8"));
  return result;
}

function record(bytes: Buffer) {
  return { base64: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") };
}

const version = consume(["--version"]);
const root = mkdtempSync(join(tmpdir(), "opfs-mbox-controls-"));
const failures: unknown[] = [];
try {
  const path = join(root, "authored.mbox"), output = join(root, "split");
  const mboxrd = mailbox("mboxrd");
  writeFileSync(path, mboxrd, { flag: "wx" });
  mkdirSync(output);
  consume(["mailsplit", "--mboxrd", `-o${output}`, path]);
  const names = readdirSync(output).sort();
  equal(names.length, messages.length, "Git split count differs from authored originals.");
  const gitSplit = names.map((name, index) => {
    const file = join(output, name);
    ok(statSync(file).size <= 1024 * 1024, "Git split exceeds its output bound.");
    const bytes = readFileSync(file), original = messages[index];
    ok(original, "Unexpected Git split ordinal.");
    deepStrictEqual(
      bytes,
      Buffer.concat([envelope, original, Buffer.from("\n")]),
      "Git output must restore every authored message byte.",
    );
    return bytes.toString("base64");
  });
  const receipt = JSON.stringify(
    {
      producer: "Authored TypeScript mboxo/mboxrd framing",
      runtime: process.version,
      proof:
        "Native Git mailsplit --mboxrd output compared completely with authored originals; mboxo has no new independent validation",
      git: version.stdout.toString("utf8").trim(),
      historicalFixtureSha256: createHash("sha256").update(historicalBytes).digest("hex"),
      original: messages.map((bytes) => bytes.toString("base64")),
      mboxo: record(mailbox("mboxo")),
      mboxrd: record(mboxrd),
      gitSplit,
    },
    null,
    2,
  ) + "\n";
  ok(Buffer.byteLength(receipt) <= 1024 * 1024, "MBOX receipt exceeds its output bound.");
  writeFileSync(values.output, receipt, { flag: "wx" });
} catch (reason) {
  failures.push(reason);
} finally {
  try {
    rmSync(root, { recursive: true });
  } catch (reason) {
    failures.push(reason);
  }
}
if (failures.length === 1) throw failures[0];
if (failures.length) throw new AggregateError(failures, "MBOX producer and cleanup failed.");
