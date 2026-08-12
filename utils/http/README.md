`@utils/http`
=============

Purpose
-------

`@utils/http` contains framework-neutral HTTP protocol utilities.

It owns the HTTP data and wire rules that endpoint definitions and server
runtimes share.  It does not own Hono, routing, middleware execution, service
compilation, or gateway composition.


Public areas
------------

`@utils/http/request`
: Parses and sanitizes an untrusted Web `Request` with explicit size and trust
  rules.

`@utils/http/cookie`
: Defines stable application cookie contracts and provides Fetch-native cookie
  helpers.

`@utils/http/response`
: Defines successful HTTP representations and runtime occurrences.  It also
  owns headers, status schemas, pagination, conditional responses, byte ranges,
  and response-body completion observation.

`@utils/http/problem`
: Defines RFC 9457 problem representations and runtime occurrences.


How it fits
-----------

Domain code can define expected failures without HTTP.  Endpoint code selects
which success responses and HTTP problems the operation may expose.  The server
runtime validates the selected definitions and materializes the final native
`Response`.

~~~~ text
domain result or expected failure
  -> endpoint response/problem selection
  -> HTTP response or RFC 9457 problem occurrence
  -> server materialization
  -> native Response
~~~~

The package remains import-safe.  Importing it performs no network access,
starts no listener, and installs no global state.

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

