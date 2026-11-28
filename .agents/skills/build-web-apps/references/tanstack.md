# TanStack Start, Router, Query, Form, Table, and Virtual

These are anonymized illustrative examples adapted from historical project
reviews. Local paths, identifiers, and commands describe example ownership;
they do not establish maintained APIs or executed evidence for this project.
Trace the active consumer, verify public package sources for the installed
version, and run the relevant checks before adoption.

## Contents

- Ecosystem ownership
- Route tree and layouts
- URL/search contract
- Loaders and Query identity
- Server functions
- Mutations and invalidation
- Forms
- Tables and virtualization
- SSR, streaming, and deployment
- Failure signatures
- Verification
- Sources and freshness

## Ecosystem ownership

Treat TanStack as a family of complementary packages, not one framework import.

| Package | Owns | Does not own |
|---|---|---|
| Start | full-stack runtime, server functions, SSR/build integration | domain/service architecture |
| Router | route tree, params, search, loaders, navigation context | remote cache contents |
| Query | server-state cache, retries, freshness, invalidation, cancellation | shareable navigation semantics |
| Form | client field/form state and validation ergonomics | server trust/authorization |
| Table | headless column/row/filter/sort/selection model | remote fetching or rendering style |
| Virtual | bounded rendering window and measurement | table semantics/accessibility policy |

Use the renderer-specific packages (`@tanstack/solid-*` in a Solid app). The illustrative Better Auth integration includes copied React Table/Form components inside an Astro/React surface; they are not Solid implementation evidence.

## Route tree and layouts

Use route groups/pathless layouts to separate organizational source layout from public URL shape. An authenticated shell can live in `_app` without adding `_app` to the URL.

Define root context once:

```ts
interface AppRouterContext {
  queryClient: QueryClient;
  session?: Session;
}

export const Route = createRootRouteWithContext<AppRouterContext>()({
  component: RootDocument,
});
```

`beforeLoad` can establish redirect/context prerequisites, but server authorization remains required in server functions/services. Preserve the intended destination when redirecting to sign-in and validate it before redirecting back.

Route file-ignore patterns are architecture. The illustrative Vite config excludes component folders, underscore helpers, server files, and tests from route generation. Verify generator output whenever the naming pattern changes.

## URL/search contract

Put only shareable/navigable state in search parameters: query, filters, sort, page/cursor when meaningful, view mode when users expect a copied link to retain it.

Do not put transient hover, open dialog, local row selection, draft keystrokes, secrets, or opaque remote objects in the URL.

Use a schema as the route entrypoint:

```ts
const leadSearchSchema = z.object({
  q: z.string().trim().max(200).catch(""),
  technologies: z.array(z.string()).catch([]),
  sort: z.enum(["relevance", "name", "updated"]).catch("relevance"),
  page: z.coerce.number().int().positive().catch(1),
});

export const Route = createFileRoute("/(product)/_app/(search)/search")({
  validateSearch: leadSearchSchema,
  search: {
    middlewares: [stripSearchParams({ q: "", technologies: [], sort: "relevance", page: 1 })],
  },
  loaderDeps: ({ search }) => leadSearchSchema.parse(search),
});
```

The exact `search.middlewares` API is version-specific. The historical example used `validateSearch`, `stripSearchParams`, and `loaderDeps`; inspect the installed Router release before copying syntax.

Reset dependent state explicitly: changing a filter should reset page/cursor. Canonicalize empty/default values to avoid equivalent URLs fragmenting cache and analytics.

## Loaders and Query identity

Create one option factory per remote operation and reuse it in route loader and component:

```ts
function leadSearchOptions(input: LeadSearch) {
  return queryOptions({
    queryKey: ["leads", "search", input],
    queryFn: ({ signal }) => searchLeads({ data: input, signal }),
    staleTime: 30_000,
  });
}

export const Route = createFileRoute("/search")({
  validateSearch: leadSearchSchema,
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) => context.queryClient.ensureQueryData(leadSearchOptions(deps)),
});
```

Check the installed server-function call signature for signal support. The important invariant is identity and cancellation, not this exact example syntax.

Query keys must contain every value that changes the response, including organization/tenant context, permissions or projection version when the same browser session can switch them. Do not put secrets or unbounded objects in a key.

Define:

- stale time from product freshness;
- garbage collection from navigation and memory needs;
- retry by error kind/idempotency;
- cancellation behavior;
- placeholder/previous data versus loading distinction;
- refetch triggers;
- persistence/broadcast owner if added;
- invalidation from mutations.

Do not mirror query results into signals. Derive presentation through memos/selectors while Query remains the remote-cache owner.

## Server functions

A server function is a transport handoff, not a service-module replacement.

```ts
export const searchLeads = createServerFn({ method: "GET" })
  .inputValidator(leadSearchSchema)
  .handler(async ({ data }) => {
    const session = await requireSession();
    return leadService.search({ organizationId: session.organizationId, ...data });
  });
```

Exact middleware/input APIs are versioned. Preserve this sequence regardless:

1. parse input on the server;
2. resolve session;
3. authorize organization/resource;
4. apply server-owned scope;
5. call a reusable service operation;
6. map known failures to a safe stable result;
7. record redacted diagnostics/correlation.

Never trust the `organizationId`, price, plan, role, or redirect URL supplied by the browser. The illustrative application wraps billing and auth operations in server functions and forwards request headers to Better Auth; inspect that server-function handoff for every mutation.

## Mutations and invalidation

Classify mutation behavior:

- idempotent create/update with a stable request key;
- non-idempotent external side effect;
- optimistic local/cache update with rollback;
- durable background request returning operation status;
- synchronous server transaction.

Use query-key factories for invalidation so reads and writes agree. Prefer updating a detail cache from the authoritative response and invalidating dependent lists/counts. Avoid “invalidate everything” when it creates expensive refetch storms.

Optimistic update requires:

1. cancel relevant in-flight reads;
2. snapshot previous cache;
3. apply a deterministic optimistic value;
4. restore on failure;
5. reconcile server response;
6. refetch when server-side ordering/counts may differ.

Test two concurrent mutations and response reordering. A last-write UI assumption may not match database conflict semantics.

## Forms

TanStack Form can own field state, touched/dirty/pending/error state, and client validators. Keep a server schema and server authorization authoritative.

Renderer mismatch is a real failure mode: a reviewed React and Better Auth surface imports `@tanstack/react-form`. Do not copy that into the Solid TanStack Start app; use the installed Solid package and Solid examples.

Define whether validation occurs on change, blur, submit, and asynchronously. Cancel stale async validators. Map stable server field errors back to fields while retaining a form-level unexpected failure.

After submit, disable/dedupe or define superseding semantics. Preserve values after recoverable errors and move focus to an error summary/first invalid field accessibly.

## Tables and virtualization

Table is headless. The application still owns:

- column definitions and stable IDs;
- controlled sorting/filtering/pagination;
- remote versus client processing mode;
- row identity and selection across pages;
- visibility/order/pinning persistence;
- empty/loading/error states;
- cell semantics and responsive layout;
- authorization for bulk actions.

Do not enable both remote sorting and a client sorting model accidentally. Encode server-supported public fields/operators, not arbitrary database identifiers.

Virtualization is justified by measured DOM/layout cost. It adds dynamic measurement, overscan, scroll restoration, sticky-header, focus, screen-reader, resize, and SSR complexity. A paginated table may be a better product/accessibility tradeoff.

Keep focused/selected rows reachable. Test zoom, font loading, variable row height, expanded rows, responsive columns, and direct restoration.

## SSR, streaming, and deployment

Create one QueryClient per server request and a long-lived browser client. Never share a mutable server cache across users. Align dehydration/hydration and route-loader identity.

Keep browser-only libraries out of server module initialization. Validate environment separation and adapter support for request headers, cookies, streaming, abort, background work, and native dependencies.

The illustrative application combines TanStack Solid Start, Nitro Vite, and a target deployment adapter. A successful Vite build does not prove deployed request/cookie/database behavior. Run adapter-equivalent requests.

## Failure signatures

| Signature | Likely defect | Evidence |
|---|---|---|
| loader fetches then component fetches again | option/key mismatch | compare factories and hydration state |
| copied URL loses filters | local state owns navigable values | route search schema/navigation |
| cache shows another organization | tenant missing from key or server scope | key plus authorization test |
| page remains high after filter | dependent URL state not reset | search transition test |
| server function can query arbitrary tenant | browser input trusted | cross-organization test |
| optimistic row jumps/disappears | server sort/count differs | reordered/concurrent mutation test |
| React package in Solid file | ecosystem binding copied | manifests/imports/compiler |
| SSR users share cache | process-global QueryClient | concurrent request isolation |
| virtual table loses focus | windowing owns keyboard target badly | keyboard/scroll test |
| auth redirect loops | route guard/session cookie mount mismatch | request trace and redirect destination |

## Verification

- generate/inspect route tree and direct-load every protected/public route;
- copy and reload URLs with valid, default, invalid, and legacy search values;
- assert loader/component use one option factory/key;
- test cancellation, retries, offline, stale/placeholder/error states;
- test cross-tenant server-function calls directly;
- test mutation double-submit, reordering, rollback, and invalidation;
- server-render/hydrate with isolated QueryClient instances;
- test table keyboard/selection/pagination/virtualization at representative size;
- run production SSR build and deployment-adapter smoke tests.

## Sources and freshness

- Primary starting points: [TanStack Start](https://tanstack.com/start/latest), [Router](https://tanstack.com/router/latest), [Query](https://tanstack.com/query/latest), [Form](https://tanstack.com/form/latest), [Table](https://tanstack.com/table/latest), and [Virtual](https://tanstack.com/virtual/latest), checked 2026-07-17 for current product scope.
- Historical source scope: a Solid/Start application review from 2026-07-17, adapted into anonymized route, query, and auth-integration examples.

TanStack package signatures and Start deployment behavior evolve quickly and vary by renderer. Exact imports, server-function APIs, generated route behavior, and adapters are version-sensitive; verify the target lockfile and primary docs.
