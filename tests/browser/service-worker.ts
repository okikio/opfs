/// <reference no-default-lib="true" />
/// <reference lib="esnext" />
/// <reference lib="webworker" />
import { openFileSystem, probeOpfs } from "../../mod.ts";

// Default type of `self` is `WorkerGlobalScope & typeof globalThis`
// https://github.com/microsoft/TypeScript/issues/14877
declare var self: ServiceWorkerGlobalScope;

self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("message", (event) => {
  const work = (async () => {
    try {
      const capabilities = await probeOpfs();
      const fs = await openFileSystem();
      await fs.writeFile("/matrix/service.txt", "service-worker", { parents: true });
      event.source?.postMessage({ type: "service-worker-result", ok: true, capabilities, text: await fs.readText("/matrix/service.txt") });
    } catch (error) {
      const err = error as Error & { code?: string };
      const name = err?.name;
      const code = err?.code;
      const message = err?.message;
      event.source?.postMessage({ type: "service-worker-result", ok: false, name, code, message  });
    }
  })();
  event.waitUntil(work);
});
