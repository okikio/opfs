/// <reference lib="webworker" />
import { openFileSystem, probeOpfs } from "../../../mod.ts";

/** ServiceWorker global used to verify OPFS without relying on Playwright-only worker instrumentation. */
declare const self: ServiceWorkerGlobalScope;

/** Runs one message-scoped OPFS request while the caller keeps the ServiceWorker event alive. */
async function runServiceRequest(
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

self.addEventListener("install", (event: ExtendableEvent) => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", (event: ExtendableEvent) => event.waitUntil(self.clients.claim()));
self.addEventListener("message", (event: ExtendableMessageEvent) => {
  const port = event.ports[0];
  if (port === undefined) return;
  event.waitUntil(runServiceRequest(port, event.data));
});
