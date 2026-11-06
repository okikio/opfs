/** Inert signed-APT closure admission and notices for disposable native fixture images. */
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { check, digest, integer, json, record, snapshot, text } from "./acquire.ts";
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { root: { type: "string" }, profile: { type: "string", default: "qcow2" } },
});
check(
  values.root && positionals.length === 1 && ["admit", "verify", "notices", "inventory"].includes(positionals[0]!),
  "Usage: apt.ts admit|verify|notices|inventory --root OWNED_RECEIPTS",
);
check(values.profile === "qcow2" || values.profile === "geotiff", "Reviewed native package profile required.");
const requests = values.profile === "qcow2"
  ? ["qemu-utils"]
  : ["gdal-bin", "libgdal-dev", "libtiff-dev", "libtiff-tools", "g++"];
const root = values.root;
function read(path: string, maximum: number): Buffer<ArrayBuffer> {
  check(statSync(path).isFile() && statSync(path).size <= maximum, "Receipt/input extent: " + path);
  const value = readFileSync(path);
  check(value.length <= maximum, "Receipt/input changed beyond cap: " + path);
  return value;
}
function files(path: string, follow = false): string[] {
  const entries = readdirSync(path, { withFileTypes: true });
  check(entries.length <= 4096, "Native input directory inventory ceiling.");
  for (const entry of entries) {
    check(!entry.name.endsWith(".deb") || entry.isFile(), "Archive identity is not a regular file.");
  }
  return entries.filter((entry) =>
    entry.isFile() || (follow && entry.isSymbolicLink() && statSync(join(path, entry.name)).isFile())
  ).map((entry) => entry.name).sort();
}
function name(value: unknown): string {
  const result = text(value);
  check(
    /^[A-Za-z0-9][A-Za-z0-9.%+_:~-]*$/.test(result) && result.length <= 512,
    "Invalid native package/file identity.",
  );
  return result;
}
/** Hash large native executables in bounded chunks rather than allocating the whole file. */
function nativeHash(path: string): string {
  const size = statSync(path).size;
  check(size <= 256 * 1024 * 1024, "Native executable hash ceiling.");
  const fd = openSync(path, "r"), hash = createHash("sha256"), chunk = Buffer.alloc(1024 * 1024);
  try {
    let at = 0;
    while (at < size) {
      const count = readSync(fd, chunk, 0, Math.min(chunk.length, size - at), at);
      check(count > 0, "Native executable changed while hashing.");
      hash.update(chunk.subarray(0, count));
      at += count;
    }
    check(statSync(path).size === size, "Native executable extent changed.");
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}
interface ArchiveType {
  file: string;
  bytes: number;
  sha256: string;
  package: string;
  version: string;
  architecture: string;
  source: string;
  installedBytes: number;
}
if (positionals[0] === "admit") {
  const archives = files("/var/cache/apt/archives").filter((file) => file.endsWith(".deb"));
  check(archives.length > 0 && archives.length <= 256, "Downloaded archive closure cardinality.");
  const rows: ArchiveType[] = [];
  let total = 0, installed = 0;
  for (const file of archives) {
    name(file);
    const path = join("/var/cache/apt/archives", file), bytes = read(path, 64 * 1024 * 1024);
    total += bytes.length;
    check(total <= 256 * 1024 * 1024, "Downloaded archive aggregate ceiling.");
    const metadata = spawnSync("dpkg-deb", [
      "--show",
      "--showformat=${Package}\t${Version}\t${Architecture}\t${Source}\t${Installed-Size}",
      path,
    ], { timeout: 10_000, maxBuffer: 65536 });
    check(!metadata.error && metadata.status === 0, "Bounded package metadata query failed.");
    const fields = metadata.stdout.toString().split("\t");
    check(fields.length === 5 && /^\d+$/.test(fields[4]!), "Package metadata cardinality/installed size.");
    const amount = integer(Number(fields[4]) * 1024, 768 * 1024 * 1024);
    installed += amount;
    check(installed <= 768 * 1024 * 1024, "Declared installed closure ceiling.");
    snapshot(root, "debs/" + file, bytes);
    rows.push({
      file,
      bytes: bytes.length,
      sha256: digest(bytes),
      package: name(fields[0]),
      version: text(fields[1]),
      architecture: name(fields[2]),
      source: text(fields[3]),
      installedBytes: amount,
    });
  }
  json(root, "acquisition.json", {
    profile: values.profile,
    directRequests: requests,
    downloadBytes: total,
    declaredInstalledBytes: installed,
    archives: rows,
  });
} else if (positionals[0] === "verify") {
  const manifest = record(JSON.parse(read(join(root, "acquisition.json"), 1024 * 1024).toString()));
  check(
    Array.isArray(manifest.archives) && manifest.archives.length > 0 && manifest.archives.length <= 256,
    "Admitted archive inventory.",
  );
  check(
    JSON.stringify(manifest.directRequests) === JSON.stringify(requests),
    "Admitted direct package requests differ from selected native profile.",
  );
  const paths = files(join(root, "debs")).filter((file) => file.endsWith(".deb")), seen = new Set<string>();
  let total = 0, installed = 0;
  for (const value of manifest.archives) {
    const row = record(value), file = name(row.file);
    check(file.endsWith(".deb") && !seen.has(file), "Duplicate/non-archive admitted filename.");
    seen.add(file);
    const bytes = read(join(root, "debs", file), 64 * 1024 * 1024);
    check(
      bytes.length === integer(row.bytes, 64 * 1024 * 1024) && digest(bytes) === row.sha256,
      "Admitted archive extent/SHA changed.",
    );
    total += bytes.length;
    installed += integer(row.installedBytes, 768 * 1024 * 1024);
  }
  check(
    paths.length === seen.size && paths.every((path) => seen.has(path)) && total <= 256 * 1024 * 1024 &&
      installed <= 768 * 1024 * 1024,
    "Admitted closure file set/aggregate changed.",
  );
  check(
    total === manifest.downloadBytes && installed === manifest.declaredInstalledBytes,
    "Admitted closure totals changed.",
  );
} else if (positionals[0] === "notices") {
  const before = new Map(
    read(join(root, "packages-before.tsv"), 1024 * 1024).toString().trimEnd().split("\n").map(
      (line): [string, string] => {
        const parts = line.split("\t");
        check(parts.length === 2, "Before-package TSV fields.");
        return [parts[0]!, parts[1]!];
      },
    ),
  );
  const after = read(join(root, "packages-after.tsv"), 1024 * 1024).toString().trimEnd().split("\n");
  check(after.length <= 4096, "Installed package inventory ceiling.");
  const licenses: unknown[] = [];
  let total = 0;
  const notice = function (relative: string, bytes: Buffer<ArrayBuffer>): void {
    total += bytes.length;
    check(total <= 8 * 1024 * 1024, "Notice closure exceeds 8 MiB.");
    snapshot(root, relative, bytes);
  };
  for (const line of after) {
    const fields = line.split("\t");
    check(fields.length === 5, "After-package TSV fields.");
    const packageName = name(fields[0]), version = fields[1]!;
    if (before.get(packageName) === version) continue;
    const bytes = read(join("/usr/share/doc", packageName.split(":")[0]!, "copyright"), 1024 * 1024);
    const file = "licenses/" + packageName.replaceAll(":", "_") + ".copyright.snapshot";
    notice(file, bytes);
    licenses.push({
      package: packageName,
      version,
      source: fields[2],
      sourceVersion: fields[3],
      architecture: fields[4],
      bytes: bytes.length,
      sha256: digest(bytes),
      file,
    });
  }
  for (const file of files("/usr/share/common-licenses", true)) {
    name(file);
    const bytes = read(join("/usr/share/common-licenses", file), 1024 * 1024),
      target = "licenses/common-" + file + ".snapshot";
    notice(target, bytes);
    licenses.push({ commonLicense: file, bytes: bytes.length, sha256: digest(bytes), file: target });
  }
  check(process.version === "v26.13.0", "Reviewed Node runtime version.");
  const nodeLicense = read("/usr/local/LICENSE", 1024 * 1024);
  notice("licenses/node-image-LICENSE.txt.snapshot", nodeLicense);
  json(root, "runtime.json", {
    node: {
      version: process.version,
      executable: process.execPath,
      executableSha256: nativeHash(process.execPath),
      licenseSha256: digest(nodeLicense),
    },
    nativeBinaries: Object.fromEntries(
      (values.profile === "qcow2"
        ? ["/usr/bin/qemu-img", "/usr/bin/qemu-io"]
        : ["/usr/bin/gdalinfo", "/usr/bin/gdal-config", "/usr/bin/g++", "/usr/bin/tiffinfo"]).map((
          path,
        ) => [path, nativeHash(path)]),
    ),
    profile: values.profile,
    licenses,
  });
  const releases = files("/var/lib/apt/lists").filter((file) => file.endsWith("InRelease"));
  check(releases.length > 0 && releases.length <= 32, "Signed release inventory.");
  for (const file of releases) {
    snapshot(root, "apt-trust/" + name(file), read(join("/var/lib/apt/lists", file), 1024 * 1024));
  }
} else {
  let count = 0, size = 0;
  const walk = function (directory: string, depth: number): void {
    check(depth <= 8, "Receipt directory depth ceiling.");
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      check(++count <= 1020 && !entry.isSymbolicLink(), "Receipt inventory/symlink ceiling.");
      if (entry.name === "debs" && directory === root) continue;
      if (entry.name.startsWith("acquisition-download.") || entry.name.startsWith("acquisition-install.")) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path, depth + 1);
      else {
        check(entry.isFile(), "Unexpected receipt entry kind.");
        size += statSync(path).size;
      }
      check(
        size + 4 * 1024 * 1024 + 8192 <= 64 * 1024 * 1024,
        "Non-archive receipt aggregate ceiling including wrapper reservation.",
      );
    }
  };
  walk(root, 0);
}
