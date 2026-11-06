/** Inert official source acquisition pinned to the published release asset digest and exact extent. */
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { check, digest, fetchBytes, json, output, snapshot } from "../acquire.ts";
import { SAMTOOLS } from "./artifacts.ts";

const { values } = parseArgs({ options: { output: { type: "string" } } });
check(values.output, "Require a fresh --output directory.");
const url = SAMTOOLS.url;
await output(resolve(values.output), async (root) => {
  const archive = await fetchBytes(
    url,
    SAMTOOLS.bytes,
    Date.now() + 60_000,
    (from, to) => from.hostname === "github.com" && to.hostname === "release-assets.githubusercontent.com",
  );
  check(
    archive.length === SAMTOOLS.bytes && digest(archive) === SAMTOOLS.sha256,
    "Official release archive does not match its pinned extent and published digest.",
  );
  snapshot(root, "samtools-1.25.tar.bz2.snapshot", archive);
  json(root, "admission.json", {
    source: url,
    release: SAMTOOLS.version,
    bytes: archive.length,
    sha256: digest(archive),
    releaseID: SAMTOOLS.release,
    assetID: SAMTOOLS.asset,
    metadataAuthority: SAMTOOLS.authority,
    annotatedTag: SAMTOOLS.tag,
    commit: SAMTOOLS.commit,
    tagAuthority: SAMTOOLS.tagAuthority,
    digestAuthority:
      "published GitHub release asset SHA-256; not a reproducible build or independent signature verification",
    executionAdmitted: false,
    bundledLibraryIdentity: "pending bounded source inventory and native version observation",
  });
});
