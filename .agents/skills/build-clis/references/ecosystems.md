# CLI ecosystem ownership map

This reference helps select **capability owners** around a CLI. It is not a list
of packages to install. Use `explore-ecosystems` to verify current versions,
relationships, exports, and alternatives before a material dependency change.

## Selection principle

Start from the capability:

```text
command grammar
config discovery
merge/resolution
runtime schema
logging/diagnostics
prompts
HTTP
storage
paths/environment
build/package/release
long-running durability
```

Then select the existing or best-fitting owner. Do not choose an ecosystem first
and force every sibling into the project.

## Command language

When selected, Optique can own typed command grammar, options, arguments,
subcommands, choices, help, command discovery, completion, manuals, and focused
integrations through separate packages.

Relevant adjacent integrations can include schema adapters, environment/config
sources, prompts, Git, LogTape, Temporal, time, and run/discovery packages.
Inspect the installed version and exact package exports. Stable and unreleased
Optique lines must not be mixed in implementation claims.

Citty or another parser is normally an alternative command owner. Two parsers in
one product need an explicit separation such as two independent executables.

## Configuration and runtime loading

The UnJS configuration cluster often separates:

- `c12`: config discovery/layers/factories;
- `defu`: default-style merge primitive;
- `jiti`: runtime TS/ESM/CJS loading where selected;
- `confbox`: configuration formats;
- `destr`: tolerant untrusted string parsing for appropriate data;
- `pkg-types`: package metadata utilities;
- `pathe`: path utilities;
- `ufo`: URL utilities;
- `std-env`: environment/runtime signals;
- `rc9`: user configuration patterns where applicable.

An application still owns its specific precedence, array/union/operation
semantics, provenance, and final runtime schema.

## Schema owners

Zod, Valibot, or another selected validator can own project schemas. Standard
Schema is a validator-neutral interoperability protocol. Standard JSON Schema is
another representation contract. Do not install multiple validators without an
interop or migration reason.

For a TypeScript project that selects Zod, this collection defaults to `*Schema` plus
schema-derived `*Type` when Zod is the selected project owner.

## Logging and terminal output

When selected, LogTape can own structured diagnostic transport and categories.
Application code owns configuration/sinks/filters/redaction. Keep stable command
results separate from diagnostic rendering.

Useful related packages may include pretty/file/redaction/testing/framework or
Optique integrations. Verify the exact need. A custom project formatter can
remain when it communicates the domain better than a generic formatter.

Consola or another logger is usually an alternative transport owner, not an
extra layer to add by default.

## Prompts

Clack, Inquirer, or parser-specific prompt adapters can own presentation. The
application still owns:

- noninteractive/CI behavior;
- TTY checks;
- cancellation;
- secret handling;
- defaults/provenance;
- destructive confirmation and plan/apply policy.

## HTTP, state, hooks, hashing

Focused UnJS packages can provide useful independent capabilities:

- `ofetch`: HTTP/fetch client behavior;
- `unstorage`: storage abstraction and drivers;
- `ohash`: deterministic hashing for supported values;
- `hookable`: hook orchestration.

Do not turn these into one “UnJS runtime” abstraction. Each package keeps its
own contract and lifecycle.

## Build/package/release

Depending on repository selection:

- `unbuild` can own package builds;
- `nypm` package-manager commands;
- Magicast source-preserving source edits;
- giget template retrieval;
- changelogen changelog/release planning;
- automd bounded generated documentation;
- Mise repository tool/task versions;
- Oxc parser/linter/formatter/transform tooling;
- Unplugin cross-bundler plugin integration.

Use `build-devtools` for this layer and verify installed APIs rather than copying
version-specific examples from memory.

## Durable work

Temporal or another durable workflow engine owns durable history, timers,
signals, replay, and execution processes. An Optique/CLI adapter can expose
start/status/cancel commands; it does not make in-process work durable.

## Project-local Okikio tools

`@okikio/undent` can own readable multiline templates/help/diagnostics where its
actual public API fits. Use `use-okikio` for current export evidence rather than
inventing remembered functions.

## Anti-patterns

- installing every same-organization package after discovering the ecosystem;
- two command parsers for one command tree;
- c12 plus a second config loader reading the same files/env without a contract;
- global LogTape configuration inside a reusable library;
- Standard Schema treated as a validation implementation;
- one giant wrapper hiding several independent UnJS packages;
- `@optique/logtape` duplicated by hand while Optique is already selected;
- Unplugin added when the repository needs only one bundler and existing config
  is simpler;
- Oxc/Babel/TypeScript transforms stacked without ownership rationale.

## Verification

For every material ecosystem choice, record:

- exact package/version/export;
- capability it owns;
- why current owner is retained/replaced/coexists;
- runtime and build constraints;
- resource/configuration owner;
- test or clean-consumer proof;
- deliberate excluded siblings/alternatives.

The ecosystem map is decision evidence, not a dependency shopping list.
