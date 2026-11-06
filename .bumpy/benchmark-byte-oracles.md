---
"@okikio/opfs": patch
---

### Compare complete bytes with bounded failure evidence

Benchmark preflights now compare visible byte length and every byte, so an equivalent `Buffer`, `Uint8Array` subclass or
nonzero-offset view satisfies the same oracle. The comparison runs before sampling. Timing callbacks and expected
payloads stay unchanged.

Previously, a whole-array assertion also compared prototypes. A failed large-buffer assertion could format both complete
arrays while reporting the error. The new failure retains the first differing offset and two scalar bytes, or the two
lengths:

The internal preflight accepts equivalent views and reports a useful first mismatch:

```ts
expectBytes(Buffer.from([0, 255]), Uint8Array.of(0, 255), "read"); // passes
expectBytes(Uint8Array.of(0, 17), Uint8Array.of(0, 255), "read"); // rejects
// Error cause: { offset: 1, actual: 17, expected: 255 }
```

The common native, provider and FUSE preflights and the layer-comparison workload use this boundary. Corruption at any
offset, missing bytes and extra bytes still reject. A focused control checks every offset of an independently authored
payload, a large tail mismatch, prototype variation and bounded failure evidence.

An earlier native provider run reached the container's memory limit. This repair makes byte-oracle failure diagnostics
bounded; it does not establish the cause of that kill, a performance gain, or a bound on a native client's allocations.
