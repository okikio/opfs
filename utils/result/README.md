`@utils/result`
===============

Purpose
-------

`@utils/result` provides a small immutable success-or-failure value for expected
caller branching.

Use it when failure is a normal branch that the caller should inspect.  Do not
use it to define failure identity, validation, serialization, HTTP status, or
retry policy.


How it fits
-----------

`@utils/failure` defines expected failure families and runtime occurrences.
`@utils/result` only carries a success value or a failure value.

This separation keeps `@utils/result` free of schemas, catalogs, and transport
concerns.  A result can therefore contain a failure occurrence, a validation
problem, a string, or another exact reason type.


Example
-------

~~~~ typescript
const value = result.fail(validationFailure);

if (result.isFailure(value)) {
  return value.failure;
}
~~~~

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

