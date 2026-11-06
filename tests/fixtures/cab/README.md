# Produce independent CAB controls

These programs prepare fixture evidence without importing `@okikio/opfs`. Use an isolated fixture environment with the
selected native executables already available. Each command requires a new output JSON path and refuses to overwrite an
existing file. Ordinary tests read the committed JSON and do not run these programs.

```sh
node tests/fixtures/cab/create.ts --gcab /usr/bin/gcab --cabextract /usr/bin/cabextract --output /tmp/new-cab.json
node tests/fixtures/cab/vectors.ts --cabextract /usr/bin/cabextract --output /tmp/new-cab-vectors.json
node tests/fixtures/cab/mszip.ts --seven /usr/bin/7zz --output /tmp/new-cab-mszip.json
```

`create.ts` asks gcab to produce stored and MSZIP cabinets, then asks cabextract to consume every original file.
`vectors.ts` instead constructs the cabinet framing itself to exercise CAB's unusual remainder-byte checksum
calculation. It requires four ordinary payloads to pass cabextract and records all 24 reserved-area outcomes separately.
A reserved-area failure is diagnostic evidence, not an accepted payload profile.

`mszip.ts` requires Node 26.5 or later. Its built-in zlib compressor receives the last 32 KiB of preceding plain bytes
as a dictionary. It uses `memLevel: 9` to avoid the default smaller pending-buffer split for a 32 KiB high-entropy unit.
Every resulting CK-prefixed unit must still fit CAB's 32,780-byte limit; the script refuses larger units rather than
changing that format bound. The matching native decoder checks every complete original, and the script also attempts
decoding without that dictionary to establish which packed units depend on history. It rejects truncated and extra
compressed input before accepting the comparison. The
[Node zlib options](https://nodejs.org/download/release/v26.13.0/docs/api/zlib.html#class-options) document
`dictionary`, `maxOutputLength` and `rejectGarbageAfterEnd`; the last option is why this test-only producer requires the
newer Node version.

The producer then frames those compressed units as cabinets and asks 7zz to read each complete payload. Dynamic,
fixed-Huffman, stored and overlapping-copy profiles must pass with exact original bytes. The short-history profile must
retain a normally exited native refusal. Failure to start 7zz, a signal or a watchdog timeout cannot count as that
refusal. If a later 7zz accepts this profile, the producer stops so the changed native observation can be reviewed.

The TypeScript MSZIP source uses an authored xorshift32 pattern with seed 20519 and shifts 13, 17 and 5. This is a
reproducible fixture pattern, not security randomness or an emulation of CPython's PRNG. Its newly produced archive
bytes can differ from `mszip.json`. Keep any new run as separate evidence until its complete outputs, native results and
resource receipts have been reviewed.

`*.py.snapshot` preserves the exact historical source. `source-map.json` maps the checksum and MSZIP producer paths to
their snapshots and new TypeScript sources without changing old execution records. The existing `independent.json`,
`vectors.json`, `mszip.json` and provenance remain unchanged. The TypeScript ports have not produced those historical
hashes or replaced the native evidence described in [mszip.md](mszip.md).

Native calls run serially. Checksum controls allow fifteen seconds and 1 MiB per pipe per cabextract call, with a
five-minute overall command admission deadline. MSZIP controls allow twenty seconds and 8 MiB per pipe per 7zz call,
within a two-minute command admission deadline. Each producer owns a fresh temporary directory and removes only that
directory. The checksum and MSZIP controls retain both workload and cleanup failures if both occur. Container memory,
CPU and mount limits belong to the independent runner, not to these subprocess watchdogs.
