# Native ORC originals

`independent.json` contains eighteen genuine uncompressed ORC files written and read by Apache C++ ORC through PyArrow
20.0.0 on Python 3.13.12, Linux ARM64. `create.py` authored fixed original arrays without importing the TypeScript
candidate. Each file retains its original wire, every physical little-endian column, separate null masks, and SHA-256
digests. The native readback checks all values before the fixture is accepted.

Versions 0.11 and 0.12 each cover 0, 37 and 8192 rows with nonnullable, mixed-null and all-null columns. The seven
physical types are BOOLEAN, BYTE, SHORT, INT, LONG, FLOAT and DOUBLE. Cases include signed endpoints, integers beyond
exact JavaScript number range, NaN, infinity and signed zero. Modern 0.12 SHORT/INT/LONG use DIRECT_V2 and are refusal
controls; they do not imply RLEv2 support.

The 8192-row nonnullable and mixed-null files have 32 native stripes; all-null files have seven. Selected
supported-column rows 253 through 259 cross two stripes in the nonnullable and mixed-null cases. Empty selection must
acquire no body. Tests compare complete original values and masks as well as selected output. Float comparisons use
numeric semantics, including NaN and signed zero, without requiring a NaN payload bit pattern.

The writer and reader share one native C++ ORC implementation. These files establish native-wire interoperability
against our separate TypeScript decoder, not agreement between two independent native engines. All emitted files use
body-only `contentLength`; the alternate header-and-body equation has a separate authored grammar control.

[provenance.json](provenance.json) records exact primary-source pins, the admitted wheel, execution receipts, original
notice locations and the raw JSON digest. The raw JSON is 3,547,744 bytes with SHA-256
`8b0661e99078a2815232ff518f4bc41bf78e7c4d9cd83ee58f29cc4eeb0edcf6`. If presentation formatting later changes JSON
whitespace, retain that raw digest separately and verify that every embedded original blob and parsed value stays
unchanged. The [recipe](RECIPE.md) explains bounded offline reproduction and keeps installation separate from native
engine execution.

The first installation attempt could not write diagnostics into copied host-owned input files under the container's
dropped capabilities. Its original failure and diagnostic remain in `receipts/`. The successful revision writes only to
container-owned `/tmp/orc-install`; it does not add capabilities or change the admitted wheel. Benchmark source is
separate from these native proofs and has not produced a timing result.
