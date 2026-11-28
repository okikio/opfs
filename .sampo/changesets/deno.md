---
npm/@okikio/opfs: patch
---

Document Deno file ownership and keep the native declaration graph complete.

The native driver keeps finite range reads, stream writes, queued positional sessions and synchronous access under
separate resource owners. Existing imports continue to use `@okikio/opfs/driver/deno`.

The npm build now follows the emitted local declaration imports and re-exports before attaching the official Deno type
reference. Missing declaration files fail the build. Installed consumer checks cover the range, writable and synchronous
constructors and the stream writer while keeping Deno globals out of portable consumers.

The host guide explains which constructors take ownership of an open file, which operation borrows it, and how
cancellation or close retires it.
