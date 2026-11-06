import { createFileSystem, probeOpfs } from "../../../mod.ts";
import { createOpfsAdapter } from "../../../src/adapter/opfs.ts";
import { withReleases } from "../../close.ts";
import { unavailable } from "../../upstream/capability.ts";
import { directoryCases, runDirectoryCase } from "../../upstream/wpt.ts";

/** Both routes use the identical copied upstream callback and a private native namespace. */
async function directory(name: string, route: "native" | "facade") {
  const test = directoryCases.find((value) => value.name === name);
  if (test === undefined) throw new Error(`Unknown upstream case: ${name}`);
  const probe = await probeOpfs();
  const reason = unavailable(probe);
  if (reason !== undefined) return { supported: false, reason };
  await withReleases(async (releases) => {
    const origin = await navigator.storage.getDirectory();
    const namespace = `upstream-${crypto.randomUUID()}`;
    const root = await origin.getDirectoryHandle(namespace, { create: true });
    releases.push(() => origin.removeEntry(namespace, { recursive: true }));
    if (route === "native") {
      await runDirectoryCase(test, root);
    } else {
      const fileSystem = createFileSystem(createOpfsAdapter(root));
      releases.push(() => fileSystem.close());
      await runDirectoryCase(test, fileSystem.root);
    }
  });
  return { supported: true, name, route };
}

/** The worker owns file handles; the page always owns worker termination. */
async function sync(route: "native" | "facade") {
  const worker = new Worker(new URL("./upstream-worker.ts", import.meta.url), { type: "module" });
  try {
    return await new Promise<{ supported: boolean; reason?: string; names?: string[]; error?: string }>(
      (resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Upstream worker did not settle within its 20-second watchdog.")),
          20_000,
        );
        worker.onmessage = (event) => {
          clearTimeout(timer);
          resolve(event.data);
        };
        worker.onerror = (event) => {
          clearTimeout(timer);
          reject(new Error(event.message));
        };
        worker.postMessage(route);
      },
    );
  } finally {
    worker.terminate();
  }
}

/** Opt-in fixture global; no production or ambient Window API is installed. */
export const upstream = { directory, sync };
(globalThis as typeof globalThis & { upstreamTest: typeof upstream }).upstreamTest = upstream;
