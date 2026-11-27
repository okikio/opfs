# Deno foundations

Use this reference for any substantive Deno repository task. It defines the
baseline mental model before version-specific or package-specific details are
loaded.

## Deno is a runtime and project toolchain

Deno can own several different concerns:

```text
runtime / Web APIs / Deno.* APIs
TypeScript and module execution
package installation and resolution
workspace configuration
formatter / linter / type checking
test / bench
tasks
permissions and security
bundle / compile / desktop artifacts
JSR publication
Node/npm compatibility
```

Do not assume every Deno repository delegates all of these to Deno. A hybrid
project can intentionally use package.json, pnpm, Vite, Oxc, Mise, Playwright,
or another established owner. Inspect the repository before “simplifying” it.

## Current baseline

The repository skill baseline is Deno 2.x through 2.9. Deno 2.9 was released
2026-06-25. Version-specific behavior must still be verified against the
repository's pinned/runtime version and current official documentation.

Important 2.9-era facts include stronger Node/package-manager migration,
workspace/catalog behavior, newer test-runner features, Node.js 26 compatibility,
and changed `Deno.serve` automatic-compression behavior. Do not apply current
behavior to an older pinned Deno without checking.

## Classify the project mode first

### Deno-native

Usually:

- `deno.json(c)` owns package/tooling configuration;
- dependencies use Deno imports/JSR/npm according to project policy;
- Deno tasks/check/test/fmt/lint are primary;
- package publication may target JSR.

### package.json-first

Deno runs an existing Node/npm project without migrating its dependency owner.
`package.json` dependencies/scripts remain valid inputs. Add `deno.json` only
for Deno-specific tooling/configuration that is actually needed.

### hybrid

Both files intentionally exist. Decide field ownership instead of mirroring all
configuration into both.

Current Deno docs explicitly treat `package.json` and `deno.json` as first-class,
optional configuration sources. A hybrid repository is not inherently a
migration failure.

## Runtime API selection

Prefer stable Web APIs when they express the contract and improve runtime
portability. In shared code, direct Node/Deno globals and static builtin imports
are portability smells even when Deno accepts them. Inspect existing local
`utils/` or focused env/file/process utilities before duplicating host access.
Use `Deno.*` at a deliberate Deno adapter/root when it owns a capability or
provides stronger semantics the repository wants. Test-runner imports remain
tooling, not a reason to put Node runtime imports into portable production code.

Examples:

- `fetch`, `Request`, `Response`, streams, `URL`, `AbortSignal` are portable Web
  APIs;
- Deno filesystem, permissions, KV, serve, subprocess, compile, and project
  tooling are appropriate when the Deno contract is intentional.

Do not add Node compatibility APIs merely because an agent host happens to lack
Deno. Validation shims belong in disposable validation infrastructure, not in
production source.

## TypeScript

Deno runs TypeScript directly, but the repository still has a type contract.
Follow repository-local strictness and explicit-file-extension rules. For
cross-runtime libraries:

- keep one core TypeScript source where practical;
- isolate runtime-specific adapters behind explicit modules/subpaths;
- type-check each claimed environment with the right globals;
- do not let a broad tsconfig accidentally provide browser and server globals to
  the same source;
- test public generic inference with compile fixtures when inference is part of
  the API.

For project data with Zod as owner, use `*Schema` plus schema-derived `*Type` and
put important field documentation on the schema fields. Standard Schema remains
an interoperability protocol, not the project's validator implementation.

## Side effects and entrypoints

A reusable Deno package should normally be import-safe. Importing it should not:

- read environment variables unless that module explicitly represents env
  discovery;
- install process signal handlers;
- configure LogTape globally;
- start a server/worker/subprocess;
- connect to databases/providers;
- mutate process-global registries.

Application/CLI entrypoints own composition and host side effects.

## Cancellation and cleanup

Use `AbortSignal` for cooperative cancellation and explicit resource management
for cleanup. They are separate contracts.

Prefer `using`/`await using`, `Disposable`, `AsyncDisposable`, and disposal
stacks when they improve ownership and the target runtime supports them.
Injected resources are borrowed by default unless ownership transfer is explicit.
Partial construction must unwind already-acquired resources; cleanup failure must
not erase the primary failure.

## Errors

Use errors/typed results according to the local public contract. Keep stable
machine-readable failures at API/CLI entrypoints and preserve original causes for
diagnostics. Do not expose raw provider/database errors to users merely because
Deno includes stack traces.

## Configuration

Do not duplicate every option in `deno.json`, `package.json`, Mise, and CI.
Determine one owner per concern:

- package dependencies and scripts;
- Deno imports/scopes;
- tasks;
- workspace membership;
- formatter/linter/compiler/test settings;
- publish metadata;
- permissions;
- build/package output.

Some Deno workspace options are root-only. Verify exact current rules before
moving them to members.

## Minimum runtime

Set the minimum Deno version from features actually used and project support
policy. Do not set it to “latest” without reason. If the package uses a 2.9-only
feature, encode/document that requirement and test it in CI.

## Failure signatures

| Symptom | Likely mistake |
|---|---|
| Node project rewritten to Deno imports for no benefit | project mode not classified |
| browser globals compile in server code | type environments mixed |
| library import configures logging/env | application composition leaked into package |
| agent adds Node shim to production | validation-host limitation mistaken for runtime need |
| resource closes caller's database | ownership transfer not explicit |
| task config duplicated in several systems | owner not chosen |
| current Deno API used against older pin | version line ignored |

## Verification

For substantive work, prove the repository mode and run the actual owning gates:

- configured formatter/linter/type checks;
- package/runtime tests;
- claimed cross-runtime lanes;
- build/bundle/compile/package checks when changed;
- public/import-safe behavior for libraries;
- artifact inspection and clean consumer where published.

Use the current official Deno docs for any command, config field, stability,
workspace, permission, compile, desktop, or compatibility behavior that could
have changed.
