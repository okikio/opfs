Validation strategy
===================

The repository keeps validation support under `.agents/` because the ChatGPT execution host does not provide every production runtime or registry dependency.

Production code remains Deno/browser/server-native. Validation shims do not enter the package exports or publish list.

What is validated here
----------------------

The validation matrix has separate TypeScript targets so one environment cannot accidentally provide globals for another.

```text
Window target
  core + browser OPFS + ecosystem structural adapters

WebWorker target
  core + browser OPFS worker declarations

Server target
  Node + Deno + Bun concrete adapters

Deno test source target
  repository tests with validation-only Deno.test declaration

Emit target
  ESM + declarations for public output inspection and behavior tests
```

Commands
--------

```sh
tsc -p .agents/tsconfig.window.json
tsc -p .agents/tsconfig.worker.json
tsc -p .agents/tsconfig.server.json
tsc -p .agents/tsconfig.tests.json

tsc -p .agents/tsconfig.emit.json
node .agents/scripts/prepare-node-runtime.mjs
node --test .agents/tests/adapters.test.mjs
```

Representative consumers are also type-checked:

```sh
tsc -p .agents/tsconfig.consumer.window.json
tsc -p .agents/tsconfig.consumer.worker.json
```

The npm payload is inspected without publishing:

```sh
npm pack --dry-run --json
```

`package.json#files` excludes `.agents/`, tests, and generated validation output from the npm package.

The browser matrix has its own build configuration:

```sh
tsc -p .agents/tsconfig.browser.emit.json
node .agents/scripts/prepare-browser-runtime.mjs
node .agents/browser/server.mjs
```

The browser server is validation-only. It is not package runtime infrastructure.

Behavioral coverage
-------------------

The Node-hosted adapter contract suite covers:

- runtime adapter capability/schema rejection;
- Web Locks request shape;
- path normalization and virtual-root escape rejection;
- replace, append, update, byte range, and stat semantics;
- OPFS-shaped file/directory handles over a non-OPFS backend;
- Blob versus File System write-command discrimination;
- staged writable close/abort semantics;
- bounded record-adapter stream buffering and producer cancellation;
- overwrite copy replacing stale trees;
- fallback move removing source only after successful copy;
- source/destination overlap protection;
- aborted queued write recovery;
- independent file write concurrency;
- structural operations waiting for active file mutation;
- post-open stream cancellation;
- unstorage high-level Storage bridge;
- reverse unstorage driver, reversible key encoding, and `foo` plus `foo:bar` prefix-collision handling;
- RxDB collection bridge;
- db0 SQLite, libSQL, PostgreSQL, and MySQL SQL branches;
- db0 SQLite DDL/upsert/select/delete execution against Node's real SQLite engine;
- Drizzle common CRUD bridge;
- real Node filesystem streaming, rename, sync random access, flush, and sync-lock lifetime;
- explicit adapter disposal ownership;
- non-throwing OPFS probe outside a browser OPFS context.

The repository also contains Deno-native tests for path handling and the memory adapter frontend contract. Their source is type-checked here even when the Deno executable is unavailable.

Dependency validation in this host
----------------------------------

Network package installation is unavailable in the current execution host. The validation configs map `zod` and the small `drizzle-orm` `eq()` dependency to `.agents/stubs/` only for local type/behavior execution.

These stubs are not production dependencies and are not published.

The purpose of the Zod stub is to exercise the package's schema calls and failure branches. The purpose of the Drizzle stub is to exercise the adapter's common CRUD builder translation with a fake connected database.

A release environment with registry access must run the same checks against the real dependency versions before publish.

Deno runtime status
-------------------

The current host does not have a Deno executable. Therefore the following production-native commands cannot be truthfully marked passed here:

```text
deno task check
deno task test
deno task fmt:check
deno task lint
deno publish --dry-run
```

The repository keeps these tasks in `deno.json` so a Deno-capable release environment can run them directly.

Bun runtime status
------------------

The current host does not provide Bun. The Bun adapter is strict-type-checked against its declared runtime shape and shares host-path/Node-compatible primitives with tested code, but a real Bun filesystem execution remains a release-environment check.

Browser runtime status
----------------------

Chromium is installed in this host, but its administrator policy rejects the local trustworthy origin used by the browser matrix with `net::ERR_BLOCKED_BY_ADMINISTRATOR` before the page can run. A synthetic intercepted HTTPS origin was also blocked before interception.

Therefore live Window/DedicatedWorker/SharedWorker/ServiceWorker/iframe OPFS execution is recorded as environment-blocked, not passed.

The harness remains in `.agents/browser/` so it can run in a normal Chromium/Firefox/Safari test environment.

Artifact verification
---------------------

Before a ZIP is delivered:

1. run every available type and behavior check against the working tree;
2. inspect generated ESM/declaration output;
3. inspect package exports and stale symbol references;
4. remove generated `.agents/build`, browser build, and validation `node_modules`;
5. create the ZIP;
6. extract that exact ZIP into a clean directory;
7. recreate only validation-side host shims;
8. rerun the same available checks against the extracted artifact;
9. compare source/extracted file lists and compute SHA-256.

A result is not called complete if the extracted deliverable fails a check that the source working tree passed.
