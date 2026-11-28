/** Guard ambient capabilities before any installed optional module can enter this fresh process. */
const capabilities = [
  "crypto/jwe",
  "nats",
  "kafka",
  "netlify",
  "dataset/parquet",
  "crypto/age",
  "crypto/age-node",
  "dataset/orc",
  "dataset/arrow",
  "dataset/bam",
  "amqp",
  "glacier",
];
const descriptors = new Map();
const touched = [];
try {
  for (const name of ["crypto", "fetch", "WebSocket"]) {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      get() {
        touched.push(name);
        throw new Error("Optional import discovered ambient capability: " + name);
      },
    });
  }
  for (const spec of capabilities) await import("@okikio/opfs/" + spec);
  if (touched.length) throw new Error("Optional import touched ambient capabilities: " + touched.join(","));
} finally {
  for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
}
console.log("Imported " + capabilities.length + " optional capabilities without ambient crypto, fetch or sockets");
