# Naming and Folder Structure Guide

> **Current cross-project rule:** read the applicable [engineering-standards](engineering-standards.md) sections first; inspect headings to select them rather than reading unrelated chapters. This guide remains the detailed naming and placement reference. The current standard owns cross-project `Schema`/`Type`, `get`/`read`, `ctx`, `utils/`, `packages/`, `registry/`, and executable-composition rules.


## Applying the examples

Judge a convention by the reader contract it protects. Namespace-oriented
runtime operations do not require namespace imports for test runners, assertions,
schemas, or types. Keep protocol-required spellings exact. Preserve local
formatting and visible test scenarios; do not create public API documentation or
schemas for trivial private fixtures just to reproduce an example's shape.

Package paths under `@example/` and the illustrated folder layout are fictional.
Use the repository's existing exports, formatter and ownership conventions.

## Purpose

This guide defines how software symbols, files, folders, packages, and executable entry points should be named and organized.

The objective is to make the codebase readable without prior context. Names should reveal what a value represents, what an operation does, which runtime resource owns it, and where an implementation belongs.

This guide separates generic mechanisms, concrete capabilities, declarative
definitions, and executable composition. `utils/`, `packages/`, `registry/`, and
`clis/` are an illustrative application layout. The public `okikio/utils`
workspace instead keeps generic source packages under `packages/*`. Follow the
consumer's actual ownership and dependency graph. Verify source or release
resolution before adopting a package; directory names do not prescribe a taxonomy.

## Core principle

> Use the most concrete plain-English name that accurately describes the domain concept, runtime resource, operation, or result. Organize generic primitives separately from concrete capabilities and executable composition.

A reader should not need to open an implementation to learn whether a so-called worker is a process, thread, browser tab, queue consumer, or orchestration task.


## Current naming contract

The latest cross-project work tightens several rules that older examples in this
guide can predate. Use this section when a later section is less specific.

### Prefer one word, then add only necessary context

Prefer one concrete word when the package, folder, module, type, or namespace
already supplies the rest of the meaning. Use two words when one word is
ambiguous. Use three words only when a real distinction still requires them.
Treat more than three project-owned words as a design warning. Constants are
exempt because protocol and domain keys sometimes need to encode a complete
fixed name.

Avoid vague project-owned words such as `generate`, `execute`, `handle`,
`process`, `manager`, `helper`, `common`, `shared`, `misc`, `data`, `item`,
`thing`, and `worker` when a more exact concept exists. These words are valid
when they are the actual external or platform concept.

Do not use a generic architecture noun when a concrete concept is available. Name the concrete API, process edge, trust zone, transaction scope, module interface, network hop, or ownership point.

`ctx` is acceptable for one well-typed execution context when the surrounding
operation makes its meaning obvious. Do not turn `ctx` into a universal bag of
unrelated services, state, configuration, logging, storage, and resources.

### Schemas own project data shapes

Every Zod schema constant ends in `Schema`.

Project-owned data types inferred from executable schemas normally end in
`Type`:

```ts
export const SourceSchema = z.discriminatedUnion('kind', [
  UrlSourceSchema,
  BlobSourceSchema,
  StreamSourceSchema,
]);

export type SourceType = z.output<typeof SourceSchema>;
```

Do not duplicate a schema-owned record with a hand-written TypeScript interface.
Use an interface or class for behavior, a live resource, or a provider contract.
Behavior contracts use the concrete domain noun without `Type`:

```ts
export interface Writer extends AsyncDisposable {
  write(chunk: Uint8Array): Promise<void>;
}
```

Direct imports are the default for schemas, schema-derived data types, and
individually meaningful constants. Namespace imports are for coherent operation
families whose short call sites become clearer with the namespace.

### Important fields are contracts too

A field deserves documentation when its name and primitive type do not fully
communicate its meaning. Document units, defaults, missing/null meaning,
ownership, provenance, lifecycle state, limits, and terminal conditions where
those details affect behavior. Apply the same rule to important internal fields
such as sequence numbers, cache generations, lease state, parser cursors, and
retirement markers.

## Naming foundations

Names should communicate:

- the domain concept being represented
- the operation being performed
- the runtime resource involved
- ownership and lifecycle when relevant
- whether a value is input, state, success, failure, or a recoverable problem
- whether a module is generic, concrete, declarative, or executable

Prefer complete words by default. Shorter words are appropriate when the surrounding module, namespace, type, and call site all preserve the missing meaning. The shorter form must remain clear both where it is defined and everywhere it is used.

Do not abbreviate merely to save characters. A short name is successful only when a reader can recover its exact meaning without opening the implementation. Use TSDoc or a focused comment to establish domain-specific terminology that is not already obvious.

Prefer:

```ts
const browserProcessCount = 4;
const routeCaptureResult = await captureRoute({ route, browserContext, archiveWriter, signal });
```

Avoid:

```ts
const workerCount = 4;
const res = await run({ route, ctx, writer, signal });
```

## Context-supported short names

A name may be shorter when its surrounding context carries the omitted meaning at both the definition and every usage.

```ts
import * as processPool from '@example/browser/pool';

const pool = processPool.create(options);
await pool.dispose();
```

Here, `processPool.create` makes `create` precise, and the `pool` value remains clear inside a module that operates on one kind of pool.

Short forms are appropriate for:

- a namespace operation whose namespace supplies the domain, such as `lease.acquire` or `facts.extract`
- a local value whose type and containing function make the concept unambiguous, such as `route`, `options`, `result`, or `ctx`
- a filename whose parent folders supply the omitted context, such as `process.ts` inside `browser/pool/`
- an established ecosystem abbreviation whose meaning is stable, such as `URL`, `HTTP`, `CLI`, or `ctx` for a typed execution context

Do not shorten a public symbol when consumers are likely to import it directly and lose the namespace or folder context.

Prefer:

```ts
import * as capture from '@example/browser/capture';

const result = await capture.page({ route, browserContext, archiveWriter, signal });
```

Avoid an ambiguous direct import:

```ts
import { page } from '@example/browser/capture';

const result = await page({ route, browserContext, archiveWriter, signal });
```

A short name must not depend on context available only to its author.

## Concrete domain names

Use names that identify the actual concept rather than a generic role.

Prefer:

```ts
createBrowserProcessPool();
acquireRouteLease();
capturePageArchive();
extractTechnologyFacts();
disposeAnalysisThreadPool();
```

Avoid vague names:

```ts
run();
execute();
handle();
process();
manage();
doWork();
```

Generic verbs are acceptable only when the surrounding namespace makes the operation unambiguous.

```ts
await lease.acquire({ routeId, ownerId, expiresAt });
await workflow.start({ definition, input, signal });
```

In these examples, the namespace supplies the missing domain meaning.

## Functions and methods

Function names should normally begin with a concrete verb and end with the domain object being acted upon.

```ts
createBrowserProcessPool();
getRouteManifest();
readRouteManifestFile();
parseCaptureOptions();
validateArchiveRecord();
normalizeTechnologyEvidence();
writePageArchive();
```

Use verbs consistently:

| Verb | Intended meaning |
| --- | --- |
| `create` | Construct a new value or owned resource |
| `define` | Declare a reusable schema, resource, service, workflow, or policy |
| `get` | Retrieve an already available value, registration, configuration, or resource by identity or location |
| `read` | Consume bytes, text, records, or entries from a file, stream, reader, cursor, or similarly sequential source |
| `parse` | Convert and validate external input into an accepted representation |
| `normalize` | Convert equivalent forms into one canonical representation |
| `resolve` | Select or derive a concrete value from available candidates or dependencies |
| `acquire` | Obtain temporary ownership of a resource or lease |
| `release` | Return explicitly acquired ownership without destroying the underlying system |
| `dispose` | Permanently end ownership and release all associated resources |
| `capture` | Observe and persist browser, network, archive, or page evidence |
| `extract` | Derive structured facts from observed input |
| `detect` | Determine whether defined evidence satisfies a technology or capability definition |
| `enqueue` | Add work to a queue |
| `dequeue` | Remove or lease work from a queue |

Do not use different verbs for the same operation without a semantic reason.

### Prefer `get` over `read` for retrieval

Use `get` when the operation retrieves a value that is already addressable through an identifier, key, registry, map, configuration object, or resolved service.

```ts
getRouteById(routeId);
getCaptureOptions(config);
getBrowserProcess(processId);
getTechnologyDefinition(technologyId);
```

Reserve `read` for operations where reading is part of the actual behaviour, especially files, streams, archive entries, readers, cursors, or sequential records.

```ts
readRouteManifestFile(path);
readArchiveEntry(reader);
readNextQueueRecord(cursor);
```

Prefer `get` when either verb would be technically possible but the caller is conceptually retrieving a value rather than consuming input.

### Avoid generic lifecycle names

Avoid functions such as:

```ts
runWorker();
startManager();
stopHandler();
```

Use the actual resource and lifecycle operation:

```ts
startBrowserProcess();
disposeBrowserProcessPool();
closeRouteQueue();
cancelCaptureTask();
```

## Runtime identifiers

Use `camelCase` for runtime values:

- variables
- functions
- methods
- object properties
- factory functions
- executable operations

```ts
const browserProcessPool = createBrowserProcessPool(options);
const captureResult = await captureDomain({ domain, browserProcessPool, archiveWriter, signal });
```

Names should preserve useful distinctions:

```ts
const route = routeRecord.route;
const normalizedRoute = normalizeRoute(route);
const routeCaptureResult = await captureRoute({ route: normalizedRoute, browserContext, signal });
```

Do not reuse one vague variable through several transformations.

## Types, classes, schemas, and domain abstractions

Use `PascalCase` for:

- type aliases
- interfaces
- classes
- schemas
- domain abstractions
- discriminated-union members

```ts
interface BrowserProcessPoolOptions {}
interface RouteCaptureResource {}

class BrowserProcessPool {}

type RouteCaptureResult = RouteCaptureSuccess | RouteCaptureFailure;

const RouteCaptureOptionsSchema = z.object({
  routeLimit: z.number().int().positive(),
});
```

Use a consistent suffix when it conveys the symbol's role:

| Suffix | Meaning |
| --- | --- |
| `Options` | Caller-controlled configuration |
| `Dependencies` | Required collaborating services or resources |
| `Input` | Operation or workflow input |
| `State` | Mutable or persisted lifecycle state |
| `Record` | Stored, serialized, or transport-oriented data |
| `Result` | Completed operation result, usually success or failure |
| `Success` | Successful result variant |
| `Failure` | Failed result variant |
| `Problem` | Structured issue that may not represent an execution failure |
| `Schema` | Runtime validation schema |
| `Definition` | Declarative description interpreted elsewhere |
| `Resource` | Acquired capability with ownership or disposal semantics |
| `Policy` | Rules that constrain or select behaviour |

Do not add suffixes that repeat information already supplied by the containing namespace or folder.

## Boolean names

Boolean values should read as factual questions or state assertions.

Prefer:

```ts
const isCaptureComplete = true;
const hasArchiveWriter = archiveWriter !== undefined;
const shouldRestartBrowserProcess = captureCount >= restartAfterCaptures;
const canAcquireRouteLease = activeLeaseCount < leaseLimit;
```

Avoid ambiguous booleans:

```ts
const capture = true;
const archive = false;
const restart = true;
const valid = false;
```

Use the prefixes `is`, `has`, `should`, `can`, `was`, or `did` when they clarify the meaning. Do not apply them mechanically when the property already reads naturally.

```ts
const enabled = true;
const required = false;
```

## Collections and indexed values

Pluralize collections and identify keyed structures explicitly when the key matters.

```ts
const routes: readonly Route[] = [];
const routesByDomain = new Map<DomainName, readonly Route[]>();
const technologyDefinitionsById = new Map<TechnologyId, TechnologyDefinition>();
const failuresByCaptureStage = new Map<CaptureStage, readonly CaptureFailure[]>();
```

Avoid names that hide the collection shape:

```ts
const routeData = new Map();
const items = [];
const map = new Map();
```

Use `By<Key>` for lookup structures when it improves comprehension.

## Results, successes, problems, and failures

Use `result` for the complete returned value of an operation.

```ts
const captureResult = await capturePage({ route, browserContext, archiveWriter, signal });
```

Use `success` and `failure` for mutually exclusive operation result variants.

```ts
type CaptureResult = CaptureSuccess | CaptureFailure;
```

Keep `problems` distinct from `failures`:

- A **problem** describes invalid input, incomplete evidence, an unsupported condition, or another issue that can be reported without an execution failure.
- A **failure** means the operation could not complete as intended.

```ts
interface RouteValidationResult {
  readonly acceptedRoutes: readonly Route[];
  readonly problems: readonly RouteProblem[];
}

interface CaptureFailure {
  readonly stage: CaptureStage;
  readonly reason: CaptureFailureReason;
}
```

Avoid collapsing every non-success state into `error`, `issue`, or `outcome`.

## Processes, threads, tasks, and consumers

Do not use `worker` as the primary type name when a more precise runtime resource is known.

Prefer:

```ts
BrowserProcess
AnalysisThread
CaptureTask
RouteQueueConsumer
LighthouseProcess
BrowserTab
BrowserContext
```

Avoid:

```ts
BrowserWorker
AnalysisWorker
CaptureWorker
GenericWorker
```

A descriptive phrase may still use “worker” informally, but public APIs, folders, types, metrics, and lifecycle code should identify the actual resource.

Use `Pool` only for a component that owns or coordinates multiple reusable resources of the same kind.

```ts
BrowserProcessPool
AnalysisThreadPool
```

Do not call a single process, queue, scheduler, or registry a pool.

## Context names

Use `ctx` only for a well-defined execution context whose type makes its contents and lifecycle clear.

```ts
export async function captureRoute(route: Route, ctx: RouteCaptureContext): Promise<RouteCaptureResult> {
  return await ctx.archiveWriter.capture({ route, browserContext: ctx.browserContext, signal: ctx.signal });
}
```

For ordinary objects or dependencies, use a concrete name instead of `ctx`.

```ts
const browserCaptureDependencies = { browserProcessPool, archiveWriter, lighthouse };
```

Avoid abstract names such as `OwnedContext` when the actual concept is an execution context, resource scope, browser session, or workflow context.

## Comments and TSDoc establish terminology

Use names to identify the concept, then use comments and TSDoc to teach the reader what that concept means in the project. Documentation should add the domain meaning, lifecycle, ownership, constraints, or reason that the name alone cannot carry.

Use TSDoc for public symbols and reusable internal contracts:

```ts
/**
 * Resources owned by one route capture.
 *
 * The browser context belongs to the surrounding domain capture and must not be
 * disposed by the route operation. The signal ends only this route capture.
 */
export interface RouteCaptureContext {
  readonly browserContext: BrowserContext;
  readonly signal: AbortSignal;
}
```

Use focused comments for local invariants and non-obvious terminology:

```ts
// A settled route has produced a terminal capture record, even when archival upload is still pending.
const settledRoutes = routes.filter((route) => route.captureState.isTerminal);
```

Document shortened names when the surrounding context makes them valid but the underlying concept is specific. For example, document what `ctx`, `scope`, `lease`, `record`, or `settled` means in that module rather than assuming every reader shares the author's mental model.

Do not use documentation to rescue a fundamentally vague name. Rename the symbol first, then document the remaining domain-specific meaning.

## Namespace imports

Namespace imports are appropriate when they create a small, coherent API that reads naturally at the call site. They also allow exported operations to use shorter names without losing domain context.

```ts
import * as env from '#/env/index.ts';
import * as facts from '#/facts/index.ts';
import * as lease from '#/lease/index.ts';
import * as workflow from '#/workflow/index.ts';
```

```ts
const config = env.parse(input);
const routeLease = await lease.acquire({ routeId, ownerId, expiresAt });
const extractedFacts = facts.extract({ observations, definitions });
const workflowResult = await workflow.start({ definition, input, signal });
```

Prefer short, concrete namespace names. Avoid namespace names that merely repeat a package name, add `Api`, or introduce unexplained terminology.

Use a namespace when:

- the module exposes a related family of operations
- the namespace supplies meaningful context to intentionally short operation names
- multiple imported modules expose common verbs such as `create`, `define`, `get`, `parse`, or `start`
- the resulting call site reads more clearly than a long list of renamed imports

Do not use a namespace to hide an incoherent module or an oversized public API.

### Re-export namespaces deliberately

A namespace import is a runtime module object. Re-exporting it makes the entire selected module surface part of the parent module's public runtime API, so it requires a deliberate API review.

Prefer explicit re-exports when the parent package should expose only selected symbols:

```ts
export { create, define, get } from './pool/index.ts';
export type { Options, Pool, Resource } from './pool/index.ts';
```

When a public namespace is intentional, use the direct ESM namespace re-export and give it a precise name:

```ts
export * as processPool from './pool/index.ts';
```

Avoid importing a namespace and then casually re-exporting the runtime object:

```ts
import * as processPool from './pool/index.ts';

export { processPool };
```

Before re-exporting a namespace, verify:

- every exported runtime symbol is intended to become public
- private implementation details are not exposed through an entry point
- type-only exports are handled intentionally
- the namespace name remains clear to downstream consumers
- no conflicting or duplicated namespace is already exported
- initialization side effects and module cycles have been reviewed
- the resulting package exports remain tree-shakeable in supported builds
- tests cover the public import path, not only the internal module path

Use `import type * as name` when the namespace is needed only for types. Do not turn a type-only relationship into a runtime dependency.

## Constants

Use `UPPER_SNAKE_CASE` only for values that are conceptually fixed constants, protocol constants, environment variable keys, or immutable default limits.

```ts
const DEFAULT_BROWSER_PROCESS_COUNT = 4;
const ARCHIVE_DIRECTORY = '.archive';
const ROUTE_LEASE_HEADER = 'x-example-route-lease';
```

Use `camelCase` for ordinary module values even when declared with `const`.

```ts
const defaultCaptureOptions = CaptureOptionsSchema.parse({});
const supportedProtocols = ['http:', 'https:'] as const;
```

Do not uppercase a value solely because JavaScript uses `const`.

## External and serialized names

Use `camelCase` for internal TypeScript domain models.

Preserve the established naming of external protocols, database records, and serialized formats at the adapter or codec layer.

```ts
const ClickHouseCaptureRowSchema = z.object({
  captured_at: z.string(),
  source_url: z.string().url(),
});

interface CaptureRecord {
  readonly capturedAt: Temporal.Instant;
  readonly sourceUrl: URL;
}
```

Convert explicitly between external and internal forms.

```ts
function parseCaptureRecord(row: ClickHouseCaptureRow): CaptureRecord {
  return { capturedAt: Temporal.Instant.from(row.captured_at), sourceUrl: new URL(row.source_url) };
}
```

Do not allow external naming conventions to spread through the internal domain model.

## Avoid vague and overloaded words

Avoid these names unless their meaning is made precise by an established namespace or domain convention:

- `run`
- `execute`
- `handle`
- `process`
- `manager`
- `helper`
- `util`
- `common`
- `shared`
- `misc`
- `data`
- `item`
- `thing`
- `payload`
- `worker`
- `attempt`
- `outcome`

Prefer the actual concept:

```ts
routeCaptureInput
archiveRecord
browserProcessPool
analysisThread
captureRetry
captureResult
```

`payload` remains appropriate when referring to the protocol-defined body of a message, token, event, or queue record.

## File naming

Use kebab-case for project-owned TypeScript and documentation filenames.

```text
browser-process-pool.ts
route-capture-result.ts
technology-evidence-schema.ts
naming-and-folder-structure-guide.md
```

Avoid:

```text
browser_process_pool.ts
RouteCaptureResult.ts
routeCaptureResult.ts
```

Follow established ecosystem filenames where tools require or strongly conventionally expect them.

```text
deno.jsonc
package.json
tsconfig.json
README.md
AGENTS.md
index.ts
mod.ts
```

Do not rename conventional files merely to enforce kebab-case.

### Name files after their primary concept

A file should have one clear responsibility reflected in its name.

```text
capture-page.ts
capture-page.test.ts
capture-page.schema.ts
capture-page.types.ts
```

Use suffixes only when they help distinguish roles. Avoid repeating the entire parent folder name in every file.

```text
browser/pool/
  create.ts
  pool.ts
  process.ts
  types.ts
```

can be clearer than:

```text
browser/pool/
  create-browser-process-pool.ts
  browser-process-pool.ts
  browser-process.ts
  browser-process-pool-types.ts
```

The surrounding folder already supplies `browser/pool` context.

### Narrow generic filenames are acceptable

Files such as `types.ts`, `schemas.ts`, `constants.ts`, and `errors.ts` are acceptable inside a narrow domain folder.

```text
packages/browser/pool/src/
  index.ts
  pool.ts
  process.ts
  schemas.ts
  types.ts
```

Avoid broad root-level catch-all files such as:

```text
src/helpers.ts
src/utils.ts
src/common.ts
src/misc.ts
src/types.ts
```

Split broad files by domain concept or capability.

### Entry-point files

Use `index.ts` or the repository's established entry-point convention to expose the public API.

Entry points should primarily re-export intentional public symbols. They should not contain large implementations, hidden initialization, or unrelated side effects.

```ts
export { createBrowserProcessPool } from './create.ts';
export type { BrowserProcessPool, BrowserProcessPoolOptions } from './types.ts';
```

Avoid broad wildcard exports when they expose private implementation details or create accidental public APIs.

## Folder naming

Prefer a single concrete word when the parent path already supplies the missing domain context. Use kebab-case only when a multiword name is genuinely required.

Prefer:

```text
packages/
  browser/
    pool/
    capture/
    lighthouse/
  routes/
    queue/
    classify/
  technology/
    detect/
    evidence/
  db/
    clickhouse/
    postgres/
```

Here, `browser/pool/` is precise because the parent establishes that the pool owns browser processes. `technology/detect/` is clearer and shorter than repeating `technology` in `technology-detection/`.

Use a multiword folder when:

- one word would be ambiguous among siblings
- the concept is an established compound term, such as `service-worker`
- removing a word would misidentify the runtime resource or capability
- the folder is consumed independently and loses the parent path's context
- an existing package export or ecosystem convention uses the compound name

```text
packages/
  browser/
    service-worker/
  analysis/
    thread-pool/
  routes/
    priority-queue/
```

Do not shorten a folder into a vague architectural placeholder.

Avoid:

```text
core/
base/
common/
shared/
misc/
stuff/
```

Also avoid redundant or inflated names:

```text
browser-process-management-system/
shared-common-utilities/
clickhouse-database-adapter-package/
redpanda-message-queue-resource-implementation/
```

The folder hierarchy should carry context without repeating every ancestor in each descendant. Prefer `browser/pool/` over `browser/browser-process-pool/`, but keep `process-pool/` when the folder appears without enough browser context or must be distinguished from another pool.

### Underscore-prefixed files and folders

Use a leading underscore only when the containing tree has automatic discovery semantics and ordinary sibling names are interpreted as commands, routes, plugins, tasks, migrations, or another executable registration.

In that setting, the underscore means:

> This entry supports discovered modules but must not itself be discovered as one.

For example, when every ordinary file under `commands/` becomes a CLI command:

```text
clis/main/src/commands/
  browser/
    archive.ts
    wacz.ts
    _options.ts
    _output.ts
```

When discovery works at the folder level, prefix the supporting folder instead:

```text
app/routes/
  imports/
    index.ts
    $importId.ts
    _components/
    _schemas/
```

Use the narrowest semantic name after the underscore:

```text
_options.ts
_output.ts
_schema.ts
_components/
_format/
```

Avoid generic underscore names unless the folder is genuinely narrow and local:

```text
_shared/
_helpers/
_utils/
_private/
_internal/
```

An underscore prefix does **not**:

- create JavaScript or TypeScript privacy
- prevent direct imports
- replace package export controls
- make an unstable API safe to expose
- justify keeping reusable implementation inside a CLI or route tree

Before using an underscore prefix, verify:

- the loader or framework actually ignores underscore-prefixed entries
- tests cover discovery so support modules cannot become commands or routes accidentally
- the prefixed module is local support code rather than a reusable capability
- reusable logic has been moved into `packages/` or `utils/`
- the entry is not exported through a public package entry point
- one underscore is sufficient; use double-underscore names only when a tool requires them

Do not add underscore prefixes in ordinary module trees merely to signal “private.” In non-discovered code, use focused package entry points, explicit exports, and normal concrete names to define the public API.

## Organize by capability and domain

Prefer folders that group code by the capability delivered to callers.

```text
packages/browser/capture/
  src/
    capture-domain.ts
    capture-page.ts
    capture-route.ts
    index.ts
    schemas.ts
    types.ts
```

Avoid organizing the entire repository by technical artifact type:

```text
src/
  classes/
  functions/
  interfaces/
  schemas/
  types/
```

Technical groupings such as `schemas.ts` or `types.ts` remain useful inside a focused domain folder. They should not replace domain-oriented architecture.

## Root architecture

The following example application layout illustrates a library-first dependency direction:

```text
clis/
  ↓
packages/
  ↓
utils/
```

`registry/` should remain declarative and depend only on the foundational contracts required to define registrations. It should not become an executable orchestration layer.

The essential responsibilities are:

| Root | Responsibility |
| --- | --- |
| `utils/` | Generic, reusable, platform-level primitives |
| `packages/` | Concrete capabilities, integrations, and product domain implementations |
| `registry/` | Declarative definitions and registrations consumed by interpreters or packages |
| `clis/` | Argument parsing, dependency selection, executable composition, terminal output, signals, and exit codes |

Dependencies should point toward more foundational layers. Generic code must not import concrete integrations or CLI modules.

## `utils/`

In this application layout, `utils/` contains reusable primitives that do not know about the product or its domain. The utility repository packages these same ownership roles under `packages/*`.

Appropriate examples:

```text
utils/
  async/
  codecs/
  env/
  headers/
  http/
  iterators/
  lifecycle/
  problem/
  query/
  resource/
  schema/
  streams/
  workflow/
```

A utility may define contracts and composition primitives that concrete packages implement.

```text
utils/resource/
  define.ts
  scope.ts
  types.ts
```

Do not place concrete integrations in `utils/`:

```text
utils/browser-process-pool/
utils/clickhouse/
utils/clerk/
utils/redpanda/
utils/wacz/
```

Those belong in `packages/`.

### Utility naming test

A generic mechanism can be described accurately without the current product or a specific business domain. In the illustrated application layout it belongs in `utils/`; in the utility workspace it is a focused package under `packages/*`.

If removing the domain name makes the API vague or misleading, preserve that domain in the capability's name and contract. Its directory follows the target repository's model.

## `packages/`

In the illustrated application layout, `packages/` contains concrete capabilities and domain implementations usable independently from a CLI. This is not a restriction on a generic library workspace's `packages/*` directory.

Appropriate examples:

```text
packages/
  analysis/
    thread-pool/
  archive/
    wacz/
  authentication/
    clerk/
  browser/
    capture/
    lighthouse/
    pool/
  db/
    clickhouse/
    postgres/
  queue/
    redpanda/
```

A package may implement a generic contract from `utils/`, compose several utilities, and expose a focused public API.

A package must not depend on `clis/` for parsing, configuration, execution, output, or lifecycle management.

### Package structure

Follow established repository patterns first. When no stronger local convention exists, prefer a structure similar to:

```text
packages/browser/pool/
  deno.jsonc
  package.json
  src/
    create.ts
    index.ts
    pool.ts
    process.ts
    schemas.ts
    types.ts
  tests/
    pool.test.ts
    process.test.ts
```

Keep public contracts and entry points easy to find. Keep implementation files close to the domain concept they implement.

Do not introduce nested `src/` folders mechanically when the package is too small to benefit from them or when the repository uses a different established layout.

## `registry/`

`registry/` contains declarative definitions that are discovered, indexed, validated, or interpreted elsewhere.

Appropriate examples include technology definitions, extractor registrations, fact definitions, and policy registrations.

A registry module should primarily declare data and definitions:

```ts
export const analyticsTechnologyDefinitions = [
  defineTechnology({ id: 'google-analytics', category: 'analytics', evidence: googleAnalyticsEvidence }),
] as const;
```

Avoid placing runtime orchestration, browser ownership, queue consumption, persistence, or CLI parsing in a registry module.

Prefer explicit registry names:

```text
registry/technologies/
registry/extractors/
registry/facts/
```

Avoid vague names such as:

```text
registry/items/
registry/data/
registry/misc/
```

## `clis/`

`clis/` contains executable interfaces that compose public library APIs.

Appropriate responsibilities include:

- parsing commands and flags
- loading CLI-specific configuration
- selecting package implementations
- wiring dependencies
- converting process signals into cancellation
- formatting terminal output
- selecting exit codes

```text
clis/
  main/
    src/
      commands/
        browser-wacz.ts
        commoncrawl-import.ts
      index.ts
```

CLI command names should identify the user-visible operation.

Prefer:

```text
browser-wacz.ts
commoncrawl-import.ts
technology-detect.ts
```

Avoid:

```text
run.ts
execute.ts
handler.ts
command.ts
```

The CLI should delegate core work to `packages/`.

```ts
const captureResult = await browserCapture.captureDomain({ domain, routeManifest, archiveWriter, signal });
```

Do not implement the browser capture, archive writer, queue, extractor, or detection engine directly inside the command module.

## Dependency rules

For the illustrated application layout, the expected dependency direction is:

```text
clis → packages → utils
          ↓
       registry
```

The exact relationship with `registry/` depends on the definition being consumed, but registries should remain declarative and foundational rather than importing executable orchestration.

Within that layout, prohibited dependency directions include:

```text
utils → packages
utils → clis
packages → clis
registry → clis
```

Avoid circular package dependencies. When two packages require the same contract, move the generic contract to an appropriate `utils/` module or a narrowly scoped foundational package.

Do not create a generic `shared/` package merely to break a cycle. Name and locate the extracted contract according to its actual responsibility.

## Imports and module paths

Use ESM and explicit TypeScript file extensions.

```ts
import { captureRoute } from './capture-route.ts';
import { RouteSchema } from '#/contracts/routes/schema.ts';
```

Use the current source alias:

```ts
import { RouteSchema } from '#/contracts/routes/schema.ts';
```

Do not use the obsolete alias:

```ts
import { RouteSchema } from '#src/contracts/routes/schema.ts';
```

Prefer package exports or source aliases over deep relative paths.

```ts
import { defineResource } from '@example/resource';
import { RouteSchema } from '#/contracts/routes/schema.ts';
```

Avoid:

```ts
import { RouteSchema } from '../../../../contracts/routes/schema.ts';
```

Use `import type` for type-only imports when required by the compiler configuration and `verbatimModuleSyntax`.

## Public APIs and exports

Public APIs should expose focused contracts, factories, schemas, and types.

Prefer focused package entry points:

```text
@example/browser/capture
@example/browser/pool
@example/db/clickhouse
```

Avoid one giant package entry point that exposes unrelated implementations and creates accidental coupling.

Use explicit exports when they make the supported API clear.

```ts
export { createBrowserProcessPool } from './create.ts';
export { BrowserProcessPoolOptionsSchema } from './schemas.ts';
export type { BrowserProcessPool, BrowserProcessPoolOptions } from './types.ts';
```

Do not preserve obsolete aliases, duplicate exports, or compatibility wrappers unless backward compatibility is explicitly required.

### Service definitions and published contract packages

An owning service can keep its pure endpoint schemas and definitions next to
the operations that use them. `packages/contracts/` is a public export facade
for those **same** source definitions, generated OpenAPI, and optional clients.
It must not author a duplicate catalog that the service imports to discover
its own routes. Keep the pure contract dependency graph separate from runtime
handlers, process configuration, and resource acquisition. Choose a focused
`definition.ts` or a cohesive endpoint module from actual use, not from a
mandatory multi-level folder template.

## Practical decision table

| Question | Preferred decision |
| --- | --- |
| Is the name generic or ambiguous? | Replace it with the concrete domain concept or runtime resource |
| Can the name be shorter without losing meaning at its definition or call sites? | Use the shorter form and preserve context through the namespace, type, module, or documentation |
| Does an operation retrieve an addressable value? | Prefer `get`; reserve `read` for files, streams, cursors, and sequential sources |
| Is the value executable at runtime? | Use `camelCase` |
| Is it a type, schema, class, or domain abstraction? | Use `PascalCase` |
| Is it a true fixed constant or protocol key? | Use `UPPER_SNAKE_CASE` |
| Can the parent path make a folder name unambiguous? | Prefer one concrete word; use multiword kebab-case only when needed |
| Is the entry inside an auto-discovered command, route, or plugin tree but should not be discovered? | Prefix the narrowest support file or folder with `_` and verify the loader ignores it |
| Is it a short project-owned filename or a genuinely multiword folder? | Use kebab-case |
| Does the module work without product-specific knowledge? | Consider `utils/` |
| Does it implement a concrete capability or integration? | Place it in `packages/` |
| Is it a declarative definition interpreted elsewhere? | Place it in `registry/` |
| Does it parse commands or compose an executable? | Place it in `clis/` |
| Is a folder named `shared`, `common`, or `misc`? | Identify and use its actual responsibility |
| Is a resource called a worker? | Name the actual process, thread, task, tab, or queue consumer |
| Is a package importing CLI code? | Move the reusable logic into the package and keep CLI composition separate |
| Does a namespace improve the call site's meaning? | Use a short, concrete namespace and keep its exported operations coherent |
| Is an imported namespace being re-exported? | Review the complete runtime API and prefer explicit exports unless the namespace is intentionally public |

## Review checklist

Before accepting naming or structural changes, verify:

- Names identify concrete domain concepts, operations, and runtime resources.
- Shortened names remain unambiguous both where they are defined and at every usage.
- Generic verbs and nouns have been replaced where they hide meaning.
- One-word names are preferred where context carries the rest; names longer than three project-owned words were reviewed for design/naming problems.
- `get` is preferred for addressable retrieval; `read` is reserved for actual reading or sequential consumption.
- Processes, threads, tasks, browser tabs, and queue consumers are not collapsed into `worker`.
- Runtime identifiers use `camelCase`; types and schemas use `PascalCase`.
- Every Zod schema constant ends in `Schema`; project-owned schema-derived data types normally end in `Type`.
- Behavior interfaces/classes use the concrete domain noun without `Type`, and schema-owned records are not duplicated as interfaces.
- `UPPER_SNAKE_CASE` is reserved for genuine constants and protocol keys.
- Internal domain models use `camelCase`, with external names isolated to adapters and codecs.
- Folder names use one concrete word wherever the parent path preserves the full meaning.
- Multiword folders use concise kebab-case only when one word would be ambiguous, inaccurate, or detached from necessary context.
- Underscore prefixes appear only in verified auto-discovered trees and clearly mean that the entry must not be discovered.
- Underscore-prefixed modules are not treated as private or exported as public APIs.
- Files and genuinely multiword folders use concise kebab-case unless ecosystem conventions require otherwise.
- Parent folder context is not repeated unnecessarily in every descendant name.
- Broad `helpers`, `utils`, `common`, `shared`, `misc`, and root-level `types` files have been avoided.
- Generic primitives live in `utils/`; concrete capabilities live in `packages/`.
- Declarative definitions remain in `registry/` without runtime orchestration.
- CLI modules compose packages rather than owning domain implementations.
- Dependencies follow the library-first direction and do not create cycles.
- Public entry points expose intentional APIs without accidental wildcard exports.
- Namespace imports create coherent call sites rather than hiding oversized modules.
- Namespace re-exports have been reviewed as public runtime APIs, including type-only exports, cycles, side effects, and tree shaking.
- Comments and TSDoc explain domain-specific terminology, lifecycle, ownership, and shortened names without compensating for vague naming.
- Imports use ESM, explicit extensions, and the `#/` alias where appropriate.
- Obsolete compatibility aliases were not preserved without an explicit requirement.
- Formatting follows the Code Formatting Guide, especially compact call sites and flat extra-short structures.

## Summary rule

> Name the exact concept, resource, operation, and result, shortening words only when the surrounding definition and every usage preserve their meaning. Prefer `get` for retrieval, use namespaces to keep coherent APIs concise, document domain-specific terminology with comments and TSDoc, and re-export namespaces only as deliberate public runtime APIs. Prefer single-word folders when their parents provide enough context, use multiword kebab-case only when necessary, and reserve underscore prefixes for verified non-discoverable support entries inside auto-discovered trees. Keep generic primitives in `utils/`, concrete capabilities in `packages/`, declarative definitions in `registry/`, and executable composition in `clis/`. Use intentional public entry points and one-way library-first dependencies.
