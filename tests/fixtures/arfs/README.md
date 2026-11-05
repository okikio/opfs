# ArFS independent evidence

`produce.cjs` is a test-only ArDrive core 5.1.1 and Arweave 1.15.7 producer/consumer recipe. It is not imported by the
library. The tool wallet is ephemeral; private key material is never written to the receipt. Transactions are locally
signed with explicit anchor/reward inputs, checked by the native SDK and **never submitted or funded**. Native ArFS
builders consume the resulting exact metadata bytes through an injected map. No result proves chain inclusion or
production-reader signature verification.

`tool-package.json`, the original npm `tool-lock.json` and `acquire.cjs` pin the tool-only dependency graph. The
acquisition runs both npm operations with `--ignore-scripts --no-audit --no-fund`; the validator checks the direct
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

To reproduce in an explicitly authorized disposable container, copy `tool-package.json` to `/tool/package.json`, create
the original lock using `npm install --package-lock-only --ignore-scripts --no-audit --no-fund`, run `acquire.cjs`, then
run `npm ci --ignore-scripts --no-audit --no-fund`. For an exact existing graph, copy `tool-lock.json` to
`/tool/package-lock.json` and use `npm ci` directly after checking direct pins. Snapshot the successful tool and run
`node /tool/produce.cjs /tmp/arfs-independent.json` with networking disabled. Copy the JSON only after zero exit,
retaining the command, image, resource, source/lock hashes, stderr/stdout and any failures. Do not retain wallet keys.

`zip.json` is separate independent Python 3.9.6 standard-library `zipfile` evidence. `zip-produce.py` writes a stored
`preview.txt` member with fixed metadata, then the independent Python consumer reads and compares the full authored
original bytes. `tests/arfs.test.ts` supplies that archive through an authored ArFS metadata/data binding and reads the
selected member with the package ZIP reader. This proves byte-source composition, not native ArFS signature or network
interoperability. The exact ZIP byte hash and original bytes are in the fixture; regeneration uses only Python's
standard library:

```sh
python3 tests/fixtures/arfs/zip-produce.py tests/fixtures/arfs/zip.json
```

`receipt.json` records acquired tool/source hashes. Mutable primary documentation is pinned by immutable upstream
commits in `docs/arfs.md`; the selected public-0.15 profile is deliberately narrower than universal ArFS support.
