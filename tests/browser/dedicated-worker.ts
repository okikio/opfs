/// <reference no-default-lib="true" />
/// <reference lib="esnext" />
/// <reference lib="webworker" />
import { openFileSystem, probeOpfs } from "../../mod.ts";

// Default type of `self` is `WorkerGlobalScope & typeof globalThis`
// https://github.com/microsoft/TypeScript/issues/14877
declare var self: DedicatedWorkerGlobalScope;

self.onmessage = async () => {
  try {
    const capabilities = await probeOpfs();
    const fs = await openFileSystem();
    const file = await fs.openSyncFile("/matrix/dedicated.bin", { create: true, parents: true });
    try {
      file.truncate(0);
      file.writeAll(new TextEncoder().encode("dedicated-worker"));
      file.flush();
    } finally {
      file.close();
    }
    self.postMessage({ ok: true, capabilities, text: await fs.readText("/matrix/dedicated.bin") });
  } catch (error) {
    const err = error as Error & { code?: string };
    const name = err?.name;
    const code = err?.code;
    const message = err?.message;
    self.postMessage({ ok: false, name, code, message });
  }
};
