# Create native ZipCrypto fixtures

`create.ts` asks 7-Zip to produce ZipCrypto STORED and DEFLATE archives, then uses the different InfoZIP unzip
implementation to decrypt every original file byte. An InfoZIP zip stdin producer creates the descriptor profile; 7-Zip
independently decrypts that member. Passwords are public ASCII test data, not secrets. No candidate ZIP reader or
password implementation is imported.

Run from the repository root in a disposable runner with reviewed 7zip, InfoZIP zip and InfoZIP unzip executables:

```sh
deno run --allow-read --allow-write --allow-env --allow-run tests/fixtures/password/create.ts \
  --seven /usr/bin/7zz --zip /usr/bin/zip --unzip /usr/bin/unzip --output /tmp/password-new.json
```

Every command has a 20-second deadline and a 4 MiB captured-output budget. Original files and archives stay within one
owned temporary directory, removed in `finally`. Consumer payloads return through stdout. The 7-Zip stdin attempt is
retained as a diagnostic before the separate InfoZIP descriptor producer runs; its failure is not counted as evidence
for an unsupported route.

Archive size is checked against 1 MiB before materialization. `--output` must name a new file; exclusive creation
refuses to overwrite existing evidence. Deadlines kill the direct child with SIGKILL. These limits do not impose a
filesystem quota.

A small authored central-directory inspection retains encrypted/descriptor flags and validates the expected name set. It
is not an independently supplied ZIP parser. In particular, the InfoZIP stdin profile can include ZIP64 end records even
for a small input. Native consumers establish format acceptance and full-payload decryption separately.

The new TypeScript producer has not yet run. Existing `independent.json` and `provenance.json` describe the previous
native archives checked by Python zipfile. Its exact executed producer remains inert `create.py.snapshot`; old paths and
hashes keep their original identity. The reciprocal native consumer profile is a change and requires a new qualification
with source/tool hashes, actual outcomes, complete bytes and output hashes. Do not reattribute old fixtures. Random
encryption headers mean a new run need not produce identical archive bytes.
