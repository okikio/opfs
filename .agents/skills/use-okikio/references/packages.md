# Package evidence and integration

Resolve the exact package and consumer before writing usage code. A scope, name
or README example does not establish publication, exports or runtime behavior.

## Reference scope

The detailed references preserve the following dated API scopes. These are not
claims about the latest version available today. Recheck the registry and
resolved artifact when installing, upgrading or relying on a changed contract.

| Library | Reference scope | Main decision | Detail |
| --- | --- | --- | --- |
| `@okikio/undent` | Reviewed source 0.3.3; publication must be checked | Dedentation, interpolation and Unicode display width | [Undent](undent.md) |
| `@okikio/observables` | 1.4.0; npm metadata rechecked 2026-11-26 | Subscriptions, operators, EventBus and bounded consumption | [Observables](observables.md) |
| `@okikio/sparql` | Dated 0.0.2 reference | Query construction, terms and execution ownership | [SPARQL](sparql.md) |
| `@okikio/wikitext` | Experimental source 0.0.0 | Token/event/tree APIs and unimplemented targets | [Wikitext](wikitext.md) |
| `@okikio/opfs` and storage-related projects | Resolve the actual source; no universal release is asserted | Client, driver, adapter and filesystem contracts | [OPFS](opfs.md) |
| RDF/media projects | Repository-specific source and tests | Parsing, conformance, streaming and ownership | [RDF](rdf.md), [media patterns](mediad.md) |

The separate [okikio/utils](https://github.com/okikio/utils) workspace owns
Context, Task, Workflow, Server, HTTP, Schema, Env and the related focused
packages. Use [use-utils](../../use-utils/SKILL.md). Its source package versions
must not be presented as registry releases without verification.

## Classify the evidence

| Evidence | Allowed claim |
| --- | --- |
| Registry metadata plus downloaded/built artifact | Exact published version and declared consumer exports |
| Public source at an immutable commit | Implementation and public source exports at that revision |
| Consumer manifest, lockfile and import resolution | What this consumer actually uses |
| Executed fixture | Behavior exercised in its stated runtime and conditions |
| Design note, old snapshot or remembered name | A question to verify, not a current API |

Confirm source availability and publication separately. A `deno.json` name or
version does not prove a JSR release. A package tarball does not prove a browser,
worker, database or deployment path was tested.

## Trace a candidate

1. Check exact spelling, repository, license, version, lockfile and resolver.
2. Inspect the root/subpath export map and follow symbols into implementation,
   tests and a consumer. Separate public APIs from internal source files.
3. Inspect relevant siblings or adapters only far enough to find the correct
   owner. Record unsupported behavior and version-sensitive dependencies.
4. Compare schema, error, configuration, resource and runtime contracts with
   the existing application. Choose the smallest matching integration.
5. Verify import/type inference and representative success, rejection,
   cancellation and cleanup paths in the consumer's required hosts.

Treat `@okikio/obserables` as an unresolved misspelling, not an install target.
Terms such as "backend utilities" or "ClickHouse Drizzle adapter" do not
establish a public package name. The utility workspace does not provide an
implied generic database/auth factory or SPARQL executor under a new alias.

## Preserve explicit lifecycle and capability limits

- Observables compose local observation. Define buffering, errors, cancellation,
  teardown and async-consumption policy; do not infer durable delivery.
- SPARQL builders serialize query terms and expressions. Verify the installed
  transport/executor API separately from authorization, limits and engine behavior.
- Undent formats intended text. Do not apply it to machine JSON or arbitrary
  user content merely to normalize whitespace.
- Wikitext's prototype status matters. Verify public exports before relying on
  round-trip editing or progressive parsing described only in a design.
- Storage providers have different durability, atomicity and lifecycle contracts.
  Inspect the selected adapter and test the operation against that provider.

For composition, read [backend contracts](backend.md) or
[workflow contracts](workflows.md) only when that integration is in scope.

## Validate generated and installed packages

Inspect the producer's actual tasks, dependencies and permissions. Verify source
imports first, then clean generation, export/types metadata, package contents and
a packed install into a clean consumer. Test each claimed runtime and ESM/CJS
policy. Source maps, Unicode data, licenses, README and versions must match the
artifact actually shipped. A generation script alone does not establish its output.

Do not publish or run migrations simply to inspect an API. Avoid broad Markdown
formatting during generation. Record exact passed, failed and unavailable checks;
performance or standards claims need their own equivalent-workload tests.

## Sources and freshness

Standalone reference sources are linked in each detail file. Current npm
[`@okikio/observables`](https://registry.npmjs.org/@okikio/observables) metadata was
read on 2026-11-26 and reported 1.4.0 with public root and focused subpaths.
Utility source provenance and registry limits are recorded in
[utility adoption](../../use-utils/references/adoption.md). Recheck dated source
observations before treating them as current installation advice.
