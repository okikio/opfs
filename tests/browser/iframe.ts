import { openFileSystem, probeOpfs } from "../../mod.ts";

const label = new URL(location.href).searchParams.get("label") ?? "iframe";
try {
  const capabilities = await probeOpfs();
  const fs = await openFileSystem();
  const path = `/matrix/${label}.txt`;
  await fs.writeFile(path, label, { parents: true });
  parent.postMessage({ type: "iframe-result", label, ok: true, capabilities, text: await fs.readText(path) }, "*");
} catch (error) {
  parent.postMessage({ type: "iframe-result", label, ok: false, name: error?.name, code: error?.code, message: error?.message }, "*");
}