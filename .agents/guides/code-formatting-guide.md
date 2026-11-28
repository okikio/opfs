# Code Formatting Guide

> **Current cross-project rule:** read the applicable [engineering-standards](engineering-standards.md) sections first; inspect headings to select them rather than reading unrelated chapters. This guide remains the detailed formatting reference. The current standard also requires functional and mechanical-only changes to stay separate.


## Applying the examples

Judge a convention by the reader contract it protects. Namespace-oriented
runtime operations do not require namespace imports for test runners, assertions,
schemas, or types. Keep protocol-required spellings exact. Preserve local
formatting and visible test scenarios; do not create public API documentation or
schemas for trivial private fixtures just to reproduce an example's shape.

## Purpose

This guide defines how code should be formatted so it remains compact, readable, easy to scan, and consistent across `utils/`, `packages/`, and `clis/`.

The objective is not to minimize the number of lines at any cost. The objective is to avoid unnecessary vertical expansion while preserving structure, clarity, and maintainability.

## Core principle

> Keep calls compact by default. Keep extra-short objects and arrays inline. Expand declarations and arguments only when the added vertical structure communicates something useful.

Formatting should make the code's shape obvious without forcing every value, argument, property, import, or condition onto its own line.


## Scope formatting to the change

Do not mix repository-wide mechanical cleanup with a functional change.
Formatting, import sorting, whitespace normalization, line-ending changes, and
generated-file refreshes can hide the behavior being reviewed.

For ordinary implementation work:

1. Format directly changed code with the repository formatter.
2. Inspect the diff.
3. Revert unrelated mechanical changes.
4. Keep a repository-wide formatting pass as a separate change unless the user
   explicitly requested it.

A formatter is a consistency tool, not authority to rewrite unrelated files.

## Function calls

Function calls should generally remain compact when the arguments are easy to scan.

Prefer:

```ts
await capturePage({ route, browserContext, archiveWriter, signal });
```

Avoid unnecessary expansion:

```ts
await capturePage({
  route,
  browserContext,
  archiveWriter,
  signal,
});
```

This remains true when a function receives an object argument. A short object does not need to become a tall call site.

### Expand calls when structure matters

Expand a call when it contains nested configuration, comments, long expressions, or meaningful conceptual groups.

```ts
await capturePage({
  route,
  browser: { context, page, processLease },
  archive: { writer, artifactDirectory },
  analysis: { extractors, threadPool },
  signal,
});
```

The expanded form is useful here because it reveals the browser, archive, and analysis subsystems.

### Avoid one-line calls that become difficult to parse

Do not force a call onto one line when it becomes dense or obscures important structure.

Avoid:

```ts
await capturePage({ route, browser: { context, page, processLease }, archive: { writer, artifactDirectory }, analysis: { extractors, threadPool }, signal });
```

Compact formatting must remain readable.

## Object literals

Object declarations may be expanded more freely than function calls because they often communicate configuration, state, or a public contract.

```ts
const captureOptions = {
  screenshots: true,
  lighthouse: true,
  captureAssets: true,
  observeServiceWorkers: true,
};
```

This is appropriate even when the object could technically fit on one line. The vertical form makes the configuration easier to review and compare.

### Keep extra-short objects flat

Use one line when the object is small and immediately understandable.

```ts
const retryOptions = { attempts: 3, delayMs: 500 };
const coordinates = { x: 12, y: 24 };
const routeLimit = { soft: 100, hard: 500 };
```

Avoid expanding tiny objects without a readability benefit:

```ts
const coordinates = {
  x: 12,
  y: 24,
};
```

### Expand objects when they communicate structure

Use multiple lines when:

- properties form a meaningful configuration block
- values are nested or complex
- properties require comments or TSDoc
- vertical alignment makes comparisons easier
- the object defines a public contract or persisted record
- the inline form would become visually dense

```ts
const browserProcessPoolOptions = {
  processCount: 4,
  contextsPerProcess: 8,
  tabsPerContext: 2,
  restartAfterCaptures: 500,
  shutdownTimeoutMs: 15_000,
};
```

## Arrays and tuples

Keep short arrays and tuples flat.

```ts
const supportedProtocols = ['http:', 'https:'];
const statuses = ['pending', 'active', 'completed'] as const;
const coordinates = [12, 24] as const;
```

Expand arrays when entries are long, structured, commented, or easier to compare vertically.

```ts
const captureStages = [
  initializeBrowserCapture,
  observePageRuntime,
  captureNetworkEvidence,
  generateLighthouseReport,
  finalizeArchive,
];
```

Object arrays should normally use one object per visual block:

```ts
const queuePolicies = [
  { name: 'browser-capture', concurrency: 16, retryLimit: 2 },
  { name: 'lighthouse', concurrency: 4, retryLimit: 1 },
  { name: 'analysis', concurrency: 32, retryLimit: 3 },
];
```

Expand individual entries only when their internal structure benefits from it.

```ts
const queuePolicies = [
  {
    name: 'browser-capture',
    concurrency: 16,
    retryLimit: 2,
    leaseTimeoutMs: 120_000,
  },
  {
    name: 'lighthouse',
    concurrency: 4,
    retryLimit: 1,
    leaseTimeoutMs: 180_000,
  },
];
```

## Function signatures

Keep short function signatures on one line.

```ts
export function createBrowserProcessPool(options: BrowserProcessPoolOptions): BrowserProcessPool {
```

Avoid expanding a signature solely because it contains a typed parameter:

```ts
export function createBrowserProcessPool(
  options: BrowserProcessPoolOptions,
): BrowserProcessPool {
```

Expand signatures when multiple parameters, generics, or long types make the one-line form difficult to scan.

```ts
export function createBrowserProcessPool(
  options: BrowserProcessPoolOptions,
  dependencies: BrowserProcessPoolDependencies,
): BrowserProcessPool {
```

Prefer object parameters over long positional parameter lists when the values form a coherent contract.

```ts
export function capturePage(options: CapturePageOptions): Promise<CapturePageResult> {
```

Avoid:

```ts
export function capturePage(
  route: Route,
  browserContext: BrowserContext,
  archiveWriter: ArchiveWriter,
  lighthouse: LighthouseRunner,
  signal: AbortSignal,
): Promise<CapturePageResult> {
```

## Imports

Keep imports on one line when they remain readable.

```ts
import { afterEach, beforeEach, describe, it } from 'node:test';
```

Expand long imports when the line becomes difficult to scan or exceeds the repository formatter's limit.

```ts
import {
  BrowserCaptureFailure,
  BrowserCaptureOptions,
  BrowserCaptureResult,
  BrowserCaptureSuccess,
} from '#/browser/capture/types.ts';
```

Do not use multiline imports for very short import lists without a formatting or readability reason.

## Generics and type expressions

Keep short generics and type expressions inline.

```ts
type CaptureEvent = Event<'started' | 'completed' | 'failed'>;
type RouteByStatus = ReadonlyMap<RouteStatus, readonly Route[]>;
```

Expand only when nested type structure becomes difficult to understand.

```ts
type CaptureQueueRecord = QueueRecord<
  CaptureQueuePayload,
  CaptureQueueMetadata,
  CaptureQueueFailure
>;
```

Prefer named intermediate types when deeply nested generics remain hard to read after formatting.

```ts
type CaptureQueueRecord = QueueRecord<CaptureQueuePayload, CaptureQueueMetadata, CaptureQueueFailure>;
```

If that is still too dense, introduce a domain type rather than repeatedly expanding the same nested generic expression.

## Control flow

Keep short guard clauses compact.

```ts
if (signal.aborted) return CaptureResult.cancelled(signal.reason);
if (!route.isValid) return CaptureResult.rejected(route.problems);
```

Use braces when the branch performs more than one operation or when braces improve clarity.

```ts
if (captureResult.failed) {
  await archiveWriter.recordFailure(captureResult.failure);
  return captureResult;
}
```

Do not compress unrelated side effects into one expression merely to save lines.

Avoid:

```ts
if (captureResult.failed) return await archiveWriter.recordFailure(captureResult.failure), captureResult;
```

Prefer explicit control flow over nested ternaries.

```ts
if (failed) return failure(reason);
if (completed) return success(value);
return retry(nextAttempt);
```

Avoid:

```ts
return failed ? failure(reason) : completed ? success(value) : retry(nextAttempt);
```

## Blank lines

Blank lines should separate meaningful phases, not every statement.

Prefer:

```ts
const manifest = await readRouteManifest(path);
const routes = RouteManifestSchema.parse(manifest);
const selectedRoutes = applyRouteLimit(routes, routeLimit);

await queue.enqueueMany(selectedRoutes);
return { accepted: selectedRoutes.length };
```

Avoid excessive vertical spacing:

```ts
const manifest = await readRouteManifest(path);

const routes = RouteManifestSchema.parse(manifest);

const selectedRoutes = applyRouteLimit(routes, routeLimit);

await queue.enqueueMany(selectedRoutes);

return { accepted: selectedRoutes.length };
```

Use blank lines to separate phases such as:

- validation from execution
- preparation from external side effects
- acquisition from use
- use from disposal
- successful flow from failure handling
- independent conceptual sections within a larger function

## Comments and TSDoc

Comments should explain reasoning, ownership, lifecycle rules, invariants, concurrency behaviour, and non-obvious decisions.

```ts
// Stop accepting routes before disposing browsers so no capture can acquire a process during teardown.
await routeQueue.close();
await browserProcessPool.dispose();
```

Avoid comments that merely restate the code:

```ts
// Close the route queue.
await routeQueue.close();
```

Use TSDoc for public symbols and contracts. Do not use large block comments for obvious implementation steps.

```ts
/**
 * Creates a process pool that owns and restarts browser processes.
 *
 * The caller owns the returned pool and must dispose it before process exit.
 */
export function createBrowserProcessPool(options: BrowserProcessPoolOptions): BrowserProcessPool {
```

Keep implementation comments concise unless the underlying lifecycle or protocol requires a detailed explanation.

## Nested functions and callbacks

Tiny local callbacks are acceptable when they remain obvious and are not reused.

```ts
const validRoutes = routes.filter((route) => route.isValid);
```

Extract nested functions when they represent a real domain operation, require testing, obscure the containing function, or create excessive indentation.

Prefer:

```ts
async function captureDomainRoute(route: Route, context: DomainCaptureContext): Promise<RouteCaptureResult> {
  // ...
}

export async function captureDomain(
  domain: Domain,
  context: DomainCaptureContext,
): Promise<CaptureResult> {
  return await captureRoutes(domain.routes, (route) => captureDomainRoute(route, context));
}
```

Avoid large nested implementations:

```ts
export async function captureDomain(domain: Domain): Promise<CaptureResult> {
  async function captureRoute(route: Route): Promise<RouteCaptureResult> {
    // Large implementation hidden inside another function.
  }

  return await captureRoutes(domain.routes, captureRoute);
}
```

## Chained calls

Keep short chains on one line.

```ts
const domains = input.trim().split('\n').map(normalizeDomain).filter(Boolean);
```

Expand long chains by operation when each step communicates a meaningful transformation.

```ts
const prioritizedRoutes = routes
  .filter(isValidRoute)
  .map(normalizeRoute)
  .sort(compareRoutePriority)
  .slice(0, routeLimit);
```

Do not split every method call when the chain is short and obvious.

## JSX and templates

Keep short JSX elements compact.

```tsx
<Button disabled={isSubmitting} onClick={submitImport}>Submit import</Button>
```

Expand JSX when it has multiple properties, nested children, conditional content, or meaningful visual structure.

```tsx
<Button
  disabled={isSubmitting || selectedDomains.length === 0}
  onClick={submitImport}
  variant="primary"
>
  Submit {selectedDomains.length} domains
</Button>
```

Keep short template expressions inline.

```ts
const archivePath = `${artifactDirectory}/${domain}.wacz`;
```

Use multiline templates only when the generated text itself is multiline.

## Formatting priority

When choosing between compact and expanded formatting, apply this order:

1. Preserve correctness and semantics.
2. Follow the repository formatter and lint rules.
3. Keep function calls compact when readable.
4. Keep extra-short objects, arrays, tuples, imports, and generics flat.
5. Expand declarations when doing so reveals useful structure.
6. Expand complex calls only when it exposes meaningful conceptual groups.
7. Use vertical space to communicate phases, ownership, and complexity.
8. Do not use clever or compressed syntax merely to reduce line count.

## Practical decision table

| Construct | Default | Expand when |
| --- | --- | --- |
| Function call | Compact | Nested groups, long expressions, comments, or complex arguments |
| Short object | One line | Structure or comparison benefits from vertical layout |
| Configuration object | Multiline is acceptable | Keep inline only when genuinely tiny |
| Short array or tuple | One line | Entries are long, structured, or easier to compare vertically |
| Import | One line | Import list becomes long or difficult to scan |
| Function signature | One line | Multiple parameters or long types reduce readability |
| Guard clause | One line | Branch performs multiple operations |
| Method chain | One line | Each stage is meaningful or the chain becomes dense |
| JSX element | One line | Multiple props, complex conditions, or nested children |
| Comments | Concise | Lifecycle or protocol reasoning requires detail |

## Review checklist

Before accepting a formatted change, verify:

- Function calls were not expanded without a readability benefit.
- Extra-short objects and arrays remain flat.
- Configuration objects expose useful structure.
- Long calls group related subsystems rather than listing unrelated scalar values.
- Blank lines separate conceptual phases rather than individual statements.
- Imports and signatures are compact when readable.
- Comments explain why, ownership, lifecycle, or invariants.
- Control flow remains explicit and understandable.
- Compact formatting has not introduced clever or ambiguous code.
- The repository formatter, linter, type checker, tests, and build still succeed.

## Summary rule

> Prefer compact call sites and flat short structures. Expand objects, arrays, signatures, and calls only when the additional vertical structure makes the code easier to understand, compare, review, or maintain.
