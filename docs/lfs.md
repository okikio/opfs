# Git LFS objects and pointers

Read a Git Large File Storage object using an explicit repository endpoint and trusted expected identity:

```ts
import { LfsClient } from "@okikio/opfs/content/lfs";
import type { ByteSourceType } from "@okikio/opfs/source";

export async function openLargeObject(
  endpoint: string,
  actionOrigin: string,
  authorization: string,
  oid: string,
  size: number,
  subtle: Pick<SubtleCrypto, "digest">,
): Promise<ByteSourceType> {
  const client = new LfsClient({
    endpoint,
    credentials: () => ({ Authorization: authorization }),
    downloadOrigins: [actionOrigin],
    subtle,
    maxBytes: 8 * 1024 * 1024,
  });
  return await client.openVerified({ oid, size });
}
```

Supply an endpoint such as `https://git.example/owner/repo.git/info/lfs/`, a separately approved action origin such as
`https://objects.example`, the application's repository authorization header, the expected lowercase 64-digit SHA-256
object ID and safe-integer byte size. The endpoint requires a final `/`; the client appends `objects/batch`. The caller
supplies a trusted Web Crypto capability, for example `globalThis.crypto.subtle` at application composition time.
Importing this module acquires no cryptography, credentials, configuration or connections.

This API implements the Git LFS Batch API and its `basic` transfer protocol. It does not discover Git remotes or run
Git, SSH, credential programs, clean/smudge extensions or an SDK in production. Fetching a pointer is separate from
fetching the large object's bytes. A fully verified object source can feed archive readers and preview tools, but it
does not create a Git worktree, OPFS filesystem or mutable repository namespace.

## Pointer bytes

`decodeLfsPointer(bytes)` accepts this canonical v1 profile:

```text
version https://git-lfs.github.com/spec/v1
oid sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03
size 6
```

The last line ends with LF. The pointer is strictly smaller than 1,024 bytes and uses fatal UTF-8 decoding. Version is a
literal string comparison. Historical aliases, CRLF, missing final LF, duplicate/out-of-order keys, noncanonical sizes,
unsafe integers and NUL are refused. Keys use `[a-z0-9.-]`, `version` is first and remaining keys sort lexically. The
six-byte payload named above is `hello` followed by LF. Its SHA-256 is the identity of those complete payload bytes, not
the Git blob object hash of the pointer itself.

The returned value is either `{ kind: "empty" }` or `{ kind: "pointer", oid, size, fields }`. Empty files pass through
Git LFS unchanged and therefore have zero pointer bytes; a three-line pointer with `size 0` is not admitted as
canonical. The Batch API can still explicitly request a zero-size object with its SHA-256 identity. These are distinct
representations.

`encodeLfsPointer()` preserves unknown supplemental records in `fields` and validates the resulting canonical layout.
Its local input limit is 32 supplemental records, 1,024 characters per key/value and the final format's 1,023-byte
ceiling. Unknown fields are inert data, not installed transformations. `lfsPointerObject()` turns a field-free nonempty
pointer into an object request; it refuses empty pass-through files and every pointer with supplemental fields. The
application must interpret any extension explicitly. Byte-layout preservation does not claim that every unknown field is
accepted by every Git LFS version or that the library implements transformed-content retrieval.

## Repository authority and transfer actions

`batch("download" | "upload", objects, { ref, signal })` sends a copied array of object identities with
`transfers: ["basic"]` and `hash_algo: "sha256"`. `ref`, when supplied, is explicit server authorization context such as
`refs/heads/main`; it does not publish or resolve that ref. A batch admits 1–100 objects by default, configurable
through `maxBatch` to at most 1,000. Duplicate requests are refused. Control bodies are bounded to 8 MiB, with JSON
preflight limits of 32 nesting levels, 100,000 values, 196,608 lexical characters per string and 128 characters per
numeric token. Duplicate JSON keys, prototype-sensitive keys and numbers outside precise integer range fail before
authority is used.

Each response must identify exactly the requested objects and sizes, with no duplicate, omitted or foreign entries. HTTP
200 can contain a per-object error; the result then has `state: "error"` and its native status `code`. Ready results can
carry `download`, `upload` and `verify` action records. Download requests require a download action. An upload response
with no `actions` property means only that the server reports that it already has the object. Unexpected transfer/hash
algorithms and contradictory actions fail. The native optional `authenticated` field is retained as evidence; it never
triggers credential discovery.

Actions contain secret URLs and optional secret headers. Grant their exact origins separately with `downloadOrigins`,
`uploadOrigins` and `verifyOrigins`. Even an action pointing back to the repository's own origin needs the corresponding
explicit grant. No wildcard, suffix or automatic same-origin grant exists. Requests omit cookies/referrer context and
refuse redirects. HTTPS is required unless `allowHttp: true` explicitly enables a local fixture. URL userinfo and
fragments are refused.

Repository `credentials(url, signal)` are used only on the Batch endpoint. They are never copied onto actions. A native
action's own headers remain authoritative. If deployment policy requires additional action credentials, provide the
separate `actionCredentials(url, kind, signal)` callback; it receives only an already granted target. Conflicting header
values fail rather than overriding signed context. This callback is explicit permission to acquire credentials for that
particular action kind and target, not automatic repository credential reuse.

Headers admit at most 64 names, 256 characters per input name, 8,192 characters per value and 65,536 total name/value
characters. Case-insensitive duplicates and transport/cookie/hop headers, including `Host`, `Cookie`, `Content-Length`,
`Range` and `Accept-Encoding`, are refused. Media requests set identity encoding themselves. Uploads supply an
`application/octet-stream` Content-Type only when the native action did not supply one. Verify actions preserve a native
weighted `Accept` list when it accepts `application/vnd.git-lfs+json`; defaults are added only when absent. Conflicting
JSON Content-Type/Accept values fail after retaining the acknowledged upload receipt.

`expires_in` takes precedence over `expires_at`, as required by the protocol. Relative seconds admit the protocol's
signed 32-bit range. Absolute timestamps use uppercase RFC3339 second precision with explicit calendar/offset checks;
leap-second spelling is outside this initial profile. A relative expiry is captured from local response-header receipt
time. Expiry is checked before and after action credential acquisition, using optional injected `now()` epoch
milliseconds. This is advisory server-relative evidence, not authentication, clock synchronization or an availability
guarantee. An expired action fails; the client does not silently reacquire authority or retry a mutation.

## Streaming and verified previews

`download(object, { ref, signal })` returns `{ oid, size, bytes, evidence: "server-trusted" }`. It requests the complete
object with HTTP 200, refuses real content encodings and requires any declared Content-Length to match. The readable
stream checks actual byte count and real EOF; short/extra bodies fail. The caller owns the stream and must consume it to
EOF or await cancellation. Streamed bytes become visible before a whole-object hash is known. No remote range API or
immutable source is claimed for that unverified response, even though the request contains an object ID.

`readVerified(object, signal)` preflights the expected size, downloads the entire bounded object and computes SHA-256
using the explicitly injected capability. Both exact byte size and complete digest must match before bytes are returned.
`openVerified()` retains privately verified bytes and returns a frozen immutable `ByteSourceType`; each exact-range read
returns a separate copy. Changing a returned read cannot change the stored source. Its identity names SHA-256 plus size,
not a mutable repository ref or a particular authorization principal.

`maxBytes` defaults to 8 MiB and can be set through the 64 MiB `LFS_BUFFER_BYTES` implementation ceiling. This applies
to verified whole reads and copied uploads, not the unverified streaming object's total size. Collection retains source
chunks plus the assembled array; private normalization and native Web Crypto may allocate further copies. This initial
profile deliberately performs bounded whole-object hashing because Web Crypto does not provide incremental SHA-256. It
does not claim constant-memory verification of arbitrarily large files. A trusted expected digest proves complete
content equality, not publisher authenticity, access policy or future server retention.

## Upload and recovery receipts

`upload(object, bytes, { ref, signal })` copies the supplied bounded bytes and hashes them before acquiring Batch or
action credentials. Wrong size/hash fails without provider I/O. Caller targets, ref context and bytes are captured
before awaits. A copy of concurrently modified shared memory is not an atomic snapshot; the caller must synchronize it.

The result distinguishes native evidence:

| State             | Meaning                                                                                                                                                                             |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `already-present` | The Batch response omitted upload actions for that identity. This is the server's report, not a new upload or independent content check.                                            |
| `uploaded`        | A basic PUT delivered HTTP 200. Local source bytes were verified before upload; the acknowledgment does not independently prove stored content or publish a Git ref.                |
| `verified`        | After the acknowledged PUT, an optional native verify action delivered HTTP 200, meaning the server reports that the object exists. This is not an independent download/hash proof. |

No automatic upload retry, deletion, rollback, ref update, lock operation, TUS transfer, custom adapter or retention
claim is made. A dispatched mutation without a delivered acknowledgment throws `LfsPublicationError` with
`outcome: "unknown"`. Reconcile storage explicitly before retrying. If PUT was acknowledged but optional verification
fails, `LfsVerificationError.upload` retains the `uploaded` receipt and `cause` preserves the verification failure. The
library never downgrades that acknowledged upload into a claim that nothing happened.

`LfsError.status` exposes sanitized HTTP/per-object status. Native server diagnostic bodies are not echoed. Own URL and
JSON errors omit secret inputs. Arbitrary injected Fetch/credential failures retain their original error/cause and can
themselves contain action secrets; the application must redact foreign diagnostics before logging. Keep action URLs,
headers and any persisted batch results in secret storage.

## Primary sources and proof

Protocol research pins official Git LFS commit
[`debca01ac1ca27a20cc30ac6870151b48c014881`](https://github.com/git-lfs/git-lfs/tree/debca01ac1ca27a20cc30ac6870151b48c014881/docs),
retrieved on 2026-11-05. SHA-256 hashes of unmodified source bytes:

| Source                        | SHA-256                                                            |
| ----------------------------- | ------------------------------------------------------------------ |
| `docs/spec.md`                | `14ea5fc720fbfe037d4a20991bdf272c3688d84b4cd49ae981805ec5c5e23fcd` |
| `docs/api/batch.md`           | `eafbead6a8752ea778f9d25451f7676c00885e3f643e773ce8b910bc97f2d96a` |
| `docs/api/basic-transfers.md` | `72c293217d844f25d1be1d7ff3daa0e61c4ee042ebabff1bd84541527fdd26c9` |
| `docs/api/authentication.md`  | `8b257338b66ae62f18a27f00d7020fef0495e81576fd729450feb99c6af7f0f0` |
| `docs/extensions.md`          | `0a74961cd2ea9aad6ecac9f9e36813e3a597d0e16276bee2d466a0928a19b5c1` |
| `lfs/pointer.go`              | `d0f9eeb624f4b4f65a8ee56e3040caa2b73087e9a8860e703feb5101d9363ae5` |

Checked-in pointer/empty fixtures were produced and checked by official Git LFS3.8.1; their byte hashes and commands are
in `tests/fixtures/lfs/manifest.json`. Fixture-local Git attributes disable newline conversion. The separate provider
test uses Testcontainers to run the maintained Gitea1.25.5 rootless image pinned to index
`sha256:be0b89adf2fc8657df508303d919c3be33e6413605882919f702177d62960c9a`. The independent official Git LFS3.8.1 CLI is
installed only inside that fixture from verified release archives: Linux arm64 SHA-256
`67895dd77b63329796bc5efdd47b57f218e1f7b98717ebaf936a8238dbcaec0f`, Linux amd64 SHA-256
`e72cf723a4a660438862282e8aecf3885fc8123e88bfcad534cf6b941a354b75`. Its source release resolves to
[`a662a6dbfedf706cfa9fc7a5b7bcc7ba2e2c8a65`](https://github.com/git-lfs/git-lfs/tree/a662a6dbfedf706cfa9fc7a5b7bcc7ba2e2c8a65).

Gitea's inspected native handler source is
[`services/lfs/server.go`](https://github.com/go-gitea/gitea/blob/f913d90ab664c1deccdfbe8c563abb13e897d62b/services/lfs/server.go),
SHA-256 `907cb79933ce74587bddbb08dcb98c57bb1bc227342efe43fef6c0c6601c631f`. Its optional verification action supplied
the weighted Accept list exercised by the provider test.

The provider fixture checks native clean/pre-push production against the candidate's complete verified download, then
candidate upload/verify against independent native smudge full-byte output and an already-present response. All Git
configuration, credentials and repositories live in the disposable container. Test-only Fetch address translation maps
the server's logical loopback origin to its ephemeral mapped port while preserving path/query. This does not relax the
production client's grants. Execution requires Docker, release/image download access and the repository's existing
testcontainers tooling; no global CLI installation, host Git configuration or production dependency is required.

Authored protocol cases separately cover malformed pointers/JSON, action grants, credential isolation, expiry, copied
inputs, exact EOF, terminal error identity, hash mismatch and partial verification failure. These checks do not certify
all Git hosting services, optional transfer adapters, SSH authentication, pointer transforms or deployment access
policy. No benchmark or Git LFS implementation-equivalence claim is made.
