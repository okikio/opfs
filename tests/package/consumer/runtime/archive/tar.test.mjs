/** Installed archive tar contracts. Each case owns its state and exact source oracle. */
import { describe, it } from "node:test";
import { createFileSystem } from "@okikio/opfs";
import { createByteSource } from "@okikio/opfs/source";
import { createTarStream, scanTar } from "@okikio/opfs/archive/tar/stream";
import { openTar } from "@okikio/opfs/archive/tar";
import { createTarAdapter } from "@okikio/opfs/view/tar";
import { archivePayload, assertBytes } from "../../bytes.mjs";
import { finish } from "../../finish.mjs";
import sparseInput from "../../data/archive/sparse.json" with { type: "json" };

describe("packed archive tar", () => {
  it("TAR filesystem view ranges", async () => {
    const failures = [], releases = [];
    try {
      const tarViewBytes = new Uint8Array(
        await new Response(createTarStream([
          { name: "notes/hello.txt", size: 3, body: new Blob([new Uint8Array([1, 2, 3])]).stream() },
        ])).arrayBuffer(),
      );
      const tarView = createFileSystem(createTarAdapter(await openTar(createByteSource(tarViewBytes))));
      releases.push(() => tarView.close());
      assertBytes(await tarView.readFile("/notes/hello.txt", { at: 1, length: 2 }), new Uint8Array([2, 3]));
    } catch (reason) {
      failures.push(reason);
    } finally {
      await finish(releases, failures);
    }
  });
  it("sparse TAR holes and work accounting", async () => {
    const sparseFixture = sparseInput;
    const sparseTar = await openTar(
      createByteSource(Uint8Array.from(atob(sparseFixture.archive), (byte) => byte.charCodeAt(0))),
    );
    const sparseEntry = sparseTar.entries.find((entry) => entry.name === "many.bin");
    const sparseRead = await sparseTar.read(sparseEntry.id);
    const sparseHole = sparseTar.entries.find((entry) => entry.name === "all-hole.bin");
    const sparseHoleRead = await sparseTar.read(sparseHole.id, { length: 37, maxSourceBytes: 0, maxRequests: 0 });
    assertBytes(sparseHoleRead.bytes, new Uint8Array(37));
    if (
      sparseHoleRead.work.sourceBytes !== 0 || sparseHoleRead.work.requests !== 0 ||
      sparseHoleRead.work.decodedBytes !== 37 || sparseHoleRead.work.outputBytes !== 37
    ) throw new Error("Packed sparse TAR hole accounting changed");
    assertBytes(sparseRead.bytes, Uint8Array.from(atob(sparseFixture.body), (byte) => byte.charCodeAt(0)));
    if (
      sparseEntry.sparse.profile !== "gnu-pax-1.0" || sparseEntry.sparse.mapBytes <= 512 ||
      sparseRead.integrity !== "header-checksum-only"
    ) throw new Error("Packed sparse TAR physical/logical evidence changed");
  });
  it("one-shot PAX TAR scanning", async () => {
    const tarName = "café/" + "long-name-".repeat(20);
    let tarMembers = 0;
    const tarScan = await scanTar(
      createTarStream([
        { name: tarName, size: archivePayload.length, body: new Blob([archivePayload]).stream() },
        { name: "empty/", kind: "directory", size: 0 },
      ]),
      async (entry, body) => {
        tarMembers++;
        let offset = 0;
        for await (const chunk of body) {
          assertBytes(chunk, archivePayload.subarray(offset, offset + chunk.length));
          offset += chunk.length;
        }
        if (entry.kind === "file" && (entry.name !== tarName || offset !== archivePayload.length)) {
          throw new Error("Packed PAX TAR member mismatch");
        }
      },
      { bodyChunkBytes: 31, maxOutputBytes: 1024 },
    );
    if (!tarScan.complete || tarMembers !== 2 || tarScan.work.outputBytes !== 1024) {
      throw new Error("Packed one-shot TAR scan mismatch");
    }
  });
});
