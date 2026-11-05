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

`acquire.py` downloads seven exact released artifact coordinates and their POMs from same-origin official Maven Central
HTTPS. It validates repository SHA-1 sidecars, records SHA-256, inspects class versions and bounded embedded licenses,
and does not execute downloaded code. Repository sidecars are acquisition corroboration, not an independently verified
signing-key chain. The optional separate BC artifact is inspected/retained in receipts but omitted from the actual
six-JAR classpath because the Cryptomator JARs already relocate BC. Actual acquired POMs and pinned license texts are
under `licenses/`.

The native recipe uses signed Debian OpenJDK 17 and python3-pycryptodome. Acquisition runs with network access; the
authored Java/Python producer then runs in a separate container with **no network**, no host mounts, 1 GiB memory, one
CPU and 128 PIDs. Each JVM heap is limited to 256 MiB. Subprocesses have 120-second deadlines, eight-MiB file limits and
one-MiB diagnostic limits. It compiles only `Native.java` with explicit `javac` and a fixed classpath; no Maven plugins
or upstream setup scripts execute.

Within that prepared environment the commands are:

```sh
/usr/bin/python3 /acquire.py --output /artifacts
# Review the acquired POM/JAR hashes, licenses and class-version receipts first.
# Run the next command in the separate offline producer environment.
/usr/bin/python3 /produce.py --artifacts /artifacts --source /Native.java --output /tmp/independent.json
```

Here `/produce.py` is this directory's `create.py`; `/acquire.py` remains beside it because the producer records both
scripts' hashes. The Java harness and all filenames/inputs are authored and fixed. The native producer does not import
the candidate TypeScript implementation. `provenance.json` records exact image IDs, signed-package versions/deb hashes,
native tool versions, classpath, script hashes, native exit state and compact/formatted fixture hashes. Image IDs
describe local verification images, not publicly pullable complete producer pins. Rebuilding must resolve and retain
actual signed packages/artifacts again.

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
