`@utils/http/response`
======================

Purpose
-------

`@utils/http/response` defines successful HTTP representations and creates
immutable logical response results.

A response definition records the stable ID, HTTP status, body schema, content
type, headers, examples, envelope policy, pagination policy, and response mode.
The package does not import Hono.  A server adapter performs final framework
materialization.

RFC 9457 error representations live in the neighboring
`@utils/http/problem` package.


Response flow
-------------

~~~~ text
endpoint handler
  -> logical response result
  -> verify declared definition and body
  -> finalize request-aware headers and pagination
  -> server framework materialization
  -> native Response
~~~~

`response.create()` combines one exact definition with the logical body.
`response.finalize()` performs the last request-aware transformation, such as
building pagination links from the public request URL.

A raw native `Response` remains an explicit escape hatch for proxying,
WebSockets, server-sent events, or provider responses.  It is not the normal
handler result.


Headers and pagination
----------------------

Header inputs preserve repeated fields.  This is required for fields such as
`Set-Cookie` that must not be flattened into one comma-joined value.

Storage adapters return transport-neutral cursor or offset page windows.  They
do not construct public URLs.  `response.finalize()` can add RFC 8288 links and
count metadata according to the response definition.

~~~~ typescript
return response.create(WidgetPage, {
  kind: 'cursor',
  items,
  limit: 50,
  hasMore: true,
  nextCursor,
});
~~~~


Special HTTP helpers
--------------------

`onComplete()` observes response-body drain, cancellation, abort, or stream
failure exactly once.

Conditional response helpers support declared `304` results.  Byte-range
helpers support single open, suffix, bounded, and unsatisfiable ranges for
artifact and download adapters.

The server package owns content negotiation, endpoint membership checks, and
conversion to the framework response object.
