`@utils/server`
===============

Purpose
-------

`@utils/server` composes HTTP application definitions into executable services
and gateways.

It owns endpoint, middleware, service, and gateway composition.  HTTP protocol
parsing and representation live in `@utils/http` so definition-only consumers
do not need Hono.


How it fits
-----------

Static definitions are import-safe.  They do not read the environment, start a
listener, configure logging, open a database, or create a provider client.

A composition root follows this sequence:

~~~~ text
import definitions and implementations
  -> compile the selected graph
  -> reject missing or conflicting contracts
  -> create owned runtime resources
  -> handle requests
  -> dispose the runtime
~~~~

`service.compile()` verifies the imported service graph and derives its route,
resource, response, problem, and policy plans.

`service.create()` creates the Hono runtime and owned resources for a compiled
service.

`gateway.compile()` resolves mounted service manifests and edge policies.

`gateway.create()` creates the Fetch-compatible gateway runtime.


HTTP relationship
-----------------

Use these packages for protocol values:

 -  `@utils/http/request`
 -  `@utils/http/cookie`
 -  `@utils/http/response`
 -  `@utils/http/problem`

The server package consumes those values.  It does not redefine them.

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

