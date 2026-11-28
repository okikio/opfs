/** Inspect the extracted archive before a clean consumer executes it. */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Lists every regular file below one extracted package directory. */
async function walk(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else files.push(path);
  }
  return files;
}

/** Admit the packed metadata, public targets and declaration/runtime separation. */
export async function inspectArtifact(packageRoot: string) {
  const manifest: {
    name?: string;
    exports?: Record<string, string | Record<string, string>>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  } = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  );

  const readme = await readFile(join(packageRoot, "README.md"), "utf8");
  await readFile(join(packageRoot, "LICENSE"), "utf8");
  await readFile(join(packageRoot, "CHANGELOG.md"), "utf8");
  // A reader must be able to follow the local documentation links in the installed package.
  for (
    const match of readme.matchAll(/\]\((?:\.\/)?(docs\/[^)#]+)(?:#[^)]*)?\)/gu)
  ) {
    const path = match[1];
    if (path === undefined) throw new Error("Documentation link has no captured package path.");
    await readFile(join(packageRoot, path), "utf8");
  }

  if (manifest.name !== "@okikio/opfs") {
    throw new Error(`Unexpected npm package name: ${manifest.name}`);
  }
  // The reviewed export record (`mise run build:exports`) is the one list of public subpaths. The packed
  // manifest must expose exactly those, so a subpath cannot be added or dropped by packaging alone.
  const recorded: Record<string, readonly string[]> = JSON.parse(
    await readFile(fileURLToPath(new URL("./exports.json", import.meta.url)), "utf8"),
  );
  const packed = Object.keys(manifest.exports ?? {}).filter((path) => path !== "./package.json").sort();
  const expected = Object.keys(recorded).sort();
  const missing = expected.filter((path) => !packed.includes(path));
  const extra = packed.filter((path) => !expected.includes(path));
  if (missing.length || extra.length) {
    throw new Error(
      `Packed subpaths differ from tests/package/exports.json. Missing: ${missing.join(", ") || "none"}. Extra: ${
        extra.join(", ") || "none"
      }.`,
    );
  }
  // Internal AWS signing is never public, whatever the record says.
  if ("./aws" in (manifest.exports ?? {})) throw new Error("Internal AWS signing must not be a public subpath.");
  if (manifest.dependencies?.["drizzle-orm"]) {
    throw new Error("drizzle-orm must not be a normal npm dependency.");
  }
  if (!manifest.peerDependencies?.["drizzle-orm"]) {
    throw new Error("drizzle-orm optional peer is missing.");
  }
  if (manifest.peerDependenciesMeta?.["drizzle-orm"]?.optional !== true) {
    throw new Error("drizzle-orm must be marked as an optional peer.");
  }
  if (!manifest.dependencies?.zod) {
    throw new Error("zod runtime dependency is missing.");
  }
  if (manifest.dependencies?.["deno-types"] !== "npm:@types/deno@2.7.0") {
    throw new Error(
      "The native Deno leaf requires its reviewed published declaration dependency.",
    );
  }
  for (
    const field of ["dependencies", "peerDependencies", "optionalDependencies"] as const
  ) {
    if (manifest[field]?.["@types/deno"]) {
      throw new Error(
        "Native Deno declarations must not enter automatic portable ambient discovery.",
      );
    }
    if (manifest[field]?.["@deno/shim-deno"]) {
      throw new Error(
        "Native Deno APIs must not become an installed runtime shim.",
      );
    }
  }

  for (
    const field of ["dependencies", "peerDependencies", "optionalDependencies"] as const
  ) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (name.startsWith("@jsr/")) {
        throw new Error(
          `npm tarball leaked JSR compatibility dependency '${name}' through ${field}.`,
        );
      }
    }
  }

  for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
    const entry: Record<string, string> = typeof target === "string" ? { default: target } : target;
    for (const field of ["types", "import", "default"]) {
      const path = entry?.[field];
      if (path === undefined) continue;
      if (field === "types" && !path.endsWith(".d.ts")) {
        throw new Error(`${subpath} types do not point to .d.ts: ${path}`);
      }
      if (field !== "types" && !path.endsWith(".js")) {
        throw new Error(`${subpath} runtime does not point to .js: ${path}`);
      }
      await stat(join(packageRoot, path));
    }
  }

  const publishedFiles = await walk(packageRoot);
  const rawTs = publishedFiles.filter((path) => path.endsWith(".ts") && !path.endsWith(".d.ts"));
  if (rawTs.length > 0) {
    throw new Error(`npm tarball contains raw TypeScript: ${rawTs.join(", ")}`);
  }
  for (const path of publishedFiles.filter((path) => path.endsWith(".js"))) {
    if ((await readFile(path, "utf8")).includes("@deno/shim-deno")) {
      throw new Error(
        `Published JavaScript contains a Deno runtime shim: ${path}`,
      );
    }
  }
  const nativeExport = manifest.exports?.["./driver/deno"];
  const nativeEntry = nativeExport !== null && typeof nativeExport === "object" ? nativeExport.import : undefined;
  if (typeof nativeEntry !== "string" || !nativeEntry.endsWith(".js")) {
    throw new Error("The packed native Deno ESM entrypoint is missing.");
  }
  const nativeDeclaration = await readFile(
    join(packageRoot, nativeEntry.replace(/\.js$/u, ".d.ts")),
    "utf8",
  );
  if (!nativeDeclaration.startsWith('/// <reference types="deno-types" />\n')) {
    throw new Error(
      "The native Deno type directive must precede every import and declaration.",
    );
  }

  return { manifest, expected };
}
