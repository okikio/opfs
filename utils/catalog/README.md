`@utils/catalog`
================

Purpose
-------

`@utils/catalog` groups immutable definitions without creating a global
registry.

A catalog keeps exact object identity, stable IDs, source keys, deterministic
iteration order, and key-preserving selections.  It also detects cases where
two different definitions claim the same stable ID.

Use a catalog when several reusable definitions need one named, inspectable
universe.  Do not use it as a service locator, startup mechanism, mutable
registry, or dependency container.


How it fits
-----------

Definition-oriented utilities such as `failure`, `resource`, `runtime`,
`activity`, `workflow`, `http/problem`, and `http/response` use this package to
share one composition model.

The catalog utility does not know what any entry means.  It only requires a
stable `id`.  Domain semantics stay with the package that owns the definition.


Composition rules
-----------------

`catalog.compose()` accepts direct entries, catalogs, selections, and nested
arrays.  It preserves the first occurrence of the same object and rejects a
different object that reuses the same stable ID.

`catalog.select()` keeps the original entry objects and source keys.  A
selection does not copy or redefine entries.

`catalog.document()` creates a deterministic JSON-safe view for tools and
documentation.  It does not expose the package's internal lookup maps.


Example
-------

~~~~ typescript
const Failures = catalog.create('imports.failures', {
  InvalidFile,
  CapacityUnavailable,
});

const PublicFailures = catalog.select(Failures, ['InvalidFile']);
const effective = catalog.compose(PublicFailures, CapacityUnavailable);
~~~~

Importing a catalog performs no registration.  A definition participates in an
application only because a composition root imports and uses it.

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

