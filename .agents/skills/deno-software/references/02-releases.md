# Deno 2.0 through 2.9

## Contents

- 2.0: architectural baseline
- 2.1: assets, task execution, WebAssembly, LTS
- 2.2: observability, lint plugins, SQLite, tooling depth
- 2.3: production compilation, local packages, project speed
- 2.4: bundle returns, telemetry stabilizes, broader compatibility
- 2.5: permissions in configuration and test lifecycle
- 2.6: `deno x` / `dx`, audit, granular permissions, release-age policy
- 2.7: Temporal, Windows ARM, package overrides
- 2.8: security repair and project-manager maturity
- 2.9: migration, dependency inspection, supply-chain defaults, testing, desktop
- Release-derived rules

The release posts are not a feature dump. Together they describe Deno's
direction: make existing JavaScript projects easier to run, consolidate project
tooling, improve compatibility without abandoning security, and turn source code
into multiple distributable artifacts.

## 2.0: architectural baseline

Deno 2 establishes the modern contract:

- package.json and npm compatibility are first-class;
- JSR is the TypeScript-first registry for Deno-native publication;
- workspaces are central to monorepos;
- web and Node APIs can coexist;
- the built-in toolchain is designed to cover the project lifecycle;
- explicit permissions remain a distinguishing security model.

**Operational lesson:** determine whether the repository is Deno-native,
package.json-first, or hybrid. Do not assume adopting Deno requires abandoning
the Node ecosystem.

## 2.1: assets, task execution, WebAssembly, LTS

Important direction:

- compiled applications can include assets;
- WebAssembly participates more naturally in the module graph;
- task execution became a stronger workflow surface;
- permission diagnostics improved;
- LTS made runtime policy a production decision.

**Operational lesson:** verify compiled artifacts with their embedded resources,
and define whether production follows latest stable or an LTS line.

## 2.2: observability, lint plugins, SQLite, tooling depth

Important direction:

- OpenTelemetry became integrated and later stabilized;
- lint plugins made custom policy possible without replacing the linter;
- Node compatibility expanded, including SQLite-related APIs;
- checking, compilation, benchmarking, language-server behavior, and networking
  improved.

**Operational lesson:** observability and organization-specific lint rules can
be part of the runtime/toolchain configuration, but only introduce them with an
explicit ownership and rollout plan.

## 2.3: production compilation, local packages, project speed

Important direction:

- compilation gained production-oriented platform features;
- local npm package workflows improved;
- dependency resolution, installation, checking, formatting, coverage, and
  notebooks became faster or more capable;
- explicit resource management became more practical.

**Operational lesson:** local forks and workspace packages can remain local
during migration; distribution and cleanup should be validated as first-class
concerns.

## 2.4: bundle returns, telemetry stabilizes, broader compatibility

Important direction:

- `deno bundle` returned;
- text and byte imports supported asset-oriented modules;
- built-in OpenTelemetry stabilized;
- preload hooks and dependency updates expanded project control;
- coverage extended beyond tests;
- Node and TypeScript compatibility continued improving.

**Operational lesson:** choose among source execution, bundling, and compilation
based on the consumer. Do not install a parallel bundler or telemetry stack
until current built-ins are evaluated against the real requirements.

## 2.5: permissions in configuration and test lifecycle

Important direction:

- reusable permission sets moved security policy into configuration;
- tests gained setup and teardown support;
- bundling gained programmatic and HTML-oriented capabilities;
- permission auditing and server/runtime controls improved.

**Operational lesson:** repeated task permissions should be named and
reviewable. Tests need explicit lifecycle management rather than hidden global
setup.

## 2.6: `deno x` / `dx`, audit, granular permissions, release-age policy

Important direction:

- package executables can run without global installation;
- npm vulnerability auditing joined the toolchain;
- permissions became more granular;
- minimum package release age added a supply-chain control;
- compatibility and type-check performance continued improving.

**Operational lesson:** use ephemeral executables for one-off tools; understand
that security policy may intentionally reject a newly published dependency.

## 2.7: Temporal, Windows ARM, package overrides

Important direction:

- Temporal became available as a modern date/time model;
- Windows ARM entered the supported platform conversation;
- package overrides improved dependency graph control;
- process and Node compatibility surfaces continued expanding.

**Operational lesson:** Temporal is attractive for non-trivial date/time logic,
but database, JSON, API, and older-runtime handoffs still require deliberate
serialization. Overrides must document why the upstream graph cannot be used
as-is.

## 2.8: security repair and project-manager maturity

Important direction:

- audit remediation became more integrated;
- workspace, catalog, dependency, testing, docs, compilation, and compatibility
  workflows expanded;
- Deno increasingly managed package.json repositories without forcing manifest
  conversion.

**Operational lesson:** automated dependency repair is only the first step.
Review graph changes and run behavioral tests. Preserve package.json ownership
when external tools and consumers depend on it.

## 2.9: migration, dependency inspection, supply-chain defaults, testing, desktop

Important direction:

- `deno install` can seed a Deno lockfile from npm, pnpm, Yarn, and Bun
  lockfiles;
- package.json-first management can be made explicit;
- local package links and dependency listing became stronger;
- workspace-local node_modules behavior improved;
- minimum npm release age became enabled by default with a 24-hour window;
- an optional trust no-downgrade policy can reject weaker publication
  provenance;
- snapshot tests, affected-test selection, retries, repeats, coverage
  thresholds, sharding, and parameterized tests expanded the test runner;
- `deno desktop` introduced native desktop packaging as an experimental surface;
- startup, memory, HTTP throughput, and Node compatibility improved.

**Operational lesson:** a Node project can often adopt Deno incrementally.
Testing and supply-chain policy are now architectural capabilities. Desktop
output must be isolated behind an experimental subpath and validated per
target.

## Release-derived rules

1. Confirm the active Deno version before recommending a capability.
2. Distinguish stable, experimental, and unstable behavior.
3. Prefer compatibility experiments before migrations or rewrites.
4. Treat permissions and supply-chain controls as project policy.
5. Match the command to the output artifact.
6. Validate performance on the user's workload.
7. Do not infer current syntax or guarantees from an old release announcement;
   check current docs.
