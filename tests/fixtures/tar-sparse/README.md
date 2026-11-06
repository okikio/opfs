# Create independent GNU sparse TAR fixtures

`create.ts` writes the original logical files through native positional writes and truncation, then asks GNU tar to
create PAX sparse versions 1.0, 0.1 and 0.0. It captures each original logical byte image before archiving. GNU tar's
stdout extraction and libarchive's separate extraction must both match every byte. 7zz status, byte equality and output
hash remain separate diagnostics; a zero exit code alone does not establish sparse reconstruction.

Run from the repository root in a disposable runner with reviewed GNU tar, libarchive and 7zip tools:

```sh
deno run --allow-read --allow-write --allow-env --allow-run tests/fixtures/tar-sparse/create.ts \
  --tar /usr/bin/tar --bsdtar /usr/bin/bsdtar --seven /usr/bin/7zz --output /tmp/tar-sparse-new.json
```

Each native command has a 60-second deadline and an 8 MiB captured-output budget. Archive materialization is limited to
16 MiB. The tool owns and removes its temporary tree. Hole detection depends on the runner filesystem, so a new run must
inspect its actual sparse maps rather than assuming the same physical layout as a prior run. `--output` must name a new
file; exclusive creation refuses to overwrite existing evidence. Deadlines kill the direct child with SIGKILL. These
limits do not impose a filesystem quota.

The TypeScript producer has not yet run. The committed `independent.json` and `provenance.json` remain the old GNU tar
run, whose independent consumers were Python tarfile and libarchive. Its exact producer is inert `create.py.snapshot`;
old receipt paths and hashes retain its original name. The new port replaces Python consumption with GNU tar, while
retaining the separate libarchive implementation. It is a changed consumer profile, not a replay of the old proof. Keep
new output separate until a bounded native run records its source and tool hashes, full comparisons and sparse map
observations. No historical fixture or receipt has been rewritten.
