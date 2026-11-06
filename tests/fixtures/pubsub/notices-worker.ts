/** Bounded test-only installed package notice collection; Node built-ins only. */
import * as fs from "node:fs";
import { Buffer } from "node:buffer";
import process from "node:process";
import * as path from "node:path";
import * as crypto from "node:crypto";
if (fs.statSync("/oracle/package-lock.json").size > 4 * 1024 * 1024) throw new Error("SDK lock exceeds input bound.");
const lock: { packages: Record<string, { version?: string }> } = JSON.parse(
  fs.readFileSync("/oracle/package-lock.json", "utf8"),
);
if (Object.keys(lock.packages).length !== 84) throw new Error("SDK lock package count differs.");
const notices: { name: string; bytes: number; sha256: string; base64: string }[] = [];
const packages: { path: string; name: string; version: string; license: unknown; notices: string[] }[] = [];
let nodes = 0, total = 0;
const noticeName =
  /^(?:(?:third[._ -]?party[._ -]?)?(?:licen[cs]es?|notices?|copying|copyrights?|authors))(?:[._ -].*)?$/i;
function visit(directory: string, relative: string, depth: number): void {
  if (depth > 20) throw new Error("Notice path depth exceeds policy.");
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  if (entries.length > 10000) throw new Error("Notice directory entry count exceeds policy.");
  for (const entry of entries) {
    if (++nodes > 50000) throw new Error("Notice traversal count exceeds policy.");
    if (entry.name === "node_modules" || entry.name === ".bin") continue;
    // Notice paths must reject native control bytes rather than normalize them.
    // deno-lint-ignore no-control-regex
    if (!entry.name || entry.name === "." || entry.name === ".." || /[\\\x00-\x1f\x7f]/.test(entry.name)) {
      throw new Error("Invalid notice member name.");
    }
    const source = path.join(directory, entry.name), name = relative + "/" + entry.name;
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink()) {
      if (noticeName.test(entry.name)) throw new Error("Symbolic notice is outside profile.");
      continue;
    }
    if (stat.isDirectory()) {
      visit(source, name, depth + 1);
      continue;
    }
    if (!stat.isFile() || !noticeName.test(entry.name)) continue;
    if (stat.size > 1048576 || total + stat.size > 8388608) throw new Error("SDK notice bytes exceed policy.");
    const bytes = fs.readFileSync(source);
    if (bytes.length !== stat.size) throw new Error("Notice extent changed.");
    total += bytes.length;
    notices.push({
      name,
      bytes: bytes.length,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      base64: bytes.toString("base64"),
    });
  }
}
for (const [name, expected] of Object.entries(lock.packages)) {
  if (!name) continue;
  if (
    !/^node_modules\/(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+(?:\/node_modules\/(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+)*$/
      .test(name)
  ) throw new Error("Unsafe locked package path.");
  let directory = "/oracle";
  for (const segment of name.split("/")) {
    directory = path.join(directory, segment);
    const member = fs.lstatSync(directory);
    if (member.isSymbolicLink() || !member.isDirectory()) {
      throw new Error("Locked SDK package path is not a regular directory.");
    }
  }
  const metadataPath = directory + "/package.json", stat = fs.lstatSync(metadataPath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("SDK metadata is not a regular file.");
  if (stat.size > 131072) throw new Error("SDK metadata exceeds policy.");
  const metadata: { name: string; version: string; license?: unknown } = JSON.parse(
    fs.readFileSync(metadataPath, "utf8"),
  );
  if (metadata.version !== expected.version) throw new Error("Installed SDK package version differs from lock.");
  const start = notices.length;
  visit(directory, name, 0);
  packages.push({
    path: name,
    name: metadata.name,
    version: metadata.version,
    license: metadata.license ?? null,
    notices: notices.slice(start).map((value) => value.name),
  });
}
const result = {
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
  packagesWithoutNotice: packages.filter((value) => !value.notices.length).map((value) => value.path),
  purpose: "Test-only installed SDK LICENSE/NOTICE/COPYING/COPYRIGHT/AUTHORS bytes, not production SDK source",
  packages,
  notices,
  traversedNodes: nodes,
  totalNoticeBytes: total,
};
const output = JSON.stringify(result, null, 2) + "\n";
if (Buffer.byteLength(output) > 12582912) throw new Error("Notice JSON exceeds policy.");
fs.writeFileSync("/oracle/sdk-notices.json", output, { flag: "wx" });
console.log(
  JSON.stringify({
    packageCount: packages.length,
    noticeCount: notices.length,
    totalNoticeBytes: total,
    outputBytes: Buffer.byteLength(output),
    sha256: crypto.createHash("sha256").update(output).digest("hex"),
  }),
);
