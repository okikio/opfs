# Create independent LHA fixtures

`create.ts` asks JLHA to write stored LHA archives at header levels 0, 1 and 2. JLHA, Lhasa, 7zip and libarchive each
extract them into separate directories. The tool checks the exact extracted filename set and every payload byte against
the authored originals. It refuses symbolic links or special files in extractor output. No candidate OPFS reader
participates in this proof.

Run from the repository root in a disposable Debian runner with reviewed `jlha-utils`, `libjlha-java`, `lhasa`, `7zip`,
`libarchive-tools` and `default-jre-headless` packages:

```sh
deno run --allow-read --allow-write --allow-env --allow-run tests/fixtures/lha/create.ts \
  --producer /usr/bin/jlha --lhasa /usr/bin/lhasa --seven /usr/bin/7zz \
  --bsdtar /usr/bin/bsdtar --output /tmp/lha-new.json
```

The `--output` option is required and must name a new file. Exclusive creation refuses to overwrite existing evidence.
Deadlines kill the direct child with SIGKILL. Regular files are checked against 16 MiB before materialization; these
read limits do not impose a filesystem quota.

The producer records installed Debian package versions and its own source hash. It owns and removes its temporary tree.
Each native command has a 20-second deadline and an 8 MiB captured-output budget. The level-0 input uses a shorter name
because this JLHA writer's 100-byte header budget is narrower than the format. That adaptation is retained for the port;
it does not imply that every LHA writer has this limit.

The committed `independent.json` and `provenance.json` retain the previous native run. Their original executed producer
is byte-for-byte inert `create.py.snapshot`; old `create.py` paths and hashes identify that historical file. The new
TypeScript producer has not yet run. Keep a new output separate until a bounded native qualification records exact
tools, source and output hashes, successful consumers and full comparisons. Do not change the old receipt to make it
appear that TypeScript created existing archives.
