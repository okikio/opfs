# Command language and Optique

Use this reference when changing the public command language: commands,
subcommands, options, arguments, aliases, help, completion, manuals, suggestions,
or parser-owned invalid states. For exact current Optique packages and APIs load
[optique.md](optique.md).

## Start from the user language

Before choosing parser combinators, write the command grammar in user terms:

```text
program
  inspect <target>
    --format <human|json|jsonl>
    --verbose / --quiet

  config show
  config explain [field]
  config files

  run <target>
    --dry-run
    --apply
```

Decide:

- nouns/verbs and subcommand depth;
- required/optional positional values;
- aliases and deprecations;
- repeated options;
- positive/negative boolean forms;
- mutually exclusive selectors;
- no-argument behavior;
- destructive/expensive plan/apply flow;
- output and diagnostic controls;
- stable automation-friendly spelling.

Do not design from the handler's internal object shape.

## Parser-owned invalidity

Prevent invalid forms structurally when the parser can express them cleanly:

- exactly one of several authentication modes;
- mutually exclusive `--foo`/`--no-foo` forms;
- a subcommand that requires its own argument;
- repeated or singular options according to the public grammar;
- option choices/enums with parser-aware suggestions.

Keep rules that depend on merged config, environment, dynamic data, or domain
state in the final schema/domain validation. A parser should not load the world
to decide syntax.

## Sparse source contract

A missing option means “this source did not author a value.” It does **not** mean
“insert the product default here.” Preserve absence so lower-precedence sources
can win.

```text
argv missing --timeout
        |
        v
CLI patch has no timeout field
        |
        v
resolver can inherit env/config
        |
        v
final runtime schema applies product default if still missing
```

Help can display a documented default without manufacturing an authored CLI
value. See `defaults-provenance.md`.

## Schema adapters

Parser adapters for Zod/Valibot/Standard Schema can improve value parsing and
help. They do not change ownership:

- parser validates one token/value representation;
- resolver chooses among independent sources;
- final runtime schema validates the complete request.

When composing Zod objects, preserve refinements/transforms/brands/default
semantics. Copying `.shape` can lose object-level constraints. Test the final
schema, not only component schemas.

## Optique ownership when selected

Optique can own:

- typed parser grammar;
- options/arguments/subcommands;
- source contexts supported by the selected packages;
- choices/suggestions;
- help and usage;
- command discovery;
- shell completion;
- manual generation;
- optional prompt, Git, logging, Temporal, time, or schema integrations when
  their packages are selected.

Do not add another command parser for a capability Optique already owns unless
the architecture deliberately isolates two separate CLIs.

Use static registration when bundlers/compiled artifacts need a closed command
graph. Dynamic discovery must be proven in the packaged target.

## Generated surfaces

Help, completion, and manuals should derive from the same command model wherever
possible. Verify:

- root and subcommand help;
- help/version before project configuration loads;
- aliases and deprecated spellings;
- choices/default descriptions;
- typo suggestions;
- shell completion for each claimed shell;
- man-page parity;
- static discovery under bundled/compiled execution.

Generated output needs a drift check or deterministic regeneration step.

## Naming and documentation

Command names should be concrete and script-friendly. Avoid vague verbs such as
`process`, `handle`, or `execute` when the actual operation can be named.

Document non-obvious parser contracts and internal grammar helpers. A private
combinator can encode the rule that prevents an impossible public command form.

## Failure signatures

| Symptom | Likely cause |
|---|---|
| config values ignored unless flag supplied | parser inserted defaults into CLI patch |
| invalid flag combination reaches handler | grammar did not encode structural exclusivity |
| help needs valid project config | bootstrap parser coupled to resolver/execution |
| completion lists stale commands | generated surface not derived/regenerated |
| compiled binary misses subcommands | dynamic discovery not visible to build |
| schema refinement disappears | object reconstructed from `.shape` without reapplying invariant |
| option aliases produce two runtime fields | normalization owner missing |

## Verification

Test parser semantics separately from execution:

1. table/property tests for valid and invalid token sequences;
2. sparse absence/default behavior;
3. aliases/repetition/choices/suggestions;
4. root/subcommand help and version with broken/missing config;
5. completion/manual generation;
6. packaged/compiled command discovery;
7. final runtime schema for cross-source/domain rules.

Version-sensitive Optique behavior must be checked against the installed version
and current official documentation before implementation claims.
