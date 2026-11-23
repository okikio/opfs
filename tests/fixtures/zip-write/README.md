# Check streamed ZIP output with an independent native consumer

`produce.ts` writes the authored four-entry workload through the candidate ZIP writer. `verify.ts` consumes its binary
stdin and checks it with native 7-Zip. The native parser must accept the archive's integrity test and return every
original file byte. Expected names, order and payloads are authored in the verifier, not derived from candidate output.

The verifier also implements separate, deliberately narrow framing checks using Node built-ins. Those checks assert
STORED method, UTF-8/data-descriptor flags, DOS epoch timestamps, exact central/local extents, full original payloads,
CRC32 and signed descriptor fields. This is an authored workload checker, not another independently supplied ZIP parser.
The native 7-Zip acceptance and extraction remain distinct evidence.

Run `deno task test:archive:interop` on the configured Node/Deno Linux runner with 7zz installed. The process test first
captures and checks the producer's exit, then supplies its bytes to the verifier. It does not use a shell pipe that
could hide a producer failure. To check an already captured output separately:

```sh
node tests/fixtures/zip-write/verify.ts --seven /usr/bin/7zz < /tmp/opfs-writer.zip
```

Input is limited to 1 MiB. Each native command has a 10-second deadline and a 64 KiB captured-output budget. The
verifier writes the admitted image to one owned temporary directory and removes that directory in `finally`. Native file
extraction returns selected authored members to stdout, not to host paths. A successful JSON receipt distinguishes the
native consumer and authored framing checks.

The previous executed CPython zipfile consumer is retained byte-for-byte as inert `verify.py.snapshot`. Its historical
acceptance remains evidence for the prior run, not proof that the new verifier has executed. The TypeScript verifier and
new process-test route have not yet run. A new bounded qualification must record its source hash, exact 7-Zip version,
process outcome and complete comparisons. No historical receipt has been reattributed.
