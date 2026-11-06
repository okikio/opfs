/** Acquires pinned test JARs without loading downloaded classes or running Maven. */
import { equal, ok } from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ARTIFACTS } from "./artifacts.ts";

const MIB = 1024 * 1024;
const { values: args } = parseArgs({
  options: {
    output: { type: "string" },
    java: { type: "string", default: "java" },
    javac: { type: "string", default: "javac" },
    prlimit: { type: "string", default: "/usr/bin/prlimit" },
  },
});
if (args.output === undefined) throw new TypeError("--output requires a new artifact directory.");
const target = resolve(args.output), temporary = mkdtempSync(join(tmpdir(), "opfs-cryptomator-inspect-"));
let owned = false, complete = false, total = 0, licenseTotal = 0;

/** HTTPS redirects remain on the official artifact origin; streamed bodies have admission limits. */
async function download(input: string, limit: number): Promise<Buffer> {
  const signal = AbortSignal.timeout(60_000);
  let url = new URL(input);
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (url.origin !== "https://repo.maven.apache.org" || url.username || url.password) {
      throw new Error("Cross-origin artifact redirect refused.");
    }
    const response = await fetch(url, { signal, redirect: "manual" });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (location === null) throw new Error("Artifact redirect has no location.");
      url = new URL(location, url);
      continue;
    }
    if (!response.ok || response.body === null) {
      await response.body?.cancel();
      throw new Error(`Artifact HTTP status ${response.status}.`);
    }
    const reader = response.body.getReader(), chunks: Buffer[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.length;
        if (bytes > limit) throw new Error("Artifact transport exceeds byte budget.");
        chunks.push(Buffer.from(next.value));
      }
    } catch (reason) {
      try {
        await reader.cancel(reason);
      } catch (cleanup) {
        throw new AggregateError([reason, cleanup], "Artifact read and cancellation failed.");
      }
      throw reason;
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks, bytes);
  }
  throw new Error("Artifact redirect count exceeds budget.");
}

/** Only authored JDK inspection code runs; supplied JARs are read as data. */
function run(argv: readonly string[]): string {
  const child = spawnSync(args.prlimit, [`--fsize=${8 * MIB}:${8 * MIB}`, "--", ...argv], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
    killSignal: "SIGKILL",
    maxBuffer: 8 * MIB,
  });
  if (child.error !== undefined || child.status !== 0) {
    throw new Error(
      JSON.stringify({
        argv,
        status: child.status,
        signal: child.signal,
        stderr: child.stderr?.toString(),
        error: child.error?.message,
      }),
    );
  }
  return child.stdout.toString();
}
function object(value: unknown): Record<string, unknown> {
  ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}
try {
  mkdirSync(target);
  owned = true;
  const inspector = fileURLToPath(new URL("Inspect.java", import.meta.url));
  const inspectorInfo = lstatSync(inspector);
  ok(
    inspectorInfo.isFile() && inspectorInfo.size <= MIB,
    "Authored JAR inspector exceeds its regular-file source budget.",
  );
  run([args.javac, "-J-Xmx256m", "--release", "17", "-d", temporary, inspector]);
  const artifacts: Record<string, unknown>[] = [];
  for (const artifact of ARTIFACTS) {
    const body = await download(artifact.url, 16 * MIB);
    total += body.length;
    if (total > 64 * MIB) throw new Error("Aggregate artifact bytes exceed budget.");
    equal(
      createHash("sha256").update(body).digest("hex"),
      artifact.sha256,
      "Artifact differs from the already reviewed release bytes.",
    );
    const sidecar = await download(`${artifact.url}.sha1`, 512);
    ok(sidecar.every((byte) => byte <= 127), "Repository SHA1 sidecar must be ASCII.");
    const expected = sidecar.toString("ascii").trim().split(/\s+/u)[0]!;
    ok(/^[0-9a-fA-F]{40}$/u.test(expected));
    equal(createHash("sha1").update(body).digest("hex"), expected.toLowerCase());
    const path = join(target, new URL(artifact.url).pathname.split("/").at(-1)!);
    writeFileSync(path, body, { flag: "wx" });
    const item: Record<string, unknown> = {
      url: artifact.url,
      bytes: body.length,
      sha256: artifact.sha256,
      repositorySha1: expected,
    };
    if (artifact.url.endsWith(".jar")) {
      const inspected = object(JSON.parse(run([args.java, "-Xmx256m", "-cp", temporary, "Inspect", path])) as unknown);
      ok(
        typeof inspected.licenseBytes === "number" && Number.isSafeInteger(inspected.licenseBytes) &&
          inspected.licenseBytes >= 0 && inspected.licenseBytes <= 2 * MIB,
      );
      licenseTotal += inspected.licenseBytes;
      if (licenseTotal > 8 * MIB) throw new Error("Aggregate embedded license bytes exceed budget.");
      Object.assign(item, inspected);
    }
    artifacts.push(item);
  }
  const result = {
    artifacts,
    tools: { java: run([args.java, "--version"]), javac: run([args.javac, "--version"]) },
    acquisition:
      "pinned SHA256 plus official Maven Central TLS/SHA1 corroboration; no independently authenticated signing-key chain",
    inspectorSHA256: createHash("sha256").update(readFileSync(inspector)).digest("hex"),
  };
  writeFileSync(join(target, "acquisition.json"), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  complete = true;
} finally {
  rmSync(temporary, { recursive: true, force: true });
  if (owned && !complete) rmSync(target, { recursive: true, force: true });
}
