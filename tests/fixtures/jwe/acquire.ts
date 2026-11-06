/** Download reviewed jose metadata or SHA-admitted package bytes without importing them. */
import { Buffer } from "node:buffer";
import { parseArgs } from "node:util";
import { check, digest, fetchBytes, json, output, record, snapshot, tar, text } from "../acquire.ts";

const VERSION = "6.2.15";
const METADATA = "https://registry.npmjs.org/jose/6.2.15";
const ARTIFACT = "https://registry.npmjs.org/jose/-/jose-6.2.15.tgz";
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { output: { type: "string" }, integrity: { type: "string" } },
});
check(
  values.output && positionals.length === 1 && ["metadata", "artifact"].includes(positionals[0]!),
  "Usage: acquire.ts metadata|artifact --output FRESH_PATH [--integrity sha512-BASE64]",
);
function integrity(value: unknown): Buffer<ArrayBuffer> {
  const encoded = text(value);
  check(/^sha512-[A-Za-z0-9+/]{86}==$/.test(encoded), "Expected canonical SHA-512 SRI.");
  const bytes = Buffer.from(encoded.slice(7), "base64");
  check(bytes.length === 64 && bytes.toString("base64") === encoded.slice(7), "Invalid SHA-512 SRI.");
  return bytes;
}
function packageMetadata(value: unknown): Record<string, unknown> {
  const data = record(value);
  check(
    data.name === "jose" && data.version === VERSION && data.license === "MIT",
    "Reviewed package identity/license.",
  );
  for (const key of ["dependencies", "optionalDependencies"]) {
    check(data[key] === undefined || Object.keys(record(data[key])).length === 0, "Dependency admission changed.");
  }
  return data;
}
await output(values.output, async (root) => {
  const deadline = Date.now() + 120_000;
  if (positionals[0] === "metadata") {
    const raw = await fetchBytes(METADATA, 256 * 1024, deadline);
    const data = packageMetadata(JSON.parse(raw.toString())), dist = record(data.dist);
    check(dist.tarball === ARTIFACT, "Reviewed artifact URL changed.");
    integrity(dist.integrity);
    snapshot(root, "registry.json.snapshot", raw);
    json(root, "registry-receipt.json", {
      url: METADATA,
      bytes: raw.length,
      sha256: digest(raw),
      integrity: dist.integrity,
      artifact: ARTIFACT,
      scope: "Metadata only; artifact not downloaded or executed.",
    });
    return;
  }
  const expected = integrity(values.integrity);
  const raw = await fetchBytes(ARTIFACT, 2 * 1024 * 1024, deadline);
  check(digest(raw, "sha512") === expected.toString("hex"), "Artifact SHA-512 differs from reviewed metadata.");
  const archive = tar(raw, 8 * 1024 * 1024, 512), selected = new Map<string, Buffer<ArrayBuffer>>();
  let total = 0;
  const rows = archive.members.map((member) => {
    check(
      member.name.split("/")[0] === "package" && member.kind !== "link" && member.size <= 256 * 1024,
      "Package TAR admission.",
    );
    total += member.size;
    if (
      member.kind === "file" &&
      (["package/package.json", "package/LICENSE.md", "package/README.md"].includes(member.name) ||
        (member.name.startsWith("package/dist/webapi/") && member.name.endsWith(".js")))
    ) selected.set(member.name, member.data);
    return {
      name: member.name,
      bytes: member.size,
      kind: member.kind,
      ...(member.kind === "file" ? { sha256: digest(member.data) } : {}),
    };
  });
  const license = selected.get("package/LICENSE.md"), manifest = selected.get("package/package.json");
  check(
    rows.length && license?.includes(Buffer.from("MIT License")) && manifest &&
      selected.has("package/dist/webapi/index.js"),
    "Required package inventory/license.",
  );
  check(packageMetadata(JSON.parse(manifest.toString())).type === "module", "Reviewed ESM package profile.");
  for (const [name, bytes] of selected) snapshot(root, "sdk/" + name.slice("package/".length) + ".snapshot", bytes);
  snapshot(root, "artifact.tgz.snapshot", raw);
  json(root, "acquisition.json", {
    url: ARTIFACT,
    integrity: values.integrity,
    bytes: raw.length,
    sha256: digest(raw),
    members: rows,
    selected: [...selected.keys()],
    declaredFileBytes: total,
    expandedTarBytes: archive.expandedBytes,
    scope: "SHA-verified inert package bytes; no import, install, build or lifecycle execution.",
  });
});
