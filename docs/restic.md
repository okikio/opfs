# Restic REST repository objects

Use this client to inspect or transfer opaque objects in an existing restic REST repository. These objects are encrypted
packs, indexes and other repository records, rather than paths inside a backup. The client does not decrypt them or
implement backup, restore, repository locking, garbage collection or retention.

```ts
import { ResticClient } from "@okikio/opfs/restic";

export async function readFirstPack(
  endpoint: string,
  authorization: string,
  subtle: Pick<SubtleCrypto, "digest">,
): Promise<Uint8Array | null> {
  const client = new ResticClient({
    endpoint, // One exact repository, for example https://backup.example/team-repository/
    credentials: () => authorization, // Complete native HTTP Authorization header.
    subtle, // An explicitly supplied trusted SHA-256 capability, for example your runtime's crypto.subtle.
  });
  const packs = await client.list("data");
  if (packs.length === 0) return null;
  return await client.readVerified({ kind: "data", id: packs[0]!.id });
}
```

The returned bytes are still the stored pack representation. A matching SHA-256 storage ID proves that those complete
bytes match the supplied ID. It does not decrypt an encrypted pack, authenticate its publisher, identify which snapshot
uses it, or establish that the repository is restorable. A large pack can exceed the default 8 MiB materialization
budget; choose a bounded larger policy or use a server-trusted streamed download as appropriate.

## Native object contracts

`ResticObjectSchema` is the runtime source for `ResticObjectType`. A locator is either `{ kind: "config" }` or
`{ kind, id }`, where kind is `data`, `keys`, `locks`, `snapshots` or `index` and the ID is exactly 64 lowercase
hexadecimal characters. Abbreviated CLI identifiers and arbitrary paths are refused. Config is not named by a storage-ID
hash and cannot be passed to `readVerified` or `remove`.

`list(kind)` requests the native V2 media type and requires V2 response evidence. It returns `{ id, size }` entries in
server order. The server returns one complete JSON listing; there is no pagination, cursor, frozen inventory or
automatic V1 fallback. This profile accepts the native plain `name` and `size` fields in either order and rejects extra
fields, escaped field spellings, duplicate fields/IDs and unsafe numeric values. The parser bounds numeric lexemes
before conversion and does not allocate a general JSON object tree. The control-text owner applies its separate 8 MiB
ceiling, and `maxEntries` defaults to 10000 with a hard maximum of 100000. Large repositories can exceed these explicit
limits; the client fails rather than silently truncating the inventory.

`stat(object)` returns a safe native byte size or `null` after HTTP 404. A stat is not a revision condition for a later
read. `download(object, { at, length, signal })` returns a caller-owned byte stream with its selected extent size and
`evidence: "server-trusted"`. Consume or cancel it. Full reads require HTTP 200; ranges require HTTP 206, exact finite
Content-Range and safe Content-Length. Provider EOF clamping is accepted when it agrees with the reported total. Encoded
responses, short bodies and surplus bytes are refused. Zero-length requests are local and provide no existence evidence,
including beyond EOF. This selected profile requires safe Content-Length even for full reads; unknown-length
representations are outside it.

`read` collects one full or selected server-trusted extent. `readVerified` reads the complete named object within the
same budget and compares its SHA-256 digest before returning private owned bytes. No partial read is described as a
whole-object digest proof. The endpoint's digest-shaped name alone creates no verified immutable range source, so this
client does not expose `ByteSourceType` replay identity. SHA-256 requires explicitly injected `subtle`; the library
never discovers a crypto global or another hashing implementation. The constructor reads and binds its digest method
once, so replacing that method on the supplied object during a later HTTP request does not replace the client's
authority. Treat this injected capability as trusted code.

## Writes and repository ownership

`createRepository()` sends the native `?create=true` request to create the repository's directory structure. It does not
perform `restic init`, select an encryption password, create keys/config or prove that an existing repository is empty.
Use the official restic client or another deliberately selected repository implementation for cryptographic setup.

`save(kind, bytes)` validates a named kind, copies the bounded input before its first digest or credential await,
computes the SHA-256 storage ID and sends the opaque bytes under that ID. The returned `{ id, size }` follows a complete
HTTP 200 storage acknowledgement; it is not a backup snapshot commit or independent remote read-back. Config writes and
whole-repository deletion are intentionally outside this API. The named objects are not parsed as restic encrypted
formats. Supplying random plaintext as a `data` object does not make a usable backup pack.

The pinned rest-server refuses saving an already existing object. The client does not promise universal compare-and-swap
or an atomic create condition across REST implementations; native status remains evidence from the configured service.
It never automatically retries mutations. Retrying after an uncertain save can produce a refusal even if the first save
completed, and a later matching object does not prove who published it.

`remove(object)` deletes one explicitly named object. **The caller owns the repository's maintenance and lock
protocol.** Removing a live pack, index, key or snapshot can make a backup unrestorable. This primitive does not
coordinate with restic, prune references, enforce retention or delete an entire repository. Use it only when your
application owns the necessary native maintenance conditions. An append-only rest-server denies deletion of ordinary
objects but exempts `locks`; that exception is not a general immutable retention guarantee. Repeated removal can be
acknowledged even when an object was already absent, so success is not proof that this particular request removed
existing bytes.

After a dispatched mutation lacks a complete accepted acknowledgement, `ResticPublicationError` preserves the native
operation, named object when applicable, and `outcome: "unknown"`. Causes can include `ResticError` with an HTTP status,
transport failure, rejected redirect/partial response or response-retirement failure. Preserve that context, coordinate
with the repository owner, and reconcile before retrying. A cancellation or failed acknowledgement does not roll back
storage effects. These errors do not pretend that a server refusal proves no partial effect on every implementation.

## Bounds, credentials and resources

`maxBytes` defaults to 8 MiB and cannot exceed `RESTIC_BUFFER_BYTES` (64 MiB). It bounds one copied save or materialized
read, not a streamed download, repository quota or all concurrent calls. Materialization and native WebCrypto may retain
additional copies. Callers choose concurrency and own the total memory budget. A declared oversized read is cancelled
before collecting its body; actual EOF and byte counts are still checked. Uploads are materialized only; there is no
streaming-upload or resumable-session claim.

The endpoint must be one explicit repository root ending in `/`, without embedded URL credentials, query or fragment.
Reserved REST object-type components in that prefix are refused because the server uses them to distinguish repository
scope. The selected endpoint profile uses printable ASCII URLs; encode literal Unicode as needed. Dot/encoded-dot,
encoded-slash, backslash and control aliases are rejected before normalization. HTTPS is required unless
`allowHttp: true` explicitly admits a local/test deployment.

The optional callback returns only a complete native Authorization header. An absent callback/header sends no API
authorization. It does not discover usernames, passwords, environment configuration or auth challenges. Every request
remains in the configured repository; credentials are omitted from ambient Fetch state, redirects are manual and no
redirect receives authentication. Callback URLs are detached copies. The optional request signal is borrowed through the
request owner, including credential acquisition; credential adapters should honor it. Pre-aborted calls do not acquire
credentials, and responses retire on status/header/body failures. A terminal body-read error is preserved rather than
repeated through cancellation. Caller-injected transport/credential errors are retained and can themselves contain
secrets; application error logging remains caller-owned.

## Primary sources and independent proof

The protocol is pinned to
[restic 0.19.1 REST_backend.rst](https://github.com/restic/restic/blob/6aa3a516ce654808a1f28f9fa21e9b7c8e6e90bf/doc/REST_backend.rst),
SHA-256 `671604761cf5fdc01b730df6d92522f48b092949eedea190d5be294ba162ea82`. Native server behavior is pinned to
[rest-server 0.14.0 repo/repo.go](https://github.com/restic/rest-server/blob/ad130de02124c445300f149fa4f8e826dfdd0e3f/repo/repo.go),
SHA-256 `cc2b790a5f41181fa725f59ad885f537b1ed486a5677f034b7f090df41d24e1a`. The independent
[official CLI pack reader](https://github.com/restic/restic/blob/6aa3a516ce654808a1f28f9fa21e9b7c8e6e90bf/cmd/restic/cmd_cat.go)
has SHA-256 `1ee2bf95f404b13303763905362bd1cafb09f2f5e53a4c38b8b67c7a129ad650` (retrieved 2026-11-05).

Testcontainers owns the genuine server/CLI fixture, mapped ports, private network, native HTTP/log readiness and reverse
cleanup. Immutable image indexes are rest-server
`sha256:d2aff06f47eb38637dff580c3e6bce4af98f386c396a25d32eb6727ec96214a5` and official restic CLI
`sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510`. Each server is limited to 0.25 GiB and the
CLI to 0.5 GiB. Fixture-only HTTP accounts, repository passwords, source files and caches remain inside disposable
containers. No host repository, credential or globally installed restic executable enters the test.

The CLI initializes actual encrypted repositories and backs up a source file. Candidate full verified reads and ranges
are compared with complete native `restic cat pack` bytes. The candidate also saves a produced pack to a separate
initialized repository, where the CLI raw reader compares all bytes; the copied encrypted pack is not claimed to be
decryptable under that destination's different key. The native append-only policy and its lock-object deletion exception
are exercised separately in disposable owned repositories. This proves the named raw-object profile, not backup
correctness, retention enforcement, compatibility with every REST server or production performance. No SDK or additional
third-party dependency enters production.
