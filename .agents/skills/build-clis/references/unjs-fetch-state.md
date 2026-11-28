# UnJS fetch, state, fingerprints, and hooks

## Contents

- [When to load this reference](#when-to-load-this-reference)
- [Version and evidence limit](#version-and-evidence-limit)
- [Capability ownership](#capability-ownership)
- [ofetch](#ofetch)
- [unstorage](#unstorage)
- [ohash](#ohash)
- [hookable](#hookable)
- [Integration patterns](#integration-patterns)
- [Exclusions and non-capabilities](#exclusions-and-non-capabilities)
- [Failure signatures](#failure-signatures)
- [Testing and verification](#testing-and-verification)
- [Sources and freshness](#sources-and-freshness)

## When to load this reference

Load this reference when a CLI uses or is considering one or more of:

- `ofetch` for HTTP transport;
- `unstorage` for cache, local state, or checkpoint persistence;
- `ohash` for cache keys, fingerprints, or structural comparison;
- `hookable` for application-owned extension points.

Read only the package sections relevant to the change. Read all four sections
when they form one fetch-cache, resumable-import, or plugin lifecycle.

This reference defines application ownership around the packages. It does not
make a package direct merely because it appears in a lockfile, and it does not
upgrade a cache into a durable workflow, a hash into an idempotency protocol, or
a hook collection into a trusted plugin system.

## Version and evidence limit

The exact stable package artifacts verified on 2026-07-17 are:

| Package | npm `latest` | Exact surface used here | Important alternate line |
|---|---:|---|---|
| `ofetch` | `1.5.1` | npm 1.5.1 package README, exports, declarations, and built source | npm `alpha` is `2.0.0-alpha.3` |
| `unstorage` | `1.17.5` | npm 1.17.5 package, declarations, drivers, core, and official guide | npm `alpha` is `2.0.0-alpha.7` |
| `ohash` | `2.0.11` | npm 2.0.11 package README, exports, and declarations | npm `1x` is `1.1.6` |
| `hookable` | `6.1.1` | npm 6.1.1 package README, exports, declarations, and built source | historical example graphs also pinned `5.5.3` |

Treat the version in the repository manifest and lockfile as authoritative for
that repository. Historical project reviews recorded distinct dependency graphs,
represented here as anonymized examples:

- a CLI lockfile resolved `ohash@2.0.11`;
- application, auth-integration, site, and motion examples resolved stable
  `ofetch@1.5.1`, `unstorage@1.17.5`, and `ohash@2.0.11` transitively;
- the example graphs included both `hookable@5.5.3` and `hookable@6.1.1`;
- another application graph resolved `ofetch@2.0.0-alpha.3` and
  `unstorage@2.0.0-alpha.7`.

These are historical version combinations, not claims about the active project.

A lockfile occurrence proves resolution, not direct application use or an
approved API. Do not copy the stable examples below into an alpha dependency.
Inspect that exact alpha package's exports, declarations, changelog, and source.
Likewise, do not use a v6-only Hookable surface in a package pinned to v5.

## Capability ownership

| Concern | Package role | Application-owned contract |
|---|---|---|
| HTTP request and response mechanics | `ofetch` | endpoint policy, authentication, schema validation, retry safety, deadline, cancellation, redaction, error mapping |
| Key-value access and backend adaptation | `unstorage` | key namespace, value schema, migration, consistency, atomicity, retention, lease, recovery, driver selection |
| Structural serialization and digest | `ohash` | canonical input envelope, schema version, identity meaning, collision policy, secret handling |
| Awaitable in-process callbacks | `hookable` | hook vocabulary, payload schema, ordering, timeout, cancellation, trust, failure policy, cleanup |

Prefer small application adapters over exporting package instances throughout a
codebase. This keeps package-version details in one module and prevents
interceptors, driver options, fingerprints, and hooks from becoming invisible
global policy.

## ofetch

### Exact stable surface

The verified 1.5.1 root export includes:

```ts
import {
  FetchError,
  ofetch,
  type FetchOptions,
  type FetchResponse,
} from "ofetch";
```

The callable `ofetch` has three additional properties:

- `ofetch.raw(request, options)` returns the `Response` extended with parsed
  data in the package-specific `_data` field;
- `ofetch.native` exposes the underlying native-compatible `fetch` function;
- `ofetch.create(defaults)` creates another callable instance.

There is no default export. The package has conditional exports for Node and
browser, Deno, worker, and other web-compatible conditions. In Node, the 1.5.1
package uses its Node entry and `node-fetch-native`; where `globalThis.fetch` is
available it uses that implementation.

### Response and request behavior

`ofetch<T>()` supplies a compile-time result type only. It does not validate the
wire response. Fetch as `unknown`, then parse with the repository's runtime
schema owner:

```ts
const raw: unknown = await ofetch("/api/jobs/42", {
  baseURL: config.apiBaseUrl,
  retry: false,
  signal,
});

const result = JobResponseSchema.safeParse(raw);
if (!result.success) {
  throw new InvalidRemoteResponse({ cause: result.error });
}

return result.data;
```

`JobResponseSchema` and `InvalidRemoteResponse` are application-owned symbols in
this example, not `ofetch` APIs.

In 1.5.1:

- JSON-compatible object bodies are stringified for payload methods;
- `content-type: application/json` and `accept: application/json` are added for
  JSON-compatible bodies on the packaged implementation's payload methods
  (`POST`, `PUT`, `PATCH`, and `DELETE`) when absent;
- response parsing is selected from `responseType`, `parseResponse`, or the
  response content type;
- supported explicit response types are `json`, `text`, `blob`, `arrayBuffer`,
  and `stream`;
- the default JSON path uses `destr`, not `JSON.parse`;
- `query` is the current option and `params` is a deprecated alias;
- `baseURL` and query composition use `ufo` semantics;
- HTTP 4xx/5xx responses throw `FetchError` unless `ignoreResponseError` is
  true.

Use `parseResponse: JSON.parse` only when strict JSON parsing is intentionally
required. A generic type argument does not change parsing or validate shape.

### Client defaults and interceptors

Create one transport adapter per endpoint policy rather than one mutable global
client:

```ts
const api = ofetch.create({
  baseURL: config.apiBaseUrl,
  headers: {
    accept: "application/json",
  },
  retry: false,
  onRequest({ options }) {
    options.headers.set("x-request-id", requestContext.id);
  },
  onResponse({ response }) {
    diagnostics.httpResponse({
      requestId: requestContext.id,
      status: response.status,
    });
  },
  onRequestError({ error }) {
    diagnostics.httpTransportFailure({
      requestId: requestContext.id,
      error,
    });
  },
  onResponseError({ response }) {
    diagnostics.httpStatusFailure({
      requestId: requestContext.id,
      status: response.status,
    });
  },
});
```

`requestContext` and `diagnostics` are application-owned dependencies. Do not
log complete request options, headers, URLs with secret query parameters, or
parsed response bodies by default.

Interceptor arrays are awaited sequentially. In the verified implementation,
`onResponse` runs after body parsing, including for an error status, and then
`onResponseError` runs before retry/error mapping. With
`ignoreResponseError: true`, the status-error branch and `onResponseError` are
skipped. Do not use `ignoreResponseError` merely to inspect a failure; map the
thrown `FetchError` or use an explicitly owned raw-response policy.

`ofetch.create()` defaults are cloned and inherited only one level deep. Treat
nested defaults such as mutable header objects as construction-time values.
Do not mutate a shared object after creating clients and expect isolated state.

### Errors

Map package errors once at the HTTP adapter API:

```ts
try {
  return await api<unknown>(path, options);
} catch (error) {
  if (error instanceof FetchError) {
    throw new RemoteRequestFailed({
      cause: error,
      status: error.status,
      data: error.data,
    });
  }
  throw error;
}
```

`RemoteRequestFailed` is application-owned. A `FetchError` exposes optional
`request`, `options`, `response`, `data`, `status`, `statusText`, and compatible
status aliases. Do not serialize the whole error object into user output: it can
retain a request and options containing credentials.

### Retry policy

The verified 1.5.1 default is one retry for non-payload methods and zero retries
for `POST`, `PUT`, `PATCH`, and `DELETE`. The default status set is `408`, `409`,
`425`, `429`, `500`, `502`, `503`, and `504`; the default delay is zero. A
numeric `retry` explicitly supplied by the caller also applies to payload
methods.

Therefore:

- set `retry: false` when the domain owner performs retries;
- do not add payload retries merely because an idempotency header exists;
- define attempt count, total deadline, delay/backoff, retryable transport
  errors, retryable statuses, and server `Retry-After` behavior explicitly;
- prove that the remote operation recognizes the chosen idempotency identity;
- emit one logical-operation correlation ID plus attempt numbers, not four
  unrelated success/failure stories.

The package's `retryDelay` option accepts either milliseconds or a function of
the fetch context. It is not a full retry budget or backoff protocol.

### Cancellation and deadline

`timeout` is milliseconds and is disabled by default. A critical 1.5.1 source
detail is that the package creates its timeout controller only when no `signal`
was supplied. Passing both a root `signal` and `timeout` does not compose them;
the supplied signal wins and the internal timeout is not installed.

Compose the root cancellation and deadline outside `ofetch`, then pass the one
resulting signal. This helper is application code, not an `ofetch` API:

```ts
function withDeadline(
  parent: AbortSignal,
  timeoutMs: number,
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent.reason);

  if (parent.aborted) {
    onAbort();
  } else {
    parent.addEventListener("abort", onAbort, { once: true });
  }

  const timer = setTimeout(() => {
    controller.abort(new DOMException("HTTP deadline exceeded", "TimeoutError"));
  }, timeoutMs);

  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent.removeEventListener("abort", onAbort);
    },
  };
}

const deadline = withDeadline(rootSignal, config.httpTimeoutMs);
try {
  return await api<unknown>("/jobs", {
    retry: false,
    signal: deadline.signal,
  });
} finally {
  deadline.dispose();
}
```

If the target runtime has a verified `AbortSignal.any` and
`AbortSignal.timeout`, those primitives can replace the helper. Still dispose
streams, readers, agents, and application resources; aborting fetch is not
process cleanup.

### Raw responses and streams

Use `ofetch.raw` when status, headers, or both parsed data and transport metadata
belong to the adapter result:

```ts
const response: FetchResponse<unknown> = await api.raw<unknown>("/jobs/42", {
  retry: false,
  signal,
});

const etag = response.headers.get("etag");
const raw = response._data;
```

`_data` is package-specific, not a standard `Response` property. Do not return
the extended response across the domain interface when a smaller owned result
will do.

For a stream, request `responseType: "stream"`, own the reader, propagate
cancellation, bound idle time, parse framing incrementally, and cancel/release
the reader in `finally`. `ofetch` selects `stream` automatically for
`text/event-stream` in 1.5.1, but protocol-level reconnection, cursor replay,
duplicate suppression, backpressure, and terminal event semantics remain the
application's responsibility.

### Node dispatcher integration

The 1.5.1 declarations expose `dispatcher` for Node 18+ Undici-compatible
dispatchers and `agent` for the older Node polyfill path. This is runtime-
specific configuration. Do not place an Undici dispatcher in a browser/Deno
adapter or disable certificate verification as a compatibility workaround.
Proxy, connection pool, certificate, and disposal policy belong to the Node
composition root and must be tested under the packaged runtime.

## unstorage

### Exact stable surface

The verified 1.17.5 root exports include:

```ts
import {
  createStorage,
  defineDriver,
  prefixStorage,
  restoreSnapshot,
  snapshot,
  type Driver,
  type Storage,
  type StorageMeta,
  type StorageValue,
} from "unstorage";

import fsDriver from "unstorage/drivers/fs";
import fsLiteDriver from "unstorage/drivers/fs-lite";
import denoKvDriver from "unstorage/drivers/deno-kv";
import httpDriver from "unstorage/drivers/http";
import memoryDriver from "unstorage/drivers/memory";
import redisDriver from "unstorage/drivers/redis";
```

Drivers are default exports from `unstorage/drivers/<name>`. Some drivers need
optional peer dependencies even though the driver module is listed in the
package export map. Verify and install the selected driver's peers in the owning
workspace package.

### Core value and key semantics

`createStorage()` uses an in-memory driver when none is supplied. Normal item
writes serialize non-string values; normal reads parse through `destr`. Missing
items resolve to `null`, not `undefined`. Writing `undefined` removes the item.
Raw reads and writes bypass the normal value path where the selected driver
supports them or use the core fallback serialization.

Keys normalize into colon-delimited segments. The docs accept slash-like input,
but use one canonical key builder in the application and reserve namespaces:

```text
cache:http:v2:<fingerprint>
checkpoint:import:v3:<run-id>
lease:import:v1:<run-id>
```

Include the value-schema version in the namespace or envelope. Do not store
tokens, passwords, or secret response bodies merely because a driver is local.

A TypeScript generic constrains callers; it does not validate data loaded from
disk, a remote store, an older application version, or another process:

```ts
const storage = createStorage({
  driver: fsDriver({
    base: config.stateDirectory,
    noClear: true,
  }),
});

const checkpoints = prefixStorage<Checkpoint>(storage, "checkpoint:import:v3");
const raw: unknown = await checkpoints.getItem(runId);

if (raw !== null) {
  const parsed = CheckpointSchema.safeParse(raw);
  if (!parsed.success) {
    throw new InvalidCheckpoint({ cause: parsed.error, runId });
  }
}
```

`Checkpoint`, `CheckpointSchema`, and `InvalidCheckpoint` are application-owned.
The schema must reject incompatible request identity, not silently coerce it.

### Mounts and prefixes

`storage.mount(base, driver)` routes keys with the matching normalized prefix to
that driver; more-specific mountpoints take precedence. An unmounted key uses
the default driver. `storage.unmount(base, dispose)` defaults to disposing the
removed driver. The root mount cannot be unmounted.

```ts
const storage = createStorage();
storage.mount(
  "checkpoint:import",
  fsDriver({ base: config.checkpointDirectory, noClear: true }),
);
storage.mount(
  "cache:http",
  memoryDriver(),
);

await storage.setItem("checkpoint:import:run-42", checkpoint);
await storage.setItem("cache:http:job-42", cachedResponse);
```

This example deliberately gives checkpoints and cache different owners. The
memory mount does not become durable because another mount uses the filesystem.
Use `getMount()` and `getMounts()` in diagnostics/tests when a key could route to
the wrong backend.

`prefixStorage(storage, base)` provides a smaller typed view; it is namespacing,
not isolation. The underlying driver, lifecycle, consistency, and permissions
are unchanged.

### Stable and experimental operations

The stable 1.17.5 storage surface includes `hasItem`, `getItem`, `setItem`,
`removeItem`, `getMeta`, `setMeta`, `removeMeta`, `getKeys`, `clear`, `dispose`,
`mount`, `unmount`, `getMount`, `getMounts`, `watch`, and `unwatch`, plus short
aliases such as `get`, `set`, `has`, `del`, and `remove`.

In the 1.17.5 declarations, these are explicitly experimental:

- `getItems` and `setItems`;
- `getItemRaw` and `setItemRaw`.

Do not make an experimental batch/raw API part of a stable public library
contract without pinning the version and owning a compatibility adapter.

The internal type is named `TransactionOptions`, but it is an open option bag
passed to drivers. That name does not establish begin/commit/rollback,
compare-and-set, multi-key atomicity, serializability, or exactly-once behavior.
The core `setItems` fallback performs writes in parallel, and a driver-specific
batch method still has only that driver's guarantees.

### Driver capability contract

The core `Driver` requires `hasItem`, `getItem`, and `getKeys`. Mutation,
metadata, raw, batch, watch, clear, and dispose methods are optional. The driver
may expose `flags.maxDepth` and `flags.ttl`, its original `options`, and a native
instance through `getInstance`.

Capability-check the actual driver at construction time when the application
requires a feature. In the verified 1.17.5 core, a normal `setItem` returns
without writing if the driver has no `setItem`; some read-only options also make
driver mutations no-ops. A resolved promise is not proof that state changed.
For critical state, write, read back, and verify identity/version at the claimed
consistency guarantee.

Representative verified drivers:

| Driver | Exact import/options | Guarantees to avoid inventing |
|---|---|---|
| memory | default or `unstorage/drivers/memory` with no options | process-local `Map`; `dispose()` clears it; no restart durability |
| fs | `fsDriver({ base, ignore?, readOnly?, noClear?, watchOptions? })` | colon keys map to paths; rejects `..` key segments; `readOnly` mutations and `noClear` clearing are no-ops; watch uses Chokidar |
| fs-lite | `fsLiteDriver({ base?, ignore?, readOnly?, noClear? })` | smaller filesystem surface; do not assume watch parity with `fs` |
| redis | `redisDriver({ url?, host?, cluster?, clusterOptions?, base?, ttl?, scanCount?, preConnect? })` plus `ioredis` peer | per-item/default TTL in seconds; key enumeration uses `SCAN`; no multi-key transaction is exposed by the storage API |
| Deno KV | `denoKvDriver({ base?, path?, openKv?, ttl? })` plus `@deno/kv` peer as required by this package line | backend is Deno KV, but the adapter surface does not expose Deno atomic operations |
| HTTP | `httpDriver({ base, headers? })` | maps storage operations to its HTTP protocol; not a generic REST contract or offline store |

`preConnect` in the verified Redis driver initializes inside a `try/catch` that
writes a failure with `console.error`. In a LogTape-only CLI, avoid relying on
that path for lifecycle reporting; initialize/health-check the native client at
an owned component or verify a later operation and map the error through the
CLI's diagnostic transport.

Driver options and peer ranges are version-sensitive. The table is not a reason
to pass every option supported by the native backend through configuration.
Expose only product-owned, schema-validated choices.

### Metadata, TTL, watch, and disposal

`getMeta()` combines native driver metadata with custom metadata stored under a
`$`-suffixed item unless `nativeOnly` is requested. Native fields and TTL support
vary by driver. Do not use an `mtime`, `ttl`, or custom metadata field for lease
correctness until the backend's atomic update and clock semantics are proven.

`watch(callback)` returns an async-compatible unwatch function. If a driver has
no native watcher, the core can emit changes caused through the same storage
instance; it cannot observe external processes changing that backend. A watch
event contains only `"update" | "remove"` and a key. It is not a durable event
stream, replay log, or guaranteed exactly-once notification.

Always call `storage.dispose()` from the composition root. It disposes mounted
drivers and clears the default memory driver's data. Disposing a storage is not
equivalent to flushing application work unless the selected driver explicitly
documents such a contract.

### Snapshots and custom drivers

`snapshot(storage, base)` enumerates keys and reads them in parallel.
`restoreSnapshot(storage, snapshot, base)` writes entries in parallel. The
snapshot does not include a transaction scope, metadata protocol, or
concurrent-writer exclusion. Use it for controlled fixtures, migrations under a
lock, or best-effort cache transfer, not as a database backup or crash-consistent
checkpoint.

Define a custom driver only to adapt a backend whose semantics are understood:

```ts
interface DriverOptions {
  readonly namespace: string;
}

export const customDriver = defineDriver((options: DriverOptions): Driver => {
  const values = new Map<string, string>();

  return {
    name: "example",
    options,
    hasItem(key) {
      return values.has(key);
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    removeItem(key) {
      values.delete(key);
    },
    getKeys(base) {
      return [...values.keys()].filter((key) => key.startsWith(base));
    },
    clear(base) {
      for (const key of values.keys()) {
        if (key.startsWith(base)) values.delete(key);
      }
    },
    dispose() {
      values.clear();
    },
  };
});
```

The normal driver `setItem` receives the core's serialized string, not the
original object. Normalize keys to the package convention, release watchers and
handles in `dispose`, expose native capabilities only when the backend actually
has them, and add real backend integration tests. A custom driver is an adapter,
not a place to simulate unsupported transactions.

## ohash

### Exact v2 surface

The verified 2.0.11 imports are:

```ts
import { digest, hash, isEqual, serialize } from "ohash";
import { diff } from "ohash/utils";
```

The root package also exports `ohash/crypto` through a conditional Node/JS
implementation, but ordinary consumers should use the root `digest` export.

In v2.0.11:

- `serialize(input)` creates a best-effort stable string representation;
- `digest(string)` applies SHA-256 and Base64URL encoding;
- `hash(input)` is `serialize` followed by `digest`;
- `isEqual(a, b)` first checks `===`, then compares serialized values;
- `diff(a, b)` returns `DiffEntry` objects from `ohash/utils` with `key`,
  `type`, `newValue`, optional `oldValue`, and string/JSON renderers.

The v2 documentation explicitly says serialization is not designed for
security and intentional collisions remain possible. SHA-256 does not repair
ambiguity in the serializer or make low-entropy secrets safe to expose.

### Fingerprint envelope

Hash a versioned, schema-validated, normalized envelope rather than a mutable
request object:

```ts
const fingerprint = hash({
  fingerprintVersion: 2,
  operation: "catalog-import",
  source: normalizedSourceIdentity,
  requestedMode: request.mode,
  schemaVersion: request.schemaVersion,
});

const checkpointKey = `checkpoint:import:v3:${fingerprint}`;
```

Define which inputs are material. Exclude correlation IDs, timestamps, and
presentation-only values unless they change semantic identity. Include tenant,
authorization scope, selected account, input artifact identity, and operation
version when omitting them could make two unsafe operations collide.

Never use `hash()` as:

- a password hash;
- a message authentication code or request signature;
- proof that untrusted content is authentic;
- an authorization token;
- an entire idempotency/recovery protocol;
- a compatibility guarantee across package upgrades without a golden test.

For server-side idempotency, the server must atomically bind an identity to an
operation/result and reject incompatible reuse. `ohash` can produce a component
of that identity after its collision and disclosure properties are accepted.

### Comparison and diffs

Use `isEqual` for the package's structural serialization semantics, not domain
equality such as URL identity, timestamps within tolerance, database row
identity, or secret comparison. Use `diff` for diagnostics after redacting or
projecting sensitive fields:

```ts
const changes = diff(
  redactForDiff(previousConfig),
  redactForDiff(nextConfig),
);

for (const change of changes) {
  diagnostics.configChange({
    key: change.key,
    type: change.type,
    summary: change.toString(),
  });
}
```

`redactForDiff` and `diagnostics` are application-owned. Do not log
`newValue`/`oldValue` blindly; the diff object can retain original values.

### Version line

`ohash` v2 has different documentation and outputs from the maintained v1 line.
Persist a fingerprint algorithm/version beside the value. On upgrade, either
retain the old reader, migrate under an explicit policy, or invalidate the
cache. Do not silently recompute a persisted recovery identity with a new major
version.

## hookable

### Exact v6 surface

The verified 6.1.1 root exports include:

```ts
import {
  Hookable,
  HookableCore,
  createDebugger,
  createHooks,
  flatHooks,
  mergeHooks,
} from "hookable";
```

Use `createHooks<T>()` or `new Hookable<T>()` for typed product hooks:

```ts
interface CommandContext {
  readonly command: string;
  readonly signal: AbortSignal;
  readonly requestId: string;
}

interface CliHooks {
  "command:before": (context: CommandContext) => void | Promise<void>;
  "command:after": (
    context: CommandContext,
    outcome: "succeeded" | "failed" | "cancelled",
  ) => void | Promise<void>;
}

const hooks = createHooks<CliHooks>();

const unregister = hooks.hook("command:before", async (context) => {
  await extension.prepare(context);
});

try {
  await hooks.callHook("command:before", context);
} finally {
  unregister();
}
```

`extension` is application-owned. Hook payloads should carry the owned signal
and immutable identifiers rather than giving extensions an entire mutable
composition root.

`hook()` and `hookOnce()` return unregister functions. `addHooks()` accepts a
nested object, flattens names with `:`, and returns one unregister function.
`removeHook`, `removeHooks`, `removeAllHooks`, and v6 `clearHook` provide other
cleanup paths.

### Ordering and failures

`callHook(name, ...args)` invokes registered handlers sequentially in
registration order. It awaits an async handler before starting the next. A
thrown/rejected handler rejects the call and later handlers do not run.

`callHookParallel(name, ...args)` starts handlers through `Promise.all`. It can
reduce latency only when handlers are independent. It does not roll back a
handler that completed before another rejected, establish deterministic
completion order, limit concurrency, or aggregate all failures.

Choose and document one policy per hook:

- fail-fast required hook;
- best-effort hook whose failures are collected and reported;
- independently bounded parallel hook;
- compensatable hook with an application-owned rollback protocol.

Hookable supplies only the invocation primitive. Add timeout/cancellation in
the handler contract, and do not swallow hook failure at the command entrypoint.

`beforeEach` and `afterEach` register synchronous spy callbacks. In v6 the
`afterEach` callbacks are run from `finally` when an async hook call rejects.
They are suitable for light instrumentation, not awaited work, output rendering,
or resource cleanup.

### Minimal core and version differences

`HookableCore` is a v6 smaller surface with `hook`, `removeHook`, and
`callHook`. Use it only when those operations are sufficient. It is absent from
the verified 5.5.3 package.

The historical example graphs contained both 5.5.3 and 6.1.1. Common operations
such as `createHooks`, `hook`, `hookOnce`, sequential `callHook`, and parallel
`callHookParallel` exist in the inspected v5.5.3 line, but v6 adds
`HookableCore` and `clearHook` and changes the low-level `callHookWith` calling
shape. Keep `callHookWith` behind an adapter or avoid it; inspect the installed
declaration before writing a custom caller.

Since v5, a hook failure rejects `callHook` rather than being redirected to a
global error hook. Do not write code assuming the older pre-v5 swallow-and-log
behavior.

### Output and deprecation traps

The verified v6 `createDebugger()` uses `console.time`, `console.timeLog`, and
`console.timeEnd`. Registering a handler through a deprecated hook name can use
`console.warn`.
Hookable v5 removed its old custom logger parameter. Therefore, in a CLI where
LogTape is the sole output transport:

- do not enable `createDebugger` in production command paths;
- do not delegate public deprecation rendering to Hookable;
- normalize deprecated hook names at the application/plugin interface and emit
  the warning through the owned LogTape category;
- capture stdout/stderr in tests to prove no package helper bypasses transport.

### Plugin interface

Hookable is not a plugin loader or sandbox. If third-party code registers hooks,
the application must define:

- discovery, allowlisting, version negotiation, and integrity;
- hook names and runtime-validated payloads;
- registration and teardown ownership;
- execution order, reentrancy, concurrency, timeout, and cancellation;
- exception and partial-side-effect policy;
- filesystem, network, environment, and process capability restrictions;
- secret and diagnostic exposure;
- compatibility and deprecation policy.

Prefer explicit service interfaces when one extension owns a coherent
capability. Use hooks for genuine many-listener lifecycle extension, not as a
replacement for dependency injection or ordinary function calls.

## Integration patterns

### HTTP cache with validated values

```text
application normalizes request and authorization scope
  -> ohash fingerprints a versioned non-secret identity
  -> unstorage reads cache value
  -> runtime schema validates cached envelope and expiry
  -> ofetch performs a signal-bound, explicitly retried request on miss
  -> runtime schema validates remote response
  -> unstorage writes through a driver with proven retention semantics
  -> LogTape records redacted cache/request outcome
```

Do not assume every driver honors `ttl`. Store an application expiry in the
validated envelope when expiry correctness must be portable, and treat backend
TTL as cleanup optimization unless its semantics were verified.

Avoid a cache stampede with an application-owned single-flight or lease. Neither
`ohash` nor `unstorage` gives cross-process compare-and-set through the generic
surface.

### Resumable import

```text
CLI validates request and resolves source identity
  -> ohash produces versioned request fingerprint
  -> unstorage loads and schema-validates committed checkpoint
  -> application rejects incompatible fingerprint/version
  -> ofetch resumes from the remote cursor with one composed signal
  -> domain commit succeeds
  -> checkpoint advances after commit, never before
  -> reconciliation proves ambiguous external effects
```

This can support application recovery only when the selected driver survives the
claimed failure, writes meet the required consistency guarantee, domain effects
are idempotent or reconcilable, and crash tests prove the order. Calling the
state a checkpoint does not make it durable.

### Extensible fetch lifecycle

Keep transport and product extension separate:

- use `ofetch` interceptors for transport-local request/response mechanics;
- use Hookable for documented application extension points;
- pass a projected immutable payload to product hooks;
- do not register the same concern in both systems;
- map hook and transport failures through the command's one public error owner.

For example, an `import:before-commit` product hook should not mutate
`FetchOptions`; an `onRequest` transport interceptor should not decide whether a
domain import may commit.

### Shutdown

At the composition root:

```text
signal stops new work
  -> active fetches observe the composed signal
  -> hook registration closes to new extensions
  -> bounded in-flight hooks settle or cancel
  -> committed state is flushed/verified according to driver contract
  -> unstorage.dispose() releases mounted drivers
  -> network dispatcher/client resources close
  -> LogTape sinks dispose last
```

Do not call `process.exit()` before asynchronous disposal. Bound shutdown and
report which resources were closed, timed out, or left ambiguous.

## Exclusions and non-capabilities

Do not use these packages as substitutes for:

- runtime response/config/checkpoint schemas;
- an OAuth, signing, secret-storage, or credential-refresh implementation;
- a transactional database or compare-and-set API;
- a durable queue, event log, workflow engine, or Temporal service;
- exactly-once effects;
- distributed leases without backend atomic operations and clock policy;
- a cryptographic MAC, password hash, signature, or integrity proof;
- a plugin loader, permission sandbox, module integrity system, or dependency
  injection architecture;
- stable CLI result/diagnostic transport;
- domain retry, reconciliation, and recovery policy.

Choose native `fetch` when the application does not need `ofetch` parsing,
retry, base/query, raw-response, or interceptor behavior. Choose a direct backend
client when unstorage hides a required transaction, conditional write, streaming,
query, or consistency primitive. Choose Web Crypto or a reviewed security
construction when an adversary is in the threat model. Choose explicit service
interfaces instead of Hookable when extension cardinality is known and ordered.

## Failure signatures

| Signature | Likely cause | Next verification |
|---|---|---|
| Request ignores configured deadline | `signal` and `timeout` supplied together under ofetch 1.5.1 | Inspect options at the adapter and test composed cancellation with a stalled server |
| Mutation runs twice | numeric ofetch retry enabled for a payload method | Capture attempts and prove remote idempotency/reconciliation |
| 404 is treated as valid data | `ignoreResponseError` suppressed status mapping | Test status matrix and require explicit expected-status policy |
| Typed response fails later | generic type asserted without runtime parse | Fetch `unknown` and validate hostile fixtures |
| Secret appears in diagnostics | complete FetchError/options/body or hook payload logged | Test redaction and project logged properties |
| Checkpoint vanishes after restart | default memory or other process-local driver | Kill the process and resume from the installed artifact |
| Write resolves but value is unchanged | driver lacks `setItem` or uses `readOnly` no-op | Read back through a fresh driver instance and verify identity |
| Clear reports success but data remains | filesystem driver has `noClear` or read-only policy | Exercise clear under selected options and assert retained keys |
| Watch misses external change | driver has no native watcher or only same-instance events observed | Change backend from another process/client |
| Batch partially applies | experimental batch/fallback has no atomic contract | Inject failure at each write and inspect all keys |
| Snapshot mixes generations | concurrent writes during enumerate/read | Run snapshot under concurrent mutation and use backend-native backup if required |
| TTL never expires | selected driver ignores TTL options | Inspect driver flags/source and test real elapsed expiry |
| Resume accepts a different request | fingerprint omits tenant/input/version | Mutate each material field and assert rejection |
| Stable data becomes unreachable after upgrade | persisted ohash output changed across major/version | Run golden vectors and version the key algorithm |
| Later hook never runs | earlier sequential hook rejected | Assert ordering and select fail-fast versus collection policy |
| Parallel hooks leave partial effects | one Promise.all branch rejected after another committed | Inject per-handler failure and add compensation or serialize |
| Raw console output bypasses LogTape | Hookable debugger/deprecation or Redis `preConnect` path used | Capture stdout/stderr on all error/deprecation paths |
| Typecheck rejects Hookable helper | copied v6 `HookableCore`, `clearHook`, or `callHookWith` shape into v5 | Inspect installed declaration and keep version adapter local |
| Alpha package behaves differently | stable manual applied to ofetch/unstorage 2 alpha | Inspect exact alpha exports/source and write a separate migration plan |

## Testing and verification

### Version and export verification

Run against the repository's package manager and lockfile. Useful independent
checks are:

```bash
npm view ofetch dist-tags --json
npm view unstorage dist-tags --json
npm view ohash dist-tags --json
npm view hookable dist-tags --json
```

For reproducible source inspection, fetch the exact package version, record its
registry integrity, and inspect the packaged `package.json`, declarations,
README, and implementation. Do not inspect `main` and assume it matches a lock.

Typecheck exact imports in the owning workspace package. Verify the selected
runtime and packaged CLI, not only an editor language server.

### ofetch tests

Use a local controlled HTTP server and assert:

- JSON, text, binary, empty, malformed, and schema-invalid responses;
- 2xx and every mapped 4xx/5xx class;
- actual attempt count for safe and payload methods;
- retry delay/deadline interaction;
- root cancellation, deadline cancellation, and cancellation during retry
  delay;
- headers/query/baseURL without logging credentials;
- `onResponse`/`onResponseError` order and `ignoreResponseError` behavior;
- `raw` headers plus `_data` parsing;
- stream cancellation and reader cleanup;
- proxy/dispatcher behavior only in the runtime that owns it.

### unstorage tests

Run the same contract suite for every supported driver, plus driver-specific
checks:

- missing item is `null` and `undefined` writes remove;
- value round trip followed by runtime schema validation;
- canonical keys, mount precedence, prefix views, and traversal rejection;
- read-only/no-clear behavior;
- batch partial failure and lack of assumed atomicity;
- metadata and TTL only where documented;
- same-instance and external-process watch behavior;
- process kill/restart at each checkpoint commit point;
- corrupted and old-version values;
- optional peer missing, authentication failure, network partition, and
  permission denial;
- unmount and final disposal leave no open handles;
- read-back from a fresh client proves a critical write.

### ohash tests

Maintain golden vectors per fingerprint version and package version. Prove:

- object key ordering behaves as expected for the normalized input;
- every material field changes the fingerprint;
- presentation-only fields do not when intentionally excluded;
- old checkpoint/cache keys remain readable or are deliberately invalidated;
- no secret or low-entropy sensitive value is exposed through a public hash;
- `diff` diagnostics are redacted before rendering.

Golden vectors detect compatibility changes; they do not prove collision
resistance for the serializer or make the construction secure.

### Hookable tests

Assert:

- registration order and sequential awaiting;
- fail-fast rejection and which later handlers did not run;
- parallel partial effects and the chosen policy;
- unregister, `hookOnce`, bulk add/remove, and shutdown cleanup;
- signal/timeout propagation in every async handler;
- reentrant calls and recursive hook policy;
- typed payload plus runtime validation at external plugin interfaces;
- no `console.*` output on production paths;
- compatibility against every supported installed major.

Do not run a broad Markdown formatter as part of these checks. Preserve authored
reference layout and inspect the focused diff.

## Sources and freshness

Verified 2026-07-17 from primary package artifacts and official documentation:

- `ofetch@1.5.1` registry artifact:
  <https://registry.npmjs.org/ofetch/-/ofetch-1.5.1.tgz>, integrity
  `sha512-2W4oUZlVaqAPAil6FUg/difl6YhqhUR7x2eZY4bQCko22UXg3hptq9KLQdqFClV+Wu85UX7hNtdGTngi/1BxcA==`.
- Official ofetch repository/tag and v1 documentation line:
  <https://github.com/unjs/ofetch/tree/v1.5.1> and
  <https://github.com/unjs/ofetch/tree/v1>.
- `unstorage@1.17.5` registry artifact:
  <https://registry.npmjs.org/unstorage/-/unstorage-1.17.5.tgz>, integrity
  `sha512-0i3iqvRfx29hkNntHyQvJTpf5W9dQ9ZadSoRU8+xVlhVtT7jAX57fazYO9EHvcRCfBCyi5YRya7XCDOsbTgkPg==`.
- Official unstorage guide and custom-driver contract:
  <https://unstorage.unjs.io/guide> and
  <https://unstorage.unjs.io/guide/custom-driver>.
- `ohash@2.0.11` registry artifact:
  <https://registry.npmjs.org/ohash/-/ohash-2.0.11.tgz>, integrity
  `sha512-RdR9FQrFwNBNXAr4GixM8YaRZRJ5PUWbKYbE5eOsrwAjJW0q2REGcf79oYPsLyskQCZG1PLN+S/K1V00joZAoQ==`.
- Official ohash v2.0.11 source and migration line:
  <https://github.com/unjs/ohash/tree/v2.0.11>.
- `hookable@6.1.1` registry artifact:
  <https://registry.npmjs.org/hookable/-/hookable-6.1.1.tgz>, integrity
  `sha512-U9LYDy1CwhMCnprUfeAZWZGByVbhd54hwepegYTK7Pi5NvqEj63ifz5z+xukznehT7i6NIZRu89Ay1AZmRsLEQ==`.
- Official Hookable v6.1.1 source:
  <https://github.com/unjs/hookable/tree/v6.1.1>.
- Historical version scope: CLI, application, auth-integration, site, and motion
  lockfile reviews from 2026-07-17, adapted into the anonymized graph examples
  above. Verify the active lockfile and consumer imports before adoption.

Freshness limitations:

- npm dist-tags and official `main` documentation can change after the review
  date; exact-version package artifacts control the examples above.
- the stable `ofetch` and `unstorage` examples do not describe their v2 alpha
  lines.
- only representative unstorage drivers were inspected in detail; verify the
  exact selected driver, peer package, and backend behavior.
- package presence in historical example locks is not evidence that application code uses
  the package directly or relies on the behavior documented here.
- no claim is made that a generic storage driver supplies transactions,
  compare-and-set, durable watches, or workflow recovery without backend-level
  proof.
