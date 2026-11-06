/// <reference lib="webworker" />
import { createFileSystem, probeOpfs } from "../../../mod.ts";
import { createOpfsAdapter } from "../../../src/adapter/opfs.ts";
import { withReleases } from "../../close.ts";
import { unavailable } from "../../upstream/capability.ts";
import { syncCases } from "../../upstream/wpt.ts";

/** OPFS sync access is probed in the DedicatedWorker that actually opens the handles. */
declare const self: DedicatedWorkerGlobalScope;

async function run(route: "native" | "facade") {
  const probe = await probeOpfs();
  const reason = unavailable(probe);
  if (reason !== undefined || !probe.syncAccessHandleExposed) {
    return { supported: false, reason: reason ?? JSON.stringify(probe) };
  }
  const names: string[] = [];
  await withReleases(async (releases) => {
    const origin = await navigator.storage.getDirectory();
    const namespace = `upstream-sync-${crypto.randomUUID()}`;
    const root = await origin.getDirectoryHandle(namespace, { create: true });
    releases.push(() => origin.removeEntry(namespace, { recursive: true }));
    const fileSystem = route === "facade" ? createFileSystem(createOpfsAdapter(root)) : undefined;
    if (fileSystem !== undefined) releases.push(() => fileSystem.close());
    for (const [index, test] of syncCases.entries()) {
      await withReleases(async (files) => {
        const name = `case-${index}.bin`;
        const native = await root.getFileHandle(name, { create: true });
        const file = fileSystem === undefined
          ? await native.createSyncAccessHandle()
          : await fileSystem.openSyncFile(`/${name}`);
        files.push(() => file.close());
        test.run({}, file);
        names.push(test.name);
      });
    }
  });
  return { supported: true, names };
}

self.onmessage = (event: MessageEvent<"native" | "facade">) => {
  void run(event.data).then(
    (result) => self.postMessage(result),
    (error) => self.postMessage({ supported: true, error: error instanceof Error ? error.stack : String(error) }),
  );
};
