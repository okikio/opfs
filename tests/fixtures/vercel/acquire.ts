/** Acquire inert, exact-version Vercel SDK/emulator evidence. Never install, import or execute acquired packages. */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { check, digest, fetchBytes, json, output, record, safe, snapshot, tar } from "../acquire.ts";
import { VERCEL_ARTIFACTS, VERCEL_ROOTS } from "./artifacts.ts";
import type { VercelArtifactType } from "./artifacts.ts";

/** Compare complete declaration maps; an unexpected edge must not be silently dropped from the closure. */
function edges(value: unknown, expected: Readonly<Record<string, string>>, label: string): void {
  const actual = value === undefined ? {} : record(value);
  const names = Object.keys(actual).sort(), wanted = Object.keys(expected).sort();
  check(
    names.length === wanted.length && names.every((name, index) => name === wanted[index]),
    label + " edge names differ.",
  );
  for (const name of names) check(actual[name] === expected[name], label + " edge range differs: " + name);
}

/** Registry and packed manifests must agree with the reviewed graph before their bytes are published as evidence. */
function declarations(value: Record<string, unknown>, pin: VercelArtifactType, label: string): void {
  check(value.name === pin.name && value.version === pin.version, label + " package identity differs.");
  check(value.license === pin.license, label + " license declaration differs.");
  edges(value.dependencies, pin.dependencies, label);
  edges(value.optionalDependencies, {}, label + " optional");
  edges(value.peerDependencies, {}, label + " peer");
  edges(value.peerDependenciesMeta, {}, label + " peer metadata");
  for (const bundled of [value.bundledDependencies, value.bundleDependencies]) {
    check(
      bundled === undefined || (Array.isArray(bundled) && bundled.length === 0),
      label + " bundled dependencies were not reviewed.",
    );
  }
}

/** Reject missing, duplicate or unreachable pins without resolving any version range or loading package code. */
function closure(): readonly VercelArtifactType[] {
  check(VERCEL_ARTIFACTS.length === 33, "Reviewed Vercel closure count differs.");
  const pins = new Map<string, VercelArtifactType>();
  for (const pin of VERCEL_ARTIFACTS) {
    const id = pin.name + "@" + pin.version;
    check(!pins.has(id), "Duplicate artifact identity.");
    check(
      /^(?:@[a-z0-9-]+\/)?[a-z0-9-]+$/.test(pin.name) && /^\d+\.\d+\.\d+$/.test(pin.version),
      "Noncanonical artifact identity.",
    );
    check(/^sha512-[A-Za-z0-9+/]{86}==$/.test(pin.integrity), "Noncanonical reviewed SRI.");
    const dependencies = Object.keys(pin.dependencies);
    check(
      Object.keys(pin.targets).length === dependencies.length &&
        dependencies.every((name) => typeof pin.targets[name] === "string"),
      "Dependency targets differ from declared edge names.",
    );
    for (const [name, target] of Object.entries(pin.targets)) {
      check(target.startsWith(name + "@"), "Dependency target changed package identity.");
    }
    pins.set(id, pin);
  }
  const reached = new Set<string>();
  const visit = (id: string): void => {
    if (reached.has(id)) return;
    const pin = pins.get(id);
    check(pin, "Unpinned dependency target: " + id);
    reached.add(id);
    for (const target of Object.values(pin.targets)) visit(target);
  };
  for (const id of VERCEL_ROOTS) visit(id);
  check(reached.size === pins.size, "Closure contains unreachable artifacts.");
  return [...pins.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, pin]) => pin);
}

const { values, positionals } = parseArgs({ options: { output: { type: "string" } }, allowPositionals: true });
check(values.output && positionals.length === 0, "Usage: acquire.ts --output FRESH_DIRECTORY");
const pins = closure();
await output(resolve(values.output), async (root) => {
  const deadline = Date.now() + 600_000;
  let compressed = 0, expanded = 0, files = 0, metadataBytes = 0, legalBytes = 0;
  const inventory: unknown[] = [], missingStandaloneNotices: string[] = [], attestations: unknown[] = [];
  for (const pin of pins) {
    const id = pin.name + "@" + pin.version;
    const path = pin.name.replace("/", "__") + "@" + pin.version;
    const metadataURL = "https://registry.npmjs.org/" + encodeURIComponent(pin.name) + "/" + pin.version;
    const rawMetadata = await fetchBytes(metadataURL, 256 * 1024, deadline);
    metadataBytes += rawMetadata.length;
    check(metadataBytes <= 8 * 1048576, "Aggregate registry metadata ceiling.");
    snapshot(root, "metadata/" + path + ".json", rawMetadata);
    const metadata = record(JSON.parse(rawMetadata.toString("utf8")));
    declarations(metadata, pin, id + " registry");
    const dist = record(metadata.dist), base = pin.name.slice(pin.name.lastIndexOf("/") + 1);
    const url = "https://registry.npmjs.org/" + pin.name + "/-/" + base + "-" + pin.version + ".tgz";
    check(dist.integrity === pin.integrity && dist.tarball === url, "Registry archive identity differs.");
    if (VERCEL_ROOTS.some((candidate) => candidate === id)) {
      const attestationURL = "https://registry.npmjs.org/-/npm/v1/attestations/" + pin.name.replace("/", "%2f") + "@" +
        pin.version;
      check(record(dist.attestations).url === attestationURL, "Root registry provenance URL differs.");
      const attestation = await fetchBytes(attestationURL, 1024 * 1024, deadline);
      snapshot(root, "provenance/" + path + ".json", attestation);
      attestations.push({
        id,
        url: attestationURL,
        bytes: attestation.length,
        sha256: digest(attestation),
        signatureVerified: false,
      });
    }
    const raw = await fetchBytes(url, 8 * 1048576, deadline);
    compressed += raw.length;
    check(compressed <= 64 * 1048576, "Aggregate compressed archive ceiling.");
    const integrity = "sha512-" + createHash("sha512").update(raw).digest("base64");
    check(integrity === pin.integrity, "Archive SRI differs from reviewed identity.");
    snapshot(root, "archives/" + path + ".tgz.snapshot", raw);
    const archive = tar(raw, Math.min(32 * 1048576, 96 * 1048576 - expanded), Math.min(6000, 12000 - files));
    expanded += archive.expandedBytes;
    check(expanded <= 96 * 1048576, "Aggregate expanded archive ceiling.");
    let packed: Record<string, unknown> | undefined;
    const members: unknown[] = [], notices: string[] = [], readmes: string[] = [];
    for (const member of archive.members) {
      check(member.kind !== "link", "Acquired hard links and symbolic links are not admitted.");
      if (member.kind === "directory") {
        check(
          member.name === "package/" || member.name.startsWith("package/"),
          "Archive directory escapes package root.",
        );
        continue;
      }
      check(member.name.startsWith("package/"), "Archive file escapes package root.");
      const relative = safe(member.name.slice(8));
      check(++files <= 12000, "Aggregate acquired file count ceiling.");
      snapshot(root, "source/" + path + "/" + relative + ".snapshot", member.data);
      members.push({ path: relative, bytes: member.size, sha256: digest(member.data), mode: member.mode });
      if (relative === "package.json") {
        check(member.size <= 256 * 1024, "Packed package manifest ceiling.");
        packed = record(JSON.parse(member.data.toString("utf8")));
      }
      const notice = relative.split("/").some((part) =>
        /(?:^|[-_.])(?:licen[cs]es?|notices?|copying|copyright)(?:[-_.]|$)/iu.test(part)
      );
      const readme = /(?:^|\/)readme(?:[-_.]|$)/iu.test(relative);
      if (notice || readme) {
        legalBytes += member.size;
        check(member.size <= 256 * 1024 && legalBytes <= 4 * 1048576, "Legal/README evidence ceiling.");
        snapshot(root, "legal/" + path + "/" + relative + ".snapshot", member.data);
        if (notice) notices.push(relative);
        if (readme) readmes.push(relative);
      }
    }
    check(packed, "Archive omitted packed package manifest.");
    declarations(packed, pin, id + " packed");
    if (notices.length === 0) missingStandaloneNotices.push(id);
    inventory.push({
      id,
      metadataURL,
      metadataSha256: digest(rawMetadata),
      tarball: url,
      integrity,
      tarballSha256: digest(raw),
      tarballBytes: raw.length,
      expandedBytes: archive.expandedBytes,
      dependencies: pin.dependencies,
      targets: pin.targets,
      license: packed.license,
      notices,
      readmes,
      exports: packed.exports ?? null,
      main: packed.main ?? null,
      scripts: packed.scripts ?? {},
      bin: packed.bin ?? null,
      engines: packed.engines ?? null,
      registryGitHead: metadata.gitHead ?? null,
      registryAttestations: dist.attestations ?? null,
      members,
    });
  }
  json(root, "closure.json", {
    roots: VERCEL_ROOTS,
    packages: inventory,
    attestations,
    totals: { packages: pins.length, compressed, expanded, files, metadataBytes, legalBytes },
    missingStandaloneNotices,
    sourceRevisionObservations: {
      sdk: "5425e1611f65799a02ffa0033086a56e8d280dd5",
      emulator: "1566b8e38177bd606f1b4415b7da047ae653a8b7",
      scope:
        "Prior decoded registry provenance observations; this acquisition does not verify signatures, provenance or source/build correspondence.",
    },
    scope:
      "Inert SRI/registry/packed-manifest admission only. No install, lifecycle scripts, module import, CLI execution or native service execution.",
    executableAdmission: false,
    legalReview:
      "pending; review every retained notice and any missing standalone notice before test execution; no license text is synthesized",
    productionDependencyApproved: false,
  });
});
