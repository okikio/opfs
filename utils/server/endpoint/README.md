`@utils/server/endpoint`
========================

Import-safe HTTP endpoint contracts, method operations, endpoint groups, direct
runtime handler bindings, validation, documentation, and OpenAPI projection.

The package describes HTTP behavior without creating a server or importing Hono.
Server compilation combines these values with middleware, resources, policies,
and host runtime implementations.

Authoring model
---------------

Use a method helper for the common single-operation case:

```ts
import * as endpoint from '@utils/server/endpoint';
import * as response from '@utils/http/response';

export const ListWidgets = endpoint.get({
  id: 'widgets.list',
  path: '/widgets',
  query: ListWidgetsQuery,
  responses: [response.ok(WidgetList, {
    id: 'widgets:list',
    description: 'Visible widgets.',
  })],
});
```

Use path-independent operations plus `endpoint.define()` when several methods
share one path contract:

```ts
export const GetWidget = endpoint.operation.get({
  id: 'widgets.get',
  responses: [WidgetDetail],
  problems: [WidgetNotFound],
});

export const UpdateWidget = endpoint.operation.patch({
  id: 'widgets.update',
  json: UpdateWidgetInput,
  responses: [WidgetDetail],
});

export const WidgetById = endpoint.define({
  id: 'widgets.by-id',
  path: '/:widgetId',
  param: WidgetPath,
  operations: [GetWidget, UpdateWidget],
});
```

Request locations accept Standard Schema values directly: `param`, `query`,
`header`, `cookie`, `json`, `form`, and `raw`. `raw` is mutually exclusive with
parsed body contracts.

Runtime bindings
----------------

Handlers bind to exact imported definitions rather than IDs or registry keys:

```ts
export const WidgetByIdHandlers = endpoint.handler(WidgetById, {
  get: async (context) => WidgetDetailResult,
  patch: async (context) => UpdatedWidgetResult,
});
```

The binding retains the exact endpoint and operation objects. Service
compilation verifies exhaustive handler coverage and declared result envelopes.

Composition and artifacts
-------------------------

- `endpoint.group()` creates a reusable path-prefixed endpoint collection.
- `endpoint.select()` creates a named key-preserving subset.
- `endpoint.compose()` flattens nested definitions, groups, catalogs, and
  selections while retaining direct identities.
- `endpoint.validate()` checks methods, paths, inputs, IDs, and result envelopes.
- `endpoint.document()` creates deterministic JSON-safe documentation.
- `endpoint.openapi()` projects an endpoint-only OpenAPI document. A service
  should normally generate OpenAPI from the compiler-resolved service graph so
  inherited policies and generated failures are included.

Definitions snapshot nested author-supplied arrays. Mutating the source arrays
after construction cannot alter the imported application graph.
