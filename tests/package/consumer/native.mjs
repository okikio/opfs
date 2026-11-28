/** Exercise the installed host adapter with an owned temporary root and reverse-order cleanup. */
import { finish } from "./finish.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createFileSystem } from "@okikio/opfs";

const failures = [], releases = [];
const runtime = typeof Bun !== "undefined" ? "bun" : typeof Deno !== "undefined" ? "deno" : "node";
try {
  const module = await import("@okikio/opfs/adapter/" + runtime);
  const root = await mkdtemp(fileURLToPath(new URL("./opfs-packed-native-", import.meta.url)));
  releases.push(() => rm(root, { recursive: true, force: true }));
  const adapter = module
    [runtime === "bun" ? "createBunAdapter" : runtime === "deno" ? "createDenoAdapter" : "createNodeAdapter"]({ root });
  const fs = createFileSystem(adapter, { coordination: "local" });
  releases.push(() => fs.close());
  await fs.writeFile("/data.txt", "0123456789");
  await fs.writeFile("/data.txt", "AB", { mode: "update", at: 3 });
  if (await fs.readText("/data.txt") !== "012AB56789") throw new Error(runtime + " update mismatch");
  await fs.copy("/data.txt", "/copy.txt");
  await fs.move("/copy.txt", "/moved.txt");
  if (await fs.readText("/moved.txt") !== "012AB56789") throw new Error(runtime + " move mismatch");
  if (await fs.exists("/copy.txt")) throw new Error(runtime + " move retained source");
} catch (reason) {
  failures.push(reason);
} finally {
  await finish(releases, failures);
}
console.log("Packed " + runtime + " native workflow passed");
