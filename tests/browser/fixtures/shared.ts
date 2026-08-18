/// <reference lib="webworker" />
import { openFileSystem, probeOpfs } from "../../../mod.ts";

/** SharedWorker global used to exercise storage shared by connected documents. */
declare const self: SharedWorkerGlobalScope;

/** Runs one OPFS request received through a SharedWorker message port. */
async function runSharedRequest(
  port: MessagePort,
  input: { readonly path: string; readonly value: string },
): Promise<void> {
  const probe = await probeOpfs();
  if (!probe.rootAvailable) {
    port.postMessage({ supported: true, probe });
    return;
  }

  const fileSystem = await openFileSystem();
  try {
    await fileSystem.writeFile(input.path, input.value, { parents: true });
    port.postMessage({ supported: true, probe, value: await fileSystem.readText(input.path) });
  } finally {
    await fileSystem.close();
  }
}

self.onconnect = (event: MessageEvent) => {
  const port = event.ports[0]!;
  port.onmessage = (message: MessageEvent<{ path: string; value: string }>) => {
    void runSharedRequest(port, message.data);
  };
  port.start();
};
