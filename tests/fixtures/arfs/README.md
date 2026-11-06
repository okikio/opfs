# ArFS independent evidence

`produce.cjs.snapshot` is a test-only ArDrive core 5.1.1 and Arweave 1.15.7 producer/consumer recipe. It is not imported
by the library. The tool wallet is ephemeral; private key material is never written to the receipt. Transactions are
locally signed with explicit anchor/reward inputs, checked by the native SDK and **never submitted or funded**. Native
ArFS builders consume the resulting exact metadata bytes through an injected map. No result proves chain inclusion or
production-reader signature verification.

`tool-package.json`, the original npm `tool-lock.json` and `acquire.cjs.snapshot` pin the tool-only dependency graph.
The acquisition runs both npm operations with `--ignore-scripts --no-audit --no-fund`; the validator checks the direct
artifact integrity, URL and version before installation. Transitive package sources and integrity are recorded in the
lock. The tool uses AGPL-3.0-or-later ArDrive core and MIT Arweave as test tooling only; no upstream implementation code
is copied into production or adopted as a production dependency.

The acquisition image is the existing ARM64 Node 22.23.4 image
`sha256:69f266c3ec9d93ce85b5643431560e9eedefb54f252730c84453239c2e68f071`. The resulting test-tool image is
`sha256:d79dbd777b23b5dde0aed682c645c183bacb5f76aa9c5915c258a3ca39455c2d`. Acquisition used 2 GiB, two CPUs and 256
PIDs, and exited zero without OOM. Its stopped writable container was removed after the image was verified. Acquisition
requires network access; the subsequent fixture run must use `--network none` with the same finite resource limits. The
recipe also makes SDK API methods and global Fetch fail if called. **Fixture execution passed** in an offline container
with the same 2 GiB/two CPU/256 PID limits and no OOM. `independent.json` contains five genuine metadata transactions
plus one file-data transaction, native builder and signature verification receipts, authored original bytes and
full/range oracles. All monitored network calls remained zero. The acquisition and producer containers were removed
after successful state/image/fixture verification. The large test-only tool image was then removed to recover host
storage; its recorded SHA is provenance, not a claim that the image remains installed. Reproduction installs the pinned
lock in a fresh disposable tool.

The historical acquisition copied the tool package into a fresh disposable container, admitted direct pins, installed
with lifecycle scripts disabled, then ran the native SDK producer in a separate offline container. Its exact recipe
sources are now inert snapshots. The current TypeScript command below uses the retained package/lock graph and requires
a new output receipt.

`zip.json` preserves independent Python 3.9.6 standard-library ZIP evidence. Its exact producer is now inert
`zip-produce.py.snapshot`; the historical archive and hashes remain unchanged. The package test supplies that image
through an authored ArFS metadata/data binding and reads the selected member. This proves byte-source composition, not
ArFS signature, chain inclusion or network interoperability.

For a new candidate-free native run, use the TypeScript launcher with installed InfoZIP and libarchive:

```sh
node tests/fixtures/arfs/zip-produce.ts --output /tmp/arfs-zip-new.json
```

InfoZIP writes a STORED member and libarchive compares every authored payload byte. This changes the producer profile;
it does not replay the Python ZIP or replace historical evidence. The launcher admits at most 1 MiB of archive bytes,
uses the shared 90-second/16-MiB native command bounds, removes its owned temporary directory, and refuses to overwrite
an existing receipt. These bounds are not a filesystem quota. The new command still needs independent qualification.

`receipt.json` records acquired tool/source hashes. Mutable primary documentation is pinned by immutable upstream
commits in `docs/arfs.md`; the selected public-0.15 profile is deliberately narrower than universal ArFS support.

## Current TypeScript tooling

The executable sources are now `acquire.ts` and `produce.ts`. `*.cjs.snapshot` retains the exact historical source
bytes; `source-map.json` maps those identities without changing old fixture/receipt hashes. Use new output paths;
current producers refuse to overwrite a receipt. The native SDKs, signing and full original-byte checks are retained,
rather than replacing their output with a project encoder or parser.

After the reviewed acquisition has placed the pinned package/lock in a fresh `/tool` directory and admitted it with
`node /tool/acquire.ts`, use the same `npm ci --ignore-scripts --no-audit --no-fund` installation policy. Copy the
selected producer beside those installed dependencies. Its type-only SDK interfaces are erased at runtime; no SDK
implementation is copied into the library. Run in an isolated container with networking disabled and the existing 2
GiB/two CPU/256 PID limits:

```sh
node /tool/produce.ts /tmp/new-arfs-receipt.json
```

Node 22.18 or later strips these erasable TypeScript annotations directly. The producers still replace SDK API methods
and Fetch with throwing monitors, require zero network calls, and never submit/fund a transaction or retain a private
wallet in their output. ArDrive native builders still consume exact metadata through the injected byte gateway and check
names, file sizes, data transaction IDs and dates.

Acquisition validators admit at most 4 MiB of package-lock input. The output receipt limit is 4 MiB and producer inputs
remain the fixed authored case set. The enclosing runner owns time, native memory, process and filesystem quotas; a JSON
byte limit alone does not bound SDK key generation. New random wallets and signatures change receipt hashes. Review new
exit/resource receipts and complete native verification before replacing any historical JSON. A successful local SDK run
still proves neither chain inclusion nor publication.
