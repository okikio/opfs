# CLI architecture

Use this reference when the task changes how command language, configuration,
portable logic, host resources, durable work, or installed artifacts fit
together. Load the focused references for exact parser, config, output, or
lifecycle APIs.

## Mental model

A production CLI is a small application with several different contracts:

```text
argv / environment / config / prompt
              |
              v
       source interpretation
              |
              v
   sparse normalized source values
              |
              v
       precedence resolution
              |
              v
      validated runtime request
              |
              v
          use-case code
              |
      +-------+--------+
      |                |
      v                v
 live resources     stable result
      |                |
      v                v
 diagnostics       stdout/artifact
      |
      v
 cleanup / exit
```

The layers can live in one module for a small command. They still need distinct
ownership so defaults, errors, resources, and output do not leak across them.

## Choose structure proportionally

| Situation | Appropriate shape |
|---|---|
| Small internal command, one runtime | One executable module with explicit parser/request/result/resource seams |
| Reusable operation plus CLI | Reusable library/domain function plus one CLI adapter/composition root |
| Deno and Node entrypoints | Shared core plus runtime-specific roots only where host APIs differ |
| Browser/worker reuse | Capability-injected core with no process or terminal globals |
| Several commands sharing config/output | Shared command/config/output modules plus explicit per-command handlers |
| Long-running recoverable work | Thin CLI client over a workflow/control-plane owner when cross-process durability is required |
| Installable CLI package | Explicit source, build, package, generated completion/manual, and clean installed-entrypoint contracts |

Do not split packages because a diagram looks cleaner. Split when a concept has
its own public/reusable contract, dependency direction, lifecycle, or release
surface.

## Ownership map

### Command grammar

The selected parser owns token spelling, options, arguments, aliases,
subcommands, mutually exclusive forms, typo suggestions, help metadata, and
other syntax-level invalid states.

If the repository selected Optique, use its grammar and ecosystem rather than
building a parallel parser. `@optique/logtape` can own logging option grammar
when its semantics fit. Optique does not own application configuration loading,
product defaults, resource creation, or domain execution merely because the
same values eventually reach the handler.

### Source adapters

CLI args, environment, config files, prompts, secret stores, and programmatic
callers are independent sources. Each source produces a sparse value/patch plus
provenance. Absence is not a default value.

### Resolver

The resolver owns precedence, merge semantics, authored operations, aliases,
normalization between source shapes, final defaults, and field provenance.

### Runtime schema

The final schema owns executable request validity. It should validate the
resolved request once defaults and source precedence are known. A parser can
reject syntactically impossible argv forms earlier without becoming the owner of
cross-source/domain semantics.

### Use-case code

A handler receives a validated request and explicit capabilities. It owns the
operation, not process globals, terminal rendering, or application-wide logger
configuration.

### Results and diagnostics

Stable command results, operational diagnostics, and durable artifacts are
separate output classes. See `output.md` and `logtape.md`.

### Composition root

The executable root owns host resources and terminal/process policy:

- `Deno.args`, `process.argv`, environment access;
- stdin/stdout/stderr and TTY detection;
- root cancellation and OS signals;
- application LogTape configuration and sink lifetime;
- resource construction and disposal;
- exit-code mapping;
- host-specific permissions or adapters.

## Portable core

Prefer request-oriented call sites:

```ts
const request = RequestSchema.parse(resolved);
const result = await inspect(ctx, request, dependencies);
```

rather than handlers that reach into ambient process state:

```ts
async function inspect() {
  const path = Deno.args[0];
  const token = Deno.env.get('TOKEN');
  // ...
}
```

Explicit inputs make the core easier to test, reuse, benchmark, and run under
another host. Do not invent a giant universal context to hide dependencies.
`ctx` can carry scoped lifetime/cancellation/deadline/trace identity when the
project uses that model; pass concrete service capabilities explicitly.

## Import safety

Reusable command modules should be safe to import for:

- generated help/completion/man discovery;
- tests;
- programmatic use;
- bundler/tree-shaking inspection;
- alternate host adapters.

Importing a parser or handler module must not automatically:

- parse ambient argv;
- load project config;
- prompt;
- configure LogTape globally;
- start a server/browser/worker;
- connect to a database;
- install signal handlers;
- exit the process.

Keep those effects in the composition root.

## Long-running commands

Decide whether the CLI itself owns active work or is a client of durable work.
Ask:

- does work need to survive CLI/process loss?
- is a run ID durable and inspectable later?
- can another process attach/cancel/resume it?
- do timers/signals/leases/replay matter?

If yes, compose with `build-workflows`. The CLI can start a run, wait, stream
status, attach, inspect, retry, cancel, or resume. The durable engine remains the
owner of history and execution.

## Failure signatures

| Symptom | Architectural defect |
|---|---|
| `--help` fails because config is invalid | bootstrap language coupled to runtime config |
| unit tests need to patch global argv/env | process globals leaked into reusable handler |
| same config value loaded by parser and c12 | duplicate source ownership |
| parser default always beats config | absence collapsed into authored value |
| logger config appears in a reusable library | composition-root ownership leaked inward |
| command returns a run ID but work dies with CLI | durability claim exceeds execution owner |
| importing command tree opens resources | import-time side effects |
| Node/Deno entrypoints fork domain logic | runtime adapter split happened too high |

## Verification

Verify architecture through behavior:

1. import parser/handler modules without process side effects;
2. parse sparse argv independently from config loading;
3. run resolution with representative source combinations;
4. call the use-case function directly with explicit capabilities;
5. run the real executable in success/error/cancel cases;
6. verify generated help/completion/man without executing project work;
7. verify packaged/compiled entrypoint uses the same domain behavior.

Use the shared CLI guides, the active repository's configuration contract, and
official package documentation registered in the skill source ledger. Historical
configuration examples illustrate ownership. Recheck version-sensitive APIs
against the installed package.
