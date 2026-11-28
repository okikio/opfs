# Verify the installed package

The package gate answers a consumer's question: does the published archive expose the same usable contracts as the
source? It builds an npm tarball, installs that tarball in a temporary directory, and runs real consumers against that
install. Library imports in these fixtures use `@okikio/opfs` and its public subpaths.

Run the complete gate from the repository root:

```sh
mise run check:package
```

To inspect an already built archive, pass its exact path to the same verifier:

```sh
node tests/package/verify.ts .tmp/npm/okikio-opfs-0.0.0-test.tgz
```

Use the filename reported by the build. The verifier requires Node, Deno and Bun. The package type checks use the actual
published compiler CLIs and belong in the serial, memory-budgeted runner described by the source checkout's `AGENTS.md`
and the [validation guide](validation.md). Source-only instructions and test programs are repository files; the
published package includes this guide.

## Follow each verification owner

| Path                                                                    | Contract                                                                                                                                        |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `verify.ts`                                                             | Orders archive admission, clean installation and each independent verification gate. Owns the temporary workspace.                              |
| `artifact.ts`                                                           | Checks package identity, explicit exports, target files, local documentation links, dependency ownership and native Deno declaration placement. |
| `process.ts`                                                            | Uses the existing child-process owner, including unsuccessful exits and its operational watchdog.                                               |
| `prepare.ts`                                                            | Copies authored consumer files and the existing age oracle, then writes projected fixture data.                                                 |
| `fixtures/{archive,content,crypto,dataset,image,messaging,provider}.ts` | Selects the existing independent producer bytes and expected values. Arrow and BAM retain their exact corpus extent and SHA-256 admission.      |
| `exports.json`                                                          | Records the reviewed public subpaths and symbols. `build:exports` owns changes to this record.                                                  |
| `consumer/runtime/`                                                     | Native `.test.mjs` scenarios grouped by archive, content, crypto, dataset, filesystem, image, messaging and provider responsibility.            |
| `consumer/bytes.mjs`                                                    | Deterministic read-only inputs and exact byte comparisons, independent of candidate codecs.                                                     |
| `consumer/finish.mjs`                                                   | Reverse-order release that preserves the primary failure and all cleanup failures.                                                              |
| `consumer/native.mjs`                                                   | Actual host filesystem operations through the installed Node, Deno and Bun adapters.                                                            |
| `consumer/types/root.ts`                                                | The Deno compiler's clean consumer of the portable root.                                                                                        |
| `consumer/types/portable.ts` and `consumer/types/portable/`             | Portable declaration contracts in one complete compiler graph, including negative ambient and API assertions.                                   |
| `consumer/types/{node,deno}.ts`                                         | Separate native host declaration contracts.                                                                                                     |
| `consumer/typecheck.mjs`                                                | Runs both published TypeScript CLIs with semantic checking, records their actual source graph and rejects ambient leakage.                      |
| `consumer/browser/`                                                     | Browser-target bundle entries and an executable memory-filesystem bundle check.                                                                 |
| `consumer/imports/`                                                     | Fresh-process optional-peer, ambient-capability and physical installed-export checks.                                                           |

The authored consumer tree is copied as a tree. Generated JSON modules live in its temporary `data/` directory. Large
independent corpora stay data rather than being interpolated into executable source. Some projections deliberately carry
the original JSON **text**: parsing and serializing it in the host would erase negative zero or other producer lexemes
before the consumer could compare them.

The runtime runners discover files directly:

```sh
# These commands run inside the prepared temporary install.
node --test --test-concurrency=1 runtime
deno test --no-check --no-config --node-modules-dir=manual runtime
bun test ./runtime
```

Each case keeps its state transitions together. The memory filesystem, active writable handle, TAR view and CPIO view
now retire within their owning cases. Existing native protocol and cryptographic cleanup remains beside the assertions
that depend on it. The age corpus retains the former twenty-minute operational ceiling because Bun uses the bounded
test-only Deno cipher oracle; each child still has its separate five-second watchdog and denied permissions.

## Keep declaration environments independent

The portable modules are discovered by TypeScript's `include: ["types/portable/**/*.ts"]`. They share one compiler
invocation with the portable entry's negative Deno-namespace assertion. Each compiler runs this graph with both default
ambient discovery and `types: []`. The native Deno leaf must load only the published `deno-types` alias, and the native
Node leaf must load its selected Node declarations. `skipLibCheck` remains false.

`typecheck.mjs` uses `--listFiles`, which retains semantic checking, and checks that portable discovery selected actual
contract files. It also verifies that the build-only `@types/deno` package did not enter any installed consumer graph.

These compile-only files intentionally contain invalid calls guarded by `@ts-expect-error`, borrowed declarations and
top-level expressions that must never execute. The repository source checker leaves `consumer/` to this package gate.
Checking the fixtures through the source repository's import map or Deno ambient configuration would answer a different
question and could hide a broken published declaration.

## Add a contract without a second registry

Add an executable case to the appropriate `.test.mjs` owner, or add a cohesive new owner under `consumer/runtime/`. Use
installed package imports. Put its independent fixture projection in the existing domain projection module and import
the generated JSON module beside the consumer. Preserve producer identity, expected values, exact scopes, ownership and
failure evidence.

Add portable type assertions under `consumer/types/portable/`; native TypeScript discovery includes them without an
entry-file list. Keep a negative assertion's comment beside the expression it must reject. A native host requirement
belongs in its explicit host fixture rather than the portable graph.

Keep ambient import guards in their separate processes. Importing the candidate before installing a getter guard would
allow module caching to bypass the test. Keep browser bundle checks separate too: a bundle's absence of optional
protocol markers and its executable memory behavior establish different facts from the runtime and declaration suites.

All generated consumers, installations, bundles and compiler configurations belong to the verifier's temporary
workspace. Source and artifact checks report their own results; a source pass alone does not establish installed-package
behavior.
