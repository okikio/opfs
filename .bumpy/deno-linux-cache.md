---
"@okikio/opfs": patch
---

The offline Linux Deno lanes now disable Deno's optional native `node` launcher while keeping the complete copied cache
sealed. Run the same maintainer command:

```sh
deno task test:linux
```

Deno 2.9.7 can create a cached `node` alias to its executable in the container image before application code starts.
That executable lies outside the admitted input tree. Source admission correctly rejected the new alias instead of
accepting an unguarded runtime dependency. The two Deno containers now use the supported `DENO_DISABLE_NODE_SHIM=1`
environment setting during root admission, ordinary worker startup and Deno test execution.

This policy belongs to the offline maintainer lanes. It does not change application environments or library behavior.
The selected portable, upstream, Deno filesystem and Deno KV tests use Deno directly; their maintained test closure does
not require a child named `node`. The independent Node 22 and Node 24 lanes still use real Node. Deno's `node:` built-in
compatibility remains available. If a future Deno fixture launches a runtime child, use the explicit native Deno
executable, such as `Deno.execPath()`, or admit a separate Node emulation fixture rather than relying on an implicit
external alias.

Disabling the launcher alone did not prevent root startup from adding analysis databases and SQLite journal files to the
copied cache before read-only admission. Root admission now gets a separate UUID-named output cache under `/tmp`. That
worker uses only local copied modules and native built-ins, so it needs no downloaded dependencies. The container owns
these disposable runtime outputs, and its receipt declares their path. Ordinary Deno worker startup and tests still use
the complete root-owned read-only input cache. Inputs are never pruned or made writable to admit startup outputs.

All source, dependency and cache byte, mode, membership and alias guards remain in force. The same complete input cache
must pass before/after admission; input changes still reject the lane. The independently observed root and ordinary
worker identities retain their native Deno authority. Later workload subprocess credentials rely on exec inheritance and
NoNewPrivs rather than a separate proc observation of every descendant. This change makes no performance claim and does
not certify an arbitrary Deno cache or future runtime version. Setup and output-cache disposal remain separate from
measured library work.
