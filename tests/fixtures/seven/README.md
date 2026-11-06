# Create independent 7-Zip fixtures

`create.ts` asks installed 7zz to write COPY, LZMA1, LZMA2, solid, encoded-header and encrypted profiles. Libarchive
extracts the nonencrypted profiles, and every expected payload is compared with its original input. Encrypted consumer
failure remains diagnostic evidence only. No candidate OPFS implementation produces or checks these expectations.

Run from the repository root in a disposable runner with reviewed `7zip` and `libarchive-tools` packages:

```sh
deno run --allow-read --allow-write --allow-env --allow-run tests/fixtures/seven/create.ts \
  --seven /usr/bin/7zz --bsdtar /usr/bin/bsdtar --output /tmp/seven-new.json
```

The `--output` option is required and must name a new file. Exclusive creation refuses to overwrite existing evidence.
Deadlines kill the direct child with SIGKILL. Regular files are checked against 16 MiB before materialization; these
read limits do not impose a filesystem quota.

The producer owns and removes its temporary tree. Each native command has a 20-second deadline and an 8 MiB
captured-output budget. The JSON keeps tool versions, commands, consumer status, complete archive bytes and digests,
expected entry bytes, and the native next-header tag. Passwords are public test data. Full extraction of a native
fixture does not imply that the OPFS reader supports every profile or provides decryption.

The TypeScript port has not yet run. The committed `independent.json` and `provenance.json` retain the previous native
run and its original `create.py` identity. That producer is preserved byte-for-byte as inert `create.py.snapshot`. Keep
a new output separate until a bounded native run records the port's source hash, exact tools, process outcomes, output
hashes and full byte comparisons. Do not edit the old receipt to attribute existing archives to the new source.
