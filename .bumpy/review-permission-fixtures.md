---
"@okikio/opfs": patch
---

Container ownership regressions now compare the physical resources that each fixture actually acquired. The private
Linux runner starts children with a `077` umask, so `mkdir(path, { mode: 0o755 })` can create a `0700` directory. A
previous test correctly observed refused cleanup and retained bytes, then failed because it expected the requested
creation mode instead of the mode the OS established.

The preservation scenarios now record native device, inode, owner, full mode, link count and size before the attempted
cleanup. They compare those independently acquired values afterward and check binary sentinels containing zero and
non-UTF-8 bytes. The admission-failure case also requires the original error object as both the first aggregate member
and cause, plus a distinct cleanup error that identifies the acquired original and replacement directory. A missing
sentinel, changed mode, replaced inode or lost primary error remains a failure.

An exact permission requirement belongs to fixture setup. The attestation scenario explicitly establishes `0700` on its
new directories before comparing their owners and modes. The guard must reject the replacement because its physical
identity changed while leaving that replacement and its approval bytes intact.

Run the maintained native controls with the existing Deno permissions and without type checking:

```sh
deno test --no-check --allow-run --allow-env --allow-read --allow-write \
  tests/container.test.ts tests/attest.test.ts
```

The same test sources run in the Node and Bun compatibility suites and the isolated Linux lanes. The runner keeps its
private umask, exact archive validation and independent cleanup checks. This change concerns validation evidence; it
does not alter storage APIs, production permission policy or performance guarantees. These cooperative native identity
observations do not create an atomic boundary against hostile concurrent filesystem mutation.
