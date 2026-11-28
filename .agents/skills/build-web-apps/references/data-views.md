# Data views, URL state, tables, virtualization, and selection

These are anonymized illustrative examples adapted from historical project
reviews. Local paths, identifiers, and commands describe example ownership;
they do not establish maintained APIs or executed evidence for this project.
Trace the active consumer, verify public package sources for the installed
version, and run the relevant checks before adoption.


Use this reference for search, filters, sorting, faceting, pagination, tables, cards, charts, infinite lists, virtualized views, bulk selection, and mutations. Separate domain/query semantics from presentation state.

## Contents

- Evidence and ownership inventory
- State ownership model
- Validated URL and canonical query identity
- Query loading and mutation contracts
- Table and list semantics
- Selection and bulk action policy
- Pagination, infinite loading, and virtualization
- Responsive and accessible data presentation
- Failure signatures
- Verification
- Sources and freshness

## Evidence and ownership inventory

Inspect:

- route search schema, defaults, canonicalization, and `loaderDeps`;
- query-options/key factory, loader prefetch, component observer, stale/cache policy;
- server function/repository schema and tenant scope;
- sorting/filtering/pagination execution owner;
- stable row id and revision/freshness metadata;
- table, virtualizer, chart, drag/drop, and component versions;
- selection model and bulk authorization;
- loading/pending/stale/empty/partial/error states;
- mutation invalidation/rollback;
- SSR/hydration and scroll/focus restoration;
- large-data and accessibility tests.

## State ownership model

| State | Owner | Examples |
|---|---|---|
| Shareable/navigation | Validated URL | query, filters, sort, page, page size, view mode |
| Remote/server | Query cache/route loader | results, facets, totals, revision |
| Local view | Component/table | open panel, hovered row, draft query, column resizing |
| Selection | Explicit policy store | selected ids/exclusions/scope |
| Session preference | Persistent app preference | density, optional column visibility |
| Authority | Server | tenant, allowed fields/actions, total matching set |

Do not put modal open, hover, every keystroke, or pending animation into the URL. Do not duplicate remote results into a global store without an offline/editing contract.

Large datasets normally execute sort/filter/page on the server. A headless table owns column/header/row presentation state; it does not make database ordering authoritative.

## Validated URL and canonical query identity

The illustrative product search route follows this ownership chain:

```text
URL search
  -> Zod validation/defaults
  -> strip canonical defaults
  -> loader dependencies
  -> queryOptions(organization + validated search)
  -> loader ensureQueryData
  -> component observes same query
```

```ts
const searchSchema = z.object({
  q: z.string().catch(""),
  technologies: z.array(z.string().min(1)).catch([]),
  page: z.number().int().positive().catch(1),
  page_size: z.number().int().min(10).max(50).catch(20),
  sort: z.enum(["relevance", "recent", "company_asc"]).catch("relevance"),
});
```

Use the installed router's adapter/API when required; direct Zod v4 support and middleware APIs are version-sensitive.

Define dependent reset rules:

- query/filter/sort/page-size change resets page to 1;
- page change preserves filters;
- clearing a filter removes/canonicalizes the URL value;
- invalid values parse to safe defaults or a deliberate error;
- default values can be stripped from canonical URLs;
- arrays have stable ordering/encoding when identity depends on them.

Canonical query identity must include every input that changes results, including organization/tenant:

```ts
function resultsQuery(input: { organizationId: string; search: Search }) {
  return queryOptions({
    queryKey: ["lead-search", input.organizationId, input.search],
    queryFn: () => searchLeads({ data: input.search }),
  });
}
```

The uploaded source expands fields individually in the key, which is also valid if kept complete and stable. Loader, component, prefetch, and invalidation must call the same factory.

## Query loading and mutation contracts

Distinguish:

- initial pending with no data;
- background fetching with usable stale data;
- empty successful result;
- partial result/facets;
- retryable transport failure;
- invalid/forbidden request;
- stale revision and refresh;
- mutation pending/conflict/rollback.

Do not render `query.data!` unless loader/query integration guarantees it on every path and error/pending states cover failures. TanStack router-query SSR integrations differ by framework/version. Current official guidance distinguishes server-executed suspense/loader prefetch from client-only plain queries; verify Solid package behavior.

For mutations invalidate the exact affected keys. Adding items to a saved list should not refetch unrelated search results unless server facts changed. Use stable key helpers for targeted invalidation.

## Table and list semantics

Choose presentation from user task:

- semantic table for comparison across consistent columns;
- cards/list for heterogeneous summary and narrow layouts;
- description list for key/value record details;
- chart plus table/text alternative for patterns over numbers;
- tree/grid only when their richer keyboard models are implemented.

Use stable domain row identity. Array index breaks selection, row expansion, animations, drag/drop, and virtualizer measurement when rows reorder.

Table requirements:

- `<caption>` or equivalent contextual name;
- `<th scope="col">`/row headers and correct header groups;
- sorting control announces state with `aria-sort` on the current header;
- numeric alignment and machine-readable values where useful;
- overflow container that does not hide focus;
- sticky/pinned columns with correct overlap/background/z-index;
- resizers with keyboard/accessibility policy if user-operable;
- empty/loading/error rows use correct `colSpan` and status semantics.

Do not add `role="grid"` to a native table unless implementing the grid keyboard/focus model.

## Selection and bulk action policy

Define selection scope explicitly:

1. Loaded rows only.
2. Current page.
3. Manually selected stable ids across pages.
4. All rows matching the current query, represented as query identity plus exclusions.

Never infer all-matching selection from a header checkbox alone.

```ts
type Selection =
  | { kind: "ids"; ids: ReadonlySet<string> }
  | { kind: "all-matching"; query: SearchIdentity; excluded: ReadonlySet<string> };
```

Bulk request sends an explicit versioned policy. The server revalidates tenant, current query, record eligibility, limits, and actor authorization. Counts shown to the user must correspond to the same scope.

The illustrative search UI keeps selected company ids local and labels its checkbox “Select page,” which honestly describes current-page behavior. Selection persists across page changes because ids are stored; product policy should decide whether that is intended and show scope/count clearly.

## Pagination, infinite loading, and virtualization

Pagination contract:

- stable deterministic sort with tie-breaker;
- one-based/zero-based policy mapped once;
- total/page-count semantics, including zero results;
- page out-of-range behavior after data changes;
- cursor versus offset ownership;
- URL/back/forward/scroll restoration;
- server-enforced page-size limits.

Infinite loading adds concurrency and completion:

- `hasMore`, fetching state, cursor identity, retry;
- prevent repeated fetch at threshold;
- deduplicate records across pages;
- preserve ordering when response arrival is reordered;
- announce load result without noisy per-scroll updates;
- provide a reachable non-infinite/paginated alternative where required.

TanStack Table does not include virtualization itself; pair it with TanStack Virtual or another virtualizer. One reviewed application's table:

- separates top-pinned, center, and bottom-pinned rows;
- virtualizes center rows;
- uses leading/trailing spacer rows;
- resolves scroll container;
- supports custom stable item keys and row measurement;
- exposes overscan/estimate size;
- triggers fetch-more near the final virtual item;
- renders loading/completion rows.

That is a capable implementation shape, not proof of every accessibility behavior.

Virtualization contract:

- measured need and dataset size;
- stable `getItemKey` from row id, never index fallback when order changes;
- fixed or dynamic measurement and resize invalidation;
- overscan based on interaction/focus, not arbitrary large values;
- scroll element and nested scroll containers;
- pinned rows/headers outside the virtual range;
- SSR initial range and hydration;
- focus when row leaves rendered window;
- screen-reader semantics/count/position;
- find-in-page/export/print alternative;
- memory/DOM bound and fetch threshold.

## Responsive and accessible data presentation

Do not hide essential columns at narrow widths without an alternate path. Options:

- horizontal scroll with clear affordance and sticky primary column;
- responsive card/details presentation from the same row view model;
- user-configurable columns persisted as a preference;
- priority columns plus an accessible row-details disclosure.

Keep the DOM/source order meaningful. Test zoom, long content, localization, forced colors, focus across sticky elements, and touch resizing/dragging.

Charts require title/description, textual summary, and tabular or downloadable data when users need exact values. Do not encode categories only by color.

Loading skeletons should preserve expected geometry and not claim data. Empty states distinguish no records, no filter matches, forbidden data, and unavailable service.

## Failure signatures

| Signature | Likely cause | Next inspection |
|---|---|---|
| Deep link refetches different data | URL schema/query key mismatch | Validated search and key factory |
| Filter resets unrelated state | URL patch replaces instead of merges | Navigation update function |
| Page change loses filters | Search params not retained | Functional search update |
| Cross-org cache leak | Tenant omitted from query key/server scope | Key and repository policy |
| Selection moves to another row | Index identity | Row id/getItemKey |
| “All selected” only affects visible rows | Scope ambiguous | Selection union/request contract |
| Infinite loader calls repeatedly | Threshold/fetch state race | last item, `isFetchingMore`, cursor |
| Virtual row overlaps/jumps | Wrong estimate/measurement/scroll element | Virtualizer config |
| Focus disappears during scroll | Focused row unmounted | Overscan/focus/alternative policy |
| Empty screen during background fetch | Initial and stale-fetch states collapsed | Query status model |
| Sort looks active but server ignores it | Table presentation disconnected from query | URL/repository sort mapping |

## Verification

1. Copy/reload/back/forward URLs for every filter/sort/page combination.
2. Invalid/default URL canonicalization and dependent page reset.
3. Assert loader/component/invalidation keys are identical and tenant-scoped.
4. Test initial, stale, empty, partial, error, retry, offline, and refresh states.
5. Stable ordering/tie-breakers across insertion/deletion and pagination.
6. Selection across sort, refresh, pages, deletion, and tenant authorization.
7. Virtualizer stable keys, measurement, resize, pinned rows, dynamic height, SSR, and scroll restore.
8. Keyboard/screen-reader table semantics, focus while virtualizing, zoom, responsive overflow, and touch.
9. Infinite loading reordered responses, duplicate data, threshold, completion, and retry.
10. Measure DOM/memory/frame/interaction cost with realistic large data.

## Sources and freshness

- Historical source scope: TanStack Solid Router/Query search and React
  table/virtualizer reviews from 2026-07-17, adapted into anonymized examples.
- TanStack Router search params: https://tanstack.com/router/latest/docs/guide/search-params (reviewed 2026-07-17).
- TanStack Router Query integration: https://tanstack.com/router/latest/docs/integrations/query (reviewed 2026-07-17).
- TanStack Table virtualization: https://tanstack.com/table/latest/docs/guide/virtualization (reviewed 2026-07-17).
- Router, Query, Table, and Virtual APIs vary by framework/version. Inspect installed package docs/types and do not translate React examples mechanically into Solid.
