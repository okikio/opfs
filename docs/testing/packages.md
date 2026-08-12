Package testing
===============

Each `@media/*` package owns `mod_test.ts`. Tests use `node:test` for the runner
and BDD suite shape, and `@std/expect` for assertions. The same test file is also
valid under Deno.

Run all package tests with `mise run test`.
