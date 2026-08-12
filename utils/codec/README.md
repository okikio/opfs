`@utils/codec`
==============

Purpose
-------

`@utils/codec` defines explicit two-way data conversion with one Standard
Schema for each direction.

A codec is useful when the runtime value and serialized value are different.
Examples include dates, identifiers, provider records, persistence formats, and
wire representations.

The package deliberately uses separate decode and encode schemas.  A single
invertible schema is not assumed to describe both directions safely.


How it fits
-----------

`@utils/schema` supplies the common Standard Schema validation operations.
`@utils/codec` adds bidirectional composition on top of those operations.

Use `schema` when a value only needs validation or normalization.  Use `codec`
when callers must also convert the validated value back to a different external
form.

The codec utility does not own transport, persistence, HTTP, or provider
behavior.


Composition
-----------

The package can compose codecs for objects, optional values, nullable values,
and arrays while preserving nested issue paths.

~~~~ typescript
const UserCodec = codec.object({
  id: UserIdCodec,
  displayName: codec.optional(DisplayNameCodec),
});

const user = await codec.decode(UserCodec, stored);
const encoded = await codec.encode(UserCodec, user);
~~~~

Invalid nested data reports the complete path to the failing property.  The
conversion remains deterministic and does not mutate caller values.

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

