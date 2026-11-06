# Create independent CPIO fixtures

`create.ts` writes authored binary input files, then asks an installed native `cpio` to create newc or CRC archives.
Expected member bytes come from those input files. The tool imports no OPFS implementation. It owns and removes its
temporary directory, including hard links and a symbolic link used to exercise the archive profile.

Run from the repository root in a disposable Linux runner with the reviewed GNU cpio package installed. Choose a new
output path so a new producer run cannot silently replace committed evidence:

```sh
deno run --allow-read --allow-write --allow-env --allow-run tests/fixtures/cpio/create.ts \
  --cpio /usr/bin/cpio --formats newc crc --output /tmp/cpio-new.json
```

The `--output` option is required and must name a new file. Exclusive creation refuses to overwrite existing evidence.
Deadlines kill the direct child with SIGKILL. Regular files are checked against 16 MiB before materialization; these
read limits do not impose a filesystem quota.

GNU cpio supports both profiles; a writer that supports only newc can use `--formats newc`. Each command has a 10-second
deadline and a 4 MiB captured-output budget. The JSON retains the writer version, command, archive bytes, digest and
every expected entry. Filesystem inode/device identifiers and symbolic-link times can change archive bytes between runs,
even when the original payloads stay the same.

The committed `gnu.json`, `independent.json` and `provenance.json` remain historical evidence. Their executed Python
producer is retained byte-for-byte as inert `create.py.snapshot`; old receipt paths identify its original name. Do not
execute that snapshot or rewrite its receipts to attribute those archives to TypeScript. The new TypeScript producer has
not yet been executed against the native writer. A future qualification must record its own source hash, exact tools,
exit status, output hashes and full payload comparisons before replacing or adding fixtures.
