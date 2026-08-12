`@utils/activity`
=================

Purpose
-------

`@utils/activity` defines external work that a workflow can request and a host
can execute.

An activity definition records the stable contract for one operation:

 -  input and result schemas
 -  expected failures
 -  logical runtime placement
 -  required resources and permissions
 -  resilience policy

The definition is import-safe.  It does not open a database, start a Worker,
read environment variables, configure logging, or perform the external work.


How it fits
-----------

`@utils/workflow` owns orchestration.  It yields an activity command when a
workflow requests external work.  `@utils/activity` owns the activity contract
and the direct host execution rules.

`@utils/runtime` supplies logical placement definitions.  `@utils/resource`
supplies the resource resolver that an activity implementation can use.
`@utils/failure` supplies stable expected failures.  Concrete providers remain
in `packages/`.

This separation lets the same activity definition participate in a durable
workflow, a local test, or a direct host call without putting provider logic in
the definition.


Execution model
---------------

`activity.run()` creates a workflow operation.  It does not start work.

`activity.execute()` performs one concrete implementation immediately.  It:

1. validates the job identity and attempt number;
2. validates the activity input;
3. creates a child execution context whose `id` is the activity job ID;
4. exposes only the declared resources;
5. runs the implementation;
6. validates the returned result;
7. rejects expected failures that the activity did not declare.

`activity.try()` converts only declared activity failures into an explicit
`@utils/result` value.  Unexpected faults still escape.


Example
-------

~~~~ typescript
const FetchPage = activity.define({
  id: 'page.fetch',
  input: FetchPageInput,
  result: FetchPageResult,
  failures: [FetchTimedOut],
  runtimes: [BrowserRuntime],
  resources: [HttpClient],
});

const result = yield* activity.try(FetchPage, { url });
~~~~

A durable workflow package may replay the activity command.  The activity
utility itself does not own persistence, claims, retries, or queue storage.

Progressive usage
-----------------

The package participates in the complete domain-enrichment example in
`docs/implementation/utils-progressive-usage.md`.  Read that guide when the
individual helpers make sense in isolation but their place in a service,
resource graph, runtime host, or workflow is not yet clear.

`API.md` is the exhaustive public-surface map for this package.  It lists every
package export target, explains each exported name, gives a compact use form,
and expands every detected repository use into a source-backed TypeScript
snippet.  An export with no current consumer stays labelled as unproven instead
of receiving an invented production example.

