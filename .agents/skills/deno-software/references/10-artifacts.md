# Deno artifacts: scripts, CLIs, servers, bundles, binaries, and desktop apps

Use this reference when source is converted into an executable, package, bundle,
server deployment, or desktop artifact. The artifact has its own runtime and
resource contract.

## Start from the delivery form

| Form | Main proof |
|---|---|
| source script | direct Deno execution with declared permissions |
| installable CLI package | package/bin mapping plus clean installed subprocess |
| HTTP service | startup, request behavior, resource lifetime, shutdown |
| `deno bundle` output | bundled import/runtime behavior and asset assumptions |
| `deno compile` executable | clean machine execution, permissions/assets/subprocesses |
| `deno desktop` app | platform packaging, web/runtime bridge, native artifact behavior |
| npm/JSR library | exports, declarations/source, package contents, clean consumer |

Do not use one green source-tree test as proof for all forms.

## Scripts

A script should state or encode its required permissions and inputs. Avoid `-A`
for normal product execution when narrower permissions are practical. Development
scaffolding/tools may legitimately need broad access when the repository chooses
that risk.

If a script becomes a reusable/user-facing CLI, move stable parser/result/error
contracts into `build-clis` rather than growing ad hoc `Deno.args` parsing.

## CLIs

For a Deno CLI verify:

- source entrypoint;
- `deno install`/package/bin/compile strategy;
- help/version without project config;
- permission behavior;
- config/data/cache locations;
- completion/manual assets if claimed;
- stdout/stderr/exit status;
- signals and resource cleanup;
- clean installed/compiled execution.

## Servers

`Deno.serve` and framework adapters are runtime resources. Verify current version
behavior. Deno 2.9 changed automatic response compression to opt-in, so do not
assume older defaults.

Test:

- bind/listen configuration;
- readiness/health;
- request cancellation/timeouts;
- graceful shutdown/drain;
- long-lived connections/streams;
- log/resource disposal;
- deployment-specific environment/permissions.

## Bundles

Bundling can change dynamic imports, package-relative assets, tree shaking, and
runtime resolution. Inspect produced output and run it in the target environment.
Do not assume an import graph visible in source remains accessible after bundle.

## Compiled executables

Before compiling, identify:

- runtime permissions encoded/required;
- static/dynamic files and templates;
- external subprocesses;
- native addons;
- browser drivers/binaries;
- environment/config files;
- working-directory assumptions;
- network endpoints;
- target OS/architecture.

Then run the exact binary outside the source checkout. Verify error/cancellation
and not only `--help`.

## Desktop

Deno 2.9 introduced `deno desktop`. Treat desktop APIs, packaging, signing,
platform support, web/native bridge, updates, file access, and security as
version-sensitive. Verify current official docs and the repository's pinned Deno
before adopting it.

Do not present an experimental/new desktop path as established production support
without platform artifacts and user-flow tests.

## Containers/deployment

If a Deno service or CLI ships in a container:

- build from the same immutable revision;
- pin runtime/base image as required;
- include only needed files;
- define non-root/permissions/filesystem behavior;
- health/readiness for services;
- signals and graceful shutdown;
- environment/secrets ownership;
- reproduce package install/lockfile policy;
- test the container entrypoint itself.

## Artifact validation

For any delivered ZIP/package/binary/container metadata bundle:

1. build from the final working tree;
2. inspect file list and obvious secrets/caches;
3. compute hashes where useful;
4. extract/install into a clean location;
5. rerun the relevant checks against that exact artifact;
6. compare extracted/source files when the artifact is expected to preserve them.

A working tree that passes while the delivered ZIP fails is not complete.

## Failure signatures

| Symptom | Cause |
|---|---|
| source works, compiled binary misses command/template | dynamic source/asset not included |
| service behavior changes after Deno upgrade | version-sensitive runtime default |
| binary requires unexpected cwd | source-tree path assumption |
| container ignores SIGTERM | entrypoint/lifecycle not verified |
| package archive includes `.agents` or secrets | inclusion policy missing |
| desktop demo works only on dev OS | target artifact matrix untested |
| bundle imports wrong conditional export | bundled resolution differs from source |

## Completion gate

The artifact itself must execute in its claimed environment with the expected
permissions, assets, resource lifecycle, and user-facing behavior. Report any
platform/runtime artifact lane that could not be run.
