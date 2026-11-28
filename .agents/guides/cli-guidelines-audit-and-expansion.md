---
title: "CLI Guidelines Audit and Expansion Plan"
subtitle: "What clig.dev validates, what it adds, and how Optique, LogTape, and UnJS implement the missing capabilities"
author: "Okiki Ojo"
date: "July 2026"
lang: en-CA
---

> **Current standards note (2026-08-19):** Use [Okikio Engineering Standards](engineering-standards.md) for current cross-project naming, schema/type, comments/TSDoc, formatting, testing, logging, dependency, compatibility, validation, and delivery rules. This document remains authoritative for its domain-specific design and dated implementation evidence where it is more specific.

## Apply the audit to the selected CLI

This is a dated audit and expansion plan, not proof that the current consumer
implements its guidebook. Verify the selected parser, logger, config sources,
exports, and tests before using a package API. Optique, LogTape, and UnJS are
focused choices; preserve a deliberately selected native parser or another
verified stack. A small command does not need every adapter in this catalog.

Stable machine stdout can be written directly under its result contract;
LogTape owns diagnostics when selected and is not mandatory result transport.
Apply diagnostic redaction to diagnostics. User-requested exports, config
display, and support bundles need their own exposure policy, preserving safe
structured values. An old example's single redaction pipeline does not decide
those products. Select the tests that prove the affected channel, interaction,
lifetime, or installed-artifact claim.

# Executive conclusion

The Command Line Interface Guidelines validates the guidebook’s core architecture. Both approaches insist on predictable exit status, clean stdout and stderr contracts, composability, early validation, automation-safe interaction, documented configuration precedence, useful help, robust cancellation, and realistic packaged-artifact testing.

The article also reveals a meaningful gap. Version 1.0 of the guidebook concentrated on the software architecture beneath a CLI: portable handlers, schemas, adapters, source resolution, logging, lifecycle, tests, and release tooling. The article concentrates on the interface experienced over many invocations: command language, default help, progress, state visibility, typo recovery, dangerous operations, standard streams, secrets, pagers, XDG paths, resumability, deprecation, uninstall, and telemetry consent.

The correct conclusion is not to replace the guidebook’s pattern. It is to add a human-interface policy layer around it.

```text
Existing guidebook strength
  portable, schema-first, framework-neutral execution architecture

CLI Guidelines contribution
  human-first language, conversation, convention, safety, and longevity

Revised guidebook
  portable execution core + production command-line interface policy
```

# Evaluation method

Every major recommendation in the article was classified as one of five states:

- **Validated**: already explicit in the guidebook.
- **Strengthened**: present, but the article makes the policy more concrete.
- **Expanded**: architecture existed, but important user-facing behaviour was missing.
- **New**: no meaningful treatment existed in version 1.0.
- **Product policy**: no library can decide the right behaviour; frameworks can only support it.

The ecosystem review followed a strict ownership rule:

- **Optique** owns executable grammar, parsing, source binding, help, suggestions, completion, and man-page generation.
- **LogTape** owns result and diagnostic transport, categories, filters, redaction, formatter and sink selection, contexts, durable diagnostics, testing, and optional telemetry export.
- **UnJS packages** fill focused host-adapter roles such as configuration, XDG RC files, environment detection, network resilience, persistence, paths, URLs, package metadata, builds, and source-preserving config edits.
- **The portable core** owns schemas, risk policy, outcome policy, operation plans, checkpoints, telemetry consent, deprecation contracts, and domain behaviour.

The review deliberately avoids stacking overlapping frameworks. Citty is an alternative to Optique, not an additional parser. Consola is an alternative terminal logger, not an additional transport beside LogTape.

# What the article validates

## Composability and channel discipline

The article’s essential contract is the same one already implemented in the guidebook:

```text
primary result       -> stdout
messages/diagnostics -> stderr
success               -> exit 0
failure               -> stable non-zero exit
```

The guidebook goes further by routing both results and diagnostics through LogTape categories, preserving one redaction, testing, and lifecycle model while still writing exact raw bytes to stdout for machine results.

## Parser-generated help and documentation

The article recommends an argument-parsing library, extensive help, subcommand help, examples, terminal documentation, and man pages. The guidebook already selects Optique and derives parsing, help, completion, and man pages from one model.

## Early validation

The article says all user input will eventually be bad and should be rejected before harmful work begins. The guidebook already has authored, sparse-patch, and resolved-request schemas, with Zod or Valibot behind Standard Schema.

## Automation-safe prompts

Both documents require prompts to be optional, TTY-aware, and disabled in scripts. The guidebook’s `PromptService` and Clack adapter already create the correct dependency boundary.

## Configuration precedence

Both documents require an explicit precedence chain. The guidebook already combines Optique source contexts with c12 layers, defu merge policy, and provenance.

## Cancellation and cleanup

The article expects Ctrl-C to work promptly and cleanup to be bounded. The guidebook already has a root `AbortController`, explicit resource ownership, LogTape flushing, and subprocess cancellation tests.

## Real validation

The article repeatedly treats observable behaviour as the standard. The guidebook already requires unit, property, adapter, in-process, subprocess, completion, man, packed-package, and compiled-artifact tests.

# What the article strengthens

## Help has information architecture

Version 1.0 generated help but did not say enough about what the default page should contain. The article adds a valuable distinction:

- no-argument output is concise and task-oriented
- requested help is comprehensive
- examples lead
- common flags and commands appear first
- web docs and issue paths are visible
- help remains reachable from every subcommand

This is now represented as help metadata and a root invocation policy rather than being left to formatter defaults.

## Human output and machine output are separate products

Version 1.0 separated stdout and diagnostics, but the article identifies more output contracts:

- human output can wrap, group, colour, and explain
- plain output remains line-oriented
- JSON is a complete structured document
- JSONL supports streams
- scripts should be directed to stable modes

The revised guidebook adds a schema-owned output policy and separate LogTape result categories.

## Interruption needs escalation

The original guidebook handled SIGINT. The article adds the practical two-stage interaction: the first Ctrl-C begins graceful cancellation, while a second Ctrl-C forces a prompt exit. The revised pattern adds a shutdown policy and cleanup deadline.

## Errors are part of documentation

The original guidebook had outcome schemas and structured diagnostics. The article strengthens the human contract: rewrite expected failures, group repeated errors, put actionable information where the user sees it, and create a low-friction bug-report path. The revised guide adds `UserFacingErrorSchema` and redacted support bundles.

# What the article adds

## Command-language governance

The article makes flag and argument design a first-class compatibility concern:

- prefer flags for heterogeneous inputs
- always provide long names
- reserve short names for common operations
- use conventional names
- avoid ambiguous sibling commands
- avoid arbitrary abbreviations
- avoid catch-all commands
- keep aliases explicit and stable

Optique provides multiple option names, aliases, hidden aliases, hidden visibility controls, parser-aware suggestions, and structural grammar. The application still needs a naming review policy and compatibility tests.

## Dangerous-operation policy

The article’s mild, moderate, and severe distinction is one of its strongest contributions. The revised guide adds schema-owned risk levels, dry-run operation plans, `--force`, typed confirmation tokens, and plan/apply workflows.

## Standard stream sentinels

Supporting `-` for stdin or stdout is essential composability guidance missing from version 1.0. The revision adds a discriminated union for paths, stdin, stdout, and disabled values, plus a custom Optique parser.

## Secret-source policy

The article correctly warns that secrets in argv and general environment variables leak. The revised guide adds `SecretSource` and `SecretReferenceSchema`, supporting files, stdin, no-echo prompts, sockets, and provider references. LogTape redaction remains defence in depth.

## Pager policy

Long help, plans, and explanations may use a pager only for human TTY output. The revised guide adds an injectable `Pager` capability and `--no-pager`, while preserving LogTape as the result transport.

## Explicit state and conversational workflows

The article frames repeated CLI invocations as a conversation. The revision adds status schemas, `next_commands`, plan/apply flows, resumable run commands, and config provenance as visible state.

## XDG paths and consentful edits

The article gives config locations an explicit policy. The revision adds `ApplicationPathsSchema`, `PathPolicy`, rc9 for XDG user configuration, pathe for normalized paths, and consentful c12/magicast/confbox edits.

## Recovery and crash-only execution

Version 1.0 tested idempotence but did not define a checkpoint architecture. The revision adds checkpoint schemas, `CheckpointStore`, unstorage adapters, request fingerprints, startup reconciliation, and resume semantics.

## Distribution and removal

The article recommends a single binary and easy uninstall. The revision now distinguishes:

- Deno compile for self-contained Deno binaries
- Node single executable applications for bundled Node executables
- unbuild for package and library builds
- pkg-types for metadata
- nypm for project package-manager operations
- explicit install, smoke-test, checksum, signing, and uninstall validation

## Telemetry consent

Version 1.0 mentioned optional LogTape remote sinks but did not define consent. The revision adds `TelemetryPolicySchema`, makes remote sinks opt-in or enterprise-policy controlled, and separates operational diagnostics from product analytics.

# Ecosystem capability map

## Optique

Optique is the best fit for the guidebook’s command-language adapter because it provides more than token parsing:

- parser combinators that encode valid state combinations in the inferred type
- options with multiple names
- commands with visible and hidden aliases
- visibility controls for usage, documentation, help, and suggestions
- parser-aware typo suggestions
- rich value parsers and asynchronous parsers
- context-aware completion
- help as option, command, or both
- program metadata for examples, issue paths, and footer text
- Bash, zsh, fish, PowerShell, and Nushell completion
- generated man pages
- source contexts for config, environment, prompts, and derived defaults
- Zod, Valibot, Standard Schema, Temporal, Git, Clack, Inquirer, and LogTape integrations
- explicit static command registration through `@optique/discover`

Optique cannot decide whether deleting a production tenant is severe, whether telemetry is ethical, or what “plain output” means for a domain. Those stay in schemas and product policy.

## LogTape

LogTape maps unusually well to the article’s “say enough, but not too much” principle:

- hierarchical categories let normal mode suppress internal details without discarding them from file or telemetry routes
- structured properties support human, JSON, support-bundle, and analytics representations without parsing rendered strings
- contexts attach run and request identities once
- lazy evaluation avoids expensive debug properties when no sink needs them
- filters implement quiet, silent, verbose, subsystem, and output-mode policies
- pretty formatting creates human diagnostics without changing the record
- stream, file, rotating file, OpenTelemetry, Sentry, syslog, CloudWatch, and Windows Event Log sinks address different deployment needs
- redaction protects every route
- testing packages assert observable records
- lint rules can prevent interpolation, unawaited logging, and eager debug work

The strongest pattern is still one transport with multiple categories. Do not introduce Consola for friendly output beside LogTape. Implement friendly rendering as a LogTape formatter or sink.

## c12 and defu

c12 supports the article’s configuration hierarchy through project files, RC sources, global RC, package metadata, environment variants, dotenv, `extends`, provenance, watching, and custom loading. defu supplies nested defaults and custom mergers.

The guidebook’s main improvement over generic c12 usage is its explicit merge algebra. Array replacement, concatenation, and deduplication are domain decisions and are tested through real extension chains.

## std-env

std-env is a useful terminal and automation adapter because it identifies:

- CI
- provider environments
- TTY presence
- colour capability
- debug mode
- minimal environments

It does not replace direct per-stream TTY checks, because stdout and stderr may be routed differently. It supplies shared contextual signals to the host adapter.

## rc9 and pathe

rc9 gives the user-level configuration layer read, write, and update operations in XDG-aware locations. pathe normalizes cross-platform path operations. Combined behind `PathPolicy` and `ConfigEditor`, they keep platform rules out of handlers.

## ofetch

ofetch supplies cross-runtime fetch behaviour, timeout, retries, retry delay, response parsing, and interceptors. Its safer default is not to retry payload-changing methods automatically. The guidebook layers Temporal durations, abort signals, idempotency policy, and LogTape events around it.

## unstorage and ohash

unstorage gives checkpoints and caches a runtime-neutral key-value boundary with memory, filesystem, browser, worker, database, and remote drivers. ohash can fingerprint normalized requests and operation plans. Neither decides resumability semantics; schemas do.

## magicast and confbox

magicast supports source-preserving JavaScript and TypeScript config changes. confbox handles structured formats. They are suitable only after the application shows the proposed edit, obtains consent, writes atomically, and validates the result with the authored configuration schema.

## pkg-types, nypm, and unbuild

These packages address packaging rather than runtime command semantics:

- pkg-types discovers and reads package metadata and exports
- nypm detects the project package manager and performs dependency or script operations consistently
- unbuild builds libraries and package artifacts

They complement, but do not replace, Deno compile or Node single executable applications.

## Citty and Consola

Both are capable UnJS tools, but the guidebook should not adopt them by accumulation:

- Citty is a lightweight alternative parser with generated usage, nested and lazy subcommands, aliases, hooks, and plugins. Choose it instead of Optique when the command grammar is smaller and the richer Optique source, schema, completion, and man ecosystem is unnecessary.
- Consola is an alternative console logger and reporter. Adding it beside LogTape would split transport and weaken the guidebook’s core guarantee.

# Detailed checklist by article section

## Philosophy

| Recommendation | Status | Guidebook action |
|---|---|---|
| human-first design | expanded | add outer interface contract |
| simple parts compose | validated | retain stdout/result and portable-handler model |
| consistency across programs | expanded | shared flag vocabulary and naming review |
| say just enough | expanded | output modes, progress, quiet/silent, LogTape filters |
| ease of discovery | expanded | concise help, examples first, next commands |
| conversation as norm | new | status, plan/apply, resume, suggestions |
| robustness should feel robust | expanded | prompt acknowledgement, progress, human errors |
| empathy | product policy | review wording and first-use usability |
| break conventions intentionally | product policy | document exceptions and test them |

## Basics, help, and documentation

| Recommendation | Status | Guidebook action |
|---|---|---|
| use parser library | validated | Optique adapter |
| correct exit status | validated | stable outcome policy |
| primary output to stdout | validated | LogTape result category |
| messages to stderr | validated | diagnostic route |
| extensive requested help | validated | Optique help both surfaces |
| concise default help | new | root invocation policy |
| help at every subcommand | strengthened | explicit subprocess matrix |
| support path | new | metadata and package links |
| web docs links | new | command-specific URL metadata |
| examples first | new | help example schema |
| common commands first | new | common metadata and renderer ordering |
| formatted help | strengthened | Optique messages and TTY formatter |
| typo suggestions | expanded | structured Optique suggestions |
| piped-input command should not hang on TTY | new | stdin capability preflight |
| web docs | strengthened | durable versioned docs |
| terminal docs and man pages | validated | Optique help/man |

## Output and errors

| Recommendation | Status | Guidebook action |
|---|---|---|
| human output paramount | expanded | human renderer over result schema |
| machine output | validated and expanded | plain/JSON/JSONL modes |
| `--plain` | new | stable line mode |
| `--json` | strengthened | exact result renderer |
| brief success feedback | expanded | state/result policy |
| explain state changes | new | operation result and status schemas |
| current-state command | new | status family |
| suggest next commands | new | `next_commands` field |
| explicit external effects | expanded | operation plans and capability checks |
| intentional colour | expanded | schema-owned colour policy |
| disable colour off-TTY/NO_COLOR | new | std-env plus policy precedence |
| no animation off-TTY | new | progress route selection |
| symbols only when useful | product policy | renderer review |
| internal details only in verbose mode | strengthened | category filters |
| stderr is not a log dump | expanded | normal human formatter |
| pager for long text | new | Pager capability |
| rewrite expected errors | expanded | user-facing error schema |
| group repeated errors | new | aggregate failure renderer |
| debug path for unexpected errors | expanded | redacted support bundle |
| effortless bug report | new | issue URL and prefilled metadata |

## Arguments, interactivity, and subcommands

| Recommendation | Status | Guidebook action |
|---|---|---|
| prefer flags | expanded | grammar review policy |
| full-length flag names | new rule | option metadata validation |
| reserve short flags | new rule | review checklist |
| multiple same-kind args | clarified | homogeneous positional collection |
| avoid multiple heterogeneous args | new rule | flags or discriminated input modes |
| standard flag names | new | shared parser fragments |
| right defaults | validated | resolved-schema defaults |
| prompt for missing values | validated | prompt adapter |
| prompt never required | validated | `--no-input` and non-TTY errors |
| confirm dangerous actions | new | risk and plan schemas |
| `-` for standard streams | new | file endpoint union |
| explicit `none` sentinel | new | disabled union branch |
| order independence | expanded | composition and subprocess tests |
| no secrets in flags | new | secret-source capability |
| prompts only on TTY | validated | interaction policy |
| hidden password input | expanded | prompt adapter contract |
| let user escape | strengthened | AbortSignal propagation |
| consistent subcommands | expanded | metadata review and shared fragments |
| noun/verb consistency | product policy | command vocabulary table |
| no ambiguous names | expanded | naming tests and suggestions |

## Robustness and future-proofing

| Recommendation | Status | Guidebook action |
|---|---|---|
| validate input | validated | schema pipeline |
| acknowledge within about 100ms | new target | progress start event |
| long-task progress | expanded | progress schema and renderer |
| parallel progress | new | coordinator route |
| timeout | expanded | Temporal + ofetch policy |
| recoverable | new | checkpoint store |
| crash-only | new | startup reconciliation |
| expect misuse | strengthened | adversarial adapter/subprocess tests |
| additive changes | expanded | versioned interface policy |
| warn before breaking | new | deprecation schema/category |
| human output can evolve | expanded | stable machine modes |
| no catch-all command | new rule | static explicit registry |
| no arbitrary abbreviations | new rule | explicit aliases only |
| avoid external time bombs | expanded | offline and pinned remote policy |

## Signals, configuration, environment, naming, distribution, analytics

| Recommendation | Status | Guidebook action |
|---|---|---|
| fast first Ctrl-C | strengthened | immediate lifecycle event |
| second Ctrl-C forces exit | new | signal escalation policy |
| cleanup timeout | expanded | Temporal shutdown policy |
| configuration by specificity | expanded | invocation/session/project/user/system model |
| XDG spec | new | rc9 and path policy |
| consent before editing other config | new | plan/diff/config editor |
| tested precedence | validated | Optique/c12/defu tests |
| env for context | expanded | environment policy |
| portable env names | new rule | schema validation |
| use general env conventions | new | std-env and host adapter |
| dotenv where appropriate | validated and clarified | Optique env/c12 source |
| dotenv not full config | strengthened | typed config remains primary |
| no secrets in env | new | secret-source policy |
| simple command name | product policy | naming review |
| lowercase and short | product policy | distribution review |
| single binary | expanded | Deno compile and Node SEA |
| easy uninstall | new | owned-path inventory and docs |
| no telemetry without consent | new | telemetry policy and sink gating |
| consider analytics alternatives | new | docs/download/support measurement |

# Revised production priorities

The highest-value additions are not all equal. Adopt them in this order:

## Priority 1: correctness and automation

1. human/plain/JSON/JSONL modes
2. stdout/stderr and TTY separation
3. `--no-input`, non-TTY prompt failures
4. stdin/stdout `-` support
5. secret-source policy
6. dangerous-action risk and dry-run schemas
7. first/second interrupt lifecycle

## Priority 2: discovery and trust

1. concise default help
2. examples-first full help
3. typo suggestions
4. support and web-doc links
5. user-facing errors and support bundles
6. status and next-command results
7. deprecation lifecycle

## Priority 3: long-running production workflows

1. progress event model
2. central parallel-progress coordinator
3. Temporal deadlines and ofetch retry policy
4. unstorage checkpoint adapter
5. crash-only startup reconciliation
6. XDG paths and consentful config edits

## Priority 4: distribution and governance

1. compile or package smoke tests
2. install/uninstall validation
3. output-schema versioning
4. telemetry consent
5. offline and remote-config trust tests

# Final assessment

Version 1.0 was already a strong production software architecture. The article shows that “productionized” must also describe the user’s repeated relationship with the command.

The revised definition is:

> A productionized CLI is a portable application boundary with schema-owned data, explicit capabilities, one observable output transport, and a human-first public language that remains discoverable, composable, safe, recoverable, and compatible over time.

# Sources

1. Command Line Interface Guidelines: <https://clig.dev/>
2. Productionized CLI Pattern Guidebook v1.0.
3. Optique: <https://optique.dev/> and <https://github.com/dahlia/optique>
4. LogTape: <https://logtape.org/> and <https://github.com/dahlia/logtape>
5. c12: <https://github.com/unjs/c12>
6. defu: <https://github.com/unjs/defu>
7. std-env: <https://github.com/unjs/std-env>
8. ofetch: <https://github.com/unjs/ofetch>
9. unstorage: <https://github.com/unjs/unstorage>
10. rc9: <https://github.com/unjs/rc9>
11. pathe: <https://github.com/unjs/pathe>
12. ufo: <https://github.com/unjs/ufo>
13. pkg-types: <https://github.com/unjs/pkg-types>
14. nypm: <https://github.com/unjs/nypm>
15. unbuild: <https://github.com/unjs/unbuild>
16. magicast: <https://github.com/unjs/magicast>
17. confbox: <https://github.com/unjs/confbox>
18. ohash: <https://github.com/unjs/ohash>
19. automd: <https://github.com/unjs/automd>
20. changelogen: <https://github.com/unjs/changelogen>
21. Citty: <https://github.com/unjs/citty>
22. Consola: <https://github.com/unjs/consola>
23. Deno compile: <https://docs.deno.com/runtime/reference/cli/compile/>
24. Node single executable applications: <https://nodejs.org/api/single-executable-applications.html>
25. NO_COLOR: <https://no-color.org/>
