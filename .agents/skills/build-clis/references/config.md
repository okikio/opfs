# Configuration resolution

Use this reference for the application-level configuration contract. Load
[c12-defu.md](c12-defu.md) for detailed current c12/defu/jiti behavior and
[defaults-provenance.md](defaults-provenance.md) for default/provenance design.

## Configuration is a staged resolver

Do not model configuration as one deep merge. Keep at least three shapes
separate:

```text
authored layer
  partial values, source syntax, append/prepend/replace operations,
  dynamic factory input, source metadata
        |
        v
resolved sparse patch
  normal project values only, no source-only operations, no product defaults
        |
        v
runtime config
  complete validated values, product defaults/transforms applied
```

Domain code consumes the runtime config. It should never need to know what
`$append`, c12 metadata, or a CLI parser source object means.

## Source owners

List every source and one owner:

```text
programmatic override
CLI argv
environment variables
project config
user config
extends/base configs
secret provider
defaults
```

Do not read the same environment variable through both parser integration and a
separate application env loader unless the product explicitly reconciles the two
sources.

## Precedence versus evaluation order

Public precedence is usually described highest to lowest:

```text
CLI > environment > project > user > defaults
```

Operations such as append/prepend often require implementation evaluation from
lowest to highest so the high-precedence operation receives the already-resolved
inherited value.

```text
file ['a']
 -> env prepend ['env']
 -> CLI append ['cli']
 = ['env', 'a', 'cli']
```

Do not confuse evaluation traversal with precedence.

## Merge algebra

Define each category explicitly.

### Missing and falsy values

`undefined`/absence usually inherits. `false`, `0`, empty string, and empty array
can be valid authored values and must not be dropped by truthiness checks.
`null` needs an explicit product meaning: value, clear/reset, or invalid.

### Objects

Ordinary configuration objects can recursively merge when field semantics allow
it. Do not recursively merge opaque/provider objects merely because they are
objects.

### Arrays

Plain arrays normally express a complete value and replace inherited arrays.
Automatic concatenation makes it hard to clear a list and makes source meaning
ambiguous.

Use explicit operations when the author intends transformation:

```text
replace([...])
append([...])
prepend([...])
```

Operations are serializable authoring data, not arbitrary callbacks.

### Discriminated unions

Mutually exclusive variants normally replace atomically. A `kind: 'named'`
selector must not inherit stale fields from `kind: 'range'`.

### Deletion/reset

If supported, define deletion/reset separately from `undefined`, empty array, or
empty object. Make its representation and provenance visible.

## Dynamic config factories

When c12/jiti evaluates executable config:

- identify the exact factory inputs;
- evaluate once per intended resolution snapshot;
- define async behavior;
- keep discovery separate from final runtime validation;
- do not execute the factory once for bootstrap and again for final parse unless
  double execution is explicitly safe and required;
- avoid observable side effects in config factories where possible.

A second parser/config pass must not turn first-pass defaults into authored
higher-precedence values.

## Defaults

Classify defaults before coding:

- help/documentation default;
- parser representation fallback;
- schema prefault/input substitute;
- product runtime default;
- provider/runtime default.

Apply product defaults once, after sparse-source resolution. Zod `.default()` and
`.prefault()` have different transform/refinement implications; verify the
installed Zod behavior before relying on one.

## Provenance

A useful field decision can explain:

```text
field: log.level
winner: cli --log-level=debug
shadowed:
  env PROJECT_LOG_LEVEL=info
  project config=warn
operation contributions: none
normalized runtime value: debug
```

`config explain` should derive from actual resolver decisions. `config files`
should report all discovered/extended layers, not only the final winning file.

Provenance is data for diagnostics. Do not let it leak secrets. A secret-bearing
source should retain safe source identity without serializing the secret value.

## Failure signatures

| Symptom | Cause to inspect |
|---|---|
| config file never wins against omitted flag | parser default polluted high-precedence patch |
| arrays grow on every layer | accidental deep-merge concatenation |
| union contains fields from two variants | recursive merge instead of atomic replacement |
| empty array cannot clear inherited list | emptiness treated as missing |
| config factory runs twice | multi-pass resolution lifecycle |
| `config explain` disagrees with runtime | provenance computed separately from resolver |
| imported base path resolves from wrong cwd | source-relative path normalization lost |
| defaults bypass transforms/refinements | wrong Zod default/prefault stage |

## Verification matrix

At minimum test:

- missing versus all valid falsy values;
- object recursion;
- array replacement and explicit empty reset;
- append/prepend/replace across three sources;
- atomic discriminated-union replacement;
- aliases/normalization once;
- immutable input objects;
- no authoring operation remaining in runtime output;
- real c12 extends/environment/factory chains;
- factory evaluation count;
- source-relative paths;
- provenance winners/shadowing/operations;
- malformed lower and higher layers;
- final runtime schema defaults/refinements;
- secrets excluded from config explanation.

Ground configuration behavior in the current project handoff and installed
c12/defu/Zod/Optique versions. Do not copy an old merge helper solely because it
exists.
