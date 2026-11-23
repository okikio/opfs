# Independent Arweave signature and data-root fixtures

These files are test-only. No Arweave SDK is imported by production code, no wallet private key is retained, and no
transaction was posted, funded or confirmed. The native signer supplies interoperability evidence for the selected
cryptographic and chunk-writer profiles; it does not supply chain-inclusion evidence.

`pss32.json` contains 11 original payloads with lengths 0, 1, 32767, 32768, 262143, 262144, 262145, 294911, 524288,
524289 and 1048577. Each original byte is `(index * 131 + 17) % 251`. The fixture retains full signed transaction JSON
with those bytes, complete SHA-256 oracles, exact native signing payloads, chunk hashes/boundaries and upload proofs.
Original bytes are authored independently of the candidate. Empty data has an empty root and no native upload
chunks/proofs. Exact multiples of 256 KiB retain a terminal empty tree leaf in the root, although prepared upload
chunk/proof records omit that empty leaf. The candidate checks complete roots, not these upload proof paths.

The last vector includes binary tag name `ff00` and value `c0af00fe`. The Unicode tag has raw value `65cc81`: lowercase
e plus combining U+0301, without normalization. Tag pair order is retained. `pss32.json` also contains three authored
public ArFS 0.15 drive/root/file metadata records signed by the native SDK. The file points to the size 1 native
payload. This proves signed-byte composition through the ArFS reader; it is not an independent native ArDrive builder
proof.

## A retained signer-profile mismatch

`independent.json` is the first genuine producer run under Node 22.23.4. Default ArweaveJS 1.15.7 Node signing produced
RSA-PSS with a 478-byte salt. Its native SDK verification succeeded. The candidate's reconstructed deep-hash signing
bytes exactly matched the native `signatureDataBase64`; direct native WebCrypto verification succeeded with 478 and
failed with 32. The selected `rsa4096-pss32-v2` profile therefore correctly refuses those transactions. Tests retain
this mismatch as refusal evidence. They do not treat successful SDK verification as proof of the selected salt length.

`produce-pss32.cjs.snapshot` explicitly passes `{ saltLength: 32 }` to SDK signing and independently checks each main
vector with Node's built-in `crypto.verify` using RSA-PSS/SHA-256/salt 32. It ran under Node 26.13.0 on an existing
parent-verified ARM64 tools image. This is independent native fixture evidence, not a Node 22 runtime certification. The
original `produce.cjs.snapshot` preserves the original default-salt mismatch recipe as inert data. No profile
interpretation was silently changed, and the first producer bytes were not overwritten.

## Historical acquisition and execution

`tool-package.json` pins the sole direct test dependency, ArweaveJS 1.15.7. `tool-lock.json` and `tool-lock-pss32.json`
independently resolved to the same lock SHA-256. `acquire.cjs.snapshot` checks the direct package's exact registry
artifact URL, version and SHA-512 integrity before `npm ci --ignore-scripts --no-audit --no-fund`. SDK source is pinned
to commit 695dafc5d3bcd15aa52068e8a79b56b31d4ee262. The native node signing/transaction grammar sources are pinned
separately in `primary.json`, with source-byte SHA-256 receipts.

The historical reviewed recipe created a fresh `/tool` directory, installs only that package/lock graph, copies the
selected producer beside its dependencies, then runs it in a separate container with
`--network none --memory 2g --cpus 2
--pids-limit 256`. Its exact producer sources are now inert
`produce-pss32.cjs.snapshot` and `produce.cjs.snapshot`; the executable TypeScript replacement commands appear below.
SDK API methods and global Fetch are replaced by throwing monitors, and the receipt asserts zero calls. Output is copied
only after exit 0 with no OOM. The producer never imports candidate source. RSA key generation is random, so signatures,
owner IDs and JSON digests vary across reproductions; original payload bytes, native writer roots, verified salt profile
and byte comparison results remain reproducible.

The first explicit 32 acquisition attempt could not create its container because the old base image had been removed. No
acquisition ran. The parent approved an already-present pinned image instead; `receipt.json` records both exact base
images and the failed attempt. Both successful producers exited 0 without OOM. Only task-owned stopped containers and
temporary SDK images were removed after preserving source, locks, fixture bytes, hashes and state receipts. The base
images were not removed by this task. The temporary SDK tools images are no longer local.

`receipt.json` distinguishes exact raw producer JSON hashes from formatted repository-file hashes. Source recipe hashes
identify their current repository formatting; the initial pre-format original recipe hash was not captured. The JSON
fixture bytes were captured before formatting and their exact raw hashes remain recorded. These receipts establish which
bytes were checked, not provenance of real-world publishers.

## Current TypeScript tooling

The executable sources are now `acquire.ts` and `produce.ts` plus `produce-pss32.ts`. `*.cjs.snapshot` retains the exact
historical source bytes; `source-map.json` maps those identities without changing old fixture/receipt hashes. Use new
output paths; current producers refuse to overwrite a receipt. The native SDKs, signing and full original-byte checks
are retained, rather than replacing their output with a project encoder or parser.

After the reviewed acquisition has placed the pinned package/lock in a fresh `/tool` directory and admitted it with
`node /tool/acquire.ts`, use the same `npm ci --ignore-scripts --no-audit --no-fund` installation policy. Copy the
selected producer beside those installed dependencies. Its type-only SDK interfaces are erased at runtime; no SDK
implementation is copied into the library. Run in an isolated container with networking disabled and the existing 2
GiB/two CPU/256 PID limits:

```sh
node /tool/produce-pss32.ts /tmp/new-arweave-receipt.json
```

Node 22.18 or later strips these erasable TypeScript annotations directly. The producers still replace SDK API methods
and Fetch with throwing monitors, require zero network calls, and never submit/fund a transaction or retain a private
wallet in their output. `produce.ts` retains the default-salt profile, while `produce-pss32.ts` retains explicit salt
length 32 and separate Node crypto verification. Neither profile is silently substituted for the other.

Acquisition validators admit at most 4 MiB of package-lock input. The output receipt limit is 32 MiB and producer inputs
remain the fixed authored case set. The enclosing runner owns time, native memory, process and filesystem quotas; a JSON
byte limit alone does not bound SDK key generation. New random wallets and signatures change receipt hashes. Review new
exit/resource receipts and complete native verification before replacing any historical JSON. A successful local SDK run
still proves neither chain inclusion nor publication.
