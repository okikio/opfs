Kaiju utility programming model
===============================

Purpose
-------

The `utils/` tree contains generic programming models and runtime primitives.
A utility must remain useful without knowing about Kaiju products, a browser
vendor, a database, an identity provider, a billing provider, or a CLI.

The utility layer gives concrete packages a small set of shared rules for:

 -  immutable definitions
 -  runtime validation
 -  explicit success and failure values
 -  cancellation and deadlines
 -  resource ownership
 -  bounded concurrency
 -  queues and process control
 -  durable workflow instructions
 -  HTTP protocol contracts
 -  service and gateway composition

Concrete implementations still belong in `packages/`.  For example, the queue
utility defines queue behavior.  A Redpanda or SQLite queue implementation
belongs in a package.


How the utility groups fit together
-----------------------------------

The utility tree has five main groups.

| Group | Utilities | Job |
| ----- | --------- | --- |
| Definitions and data | `catalog`, `schema`, `codec`, `result`, `failure` | Define stable values, validate data, and describe expected failure. |
| Execution and ownership | `context`, `resource`, `pool`, `process`, `worker`, `streams` | Carry cancellation, own resources, and control local runtime resources. |
| Work coordination | `queue`, `resilience`, `workflow`, `activity`, `runtime` | Coordinate retries, leases, instructions, external work, and placement. |
| HTTP and services | `http`, `server` | Model HTTP protocol values, then compose endpoints, middleware, services, and gateways. |
| Data helpers | `env`, `query`, `csv`, `email` | Solve reusable input, query, and data-normalization problems. |

The package groups are related, but they do not collapse into one universal
runtime object.  Each package owns one concept and exposes only the data or
behavior that another package needs.


Result, failure, problem, and response
--------------------------------------

These four names describe different concepts.

`result`
: A small `ok` or `failure` value for expected caller branching.  It does not
  define what a failure means and has no schema dependency.

`failure`
: A stable definition and runtime occurrence for an expected operation failure.
  A failure can be validated, encoded, sent through a queue or Worker, and
  decoded through a trusted catalog.

`http/problem`
: An RFC 9457 representation that an HTTP API can expose to a caller.  It is a
  protocol contract.  It is not the generic failure model.

`http/response`
: A successful HTTP representation.  It owns status, headers, pagination,
  conditional response handling, byte ranges, and response completion.

A domain operation can therefore fail without HTTP.  An HTTP service can map an
expected failure to one declared problem.  A caller can also place that failure
inside a `result` when explicit branching is preferable to throwing it.


Context identity
----------------

`@utils/context` carries one local operation through cancellation, deadlines,
tracing, and clocks.

The context identity is `ctx.id`.  The value names the current operation.  A
host can choose a request ID, activity job ID, workflow run ID, queue consumer
ID, or another stable operation ID.

HTTP correlation keeps the more specific name `requestId` because that value
really does identify an HTTP request.  The service runtime copies the HTTP
request ID into `ctx.id` when it creates the request context.

This distinction prevents an HTTP term from leaking into generic workflow,
queue, process, and Worker code.


HTTP and server ownership
-------------------------

`@utils/http` owns framework-neutral HTTP protocol behavior:

 -  bounded `Request` parsing and sanitation
 -  cookies
 -  successful response definitions and occurrences
 -  RFC 9457 problem definitions and occurrences

`@utils/server` owns application composition:

 -  endpoint definitions
 -  middleware definitions
 -  service compilation and runtime creation
 -  gateway compilation and runtime creation

This split keeps HTTP contracts usable without Hono.  Importing `@utils/http`
does not import or configure a server framework.


Workflow and activity ownership
-------------------------------

`@utils/workflow` owns the iterator programming model.  A workflow program
yields instructions.  The interpreter owns instruction execution and can wrap
every instruction with durable recording.

`@utils/activity` owns external work that a workflow can request.  An activity
names its input, result, expected failures, allowed logical runtimes, required
resources, and resilience policy.

`@utils/runtime` defines logical placement names.  It does not start a process
or thread.

Concrete durable storage, queue consumers, browser processes, analysis threads,
and provider clients belong in `packages/`.


Resource ownership
------------------

Resource lifetimes must remain visible in control flow.

Use `using` or `await using` when a function acquires an owned value.  A caller
must not need hidden global shutdown logic to release a resource.

A local operation should follow this order when the order matters:

~~~~ text
validate input
  -> acquire owned resources
  -> perform work
  -> commit required result
  -> release owned resources
~~~~

Cancellation must stop admission before disposal can make a new acquisition
possible.


Utility acceptance standard
---------------------------

A utility is ready only when all of these statements are true:

 -  Its public API can be explained without a Kaiju product domain.
 -  Importing it starts no process, timer, queue consumer, network client, or
    global registration.
 -  Public data uses the correct value, iterable, stream, batch, or disposable
    shape.
 -  Concurrency, buffering, retries, and open resources have explicit limits.
 -  Ownership and cleanup are visible and tested.
 -  Expected failures have stable machine-readable contracts.
 -  Public exports have TSDoc that explains the contract and non-obvious rules.
 -  The README explains what the utility owns, what it does not own, and how it
    composes with neighboring utilities.
 -  Happy-path and pathological tests exercise the public API.
 -  Package exports and source imports agree.

Passing unit tests is necessary, but it is not enough.  A utility can be
correct in isolation and still be the wrong abstraction for the system.
