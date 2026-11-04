---
"@okikio/opfs": patch
---

Native command regression controls now separate cold runtime admission from the behavior they test. Run the same
portable contracts through the repository tasks:

```sh
deno task test
deno task test:node
deno task test:bun
```

A success control previously allowed only ten seconds for a new runtime to start, write its binary sentinels and exit.
On a constrained Docker runner, it could observe a null exit code before the expected-status assertion. The assertion
ran before the command record was written, so the failed test did not retain enough facts to distinguish a deadline from
another native status. That failed attempt remains a failure; these changes do not establish its missing cause.

The positive controls now use a finite 180-second operational budget. Cancellation first waits for a physically written
marker, with a 170-second readiness budget and time left for child retirement. Native controls also supply an outer
per-test runner budget longer than their child and cleanup lifetimes, rather than relying on a shorter Bun CLI default.
A child that has already settled without that marker fails admission immediately. The expected binary bytes, status,
signal, pipe EOF, quota and cleanup outcomes still decide whether the control passes. The intentional one-second
automatic deadline remains a separate control.

```text
native acquisition -> actual command facts -> physical record -> behavioral verdict -> owned retirement
                                  \________________ failure retains facts and original reasons __/
```

A common test scope records each settled observation before a later assertion or cleanup can fail. Diagnostics preserve
the exact original reason, including `undefined` or `null`, and independent cleanup failures. No status is invented for
an acquisition that did not produce an observation. The physical binary records are temporary fixtures; structured
failure diagnostics are not a claim that every raw fault stream is durably archived.

This is a test admission and diagnostic repair. It establishes neither a latency target nor a performance gain for the
published library. Native capture's production deadline policy and validation rules retain their existing contracts.
