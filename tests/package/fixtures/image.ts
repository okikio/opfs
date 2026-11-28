/** Project retained image oracles into the disposable installed consumer. */
import { readFile } from "node:fs/promises";

/** Preserve producer selections and original JSON text where numeric lexemes are evidence. */
export async function imageFixtures(): Promise<Record<string, unknown>> {
  return {
    "image/qcow2.json": await readFile(new URL("../../fixtures/qcow2/independent.json", import.meta.url), "utf8"),
  };
}
