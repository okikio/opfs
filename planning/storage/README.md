# Storage expansion research

This directory preserves the planning inputs for maintainers implementing the remaining storage protocols and formats.
Start with [current implementation status](../../docs/expansion.md), then use the [research plan](research/PLAN.md),
[extension contracts](research/EXTENSIONS.md) and [preview routing](research/PREVIEW.md) to find a proposed capability.

The research files are retained byte-for-byte from the local `storage-expansion-20261105` handoff. They describe proposals
at that checkpoint, not current support. The catalog has 895 records; the focused archive/encryption inventory has 136
records, with overlap mapped explicitly. Neither count is a count of shipped adapters or supported formats.

Run `python3 planning/storage/research/validate.py` from the repository root to check IDs, routes, crosswalks, local links
and the original parent catalog SHA256. This validates planning integrity only. Protocol tests, interoperability fixtures,
public exports and the current implementation status remain separate evidence. The catalog hash is
`7fc1fefdfea648cfab176f38b6351b8b5c4d547b5a259ef103861aef8b6851b5`.

Keep new implementation status in `docs/expansion.md` and the capability guides. Do not rewrite historical routing records
to make proposals look implemented. These research inputs are excluded from runtime package publication; no production
module imports them.
