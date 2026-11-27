# Lifecycle, cancellation, resources, and public failures

Use this reference when a command opens resources, handles signals, launches
subprocesses/browsers/threads/workers, performs long-running work, supports
resume, or maps failures to exit status.

## One root lifetime

The executable composition root owns the root lifetime:

```text
OS/process signal
       |
       v
AbortController / execution context
       |
       +--> handler
       +--> HTTP
       +--> subprocess
       +--> browser/context/page
       +--> queue/work unit
       +--> file/database/client
       |
       v
ordered cleanup / logger flush
       |
       v
stable process exit
```

Do not install independent signal handlers in every library. Do not create a new
root controller in each nested operation unless it is intentionally a child
lifetime.

## Cancellation is not disposal

Cancellation asks active work to stop. Disposal releases resources. A canceled
operation still needs disposal; a successful operation also disposes resources.

Use `AbortSignal` for cooperative cancellation. Use `Disposable`,
`AsyncDisposable`, `using`, `await using`, `DisposableStack`, or
`AsyncDisposableStack` when the runtime/repository supports them and they make
ownership clearer. Otherwise preserve the same contract with `try/finally`.

## Borrowed versus owned resources

Injected resources are borrowed by default unless the API explicitly transfers
ownership.

```text
caller owns database/client
      |
      +--> CLI handler borrows
      |        |
      |        +--> operation completes
      |        +--> resource remains open
      |
      +--> composition root disposes later
```

A resource the command itself creates normally belongs to that command/root and
must be closed on success, failure, cancellation, and partial initialization.

## Partial construction

If resource construction is staged:

```text
open logger sink
open database
launch browser  <-- fails
```

then release database and logger resources already acquired. Preserve the
browser-launch failure as the primary cause. If cleanup also fails, retain both;
do not replace the original defect with the cleanup error.

## Signal policy

Define host-specific policy explicitly. A common interactive CLI shape is:

- first interrupt: request cooperative cancellation;
- stop admitting new work;
- give active work a bounded cleanup window;
- close/terminate resources in defined order;
- flush diagnostics;
- exit with a stable canceled/interrupt status (often 130 for SIGINT on Unix
  conventions where the host supports it);
- optional second interrupt: force termination if bounded cleanup cannot finish.

Do not hard-code Unix signal assumptions into a runtime-neutral core.

## Public failure ownership

Domain/use-case code should return or throw structured failures. One executable
the executable root maps them to human/machine diagnostics and exit classes.

Useful distinct classes can include:

- usage/validation;
- invalid configuration;
- conflict/precondition;
- permission/auth;
- unavailable dependency/network/provider;
- canceled/interrupted;
- internal defect.

The exact exit numbers are a product contract. Stability matters more than
inventing a large taxonomy.

Avoid this duplicate path:

```text
handler logs error
handler throws
root logs error again
root prints stack
```

The public API renders once. Internal layers can add structured diagnostic
context without emitting duplicate user messages.

## Long-running and resumable work

A checkpoint records committed work, not attempted work. Include enough identity
to reject incompatible resume:

- input/config/schema/version identity;
- run/stage identity;
- committed offset/key/sequence;
- output/artifact identity;
- external effect/idempotency identity where required.

On restart, reconcile external state, durable outputs, and checkpoint before
continuing. If the process itself must survive CLI loss or timers/signals/leases
are material, move durable authority to `build-workflows` rather than pretending
local checkpointing is a workflow engine.

## Resource-specific checks

### HTTP
Abort response/body reads, release connections according to the client, and do
not retry after terminal cancellation.

### Subprocess
Propagate cancellation, close stdio, terminate child process trees according to
host semantics, and await/reap the process.

### Browser
Close page/context/browser in ownership order. Do not leave child Chromium
processes after a command error.

### Files
Close handles/streams. For staged outputs, distinguish abort/discard from final
commit/close.

### LogTape
Application root configures logging. Flush asynchronous sinks and reset/dispose
configuration according to the selected lifecycle. Reusable writers should not
hard-code Deno-only stdout/stderr if the core claims runtime neutrality.

## Failure signatures

| Symptom | Inspect |
|---|---|
| Ctrl-C prints message but work continues | signal not connected to resource |
| command exits but child browser remains | resource ownership/termination |
| cleanup hangs forever | no deadline/force policy |
| injected DB closes unexpectedly | borrowed resource treated as owned |
| original error replaced by close error | cleanup error aggregation wrong |
| canceled task later reports success | terminal ordering/stale completion |
| resume skips missing output | checkpoint advanced before commit |
| error printed twice | multiple public failure owners |

## Verification

Use real subprocess/lifecycle tests for claims that cannot be proven in-process:

1. success cleanup;
2. operation failure cleanup;
3. partial-construction failure;
4. cancellation before work;
5. cancellation during active I/O/resource use;
6. SIGINT/host signal path;
7. cleanup timeout/force path where supported;
8. exact exit status and diagnostic count;
9. no child processes/open resources after exit;
10. resume/reconciliation around commit points when supported.

Type signatures containing `AbortSignal` or `AsyncDisposable` are not lifecycle
proof by themselves.
