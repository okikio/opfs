---
npm/@okikio/opfs: patch
---

Require Zod 4.6.7 or newer. Zod 4.6.5 and older collect one issue for every failing element of an array, with no cap, so
a large invalid array can exhaust memory while a schema validates it (GHSA-mrhx-c7xc-m3w5). OPFS validates provider
configuration, receipts and checkpoints with Zod schemas, so an application that passes untrusted values to those
schemas was exposed. The package range now excludes the affected releases; no API changes.
