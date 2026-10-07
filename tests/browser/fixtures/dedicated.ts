/// <reference lib="webworker" />
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
    let syncBytes: number[] | undefined;
    let syncClosedCode: string | undefined;
    let syncReopened = false;
    if (probe.syncAccessHandleExposed) {
      try {
        const path = `/sync/${crypto.randomUUID()}.bin`;
        const file = await fileSystem.openSyncFile(path, { create: true, parents: true });
        try {
          file.writeAll(new Uint8Array([0, 1, 127, 255]), { at: 0 });
          file.writeAll(new Uint8Array([9]), { at: 1 });
          file.truncate(6);
          file.flush();
          const bytes = new Uint8Array(file.getSize());
          file.read(bytes, { at: 0 });
          syncBytes = Array.from(bytes);
        } finally {
          file.close();
        }
        file.close();
        try {
          file.getSize();
        } catch (error) {
          syncClosedCode = String(Reflect.get(Object(error), "code"));
        }
        const reopened = await fileSystem.openSyncFile(path);
        try {
          const bytes = new Uint8Array(reopened.getSize());
          reopened.read(bytes, { at: 0 });
          syncReopened = JSON.stringify(Array.from(bytes)) === JSON.stringify(syncBytes);
        } finally {
          reopened.close();
          await fileSystem.remove(path);
        }
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
      syncReopened,
      ...(syncBytes === undefined ? {} : { syncBytes }),
      ...(syncClosedCode === undefined ? {} : { syncClosedCode }),
      ...(syncError === undefined ? {} : { syncError }),
    });
  } finally {
    await fileSystem.close();
  }
}

self.onmessage = (event: MessageEvent<{ path: string; value: string }>) => {
  void runDedicatedRequest(event.data).catch((error) => self.postMessage({ error: String(error) }));
};
