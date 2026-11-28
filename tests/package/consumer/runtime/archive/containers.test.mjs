/** Installed archive containers contracts. Each case owns its state and exact source oracle. */
import { describe, it } from "node:test";
import { createFileSystem } from "@okikio/opfs";
import { createByteSource } from "@okikio/opfs/source";
import { openCpio } from "@okikio/opfs/archive/cpio";
import { createCpioAdapter } from "@okikio/opfs/view/cpio";
import { openCab } from "@okikio/opfs/archive/cab";
import { openSeven } from "@okikio/opfs/archive/seven";
import { openAr } from "@okikio/opfs/archive/ar";
import { openXar } from "@okikio/opfs/archive/xar";
import { openRar } from "@okikio/opfs/archive/rar";
import { openLha } from "@okikio/opfs/archive/lha";
import { openArj } from "@okikio/opfs/archive/arj";
import { openBinHex } from "@okikio/opfs/archive/binhex";
import { assertBytes, fromBase64 } from "../../bytes.mjs";
import { finish } from "../../finish.mjs";
import cpioInput from "../../data/archive/cpio.json" with { type: "json" };
import cabInput from "../../data/archive/cab.json" with { type: "json" };
import mszipInput from "../../data/archive/mszip.json" with { type: "json" };
import sevenInput from "../../data/archive/seven.json" with { type: "json" };
import compressedSevenInput from "../../data/archive/compressedseven.json" with { type: "json" };
import arInput from "../../data/archive/ar.json" with { type: "json" };
import lhaInput from "../../data/archive/lha.json" with { type: "json" };
import binhexInput from "../../data/archive/binhex.json" with { type: "json" };
import binhexPerlInput from "../../data/archive/binhexperl.json" with { type: "json" };
import arjInput from "../../data/archive/arj.json" with { type: "json" };
import rarInput from "../../data/archive/rar.json" with { type: "json" };
import xarInput from "../../data/archive/xar.json" with { type: "json" };

describe("packed archive containers", () => {
  it("GNU CPIO filesystem view ranges", async () => {
    const failures = [], releases = [];
    try {
      // CPIO fixture bytes come from the independent GNU producer retained by the repository.
      const cpioFixture = cpioInput;
      const cpioBytes = Uint8Array.from(atob(cpioFixture.archive), (byte) => byte.charCodeAt(0));
      const cpioArchive = await openCpio(createByteSource(cpioBytes));
      const cpioView = createFileSystem(
        createCpioAdapter({
          ...cpioArchive,
          entries: cpioArchive.entries.filter((entry) => entry.kind === "file" || entry.kind === "directory"),
        }),
      );
      releases.push(() => cpioView.close());
      const cpioExpected = Uint8Array.from(
        atob(cpioFixture.entries.find((entry) => entry.name === "folder/data.bin").body),
        (byte) => byte.charCodeAt(0),
      );
      assertBytes(await cpioView.readFile("/folder/data.bin", { length: 7 }), cpioExpected.slice(0, 7));
    } catch (reason) {
      failures.push(reason);
    } finally {
      await finish(releases, failures);
    }
  });
  it("CAB stored and MSZIP prerequisite evidence", async () => {
    const cabFixture = cabInput;
    const cabArchive = await openCab(
      createByteSource(Uint8Array.from(atob(cabFixture.archive), (byte) => byte.charCodeAt(0))),
    );
    assertBytes(
      (await cabArchive.read(0)).bytes,
      Uint8Array.from(atob(cabFixture.entries[0].body), (byte) => byte.charCodeAt(0)),
    );
    const mszipFixture = mszipInput;
    const mszip = await openCab(
      createByteSource(Uint8Array.from(atob(mszipFixture.archive), (byte) => byte.charCodeAt(0))),
    );
    const mszipRead = await mszip.read(0, { offset: 32768, length: 3 });
    assertBytes(
      mszipRead.bytes,
      Uint8Array.from(atob(mszipFixture.body), (byte) => byte.charCodeAt(0)).subarray(32768, 32771),
    );
    if (
      !mszipRead.blocks.some((block) => block.role === "history") || mszipRead.integrity !== "block-checksum-verified"
    ) throw new Error("Packed MSZIP prerequisite evidence changed");
  });
  it("7z COPY, compressed members and encoded metadata", async () => {
    const sevenFixture = sevenInput;
    const sevenArchive = await openSeven(
      createByteSource(Uint8Array.from(atob(sevenFixture.archive), (byte) => byte.charCodeAt(0))),
    );
    const sevenFile = sevenArchive.entries.find((entry) => entry.kind === "file" && entry.readable && entry.size > 0);
    if (!sevenFile) throw new Error("Packed 7z COPY missing");
    assertBytes(
      (await sevenArchive.read(sevenFile.id)).bytes,
      Uint8Array.from(
        atob(sevenFixture.entries.find((entry) => entry.name === sevenFile.name).body),
        (byte) => byte.charCodeAt(0),
      ),
    );
    const compressedSevenFixtures = compressedSevenInput;
    for (const fixture of compressedSevenFixtures) {
      const compressedSeven = await openSeven(
        createByteSource(Uint8Array.from(atob(fixture.archive), (byte) => byte.charCodeAt(0))),
      );
      for (const entry of compressedSeven.entries.filter((entry) => entry.kind === "file" && entry.size > 0)) {
        const result = await compressedSeven.read(entry.id);
        assertBytes(
          result.bytes,
          Uint8Array.from(
            atob(fixture.entries.find((item) => item.name === entry.name).body),
            (byte) => byte.charCodeAt(0),
          ),
        );
        if (result.decoding !== "complete" || result.integrity !== "crc32-verified") {
          throw new Error("Packed 7z compressed member scope changed");
        }
      }
      if (fixture.nextHeaderTag === 23 && compressedSeven.headers.decoded?.integrity !== "crc32-verified") {
        throw new Error("Packed 7z encoded metadata was not verified");
      }
    }
  });
  it("GNU ar members", async () => {
    const arFixture = arInput;
    const arArchive = await openAr(
      createByteSource(Uint8Array.from(atob(arFixture.archive), (byte) => byte.charCodeAt(0))),
    );
    const arFile = arArchive.entries.find((entry) => entry.name === "first.bin");
    assertBytes(
      await arArchive.member(arFile.id).read(0, arFile.size),
      Uint8Array.from(
        atob(arFixture.entries.find((entry) => entry.name === "first.bin").body),
        (byte) => byte.charCodeAt(0),
      ),
    );
  });
  it("LHA checksum scopes", async () => {
    const lhaFixture = lhaInput;
    const lha = await openLha(createByteSource(Uint8Array.from(atob(lhaFixture.wire), (byte) => byte.charCodeAt(0))));
    const lhaEntry = lha.entries.find((entry) => entry.name === "odd.bin");
    const lhaRead = await lha.read(lhaEntry.id);
    const lhaOriginal = Uint8Array.from(atob(lhaFixture.original), (byte) => byte.charCodeAt(0));
    assertBytes(lhaRead.bytes, lhaOriginal);
    if (
      lhaEntry.level !== 2 || lhaRead.integrity !== "crc16-verified" || lhaEntry.headerIntegrity !== "crc16-verified"
    ) throw new Error("Packed LHA scopes changed");
    assertBytes(await lha.member(lhaEntry.id).read(3, 17), lhaOriginal.slice(3, 20));
  });
  it("BinHex forks and explicit producer padding", async () => {
    const binhexFixture = binhexInput;
    const binhex = await openBinHex(createByteSource(fromBase64(binhexFixture.archive.base64)), {
      preamble: "rfc1741-or-macutils",
    });
    const binhexData = await binhex.read("data", { length: 37 });
    assertBytes(binhexData.bytes, fromBase64(binhexFixture.data.base64).slice(0, 37));
    if (
      binhexData.data !== "crc16-verified" || binhexData.resource !== "pending" || binhexData.terminal !== "pending"
    ) throw new Error("Packed BinHex fork evidence changed");
    const binhexResource = await binhex.read("resource");
    assertBytes(binhexResource.bytes, fromBase64(binhexFixture.resource.base64));
    if (binhexResource.terminal !== "verified" || binhexResource.terminalPaddingBytes !== 0) {
      throw new Error("Packed BinHex terminal evidence changed");
    }
    assertBytes(await binhex.member("data").read(17, 37), fromBase64(binhexFixture.data.base64).slice(17, 54));
    const binhexPerlFixture = binhexPerlInput;
    const binhexPerl = await openBinHex(createByteSource(fromBase64(binhexPerlFixture.archive.base64)), {
      padding: "convert-binhex",
    });
    if ((await binhexPerl.verify()).terminalPaddingBytes !== 1) {
      throw new Error("Packed BinHex explicit producer padding changed");
    }
  });
  it("ARJ verified and unchecked range costs", async () => {
    const arjFixture = arjInput;
    const arjBytes = Uint8Array.from(atob(arjFixture.wire), (byte) => byte.charCodeAt(0));
    let arjPhysical = 0;
    const arj = await openArj({
      size: arjBytes.length,
      stability: "immutable",
      read: async (at, length) => {
        arjPhysical += length;
        return arjBytes.slice(at, at + length);
      },
    });
    const arjEntry = arj.entries.find((entry) => entry.name === "many.bin");
    if (!arjEntry || arjEntry.headerIntegrity !== "crc32-verified") {
      throw new Error("Packed ARJ native member is absent");
    }
    const arjOriginal = Uint8Array.from(atob(arjFixture.original), (byte) => byte.charCodeAt(0));
    const arjFull = await arj.read(arjEntry.id);
    assertBytes(arjFull.bytes, arjOriginal);
    const arjBefore = arjPhysical;
    const arjPrefix = await arj.read(arjEntry.id, { length: 37 });
    assertBytes(arjPrefix.bytes, arjOriginal.slice(0, 37));
    if (
      arjFull.integrity !== "crc32-verified" || arjPrefix.integrity !== "crc32-verified" ||
      arjPhysical - arjBefore !== arjOriginal.length
    ) throw new Error("Packed ARJ verification scope changed");
    const arjPendingAt = arjPhysical;
    const arjPartial = await arj.read(arjEntry.id, { offset: 3, length: 17, verify: false });
    assertBytes(arjPartial.bytes, arjOriginal.slice(3, 20));
    if (arjPartial.integrity !== "pending" || arjPhysical - arjPendingAt !== 17) {
      throw new Error("Packed ARJ unchecked range cost changed");
    }
    assertBytes(await arj.member(arjEntry.id).read(3, 17), arjOriginal.slice(3, 20));
  });
  it("RAR checksum scopes", async () => {
    const rarFixture = rarInput;
    const rar = await openRar(
      createByteSource(Uint8Array.from(atob(rarFixture.archive), (byte) => byte.charCodeAt(0))),
    );
    const rarHello = rar.entries.find((entry) => entry.name === "hello.txt");
    const rarRead = await rar.read(rarHello.id);
    assertBytes(rarRead.bytes, Uint8Array.from(atob(rarFixture.body), (byte) => byte.charCodeAt(0)));
    if (rar.metadata !== "header-crc32-verified" || rarRead.integrity !== "crc32-verified") {
      throw new Error("Packed RAR checksum scopes changed");
    }
  });
  it("XAR table and member checksums", async () => {
    const xarFixture = xarInput;
    const xar = await openXar(
      createByteSource(Uint8Array.from(atob(xarFixture.archive), (byte) => byte.charCodeAt(0))),
      { subtle: globalThis.crypto.subtle },
    );
    const xarHello = xar.entries.find((entry) => entry.path === "hello.txt");
    const xarRead = await xar.read(xarHello.id);
    assertBytes(xarRead.bytes, Uint8Array.from(atob(xarFixture.body), (byte) => byte.charCodeAt(0)));
    if (xar.toc.status !== "verified" || xarRead.archived !== "verified" || xarRead.extracted !== "verified") {
      throw new Error("Packed XAR checksum scopes changed");
    }
  });
});
