`@utils/http/problem`
=====================

Purpose
-------

`@utils/http/problem` defines RFC 9457 HTTP error representations.

A problem definition records the public type URI, HTTP status, title,
description, retry guidance, exposure policy, examples, and optional extension
schema.  A problem result contains the final RFC 9457 body and HTTP headers.

The package is generic across HTTP applications, but the concept itself is
HTTP-specific.


How it fits
-----------

`@utils/failure` defines an expected operation failure that can exist without
HTTP.  `@utils/http/problem` defines what an HTTP caller is allowed to see.

A service can translate one expected failure into a declared problem.  The
failure definition should not gain HTTP status codes merely because one API
exposes it.

Some problems have no domain failure at all.  Unsupported media type, malformed
request syntax, and an undeclared handler result are examples of protocol or
server conditions.


Public safety
-------------

Problem extensions cannot overwrite canonical RFC 9457 members.  An optional
Standard Schema validates extension data before the server sends it.

Definitions distinguish public and internal exposure.  Provider causes can be
retained in hidden local metadata for diagnostics while the public problem body
stays controlled.

~~~~ typescript
const NotFound = problem.define({
  id: 'widgets.not-found',
  type: 'https://api.example.test/problems/widget-not-found',
  status: 404,
  title: 'Widget not found',
  description: 'The widget does not exist or is not visible.',
});
~~~~

`problem.catalog()`, `select()`, and `compose()` build declared problem
universes.  `problem.is()` and `match()` preserve exact definition identity at
runtime.
