# Create independent ar fixtures

`create.ts` asks GNU ar to write the GNU profile and LLVM ar to write the BSD profile. It extracts each archive with the
other implementation and compares every extracted payload with its original input. A separate unfiltered bsdtar
extraction retains its diagnostic even when it fails; that failure is not counted as successful payload verification. No
candidate OPFS implementation is imported.

Run from the repository root in a disposable Linux runner with reviewed GNU binutils, LLVM and libarchive tools:

```sh
deno run --allow-read --allow-write --allow-env --allow-run tests/fixtures/ar/create.ts \
  --gnu /usr/bin/ar --llvm /usr/bin/llvm-ar --bsdtar /usr/bin/bsdtar --output /tmp/ar-new.json
```

The `--output` option is required and must name a new file. Exclusive creation refuses to overwrite existing evidence.
Deadlines kill the direct child with SIGKILL. Regular files are checked against 16 MiB before materialization; these
read limits do not impose a filesystem quota.

The tool owns and removes its temporary tree. Each native process has a 20-second deadline and an 8 MiB captured-output
budget. The fixture includes empty and binary payloads, long and Unicode names, and a nested control TAR wrapped with
built-in gzip. The TypeScript producer uses native bsdtar for that USTAR image. The historical producer used Python's
standard TAR/gzip modules, so the port does not promise identical nested archive bytes. Its exact output must receive a
new receipt and payload qualification.

The committed `independent.json` and `provenance.json` still describe the previously executed producer. Its exact bytes
are retained as inert `create.py.snapshot`; the receipt's `create.py` key records its original filename. The new
TypeScript producer has not yet run. Do not attribute old fixtures to it or replace their hashes without a separately
recorded native run and full comparisons.
