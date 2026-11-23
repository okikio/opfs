# Native BAI/CSI query corpus recipe

Status: native fixture passed on 2026-11-06 in isolated run `3665437b-f7b4-4561-8713-44376fbe9cc8`. The retained
`.tmp/implementation/language-validation/3665437b-f7b4-4561-8713-44376fbe9cc8/receipt.json` records a pass, no OOM and
container removal; `evidence/bai-native/independent.json` retains the native observations. The selected corpus is copied
into [`native/corpus.json`](native/corpus.json), whose qualification record identifies the original receipt bytes. This
fixture extends the BAM proof with separately authored indexed inputs; it does not change the frozen prefix corpus,
qualify a candidate index parser or establish a production regional-query API. Read the
[BAI/CSI plan](../../../planning/storage/BAI.md) for the proposed caller-asserted source/index pairing and its limits.

The producer builds official Samtools 1.25 and its bundled HTSlib from the same exact admitted input as the
[BAM fixture](../bam/README.md). Its only imports from that fixture are the immutable artifact identity and shared inert
source admission/extraction. No second TAR parser, candidate BAM/index parser, Python program or downloaded
package-install hook runs. Samtools writes BAM, writes indexes and queries them; this is independent of candidate code
but shares one native library, rather than proving two-engine interoperability.

## Inputs and bounded execution

Reuse `/native-input/bam`, containing the exact `samtools-1.25.tar.bz2.snapshot`, inert `admission.json` and separately
reviewed `execution-admission.json`. Do not rewrite the inert receipt or infer execution permission from a published
digest. The release bytes, source review and build requirements are documented in the existing BAM recipe.

Run only in the root-owned offline qualification container with the admitted source mounted read-only, 1 GiB memory and
swap, CPU 1, PID 256 and a fresh writable evidence destination. Node 26, C compiler, make, zlib development files,
system BZIP2 and `/usr/bin/prlimit` are required. No new runtime or production package dependency is introduced.

```sh
node tests/fixtures/bai/producer-run.ts --artifacts /native-input/bam --output /evidence/bai-new
```

The shared Arrow group supervisor owns all descendant configure/make/query commands under its existing 180-second
producer deadline and bounded post-kill join. Individual commands use the existing 120-second SIGKILL deadline, 32 MiB
file ceiling and 4 MiB captured-output ceiling. The build uses one job, the bundled HTSlib, and disables curses,
libcurl/cloud transports, plugins, bzip2/LZMA codecs and libdeflate. System BZIP2 remains necessary to admit the source
archive. No `make install` or upstream test script runs. The retained passing run used these limits and supplied `make`
from the runner's retained `make.deb`; a fresh run still needs the listed build inputs.

Direct `create.ts --output` expects a new file and writes it with `wx`. The supervised command above instead owns a
fresh output directory and passes its `independent.json` path to the producer. Source cleanup runs on success or
failure; independent cleanup errors preserve the exact primary reason. Native nonzero exits are recorded for deliberate
refusal controls. A timeout, signal or launch error remains a failed qualification, never a successful native refusal.

## Authored truth and native observations

Every expected SAM selection is authored before its native query executes. Complete native `view --no-PG -h` readback
must first match the entire authored SAM input. Then explicit `view --no-PG -h -X BAM INDEX REGION` queries through both
BAI and CSI must match every expected header/record byte, including two distinct identical records. Regions convert the
library's proposed zero-based half-open intervals into Samtools's one-based inclusive syntax explicitly.

The coordinate-sorted case covers two references, equal-coordinate duplicates, a 16 KiB boundary, intervals inside `D`
and `N` spans, zero reference consumption, placed unmapped reads, an unplaced tail, empty matches and a 160,000-base
record. Its packed bases and qualities require multiple BGZF members; this fixture does not invent a measured block
count or reuse a candidate decoder as its geometry oracle. A native `*` query separately checks the unplaced tail;
placed unmapped records remain in their coordinate interval. This control does not implement a public unmapped-tail
operation.

A separate reference of length 1,000,000,000 and record beyond coordinate 2^29 require native CSI success and native BAI
refusal. An out-of-order input requires native index refusal. The producer retains actual CSI `min_shift`, `depth` and
auxiliary extent through a narrow native-gzip header observation; it does not assume all CSI parameter profiles have
been exercised.

Two controls retain observations without inventing universal wrong-index detection:

- A different BAM has the same textual/binary dictionary but omits the large record. Its native BAI is queried against
  the original BAM. The receipt records the native exit, full output and comparison with the original authored truth.
- An explicitly authored BAI contains the native reference count with zero bins/chunks/linear entries. It is labelled
  authored framing, not a native-produced index. Its query output/refusal is retained against the same truth.

Either native response is an observation. Parsing a valid-looking index or checking the visited block CRCs cannot prove
that no relevant chunk was omitted. The eventual API must preserve caller-asserted binding and index-dependent
completeness unless it obtains separate full coverage evidence. Hashes of both inputs identify a pair but do not prove
correct index construction.

## Frozen specification identities

The official GitHub commit endpoint resolved hts-specs to
[`510c107ba89aa13113818c9e4fa3071283cb7f7b`](https://github.com/samtools/hts-specs/commit/510c107ba89aa13113818c9e4fa3071283cb7f7b)
on 2026-11-06. Bounded inert downloads measured these exact raw source bytes:

| Source                                                                                                                                         |  Bytes | SHA-256                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | -----: | ------------------------------------------------------------------ |
| [SAMv1.tex, including the BAI layout](https://raw.githubusercontent.com/samtools/hts-specs/510c107ba89aa13113818c9e4fa3071283cb7f7b/SAMv1.tex) | 92,666 | `5f1326a2298b37e9e6f375456189dfb5646a285dd0adf023c6a9344fd4fbc35a` |
| [CSIv1.tex](https://raw.githubusercontent.com/samtools/hts-specs/510c107ba89aa13113818c9e4fa3071283cb7f7b/CSIv1.tex)                           |  3,791 | `f91a2a7b6c866c2bc6b7ec89919cf52f2adcd48eb8903e11d5415c355350f396` |

The source constants retain commit, extents and hashes. Inert originals and the measured identity receipt are retained
under the task-owned ignored `.tmp/implementation/bai-specs-510c107ba89aa13113818c9e4fa3071283cb7f7b/` directory. They
are research evidence, not executable build inputs. No explicit redistribution grant was located in the inspected root
listing/README, so full normative texts are not copied into the published fixture. These byte identities do not claim
signature verification or that a future URL is trusted without rechecking its bytes. Runtime grammar and native behavior
also use the independently admitted HTSlib 1.25 source. The generated `SAMv1.ver` file was unavailable at this commit;
no identity is claimed for it.

The passing run retained `independent.json` and the supervisor's diagnostics/state. Retain new evidence separately for
any future run. The original includes complete SAM inputs, native BAM/BAI/CSI bytes and hashes, every expected region
selection, actual CSI geometry, refusal/control observations, immutable source/specification identities,
source-inventory hash, native versions and bounded command receipts. The copied corpus preserves the original evidence
SHA-256 `16e8be1e00e9ad13f5c2b0b11488ee163f16491069f3e6bbb907d7c57cd0e99d`. This native producer qualification does not
qualify an OPFS parser or prove universal index pairing, interval completeness or production index support.
