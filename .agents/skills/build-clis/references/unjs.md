# Focused UnJS adapters for CLI applications

## Contents

- [Selection rule](#selection-rule)
- [Capability map](#capability-map)
- [Configuration cluster](#configuration-cluster)
- [Environment and path cluster](#environment-and-path-cluster)
- [HTTP and URL cluster](#http-and-url-cluster)
- [Storage, hashing, and hooks](#storage-hashing-and-hooks)
- [Package and build cluster](#package-and-build-cluster)
- [Documentation and release cluster](#documentation-and-release-cluster)
- [Alternative parser and reporter](#alternative-parser-and-reporter)
- [Integration sequences](#integration-sequences)
- [Testing and failure signatures](#testing-and-failure-signatures)
- [Sources and freshness](#sources-and-freshness)

## Selection rule

Treat UnJS as an ecosystem of focused packages, not a framework to install as a
bundle. Verify each package's current exports, runtime matrix, maintenance state,
and relationship to installed siblings. Assign one owner to every capability.

Use an UnJS package when it replaces application-specific host plumbing behind
a clear contract. Do not replace domain schemas, durability semantics, risk
policy, output contracts, or lifecycle ownership with an ecosystem brand.

After selecting a cluster, load the versioned implementation manual instead of
extrapolating from this map:

- [runtime and configuration packages](unjs-runtime-config.md);
- [fetch, state, hashing, and hooks](unjs-fetch-state.md);
- [build, release, content, and project operations](unjs-build-release.md).

The productionized CLI guidebook and its audit provide the capability map below.
The attached CLI proves c12, defu, jiti, and related transitive packages are
present; it does not prove every mapped package is installed or used.

## Capability map

| Package | Capability | Put behind | Important exclusion |
|---|---|---|---|
| c12 | Config discovery, layers, extends, environments, provenance, watch/update | `ConfigLoader` | Does not own domain defaults or trust policy |
| defu | Recursive default-style pair merging and custom merger | merge function | Default array behavior is not product policy |
| jiti | Runtime JavaScript/TypeScript module loading | config/module loader | Not a sandbox |
| rc9 | XDG-aware user RC read/write/update | `UserConfigStore` | Not project config discovery |
| std-env | CI/provider/debug/color/minimal-environment signals | `EnvironmentPolicy` | Does not replace per-stream TTY probes |
| pathe | Normalized cross-platform paths | `PathPolicy` | Does not define ownership/security |
| ofetch | Cross-runtime fetch, parsing, timeout, retry, interceptors | `HttpClient` | Does not decide idempotency or business retry policy |
| ufo | URL parsing, joining, normalization, query composition | URL composition helper | Do not use normalization that changes domain identity silently |
| unstorage | Async key-value API, drivers, mounts, metadata, watch/snapshot/hydration where supported | `CheckpointStore` or `Cache` | Key-value persistence alone is not durability semantics |
| ohash | Deterministic hashing over canonicalizable inputs | `Fingerprint` | A hash is not an idempotency/recovery protocol |
| hookable | Typed/application hook mechanism | extension adapter | Do not create a plugin system without lifecycle/error policy |
| magicast | Source-preserving JS/TS config edits | `ConfigEditor` | Requires consent, validation, and atomic write |
| confbox | JSONC/YAML/TOML and structured config handling | format adapter | Does not replace authored schema |
| pkg-types | Package discovery, metadata, exports, version | `PackageMetadata` | Does not choose release truth automatically |
| nypm | Package-manager detection, dependency/script operations | `ProjectTooling` | Does not own the CLI's installer or uninstall policy |
| unbuild | Library/package builds, declarations, externals, development stubs | build pipeline | Not a standalone executable compiler |
| changelogen | Changelog/release-note generation | release workflow | Generated notes require review and version policy |
| automd | Generated Markdown regions | documentation workflow | Do not broad-format human-authored Markdown |
| giget | Template/repository fetching used in some ecosystem flows | trusted fetch adapter | Remote source needs pinning/integrity/offline policy |
| Citty | Lightweight CLI parser/runner | parser adapter | Alternative to Optique, not another layer |
| Consola | Console logger/reporter | output adapter | Alternative to LogTape, not a second transport |

Confirm version-specific details from primary documentation or installed type
declarations. Several packages have much broader APIs than a CLI needs.

## Configuration cluster

Use c12, defu, and jiti together only through the application's config owner:

```text
c12 discovers layers
  -> jiti evaluates allowed JS/TS modules
  -> application validates authored exports
  -> defu-based explicit merger resolves layers
  -> application validates sparse patch
  -> runtime schema applies defaults
```

Use rc9 for a distinct user-level RC source. Do not make c12 and rc9 both read
and merge the same file. Record user RC below project and invocation sources
unless the product defines another order.

Use magicast or confbox for consentful editing:

- magicast when preserving JavaScript/TypeScript source structure matters;
- confbox for a supported structured format;
- c12 update/create hooks when their version and file type fit;
- authored schema validation after the edit regardless of writer.

Never silently edit a shell profile or unrelated configuration. Show the target
and diff, support dry run, write atomically, reload, and report the path.

## Environment and path cluster

Use std-env to detect broad host context such as CI provider, debug convention,
color support, or minimal runtime. Continue to probe stdin, stdout, and stderr
independently because one stream can be redirected while another is a TTY.

Combine std-env signals with explicit CLI policy:

```text
explicit --color/--no-color
  > NO_COLOR/FORCE_COLOR and product environment
  > stream-specific TTY capability
  > CI/provider convention
  > safe no-color fallback
```

Use pathe inside host adapters for normalized path operations. Keep path policy
explicit for:

- project-relative versus layer-relative paths;
- XDG config, data, cache, state, and log directories;
- Windows drive/UNC behavior;
- symlink and traversal checks;
- display path versus canonical filesystem identity.

Do not let string normalization authorize a path. Validate containment and
ownership after resolution.

## HTTP and URL cluster

Use ofetch behind a structural client contract:

```ts
export interface HttpClient {
	request<T>(options: {
		readonly url: URL;
		readonly method: string;
		readonly signal: AbortSignal;
		readonly timeoutMs: number;
		readonly idempotencyKey?: string;
	}): Promise<T>;
}
```

Configure timeouts for every request. Retry only methods/operations whose
semantics are safe. ofetch's defaults are an implementation detail; define
allowed methods, attempts, backoff, deadline, and retryable errors in schemas.
Propagate the root abort signal.

Use interceptors for correlation and structured LogTape events, not to hide
global mutable policy. Redact credentials and query parameters before logging.

Use ufo at URL fields where its parsing/composition helpers materially
reduce mistakes. Preserve URL identity rules for signing, cache keys, crawls,
and user-provided opaque URLs. A “cleaner” URL can be a different resource.

## Storage, hashing, and hooks

Use unstorage as an adapter for caches or checkpoints when its driver matrix
matches the runtime. Define schema and semantics above it:

```ts
export interface CheckpointStore<T> {
	read(key: string): Promise<T | undefined>;
	write(key: string, value: T): Promise<void>;
	remove(key: string): Promise<void>;
}
```

For recovery, also define:

- versioned checkpoint schema;
- committed versus attempted work;
- atomicity or compare-and-set requirements;
- lease ownership/expiry;
- idempotency and reconciliation;
- incompatible-request rejection;
- corruption and migration behavior.

In-memory and browser drivers do not provide cross-process durability. A remote
driver does not automatically provide transactions. Match driver guarantees to
the workflow claim.

Use ohash over normalized, schema-validated canonical data for plan/request
fingerprints. Include version and relevant input identities. Do not hash secrets
into public identifiers without analyzing leakage. Test key-order and runtime
stability for the exact version.

Use hookable only when extension points are a product requirement. Define:

- hook names and payload schemas;
- serial versus parallel execution;
- ordering and reentrancy;
- cancellation and timeout;
- exception aggregation;
- plugin trust and version compatibility;
- cleanup/unregistration.

Callbacks without these rules create hidden control flow and make recovery hard.

## Package and build cluster

Use pkg-types to inspect the manifest and export graph that actually owns the
package. Use it for version/build provenance only after deciding whether root,
workspace package, tag, or injected revision is authoritative.

Use nypm when a CLI operates on another project's dependencies or scripts:

```text
detect package manager from manifests and locks
  -> respect project choice and workspace root
  -> show planned operation
  -> invoke through injected subprocess and signal
  -> stream redacted diagnostics
  -> verify manifest/lock outcome
```

Do not install with npm in a pnpm/Yarn/Bun/Deno project merely because the CLI
itself runs on Node. Do not let nypm determine whether a dependency mutation was
authorized.

Use unbuild for distributable libraries/packages when declaration output,
externals, multiple entrypoints, and development stubs fit. Verify:

- clean public export map imports;
- type declarations and source maps;
- runtime dependencies versus externals;
- side effects and tree shaking;
- packed tarball contents;
- Deno/Node/browser conditions claimed.

Use `deno compile` or the chosen standalone pipeline when the product needs a
self-contained executable. Use Node SEA only with its current limitations and
target verification. unbuild does not replace either executable pipeline.

## Documentation and release cluster

Use changelogen to assist release notes, not define compatibility. Compare
command names, flags, environment variables, config keys, exit codes, output
schemas, persisted state, and installation behavior before classifying a change.

Use automd only for marked generated regions. Preserve human-authored wrapping,
tables, and code blocks outside those regions. The user's explicit Markdown
layout rule overrides broad formatter defaults.

When fetching templates or presets through giget or a similar adapter:

- pin a tag, commit, digest, or package version;
- define allowed hosts/protocols;
- respect proxies and offline mode;
- set timeouts and size limits;
- validate extracted paths and reject traversal;
- show overwritten files before applying;
- verify the generated project rather than trusting fetch success.

## Alternative parser and reporter

Citty can be the command owner when a lightweight grammar, nested/lazy commands,
aliases, generated usage, hooks, and plugins are sufficient. Choose it instead
of Optique after comparing requirements. Do not parse some subcommands with
Optique and others with Citty without an explicit stable contract.

Consola can be the output owner for applications that choose its reporter model.
Do not add it for spinners or friendly messages when LogTape already owns
transport. Build a LogTape formatter/sink or interaction renderer over the same
structured event instead.

## Integration sequences

### Project-aware install command

```text
Optique parses package and dry-run terms
  -> c12 loads project policy once
  -> pkg-types locates workspace/package metadata
  -> nypm detects the selected package manager
  -> command creates an operation plan
  -> LogTape transports plan/result and diagnostics
  -> authorized apply invokes package manager with root abort signal
  -> manifest and lockfile changes are verified
```

### Recoverable network import

```text
Optique parses semantic timeout and resume selection
  -> c12 resolves endpoint and cache policy
  -> ufo validates/composes URLs
  -> ofetch applies deadline, signal, and safe retry policy
  -> unstorage persists versioned committed checkpoints
  -> ohash binds checkpoint to normalized request/input identity
  -> LogTape records redacted progress and exact stable result
```

### Consentful config initialization

```text
Optique/Clack gathers missing non-secret values only on a TTY
  -> c12 selects the owned config target
  -> magicast or confbox builds a source-preserving edit
  -> dry-run result shows the diff
  -> atomic writer applies authorized change
  -> c12 reloads the file
  -> authored and runtime schemas validate it
```

## Testing and failure signatures

Use real integration fixtures for package-manager locks, config formats, fetch
failures, storage drivers, and packed artifacts. Mocking every package at the
adapter API can prove domain isolation but not ecosystem compatibility.

| Signature | Likely ownership error | Verification |
|---|---|---|
| Two different config values by command | c12/rc9/Optique env overlap | Trace one source algebra and winners |
| CI receives color or prompt | std-env signal replaced explicit per-stream policy | Run with redirected streams and CI env |
| POST executes twice | ofetch retries without domain idempotency policy | Capture request attempts and method rules |
| Resume accepts different inputs | ohash fingerprint omits normalized identity/version | Mutate one material field and assert rejection |
| “Durable” run disappears after restart | unstorage driver is memory/local-only | Kill process and resume from claimed checkpoint |
| Generated config loses comments | structured serializer used on TS/JSONC source | Compare source-preserving edit and diff |
| Wrong package manager changes lockfile | nypm detection/workspace root unchecked | Exercise npm/pnpm/Yarn/Bun/Deno fixtures |
| Package works in repo but not consumer | unbuild/pkg-types export or packed-file drift | Install packed tarball in a clean project |
| Static binary lacks commands/templates | dynamic graph invisible to compiler | Run every installed command from artifact |
| Markdown diff rewrites guidebook | automd/formatter touched unowned regions | Restrict generation markers and inspect diff |
| Logs split between two policies | Consola added beside LogTape | Search output imports and test exact routes |
| Unknown command changes meaning later | catch-all/lazy parser accepts abbreviations | Test explicit command registry and aliases |

## Sources and freshness

- Normative ecosystem audit: `cli-guidelines-audit-and-expansion(1).md`, reviewed 2026-07-17.
- Normative architecture: `productionized-cli-pattern-guidebook-v1.1(1).md`, reviewed 2026-07-17.
- Observed dependency graph: `live-browser-cli(41).zip/deno.lock` and package manifests, reviewed 2026-07-17.
- Official ecosystem index: <https://unjs.io/>, discovery pointer for maintained projects and current package documentation.
- Official organization source: <https://github.com/unjs>, discovery pointer for individual package repositories and release histories.

Freshness status: the capability assignments are grounded in the attached
guidebooks. They are not proof that every package is installed, supports every
runtime, or retains the same API. Verify the selected package's official docs,
exports, version, driver guarantees, and maintenance status before adoption.
