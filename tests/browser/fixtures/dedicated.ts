import { openFileSystem, probeOpfs } from "../../../mod.ts";

/** DedicatedWorker global used to exercise worker-only OPFS capabilities. */
declare const self: DedicatedWorkerGlobalScope;

/**
 * Runs one OPFS request in the DedicatedWorker realm.
 *
 * The fixture probes synchronous-access exposure in the same realm because
 * capability exposure is more trustworthy than inferring support from a
 * browser name.
 */
async function runDedicatedRequest(input: { readonly path: string; readonly value: string }): Promise<void> {
  const probe = await probeOpfs();
  if (!probe.rootAvailable) {
    self.postMessage({ supported: true, probe });
    return;
  }

  const fileSystem = await openFileSystem();
  try {
    await fileSystem.writeFile(input.path, input.value, { parents: true });
    let syncOpened = false;
    let syncError: string | undefined;
    if (probe.syncAccessHandleExposed) {
      try {
        const file = await fileSystem.openSyncFile(`/sync/${crypto.randomUUID()}.bin`, { create: true, parents: true });
        file.close();
        syncOpened = true;
      } catch (error) {
        syncError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      }
    }

    self.postMessage({
      supported: true,
      probe,
      value: await fileSystem.readText(input.path),
      syncOpened,
      ...(syncError === undefined ? {} : { syncError }),
    });
  } finally {
    await fileSystem.close();
  }
}

self.onmessage = (event: MessageEvent<{ path: string; value: string }>) => {
  void runDedicatedRequest(event.data);
};
