/** Network acquisition and offline extraction are separate explicit test stages. */
import { equal, ok } from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ARROW, DUCKDB, LIBRARIES } from "./artifacts.ts";
import { inspectZip, MIB, read, sha } from "./files.ts";

/** Fixed origins cover GitHub's official release redirect, not arbitrary redirects. */
async function download(input: string, maximum: number): Promise<Buffer> {
  const signal = AbortSignal.timeout(180_000);
  let url = new URL(input);
  for (let count = 0; count <= 5; count++) {
    ok(url.protocol === "https:" && !url.username && !url.password);
    const allowed = input === ARROW.url
      ? ["files.pythonhosted.org"]
      : ["github.com", "release-assets.githubusercontent.com"];
    ok(
      allowed.includes(url.hostname) && (url.port === "" || url.port === "443"),
      "Unreviewed artifact redirect origin.",
    );
    const response = await fetch(url, { redirect: "manual", signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      ok(location !== null);
      url = new URL(location, url);
      continue;
    }
    if (!response.ok || response.body === null) {
      await response.body?.cancel();
      throw new Error(`Artifact HTTP ${response.status}.`);
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    const reader = response.body.getReader();
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.length;
        ok(bytes <= maximum, "Artifact exceeds transport budget.");
        chunks.push(Buffer.from(next.value));
      }
    } catch (reason) {
      await reader.cancel(reason);
      throw reason;
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks, bytes);
  }
  throw new Error("Artifact redirect count exceeds budget.");
}

export async function acquire(destination: string, duckdb: boolean): Promise<void> {
  const root = resolve(destination);
  mkdirSync(root);
  let complete = false;
  try {
    const arrow = await download(ARROW.url, 64 * MIB);
    equal(arrow.length, ARROW.bytes);
    equal(sha(arrow), ARROW.sha256);
    writeFileSync(join(root, "arrow.whl"), arrow, { flag: "wx" });
    const artifacts: Record<string, unknown>[] = [{ ...ARROW, file: "arrow.whl" }];
    if (duckdb) {
      const cli = await download(DUCKDB.url, 32 * MIB);
      equal(sha(cli), DUCKDB.sha256);
      writeFileSync(join(root, "duckdb.zip"), cli, { flag: "wx" });
      artifacts.push({ ...DUCKDB, file: "duckdb.zip", bytes: cli.length });
    }
    writeFileSync(
      join(root, "acquisition.json"),
      JSON.stringify({
        artifacts,
        claim: "Exact SHA256-pinned upstream containers; no package installation or code execution",
      }) + "\n",
      { flag: "wx" },
    );
    complete = true;
  } finally {
    if (!complete) rmSync(root, { recursive: true, force: true });
  }
}

/** Only headers, two C++ libraries and upstream notices leave the admitted wheel. */
export function install(receipts: string, destination: string, duckdb: boolean): void {
  const wheel = read(join(receipts, "arrow.whl"), 64 * MIB);
  equal(wheel.length, ARROW.bytes);
  equal(sha(wheel), ARROW.sha256);
  const root = resolve(destination);
  mkdirSync(root);
  let complete = false, noticeBytes = 0;
  const files: { path: string; bytes: number; sha256: string }[] = [];
  const libraries = new Set<string>();
  function retain(path: string, body: Buffer): void {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body, { flag: "wx", mode: path === "duckdb" ? 0o700 : 0o600 });
    files.push({ path, bytes: body.length, sha256: sha(body) });
  }
  try {
    retain("arrow.whl", wheel);
    inspectZip(wheel, ({ name, body, sha256 }) => {
      if (name.endsWith("/")) return;
      if (name.startsWith("pyarrow/include/")) retain(name.slice("pyarrow/".length), body);
      else if (name.startsWith("pyarrow/") && Object.hasOwn(LIBRARIES, name.slice(8))) {
        const library = name.slice(8) as keyof typeof LIBRARIES;
        equal(sha256, LIBRARIES[library]);
        ok(body.subarray(0, 6).equals(Buffer.from([127, 69, 76, 70, 2, 1])));
        equal(body.readUInt16LE(18), 183);
        libraries.add(library);
        retain(library, body);
      } else if (name.toLowerCase().split("/").some((part) => /^(license|notice|copying)/u.test(part))) {
        ok(body.length <= MIB);
        noticeBytes += body.length;
        ok(noticeBytes <= 8 * MIB);
        retain(`notices/${name}`, body);
      }
    });
    equal(libraries.size, 2);
    if (duckdb) {
      const archive = read(join(receipts, "duckdb.zip"), 32 * MIB);
      equal(sha(archive), DUCKDB.sha256);
      retain("duckdb.zip", archive);
      let found = 0;
      inspectZip(archive, ({ name, body }) => {
        if (name === "duckdb") {
          found++;
          ok(body.subarray(0, 6).equals(Buffer.from([127, 69, 76, 70, 2, 1])));
          equal(body.readUInt16LE(18), 183);
          retain("duckdb", body);
        }
      });
      equal(found, 1);
    }
    writeFileSync(
      join(root, "admission.json"),
      JSON.stringify({
        arrow: ARROW,
        duckdb: duckdb ? DUCKDB : null,
        files,
        qualification: "C++ subset extraction; no libarrow_python, Python, pip or downloaded setup execution",
      }) + "\n",
      { flag: "wx" },
    );
    complete = true;
  } finally {
    if (!complete) rmSync(root, { recursive: true, force: true });
  }
}

/** Re-admit extracted compilation inputs from pinned containers, not a self-asserted receipt. */
export function verify(root: string, duckdb: boolean): void {
  const wheel = read(join(root, "arrow.whl"), 64 * MIB);
  equal(wheel.length, ARROW.bytes);
  equal(sha(wheel), ARROW.sha256);
  const headers = new Set<string>();
  inspectZip(wheel, ({ name, sha256 }) => {
    const path = name.startsWith("pyarrow/include/")
      ? name.slice(8)
      : name.startsWith("pyarrow/") && Object.hasOwn(LIBRARIES, name.slice(8))
      ? name.slice(8)
      : null;
    if (path === null || name.endsWith("/")) return;
    equal(sha(read(join(root, path), 128 * MIB)), sha256, "Extracted compilation input differs from pinned wheel.");
    if (path.startsWith("include/")) headers.add(path);
  });
  function walk(path: string): void {
    for (const item of readdirSync(join(root, path), { withFileTypes: true })) {
      const relative = `${path}/${item.name}`;
      if (item.isDirectory()) walk(relative);
      else ok(item.isFile() && headers.has(relative), "Unadmitted include entry.");
    }
  }
  walk("include");
  if (duckdb) {
    const archive = read(join(root, "duckdb.zip"), 32 * MIB);
    equal(sha(archive), DUCKDB.sha256);
    let found = 0;
    inspectZip(archive, ({ name, sha256 }) => {
      if (name === "duckdb") {
        found++;
        equal(sha(read(join(root, "duckdb"), 128 * MIB)), sha256);
      }
    });
    equal(found, 1);
  }
}
