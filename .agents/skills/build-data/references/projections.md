# Search, graph, and analytical projections

Use this reference when authoritative data is copied into Typesense or another search engine, QLever/Blazegraph or another graph query engine, ClickHouse, a materialized view, or a cache. A projection is operationally complete only when its identity, build, publication, lag, deletion, reconciliation, and rollback contracts are explicit.

## Contents

- Authority and projection ownership
- Change identity and projector contract
- Search projections
- RDF and SPARQL projections
- Analytical projections
- Versioned build and atomic publication
- Deletion, correction, and privacy
- Reconciliation and repair
- Integration sequence
- Failure and recovery
- Test matrix
- Executable verification
- Deliberate exclusions
- Sources and freshness

## Authority and projection ownership

For each projected fact, name:

- the authoritative source and transaction scope;
- the durable change identity or replay source;
- the projector version and configuration;
- the target document/subject/row identity;
- expected lag and freshness objective;
- deletion/tombstone behavior;
- whether the projection is required for product availability;
- who can trigger a backfill, cutover, rollback, or targeted repair.

Do not call a search or graph store authoritative merely because it serves reads. Serving authority and data authority are different. A store can own query availability while remaining rebuildable from PostgreSQL, immutable artifacts, or another source.

Inspect active startup configuration, container scripts, query endpoints, schemas, seeders and ingestion jobs. Older migrations and comments may describe replaced engines. Choose query and rebuild semantics from the engine that actually receives writes and serves reads.

## Change identity and projector contract

A projector should behave like this:

```ts
interface ProjectionChange<T> {
  changeId: string
  authorityVersion: string
  entityId: string
  operation: 'upsert' | 'delete'
  occurredAt: string
  schemaVersion: string
  payload?: T
}

interface ProjectionReceipt {
  projection: string
  projectionVersion: string
  changeId: string
  targetIdentity: string
  status: 'applied' | 'already-applied' | 'rejected'
  appliedAt: string
}
```

The projector must be idempotent by `changeId`, target version, or another proven mechanism. “Upsert” is not sufficient if applying an older event after a newer one can regress state. Carry authority version/event time and define ordering or compare-and-ignore behavior.

If writes originate in PostgreSQL, use a transactional outbox, logical change stream, or another durable change source when losing the projection update is unacceptable. Writing PostgreSQL and Typesense/QLever/ClickHouse in one request handler is a dual write, not a transaction.

## Search projections

Define a search collection contract independently of the source record:

```ts
interface SearchDocumentV3 {
  id: string
  tenantId: string
  title: string
  aliases: string[]
  status: 'active' | 'archived'
  authorityVersion: string
  indexedAt: string
}
```

Decide and test:

- stable document ID and tenant namespace;
- searchable versus facetable versus sortable fields;
- tokenization, locale, stemming, typo tolerance, synonyms, and infix behavior;
- optional/null/empty handling;
- nested and array field behavior;
- ranking and tie-break rules;
- per-tenant filter applied by the server, not trusted from the client;
- batch import/upsert response inspection per document;
- delete and tombstone propagation;
- schema evolution and rebuild triggers;
- alias or collection cutover support in the installed engine/version.

Bulk APIs can return a successful HTTP response while individual documents fail. Parse every item result, quarantine rejected documents with safe reasons, and reconcile requested IDs against accepted IDs.

A registered sink that only logs an intended write is a placeholder. Trace the network/storage operation and inspect its result contract before calling the projection implemented. For a bulk import, reconcile each requested document with its item result.

## RDF and SPARQL projections

An RDF projection needs explicit term and ontology ownership:

- base IRI and stable subject identity;
- namespace registry and prefix versions;
- source-to-RDF mapping version;
- literal datatype and language-tag rules;
- blank-node policy; use stable IRIs where cross-run identity matters;
- ontology and inference version;
- named graph or dataset ownership if used;
- serialization and parser version;
- duplicate triple and delete/correction model;
- engine update capability versus rebuild-only operation;
- query endpoint, timeout, result limits, and service owner.

N-Triples append is easy to implement and hard to correct. Appending a changed record can leave the old triple present. Define whether the build is a full immutable dataset, per-source graph replacement, or an update-capable store. If full rebuild is the contract, publish a complete versioned dataset and atomically switch the serving index.

Flushing an in-memory RDF graph by batch can bound graph memory. It does not establish record checkpoints, atomic publication across files, deletion behavior or a manifest. Build a serving index from a named complete input set and record which input set was successfully published.

For SPARQL queries, test the active engine rather than assuming common semantics cover:

- supported SPARQL version/features;
- timeout and result-size limits;
- property paths, full-text extensions, and service clauses;
- datatype comparisons and unbound variables;
- query plan behavior for the actual data distribution;
- update availability and authorization;
- inference/materialization behavior.

## Analytical projections

For ClickHouse, aggregate tables, or analytical materialized views, define:

- event/row identity and deduplication policy;
- source event time, ingest time, and correction version;
- column types, null/default semantics, and schema evolution;
- partition and ordering keys derived from query/lifecycle needs;
- late-arrival window and backfill path;
- mutable correction semantics and convergence checks;
- aggregate refresh/materialization ownership;
- retention/TTL and legal-delete propagation;
- query consistency expected by callers.

Do not promise immediate row uniqueness or synchronous update semantics merely because the projection exposes SQL. Keep transactional invariants in their authoritative owner and document analytical convergence.

## Versioned build and atomic publication

Prefer versioned targets:

```text
authority snapshot/outbox commit point: 004182
projection schema: search-comic-v7
target: comics_20260717_142233_v7
checkpoint: through change 004182
```

Build sequence:

1. Freeze or name the input snapshot/change capture point.
2. Create a new target/index/collection/dataset with the declared schema.
3. Stream bounded batches and inspect every batch receipt.
4. Record rejects without silently omitting them.
5. Reconcile counts, IDs, tenant/domain invariants, and sampled content.
6. Run representative queries and latency/error checks.
7. Atomically switch an alias/router/config pointer where supported.
8. Observe the new target through the real application.
9. Retain the previous target for a defined rollback window.
10. Delete old targets only after rollback and retention requirements expire.

If the engine lacks an atomic alias, design a routing layer or a maintenance-window cutover. Do not rename a multi-step replacement “zero downtime” without a concurrency test.

## Deletion, correction, and privacy

Deletion is a first-class projection operation. Define:

- hard delete, tombstone, or hide policy;
- propagation deadline;
- how a rebuild learns that a source record was deleted;
- how old immutable artifacts are retained or redacted under policy;
- how derived documents/triples/aggregates are located;
- how deletion is confirmed across all required projections;
- how a failed deletion is retried and escalated.

Full-snapshot rebuilds naturally drop absent records only if the target is replaced wholesale. Incremental upserts do not. Maintain tombstones or compare authoritative and projected identity sets.

Corrections need version-aware application. A late retry of source version 4 must not overwrite version 5. For RDF builds, correction may require rebuilding the relevant graph/dataset because an appended replacement triple does not remove the old one.

## Reconciliation and repair

Use several layers of reconciliation:

| Layer | Example proof |
|---|---|
| Transport | Every requested batch item has a success or rejected receipt |
| Identity | Authoritative active IDs equal projected active IDs for one projection scope |
| Counts | Per tenant/status/day counts agree within declared semantics |
| Content | Deterministic hashes of normalized projection records match |
| Domain | No public document references deleted/private authority rows |
| Query | Representative search/SPARQL/analytical queries return expected fixtures |
| Freshness | Checkpoint lag and oldest unapplied change stay within objective |

Support both targeted repair and full rebuild. Targeted repair accepts an authoritative identity/range and is idempotent. Full rebuild uses a versioned target and safe cutover. Record who initiated repair, input validation point, projector version, results, and rejected items.

## Integration sequence

```text
authoritative transaction
  -> durable change identity or named snapshot
  -> normalize projection record with authority version
  -> idempotent projector
  -> inspect per-item sink receipts
  -> commit projection checkpoint
  -> expose lag/error metrics
  -> reconcile identities/content/invariants
  -> cut over or repair
```

For a pipeline with several sinks, keep independent state:

```json
{
  "changeId": "004182",
  "sinks": {
    "typesense": {"state":"complete","target":"comics_v7"},
    "qlever": {"state":"failed","target":"kg_20260717","error":"..."},
    "clickhouse": {"state":"pending"}
  }
}
```

Global success is false until every required sink is complete.

## Failure and recovery

| Failure | Required response |
|---|---|
| Projector crashes after sink write but before checkpoint | Replay same change safely; detect already-applied version |
| Checkpoint advances before sink acknowledgement | Reconcile gap and rewind/replay; fix ordering |
| Search bulk import partially rejects documents | Persist item-level rejects; keep build incomplete if required |
| Alias switches before validation | Roll back alias and invalidate incomplete target |
| Deleted authority record remains searchable | Apply tombstone/identity diff; test tenant/privacy filters |
| RDF append contains old and new values | Rebuild/replace graph or issue explicit deletes through supported update path |
| QLever/graph index build fails halfway | Never route to partial index; rebuild named target from manifest |
| Projection schema changes while backlog exists | Version event/normalizer and run explicit compatibility or rebuild path |
| Backfill races live updates | Use a snapshot plus catch-up phase; compare versions before application |
| Optional projection fails | Show degraded capability and retry state; do not silently claim fresh |

## Test matrix

Test:

- initial empty build, full build, no-op rebuild, and incremental catch-up;
- duplicate delivery and out-of-order source versions;
- inserts, updates, deletes, undeletes, and tenant moves;
- process loss after sink commit but before checkpoint;
- partial batch failures and retry of only rejected identities;
- schema-compatible and incompatible projection changes;
- backfill concurrent with live writes;
- cutover and rollback while queries are active;
- old and new target query equivalence on frozen fixtures;
- search ranking/facet/filter/sort behavior;
- RDF term identity, datatypes, correction, and representative SPARQL queries;
- analytical late arrival, correction, and retention behavior;
- privacy deletion across every projection;
- lag objective and alerting;
- targeted repair and full rebuild from the same authoritative snapshot.

## Executable verification

Use engine-native commands and real application requests. Examples to adapt:

```bash
curl -fsS "$TYPESENSE_URL/collections/comics/documents/search?q=fixture&query_by=title"
curl -fsS --get "$QLEVER_URL" --data-urlencode 'query=SELECT (COUNT(*) AS ?count) WHERE { ?s ?p ?o }'
```

Run a reconciliation program that exits non-zero for missing, extra, stale-version, tenant-leaking, or rejected required records. Verify the serving alias/pointer and then issue the application's real search/graph/analytics requests before retiring the previous target.

## Deliberate exclusions

- Do not mandate Typesense, QLever, Blazegraph, ClickHouse, or any named engine without repository/deployment evidence.
- Do not treat a registered placeholder sink as an implemented projection.
- Do not assume search bulk HTTP success means every document succeeded.
- Do not use the projection as authority unless the architecture explicitly assigns it authority and recovery.
- Do not dual-write required state without a durable gap-repair mechanism.
- Do not claim exactly-once projection; specify idempotent replay and observable convergence.
- Do not force Zod, LogTape, Effect, or a specific queue/outbox implementation when the consumer chose another owner.
- Do not delete the previous target before rollback evidence and retention policy allow it.

## Sources and freshness

Primary references: [Typesense document import](https://typesense.org/docs/latest/api/documents.html#import-documents), [QLever source and configuration](https://github.com/ad-freiburg/qlever) and [SPARQL 1.1](https://www.w3.org/TR/sparql11-overview/). These identify the relevant public systems; they do not prove a consumer has deployed them. Verify the active engine, item-result contract, update behavior, rebuild path and installed version before implementation claims.
