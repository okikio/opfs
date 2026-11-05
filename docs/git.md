# Read verified Git loose objects

Supply a source for one compressed loose object, the full expected object ID, its repository hash algorithm, and a
trusted native hash capability. The library never discovers a local repository or network credentials.

```ts
import { openGitObject } from "@okikio/opfs/content/git";
import type { ByteSourceType } from "@okikio/opfs/source";

async function previewBlob(
  source: ByteSourceType,
  oid: string,
  subtle: Pick<SubtleCrypto, "digest">,
): Promise<Uint8Array> {
  const object = await openGitObject(source, {
    algorithm: "sha256",
    oid,
    subtle,
    maxCompressedBytes: 16 * 1024 * 1024,
    maxObjectBytes: 8 * 1024 * 1024,
  });
  if (object.kind !== "blob") throw new TypeError("Expected a Git blob.");
  return object.source.read(0, Math.min(object.size, 4096));
}
```

The caller owns and closes the borrowed input source. `openGitObject` captures its size and read method, consumes its
complete compressed extent, checks zlib framing and Adler-32 through the native compression owner, and hashes the exact
decoded `type SP size NUL payload` bytes. It exposes no payload until these checks finish. A matching hash identifies
those bytes; it does not authenticate a publisher. The injected `subtle` capability is trusted to implement the
requested digest without changing borrowed input. No global hash capability is acquired by this module.

`object.read()` returns a fresh payload copy. `object.source` is an immutable private snapshot: range reads copy the
selected payload, not compressed source bytes. The identity includes the algorithm, full object ID, kind, and payload
scope. `object.source.size` is payload length, while `maxObjectBytes` includes the decoded header. The same compressed
source is not consulted again after verification.

## Inspect a tree without extracting it

For a verified tree, `object.entries()` returns canonical modes, referenced object IDs, and exact `nameBytes`. Each call
copies the name buffers. A strict UTF-8 `name` is optional; malformed UTF-8 never becomes replacement characters.
Control characters and backslashes remain valid inert name bytes. Even a valid `name` is not a safe host path or
terminal label. The module does not render, normalize, extract, follow symlinks, or traverse gitlinks.

Modes are `40000` (tree), `100644` (blob), `100755` (executable), `120000` (symlink), and `160000` (gitlink). Parsing
rejects duplicate names, empty names, slash/NUL, dot/dot-dot, noncanonical modes, truncated references, and noncanonical
Git byte ordering. This is a strict writer profile; historically tolerated mode spellings are not silently rewritten.
Tree IDs refer to other objects without proving that those objects exist. Commit and tag payloads remain opaque verified
bytes; no signatures, ancestry, refs, or referenced objects are checked.

`encodeGitTree(entries, { algorithm })` independently encodes a bounded tree payload, sorting exact copied names using
Git's directory `/` sentinel order. It does not hash, compress, verify input provenance, or publish an object. Native
Git `mktree`/`cat-file` full-byte fixtures check both hash-width profiles, including full-width gitlinks. SHA-1
repositories use 20-byte references and SHA-256 repositories use 32-byte references; widths are never guessed from
payloads.

## Resource and failure policy

The materialized profile defaults to 16 MiB compressed input, 8 MiB decoded header plus payload, 100,000 tree entries,
and 4,096 bytes per name. Compressed and decoded policy ceilings are 64 MiB; entry and name ceilings are 1,000,000 and 1
MiB. Bounds are checked before whole-object allocations. A 64-byte header scratch area and bounded native codec chunks
exist independently of the final payload. The implementation needs the complete decoded object plus codec, digest, tree
metadata, and returned-copy storage; it does not promise constant memory or random access through compressed bytes.
Native WebCrypto may make internal copies.

Physical input reads are at most 64 KiB and use a `SourceBudgetType`. The default budget allows the configured
compressed bytes and 1,024 requests. Failed reserved work is not refunded. Supply a shared `budget` to account for
several objects. The optional archive `ledger` separately accounts for codec input and output work; these two accounting
scopes must not be confused. A source that fails, returns short data, or exceeds limits causes the operation to fail
before exposing an object.

An optional abort signal is checked before IO, passed through source/codec work, and checked around hashing. Native
digest work cannot be interrupted while `subtle.digest` is pending. The caller's source must honor its own IO
cancellation contract. Readers and native codec streams are retired on failure while preserving the primary error. No
retry is implicit.

Native decompression must reach terminal EOF, and the compression owner separately checks the zlib header and final
Adler-32. This is not an independent full DEFLATE parser: structural and trailing-member acceptance follows the selected
runtime's native codec. Do not use it as proof of canonical compressed serialization. SHA-1 is format compatibility and
corruption detection here. Native SHA-1 does not implement Git's SHA1DC collision detection and is not a substitute for
modern collision-resistant authentication.

This module does not support packfiles, deltas, refs, indexes, network transports, worktrees, checkout, complete DAG
validation, or filesystem projection.

## Evidence

[The native Git fixture record](../tests/fixtures/git/README.md) records the CLI producer, exact raw payload oracles,
immutable source revision, and file hashes. Tests compare native SHA-1 and SHA-256 objects and tree encodings byte for
byte, then exercise corrupt checksums, wrong IDs, malformed extents, budgets, aborts, and mutable caller buffers. This
proves the documented loose-object profile; it does not certify Git interoperability beyond those profiles or
authenticate fixture authors.
