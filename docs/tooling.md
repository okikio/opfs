# Run checks, tests and benchmarks

Every repository command is a mise task. `mise run <family>:<kind>` runs the same program locally and in CI, so a
failure in a pull request can be reproduced with the command shown in its log. Mise installs the pinned Deno, Node.js
and Bun from `mise.toml`; check tools such as `gitleaks` download the first time their task runs.

```sh
mise install            # the pinned runtimes
mise run prepare:deps   # the frozen dependency graph from deno.lock (`deno ci`)
mise run check          # every check
mise run test           # the discovered suite on Deno, Node.js and Bun
```

Task files live in `.mise/tasks/<family>/<kind>.sh`. Each one only selects a program; the programs live in `tools/`, in
a folder named after the task family that runs them, so `check:types` runs `tools/check/types.ts` and `ci:plan` runs
`tools/ci/plan.ts`. `mise tasks` lists every task with its description.

```text
tools/
  check/     types, exports, commits, examples, security   (check:* tasks with a program of their own)
  test/      suite, discover, netlify, ecosystems, linux, command, attest, container/
  bench/     local                                    (bench:local)
  ci/        plan, lane, result, stack, evidence      (ci:plan, ci:lane and the Quality workflow)
  release/   plan, version, publish, verify, manifest, sampo
  fixtures/  store                                    (prepare:fixtures, check:fixtures, build:fixtures)
  npm/       build, pack                              (build:npm, check:package)
  schema/    types, compiler                          (build:schema, check:schema)
  spawn.ts   runs one child program from the repository root; the other tools share it
```

## Tasks

| Task                                       | What it runs                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `prepare:deps`                             | `deno ci`: the dependency graph exactly as `deno.lock` records it                                 |
| `prepare:fixtures`                         | Downloads the [stored fixtures](fixtures.md) and checks each SHA-256                              |
| `prepare:browser`                          | The pinned Playwright browsers and their system packages                                          |
| `check:types`                              | `deno check` on tracked repository TypeScript programs, then `tsc` on the DOM and worker projects |
| `check:format`, `check:lint`, `check:docs` | `deno fmt --check`, `deno lint`, `deno doc --lint mod.ts`                                         |
| `check:examples`                           | Type-checks the complete examples in Markdown                                                     |
| `check:schema`                             | JSON Schemas match their Zod sources (`build:schema` rewrites them)                               |
| `check:fixtures`                           | No tracked fixture is over 256 KiB, and the fixture manifest is consistent                        |
| `check:jsr`, `check:package`               | JSR dry run; npm tarball built and tested from a clean consumer                                   |
| `check:exports`                            | Public symbols per subpath match `tests/package/exports.json` (`build:exports` rewrites it)       |
| `check:versions`                           | `package.json` and `deno.json` carry the same version                                             |
| `check:actions`                            | Workflows and local actions: jactionlint, zizmor and pinact                                       |
| `check:shell`, `check:tasks`               | shellcheck on shell scripts; `mise tasks validate`                                                |
| `check:secrets`                            | gitleaks on the Git history, with exact reviewed exceptions in `.gitleaksignore`                  |
| `check:security`                           | `deno audit` and osv-scanner, with reviewed, expiring exceptions in `osv-scanner.toml`            |
| `check:commits`                            | Conventional Commit subjects between `BASE_SHA` and `HEAD_SHA`                                    |
| `test:deno`, `test:node`, `test:bun`       | The discovered tests for that runtime; accepts files, `--family` and `--shard i/n`                |
| `test:providers`                           | Provider tests against containers started by Testcontainers (Docker required)                     |
| `test:interop`                             | Archive output compared with installed 7-Zip, bsdtar and unzip                                    |
| `test:netlify`                             | The Netlify Blobs client against the frozen SDK closure                                           |
| `test:browser`                             | Playwright browser tests (Chromium, Firefox, WebKit)                                              |
| `test:stress`, `test:coverage`             | Shuffled repeats of the portable suite; Deno coverage                                             |
| `test:ecosystems`                          | unstorage, db0, Drizzle and RxDB installed fresh at pinned versions                               |
| `bench:local`                              | Every container-free benchmark once, as a correctness check; reports in `.tmp/reports/bench/`     |
| `bench:providers`, `bench:browser`         | Provider baselines and browser OPFS benchmarks                                                    |
| `release:plan`, `release:version`          | Preview, then write, the next version from Sampo changesets; see [releasing](releasing.md)        |
| `release:publish`, `release:verify`        | Publish to one registry (`--target npm\|jsr`); install it back in a fresh consumer                |
| `ci:plan`, `ci:lane`                       | Select the lanes a change needs; run one lane's tasks in order                                    |

The type check leaves copied guidance examples and configurations under `.agents/guides/`, `.agents/references/`,
`.agents/skills/` and `.agents/handbook/` to their upstream guidance repository. It still checks local agent programs,
including `.agents/validation/`. Original upstream test snapshots and generated declaration files also remain inert.
Installed-consumer files under `tests/package/consumer/` use the separate package gate. Its actual compiler CLIs check
the packed declarations under portable, Node and Deno ambient environments; the source configuration must not replace
those environments. Host orchestration under `tests/package/` stays in the ordinary source check.

Files that load Bun declarations need a separate compiler group because those declarations change shared browser
globals. Rolldown's Oxc parser identifies their imports, re-exports, import types, literal dynamic imports and leading
triple-slash type references. Quoted examples and ordinary comments do not change a file's group.

The type checker imports the pinned `rolldown/utils` entrypoint directly to avoid Vite's unrelated host probes. When the
discovered test selection includes `tools/check/types.test.ts`, the Deno runner grants `--allow-ffi=node_modules` to
load the installed native parser. Other selections retain their existing permissions; Netlify continues to use its
existing `--allow-all` contract.

## Tests are discovered

A file named `*.test.ts` under `tests/` or `tools/` is a test. It runs on Deno, Node.js and Bun unless its name puts it
in a family with other needs; `tools/test/discover.ts` holds those rules, each with its reason:

| Family                      | Files                                            | Runs on                             |
| --------------------------- | ------------------------------------------------ | ----------------------------------- |
| `provider`                  | `*-provider.test.ts`, `provider.test.ts`         | Node.js, with Docker                |
| `interop`                   | `compress-process`, `tar-process`, `zip-process` | Deno, with native archive tools     |
| `netlify`                   | `netlify-*.test.ts`                              | Deno, with the acquired SDK closure |
| `process`                   | `fixture-group`, `process`                       | Deno and Node.js                    |
| `sqlite`                    | `d1`                                             | Deno and Node.js (`node:sqlite`)    |
| `deno`, `kv`, `node`, `bun` | the runtime's own driver tests                   | that runtime                        |

A new test needs no other edit: name it for its family. `mise run test:deno -- --list` prints the inventory a run would
use, with each file's family.

The [installed-package fixtures](package.md) have a separate owner. `check:package` copies real `.test.mjs` files into a
clean npm install, then Node, Deno and Bun discover its `runtime/` tree with their native test commands. TypeScript
discovers `types/portable/**/*.ts` within the same installed consumer. These fixtures must not run through the
repository source aliases or its ordinary portable-suite discovery.

## CI runs the same tasks

`.github/workflows/ci.yml` calls the Quality workflow. Its first job runs `mise run ci:plan`; each selected job then
runs `mise run ci:lane -- <lane>`, which calls the same tasks listed above in order. Every job has a 10-minute limit;
long suites are split into shards.

- **Selection.** `tools/ci/plan.ts` compares the base and head commits. A change limited to Markdown or planning records
  runs only the source checks; any other change runs every lane whose tests exist. In a native pull request stack only
  the top layer runs the full lanes; lower layers run the source checks.
- **Result cache.** A lane records a pass under its exact inputs: the commit's tree, the lane, its shard and the runner
  image release. A later run with the same key skips that lane. The cache never decides what is selected, and a fresh
  dispatch (`fresh: true`) bypasses it.
- **Download caches.** Deno's package downloads, Deno's compiler state and the stored fixtures are cached separately. A
  restored download is still verified: `deno ci` checks the lockfile and fixtures are hashed before use.
- **Playwright's Ubuntu packages.** `prepare:browser` installs the browsers' system packages from cached `.deb` files
  with one `dpkg --install`, so a slow Ubuntu mirror cannot spend a job's 10 minutes. On a miss, or when the files no
  longer fit the runner image, it fetches the same files over 8 parallel connections first, because a slow mirror limits
  each connection, then has apt install from that folder; apt checks every file against the signed index and downloads
  anything missing itself. A local `.deb` has no signature for apt to check, so only trusted refs write this cache. See
  `.github/actions/playwright-cache`. GitHub scopes caches by ref: a pull request reads its own entries and `main`'s, so
  the first run of a new pull request misses until `main` has saved an entry.
- **Evidence.** A push to `main` selects work changed since the last commit whose CI passed. Release requires a passing
  main-push CI run on the exact commit being published.
