`@utils/schema`
===============

Purpose
-------

`@utils/schema` provides the small Standard Schema operations shared by the
other generic utilities.

It recognizes Standard Schema V1 contracts, validates values, parses typed
outputs, throws one structured `SchemaValidationError`, and prefixes issue paths
when a larger composed value reports nested validation failures.


How it fits
-----------

This package prevents each utility from implementing its own schema-library
adapter.  `failure`, `codec`, `activity`, `workflow`, `http`, and other packages
can accept Standard Schema contracts without requiring Zod or Valibot in their
core APIs.

Use schema-library-specific packages only where their richer authoring metadata
is part of the job.  For example, `@utils/env/zod` can read Zod metadata while
the generic environment package still validates through Standard Schema.


Rules
-----

`schema.validate()` returns the Standard Schema result without inventing a new
issue model.

`schema.parse()` returns the typed output or throws `SchemaValidationError` with
the original structured issues.

`schema.prefixIssues()` creates new issue objects with a parent path.  It does
not mutate provider-owned issue objects.

The package owns no business schema and performs no I/O.

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

