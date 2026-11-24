---
npm/@okikio/opfs: minor
---

### Shorter names, chosen from how each function is called

These public names changed at 0.x, with no aliases. Each new name says what the call does; the import path already
supplies the rest.

| Entry point                                                           | Before                                    | After                           |
| --------------------------------------------------------------------- | ----------------------------------------- | ------------------------------- |
| `driver/s3`, `azure`, `gcs`, `r2`, `b2`, `swift`, `webdav`, `webhdfs` | `create<Backend>DriverFromClient(client)` | `create<Backend>Driver(client)` |
| `source`                                                              | `budgetSource(source, budget)`            | `limitSource(source, budget)`   |
| `dataset/zarr`                                                        | `createZarrObjectLedger()`                | `createZarrLedger()`            |
| `driver/db0`                                                          | `getCreateTableSql(table)`                | `getTableSql(table)`            |
| `_sigv4`                                                              | `signingKey(...)`                         | `deriveSigningKey(...)`         |

#### Drivers now always take the client you made

Each of the eight drivers had two constructors: one that built a client from options and owned it, and `…FromClient`,
which borrowed a client. The options form is gone, along with its `<Backend>DriverOptionsType`. The adapters already
took a client, so the driver now matches:

```ts
// Before
const driver = createS3Driver({ endpoint, bucket, region, credentials });

// After
const client = createS3Client({ endpoint, bucket, region, credentials });
const driver = createS3Driver(client);
```

The driver borrows the client. Closing the driver, or a filesystem built on it, leaves the client open, so you can keep
using it for calls the filesystem does not model. For R2, pass the binding to `createR2Client(env.BUCKET,
options)`
first. WebDAV and WebHDFS still take their read limits as a second argument:
`createWebdavDriver(client, { maxReadBytes })` and `createWebhdfsDriver(client, { maxBufferedReadBytes })`.

#### Internal names

`fromForeignError`, `getRuntimeCode`, `BaseHandle.sharesFileSystem` and two private stream helpers were renamed the same
way. They are not part of the public API.
