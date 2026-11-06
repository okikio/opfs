# Independent Cryptomator fixtures

These are test-only tools. No Java artifacts, PyCryptodome dependency or upstream Cryptomator implementation is bundled
into production source.

`independent.json` retains 19 originals, genuine cryptolib-produced encrypted content and names, and reciprocal
Python-produced content and names. Released cryptolib 2.4.0 encrypts each original and name; PyCryptodome independently
decrypts every original byte and UTF-8 name. Python then produces another ciphertext/name pair and cryptolib decrypts
both back to the same originals. The raw key is fixed public test data and must never be used for a real vault. Empty,
block/chunk boundary, Unicode, literal BOM and nested ZIP cases are included. Name and parent-ID lengths include 1, 15,
16, 17, 31, 32 and 33 bytes. The compact JWT is authored from the documented format, not produced by the Cryptomator
filesystem application.

## Current TypeScript acquisition and interoperability

The current `acquire.ts` downloads the same seven released coordinates and POMs. `artifacts.ts` pins all fourteen SHA256
digests to the previously reviewed release bytes. Official Maven Central HTTPS and repository SHA1 sidecars provide
additional transport corroboration, not an independently authenticated signing-key chain. Redirects stay on that HTTPS
origin, with at most five redirects and a 60-second request deadline. Streamed artifacts are limited to 16 MiB each and
64 MiB in aggregate; sidecars are ASCII and at most 512 bytes.

`Inspect.java` uses JDK `JarFile` to read downloaded JARs as data. It loads no downloaded classes and runs no Maven
plugins or upstream setup scripts. It retains class-major counts by base/multi-release section, rejects base classes
newer than Java 17, and inspects the manifest and embedded license/notice text. Admission remains at most 20000 entries,
64 licenses per JAR, 1 MiB per license, 2 MiB license text per JAR and 8 MiB across artifacts. Manifest text also has a
1 MiB bound. The acquisition directory must be new; exclusive file creation and owned-directory cleanup preserve
preexisting evidence when a run fails.

Run acquisition in the network-enabled disposable runner, review its receipts, then copy the admitted artifacts into a
separate offline runner. Both runners need Node 26, signed OpenJDK 17 `java`/`javac` and util-linux `prlimit`; the
producer also needs the reviewed native `7zz` CLI:

```sh
node tests/fixtures/cryptomator/acquire.ts --output /tmp/cryptomator-artifacts-new
# After receipt review, in the separate offline runner:
node tests/fixtures/cryptomator/create.ts --artifacts /tmp/cryptomator-artifacts-new --output /tmp/cryptomator-new.json
```

`create.ts` rechecks every artifact against pinned SHA256 before compilation. The unchanged `Native.java` still
encrypts/decrypts all nineteen content/name cases with released cryptolib. Node's built-in AES-256-GCM primitives
independently decrypt complete native content and produce another authenticated image that cryptolib must accept. The
fixed public 64-byte key and authored HMAC-SHA256 JWT are preserved. The JWT is an authored protocol input; the Java
harness does not validate configuration JWTs.

Filename checks use **authored RFC5297 CMAC/S2V framing over Node's native AES-256 ECB/CTR primitives**. They compare
deterministic native name ciphertext exactly, verify the synthetic tag before decoding UTF8, and require cryptolib to
decrypt authored names to every original, including a literal BOM. This is not an independently supplied complete SIV
implementation and does not inherit the frozen PyCryptodome attribution. New records use `nodeCiphertext` and
`nodeEncryptedName`. The S2V construction follows [RFC5297](https://www.rfc-editor.org/rfc/rfc5297); primitive
authentication uses the documented [Node crypto API](https://nodejs.org/api/crypto.html).

The nested ZIP now comes from native 7-Zip STORED production with the same original member contents; it is a changed
archive-input profile, not a replay of Python zipfile bytes. Every nested image byte still passes through both content
directions. Each native child has a 120-second deadline with SIGKILL and an 8 MiB kernel per-file limit. Producer
diagnostics are capped at 1 MiB; JAR-inspector JSON is capped at 8 MiB. Each JVM heap stays at 256 MiB. Regular native
files are size-checked before materialization. These bounds are not a filesystem quota. The final JSON requires a new
path and uses exclusive creation.

The current TypeScript acquisition completed separately from the offline producer. Its native qualification passed all
19 reciprocal byte/name cases with OpenJDK 17.0.21 and Node 26.13.0. Production ran without network in a 1 GiB runner,
without OOM; the owned container was removed. This qualifies the changed Node/native profile, not a new PyCryptodome
execution or an independently supplied complete SIV implementation. Keep its output separate from the existing
`independent.json`, provenance and licenses, which remain unchanged. Original Python sources remain exact inert
snapshots.

## Historical Python and native Java evidence

The historical `acquire.py`, now inert `acquire.py.snapshot`, downloaded seven exact released artifact coordinates and
their POMs from same-origin official Maven Central HTTPS. It validates repository SHA-1 sidecars, records SHA-256,
inspects class versions and bounded embedded licenses, and does not execute downloaded code. Repository sidecars are
acquisition corroboration, not an independently verified signing-key chain. The optional separate BC artifact is
inspected/retained in receipts but omitted from the actual six-JAR classpath because the Cryptomator JARs already
relocate BC. Actual acquired POMs and pinned license texts are under `licenses/`.

The native recipe uses signed Debian OpenJDK 17 and python3-pycryptodome. Acquisition runs with network access; the
authored Java/Python producer then runs in a separate container with **no network**, no host mounts, 1 GiB memory, one
CPU and 128 PIDs. Each JVM heap is limited to 256 MiB. Subprocesses have 120-second deadlines, eight-MiB file limits and
one-MiB diagnostic limits. It compiles only `Native.java` with explicit `javac` and a fixed classpath; no Maven plugins
or upstream setup scripts execute.

That historical prepared environment ran:

```sh
/usr/bin/python3 /acquire.py --output /artifacts
# Review the acquired POM/JAR hashes, licenses and class-version receipts first.
# Run the next command in the separate offline producer environment.
/usr/bin/python3 /produce.py --artifacts /artifacts --source /Native.java --output /tmp/independent.json
```

Here `/produce.py` was the original `create.py`, now inert `create.py.snapshot`; `/acquire.py` remained beside it
because the producer recorded both scripts' hashes. The Java harness and all filenames/inputs are authored and fixed.
The native producer does not import the candidate TypeScript implementation. `provenance.json` records exact image IDs,
signed-package versions/deb hashes, native tool versions, classpath, script hashes, native exit state and
compact/formatted fixture hashes. Image IDs describe local verification images, not publicly pullable complete producer
pins. Rebuilding must resolve and retain actual signed packages/artifacts again.

The initial authored harness failed Java compilation because public FileHeader has no destroy method. The successful
harness checks its separate Destroyable capability. The initial diagnostic and original harness hash remain recorded; no
fixture was copied from that failed attempt.

The independent oracle is AES-256 interoperability through these public APIs. Published RFC 4493/5297 AES-128 example
vectors were not executed against the AES-256-only selected module. No private implementation was duplicated or exported
solely to pretend that those examples test this profile.

The fixture cannot prove an independent security audit, constant-time behavior, original file completeness, freshness or
the association of a name with file contents. It proves the retained original bytes and names interoperate with the
recorded genuine producer/consumer versions. The portable tests separately exercise tampering, budgets, lifetime,
cancellation and archive composition.
