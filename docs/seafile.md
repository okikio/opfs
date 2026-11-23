# Read and upload files in a Seafile library

Use `SeafileClient` when an application owns one Seafile library ID and a user API token. The client keeps native
library and file identity visible and gives file-server capabilities their own explicit grants. It does not discover
accounts, log in, unlock encrypted libraries or project a canonical filesystem.

This complete function uploads bytes and reads the **actual created name** from the acknowledgement. Seafile may rename
an upload when the requested name already exists:

```ts
import { SeafileClient } from "@okikio/opfs/seafile";
import type { SeafileReceiptType } from "@okikio/opfs/seafile";

export async function save(
  endpoint: string,
  library: string,
  token: string,
  dataOrigin: string,
  directory: string,
  name: string,
  bytes: Uint8Array,
): Promise<{ receipt: SeafileReceiptType; bytes: Uint8Array }> {
  const client = new SeafileClient({
    endpoint,
    library,
    token,
    uploadGrants: [{ origin: dataOrigin, prefix: "/seafhttp/" }],
    downloadGrants: [{ origin: dataOrigin, prefix: "/seafhttp/" }],
  });
  const receipt = await client.upload(directory, name, bytes);
  const created = `${receipt.parent === "/" ? "" : receipt.parent}/${receipt.name}`;
  return { receipt, bytes: await client.read(created) };
}
```

Use only a library and directory you own. The native upload can modify persistent state and is not rolled back when a
later read fails. A lost acknowledgement needs application-owned reconciliation; do not blindly call this function
again.

## Library, file and capability authority

`endpoint` is the Seafile service base, optionally under a reverse-proxy prefix. `library` is a complete lowercase UUID.
The `token` option is an explicitly supplied user token or an async callback receiving a detached API URL and signal.
The client sends it as native `Authorization: Token ...`; the inspected server also accepts Bearer spelling. The
callback does not return the whole header. Library API tokens use different `via-repo-token` routes and are outside this
profile. The caller owns token acquisition, refresh, authorization and revocation.

Importing the module starts no work. Client construction captures the configured capabilities; it does not connect or
read environment variables. HTTPS is required unless `allowHttp: true` explicitly permits an owned HTTP deployment.
`getLibrary()` returns native name, permissions, encryption state and reported head when available. Every nonempty data
operation obtains library metadata and refuses an encrypted library before requesting a file capability. Encrypted
library metadata remains inspectable. There is no password exchange, key derivation, cached-decryption session or claim
that the existing archive encryption readers decrypt Seafile's library format. A zero-length read is local and proves
neither library accessibility nor file existence.

`stat()` returns native file ID, name, parent and size. `list()` returns the complete nonrecursive directory response,
with file/directory kinds retained and no invented continuation. It refuses duplicate names, unsafe names or mismatched
parents. Seafile file IDs refer to its native file representation and are **not** verified SHA-1 digests of complete
file bytes. Library head IDs and file metadata do not supply a conditional read in this profile. No immutable
`ByteSource`, version selection, virtual-library identity guarantee or general filesystem semantics are inferred. Paths
can change between metadata, link acquisition and data transfer.

Native paths must start with `/` and use literal Unicode segments. Dot segments, repeated separators, backslashes,
control characters, malformed UTF-16 and trailing slashes outside root are refused. File names are at most 255 code
units. Names are not silently normalized. The native API still owns its additional naming and permission rules.

API requests and file-server capabilities are separate authorities. `downloadGrants` and `uploadGrants` independently
admit exact origins and literal ASCII path prefixes ending in `/`, such as `https://files.example.test` plus
`/seafhttp/`. Configure the actual `FILE_SERVER_ROOT` advertised by your deployment; a custom reverse proxy can need a
different explicit prefix. There is no implicit same-origin grant, wildcard host suffix or arbitrary root grant.
Capability URLs with credentials, fragments or encoded path aliases refuse. Their query/path tokens are secret and are
not returned by the convenience APIs.

**Capability hops receive no user token, even when their origin equals the API origin.** Cookies and referrers are also
omitted. API and upload redirects refuse. Download redirects are credential-free, bounded by `maxRedirects` (default 3,
hard 8), and must pass the download grants at every hop. Repeated URLs reject. A hostile or expired capability cannot
cause an API credential callback to run for a data URL.

## Bytes, uploads and uncertain receipts

`download()` returns `{ bytes, size, evidence: "server-trusted" }`; consume or cancel its stream. It obtains a fresh
native one-time link (`reuse=0`). Capability GETs are not automatically retried, because a token can be consumed by a
previous attempt. A new download operation obtains a new link; this is not a resumable or revision-stable source. Ranges
require matching HTTP 206 and finite Content-Range/Content-Length, with ordinary EOF clamping. Full reads require
HTTP 200. Encoded data, wrong extents, premature EOF and extra bytes reject. A complete native read error remains the
primary error rather than being duplicated by cancellation. Signals cancel active I/O and caller-owned consumption; they
do not undo uploads or revoke minted native links.

`read()` materializes a response up to `maxBytes`, default 8 MiB, hard 64 MiB (`SEAFILE_BUFFER_BYTES`). Admission uses
the response's size, so an oversized read can make API/data requests before refusing the body. Streaming downloads do
not inherit the whole-file buffering limit. Uploads copy bytes before any credential/library await and use the same
materialization policy. Caller-owned token callbacks and transports are trusted capabilities and remain caller-owned.

`upload(directory, name, bytes)` uses native `replace=false`. A collision can produce a different name; follow
`receipt.name` and `receipt.parent` rather than assuming creation failed or overwrote the original. This is **not**
atomic create-only. `{ replace: true }` explicitly requests native unconditional replacement. No ETag compare-and-swap,
atomic rename or transaction is implemented. The acknowledgement validates one safe returned name, native ID and exact
submitted size. It does not certify content integrity, publisher authenticity or durability. Full streaming uploads,
chunked/resumable sessions, mkdir, remove, rename, share administration and encrypted data are outside this profile.

`SeafileError` exposes a native API status without response text or capability URLs in its message.
`SeafilePublicationError` retains `outcome: "unknown"`, library, requested parent/name and original cause after a
dispatched data upload lacks a validated complete receipt. HTTP errors, redirects, malformed receipts, unexpected sizes
and body-release failures cannot establish safe replay. API admission failures before dispatch do not imply data
publication. Application recovery must retain intent and inspect native state under its own concurrency policy; matching
later bytes alone cannot attribute an upload to this attempt. Library-owned messages omit secrets, but injected token or
transport errors can contain them in their causes; do not dump arbitrary errors into public logs.

Control responses have an 8 MiB response-reader bound. The private JSON profile also limits depth 32, 100000 tokens and
512 KiB lexical strings, rejects duplicate decoded/prototype keys, and accepts only canonical safe-integer numeric
lexemes before conversion. Fractions and exponent notation reject rather than rounding into usable byte authority.
Directory results default to at most 10000 entries, configurable up to 100000; this is a client safety policy, not the
server's directory limit. Unknown non-authority metadata is otherwise ignored.

## Verification and supply chain

`tests/seafile.test.ts` contains authored protocol cases for byte/option snapshots, same-origin credential stripping,
grants, ranges and actual extents, encryption refusal, listing identity, malformed numeric authority, uncertain receipts
and cancellation. These fixtures do not constitute an independent server implementation.

Historical native verification passed against the pinned official CE14 image reporting **14.0.9**, with official
`seafileapi2` as an independent producer and complete-byte reader. The current TypeScript fixture uses native curl for
HTTP and multipart framing instead. This is an authored API recipe, not a new run of that SDK. Run
`node --test tests/seafile-provider.test.ts` with Docker available. The test checks complete bytes in both directions,
exact ranges/stat, actual collision names and preserved originals, unconditional replacement, listing, encrypted-library
refusal, invalid tokens and native read-only sharing (read succeeds; upload refuses). It also verifies the returned
native capability origin and `/seafhttp/` prefix before the candidate reads bytes. The final run exited 0; its bounded
receipt is `.tmp/seafile-provider-final.log`. This is one disposable local deployment, not proof of every Seafile
release, production scaling, failover or encrypted content support.

No production module imports the fixture recipe or former SDK. The finite fixture budgets are 2 GiB server, 0.5 GiB
database and 0.125 GiB Redis. The private network and services have reverse-order cleanup, with the primary setup
failure preserved alongside cleanup failures. Testcontainers owns readiness and mapped ports. No host account,
production library or fixed port is used. The first attempt encountered a read-only Docker filesystem that also
prevented cleanup; its initial and recovery logs remain under `.tmp/seafile-*.log`. After host/Docker recovery, the
final native run and teardown succeeded.

The fixture configures native capability receipts with its actual mapped authority. CE14 applies
`SEAFILE_SERVER_HOSTNAME` after local settings, so the fixture restarts only Seahub with that explicit environment
value; the container's ephemeral port stays stable. The pinned native script checks only process existence and allows
one second for graceful shutdown. On its exact slow-shutdown failure, a bounded Testcontainers command strategy waits
for the owned Gunicorn process to exit before repeating native restart. Testcontainers then verifies HTTP readiness. The
inspected `seahub.sh` SHA-256 is `9bb44214b9787aa47b7a08b27bc29e876928fbbdef54f15af5a1046617691368`.

The current [TypeScript curl recipe](../tests/provider/seafile-curl.ts) runs on the caller's host and requires curl on
PATH. It disables curl startup configuration and proxies, bounds each command to 35 seconds and 1 MiB of output, and
sends credentials only to the disposable server's exact mapped authority. It validates returned capability URLs before
using them and omits the user token on downloads. No URL is rewritten to a different authority.

The recipe follows Seafile's [upload API](https://plus.seafile.com/published/web-api/v2.1/file-upload.md) and
[file API](https://cloud.seafile.com/published/web-api/v2.1/file.md). Native curl owns multipart framing; the recipe
authors the create, upload and read operation sequence. Its complete provider suite must pass before this replacement
can be called runtime-qualified. The previous SDK fixture is retained byte-for-byte as
[`provider.ts.snapshot`](../tests/fixtures/seafile/provider.ts.snapshot), including all original wheel pins. That
snapshot is inert historical evidence; no Python, pip, wheel imports or upstream setup run in the current fixture.

Primary evidence inspected 2026-11-05:

| Source                                                                                                                                  | Immutable revision or digest                                     | Source SHA-256                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| [Native file handler](https://github.com/haiwen/seahub/blob/0841826c7ce738caf92121d94d7741ba0f2373d5/seahub/api2/endpoints/file.py)     | `0841826c7ce738caf92121d94d7741ba0f2373d5` (v14.0.9-server)      | `1926fa9f5d281415d0483ce18e5de9e6a7a920e584cda2c0849f56e47531a10b` |
| [Native directory handler](https://github.com/haiwen/seahub/blob/0841826c7ce738caf92121d94d7741ba0f2373d5/seahub/api2/endpoints/dir.py) | same commit                                                      | `089aab99a4b880f3fa5b6906660b9bdc23f9270d935ba6ff469d33fa97012d02` |
| [Official CE14 deployment](https://manual.seafile.com/14.0/setup/setup_ce_by_docker/)                                                   | retrieved 2026-11-05; deployment YAML bytes retained in research | `2dc49bdd563ab0b9c10e3cac22593a2bada2646801ca777272cc9d5d56183e9f` |

The CE14 fixture selects Linux AMD64 manifest `sha256:61cabec327c2401258cf814a3c5aaa7323d07ef02551bb032508a263d5c874a4`
from official index `sha256:75d8b88e8bfaa54099082aec0e99ff1a962bd364bfc21da34125fa66998f0861`. Its advertised ARM64
variant failed here with an entrypoint `exec format error`; ARM hosts need explicit AMD64 emulation for this fixture.
Other pinned images are MariaDB 10.11.15 `sha256:85c39719200637250bb8abe3ccd239239d6f175156fc1698141409fcf8e01a38` and
Redis 7.4.7-alpine `sha256:02f2cc4882f8bf87c79a220ac958f58c700bdec0dfb9b9ea61b62fb0e8f1bfcf`. Image pins and independent
complete-byte checks do not prove production scalability, failover, encrypted-library behavior or an independent
security audit.
