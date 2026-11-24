---
npm/@okikio/opfs: patch
---

### One copy of each check, so a fix lands once

Many provider clients and format readers carried their own copy of the same small helpers. A bug fixed in one copy
stayed in the others. They now share one implementation each:

| Helper                                               | Entry point       | Replaced copies                                |
| ---------------------------------------------------- | ----------------- | ---------------------------------------------- |
| `parseJson(text, limits)`                            | `_json`           | 13 bounded JSON lexers in provider clients     |
| `exactLength(body, length, options)`                 | `_body`           | 12 exact-length response wrappers              |
| `assertInteger`, `toInteger`, `resolveLimit`         | `_check`          | about 60 integer and limit checks              |
| `assertAtMost`, `toSafeInteger`, `createChildLedger` | `archive/_budget` | 30 archive and dataset limit and 64-bit checks |
| `raceAbort(promise, signal)`                         | `_abort`          | 7 socket clients                               |
| `encodeText(value)`                                  | `_bytes`          | 2 protocol clients                             |

What you can observe:

- **Error messages are more uniform.** A bad integer now reads, for example,
  `Box part size must be an integer from
  0 to 10000.` instead of `Invalid Box part size.`. The error class is
  unchanged (`RangeError`), except in the private Arrow framing and FlatBuffers modules, which threw `TypeError` for
  out-of-range caller numbers and now throw `RangeError` like the rest of the package.
- **A 64-bit field past 2^53 - 1** in an Arrow, ORC or Parquet file is now `unsupported-profile` rather than
  `invalid-archive`: the file can be valid, the reader just cannot address it exactly. A negative value stays
  `invalid-archive`.
- **Dataset limit options** (HDF5, Shapefile, GeoTIFF, MCAP, Zarr) above their hard ceiling now throw `RangeError`, like
  the provider clients, rather than `budget-exceeded`: the option is wrong before any work starts.
- **JSON responses** from Firebase, Git LFS, PocketBase, Supabase and Yandex Disk are now parsed into objects without a
  prototype, as the other eight clients already were, and object keys count toward the token limit.
- **Exact-length bodies** now count consecutive empty chunks for the no-progress check in every client, and never cancel
  a source a second time after its read already failed.
