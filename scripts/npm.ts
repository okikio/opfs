import { build, emptyDir } from "@deno/dnt";
import { fromFileUrl, join, resolve } from "jsr:@std/path@1.1.6";

interface DenoConfigType {
  readonly exports: Readonly<Record<string, string>>;
}

interface PackageSourceType {
  readonly name: string;
  readonly description?: string;
  readonly license?: string;
  readonly repository?: string | { readonly type: string; readonly url: string; readonly directory?: string };
  readonly homepage?: string;
  readonly bugs?: string | { readonly url?: string; readonly email?: string };
  readonly keywords?: readonly string[];
  readonly engines?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
}

/** Reads one JSON object without leaking an inferred filesystem shape into the public package. */
async function readJson<Type>(path: string): Promise<Type> {
  return JSON.parse(await Deno.readTextFile(path)) as Type;
}

/** Converts one Deno export key into the export name expected by dnt. */
function exportName(key: string): string {
  return key === "." ? "." : key;
}

/** Fails when dnt emitted an npm dependency that still requires the JSR compatibility registry. */
async function assertNoJsrDependencies(path: string): Promise<void> {
  const manifest = await readJson<Record<string, unknown>>(path);
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"] as const) {
    const dependencies = manifest[field];
    if (typeof dependencies !== "object" || dependencies === null) continue;
    for (const name of Object.keys(dependencies)) {
      if (name.startsWith("@jsr/")) {
        throw new Error(`npm package leaked JSR compatibility dependency '${name}' through ${field}.`);
      }
    }
  }
}

const version = Deno.args[0];
if (version === undefined || version.length === 0) throw new TypeError("Pass the npm package version as the first argument.");
const output = resolve(Deno.args[1] ?? ".release/npm/package");
const root = resolve(fromFileUrl(new URL("..", import.meta.url)));
const denoConfig = await readJson<DenoConfigType>(join(root, "deno.json"));
const source = await readJson<PackageSourceType>(join(root, "package.json"));
const drizzle = source.peerDependencies?.["drizzle-orm"] ?? "^0.45.2";

await emptyDir(output);
await build({
  cwd: root,
  configFile: join(root, "deno.json"),
  entryPoints: Object.entries(denoConfig.exports).map(([name, path]) => ({
    name: exportName(name),
    path,
  })),
  outDir: output,
  scriptModule: false,
  declaration: "inline",
  declarationMap: false,
  typeCheck: "single",
  test: false,
  skipSourceOutput: true,
  shims: {
    deno: "dev",
  },
  mappings: {
    "@okikio/undent": {
      name: "@okikio/undent",
      version: "^0.3.3",
    },
    "drizzle-orm": {
      name: "drizzle-orm",
      version: drizzle,
      peerDependency: true,
    },
  },
  package: {
    name: source.name,
    version,
    ...(source.description === undefined ? {} : { description: source.description }),
    ...(source.license === undefined ? {} : { license: source.license }),
    ...(source.repository === undefined ? {} : { repository: source.repository }),
    ...(source.homepage === undefined ? {} : { homepage: source.homepage }),
    ...(source.bugs === undefined ? {} : { bugs: source.bugs }),
    ...(source.keywords === undefined ? {} : { keywords: [...source.keywords] }),
    sideEffects: false,
    ...(source.engines === undefined ? {} : { engines: { ...source.engines } }),
    peerDependencies: {
      "drizzle-orm": drizzle,
    },
    peerDependenciesMeta: {
      "drizzle-orm": { optional: true },
    },
  },
  async postBuild() {
    await Deno.copyFile(join(root, "README.md"), join(output, "README.md"));
    await Deno.copyFile(join(root, "LICENSE"), join(output, "LICENSE"));
    await assertNoJsrDependencies(join(output, "package.json"));
  },
});

const packageJson = join(output, "package.json");
await assertNoJsrDependencies(packageJson);
console.log(`Built npm package ${source.name}@${version} at ${output}`);
