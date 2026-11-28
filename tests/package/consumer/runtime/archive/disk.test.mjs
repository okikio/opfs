/** Installed archive disk contracts. Each case owns its state and exact source oracle. */
import { describe, it } from "node:test";
import { createByteSource } from "@okikio/opfs/source";
import { openIso } from "@okikio/opfs/archive/iso";
import { openWim } from "@okikio/opfs/archive/wim";
import { openUdf } from "@okikio/opfs/archive/udf";
import { assertBytes } from "../../bytes.mjs";
import udfInput from "../../data/archive/udf.json" with { type: "json" };
import isoInput from "../../data/archive/iso.json" with { type: "json" };
import lzxInput from "../../data/archive/lzx.json" with { type: "json" };
import xpressInput from "../../data/archive/xpress.json" with { type: "json" };
import wimInput from "../../data/archive/wim.json" with { type: "json" };

describe("packed archive disk", () => {
  it("UDF physical ranges and metadata scope", async () => {
    const udfFixture = udfInput;
    const udf = await openUdf(
      createByteSource(Uint8Array.from(atob(udfFixture.archive), (byte) => byte.charCodeAt(0))),
    );
    const udfEntry = udf.entries.find((entry) => entry.kind === "file" && entry.name === "large.bin");
    const udfOriginal = Uint8Array.from(atob(udfFixture.body), (byte) => byte.charCodeAt(0));
    assertBytes((await udf.read(udfEntry.id)).bytes, udfOriginal);
    assertBytes(await udf.member(udfEntry.id).read(2040, 37), udfOriginal.slice(2040, 2077));
    if (
      udf.metadata !== "descriptor-crc16-verified" || (await udf.read(udfEntry.id, { length: 0 })).integrity !== "none"
    ) throw new Error("Packed UDF metadata/payload scope changed");
  });
  it("Joliet ISO members", async () => {
    const isoFixture = isoInput;
    const iso = await openIso(
      createByteSource(Uint8Array.from(atob(isoFixture.archive), (byte) => byte.charCodeAt(0))),
      { namespace: "joliet" },
    );
    const isoHello = iso.entries.find((entry) => entry.parentId === -1 && entry.name === "hello.txt");
    assertBytes(
      (await iso.read(isoHello.id)).bytes,
      Uint8Array.from(atob(isoFixture.body), (byte) => byte.charCodeAt(0)),
    );
  });
  it("WIM LZX resource proof and decode work", async () => {
    const lzxFixture = lzxInput;
    const lzx = await openWim(
      createByteSource(Uint8Array.from(atob(lzxFixture.archive), (byte) => byte.charCodeAt(0))),
      { subtle: globalThis.crypto.subtle },
    );
    const lzxImage = await lzx.image(1);
    const lzxEntry = lzxImage.entries.find((entry) => entry.path === lzxFixture.path);
    const lzxRead = await lzxImage.read(lzxEntry.id);
    assertBytes(lzxRead.bytes, Uint8Array.from(atob(lzxFixture.body), (byte) => byte.charCodeAt(0)));
    if (
      lzx.profile !== "lzx-32k-1.13" || lzxRead.integrity !== "resource-sha1-verified" || lzxRead.lzxSteps <= 0 ||
      lzxRead.lzxBlocks <= 0 || lzxRead.xpressSteps !== 0
    ) throw new Error("Packed WIM LZX evidence changed");
  });
  it("WIM XPRESS resource proof and decode work", async () => {
    const xpressFixture = xpressInput;
    const xpress = await openWim(
      createByteSource(Uint8Array.from(atob(xpressFixture.archive), (byte) => byte.charCodeAt(0))),
      { subtle: globalThis.crypto.subtle },
    );
    const xpressImage = await xpress.image(1);
    const xpressEntry = xpressImage.entries.find((entry) => entry.path === xpressFixture.path);
    const xpressRead = await xpressImage.read(xpressEntry.id);
    assertBytes(xpressRead.bytes, Uint8Array.from(atob(xpressFixture.body), (byte) => byte.charCodeAt(0)));
    if (
      xpress.profile !== "xpress-huffman-32k-1.13" || xpressRead.integrity !== "resource-sha1-verified" ||
      xpressRead.xpressSteps <= 0
    ) throw new Error("Packed WIM XPRESS evidence changed");
  });
  it("WIM stored resource checksums", async () => {
    const wimFixture = wimInput;
    const wim = await openWim(
      createByteSource(Uint8Array.from(atob(wimFixture.archive), (byte) => byte.charCodeAt(0))),
      { subtle: globalThis.crypto.subtle },
    );
    const wimImage = await wim.image(1);
    const wimHello = wimImage.entries.find((entry) => entry.path === "hello.txt");
    const wimRead = await wimImage.read(wimHello.id);
    assertBytes(wimRead.bytes, Uint8Array.from(atob(wimFixture.body), (byte) => byte.charCodeAt(0)));
    if (wimImage.metadataIntegrity !== "resource-sha1-verified" || wimRead.integrity !== "resource-sha1-verified") {
      throw new Error("Packed WIM checksum scopes changed");
    }
  });
});
