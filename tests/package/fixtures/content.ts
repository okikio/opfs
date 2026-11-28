/** Project retained content oracles into the disposable installed consumer. */
import { readFile } from "node:fs/promises";

/** Preserve producer selections and original JSON text where numeric lexemes are evidence. */
export async function contentFixtures(): Promise<Record<string, unknown>> {
  return {
    "content/git.json": await (async () => {
      const manifest = JSON.parse(
        await readFile(new URL("../../fixtures/git/manifest.json", import.meta.url), "utf8"),
      );
      const record = manifest.objects.find((entry: Record<string, unknown>) =>
        entry.algorithm === "sha256" && entry.label === "blob"
      );
      return {
        oid: record.oid,
        loose: (await readFile(new URL("../../fixtures/git/" + record.loose, import.meta.url))).toString("base64"),
        payload: (await readFile(new URL("../../fixtures/git/" + record.payload, import.meta.url))).toString("base64"),
      };
    })(),
    "content/lfspointer.json": (await readFile(new URL("../../fixtures/lfs/hello.pointer", import.meta.url))).toString(
      "base64",
    ),
    "content/arweave.json": await (async () => {
      const fixture = JSON.parse(
        await readFile(new URL("../../fixtures/arweave/pss32.json", import.meta.url), "utf8"),
      );
      return fixture.rows[1];
    })(),
    "content/unixfs.json": await (async () => {
      const fixture = JSON.parse(
        await readFile(new URL("../../fixtures/unixfs/independent.json", import.meta.url), "utf8"),
      );
      const profile = fixture.profiles[0];
      return {
        cid: profile.cid,
        blocks: profile.blocks,
        file: profile.files.find((entry: Record<string, unknown>) => entry.path === "nested/data.bin"),
      };
    })(),
    "content/arfs.json": JSON.parse(
      await readFile(new URL("../../fixtures/arfs/independent.json", import.meta.url), "utf8"),
    ),
    "content/arfszip.json": JSON.parse(
      await readFile(new URL("../../fixtures/arfs/zip.json", import.meta.url), "utf8"),
    ),
    "content/hamt.json": await (async () => {
      const fixture = JSON.parse(
        await readFile(new URL("../../fixtures/unixfs/hamt/independent.json", import.meta.url), "utf8"),
      );
      return {
        rootCid: fixture.rootCid,
        blocks: fixture.blocks,
        file: fixture.files.find((entry: Record<string, unknown>) => entry.path === "file-000.txt"),
        names: fixture.listings[0].expectedNames,
      };
    })(),
  };
}
