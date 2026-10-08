---
"@okikio/opfs": minor
---

File copy now publishes from an exclusively owned sibling on native hosts, preserving an existing destination if copying
fails. Move validates the source before any overwrite removal. Existing tree/kind replacement defaults to rejection;
choose `preserve: false` explicitly for best-effort recursion. `exclusive: true` requests admitted atomic no-replace;
host copy supports it, while portable host rename rejects before mutation. Inspection and pure plans expose the scoped
publication facts. Host acknowledgement does not promise crash-durable publication.

```ts
await fs.copy("/draft.bin", "/published.bin", { overwrite: true });
console.log(fs.inspect().adapter.publication);
console.log(fs.plan({ operation: "move", path: "/draft.bin", destination: "/new.bin", exclusive: true }));
```

Positional resources serialize complete native operations, cap pending buffers/operations, and reserve a winning
close/abort slot. The default is 64 MiB/64 per resource; awaiting each write requires no new controls. Preserve caller
buffers until settlement. Synchronous reads clamp EOF cursors, and handle seek/truncate obey their WritableStream
terminal state. Host removal unlinks links without traversing their target, rejects stable alias ancestors and includes
foreign entries in structural enumeration. Web Storage deletion snapshots keys before yielding.

Deno KV v3 replaces generation-age deletion with durable writer state, immutable-part CAS/accounting, atomic publication
and retirement, renewable read pins and versioned collector claims. Applied-but-unacknowledged pin operations reconcile
the same token and decrement only present records. Reader suspension beyond its lease rejects; age never alone permits
collection. `adapter.driver.collect()` returns bounded progress/cursor, `maintenance` is pure and `probe()` reads live
retention. Optional aggregate partition admission prevents unlimited retained bodies when maintenance stalls.

```ts
const adapter = createDenoKvAdapter(db, { prefix: "new-reports" });
const fs = createFileSystem(adapter);
await fs.writeFile("/result.bin", bytes);
console.log(await adapter.driver.probe());
const pass = await adapter.driver.collect();
if (pass.cursor !== undefined) await adapter.driver.collect({ cursor: pass.cursor });
```

Stop legacy writers and export/import their visible files to a fresh v3 prefix before switching consumers. There is no
automatic destructive layout migration. Read-only logical access still needs private pin writes. Repeated maintenance
and application quota remain necessary unless aggregate limits are configured.

Reverse KV bridges now default to marked `/.opfs-kv` ownership, reject `/`, preserve exact JS-string keys (including
empty segments and lone UTF-16 units), and clear only owned value leaves. Unstorage performs its own documented
normalization first. Legacy namespaces require explicit export/import. Object adapters reject simultaneous file/prefix
identities; pure plans translate physical prefixes and actual native/fallback sources before admission.

[Storage ownership and publication](../docs/storage.md) teaches the full contracts, migration, resource costs and
residual runtime/provider boundaries. Focused fault tests and real local runtime tests establish the listed cases; no
numeric performance improvement or universal cloud guarantee is claimed.
