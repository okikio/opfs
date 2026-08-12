`@utils/http/request`
=====================

Purpose
-------

`@utils/http/request` parses and sanitizes an untrusted Web `Request` before a
service gives values to endpoint-specific schemas or domain code.

The package preserves protocol details that are easy to lose accidentally:
repeated values, exact raw bytes, forwarding trust, bounded inputs, credential
redaction, content negotiation, trace correlation, and request-owned memoized
work.

It does not authenticate credentials, authorize actors, apply tenant policy, or
compile a database query.


Request flow
------------

~~~~ text
untrusted HTTP request
  -> syntax and size checks
  -> normalized HTTP values
  -> endpoint Standard Schema validation
  -> typed application input
~~~~

`parseParameters()`, `parseQuery()`, `parseHeaders()`, and `parseCookies()`
retain the information needed by later validation instead of silently choosing
one repeated value.

`readBody()`, `parseJson()`, and `parseForm()` enforce independent body limits.
`parseAuthorization()` parses credential syntax but redacts the credential when
it is stringified or serialized.


Trust and correlation
---------------------

`externalUrl()` ignores forwarding headers unless the caller supplies an
explicit trusted-proxy policy.  Host and protocol allowlists prevent a caller
from selecting the public origin used for links or redirects.

`correlation()` validates W3C trace fields and request IDs.  The HTTP value is
named `requestId` because it identifies an HTTP request.  A server can copy that
value into the generic execution context as `ctx.id`.

`correlationFields()` returns safe structured identifiers for logging.  It does
not include authorization values, cookies, query values, or request bodies.


Request-owned memoization
-------------------------

`memoize()` shares pending request work such as authentication, body reads,
hashes, or canonical-origin resolution.  Failed loads are removed so an
explicit retry can run.

`disposeMemo()` releases disposable memoized values after the response body
finishes, cancels, aborts, or fails.  Releasing values only when headers are
created would end request-owned resources too early for streaming responses.
