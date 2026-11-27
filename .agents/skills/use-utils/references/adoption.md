# Adopt a verified utility contract

## Separate source from publication

The [public source tree](https://github.com/okikio/utils/tree/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7) declares
27 packages at source versions `1.0.0` or `0.1.0`. These versions identify the
checked-out manifests; they do not establish available releases.

On 2026-11-26, the npm registry returned only `0.0.0` without exports for 17
names and HTTP 404 for the other 10. No matching source release was established.
[GitHub releases](https://api.github.com/repos/okikio/utils/releases) was empty;
JSR metadata could not be read. Do not interpret that access failure as proof
that a JSR package does not exist. Recheck the intended registry before adoption.

Verify registry metadata directly, for example
[`@okikio/server`](https://registry.npmjs.org/@okikio/server). Do not inherit a
private registry scope, token requirement or install command from another
organization's package. Use the consumer's existing dependency configuration.

## Resolve the consumer

1. Read its manifests, import map, lockfile and registry configuration.
2. Record the exact registry version, vendored source or immutable commit that
   resolves the requested import. Match its license and public export map.
3. Inspect the operation's source/types and relevant tests at that resolution.
   A branch name, README example or sibling package does not establish an API.
4. If a verified release exists, add it under the consumer's version policy and
   refresh the lockfile. If only source is available, use an explicitly agreed
   source/build arrangement and test the generated artifact. Do not invent a
   registry version to make the example install.
5. Inspect the generated package engine requirements and dependency conditions,
   not only the source manifest. Preserve the consumer's declared runtime.
6. Run an import/type fixture plus the changed behavior and cleanup paths.
   Test each host whose support the change claims.

For a source checkout, follow its [repository setup and examples](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/README.md)
and [package checks](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/AGENTS.md). Its package manifests own exports;
Deno manifests and generated npm artifacts must preserve those decisions.
A publication dry run is not a release.

At the inspected commit, the [npm package generator](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/tools/packages/npm.ts)
sets `engines.node` to `>=26.10.0`; the repository toolchain pins Node26.10.0.
That is a generated-artifact requirement, even if a focused source operation
runs on an older runtime. A Node24 consumer must resolve this mismatch before
adopting that npm build; do not silently change its runtime or lower the engine
field. Inspect the exact release artifact before making a compatibility claim.

## Start with explicit configuration

This source example checks raw port text without reading ambient environment
variables. Use a resolver that points to the inspected source or an independently
verified release. It does not assert npm or JSR availability.

```ts
import * as env from '@okikio/env';
import * as schema from '@okikio/schema';

const Config = env.define({
  PORT: env.variable(schema.coerce.number({ integer: true, minimum: 1, maximum: 65535 }), {
    description: 'Port used by the listener.',
  }),
});
const config = Config.parseSync(env.record({ PORT: '8787' }));
console.log(config.PORT); // 8787
```

The [environment root](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/env/mod.ts) is validator-neutral and inert
on import. `/zod` and `/valibot` are optional adapters; `/resolve` owns explicit
source resolution. Mark sensitive fields with `secret()` and keep raw values
out of diagnostics. Validate configuration at the executable composition root.

Use `env.define()`, not the retired `env.environment()` alias. `env.manifest()`
projects configuration metadata; it is distinct from the retired
`resource.manifest()` alias, whose replacement is `resource.document()`.
The [consolidation guide](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/docs/maintenance/04-consolidation.md) records these changes.

[Schema](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/schema/mod.ts) provides native builders and Standard
Schema validation. Object schemas reject unknown keys by default. A selected
project validator can remain the owner; do not impose another validator just
because a utility accepts the same standard. Use `/codec` for explicit two-way
wire conversions and verify input and output projections separately.

## Replace a local utility by capability

List its exports and every consumer. Map each operation to an actual public
entry, compare errors, data shapes, ownership and runtime behavior, then migrate
one coherent capability. Update imports, exports, tests, docs, config and
persisted representations before removing the previous implementation.

Do not rename application aliases or an organization's scope by pattern. A historical
database/auth/SQL package may have no current counterpart. `query/postgres`
compiles SQL; it is not a general database or Drizzle executor. `authz` declares
and checks access; it is not a Better Auth factory.

Keep domain policies in their application. If a verified package cannot meet a
required contract, record the missing behavior and its test. Keep a narrow local
implementation or propose an upstream change; adopting the suite is optional.

## Sources and freshness

Checked 2026-11-26 at `32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7`:
[manifests](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/docs/01-packages.md), [environment](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/env/mod.ts),
[schema](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/schema/mod.ts), [codecs](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/schema/codec/mod.ts),
[release procedure](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/docs/maintenance/03-releases.md), and the registry
metadata described above. Recheck source and artifact when the consumer changes.
