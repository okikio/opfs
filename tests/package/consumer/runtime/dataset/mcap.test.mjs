/** Installed dataset mcap contracts. Each case owns its state and exact source oracle. */
import { describe, it } from "node:test";
import { createByteSource } from "@okikio/opfs/source";
import { openMcap } from "@okikio/opfs/dataset/mcap";
import { assertBytes } from "../../bytes.mjs";
import mcapInput from "../../data/dataset/mcap.json" with { type: "json" };

describe("packed dataset mcap", () => {
  it("MCAP enumeration, exact time and CRC scope", async () => {
    const mcapFixture = mcapInput;
    const mcap = await openMcap(
      createByteSource(Uint8Array.from(atob(mcapFixture.data), (byte) => byte.charCodeAt(0))),
      { profile: "mcap0-uncompressed" },
    );
    const mcapPage = mcap.messages({ limit: 64, maxScanned: 64 });
    if (
      mcapPage.messages.length !== mcapFixture.messages.length || mcap.integrity.scope !== "summary" ||
      mcap.integrity.status !== "verified"
    ) throw new Error("Packed MCAP physical enumeration changed");
    for (let id = 0; id < mcapFixture.messages.length; id++) {
      const original = mcapFixture.messages[id], descriptor = mcapPage.messages[id], result = await mcap.read(id);
      assertBytes(result.bytes, Uint8Array.from(atob(original.data), (byte) => byte.charCodeAt(0)));
      if (
        descriptor.logTime !== BigInt(original.logTime) || descriptor.publishTime !== BigInt(original.publishTime) ||
        result.integrity.scope !== "chunk" || result.integrity.status !== "verified"
      ) throw new Error("Packed MCAP exact time or CRC scope changed");
    }
    const mcapSparse = mcap.messages({ channelId: 65535, limit: 2, maxScanned: 3 });
    if (mcapSparse.messages.length !== 0 || mcapSparse.scanned !== 3 || mcapSparse.cursor !== 3) {
      throw new Error("Packed MCAP empty sparse continuation changed");
    }
    const mcapUnchecked = await mcap.read(0, { length: 3, verify: false });
    if (mcapUnchecked.integrity.status !== "pending") throw new Error("Packed MCAP pending evidence changed");
    assertBytes(
      await mcap.source(0).read(0, 3),
      Uint8Array.from(atob(mcapFixture.messages[0].data), (byte) => byte.charCodeAt(0)).slice(0, 3),
    );
    assertBytes(
      (await mcap.readAttachment(0)).bytes,
      new Uint8Array([0, ...new TextEncoder().encode("native attachment"), 255]),
    );
    if ((await mcap.verify({ scope: "data" })).integrity.status !== "verified") {
      throw new Error("Packed MCAP whole data check changed");
    }
  });
});
