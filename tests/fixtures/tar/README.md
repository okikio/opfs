# Create native PAX and GNU TAR fixtures

`create.ts` creates long Unicode/POSIX-PAX names, GNU long names and long symbolic-link targets with an installed GNU
tar writer. Independent libarchive extraction checks every original file byte and the symbolic-link target. Expected
payloads come from authored input files, never an OPFS reader. The tool owns and removes its temporary tree.

Run from the repository root in a disposable runner with reviewed GNU tar and libarchive tools:

```sh
deno run --allow-read --allow-write --allow-env --allow-run tests/fixtures/tar/create.ts \
  --tar /usr/bin/tar --bsdtar /usr/bin/bsdtar --output /tmp/tar-native-new.json
```

Each command has a 30-second deadline and a 4 MiB captured-output budget. Names and file timestamps are authored, but
native PAX metadata can still vary by writer and environment. Compare semantic payloads and record actual output hashes;
this command does not promise identical archive bytes across hosts. Archive size is checked against 1 MiB before
extraction or materialization. `--output` must name a new file; exclusive creation refuses to overwrite existing
evidence. Deadlines kill the direct child with SIGKILL. These limits do not impose a filesystem quota.

The existing `independent.json` was produced by Python's standard tarfile module. Its exact producer remains inert
`create.py.snapshot`. That fixture includes a global PAX `path=global.txt` override that renames a later member. The new
native producer intentionally describes a different profile: it preserves the ordinary `short.txt` path and does not
claim the historical global override. Old fixture bytes and their expected metadata remain unchanged for existing
regression tests. The former inline Python consumer test is also retained as inert `consumer.test.ts.snapshot`.

The TypeScript producer has not yet run. Qualify its new native output with source and tool hashes, commands, full
comparisons and the observed profile before adding it to tests. Do not replace the historical JSON with a new profile
under the old producer attribution.
