`@utils/http/cookie`
====================

Purpose
-------

`@utils/http/cookie` defines application-owned HTTP cookies and provides
Fetch-native helpers to read, set, delete, compose, and document them.

A cookie definition records the stable cookie name and its security attributes.
Importing the definition does not read a request or write a response.


How it fits
-----------

This package belongs in `@utils/http` because cookies are HTTP protocol data.
`@utils/server` can apply these definitions while executing a request, but the
cookie contract does not depend on Hono or service composition.

Provider-owned authentication cookies remain inside the provider adapter that
owns them.  A generic utility should not redefine Clerk, Better Auth, or another
provider's cookie semantics.


Operations
----------

`cookie.define()` creates one immutable cookie contract.  Catalog operations
compose and select reusable sets.

`cookie.get()` reads the declared cookie from a request.  `cookie.set()` and
`cookie.delete()` create response header values from the same definition.

`cookie.document()` creates a JSON-safe view for generated references and
service documentation.

~~~~ typescript
const WorkspaceCookie = cookie.define({
  id: 'workspace',
  name: 'kaiju-workspace',
  httpOnly: true,
  secure: true,
  sameSite: 'Lax',
  path: '/',
});
~~~~

Cookie definitions should describe application protocol behavior.  They should
not contain authentication logic, session storage, or provider clients.
