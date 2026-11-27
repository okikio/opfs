# UnJS runtime and configuration cluster manual

## Contents

- [When to load this reference](#when-to-load-this-reference)
- [Outcome](#outcome)
- [Verified versions and evidence limit](#verified-versions-and-evidence-limit)
- [Capability ownership](#capability-ownership)
- [Recommended integration order](#recommended-integration-order)
- [jiti runtime module loading](#jiti-runtime-module-loading)
- [c12 configuration loading](#c12-configuration-loading)
- [defu merge behavior](#defu-merge-behavior)
- [destr input parsing](#destr-input-parsing)
- [confbox structured formats](#confbox-structured-formats)
- [pkg-types repository metadata](#pkg-types-repository-metadata)
- [pathe filesystem paths](#pathe-filesystem-paths)
- [ufo URLs and query strings](#ufo-urls-and-query-strings)
- [Complete integration patterns](#complete-integration-patterns)
- [Failure signatures](#failure-signatures)
- [Testing and verification](#testing-and-verification)
- [Sources and freshness](#sources-and-freshness)

## When to load this reference

Load this reference when a CLI or developer tool uses, evaluates, discovers,
merges, reads, writes, or validates runtime configuration with any of these
packages:

- jiti;
- c12;
- defu;
- destr;
- confbox;
- pkg-types;
- pathe;
- ufo.

Also load it when a project says only “use the UnJS ecosystem” for config,
paths, package metadata, or URLs. That phrase is not an implementation plan.
Select packages by capability, assign one owner to each concern, and verify the
installed version before copying an API.

Read [c12-defu.md](c12-defu.md) as well when the application needs a
field-specific merge algebra, provenance, declarative array operations, or
separate authoring, sparse-patch, and runtime schemas. Read
[output.md](output.md) when a dependency can write directly to stdout or
stderr.

## Outcome

Following this reference should produce a configuration subsystem in which:

- repository and workspace ownership is discovered deliberately;
- file and URL operations use the correct namespace;
- every enabled config source and precedence edge is explicit;
- executable config is treated as trusted code, never as data parsing;
- syntax parsing is separated from runtime schema validation;
- merge semantics are product policy rather than an accidental defu default;
- config edits state their lossiness and use the product's write-safety policy;
- package versions, export paths, and optional peers are verified;
- library diagnostics do not silently violate the CLI's output contract;
- failure cases are exercised through the public application resolver.

## Verified versions and evidence limit

The APIs in this reference were rechecked on 2026-07-17 against the published
npm artifacts, including each package's export map, README, declarations, and
runtime bundle where behavior was ambiguous.

| Package | Version inspected | npm tag observed | Important status |
| --- | --- | --- | --- |
| jiti | 2.7.0 | `latest` | The synchronous CommonJS-style call is deprecated; use `await jiti.import()` |
| c12 | 4.0.0-beta.5 | `latest` | v4 is still a beta version; npm also exposes `3x` as 3.3.4 |
| defu | 6.1.7 | `latest` | Array concatenation and nullish skipping are default behavior |
| destr | 2.0.5 | `latest` | “Strict” is not identical to the JSON grammar |
| confbox | 0.2.4 | `latest` | JSONC parsing is fault tolerant unless errors are inspected |
| pkg-types | 2.3.1 | `latest` | Types and readers do not perform application schema validation |
| pathe | 2.0.3 | `latest` | Normalizes filesystem paths to `/`; it is not a containment check |
| ufo | 1.6.4 | `latest` | Parsing and normalization are permissive utilities, not URL authorization |

Historical CLI and database-tooling reviews provide the following anonymized
ownership examples. Paths are illustrative local owners, not upstream exports
or a required repository layout:

- the example root resolved c12 4.0.0-beta.5 and defu 6.1.7 while its Deno import map
  also contains c12 3.3.4;
- `packages/config/deno.json` selects jiti 2.7.0 and c12 4.0.0-beta.5;
- `packages/config/src/index.ts` uses c12 behind an application resolver,
  disables unwanted sources, validates authored layers, keeps patches sparse,
  and applies Zod defaults only after merging;
- `packages/config/src/merge.ts` uses `createDefu()` only as the recursive
  engine beneath explicit array and atomic-union policy;
- the ClickHouse tooling uses both `createJiti()` and c12, then validates the
  imported value before migrations, seeds, or connections can consume it.

These examples describe ownership, not maintained application APIs. Their local
helpers, schemas, array operation language, and package aliases are not exports
from UnJS packages.

Do not cross-apply c12 v4 examples to c12 3 without checking the resolved
declarations. In v4, `chokidar`, `giget`, `jiti`, `magicast`, and some dotenv
support moved behind optional peer paths. In c12 3.3.4, several of those are
ordinary dependencies. A lockfile containing both versions does not make their
runtime behavior interchangeable.

## Capability ownership

| Owner | Owns | Does not own |
| --- | --- | --- |
| application schema | Accepted authored values, sparse patches, complete runtime config, transformations, defaults | File discovery or module evaluation |
| application resolver | Enabled sources, trust, precedence, merge policy, provenance, path bases, reload policy | Format-specific parser implementation |
| jiti | TypeScript/ESM-compatible module resolution, transformation, and evaluation | Sandboxing, config trust, precedence, or runtime validation |
| c12 | Config discovery, supported format loading, source layers, `extends`, environment branches, optional dotenv, watch/update plumbing | Domain schema, safe remote-code policy, or product merge semantics |
| defu | Recursive leftmost-priority default merge and custom merger callback | A complete patch language, deletion semantics, or atomic union ownership |
| destr | Convenient JSON-like scalar/value parsing with prototype-pollution defenses | Exact JSON validation, runtime type validation, or shell tokenization |
| confbox | JSON, JSON5, JSONC, YAML, TOML, and INI parsing/serialization | Semantic validation or lossless comment-preserving edits |
| pkg-types | Package, tsconfig, git config, lockfile, and workspace discovery/read/write helpers | Repository ownership truth, package-manager policy, or atomic mutation |
| pathe | Cross-platform filesystem path string operations with `/` normalization | Filesystem authorization, symlink resolution, or URL operations |
| ufo | URL/path/query encoding, parsing, joining, and normalization helpers | Origin allowlisting, SSRF prevention, signature identity, or filesystem paths |

Keep these ownership rules even though c12 depends on defu, confbox, pathe, and
pkg-types. A transitive dependency relationship does not transfer product
policy to the package.

## Recommended integration order

Use this order for a full configuration resolver:

```text
explicit invocation cwd
  -> pkg-types repository/workspace evidence
  -> application chooses the owning root
  -> pathe resolves configured filesystem paths
  -> c12 discovers only authorized sources
       -> confbox parses structured formats
       -> native import or jiti evaluates trusted code config
       -> c12 resolves explicitly allowed environment/extends layers
  -> application validates every retained authored layer
  -> application converts sources to sparse patches
  -> explicit defu-based merger applies product field semantics
  -> application removes loader-only keys
  -> application validates the resolved sparse patch
  -> runtime schema applies defaults and transformations once
  -> ufo handles URL/query fields at their owning parser
  -> complete runtime config plus provenance reaches commands
```

`destr` is not a mandatory stage. Use it only for a deliberately ergonomic
single value, such as an environment or CLI value that may be `true`, `42`,
`null`, an array, or an object. Do not run complete config documents through
destr when confbox, c12, or an exact JSON parser owns the format.

## jiti runtime module loading

### Current imports and APIs

The verified ESM entry point is:

```ts
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
	interopDefault: true,
	moduleCache: true,
	sourceMaps: false,
});

const value = await jiti.import<unknown>("./tool.config.ts", {
	default: true,
});
```

The second argument to `jiti.import()` accepts resolution conditions,
`parentURL`, `try`, and the `{ default: true }` shortcut. That shortcut returns
`module.default ?? module`; it does not validate the export.

Use the async API for new code:

```ts
const module = await jiti.import<unknown>(absoluteConfigPath);
const resolved = jiti.esmResolve("./schema.ts");
```

The callable `jiti(id)` and `jiti.resolve()` APIs emulate CommonJS `require()`
and are deprecated in the 2.7.0 declarations. Do not introduce them merely to
avoid making a loader async.

Other verified entry points are:

| Import | Purpose | Owner |
| --- | --- | --- |
| `jiti/register` | Global Node module hook | Requires Node newer than 20 according to the published docs; affects the process globally |
| `jiti/native` | The same high-level API backed by native `import()` and `import.meta.resolve()` | Use only when the runtime natively accepts the selected syntax |
| `jiti/static` | Static entry supplied by the package | Confirm the installed behavior before treating it as a dynamic transformer replacement |

### Verified option surface

| Option | Verified 2.7.0 behavior | Decision rule |
| --- | --- | --- |
| `fsCache?: boolean \| string` | Enabled by default; `true` selects `node_modules/.cache/jiti` when available or a temp cache | Choose an explicit writable cache for constrained runtimes; treat cached transformed code as execution state |
| `rebuildFsCache?: boolean` | Rebuilds the filesystem transform cache | Use for controlled invalidation, not on every production invocation |
| `moduleCache?: boolean` | Enabled by default and integrates with the native CommonJS cache | Disable deliberately for reload tests; understand repeated module side effects first |
| `debug?: boolean` | Emits verbose jiti diagnostics | It writes through jiti's own console path, so it can violate a LogTape-only output contract |
| `sourceMaps?: boolean` | Adds inline source maps to transformed output | Enable when stack fidelity outweighs transformed-source size |
| `interopDefault?: boolean` | Defaults to true and proxies module/default exports for mixed ESM/CJS compatibility | Prefer explicit export contracts for config; test namespace and default behavior during upgrades |
| `extensions?: string[]` | Controls resolvable/transformed extensions | Narrowing is safer than accepting syntax the product never documents |
| `transform` and `transformOptions` | Replace/configure transformation | This is compiler ownership; use only with executable tests for the selected syntax |
| `alias?: Record<string, string>` | Rewrites module IDs during resolution | Validate aliases and allowed roots; aliases are not a security trust transition |
| `tsconfigPaths?: boolean \| string` | Disabled by default; `true` discovers a tsconfig, string selects one | Prefer an explicit path in monorepos to avoid adopting a neighboring package's aliases |
| `nativeModules?: string[]` | Adds modules to the native-load set | Do not use it to bypass validation of a loaded config export |
| `transformModules?: string[]` | Forces named modules through transformation | Pin and test; transforming dependencies can change runtime and cache behavior |
| `tryNative?: boolean` | Tries native loading before transformation; enabled by default when Bun is detected | Exercise native and transformed paths if the product supports several runtimes |
| `importMeta?: ImportMeta` | Supplies parent import metadata for `jiti/native` | Use the actual owning module, not a synthetic unrelated base |
| `esmEvalTempFile?: boolean` | Forces the ESM fallback through a temporary file | Account for temp-directory write permissions and cleanup |
| `jsx?: boolean \| JSXOptions` | Opt-in JSX transform | Config files should not gain JSX unless it is an explicit product feature |
| `virtualModules?: Record<string, unknown>` | Returns preloaded values for matching module IDs | Useful for bundled binaries; validate the map as part of the build contract |

`cache` and `requireCache` remain deprecated aliases for `fsCache` and
`moduleCache`. Do not teach new code the old names.

The published README and declarations do not fully agree about the documented
default list for `nativeModules`. The 2.7.0 runtime builds an internal native
set containing at least `typescript` and `jiti`, then adds user entries. Treat
the runtime bundle as version-specific evidence and do not encode the internal
list into application policy.

### Trust and isolation

jiti executes code with the process's authority. A TypeScript config can read
files, inspect environment variables, open sockets, spawn processes, mutate
globals, and import any dependency available to it. Transformation is not
sandboxing.

Apply these rules:

- evaluate only files within the documented trust model;
- resolve the file and allowed root before importing it;
- do not accept a remote URL or arbitrary package name as a config path;
- validate the returned value immediately as `unknown`;
- keep secrets out of loader diagnostics and thrown source excerpts;
- decide cache behavior for watch mode and tests;
- run genuinely untrusted plugins in an isolated process or stronger sandbox
  with a narrow protocol rather than in jiti.

For default exports, prefer the explicit shortcut and schema validation stage:

```ts
const imported = await jiti.import<unknown>(absolutePath, { default: true });
const authored = AuthoringConfigSchema.parse(imported);
```

Do not write `jiti.import<MyConfig>()` and treat the generic as validation. It
only changes the TypeScript view of the result.

## c12 configuration loading

### v4 default behavior that must be made explicit

For c12 4.0.0-beta.5, the published runtime establishes these defaults:

- `cwd` resolves from `process.cwd()`;
- `name` defaults to `config`;
- `configFile` defaults to `config`, or `<name>.config` for another name;
- `rcFile` defaults to `.<name>rc`, so local RC loading is enabled unless set
  to `false`;
- `globalRc` is opt-in, but can add workspace and user sources when enabled;
- `packageJson` and `dotenv` are disabled unless selected;
- `envName` defaults to `process.env.NODE_ENV`, enabling matching `$test`,
  `$development`, `$production`, or `$env[name]` branches when it is set;
- `extends` processing is enabled unless `extend: false` is passed;
- `omit$Keys` defaults to false;
- defu is the default merger.

This means `loadConfig({ name: "tool" })` is not a neutral “load one file”
call. It can load `.toolrc`, select an environment branch, and resolve
`extends`. State each source policy.

### Narrow application-owned loader

Use a deliberately narrow call when only an explicit project config is part of
the contract:

```ts
import { loadConfig, type ConfigLayer } from "c12";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
	interopDefault: true,
	moduleCache: false,
	fsCache: true,
});

const loaded = await loadConfig<Record<string, unknown>>({
	cwd: projectRoot,
	name: "tool",
	configFile: explicitConfigPath,
	configFileRequired: true,
	rcFile: false,
	globalRc: false,
	packageJson: false,
	dotenv: false,
	envName: false,
	extend: false,
	omit$Keys: true,
	context: {
		cwd: projectRoot,
		configPath: explicitConfigPath,
	},
	import: (id) => jiti.import(id),
	resolveModule: (module) => module?.default ?? module,
	merger: mergeConfigInputs,
});

for (const layer of loaded.layers ?? []) {
	validateAuthoredLayer(layer as ConfigLayer);
}

const filePatch = SparseConfigSchema.parse(loaded.config);
```

The application functions in this example are not c12 exports:

- `mergeConfigInputs` owns field-specific semantics;
- `validateAuthoredLayer` reports source-local schema failures;
- `SparseConfigSchema` prevents defaults from entering precedence early.

If no custom `import` is passed, c12 4 first tries native `import()`, then falls
back to jiti if native loading fails and jiti is installed. `jitiOptions` only
controls that fallback. It has no effect when `import` is supplied.

The default module resolver is effectively `module.default || module`. Use a
custom nullish-aware resolver if falsy default exports are meaningful, then
validate the result.

### Source priority and defaults

c12 documents and implements high-to-low priority in this order:

```text
overrides
  > main config file
  > local/global RC sources
  > selected package.json field
  > defaultConfig
  > extended layers
  > defaults
```

Environment-specific data is applied within each loaded layer. `defaults` is
merged after extension and remains lowest priority. `defaultConfig` participates
before extension. `overrides` is highest priority.

Do not infer that this order matches the product's desired CLI precedence. A
typical application still needs to merge explicit CLI and environment patches
outside c12:

```text
CLI patch
  > supported environment patch
  > c12 file patch
  > runtime defaults
```

Keep every input sparse until the final merge. Applying a defaulted runtime
schema to each layer causes a high-priority layer's defaults to mask authored
values from lower-priority layers.

### Extends and remote sources

The verified `extend` option is either `false` or an object with
`extendKey?: string | string[]`. c12 recognizes local files/directories,
resolvable packages, and remote prefixes supported through giget.

Remote extension is an execution and supply-chain trust transition:

- c12 can download a git/HTTP source through the optional giget peer;
- a source option can request dependency installation;
- private-source auth can be supplied;
- downloaded configuration may then be evaluated as code;
- cached clone location, ref mutability, redirects, integrity, credentials,
  offline behavior, and transitive install scripts become product concerns.

Use `extend: false` when inheritance is not a product feature. When only local
or installed presets are allowed, set `giget: false`, validate the authored
`extends` grammar before resolution where possible, pin installed preset
versions, and test traversal/alias cases. A custom c12 `resolve` callback that
returns `null` does not by itself deny a source; the default resolver continues
after an unresolved custom result.

Do not expose remote `extends` to untrusted structured config and hope the final
schema will reject it. Fetching and loading happen before the application sees
the final value.

### Structured formats and dynamic modules

The verified v4 supported extension set is:

```text
.js .ts .mjs .cjs .mts .cts .json .jsonc .json5 .yaml .yml .toml
```

JavaScript and TypeScript config are executable. JSONC, JSON5, YAML, and TOML
are parsed through confbox. c12 does not make either category schema-valid.

Dynamic config functions receive the supplied `context`:

```ts
export default async function config(context: ConfigContext) {
	return {
		root: context.cwd,
		mode: context.mode,
	};
}
```

Factories should be deterministic for a given context, side-effect-light, and
validated immediately after evaluation. c12 does not impose a timeout or
cancellation contract on a config factory.

`createDefineConfig<T>()` is a type-oriented identity helper for object input.
It is not runtime validation and its published type does not cover an
application-specific async factory union. Define an application helper only
when its type exactly matches the authored export contract.

### Dotenv

c12 v4 exposes `loadDotenv()` and `setupDotenv()` and accepts
`dotenv: true | DotenvOptions` in `loadConfig()`.

Verified options include:

- `cwd`;
- `fileName: string | string[]`;
- `interpolate`;
- target `env` object;
- `expandFileReferences` for `_FILE` variables.

When several files are listed, later dotenv files can override values loaded
by earlier dotenv files while pre-existing target environment values are
preserved. `setupDotenv()` writes selected values into the target environment;
`loadDotenv()` returns an object.

Treat dotenv as an explicit mutation and secret-loading policy. `_FILE`
expansion reads and trims file contents. Do not log those values, include them
in provenance output, or enable the feature merely because the runtime is in a
container.

On runtimes without `node:util.parseEnv`, c12 v4 may require the optional
`dotenv` peer. The v4 migration notes specifically call out legacy/Deno
support. Test the exact target runtime rather than assuming Node behavior.

### Watching and updating

`watchConfig()` returns a promise. The correct shape is:

```ts
import { watchConfig } from "c12";

const watcher = await watchConfig({
	cwd: projectRoot,
	name: "tool",
	rcFile: false,
	globalRc: false,
	packageJson: false,
	dotenv: false,
	extend: false,
	onWatch(event) {
		recordConfigFilesystemEvent(event.type, event.path);
	},
	acceptHMR({ getDiff }) {
		return getDiff().length === 0;
	},
	onUpdate({ oldConfig, newConfig, getDiff }) {
		applyValidatedReload(oldConfig, newConfig, getDiff());
	},
});

try {
	useInitialConfig(watcher.config);
} finally {
	await watcher.unwatch();
}
```

The current published README omits `await` in one watcher snippet, but the
4.0.0-beta.5 declaration and runtime are asynchronous. Follow the installed
type.

v4 requires the optional `chokidar` peer for watching. `debounce` accepts a
number or `false`; the runtime default is 100 milliseconds. Decide how invalid
reloads affect the last good config and command lifecycle.

The v4 watcher and some extension paths currently issue internal
`console.warn()` calls for reload/extension failures. This matters for CLIs that
promise LogTape as the sole output transport. Either avoid those paths, isolate
and adapt the library output, or explicitly document the exception after an
executable test. Do not claim complete output routing merely because
application callbacks use LogTape.

`updateConfig()` is imported from `c12/update`, requires the optional magicast
peer, and is marked experimental:

```ts
import { updateConfig } from "c12/update";

const result = await updateConfig({
	cwd: projectRoot,
	configFile: "tool.config",
	createExtension: ".ts",
	onCreate({ configFile }) {
		return userApprovedCreation(configFile)
			? "export default {}\n"
			: false;
	},
	onUpdate(config) {
		config.enabled = true;
	},
});
```

Wrap mutation in the product's consent, dry-run, diff, validation, backup, and
atomic-write contract. The c12 API being able to update a file does not prove
that a particular failure is crash-safe or that every source format is
lossless.

## defu merge behavior

### Exact default semantics

The verified import is:

```ts
import { createDefu, defu, defuArrayFn, defuFn } from "defu";
```

`defu(source, ...defaults)` gives the leftmost values higher priority:

```ts
const result = defu(
	{ server: { host: "127.0.0.1" } },
	{ server: { host: "0.0.0.0", port: 8080 } },
);

// { server: { host: "127.0.0.1", port: 8080 } }
```

Verified behavior that changes config semantics:

- plain objects merge recursively;
- arrays concatenate as `[...higherPriority, ...lowerPriority]`;
- `null` and `undefined` in the higher-priority input are skipped;
- `__proto__` and `constructor` assignments are skipped;
- inputs are not mutated;
- functions, promises, regular expressions, and non-plain objects are treated
  as values rather than recursively merged records.

This is default assignment, not JSON Merge Patch. `null` cannot delete an
inherited value. A plain array does not replace an inherited array. If those
semantics are required, implement them explicitly and test every field class.

### Custom merger callback

`createDefu()` accepts a callback with the current destination object, key,
higher-priority value, and parent namespace. Return `true` only after handling
the field:

```ts
import { createDefu } from "defu";

const replaceArrayFields = new Set([
	"plugins",
	"output.targets",
]);

export const mergeConfigInputs = createDefu(
	(object, key, incoming, namespace) => {
		const path = [namespace, String(key)]
			.filter(Boolean)
			.join(".");

		if (replaceArrayFields.has(path) && Array.isArray(incoming)) {
			object[key] = [...incoming];
			return true;
		}

		return false;
	},
);
```

The namespace is the parent path, not the complete key path. Construct the
complete path with `String(key)`. defu types the key generically and it may be a
symbol; interpolate only after conversion.

Use exact-path checks for discriminated unions and special arrays. A check for
only the final property name can accidentally replace unrelated fields with
the same name.

`defuFn` invokes higher-priority function values with an inherited default.
`defuArrayFn` does so only when the inherited value is an array. These helpers
are executable merge behavior. Do not use them on untrusted authored data or
as an implicit patch language.

### Product-level merge rules

At minimum, decide and test:

| Field shape | Common policy | Why default defu may be wrong |
| --- | --- | --- |
| scalar | highest authored value wins | nullish skipping may hide an intended clear operation |
| nested options | recursive merge | safe only when partial nested values are meaningful |
| ordered array | replace, append, prepend, or declared operation | default concatenation chooses append without user intent |
| set-like array | union with stable order | default concatenation preserves duplicates |
| discriminated union | atomic replacement | recursive merge can produce an impossible mixed variant |
| secret/reference | atomic replacement or explicit clear | partial merge can retain stale credential fields |
| path-bearing object | merge with per-layer base metadata | merging values alone loses the owning directory |

Validate authoring operations before merging, resolve them into ordinary
values, strip operation objects, validate the sparse result, then apply runtime
defaults once.

## destr input parsing

### Exact APIs

```ts
import { destr, safeDestr } from "destr";

const loose = destr(rawValue);
const strictish = safeDestr(rawValue);
```

`destr<T>()` and `safeDestr<T>()` default to `unknown`. A generic type argument
is a compile-time assertion, not validation.

The verified 2.0.5 behavior includes:

- non-string input passes through unchanged;
- case-insensitive `true`, `false`, `undefined`, `null`, `NaN`, `Infinity`,
  and `-Infinity` receive built-in values;
- a quoted string without escapes is unwrapped quickly;
- loose `destr()` returns an unparseable plain string unchanged;
- `safeDestr()` throws for input it attempts to parse and cannot parse;
- prototype-polluting `__proto__` and dangerous `constructor.prototype` keys
  are rejected or removed depending on strictness.

“Safe” does not mean exact JSON. `safeDestr("TRUE")` returns `true`, and
`safeDestr("undefined")` returns `undefined`. Non-string values still pass
through. Use `JSON.parse()` or confbox `parseJSON()` when exact JSON syntax is
the contract.

Use destr for an explicitly ergonomic input parser, followed by a schema:

```ts
import { safeDestr } from "destr";
import * as z from "zod";

const DefineValueSchema = z.union([
	z.string(),
	z.number().finite(),
	z.boolean(),
	z.null(),
	z.array(z.unknown()),
	z.record(z.string(), z.unknown()),
]);

export function parseDefineValue(input: string): z.output<typeof DefineValueSchema> {
	return DefineValueSchema.parse(safeDestr(input));
}
```

Do not use destructuring terminology to confuse destr with a config loader. It
does not discover files, track sources, apply precedence, or provide a schema.

In non-strict mode, destr 2.0.5 can emit an internal `console.warn()` when it
drops suspicious keys. That can violate a structured-output contract. For
untrusted values, use a strict path plus application error mapping, or isolate
the parser behavior and verify the actual output channels.

## confbox structured formats

### Current imports

All verified parsers and serializers are exported from `confbox`:

```ts
import {
	parseINI,
	parseJSON,
	parseJSON5,
	parseJSONC,
	parseTOML,
	parseYAML,
	stringifyINI,
	stringifyJSON,
	stringifyJSON5,
	stringifyJSONC,
	stringifyTOML,
	stringifyYAML,
} from "confbox";
```

Format-specific subpaths are also public:

```ts
import { parseJSONC } from "confbox/jsonc";
import { parseYAML } from "confbox/yaml";
```

c12 v4 uses those subpaths internally for structured config formats.

### Parse, validate, then resolve

Every confbox generic is type-only. Parse as `unknown`, inspect syntax errors
where the parser supports them, then run the application schema.

JSONC is deliberately fault tolerant. Reject collected errors explicitly:

```ts
import {
	parseJSONC,
	type JSONCParseError,
} from "confbox/jsonc";

export function parseConfigJSONC(text: string): unknown {
	const errors: JSONCParseError[] = [];
	const value = parseJSONC<unknown>(text, {
		allowTrailingComma: true,
		disallowComments: false,
		allowEmptyContent: false,
		errors,
	});

	if (errors.length > 0) {
		throw new SyntaxError(
			`Invalid JSONC at offsets ${errors.map((error) => error.offset).join(", ")}`,
		);
	}

	return value;
}
```

If `errors` is omitted, malformed JSONC can return a partial value. A later
runtime schema with defaults may then accept the partial value and hide the
syntax error. c12 4's built-in JSONC loader calls confbox without exposing the
error array. If strict JSONC syntax is a product requirement, preflight the
selected file, restrict the format, or provide a loader path that preserves
parse diagnostics.

### Format capabilities and lossiness

| Format | Parser options verified | Round-trip warning |
| --- | --- | --- |
| JSON | `reviver` plus indentation/whitespace metadata options | Indentation and surrounding whitespace can be preserved on the parsed object; comments are not JSON |
| JSONC | comment/trailing-comma/empty-content flags and error collection | Comments and trailing commas are not preserved after parse/stringify |
| JSON5 | reviver; serializer replacer, space, and quote | Do not assume source comments or exact lexical choices survive |
| YAML | filename, warning hook, schema, JSON compatibility, listener; many serializer layout options | Multi-document input is rejected; comments are not preserved |
| TOML | parse and stringify | Comments and indentation are not preserved |
| INI | bracketed-array parse option; whitespace, alignment, section, sort, newline, platform, and bracketed-array output options | Style and indentation are not preserved currently |

Common format metadata options include `indent`,
`preserveIndentation`, `preserveWhitespace`, and `sampleSize`. They preserve
limited formatting metadata, not a complete syntax tree. Cloning or replacing
the parsed object can also sever metadata used by a later serializer.

Do not advertise confbox as a lossless editor. For human-authored config:

1. obtain explicit authorization to edit;
2. parse and validate the original;
3. disclose format lossiness;
4. produce a reviewable diff or dry run;
5. validate the new text;
6. write through an application-owned atomic strategy;
7. reload through the public resolver.

## pkg-types repository metadata

### Verified package and workspace APIs

```ts
import {
	findPackage,
	findWorkspaceDir,
	readPackage,
	resolveLockfile,
	type PackageJson,
} from "pkg-types";

const workspaceCandidate = await findWorkspaceDir(invocationCwd, {
	tests: ["workspaceFile", "gitConfig", "lockFile", "packageJson"],
	workspaceFile: "furthest",
	gitConfig: "closest",
	lockFile: "furthest",
	packageJson: "furthest",
});

const packageFile = await findPackage(invocationCwd);
const unvalidatedPackage: PackageJson = await readPackage(invocationCwd);
const lockfile = await resolveLockfile(invocationCwd);
```

`findWorkspaceDir()` checks these marker classes by default:

1. farthest workspace file, including pnpm, Lerna, Turbo, Rush, Deno JSON/JSONC;
2. closest `.git/config`;
3. farthest supported lockfile;
4. farthest package file.

The first successful heuristic wins. That is useful evidence, not repository
ownership truth. A nested independent project, a checked-in lockfile, or a
monorepo tool file above the intended package can change the result. Compare
the candidate with repository instructions, workspace membership, manifests,
and the operation's intended scope.

`findPackage()` and `readPackage()` support `package.json`, `package.json5`, and
`package.yaml`. The JSON-only variants are `resolvePackageJSON()`,
`readPackageJSON()`, and `writePackageJSON()`.

Other verified helpers include:

- `readTSConfig()`, `writeTSConfig()`, and `resolveTSConfig()`;
- `findFile()`, `findNearestFile()`, and `findFarthestFile()`;
- `readGitConfig()`, `writeGitConfig()`, `parseGitConfig()`, and
  `stringifyGitConfig()`;
- `sortPackage()` and `normalizePackage()`;
- `updatePackage()`;
- identity type helpers `definePackageJSON()`, `defineTSConfig()`, and
  `defineGitConfig()`.

### Validation, cache, and writes

The `PackageJson` and `TSConfig` interfaces are broad static types. The readers
return values with those types but do not prove application invariants. Parse
the fields the command depends on:

```ts
const requestCache = new Map<string, Record<string, unknown>>();

const manifest = OwnedManifestSchema.parse(
	await readPackage(packageRoot, { cache: requestCache }),
);
```

`cache` accepts a boolean or a map. With `true`, pkg-types uses its module-level
cache. A long-lived watch process or a command that writes then rereads a file
can observe stale data unless it owns and invalidates a request-scoped map.

`updatePackage()` reads the package, gives the callback a proxy, and writes the
result in the same format. Accessing common map properties such as
`dependencies` or `scripts` can auto-create an empty object. This is convenient
but still a mutation:

```ts
import { updatePackage } from "pkg-types";

await updatePackage(packageRoot, (pkg) => {
	pkg.scripts.verify = "deno task verify";
	return pkg;
});
```

The verified 2.3.1 implementation writes directly with `writeFile`; it does not
claim an atomic temp-file/rename protocol. Its parsers and serializers also
inherit confbox's lossiness. For crash-safe or comment-sensitive edits, build a
product-owned mutation transaction instead of claiming `updatePackage()` alone
is safe.

Do not let pkg-types choose the package manager, authorize dependency changes,
or decide which workspace is publishable. It reports metadata and path
evidence.

## pathe filesystem paths

### Exact imports and behavior

```ts
import {
	basename,
	delimiter,
	dirname,
	extname,
	isAbsolute,
	join,
	matchesGlob,
	normalize,
	parse,
	relative,
	resolve,
	sep,
} from "pathe";
```

pathe 2.0.3 mirrors the Node path API shape while normalizing operations to
forward slashes across platforms. `sep` is always `/`. `delimiter` remains
platform-specific (`;` on Windows and `:` elsewhere). Explicit `posix` and
`win32` variants are exported.

Additional alias helpers live under `pathe/utils`:

```ts
import {
	filename,
	normalizeAliases,
	resolveAlias,
	reverseResolveAlias,
} from "pathe/utils";
```

Do not use a filesystem path utility for URLs. A colon, query string, percent
encoding, UNC prefix, or drive letter has different meaning across namespaces.

### Containment is application policy

String resolution is only the first containment stage:

```ts
import { isAbsolute, relative, resolve } from "pathe";

export function resolveContainedPath(root: string, authored: string): string {
	const candidate = resolve(root, authored);
	const fromRoot = relative(root, candidate);

	if (
		fromRoot === ".." ||
		fromRoot.startsWith("../") ||
		isAbsolute(fromRoot)
	) {
		throw new TypeError(`Path escapes the configured root: ${authored}`);
	}

	return candidate;
}
```

This rejects obvious lexical traversal only. For security-sensitive paths,
also account for:

- symlinks and junctions using the host filesystem's canonical path;
- a not-yet-created file whose existing parent is a symlink;
- Windows drive and UNC semantics;
- case-insensitive filesystems;
- race conditions between validation and use;
- the difference between a display path and canonical identity.

`normalize()`, `resolveAlias()`, and `matchesGlob()` do not authorize a path.
Aliases can redirect imports and globs can match more than expected. Apply
allowed-root and file-kind checks after resolution.

## ufo URLs and query strings

### Current parsing and composition APIs

```ts
import {
	encodeParam,
	filterQuery,
	getQuery,
	hasProtocol,
	isScriptProtocol,
	joinRelativeURL,
	joinURL,
	normalizeURL,
	parseQuery,
	parseURL,
	resolveURL,
	stringifyParsedURL,
	stringifyQuery,
	withBase,
	withQuery,
} from "ufo";
```

Use helpers according to the component being manipulated:

- `encodeParam()` encodes a path parameter and also encodes `/`;
- `encodePath()` preserves path separator meaning;
- `encodeQueryKey()` additionally encodes `=`;
- `encodeQueryValue()` uses query-value rules, including space/plus behavior;
- `parseQuery()` returns string or string-array values and ignores
  `__proto__` and `constructor` keys;
- `stringifyQuery()` repeats keys for arrays and omits `undefined` values;
- `withQuery()` merges existing query values with the supplied object, with
  supplied keys replacing existing keys;
- `joinRelativeURL()` resolves `.` and `..` segments;
- `joinURL()` joins segments without relative traversal semantics;
- `resolveURL()` preserves a base URL's query and fragment while resolving
  further segments according to ufo's rules.

Example for a validated application query:

```ts
const parsedQuery = QueryInputSchema.parse(
	parseQuery(rawQuery),
);

const requestPath = withQuery(
	joinURL("/api", encodeParam(resourceId)),
	{
		cursor: parsedQuery.cursor,
		limit: parsedQuery.limit,
	},
);
```

The schema still owns cardinality and types. `parseQuery<{ limit: string }>()`
does not turn repeated `limit` keys into a single value at runtime.

### Security and identity

ufo is permissive. `parseURL("example.com/path")` returns a pathname unless a
default protocol is supplied. Use native `URL` plus application policy when an
absolute network destination is required:

```ts
const base = new URL(AllowedEndpointSchema.parse(config.endpoint));
const target = new URL(joinURL(base.href, encodeParam(resourceId)));

if (target.origin !== base.origin) {
	throw new TypeError("Resolved endpoint changed origin");
}
```

Then apply scheme, hostname, port, DNS/IP, redirect, credential, and private
network policy appropriate to the operation. An origin comparison alone is not
a complete SSRF defense.

The 1.6.4 README shows `isScriptProtocol("javascript:alert(1)")`, but the
published implementation matches an exact protocol token ending in `:`. A
runtime smoke test produced `false` for that full URL and `true` for
`"javascript:"`. Use the parsed protocol:

```ts
const parsed = parseURL(authoredURL);

if (isScriptProtocol(parsed.protocol)) {
	throw new TypeError(`Disallowed URL protocol: ${parsed.protocol}`);
}
```

Even this is a denylist for `blob:`, `data:`, `javascript:`, and `vbscript:`.
Use a positive scheme/origin allowlist for privileged requests or links.

Do not normalize identity-bearing URLs casually:

- `normalizeURL()` changes encoding and path presentation;
- `cleanDoubleSlashes()` can change embedded URL-like path data;
- `isSamePath()` ignores trailing-slash and encoding differences;
- `isEqual()` ignores leading slash, trailing slash, and encoding differences
  unless strict comparison options are enabled;
- `decode()` returns the original string when decoding fails.

These conveniences can be wrong for signatures, OAuth redirect matching,
cache keys, crawl deduplication, opaque user identifiers, or presigned URLs.
Preserve the original string and define canonicalization as a versioned product
contract before hashing, signing, or comparing.

`$URL` and `createURL()` are deprecated in 1.6.4. Use native `URL` or
`parseURL()` as the declarations direct.

## Complete integration patterns

### Trusted TypeScript config in a monorepo CLI

```text
invocation cwd
  -> pkg-types returns workspace candidates and manifest evidence
  -> repository instructions select the owning package/root
  -> pathe resolves the explicit config under that root
  -> lexical and canonical containment checks pass
  -> c12 loads one required config with RC/package/dotenv/env disabled
  -> custom jiti import evaluates the trusted TypeScript module
  -> c12 inheritance is disabled or restricted by declared policy
  -> every authored layer is schema-validated
  -> defu custom merger resolves explicit field semantics
  -> sparse-patch schema rejects loader metadata and operation objects
  -> runtime schema applies defaults once
  -> command receives runtime config plus config/layer provenance
```

Tests must cover a nested package invocation, an explicit missing file, a
config outside the root, a module with side effects, a bad default export,
array replacement, atomic union replacement, and both c12 lines if both remain
supported.

### Human-authored JSONC config

```text
read original text
  -> confbox parseJSONC with error collection
  -> reject every syntax error
  -> authored schema validation
  -> application mutation on a copy
  -> runtime/sparse schema validation
  -> show lossiness and exact diff
  -> approved atomic write
  -> public c12 resolver reload
  -> compare effective config and provenance
```

Because comments and trailing commas are not preserved, do not call this a
source-preserving edit. If preserving comments is a requirement, select an AST
editor that supports the exact format and verify it with fixtures.

### Config-derived endpoint

```text
c12/confbox/jiti yields unknown config value
  -> URL schema accepts an absolute allowed scheme
  -> native URL parses the authority
  -> ufo encodes application path/query components
  -> native URL resolves against the approved base
  -> origin/network policy validates the result
  -> original and canonical forms remain distinct
  -> redacted diagnostic records the approved destination class
```

Never feed an unvalidated config URL into a fetch client merely because ufo
parsed or normalized it.

## Failure signatures

| Signature | Likely cause | Next inspection |
| --- | --- | --- |
| Required config cannot be resolved | `configFileRequired` is true but the base/path or extension does not resolve | Log the redacted resolved candidate and inspect c12's `configFile`/`_configFile` for the installed version |
| TypeScript config loads on one runtime only | Native import succeeded in one environment while another needed jiti or a different syntax transform | Pin jiti, inspect `jitiOptions`/custom import, and execute both runtime paths |
| Config code runs twice | Module cache disabled, watch reload, or multiple jiti instances/loaders | Trace loader instance and cache ownership; make side effects idempotent or remove them |
| jiti debug lines bypass LogTape | `debug` or `JITI_DEBUG` enabled | Disable it or explicitly adapt/isolate output before claiming a sole transport |
| Unexpected `.toolrc` values | c12 generated an RC name because `rcFile` was not false | Make the RC source policy explicit and report provenance |
| Test/production values appear unexpectedly | `envName` defaulted from `NODE_ENV` | Pass `envName: false` or a validated explicit environment |
| Network or package installation occurs during config load | c12 `extends` reached giget or an install-enabled source | Disable extends/giget, pin presets, and audit source options before loading |
| Watch mode fails to start | c12 v4 optional `chokidar` peer is absent | Install/pin the peer only if watch is a supported capability |
| Watcher object is a promise or fields are undefined | `watchConfig()` was not awaited | Follow the installed declaration, not the faulty README snippet |
| Reload warning bypasses structured diagnostics | c12 watcher emitted internal `console.warn()` | Isolate/adapt the dependency or document and test the exception |
| Array contains inherited and authored entries | defu concatenated arrays | Add a field-specific replace/operation rule and a conflict test |
| Discriminated union contains fields from two variants | defu recursively merged an atomic union | Replace the complete union at its exact path |
| `null` did not clear a value | defu skips nullish higher-priority values | Add an explicit clear operation or choose a patch algebra that defines deletion |
| “Strict JSON” accepted `TRUE`, `NaN`, or `undefined` | `safeDestr()` was mistaken for exact JSON | Use exact JSON parsing and a runtime schema |
| A warning appears while parsing an untrusted scalar | loose destr dropped a suspicious key | Use strict parsing and map the error through the output owner |
| Malformed JSONC becomes `{}` or a partial object | confbox parse errors were not collected and rejected | Pass `errors`, reject non-empty results, and test malformed fixtures |
| Comments disappear after a config edit | confbox serialization is not a lossless AST round trip | Restore the original, disclose lossiness, or use a verified format-specific editor |
| Package metadata stays stale after mutation | pkg-types global/read cache was enabled | Use an invocation-scoped cache and invalidate the changed path |
| Package file is truncated after interruption | pkg-types direct write was treated as atomic | Use an application-owned temp-file, sync, rename, and recovery policy |
| Operation runs at the wrong monorepo root | `findWorkspaceDir()` heuristic found an outer marker | Reconcile markers with workspace membership, instructions, and requested scope |
| Path passes string containment but escapes through a symlink | pathe resolves lexical strings only | Canonicalize the existing root/parent with host filesystem APIs and address races |
| Windows path comparisons differ from display output | pathe normalized separators while another layer used native/canonical form | Select one internal identity and test drive, UNC, case, and separator behavior |
| `isScriptProtocol(fullURL)` returns false | ufo 1.6.4 expects the protocol token, despite its README example | Parse first and call `isScriptProtocol(parsed.protocol)`, then apply an allowlist |
| Signed URL or cache key changes after cleanup | ufo normalization changed encoding or slash identity | Preserve the original; use only the product's versioned canonicalization |

## Testing and verification

### Version and export verification

Record the owning manifest and lockfile result, then inspect exact artifacts:

```bash
npm view jiti version dist-tags
npm view c12 version dist-tags peerDependencies
npm view defu version
npm view destr version
npm view confbox version
npm view pkg-types version
npm view pathe version
npm view ufo version
```

For reproducible source inspection, use the versioned published tarball or a
matching immutable repository tag. Verify imports with the project's own
typechecker; do not infer exports from a website navigation list.

### Resolver matrix

Exercise the application resolver, not only each library:

| Axis | Required cases |
| --- | --- |
| invocation | workspace root, nested package, outside repository, symlinked path |
| source | missing explicit file, TS module, JSON, malformed JSONC, YAML/TOML if supported |
| c12 policy | RC disabled/enabled, package field disabled/enabled, env disabled/named, extends disabled/local/remote-denied |
| jiti | native success, transform fallback, cache on/off, bad export, thrown side effect |
| merge | scalar conflict, nested object, replace/append/prepend array, atomic union, explicit clear |
| validation | bad authored layer, bad merged sparse patch, defaulted runtime config |
| mutation | dry run, rejected consent, validation failure, interrupted write, reload |
| output | stdout result remains clean, diagnostics redacted, dependency warnings accounted for |

### Package-specific executable checks

At the verified versions, smoke tests should prove at least:

```text
defu({ items: ["high"] }, { items: ["low"] })
  -> { items: ["high", "low"] }

defu({ value: null }, { value: 1 })
  -> { value: 1 }

safeDestr("TRUE")
  -> true

parseJSONC(malformed, { errors })
  -> returns a value and fills errors; application rejects it

withQuery("/x?a=1", { a: 2, b: "ok" })
  -> "/x?a=2&b=ok"

isScriptProtocol("javascript:alert(1)")
  -> false in ufo 1.6.4

isScriptProtocol(parseURL("javascript:alert(1)").protocol)
  -> true in ufo 1.6.4
```

These outputs were executed against the version-pinned npm packages while
writing this reference. Keep them as regression expectations only for the
pinned versions; rerun them when versions change.

### Completion standard

Do not report this subsystem verified until:

1. installed versions and optional peers are known;
2. the public resolver passes the source/precedence matrix;
3. every loaded value crosses a runtime schema;
4. merge decisions pass field-specific conflict tests;
5. config edits pass recovery and reload tests;
6. path and URL policies pass adversarial cases;
7. dependency-originated stdout/stderr is observed and reconciled with the
   CLI output contract;
8. the actual command uses the resolved config successfully.

## Sources and freshness

The recorded 2026-07-17 review used primary published artifacts and historical project source.

- jiti 2.7.0: [official repository](https://github.com/unjs/jiti),
  [published tarball](https://registry.npmjs.org/jiti/-/jiti-2.7.0.tgz).
- c12 4.0.0-beta.5: [official repository](https://github.com/unjs/c12),
  [published tarball](https://registry.npmjs.org/c12/-/c12-4.0.0-beta.5.tgz).
- c12 3.3.4 comparison line: npm `3x` tag and
  [published tarball](https://registry.npmjs.org/c12/-/c12-3.3.4.tgz).
- defu 6.1.7: [official repository](https://github.com/unjs/defu),
  [published tarball](https://registry.npmjs.org/defu/-/defu-6.1.7.tgz).
- destr 2.0.5: [official repository](https://github.com/unjs/destr),
  [published tarball](https://registry.npmjs.org/destr/-/destr-2.0.5.tgz).
- confbox 0.2.4: [official repository](https://github.com/unjs/confbox),
  [published tarball](https://registry.npmjs.org/confbox/-/confbox-0.2.4.tgz).
- pkg-types 2.3.1: [official repository](https://github.com/unjs/pkg-types),
  [published tarball](https://registry.npmjs.org/pkg-types/-/pkg-types-2.3.1.tgz).
- pathe 2.0.3: [official repository](https://github.com/unjs/pathe),
  [published tarball](https://registry.npmjs.org/pathe/-/pathe-2.0.3.tgz).
- ufo 1.6.4: [official repository](https://github.com/unjs/ufo),
  [published tarball](https://registry.npmjs.org/ufo/-/ufo-1.6.4.tgz).
- Historical CLI review, adapted into anonymized manifest, configuration
  resolver, merge, and test owners under `packages/config`.
- Historical ClickHouse tooling review, adapted into an anonymized loader
  example for jiti/c12 loading followed by schema validation.

Freshness rules:

- recheck c12 before every update while the selected v4 line remains beta;
- recheck package exports and declarations rather than relying on README code;
- rerun the ufo protocol smoke case until its README and runtime agree;
- rerun confbox malformed JSONC behavior and comment-loss fixtures on update;
- rerun jiti default-export, cache, and runtime-fallback tests on update;
- keep c12 3 and c12 4 expectations separate wherever both resolve in one
  workspace;
- label any API not present in the installed declarations as unresolved rather
  than reconstructing it from ecosystem familiarity.
