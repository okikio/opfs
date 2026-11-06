---
"@okikio/opfs": patch
---

### Keep workload support in benchmark input receipts

A benchmark program could keep the same hash while its shared cancellation barrier, browser cleanup or upstream
provenance changed. The native collector's old selected roots omitted those inputs, and browser collection had no
before/after source guard. Dependency installs and generated outputs inside admitted trees could also enter a receipt.

Native, provider, browser and FUSE collectors now use one maintained support catalog. It includes production and
benchmark programs, test support, raw upstream provenance, manifests and command wrappers. Correctness test definitions
and nested dependency/output/VCS trees are excluded; benchmark Playwright specifications remain measured programs.
Required roots must be regular owned paths, and symbolic links are never followed. Keep executable local workload
support in these maintained roots rather than linking it from an excluded or external tree.

Use the canonical collectors from the repository root:

```sh
deno task bench:report
deno task bench:providers:verify
deno task bench:browser
deno task test:filesystem-clients
```

The native and FUSE reports retain their existing metadata and raw output. Browser collection adds
`.tmp/reports/browser-bench/inputs.json`; provider orchestration adds `provider-inputs.json` in its report directory.

Native, FUSE and standalone provider invocations now acquire fresh report directories atomically. The readable timestamp
is followed by an owned random suffix. Two invocations starting in the same millisecond therefore keep separate progress
and raw evidence instead of overwriting one another's metadata. Provider children still write into their explicitly
supplied parent report directory. Receipts retain running or invalid admission separately from workload results. An
unchanged input receipt does not mean tests passed or timings are valid. A missing required input or changed source
rejects collection, with failure evidence retained beside raw workload output.

This catalog deliberately includes some support that a particular workload does not execute; it is not a parsed complete
import graph. Before/after hashes cannot detect a temporary edit restored between observations or prove installed
dependency bytes. Use a frozen owned source snapshot and retain runtime/provider identities for comparisons. No latency,
allocation or throughput change is claimed.
