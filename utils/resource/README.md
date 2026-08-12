`@utils/resource`
=================

Purpose
-------

`@utils/resource` describes shared acquired capabilities and creates owned,
lazily resolved collections of their concrete implementations.

A resource definition says what a capability is and which other resources it
requires.  A resource implementation says how one host creates the exact
definition.

Definitions stay import-safe.  Acquisition starts only when a caller creates a
collection and asks for a resource.


How it fits
-----------

Concrete providers belong in `packages/`.  A Postgres package can implement a
generic database resource, and a browser package can implement a browser
resource, without moving provider code into `utils/`.

`@utils/env` can declare the environment values that a resource requires.
`@utils/context` carries cancellation and time through acquisition.
`@utils/activity` and `@utils/server` can request resources through the same
collection contract.


Ownership model
---------------

The collection owns every value it acquires.  It records acquisition order and
disposes values in reverse order.

A resource receives only its declared dependencies.  Missing implementations,
duplicate implementations, stable-ID conflicts, and dependency cycles fail
explicitly.

Acquisition is lazy and memoized.  Concurrent requests for the same definition
share the same in-progress acquisition.

~~~~ typescript
const Database = resource.define({ id: 'database' });
const DatabaseLive = resource.implement(Database, {
  create({ ctx }) {
    return openDatabase({ signal: ctx.signal });
  },
});

await using resources = resource.create(
  resource.implementations(DatabaseLive),
  { ctx },
);

const database = await resources.get(Database);
~~~~

The caller chooses the collection lifetime by choosing where `await using`
appears in control flow.

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

Ownership diagram
-----------------

~~~~ text
Collection
  |
  +-- get(Repository)
  |      |
  |      +-- get(Postgres)
  |      |      `-- acquire Postgres
  |      `-- acquire Repository
  |
  `-- async dispose
         +-- Repository
         `-- Postgres
            reverse acquisition order
~~~~

