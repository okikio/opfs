# Create independent RAR5 fixtures

`create.ts` invokes an explicitly supplied vendor RAR executable. It never downloads, installs or redistributes that
executable. You must provide a separately reviewed tool and satisfy its licensing terms. This producer is not a CI
dependency and does not restore the previous task's one-time trial authorization.

Run from the repository root in an owned disposable runner with the native consumers available. Replace the example
absolute paths with the actual reviewed executables:

```sh
deno run --allow-read --allow-write --allow-env --allow-run tests/fixtures/rar/create.ts \
  --rar /opt/reviewed/rar --seven /opt/reviewed/7zz --tar /usr/bin/tar --output /tmp/rar-new.json
```

The `--output` option is required and must name a new file. Exclusive creation refuses to overwrite existing evidence.
Deadlines kill the direct child with SIGKILL. Regular files are checked against 16 MiB before materialization; these
read limits do not impose a filesystem quota.

The tool records the vendor binary hash and native version diagnostics. It creates authored empty, Unicode and binary
inputs, then compares every stored and quick-open payload through forced 7zz RAR5 reads and libarchive extraction.
Extracted Unicode filenames receive an explicit NFC lookup mapping; wire names remain unchanged. Compressed, solid,
encrypted, volume and symbolic-link profiles remain inert refusal controls, without successful payload or decryption
claims. Public passwords are test inputs. The tool owns and removes all temporary files. Each native command has a
60-second deadline and an 8 MiB captured-output budget; the help probe has a 10-second deadline.

The current TypeScript port has not yet executed. Existing `independent.json` and `provenance.json` still describe the
earlier native invocation. Its exact producer bytes remain inert `create.py.snapshot`, while the receipt keeps its
original `create.py` path and hash. Do not attribute those historical outputs to the port. Record a new source hash,
exact executables, commands, outputs and full comparisons in a separate qualification before changing any fixture.
