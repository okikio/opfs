import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { decodeLfsPointer, encodeLfsPointer, LfsClient } from "../src/content/lfs.ts";
import { LFS_BYTES, openLfsFixture } from "./provider/lfs.ts";
import { withReleases } from "./close.ts";
describe("native Gitea and official Git LFS CLI", () => {
  it("matches byte-exact pointer and empty-pass-through native CLI fixtures", async () => {
    for (const file of ["hello", "empty"]) {
      const bytes = new Uint8Array(
        await readFile(fileURLToPath(new URL(`./fixtures/lfs/${file}.pointer`, import.meta.url).href)),
      );
      expect(encodeLfsPointer(decodeLfsPointer(bytes))).toEqual(bytes);
    }
  });
  it("cross-reads complete object bytes with native clean/pre-push and smudge", { timeout: 600_000 }, async () => {
    await withReleases(async (releases) => {
      const fixture = await openLfsFixture();
      releases.push(() => fixture.close());
      const selected = await fixture.seed();
      const client = new LfsClient({
        endpoint: fixture.endpoint,
        allowHttp: true,
        fetch: fixture.fetch,
        credentials: () => ({ Authorization: fixture.authorization }),
        downloadOrigins: [fixture.origin],
        uploadOrigins: [fixture.origin],
        verifyOrigins: [fixture.origin],
        subtle: crypto.subtle,
      });
      expect(new TextDecoder().decode(await client.readVerified(selected))).toBe(LFS_BYTES);
      const bytes = new TextEncoder().encode("candidate Git LFS upload, independently fetched by native CLI\n");
      const object = { oid: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
      const receipt = await client.upload(object, bytes);
      expect(["uploaded", "verified"]).toContain(receipt.state);
      expect(await fixture.read(object.oid, object.size)).toEqual(bytes);
      expect((await client.upload(object, bytes)).state).toBe("already-present");
    });
  });
});
