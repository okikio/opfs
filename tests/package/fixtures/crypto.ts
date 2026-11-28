/** Project retained crypto oracles into the disposable installed consumer. */
import { readFile } from "node:fs/promises";

/** Preserve producer selections and original JSON text where numeric lexemes are evidence. */
export async function cryptoFixtures(): Promise<Record<string, unknown>> {
  return {
    "crypto/cryptomator.json": await (async () => {
      const fixture = JSON.parse(
        await readFile(new URL("../../fixtures/cryptomator/independent.json", import.meta.url), "utf8"),
      );
      const nested = fixture.fixtures.find((row: Record<string, unknown>) => row.id === "nested-zip");
      const named = fixture.fixtures.find((row: Record<string, unknown>) => row.id === "unicode");
      return {
        key: fixture.key,
        configuration: fixture.configuration,
        nested: { ciphertext: nested.ciphertext },
        named: { encryptedName: named.encryptedName, parent: named.parent, name: named.name },
      };
    })(),
    "crypto/jwe.json": JSON.parse(
      await readFile(new URL("../../fixtures/jwe/independent.json", import.meta.url), "utf8"),
    ),
    "crypto/jwezip.json": JSON.parse(await readFile(new URL("../../fixtures/arfs/zip.json", import.meta.url), "utf8")),
    "crypto/age.json": JSON.parse(
      await readFile(new URL("../../fixtures/age/independent.json", import.meta.url), "utf8"),
    ),
  };
}
