---
"@okikio/opfs": patch
---

Provider benchmark preflights now keep the observer's loopback listener separate from the fixture's upstream address.
Use the same tasks from a workstation or an owned Docker runner:

```sh
deno task bench:providers:verify
deno task bench:providers
```

The parent task starts SeaweedFS and Azurite through Testcontainers, passes their selected endpoints to Node and Bun,
and releases the services after both programs finish. Inside a Docker runner, those endpoints can use the Docker gateway
instead of `localhost`. The previous observer rejected that valid fixture route before any publication preflight, so a
full release preparation could fail after its other correctness gates passed.

```text
untimed SDK/client -> observer at 127.0.0.1 -> fixed caller-owned fixture endpoint
actual timing      -----------------------> original fixture endpoint
```

Only the observer listener must be loopback. Forwarding retains one fixed HTTP hostname and port, literal request paths,
Azurite's account path, signed Host headers, two-way backpressure and cancellation. A Host header naming another server
cannot change that destination. URL userinfo, query and fragment are rejected before listener acquisition instead of
being silently discarded. No extra proxy hop enters the timing samples.

This is a private benchmark transport, not a production proxy or a network ownership/security certificate. The fixture
parent owns the selected endpoints and explicit development credentials through cleanup. Admission of a gateway-shaped
URL proves the address policy only; actual provider requests, receipt identity, exact bytes and cleanup must still pass.
Existing request-count, acknowledgement, stream lifetime and failure oracles remain in force, including the 64-call
bound and 30-second operational watchdog. These budgets do not establish a latency target or live AWS/Azure conformance.

Fixture retirement also keeps one terminal promise. A second close cannot report success while the first stop is still
pending or failed. If an endpoint lookup or constructor fails after both containers were acquired, both are stopped in
reverse order. Every stop is attempted; the original startup reason and each independent cleanup failure remain
observable. The controlled resource tests do not substitute for actual Testcontainers cleanup evidence.

Testcontainers values now load only when the parent starts an actual provider acquisition. Reading fixture constants or
using the controlled ownership seam does not run SDK host/Docker configuration discovery. The Deno ownership controls
keep their existing permissions; no system-inspection grant or skipped control is added. Actual provider factories use
the same SDKs, images, readiness checks and fixed development credentials before timed workloads begin.
