import { after, before, describe, it } from "node:test";
import { expect } from "@std/expect";
import { OciClient } from "../src/oci.ts";
import { close } from "./close.ts";
import { OCI_BLOB, OCI_REPOSITORY, openOci } from "./provider/oci.ts";
import type { OciFixture } from "./provider/oci.ts";

/** Actual Distribution service evidence for this pull profile, not OCI certification. */
describe("OCI Distribution 3.1.2 Testcontainers pull profile", () => {
  let fixture: OciFixture | undefined;
  let seed: Awaited<ReturnType<OciFixture["seed"]>>;
  let files: OciClient;
  before(async () => {
    fixture = await openOci();
    try {
      seed = await fixture.seed();
      files = new OciClient({
        registry: fixture.endpoint,
        repository: OCI_REPOSITORY,
        allowHttp: true,
        request: { retries: 0 },
      });
    } catch (cause) {
      await close([() => fixture!.close()], [cause]);
    }
  });
  after(async () => {
    await fixture?.close();
  });

  it("verifies exact digest and tag manifest bytes independently produced through registry REST", async () => {
    const byTag = await files.getManifest("a");
    const byDigest = await files.getManifest(seed.manifest);
    expect(byTag.digest).toBe(seed.manifest);
    expect(byDigest.bytes).toEqual(seed.bytes);
    expect(byTag.integrity).toBe("sha256");
    expect(byTag.layers?.[0]?.digest).toBe(seed.blob);
  });
  it("reads server metadata and exact ranges, then verifies the complete blob digest", async () => {
    expect(await files.statBlob(seed.blob)).toEqual({
      digest: seed.blob,
      size: OCI_BLOB.byteLength,
      integrity: "server",
    });
    const range = new Uint8Array(
      await new Response(await files.getBlob(seed.blob, { integrity: "server", at: 2, length: 7 })).arrayBuffer(),
    );
    expect(range).toEqual(OCI_BLOB.slice(2, 9));
    expect(await files.readBlob(seed.blob, { size: OCI_BLOB.byteLength })).toEqual(OCI_BLOB);
  });
  it("exposes only a privately verified immutable local snapshot for archive consumers", async () => {
    const source = await files.openBlobSource(seed.blob, { size: OCI_BLOB.byteLength });
    expect(source.stability).toBe("immutable");
    expect(source.identity).toBe(`oci:${seed.blob}`);
    const range = await source.read(0, 3);
    range.fill(0);
    expect(await source.read(0, 3)).toEqual(OCI_BLOB.slice(0, 3));
  });
  it("follows real registry tag pagination within the selected repository", async () => {
    const tags = [];
    for await (const value of files.tags({ pageSize: 1 })) tags.push(value);
    expect(tags).toEqual(["a", "b", "c"]);
  });
});
