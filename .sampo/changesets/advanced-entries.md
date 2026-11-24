---
npm/@okikio/opfs: minor
---

### Import the mechanisms under every layer from advanced entry points

Code that needs a mechanism the main entry points do not cover can now import it. Before this release, about 180 exports
in 49 modules were reachable only from inside the package: ETag precondition rules, the Deno KV generation protocol, the
ZIP reader's stages, Kafka wire fields, archive work budgets and more. They are now published at advanced entry points,
spelled with `_` before the last path segment, under the path of the layer that owns them:

```ts
import { createArchiveAdapter } from "@okikio/opfs/view/_tree";
import { createFileSystem } from "@okikio/opfs";

// Build a read-only filesystem for an archive format the package does not read yet.
// The view refuses links, duplicates, ".." traversal and file/directory collisions before any read.
const entries = [{ id: 0, name: "notes/hello.txt", size: 5, kind: "file" }];
const adapter = createArchiveAdapter("example", entries, async (entry, { offset, length }) => {
  return new TextEncoder().encode("hello").slice(offset, offset + length);
});
const fs = createFileSystem(adapter);
console.log(await fs.readText("/notes/hello.txt")); // "hello"
```

Each advanced module's documentation says what it is for, how it is called and which main entry point covers the usual
case. Most callers never need them. They track the internal design more closely than main entry points, so expect them
to change more often; a breaking change is still listed in the changeset with its migration.

| Owner   | New advanced entry points                                                                                            |
| ------- | -------------------------------------------------------------------------------------------------------------------- |
| Root    | `_abort`, `_body`, `_bytes`, `_chunk`, `_close`, `_error`, `_handle`, `_hash`, `_iteration`                          |
| Root    | `_lock`, `_pool`, `_publication`, `_range`, `_response`, `_sigv4`, `_stream`, `_sync`, `_writable`                   |
| Root    | `_xml`                                                                                                               |
| Archive | `archive/_error`, `archive/_budget`, `archive/_field`, `archive/_deflate`, `_lzx`, `_mszip`, `_xpress`               |
| ZIP     | `archive/zip/types`, `archive/zip/_aes`, `_bzip`, `_cipher`, `_directory`, `_lzma`, `_member`, `_plan`, `_zipcrypto` |
| Drivers | `driver/_local`, `driver/_writable`, `driver/deno-kv/_generation`, `driver/indexeddb/_observe`                       |
| Kafka   | `kafka/_records`, `kafka/_session`, `kafka/_wire`                                                                    |
| Formats | `content/_murmur`, `dataset/arrow/_columns`, `_flatbuffers`, `_framing`, `_schema`                                   |
| Formats | `dataset/bam/_bgzf`, `dataset/bam/_record`, `transfer/_fields`, `view/_tree`                                         |

`archive/zip/types` follows the `/types` rule: it exports the ZIP reader's data shapes. `docs/design.md`, section "Entry
points: main, types and advanced", explains the three kinds of entry point.

The Deno KV driver's `collect()` result now documents every counter. `truncated` is also true when `maxScans` or
`maxPinScans` stops the pass, not only `maxDeletes`; the behavior is unchanged, and the earlier description was
incomplete.
