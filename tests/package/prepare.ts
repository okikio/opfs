/** Copy authored consumer programs and project admitted oracle values beside them. */
import { cp, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { archiveFixtures } from "./fixtures/archive.ts";
import { contentFixtures } from "./fixtures/content.ts";
import { providerFixtures } from "./fixtures/provider.ts";
import { cryptoFixtures } from "./fixtures/crypto.ts";
import { datasetFixtures } from "./fixtures/dataset.ts";
import { imageFixtures } from "./fixtures/image.ts";
import { messagingFixtures } from "./fixtures/messaging.ts";

/**
 * Populate one task-owned temporary install. Library imports remain package imports.
 * JSON modules carry exact projected data; programs never contain interpolated source.
 * The caller owns removal of the complete consumer directory after every gate.
 */
export async function prepareConsumer(consumer: string): Promise<void> {
  await cp(new URL("./consumer/", import.meta.url), consumer, { recursive: true });
  // Bun's explicit age cipher oracle is test tooling and must never enter the package.
  await cp(new URL("../fixtures/age/provider.ts", import.meta.url), join(consumer, "age-provider.ts"));
  await cp(new URL("../fixtures/age/oracle.ts", import.meta.url), join(consumer, "age-oracle.ts"));
  await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }, null, 2) + "\n");
  // Process one domain at a time so unrelated large corpora can be released after writing.
  for (
    const project of [
      archiveFixtures,
      contentFixtures,
      providerFixtures,
      cryptoFixtures,
      datasetFixtures,
      imageFixtures,
      messagingFixtures,
    ]
  ) {
    for (const [name, value] of Object.entries(await project())) {
      const target = join(consumer, "data", name);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, JSON.stringify(value));
    }
  }
}
