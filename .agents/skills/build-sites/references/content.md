# Content collections, CMS adapters, rich text, and publishing

These are anonymized illustrative examples adapted from historical project
reviews. Local paths, identifiers, and commands describe example ownership;
they do not establish maintained APIs or executed evidence for this project.
Trace the active consumer, verify public package sources for the installed
version, and run the relevant checks before adoption.


Use this reference for local Astro content, live/runtime CMS data, migrations, previews, taxonomies, media, rich text, feeds, and SEO. The project should have one explicit runtime source of truth per route and a stable view-model interface.

## Contents

- Content evidence inventory
- Source modes and ownership
- Astro local collections
- Runtime/live CMS adapter
- Relationships and taxonomy
- Rich text and media
- Drafts, preview, scheduling, and cache
- SEO, feeds, and discoverability
- Migration and dual-source control
- Failure signatures
- Verification
- Sources and freshness

## Content evidence inventory

Inspect:

- `src/content.config.*`, `src/live.config.*`, content directories, seed/migration inputs;
- CMS integration in Astro config and generated environment/types;
- actual page/query imports;
- content schemas and relationship/reference fields;
- mapping/adapter modules;
- provider query, cache hints, pagination, status filtering, and batch APIs;
- rich-text renderer and custom block/mark handling;
- media storage/URL/transform policy;
- preview/draft/schedule authorization;
- canonical, sitemap, robots, structured data, and feed generation;
- failure behavior and tests.

Do not infer source ownership from which directory contains more content. Trace the runtime route.

## Source modes and ownership

Name every source mode:

| Mode | Appropriate use | Primary risk |
|---|---|---|
| Build-time local collection | Versioned editorial/docs content | Rebuild required for change |
| Build-time remote import | Deterministic snapshot in CI | Network nondeterminism/provenance |
| Runtime/live collection | Editor changes without rebuild | Availability, cache, authorization |
| Preview/draft | Authorized editorial review | Draft leakage/cache pollution |
| Generated documents | OpenAPI/catalog/schema output | Drift from runtime factory |
| Legacy/migration input | Reproducible transformation | Accidental second runtime source |

For each route choose one runtime source of truth. A migration can retain raw legacy content and mapping reports without querying both providers at request time.

Use a project-owned view model:

```text
local/CMS provider record
  -> provider schema validation
  -> project mapping and policy
  -> stable Article/Page/Author/Media model
  -> layout and components
```

Pages should not know provider field names, database ids, cache hint types, or raw error shapes.

## Astro local collections

The illustrative local content config separates collections for authors, series, topics, categories, articles, and pages, with Astro `reference()` relationships and image-aware schemas. The exact `astro:content`, loader, and Zod APIs depend on the installed Astro major; verify them.

Design schemas around editorial contracts:

```ts
const articles = defineCollection({
  loader: glob({ pattern: "**/*.{md,mdx}", base: "./src/content/articles" }),
  schema: ({ image }) => z.object({
    title: z.string(),
    description: z.string().optional(),
    publishedAt: z.coerce.date(),
    updatedAt: z.coerce.date().optional(),
    authors: z.array(reference("authors")).default([]),
    heroImage: image().optional(),
    heroImageAlt: z.string().optional(),
    draft: z.boolean().default(true),
    canonicalURL: z.url().optional(),
  }),
});
```

This is a pattern, not a copy-ready current API. Define invariants that cross fields:

- hero image requires useful alt unless decorative;
- scheduled/published content has valid dates;
- canonical URL follows external canonical policy;
- series number requires a series;
- required author/category relations resolve;
- draft defaults are safe;
- related content does not self-reference if forbidden.

Do not model every field optional to make a migration pass. Separate incomplete migration input from publishable content.

## Runtime/live CMS adapter

The runtime CMS example uses one Emdash live collection and queries named content types through provider functions. Its `cms.ts` maps provider entries into project-owned `CmsArticle`, `CmsAuthor`, `CmsTopic`, `CmsCategory`, `CmsImage`, heading, and page types. This adapter interface is the reusable architecture; the provider API is version-sensitive.

Adapter responsibilities:

- validate provider response and distinguish no record from provider failure;
- apply published/draft/preview policy centrally;
- normalize ids/slugs/dates and invalid-date behavior;
- batch or cache relationship lookups;
- map media to stable source/alt/dimensions;
- map taxonomy and bylines;
- retain cache hints without exposing provider types to pages;
- provide stable pagination and sort order;
- convert provider errors into project diagnostics;
- expose raw/provider data only in an authorized debug path.

```ts
type ContentResult<T> =
  | { ok: true; value: T; cache?: unknown }
  | { ok: false; kind: "not-found" | "invalid" | "unavailable"; cause?: unknown };

async function loadPublishedArticle(slug: string): Promise<ContentResult<Article>> {
  const result = await provider.getEntry("posts", slug);
  if (result.error) return { ok: false, kind: "unavailable", cause: result.error };
  if (!result.entry || result.entry.status !== "published") {
    return { ok: false, kind: "not-found" };
  }
  return mapArticle(result.entry);
}
```

Do not silently use `new Date(0)` for required publish dates without a product policy. Epoch fallbacks can put malformed content into archives/feeds. Return invalid content or use an explicit draft-only fallback.

## Relationships and taxonomy

Define identity at every handoff:

- provider/database id;
- stable content id;
- route slug;
- canonical URL;
- author/byline identity;
- taxonomy name and term slug.

The Emdash guidebook inside the upload warns that taxonomy names must match the seed exactly and that relationship functions may require the database id rather than route slug. Treat that as provider-specific and test it. An empty taxonomy result without an error is a dangerous failure mode.

Avoid N+1 queries. Prefer provider batch APIs or load relationship maps for a page of entries. If the provider lacks batching, cache within the request and measure.

Map relationships once:

```ts
type ArticleCard = {
  id: string;
  slug: string;
  title: string;
  authors: readonly { slug: string; name: string }[];
  topics: readonly { slug: string; name: string }[];
};
```

Define missing-relation behavior: build failure, draft exclusion, omitted optional relation, safe placeholder, or operator-visible invalid state. Do not insert invented authors or categories.

## Rich text and media

Keep provider-specific rich text at a named renderer handoff. Support only inspected block/mark types and define unknown behavior.

```text
Portable Text block
  -> paragraph/heading/list/quote/code/image/custom block renderer
  -> mark renderer (strong/em/link/code)
  -> URL and embed policy
  -> safe HTML/DOM
```

Never concatenate untrusted children into HTML. If a fallback renderer emits HTML, escape text and use an allowlisted mapping. For links validate protocol and apply external-link policy. For embeds validate provider and sandbox/capabilities.

Unknown blocks should produce one of:

- visible safe unsupported-block placeholder in preview;
- diagnostic plus omitted block in production;
- hard failure for publish/build if loss is unacceptable.

Media model:

```ts
type Media = {
  id: string;
  src: string;
  alt: string;
  width?: number;
  height?: number;
  mimeType?: string;
  credit?: string;
};
```

Resolve provider ids/URLs at the adapter, not throughout components. Verify local/private storage URLs, transformations, image service compatibility, missing dimensions, alt policy, remote domains, and deletion behavior.

## Drafts, preview, scheduling, and cache

Publishing state is authorization plus cache policy:

- public queries explicitly require published status;
- preview requires an authenticated/authorized editor or a bounded signed token;
- preview responses are `private, no-store` and never enter public page/CDN cache;
- scheduled content uses one documented timezone and current-time source;
- draft/schedule changes invalidate the right public artifacts;
- feeds, sitemap, listing, taxonomy, and direct slug use the same visibility policy.

Do not rely on hiding draft links if the direct route can query the entry. Do not cache preview HTML under the public URL without a varied/private key.

For runtime CMS failures define stale-if-error versus fail-closed behavior. Stale public article content may be acceptable; stale preview or access policy may not be.

## SEO, feeds, and discoverability

Derive all discovery surfaces from the same mapped model:

- unique title and description;
- canonical absolute URL;
- Open Graph/Twitter image and alt if supported;
- article dates/authors and structured data;
- sitemap inclusion/exclusion;
- robots policy;
- RSS/Atom content and absolute links;
- archive/taxonomy pagination;
- redirects from migrated slugs;
- 404/410 decision for removed content.

Do not use request host blindly as canonical origin behind proxies. Configure the trusted production site origin and test preview environments.

Feeds must escape/serialize content safely and match public visibility. A feed that sees drafts or a different sort order is a source-ownership defect.

## Migration and dual-source control

Migration sequence:

1. Preserve raw source and hashes/provenance.
2. Define source-to-target field and relationship map.
3. Transform into a versioned intermediate/project model.
4. Report invalid, missing, defaulted, and dropped data.
5. Import idempotently with stable identity.
6. Compare counts, slugs, relationships, media, dates, and sampled rendered output.
7. Generate redirects/canonical map.
8. Switch each route to one new runtime source.
9. Retain legacy files as test/migration fixtures or remove when authorized.

Never merge local and CMS arrays at runtime to “avoid losing content” without identity/conflict rules. That creates duplicate slugs, conflicting dates, and nondeterministic feeds.

## Failure signatures

| Signature | Likely cause | Next inspection |
|---|---|---|
| Draft appears in feed only | Visibility policy duplicated | Shared published query/model |
| Taxonomy page empty | Provider taxonomy name/id mismatch | Seed/schema and adapter calls |
| One page issues dozens of CMS calls | N+1 relationship loading | Batch/cache strategy |
| Missing author crashes whole listing | Required relation not validated | Publish schema and mapper policy |
| Article date is 1970 | Silent epoch fallback | Invalid-date mapping |
| Rich text loses links/marks | Plain-text fallback treated as full renderer | Block/mark capability matrix |
| Search snippet executes markup | Provider HTML inserted raw | Sanitization/mapping stage |
| Local and CMS article both render | Dual runtime source | Route query and migration switch |
| Preview leaks publicly | Auth/cache key missing | Preview route and headers |
| Image works locally, fails deployed | Storage/image service URL mismatch | Adapter, remote domain, base URL |

## Verification

1. Parse/validate every local entry and representative provider record.
2. Test required/optional/missing relationships and invalid dates.
3. Test public/draft/scheduled/preview visibility through direct and listing routes.
4. Test allowed and unknown rich-text blocks, marks, URLs, and XSS payloads.
5. Test media missing, private, deleted, malformed, and dimensionless cases.
6. Assert query counts to catch N+1 regressions.
7. Compare article/listing/taxonomy/feed/sitemap visibility and order.
8. Test cache hints, provider outage, stale fallback, and invalid response.
9. Run migration twice and assert idempotency plus reconciliation report.
10. Crawl built/runtime routes for broken links, canonicals, assets, and redirects.

## Sources and freshness

- Historical source scope: local Astro collection, Emdash integration, CMS adapter,
  route, webhook, and static documentation reviews from 2026-07-17, adapted
  into anonymized examples.
- Astro content APIs and Emdash APIs are version-sensitive. Verify the installed Astro/EMdash packages and generated types. The local Emdash examples are illustrative; current public documentation and installed types control provider API use.
