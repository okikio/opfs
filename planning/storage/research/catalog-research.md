# Routing the storage catalog into implementation work

This appendix routes all 895 supplied IDs once. It preserves source URLs, source constraints and catalog support status. It is a provisional planning assessment; source URLs were not all live-rechecked. The original coarse discovery phase is an owner/dependency grouping, not a commitment that a service is viable or already supported. The final `delivery_wave` matches PLAN.md; it is separate from the original `discovery_phase`.

## Counts and source boundaries

- 550 storage options: 453 selectable backend candidates and 97 protocol/API candidates.
- 130 storage behaviors, 56 optional container/dataset views, 70 tooling entries and 89 reference-only entries.
- 16 catalog entries have matching current driver/adapter source pairs. This is source evidence, not full deployment/runtime conformance.
- The source catalog explicitly labels 84 shared-S3 candidates and 43 host-route candidates. The provisional map groups 91 entries under S3 profiles and 93 under host profiles by including other source-declared gateway/mount/control-plane routes. These are not 91/93 newly validated backends.
- All 895 IDs are unique and present; there are no unclassified rows. Nine historical/deprecated items are explicitly deferred pending an active route or archival scope.

## Original discovery-phase groups

| Group | Catalog records | Owner contract |
| --- | ---: | --- |
| 3 | 294 | WebDAV, resource/record services, cloud drives, runtime bindings and configured mounts. |
| 5 | 116 | Specialized domain/native/chain/device/image/backup formats after explicit feasibility and dependency gates. |
| 2 | 102 | Provider profiles plus bounded ZIP/tar, compression and encryption work. |
| reference | 89 | Preserved context; no standalone driver implementation. |
| 0 | 82 | Inventory, contracts and existing-source regression; tooling is selectively reused, not bundled. |
| 4 | 96 | Verified content addressing, peer/decentralized and synchronization work. |
| 1 | 116 | Shared range/transfer/identity foundations and native GCS/tus vertical slices. |

## Consequences for the implementation plan

1. Reuse file, record and object families. A provider profile configures shared protocol code and adds provider-specific limits and evidence; it must not fork the complete S3 implementation. A native GCS client is still warranted because Google-specific generation preconditions and resumable upload semantics deserve direct ownership.
2. Separate protocol support from service conformance. Test one compatibility contract against each named provider/deployment before advertising it. Listing an S3 endpoint or mounting a filesystem is an access route, not proof of provider-specific guarantees.
3. Keep read-only source and view contracts explicit. HTTP resource access cannot invent directory listings or writes. ZIP, disk images, backup repositories and datasets interpret stored bytes and each need separate format profiles, bounds and recovery rules.
4. A protocol feature is not a backend. tus, GCS resumable uploads and S3 multipart need shared transfer orchestration plus protocol-specific sessions/offsets/receipts. The supplied catalog says tus is absent from the current public exports; the historical checkpoint must be reviewed and ported, not counted as already present.
5. GCS, Firebase Storage and Drive have distinct authorization and identity contracts. Filestore/Lustre/NetApp or attached disks can normally use configured host mounts. Photos and Pub/Sub remain specialized media/message access rather than arbitrary complete file stores.
6. Content addressing proves identity, not retention. IPFS retrieval, pinning, CAR/UnixFS traversal, peer replication, chain payment/finality and permanent-storage claims need separate capabilities and evidence.
7. No source record can create a new production dependency approval. Native protocols that require SSH, native bindings, peer stacks, complex crypto or mature parsers remain gated by the permitted standard/personal libraries or an explicit dependency decision.
8. Measure completeness by a truthful matrix of implemented operations, runtime, conditions, stream/resume, encryption, limits and conformance. Keep catalog candidates, existing source, tested deployments and unavailable services as separate states.

## Exact per-record map

See `routing.json` and its `entries` array, or `routing.csv`. Each row retains source role/status/constraints/URLs and adds `proposed_owner`, `discovery_phase`, `delivery_wave`, `planning_status`, `reason`, classification `rule` and `uncertainty`. Some rows add a `delivery_note` for an explicit scheduling exception. The discovery table above is historical triage, not the final implementation sequence; use PLAN.md and `delivery_wave` for that sequence. Fields describe a proposal; no new OPFS export is claimed. The supplied checkpoint remains the source catalog. These artifacts contain the evaluated final routing, not a packaged catalog-rebuild tool.
