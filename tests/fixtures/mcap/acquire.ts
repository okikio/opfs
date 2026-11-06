/** Admit only the reviewed MCAP C++ NONE header closure as inert snapshots. */
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { check, digest, fetchBytes, gitBlob, integer, json, output, record, safe, snapshot, text } from "../acquire.ts";
const { values } = parseArgs({ options: { output: { type: "string" } } });
check(values.output, "Usage: acquire.ts --output FRESH_DIRECTORY");
const manifestPath = join(dirname(fileURLToPath(import.meta.url)), "upstream-cpp.json");
check(statSync(manifestPath).size <= 65536, "Header pin manifest ceiling.");
const manifest = record(JSON.parse(readFileSync(manifestPath, "utf8")));
check(
  manifest.repository === "foxglove/mcap" && manifest.commit === "23d6c627a27ac089d418d9e7f8cdcef9ed86dac1" &&
    Array.isArray(manifest.files) && manifest.files.length === 14,
  "Reviewed MCAP C++ header inventory.",
);
const files = manifest.files;
check(Array.isArray(files), "Native source inventory must be an array.");
await output(values.output, async (root) => {
  const deadline = Date.now() + 90_000, seen = new Set<string>(), rows: unknown[] = [];
  let total = 0;
  for (const value of files) {
    const item = record(value),
      path = safe(text(item.path)),
      count = integer(item.bytes, 128 * 1024),
      blob = text(item.gitBlob);
    check(
      !seen.has(path) && (path === "LICENSE" || /^cpp\/mcap\/include\/mcap\/[a-z_0-9]+\.(hpp|inl)$/.test(path)) &&
        /^[0-9a-f]{40}$/.test(blob),
      "Reviewed unique source path/blob.",
    );
    seen.add(path);
    const url = "https://raw.githubusercontent.com/foxglove/mcap/" + manifest.commit + "/" + path;
    // HTTP encodings can be larger than a tiny decoded header; identity is checked below.
    const raw = await fetchBytes(url, Math.max(count, 1024), deadline);
    check(raw.length === count && gitBlob(raw) === blob, "Pinned MCAP source extent/Git blob differs.");
    total += raw.length;
    check(total <= 512 * 1024, "Header acquisition aggregate ceiling.");
    snapshot(root, "source/" + path + ".snapshot", raw);
    rows.push({ path, url, bytes: raw.length, gitBlob: blob, sha256: digest(raw) });
  }
  json(root, "acquisition.json", {
    repository: manifest.repository,
    commit: manifest.commit,
    version: manifest.version,
    bytes: total,
    files: rows,
    scope: "Inert C++ source snapshots; no compile, import, install or upstream execution.",
  });
});
