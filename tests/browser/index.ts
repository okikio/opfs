import { openFileSystem, probeOpfs } from "../../mod.ts";

const results = {};
const output = document.querySelector("#output");
const record = (name, value) => {
  results[name] = value;
  output.textContent = JSON.stringify(results, null, 2);
};

async function windowCase() {
  try {
    const capabilities = await probeOpfs();
    const fs = await openFileSystem();
    await fs.writeFile("/matrix/window.txt", "window", { parents: true });
    return { ok: true, capabilities, text: await fs.readText("/matrix/window.txt") };
  } catch (error) {
    const err = error as Error & { code?: string };
    const name = err?.name;
    const code = err?.code;
    const message = err?.message;
    return { ok: false, name, code, message: error?.message };
  }
}

function workerCase() {
  return new Promise((resolve) => {
    const worker = new Worker("./dedicated-worker.mjs", { type: "module" });
    worker.onmessage = (event) => { worker.terminate(); resolve(event.data); };
    worker.onerror = (event) => { worker.terminate(); resolve({ ok: false, message: event.message }); };
    worker.postMessage("run");
  });
}

function sharedWorkerCase() {
  return new Promise((resolve) => {
    if (typeof SharedWorker !== "function") return resolve({ ok: false, unavailable: true });
    const worker = new SharedWorker("./shared-worker.mjs", { type: "module", name: "opfs-matrix" });
    worker.port.onmessage = (event) => resolve(event.data);
    worker.port.start();
    worker.port.postMessage("run");
  });
}

async function serviceWorkerCase() {
  if (!("serviceWorker" in navigator)) return { ok: false, unavailable: true };
  try {
    const registration = await navigator.serviceWorker.register("./service-worker.mjs", { type: "module", scope: "./" });
    await navigator.serviceWorker.ready;
    const active = registration.active ?? registration.waiting ?? registration.installing;
    if (!active) return { ok: false, message: "No service worker instance" };
    return await new Promise((resolve) => {
      const timeout = setTimeout(() => resolve({ ok: false, message: "Service worker result timed out" }), 5000);
      const listener = (event) => {
        if (event.data?.type !== "service-worker-result") return;
        clearTimeout(timeout);
        navigator.serviceWorker.removeEventListener("message", listener);
        resolve(event.data);
      };
      navigator.serviceWorker.addEventListener("message", listener);
      active.postMessage("run");
    });
  } catch (error) {
    return { ok: false, name: error?.name, message: error?.message };
  }
}

function iframeCase({ url, label, sandbox }) {
  return new Promise((resolve) => {
    const iframe = document.createElement("iframe");
    iframe.hidden = true;
    iframe.src = `${url}?label=${encodeURIComponent(label)}`;
    if (sandbox) iframe.sandbox = sandbox;
    const timeout = setTimeout(() => {
      window.removeEventListener("message", listener);
      iframe.remove();
      resolve({ ok: false, message: "iframe result timed out" });
    }, 5000);
    const listener = (event) => {
      if (event.data?.type !== "iframe-result" || event.data.label !== label) return;
      clearTimeout(timeout);
      window.removeEventListener("message", listener);
      iframe.remove();
      resolve(event.data);
    };
    window.addEventListener("message", listener);
    document.body.append(iframe);
  });
}

record("window", await windowCase());
record("dedicatedWorker", await workerCase());
record("sharedWorker", await sharedWorkerCase());
record("serviceWorker", await serviceWorkerCase());
record("sameOriginIframe", await iframeCase({ url: "./iframe.html", label: "same-origin" }));
record("opaqueSandboxIframe", await iframeCase({ url: "./iframe.html", label: "opaque-sandbox", sandbox: "allow-scripts" }));
record("crossOriginIframe", await iframeCase({ url: `http://127.0.0.1:${location.port}/.agents/browser/iframe.html`, label: "cross-origin" }));

window.__OPFS_RESULTS__ = results;
document.title = Object.values(results).every((result) => result && typeof result === "object") ? "OPFS matrix complete" : "OPFS matrix incomplete";