# Node and npm compatibility

Use this reference when Deno runs an existing Node project, a reusable package
must support Node and Deno, or an npm dependency relies on Node resolution,
lifecycle scripts, native addons, globals, or filesystem layout.

## Principle

Compatibility is an evidence question, not a purity test.

Current Deno 2.x has first-class `package.json` and npm support and can run many
Node projects without converting them to Deno-specific imports. Keep the
existing dependency owner unless a migration has a concrete benefit.

## Compatibility-first sequence

1. inspect package.json, lockfile, scripts, module type, package exports, and
   node_modules expectations;
2. run the existing project with the repository's Deno configuration;
3. classify actual failures;
4. apply the smallest compatibility change;
5. rerun Node and Deno behavior if both are claimed;
6. only redesign package ownership when the current requirement needs it.

Do not rewrite a working npm package graph into `npm:` imports merely because
Deno supports them.

## Package resolution

Deno can consume npm packages declared in package.json or through `npm:` imports.
Some packages require a local `node_modules` tree, especially CommonJS packages
or tooling that reads package-relative files. Configure `nodeModulesDir` only
according to the repository and dependency requirements.

Verify:

- ESM/CJS mode and conditional exports;
- deep/private subpath imports;
- package-relative assets;
- symlink/workspace assumptions;
- lockfile consumption;
- postinstall/build-generated files.

## Lifecycle scripts and security

npm lifecycle scripts can execute arbitrary code. Deno's script policy and
workspace root settings are part of the security contract. Do not broadly allow
scripts to make one package install without inspecting what the script does and
which package needs permission.

CI should reproduce the same script policy as local installation.

## Native addons

Packages using node-gyp, N-API, prebuilt native binaries, or platform-specific
loaders require actual runtime testing. TypeScript compatibility is irrelevant if
the native binary cannot load under the target OS/architecture/Deno version.

Before promising support:

- inspect install script and binary package selection;
- identify platform/architecture support;
- run installation under Deno's actual package flow;
- load the addon;
- execute representative behavior;
- test clean install/CI, not only a developer's populated cache.

If the dependency remains incompatible, choose a supported alternative or keep a
Node-specific adapter/entrypoint. Do not invent a shim around native ABI behavior.

## Globals and process behavior

Audit packages that assume:

- `process`/`Buffer`/`__dirname`/`require`;
- Node event loop/signals;
- exact `process.cwd()` layout;
- writable `node_modules`;
- Node-specific streams/errors;
- subprocess executable names;
- package-manager environment variables.

Deno provides extensive Node compatibility, but behavior-sensitive assumptions
still need execution proof.

## Filesystem and path layout

A package that reads files relative to its published package root, uses native
module resolution, or expects generated assets can work from a workspace and
fail after packaging/compilation. Test the actual distributed form.

For reusable libraries, isolate runtime-specific file/process logic behind
explicit adapters/subpaths rather than scattering `if (Deno)`/`if (process)`
through domain logic.

## Runtime imports are not a portability repair

An explicit `node:process` import can satisfy a Deno lint preference while still
breaking a browser-shared import graph. Review static Node/builtin imports and
ambient Node/Deno globals together. Prefer an existing utility owner; isolate
necessary host access at the selected runtime adapter. A guarded lazy lookup
avoids an absent-global access but must preserve permissions and missing-runtime
behavior. `process.getBuiltinModule` is version/capability dependent; a dynamic
`import("node:fs")` may still be resolved by a bundler. Verify the distributed
entrypoint rather than assuming either spelling proves compatibility.

## One source across runtimes

When the goal is cross-runtime support, prefer one core TypeScript
implementation. Runtime-specific adapters can use Deno/Node APIs where needed.
Do not create independent Node and Deno algorithm implementations that will drift.

Type-check each runtime with the correct globals, then execute each claimed
runtime. Validation-only shims do not count as production compatibility.

## Failure classes

### Module resolution

Symptoms: package not found, wrong export condition, CommonJS loader errors,
private subpath imports.

### Lifecycle scripts

Symptoms: missing generated native/JS files, denied install script, undeclared
external tool.

### Native addons

Symptoms: binary load/ABI/platform error.

### Filesystem layout

Symptoms: missing package-relative asset, writable node_modules assumption,
symlink/workspace-only path.

### Globals/process behavior

Symptoms: runtime check, signal/exit difference, env/cwd assumptions.

### Semantic API difference

Symptoms: code loads but stream/error/timer/network behavior differs. Requires
behavior test, not import success.

## Migration decisions

Migrate a Node project toward Deno-native ownership only when the goal justifies
it, for example:

- replacing package-manager/task tooling deliberately;
- publishing a JSR-first library;
- using Deno permissions/runtime APIs as product requirements;
- removing a Node-only dependency;
- consolidating a mixed toolchain with proven benefits.

If replacement is requested, update all current consumers/tests/docs/CI and
remove obsolete compatibility paths unless an external contract requires them.

## Exit criteria

Compatibility is proven when clean install/resolution succeeds and representative
behavior executes in each claimed runtime. For native addons or packaged CLIs,
verify the actual installed artifact on the claimed platform. Do not report Node
compatibility or Deno compatibility from type checking alone.
