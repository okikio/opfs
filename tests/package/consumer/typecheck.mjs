/** Check installed declarations with the real compiler and attest their complete ambient graph. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const compiler = process.argv[4] ?? "typescript";
const manifestPath = fileURLToPath(import.meta.resolve(compiler + "/package.json"));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
assert.equal(manifest.version, compiler === "typescript" ? "7.0.2" : "5.9.3");
assert.equal(typeof manifest.bin?.tsc, "string", "Compiler must publish its real tsc binary");
const cli = resolve(dirname(manifestPath), manifest.bin.tsc);
const entry = process.argv[2];
const native = entry === "types/deno.ts";
const node = entry === "types/node.ts";
const discovery = process.argv[3] === "default";
writeFileSync(
  "tsconfig.artifact.json",
  JSON.stringify({
    compilerOptions: {
      target: "ESNext",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      lib: ["ESNext", "DOM", "DOM.Iterable"],
      ...(node ? { types: ["node"] } : discovery ? {} : { types: [] }),
      strict: true,
      noEmit: true,
      skipLibCheck: false,
    },
    files: [entry],
    // TypeScript owns portable fixture discovery; no hand-maintained source list.
    ...(entry === "types/portable.ts" ? { include: ["types/portable/**/*.ts"] } : {}),
  }),
);
// --listFiles retains semantic checking; --listFilesOnly would bypass it.
const result = spawnSync(process.execPath, [
  cli,
  "--project",
  "tsconfig.artifact.json",
  "--listFiles",
  "--pretty",
  "false",
], {
  encoding: "utf8",
  timeout: 60000,
  maxBuffer: 8 * 1024 * 1024,
});
if (result.error) throw result.error;
if (result.status !== 0) {
  console.error(result.stdout);
  console.error(result.stderr);
  throw new Error("Installed compiler rejected artifact declarations", {
    cause: { status: result.status, signal: result.signal },
  });
}
const sources = result.stdout.split(String.fromCharCode(10)).map((file) => file.trim())
  .filter((file) => file.endsWith(".ts")).map((file) => file.replaceAll(String.fromCharCode(92), "/"));
assert.ok(sources.length > 0, "Compiler must report its checked declaration graph");
const portableFixtures = sources.filter((file) => file.includes("/types/portable/"));
if (entry === "types/portable.ts") {
  assert.ok(portableFixtures.length > 0, "Native TypeScript discovery must include the portable contracts");
}
const deno = sources.some((file) => file.includes("/node_modules/deno-types/"));
assert.equal(deno, native, "Only the native Deno leaf may load its aliased namespace");
assert.equal(
  sources.some((file) => file.includes("/node_modules/@types/deno/")),
  false,
  "Build-only Deno declarations must not reach the installed consumer",
);
const nodeTypes = sources.some((file) => file.includes("/node_modules/@types/node/"));
if (node) assert.ok(nodeTypes, "The native Node leaf must use the actual selected Node host declarations");
if (entry === "types/portable.ts" && (!discovery || compiler === "typescript")) {
  assert.equal(nodeTypes, false, "Portable root requires no Node declarations");
}
console.log(
  JSON.stringify({
    entry,
    compiler: manifest.version,
    types: node ? ["node"] : discovery ? "default" : [],
    strict: true,
    skipLibCheck: false,
    deno,
    checkedFiles: sources.length,
    portableFixtures: portableFixtures.length,
    checker: "published tsc CLI --listFiles",
  }),
);
