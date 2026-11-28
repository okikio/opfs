/** Project retained provider oracles into the disposable installed consumer. */
import { readFile } from "node:fs/promises";

/** Preserve producer selections and original JSON text where numeric lexemes are evidence. */
export async function providerFixtures(): Promise<Record<string, unknown>> {
  return {
    "provider/cmis.json": await (async () => {
      const fixture = JSON.parse(
        await readFile(new URL("../../fixtures/cmis/independent.json", import.meta.url), "utf8"),
      );
      return {
        repositoryId: fixture.repositoryId,
        objectId: fixture.objectId,
        rootId: fixture.rootId,
        repository: fixture.repository.text,
        object: fixture.object.text,
        content: fixture.content.base64,
      };
    })(),
    "provider/couchdb.json": JSON.parse(
      await readFile(new URL("../../fixtures/couchdb/independent.json", import.meta.url), "utf8"),
    ),
    "provider/etcd.json": JSON.parse(
      await readFile(new URL("../../fixtures/etcd/independent.json", import.meta.url), "utf8"),
    ),
    "provider/upload.json": await (async () => {
      const fixture = JSON.parse(
        await readFile(new URL("../../fixtures/upload/independent.json", import.meta.url), "utf8"),
      );
      return { original: fixture.original, traces: [0, 3, 4, 5].map((index) => fixture.traces[index]) };
    })(),
  };
}
