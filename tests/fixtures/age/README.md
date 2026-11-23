# Independent age v1 evidence

`independent.json` is the unchanged candidate-free producer output. Its raw 2,645,064 bytes have SHA-256
`8b28b2fc60c175c506c0e970e2a1685556be26464da801487313416a06996dbf`. The native Go age CLI v1.3.2 encrypted eight
authored originals and decrypted every complete byte before the fixture was copied. Sizes are 0, 1, 65535, 65536, 65537,
131072, 131089 and 182 bytes. The final original is the retained Python stdlib ZIP from `../arfs/zip.json`. Eight
successful upstream CCTV vectors were separately decrypted by the same native CLI and matched their published
whole-plaintext SHA-256. This is native age interoperability evidence, not cross-vendor cryptographic independence or a
whole-suite conformance claim.

The producer used no candidate library, package installation, network access or host mount. It ran Node v26.13.0 on
Linux ARM64 with 1 GiB RAM, memory-swap also 1 GiB, 1 CPU and PID limit 128. It exited 0 without OOM or cleanup faults;
its 25 native commands and resource facts are retained in `provenance/`. The first Python image inspection found no
image; the approved exact-digest pull then matched the expected ARM64 config. Neither acquisition stage ran an archived
executable. Both serial inert acquisitions passed their first execution.

The ephemeral identity is excluded from the JSON. Its file remained in the stopped owned producer container until
retirement; no erasure of native key objects is asserted. Fixture file keys are intentionally public test data. The
producer's small Bech32 and X25519 stanza-unwrapping adaptation is test-only and follows the retained immutable primary
source. It is not a production recipient decoder.

## Upstream identities and derived wires

The release is the exact ARM64 asset at:

```text
https://github.com/FiloSottile/age/releases/download/v1.3.2/age-v1.3.2-linux-arm64.tar.gz
```

It is 17,771,923 bytes, SHA-256 `6b8dc4333c53a5a57c9e5834e3a48f92605d7154014cd07269ff3327db5d37f4`. The release resolves
to source commit `b74dce4cdbe35b5e5f66c06d9612b72f89028758`. The complete nine-member TAR inventory, selected executable
hashes and ELF admission are in `provenance/cli-receipt.json`. Only the admitted `age` CLI was executed by the producer.
Other plugins and inspection tools were inventoried, never invoked. Raw binaries and their archive are not distributed
in this test fixture directory; the reviewed script reacquires the pinned artifact.

CCTV commit `4448f2097b2daa812c91a26141f9f36c2096b9ca` supplies exactly 50 selected vectors. `upstream/` retains their
original bytes, corresponding original generator source and relevant notices. `upstream-sha.json` records original
paths, exact Git blob identities and acquired SHA-256 hashes. The acquisition verified all 109 selected immutable files:
50 vectors, 50 generators and nine primary source files, totaling 123,398 raw bytes. The normative C2SP specification
remains internal research because its redistribution terms have not been established; it is not included under another
file's license.

`cctv.json` holds explicitly derived binary wires, original metadata and expectations. Zlib expansion was bounded and
required exact EOF without trailing data; the original compressed vectors remain unchanged. Outcomes are 23 header
failures, one HMAC failure, 18 payload failures and eight successes. The native producer exercised the eight successes.
It did not execute the 42 negatives or prove upstream streaming-prefix behavior. Candidate tests must refuse every
negative at its relevant boundary; an intermediate payload defect can remain pending after opening until `verify()`
authenticates the complete payload. A seek-first reader authenticating finality at open can reject earlier than the
upstream sequential API. Retained prefix metadata does not create a public streaming-prefix guarantee.

## Licenses and reproduction

The CCTV README offers 0BSD, CC0 or Unlicense for vectors; this fixture selects 0BSD. Its original README contains those
complete terms. Internal CCTV source/testkit instead retains its BSD-style age/C2SP notice. Go age root source has its
BSD-style age Authors/Google/Filippo Valsorda notice. The release's bundled license additionally includes the Go Authors
BSD notice. The Bech32 source has its original embedded MIT notice naming Takatoshi Nakagawa and the age Authors. Do not
apply the vector license to the entire source collection.

`provenance/age-acquire.py`, `age-produce.mjs` and `age-run.py` are the exact reviewed scripts used for these receipts.
The acquisition has fixed URLs, compressed/expanded/member caps, redirect policy and source hash admission. The runner
verifies exact stopped-container image/config/platform/resources/network before starting and separately retains primary
and retirement faults. The immutable Python and Node image references are in `age-prepared-inputs.json`. Reproduction
needs separate serialized acquisition and offline producer reservations, fresh task-owned containers and no candidate
files in `/tool`. The source-stage receipt names the original paths expected under `/tool/evidence/sources/`; the
producer additionally takes the admitted CLI and vector receipts, derived wires and exact Python ZIP JSON.

Strict type, installed-package and fresh-process import checks are separate integration gates. Native oracle production
and authored runtime evidence do not replace them. The first authored candidate run exposed a ZIP consumer mistake:
`zip.read()` returns a result whose `.bytes` field contains plaintext. The test and public example were corrected
without modifying native oracles.

## Portable Bun qualification

The retained first four-runtime snapshot passed native age cases in Deno, Node 22 and Node 26. Bun 1.4.2's native
`node:crypto` rejected this cipher with `ERR_CRYPTO_UNKNOWN_CIPHER`; that failure remains preserved rather than treated
as a malformed tag. `../../age-oracle.ts` is a typed wrapper around `provider.mjs`. This shared test-only transport and
`oracle.mjs` provide the explicit Deno single-chunk capability for the portable Bun reader. The installed-package check
copies the same transport and unchanged child into its disposable consumer and supplies the packed `AgeError`
constructor. Neither helper imports the source reader there or becomes a published module. The child imports no
candidate library and runs with denied I/O permissions, finite request/output/call/deadline caps and native finalization
before release. It does not unlock recipients or implement age parsing. Native factory availability remains an
independent positive full-byte or exact unsupported-cipher refusal test; no native/negative corpus case is skipped.

The subsequent focused snapshot passed all 142 combined age, ORC and AMQP cases in each of Deno, Node 22, Node 26 and
Bun 1.4.2. Bun used the shared Deno child, whose canonical response must report all seven queried permissions denied.
The immutable input has SHA-256 `f6bd346a7173541705c561be9ff034547612772697f9f9573081152825958720`; the retained runtime
receipt records exit 0, no OOM, a 1 GiB memory-and-swap ceiling, one CPU, PID limit 128 and no host mounts. This
qualifies that source input and the restricted helper behavior, not later edits, strict type checks, installed artifacts
or a cryptographic audit. The earlier Bun native-cipher failure remains a separate retained result.
