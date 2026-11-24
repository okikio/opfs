---
npm/@okikio/opfs: minor
---

### Read a file's revision, write only if it has not changed, and reach the client behind a filesystem

`fs.stat()` now returns the backend's revision for a file: an ETag on S3, Azure Blob and R2, a generation on Google
Cloud Storage, and a version ID on native Backblaze B2. Pass it back to `writeFile()` to replace only that exact
version. If another writer changed or removed the file since your stat, the write throws `locked` and writes nothing:

```ts
const stat = await fs.stat("/settings.json");
if (stat.kind === "file" && stat.revision) {
  await fs.writeFile("/settings.json", JSON.stringify(next), { ifRevision: stat.revision });
}
```

The check is atomic. The adapter compares the revision, then uploads with the provider's own precondition, so a writer
that lands between those two steps makes the upload fail too. It works where `fs.inspect().adapter.native.revisions` is
true: S3, Azure Blob, Google Cloud Storage and R2. Native B2, Swift and Cloudflare KV report revisions but cannot
condition a write, so `ifRevision` throws `not-supported` there instead of writing without the check. Adapters without
revisions, such as memory, IndexedDB and local disks, also throw `not-supported`.

A filesystem also exposes the client, database or store its driver borrows as `fs.backend`, typed by the adapter that
made it. Provider operations with no file meaning no longer need a second variable:

```ts
const fs = createFileSystem(createB2Adapter(client));
const stat = await fs.stat("/reports/q3.csv");
if (stat.kind === "file" && stat.revision?.kind === "version") {
  // B2 only: delete this one version permanently. fs.remove() hides the name and keeps old versions.
  await fs.backend.deleteVersion(await fs.backend.getFileInfo(stat.revision.value));
}
```

Object drivers (S3, Azure, GCS, R2, B2, Swift) set `backend` to their client. Other drivers leave it `undefined` for
now. The caller still owns the object: closing the filesystem does not close it.

Type changes for code that builds its own drivers or adapters:

| Before                                                            | After                                                                                |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `ObjectRevisionType` from `@okikio/opfs/driver/object`            | `RevisionType`, also exported from `@okikio/opfs` and `@okikio/opfs/driver/file`     |
| `DriverType`, `AdapterType`, `ObjectDriverType`, `FileSystemType` | The same names, with an optional `Backend` type parameter that defaults to `unknown` |
| `FileDriverStatType` (file)                                       | Adds optional `revision`                                                             |
| `FileDriverWriteOptionsType`                                      | Adds optional `ifRevision`                                                           |
| Adapter capabilities                                              | Add optional `revisions`                                                             |

Existing code compiles unchanged, except code that implements `FileSystemType` itself, which must add `backend`.
