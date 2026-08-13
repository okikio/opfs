/// <reference no-default-lib="true" />
/// <reference lib="esnext" />
/// <reference lib="webworker" />
import { openFileSystem, probeOpfs } from "../../mod.ts";

// Default type of `self` is `WorkerGlobalScope & typeof globalThis`
// https://github.com/microsoft/TypeScript/issues/14877
declare var self: SharedWorkerGlobalScope;

self.onconnect = (event) => {
  const port = event.ports[0];
  port.onmessage = async () => {
    try {
      const capabilities = await probeOpfs();
      const fs = await openFileSystem();
      await fs.writeFile("/matrix/shared.txt", "shared-worker", { parents: true });
      port.postMessage({ ok: true, capabilities, text: await fs.readText("/matrix/shared.txt") });
    } catch (error) {
      const err = error as Error & { code?: string };
      const name = err?.name;
      const code = err?.code;
      const message = err?.message;
      port.postMessage({ ok: false, name, code, message });
    }
  };
  port.start();
};