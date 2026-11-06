# Native BAM prefix corpus recipe

Status: native production qualified in receipt `86ab95db-79e3-4541-9095-0f171e5ae0f0`. Samtools and bundled HTSlib 1.25
produced four profiles with complete original SAM readback. The first BAM reader has passed focused portable candidate
tests; installed-package consumers passed in receipt `eb663979-e1bf-4c92-b91b-b10c3a770916`; exact-head CI remains
pending. Read the [BAM proposal](../../../planning/storage/BAM.md) for the consumer and verification boundaries.

This recipe converts authored SAM originals through official Samtools 1.25 and its bundled HTSlib, then compares the
complete native SAM readback with the original text. It also runs native `bgzip -t`. Samtools writing and reading share
HTSlib: this is independent of candidate code, not two-engine interoperability. The additional Node/zlib geometry check
proves that the large record actually crosses native block boundaries; it does not independently interpret all record
fields. No candidate parser, Python interpreter or downloaded setup/package-manager hook is used.

`codec.test.ts` is a separate diagnostic runtime admission test. It imports no candidate parser or compression
implementation. It uses authored stored/fixed DEFLATE, Node's native zlib for dynamic-block production and full
reference decoding, and the [Compression Standard](https://compression.spec.whatwg.org/#supported-formats) for required
refusals. Native zlib accepting concatenated gzip does not redefine the Web API's single-member requirement. The test
covers strict termination, empty concatenation, corrupt trailers and joined abort/cancel retirement. Receipt `21ea69aa`
records Node passing all six tests, Deno accepting empty truncated raw input, and Bun accepting a forbidden
trailing/concatenated-input control. The original Bun failure did not name the exact vector; current failure messages
include vector, input size and chunk size. These strict expectations remain unchanged. This diagnostic suite is separate
from the normal required passing tests; its failures prevent portable native-codec admission.

The fallback extracts the existing owned MSZIP decoder into `src/archive/deflate.ts`, with separate private raw-output
and CK-wrapper limits. New `tests/deflate.test.ts` controls cover zero, 32 KiB and 64 KiB boundaries, explicit history,
exact termination, legal padding and work/cancellation reasons. Receipt `11125dad-bb4b-49c0-8b49-3e98a3fded2d` passed
all 32 selected tests on Node and Bun. Deno passed CAB and Netlify controls but its native zlib dictionary oracle
rejected the authored maximum-distance vector after the candidate full-byte assertion had passed. That external oracle
now lives separately in `dictionary.test.ts`; the portable test retains every candidate history, refusal and overlap
assertion. The revised split passed in `3e038fe0` (Deno/Bun 30 selected tests, Node 31 including its dictionary oracle).
The first BGZF-backed BAM reader then passed Deno/Node/Bun candidate tests in `e1990cbe-7cea-4255-8b5d-4089c5f6aa33`.
The reader checks each member's header, CRC32 and ISIZE and supplies empty history for that independent member.

Root can run `deno test --no-check tests/fixtures/bam/codec.test.ts` in the isolated lane, then use existing portable
consumer tooling to resolve its standard-library imports for Node and Bun. Runtime/version receipts and successful full
EOF are required for admission; a prefix result or an unsupported constructor is not a pass.

The independent Node-only dictionary oracle can be selected separately with
`node --test tests/fixtures/bam/dictionary.test.ts` after the normal portable consumer step resolves its
standard-library import. It has no runtime skip or candidate dependency. Do not include it in the Deno-required passing
suite or interpret Deno's shim failure as a candidate failure.

## Admit bytes before executing source

The official [1.25 release](https://github.com/samtools/samtools/releases/tag/1.25) links the complete
`samtools-1.25.tar.bz2` archive. GitHub-generated source archives omit bundled HTSlib and generated files and are not
substitutes. The root acquisition obtained official release API metadata: release `425174645`, asset `681087642`,
9,521,878 bytes and SHA-256 `8bbd2b3cb447953149a74ab0b00e3ec4e88a789a27b8373a31fa6b5b2dee02b1`. These values are frozen
in `artifacts.ts`. Official tag metadata records annotated tag `17b11c98dba4f877975a6e0de4150ca850164f47`, pointing to
commit `7162950d0988480faeddeb49f03520737e13a9c4`. Inert acquisition receipt `3724b28e` measured the complete archive
against this fixed extent and SHA-256. Each later build requires a separate review of its actual bundled source,
licenses and build inputs. The metadata came from the
[official release API](https://api.github.com/repos/samtools/samtools/releases/425174645) and
[annotated tag API](https://api.github.com/repos/samtools/samtools/git/tags/17b11c98dba4f877975a6e0de4150ca850164f47).
Recording these upstream identities does not independently verify a cryptographic signature or prove that every release
archive member reproduces the commit tree.

The published asset digest is evidence about the release archive, not reproducible-build proof or independent signature
verification. Acquisition must measure the actual downloaded bytes against that fixed identity; it accepts no
caller-selected replacement hash.

```sh
node tests/fixtures/bam/acquire.ts --output /native-input/bam
```

`acquire.ts` refuses mismatched bytes or extent and an existing destination. It retains only inert archive bytes and
`admission.json`, with `executionAdmitted:false`. It does not extract or execute source. Next, run the separate inert
review step inside the bounded isolated lane, using its reviewed system `bzip2` decoder:

```sh
node tests/fixtures/bam/inspect.ts --artifacts /native-input/bam --output /evidence/bam-review
```

`bam-review` must not exist. The step rechecks the exact archive and acquisition receipt, bounds BZIP2 expansion at 128
MiB and 30 seconds, then reuses the acquisition TAR parser for checksum, path, member-count and link admission. It
writes `source/` with regular files at mode 0600, copies discovered license/notice materials under `licenses/` as inert
snapshots, and retains every source path, mode, size and SHA-256 in `inventory.json`. Candidate build inputs and license
materials are listed separately so root can locate them without treating filename classification as a completed legal or
source review. `review.json` hashes that inventory, records the system decoding observations and retains
`executionAdmitted:false`. No archived configure, setup, make target, script or native consumer is executed. The copied
source is review material, not permission to build. Inspection passed in receipt `1529f22e-f341-45de-85d8-d954d5527833`:
2,035 members and an inventory SHA-256 of `6f2cdd6e6a87b00e36a63194e1467c55add30ebd61adcb03848afaf26f2e4fc2`. The root
review covered the retained licenses, INSTALL files and selected build inputs. It did not audit every source function.

Both inspection and later production reuse `source.ts`; no second TAR parser or candidate BAM reader supplies admission
evidence. Acquisition's receipt stays unchanged. After reviewing the actual inventory, license materials and proposed
build inputs, root creates a separate fresh `/native-input/bam/execution-admission.json`:

```json
{
  "sha256": "8bbd2b3cb447953149a74ab0b00e3ec4e88a789a27b8373a31fa6b5b2dee02b1",
  "reviewedForIsolatedTestExecution": true
}
```

Preserve the original acquisition receipt. Record the actual root runner image digest and installed compiler, make,
BZIP2 and zlib package identities beside qualification. Native source inventories and full `samtools --version` output
are included in the producer's result; they must confirm the expected bundled `htslib-1.25` tree. For each new execution
admission, review real artifact bytes and licenses before granting it; this is not an authorization shortcut. The
qualified run above records one admitted build, not permission for substituted inputs.

## Compile and compare only inside the bounded runner

Required programs: Node 26, GNU make, a C compiler, `sh`, standard configure utilities, `bzip2` and `/usr/bin/prlimit`;
zlib development headers/library must be installed from the runner's reviewed package source. The qualified ARM64 runner
used image `sha256:01f5eb8edbe75e962e78730d6258d2c01c85b1c619d7e47717eeea470148b7f5`, GCC 12, `bzip2 1.0.8-5+b1` and
`zlib1g-dev 1:1.2.13.dfsg-1`. GNU make was missing from that image. Receipt `19b1fa2d` acquired Debian `make 4.3-4.1` as
an inert 391,184-byte ARM64 package, SHA-256 `7ef5f5c0e3f909c811f941598107119af0a0554641b5cc590f584cea6a55d204`. The
execution lane unpacked it into a private prefix with `dpkg-deb -x` and selected that prefix through PATH; it did not
install packages or run maintainer hooks. Other runner architectures need their own reviewed tool identities. Upstream
prerequisites are documented in [Samtools INSTALL](https://github.com/samtools/samtools/blob/1.25/INSTALL) and
[HTSlib INSTALL](https://github.com/samtools/htslib/blob/1.25/INSTALL).

The recipe selects single-job builds, the bundled HTSlib, no curses and explicit disables for curl, cloud transports,
plugins, bzip2/LZMA CRAM codecs and libdeflate. Source BZIP2 expansion still requires the system `bzip2` executable;
disabling HTSlib's bzip2 codec does not remove that acquisition-format requirement. No `make install`, upstream test
suite or miscellaneous Python/Perl script target runs. The only make targets are `libhts.a`, `bgzip` and `samtools`.

Inside root's isolated lane, mount the admitted input read-only and a fresh evidence destination writable. Use no
execution-time network, 1 GiB memory and swap, CPU 1 and PID 256; retain bounded container diagnostics and verify
removal.

```sh
node tests/fixtures/bam/producer-run.ts --artifacts /native-input/bam --output /evidence/bam-new
```

The reused group supervisor has a 180-second whole-producer deadline and finite post-kill join. Individual native
commands have 120-second deadlines, SIGKILL retirement, 32 MiB file ceilings and 4 MiB captured-output ceilings. Receipt
`86ab95db-79e3-4541-9095-0f171e5ae0f0` qualified compilation and complete readback in the isolated lane. Its
`independent.json` records Samtools/HTSlib 1.25, all four full SAM comparisons, and six BGZF blocks with one record
crossing block boundaries for the 160,000-base case. This is same-library native proof, not candidate-reader proof or
two-engine interoperability. A future timeout remains a failed qualification, not evidence of a bad format.

The source archive is expanded with a 128 MiB ceiling, at most 12,000 TAR members, checked canonical paths and no links.
Only fresh private files receive source bytes. The existing acquisition TAR inspector is reused by wrapping the bounded
raw TAR in a local stored-gzip envelope; this wrapper is tooling plumbing, not a transformation of BAM data. The result
retains every source-file hash. A source link or unexpected HTSlib directory fails closed for later review.

The four native-qualified profiles are header-only, mixed mapped/unmapped records with ordered scalar auxiliary fields,
reference-free unmapped data, and a 160,000-base record crossing BGZF boundaries. Readback must preserve every original
SAM byte, including header order and auxiliary order. A native normalization difference is a failed assumption to
investigate; do not regenerate originals from the native result. Sequence and quality values are authored, not copied
from candidate output. The large-record geometry assertion must pass on the actual native output.

`independent.json`, `native.log` and `native-state.json` are new evidence only after this command succeeds and cleanup
is checked. They do not certify production acceptance, malformed-input refusal, CRAM, indexing, regional-query
completeness or live remote access. Candidate acceptance and authored corruption/cancellation controls remain later
gates. Preserve a failed runner's terminal receipt and diagnose it before changing the profile.
