/** Retain reviewed partial-content source as inert snapshots; never install or import upstream code. */
import { readFileSync, statSync } from "node:fs";
import { parseArgs } from "node:util";
import { check, digest, fetchBytes, gitBlob, json, output, record, safe, snapshot, tar, text } from "../acquire.ts";
const { values } = parseArgs({ options: { pin: { type: "string" }, output: { type: "string" } } });
check(values.pin && values.output, "Usage: acquire.ts --pin upstream.json --output FRESH_PATH");
check(statSync(values.pin).size <= 256 * 1024, "Pin manifest ceiling.");
const pin = record(JSON.parse(readFileSync(values.pin, "utf8")));
const commit = "39a36a8970eea2652003271beb42b2d0319783b4";
check(
  pin.repository === "nordvec/partial-content" && pin.commit === commit && Array.isArray(pin.files) &&
    pin.files.length <= 4096,
  "Reviewed immutable source inventory.",
);
const expected = new Map<string, string>();
for (const value of pin.files) {
  const item = record(value), path = safe(text(item.path)), blob = text(item.gitBlob);
  check(!expected.has(path) && /^[0-9a-f]{40}$/.test(blob), "Unique pinned Git blob identity.");
  expected.set(path, blob);
}
check(expected.size > 0, "Empty source inventory.");
const url = "https://codeload.github.com/nordvec/partial-content/tar.gz/" + commit;
await output(values.output, async (root) => {
  const raw = await fetchBytes(
    url,
    16 * 1024 * 1024,
    Date.now() + 120_000,
    (_from, to) => to.origin === "https://codeload.github.com",
  );
  const archive = tar(raw, 32 * 1024 * 1024, 4096), observed: Record<string, string> = {};
  let retained = 0;
  for (const member of archive.members) {
    const slash = member.name.indexOf("/"), path = member.name.slice(slash + 1);
    if (slash < 0 || !expected.has(path)) continue;
    check(
      member.kind === "file" && member.size <= 4 * 1024 * 1024 && !Object.hasOwn(observed, path),
      "Selected source member profile.",
    );
    retained += member.size;
    check(
      retained <= 16 * 1024 * 1024 && gitBlob(member.data) === expected.get(path),
      "Retained extent/Git blob identity.",
    );
    snapshot(root, path + ".snapshot", member.data);
    observed[path] = digest(member.data);
  }
  check(
    Object.keys(observed).length === expected.size && observed.LICENSE === pin.licenseSha256,
    "Complete source inventory/license SHA.",
  );
  json(root, "source-receipt.json", {
    url,
    commit,
    archiveSha256: digest(raw),
    archiveBytes: raw.length,
    expandedBytes: archive.expandedBytes,
    members: archive.members.length,
    retainedBytes: retained,
    files: observed,
    scope: "Inert .snapshot files; reconstruct only in an explicitly owned offline provider.",
  });
});
