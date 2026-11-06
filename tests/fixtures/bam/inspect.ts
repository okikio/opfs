/** Review frozen source and licenses without executing any archived program. */
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { check, json, output, snapshot } from "../acquire.ts";
import { MIB, sha } from "../arrow/files.ts";
import { SAMTOOLS } from "./artifacts.ts";
import { extractSource, inspectSource } from "./source.ts";

const { values } = parseArgs({ options: { artifacts: { type: "string" }, output: { type: "string" } } });
check(values.artifacts && values.output, "Require --artifacts and a fresh --output directory.");
const artifacts = resolve(values.artifacts);
await output(resolve(values.output), (root) => {
  const source = inspectSource(artifacts);
  const members = source.members.map((member) => ({
    path: member.name,
    kind: member.kind,
    mode: member.mode,
    bytes: member.size,
    sha256: sha(member.data),
  }));
  const licenses = source.members.filter((member) =>
    member.kind === "file" &&
    /^(?:licen[cs]e|copying|notice|authors|copyright)(?:[._-].*)?$/i.test(basename(member.name))
  );
  check(licenses.length > 0 && licenses.length <= 128, "Bounded license-material inventory is missing or excessive.");
  let licenseBytes = 0;
  for (const member of licenses) {
    licenseBytes += member.size;
    check(member.size <= MIB && licenseBytes <= 8 * MIB, "Source license-material byte allowance exceeded.");
  }
  extractSource(source, join(root, "source"), "review");
  const materials = licenses.map((member) => {
    const path = `licenses/${member.name}.snapshot`;
    snapshot(root, path, member.data);
    return { source: member.name, snapshot: path, bytes: member.size, sha256: sha(member.data) };
  });
  const buildInputs = members.filter((member) =>
    member.kind === "file" &&
    ((member.mode & 0o111) !== 0 ||
      /^(?:configure(?:\.ac)?|makefile(?:\..*)?|config\..*|install|readme(?:\..*)?)$/i.test(basename(member.path)))
  );
  const inventory = {
    sourceIdentity: SAMTOOLS,
    archiveSha256: source.sha256,
    archiveBytes: source.archiveBytes,
    expandedBytes: source.expandedBytes,
    members,
    buildInputs,
    licenseMaterials: materials,
    licenseBytes,
  };
  const encoded = new TextEncoder().encode(JSON.stringify(inventory) + "\n");
  check(encoded.length <= 16 * MIB, "Source review inventory JSON ceiling exceeded.");
  snapshot(root, "inventory.json", encoded);
  json(root, "review.json", {
    profile: "samtools-1.25-inert-source-review-v1",
    archiveSha256: source.sha256,
    inventory: { path: "inventory.json", bytes: encoded.length, sha256: sha(encoded) },
    expansion: source.expansion,
    executionAdmitted: false,
    archivedProgramsExecuted: false,
    extractedFilesExecutable: false,
    proof:
      "Exact release digest plus bounded system BZIP2/TAR decoding and copied source/license inventory. No configure, make, setup, upstream script or native consumer executed. Inventory is input to human/root review, not an execution grant or completed license assessment.",
    next:
      "Root must review inventory, license materials and build inputs, then create a separate fresh execution-admission.json beside the original acquired archive before create.ts may build.",
  });
  return Promise.resolve();
});
