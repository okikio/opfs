`@utils/failure`
================

Purpose
-------

`@utils/failure` defines expected reasons that an operation cannot complete as
intended.

A failure definition has a stable ID, a description, and a Standard Schema for
its durable data.  A runtime occurrence keeps the exact definition, validated
data, a message, and an optional in-process cause.


How it fits
-----------

Failure is not the same concept as `result` or an HTTP problem.

 -  `@utils/result` is a success-or-failure container.
 -  `@utils/failure` gives expected failures stable identity and durable data.
 -  `@utils/http/problem` describes an RFC 9457 HTTP representation.

A queue or Worker can encode a failure occurrence and decode it through a
trusted failure catalog.  An HTTP service can map the same failure to a declared
HTTP problem without adding HTTP fields to the failure definition.


Durable data
------------

`failure.encode()` validates the data again before serialization.  The encoded
form contains only the stable failure ID, durable data, and message.

The JavaScript `cause` stays local.  Provider errors, sockets, request objects,
and other non-durable values must not enter the encoded form.

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

