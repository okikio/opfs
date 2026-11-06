# Storage expansion research

This directory preserves the planning inputs for maintainers implementing the remaining storage protocols and formats.
Start with [current implementation status](../../docs/expansion.md), then use the [research plan](research/PLAN.md),
[extension contracts](research/EXTENSIONS.md) and [preview routing](research/PREVIEW.md) to find a proposed capability.
The [group index](GROUPS.md) shows all 45 proposed owners and their remaining boundaries without changing historical
catalog records or treating one implementation as completion of a whole family.

The catalog, routing records and focused inventories are retained byte-for-byte from the local
`storage-expansion-20261105` handoff. They describe proposals at that checkpoint, not current support. The catalog has
895 records; the focused archive/encryption inventory has 136 records, with overlap mapped explicitly. Neither count is
a count of shipped adapters or supported formats.

Run `node planning/storage/research/validate.ts` from the repository root to check IDs, routes, crosswalks, local links
and the original parent catalog SHA256. This validates planning integrity only. Protocol tests, interoperability
fixtures, public exports and the current implementation status remain separate evidence. The catalog hash is
`7fc1fefdfea648cfab176f38b6351b8b5c4d547b5a259ef103861aef8b6851b5`.

Keep new implementation status in `docs/expansion.md` and the capability guides. Do not rewrite historical routing
records to make proposals look implemented. These research inputs are excluded from runtime package publication; no
production module imports them.

## Current implementation sequence

The language and documentation correction precedes the next protocol release. Maintained task runners and fixture
recipes now use TypeScript, including scripts previously embedded inside provider fixtures. Native qualification of the
replacement recipes is still in progress. Old executed producers stay as inert snapshots where their byte identities
explain existing evidence. Porting a harness does not retroactively prove its new execution or change the authority of a
frozen native fixture. The [storage model](../../docs/model.md), [preview flow](../../docs/archive.md), and
[recovery flow](../../docs/transfer.md) explain the contracts each later implementation must preserve.

Then continue the [group index](GROUPS.md), recording each implemented profile and its exclusions rather than marking
whole groups complete. Kafka currently has local independent native evidence in the working investigation, but no public
client. The [reviewed Kafka sequence](KAFKA.md) fixes the proposed public contract, limits and remaining Metadata4
semantic qualification gap; production implementation waits for migration gates. Netlify Blobs is still
dependency-admission work; native range identity and filesystem projection are unproved. Arrow IPC is still design and
reference inspection. None of those three is shipped by the Glacier change.

Each next profile needs source review, independent full-byte fixtures, bounded failure and recovery tests, runtime and
type gates, packed public-import checks, applicable benchmarks, a readable capability guide and release note, then the
same branch's CI. Runtime libraries stay within the approved dependency policy. Native test programs remain test-only
and require their own exact identity and license evidence.
