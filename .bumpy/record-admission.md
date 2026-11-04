---
"@okikio/opfs": patch
---

Record-backed filesystems now refuse malformed SQL integer metadata and stored records whose reported path differs from
its physical Cache or Web Storage key. This protects directory consumers from seeing a child that cannot subsequently be
opened at the path listing returned.

For example, a Cache entry for `/a` containing a valid record that says `/b` previously appeared as `/b` in its parent
listing. Exact reads still used physical keys, so `/a` failed validation and `/b` was absent. The driver now rejects
that listing with `TypeError`; the facade retains it as the cause of `FileSystemError`. The read does not move,
overwrite or repair the corrupt entry. Unrelated keys outside the reserved namespace remain outside this projection.

```ts
import { createFileSystem } from "@okikio/opfs";
import { createLocalStorageAdapter } from "@okikio/opfs/adapter/localstorage";

const fs = createFileSystem(createLocalStorageAdapter(localStorage, { prefix: "reports" }));
try {
  await fs.writeFile("/daily.txt", "accepted result");
  for await (const child of fs.readDir("/")) console.log(child.name);
} finally {
  await fs.close(); // the injected storage area remains caller-owned
}
```

Keep the configured namespace exclusive to this record format. When older or externally edited persistence is corrupt,
inspect and explicitly repair or migrate the original records; a listing failure is not permission to recursively clear
unrelated application data.

SQL connectors can return BIGINT metadata as decimal strings. The db0/SQLite record layer previously parsed a numeric
prefix: `"3junk"` or `"3.5"` became `3`, and a matching three-byte payload could be accepted. It now requires a complete
nonnegative decimal integer string and a JavaScript safe-integer result. Leading decimal zeros remain accepted; signs,
whitespace, fractions, exponents, nondecimal notation, trailing text and overflow reject. Genuine number and bigint
metadata retain the same safe-integer boundary. Canonical base64 and its exact decoded size remain independently
validated.

The maintained controls exercise the public driver and facade with independently authored bytes and paths. Native Node
SQLite tests retain string metadata in caller-owned TEXT columns so SQLite affinity cannot erase the malformed lexeme
before admission. Browser controls mutate real Cache Storage and localStorage JSON at an unchanged key, prove get/list
refusal and absence of the ghost path, then exercise explicit repair. These controls do not certify PostgreSQL/MySQL
connector compatibility, browser crash durability, or every storage engine behind an ecosystem wrapper. No performance
improvement is claimed; key comparison adds constant work per listed record and complete integer admission scans the
connector's supplied decimal text.

Writes bind admitted size/timestamp integers as canonical decimal text. This matters for caller-owned TEXT columns:
native SQLite can otherwise store a JavaScript number `0` as the text `"0.0"`, which the complete integer reader
correctly refuses. INTEGER/BIGINT columns apply their ordinary SQL affinity to the same exact decimal parameter. Write
admission keeps the safe-integer boundary; connector transport cannot silently introduce a fractional spelling into the
persisted format.

The exported db0 backend also admits one complete record image before its asynchronous path hash. Changing the
caller-owned record while hashing is pending cannot mix an original path identifier with later payload or metadata. This
copy does not transfer ownership of the input record or database.
