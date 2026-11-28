/** Project retained archive oracles into the disposable installed consumer. */
import { readFile } from "node:fs/promises";

/** Preserve producer selections and original JSON text where numeric lexemes are evidence. */
export async function archiveFixtures(): Promise<Record<string, unknown>> {
  return {
    "archive/cpio.json":
      JSON.parse(await readFile(new URL("../../fixtures/cpio/gnu.json", import.meta.url), "utf8")).crc,
    "archive/cab.json":
      JSON.parse(await readFile(new URL("../../fixtures/cab/independent.json", import.meta.url), "utf8")).stored,
    "archive/mszip.json": await (async () => {
      return JSON.parse(await readFile(new URL("../../fixtures/cab/mszip.json", import.meta.url), "utf8")).vectors
        .find((entry: Record<string, unknown>) => entry.name === "dynamic-history");
    })(),
    "archive/warc.json":
      JSON.parse(await readFile(new URL("../../fixtures/warc/independent.json", import.meta.url), "utf8")).archives[1],
    "archive/mime.json": JSON.parse(
      await readFile(new URL("../../fixtures/mime/independent.json", import.meta.url), "utf8"),
    ),
    "archive/seven.json":
      JSON.parse(await readFile(new URL("../../fixtures/seven/independent.json", import.meta.url), "utf8")).copy,
    "archive/compressedseven.json": await (async () => {
      const fixtures = JSON.parse(
        await readFile(new URL("../../fixtures/seven/independent.json", import.meta.url), "utf8"),
      );
      return [fixtures["encoded-lzma1"], fixtures.lzma2];
    })(),
    "archive/ar.json":
      JSON.parse(await readFile(new URL("../../fixtures/ar/independent.json", import.meta.url), "utf8")).gnu,
    "archive/mbox.json":
      JSON.parse(await readFile(new URL("../../fixtures/mbox/independent.json", import.meta.url), "utf8")).mboxrd,
    "archive/bagit.json": JSON.parse(
      await readFile(new URL("../../fixtures/bagit/independent.json", import.meta.url), "utf8"),
    ),
    "archive/password.json":
      JSON.parse(await readFile(new URL("../../fixtures/password/independent.json", import.meta.url), "utf8")).stored,
    "archive/ocfl.json":
      JSON.parse(await readFile(new URL("../../fixtures/ocfl/independent.json", import.meta.url), "utf8")).objects[0],
    "archive/aes.json": await (async () => {
      const fixtures = JSON.parse(
        await readFile(new URL("../../fixtures/aes/independent.json", import.meta.url), "utf8"),
      );
      return [fixtures["aes256-ae2"], fixtures.deflate, fixtures["deflate-ae1"]];
    })(),
    "archive/nativecodecs.json": JSON.parse(
      await readFile(new URL("../../fixtures/compression/native.json", import.meta.url), "utf8"),
    ),
    "archive/lz4.json":
      JSON.parse(await readFile(new URL("../../fixtures/lz4/independent.json", import.meta.url), "utf8"))
        .frames["no-checksum"],
    "archive/arc.json":
      JSON.parse(await readFile(new URL("../../fixtures/arc/independent.json", import.meta.url), "utf8")).objects[0],
    "archive/xz.json": JSON.parse(
      await readFile(new URL("../../fixtures/xz/independent.json", import.meta.url), "utf8"),
    ).cases.find((
      entry: Record<string, unknown>,
    ) => entry.name === "crc64-vector"),
    "archive/bzip.json": JSON.parse(
      await readFile(new URL("../../fixtures/bzip/independent.json", import.meta.url), "utf8"),
    ).fixtures.find(
      (entry: Record<string, unknown>) => entry.name === "binary",
    ),
    "archive/udf.json": await (async () => {
      const value = JSON.parse(
        await readFile(new URL("../../fixtures/udf/independent.json", import.meta.url), "utf8"),
      );
      const original = value.entries.find((entry: Record<string, unknown>) => entry.name === "large.bin");
      return {
        archive: value.adaptations.find((entry: Record<string, unknown>) => entry.name === "split-long").archive,
        body: original.body,
      };
    })(),
    "archive/iso.json": await (async () => {
      const fixture =
        JSON.parse(await readFile(new URL("../../fixtures/iso/independent.json", import.meta.url), "utf8"))
          .images["genisoimage-joliet"];
      return {
        archive: fixture.archive,
        body: fixture.profiles.joliet.find((entry: Record<string, unknown>) => entry.name === "/hello.txt").body,
      };
    })(),
    "archive/lzma.json": await (async () => {
      const fixture = JSON.parse(
        await readFile(new URL("../../fixtures/lzma/independent.json", import.meta.url), "utf8"),
      ).cases.find((entry: Record<string, unknown>) => entry.name === "lzma2-literal");
      return { packed: fixture.packed, body: fixture.body, dictionary: fixture.dictionary };
    })(),
    "archive/lha.json": await (async () => {
      const fixture = JSON.parse(
        await readFile(new URL("../../fixtures/lha/independent.json", import.meta.url), "utf8"),
      ).fixtures.find((row: Record<string, unknown>) => row.level === 2);
      return { wire: fixture.archive.base64, original: fixture.payloads["odd.bin"].base64 };
    })(),
    "archive/binhex.json": JSON.parse(
      await readFile(new URL("../../fixtures/binhex/independent.json", import.meta.url), "utf8"),
    ).fixtures
      .find((value: Record<string, unknown>) => value.case === "many" && value.producer === "macutils"),
    "archive/binhexperl.json": JSON.parse(
      await readFile(new URL("../../fixtures/binhex/independent.json", import.meta.url), "utf8"),
    ).fixtures
      .find((value: Record<string, unknown>) => value.case === "empty" && value.producer === "perl"),
    "archive/arj.json": await (async () => {
      const fixture = JSON.parse(
        await readFile(new URL("../../fixtures/arj/independent.json", import.meta.url), "utf8"),
      ).fixtures.find((row: Record<string, unknown>) => row.id === "stored");
      return { wire: fixture.archive.base64, original: fixture.payloads["many.bin"].base64 };
    })(),
    "archive/zipbzip.json": await (async () => {
      const fixture = JSON.parse(
        await readFile(new URL("../../fixtures/zip-bzip/independent.json", import.meta.url), "utf8"),
      ).fixtures.find((item: Record<string, unknown>) => item.name === "python-1");
      return {
        wire: fixture.archive.base64,
        member: fixture.members.find((item: Record<string, unknown>) => item.name === "odd.bin"),
      };
    })(),
    "archive/ziplzma.json": await (async () => {
      const fixture = JSON.parse(
        await readFile(new URL("../../fixtures/zip-lzma/independent.json", import.meta.url), "utf8"),
      ).fixtures.find((item: Record<string, unknown>) => item.name === "python");
      return {
        wire: fixture.archive.base64,
        member: fixture.members.find((item: Record<string, unknown>) => item.name === "odd.bin"),
      };
    })(),
    "archive/sparse.json": await (async () => {
      const fixture = JSON.parse(
        await readFile(new URL("../../fixtures/tar-sparse/independent.json", import.meta.url), "utf8"),
      );
      const native = fixture.fixtures.find((entry: Record<string, unknown>) => entry.profile === "1.0");
      return { archive: native.archive.base64, body: native.payloads["many.bin"].base64 };
    })(),
    "archive/lzx.json": await (async () => {
      const fixture = JSON.parse(
        await readFile(new URL("../../fixtures/wim/lzx-independent.json", import.meta.url), "utf8"),
      );
      const file = fixture.images[0].files.find((entry: Record<string, unknown>) => entry.path === "calls.bin");
      return { archive: fixture.base64, path: file.path, body: file.base64 };
    })(),
    "archive/rar.json": await (async () => {
      const fixture = JSON.parse(
        await readFile(new URL("../../fixtures/rar/independent.json", import.meta.url), "utf8"),
      );
      const native = fixture.fixtures.find((entry: Record<string, unknown>) => entry.profile === "stored");
      return { archive: native.archive.base64, body: native.payloads["hello.txt"].base64 };
    })(),
    "archive/xpress.json": await (async () => {
      const fixture = JSON.parse(
        await readFile(new URL("../../fixtures/wim/xpress-independent.json", import.meta.url), "utf8"),
      );
      const file = fixture.images[0].files.find((entry: Record<string, unknown>) => entry.path === "long.bin");
      return { archive: fixture.base64, path: file.path, body: file.base64 };
    })(),
    "archive/wim.json": await (async () => {
      const fixture = JSON.parse(
        await readFile(new URL("../../fixtures/wim/independent.json", import.meta.url), "utf8"),
      );
      return {
        archive: fixture.base64,
        body: fixture.images[0].files.find((entry: Record<string, unknown>) => entry.path === "hello.txt").base64,
      };
    })(),
    "archive/xar.json": await (async () => {
      const fixture = JSON.parse(
        await readFile(new URL("../../fixtures/xar/independent.json", import.meta.url), "utf8"),
      );
      return {
        archive:
          fixture.objects.find((entry: Record<string, unknown>) =>
            entry.compression === "gzip" && entry.algorithm === "sha1"
          ).base64,
        body: fixture.records.find((entry: Record<string, unknown>) => entry.path === "hello.txt").base64,
      };
    })(),
  };
}
