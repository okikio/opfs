/** Prove every explicit subpath resolves physically inside the clean installed package. */
import specs from "../data/exports.json" with { type: "json" };
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
const consumer = await realpath(dirname(dirname(fileURLToPath(import.meta.url))));
const root = await realpath(join(consumer, "node_modules/@okikio/opfs"));
if (relative(consumer, root) !== join("node_modules", "@okikio", "opfs")) {
  throw new Error("Package root is outside the fresh installed consumer: " + root);
}
const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
let eagerCrypto = 0;
Object.defineProperty(globalThis, "crypto", {
  configurable: true,
  get() {
    eagerCrypto++;
    throw new Error("Packed import discovered ambient crypto");
  },
});
try {
  for (const spec of specs) {
    const path = await realpath(fileURLToPath(import.meta.resolve(spec)));
    const inside = relative(root, path);
    if (inside === ".." || inside.startsWith(".." + sep) || isAbsolute(inside)) {
      throw new Error(spec + " resolved outside the installed package: " + path);
    }
    await import(spec);
  }
  if (eagerCrypto !== 0) throw new Error("Packed public imports touched ambient crypto");
} finally {
  if (cryptoDescriptor) Object.defineProperty(globalThis, "crypto", cryptoDescriptor);
  else delete globalThis.crypto;
}
let internalAwsRejected = false;
try {
  await import("@okikio/opfs/aws");
} catch {
  internalAwsRejected = true;
}
if (!internalAwsRejected) throw new Error("Internal AWS signing escaped the public export map");
console.log("Imported " + specs.length + " physically installed packed public entrypoints");
