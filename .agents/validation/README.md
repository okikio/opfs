# Retain isolated validation source without repeated full snapshots

This is agent-owned tooling for the maintainer resuming OPFS expansion. It does not import candidate production code on
the host and is excluded from package exports and JSR publication. Activate the repository's Mise-pinned Node/Deno
tools, then run tasks from the OPFS root.

```sh
# Capture and verify current tracked + nonignored untracked source. No Docker/test run.
node .agents/validation/run.ts --snapshot-only

# Existing isolated runtime workflow, with retention before container creation.
node .agents/validation/run.ts --runtime deno test --no-check tests/request.test.ts

# Every run prints a receipt containing snapshotManifest and writes source-snapshot.json.
node .agents/validation/snapshot.ts verify .tmp/implementation/source-snapshots/manifests/HASH.json
node .agents/validation/snapshot.ts restore .tmp/implementation/source-snapshots/manifests/HASH.json /private/tmp/opfs-recovered.tar
tar -tf /private/tmp/opfs-recovered.tar
```

Replace `HASH` with the exact SHA-256 from the run receipt. Restore creates a new tar file and refuses an existing
output. Inspect or extract into a separate new directory; never unpack a historical snapshot over paused work.

## What is retained

`run.ts` still includes tracked and nonignored untracked regular files, including unique unfinished source.
Dependencies, `.tmp` and `.agents` are excluded from candidate snapshots. Native tar headers, payloads, padding and
trailing bytes are retained exactly. `snapshot.ts` stores SHA-256-addressed gzip segments under
`.tmp/implementation/source-snapshots/objects/`; ordered JSON manifests under `manifests/` reconstruct each exact tar.
Headers and file payloads are separated, so unchanged files share content even when preceding files change tar offsets.

Objects are synced and verified; a complete reconstructed tar must match its source hash before a manifest is published.
The run-to-manifest reference is synced in its UUID run directory before retirement. Only after retained data and the
owned raw tar both match does the controller remove its temporary source.tar. Success, test failure and normal
controller errors follow this same source retention rule. Interrupted runs may leave a raw tar or partial objects; these
are retained, not guessed disposable. `source-retention-only` receipts do not claim a runtime test pass. A raw tar is
exclusively owned by its UUID run; external tools must not replace it while capture/retirement is in progress.

## Storage policy and failure recovery

Defaults reserve **5 GiB** of available host disk and cap this source store at **512 MiB** of compressed
objects/manifests. Before creating a tar, the controller also estimates source + header cost and, for container runs,
reserves **1 GiB** for evidence. Actual object/manifest writes recheck reserve and quota. Capture segments/inflation are
bounded to 4 MiB and manifests to 131,072 segments. The native tar framer accepts checked octal headers and refuses
unsupported numeric formats; any failure keeps the raw source instead of risking recovery.

The evidence amount is an **estimate**, not a byte limit on Docker evidence copy. This change bounds source snapshot
growth, not every external provider artifact. Container evidence-copy/cleanup outcomes remain separately recorded. A
source receipt is not proof that a container fixture completed or all generated evidence was copied. No historical
recovery archive, source version, chat or test receipt is automatically deleted, and there is no age-based garbage
collector.

When quota/reserve refuses admission, the command exits unsuccessfully and records the error; it never deletes unique
work to continue. Export/verify the store or reclaim unrelated caches before explicitly raising policy. Optional
`OPFS_SNAPSHOT_RESERVE_BYTES` and `OPFS_SNAPSHOT_MAX_BYTES` are nonnegative safe integer byte overrides (quota must be
positive), recorded in each receipt. New stores retain all distinct admitted states until the quota stops growth. Keep
**the whole source-snapshots directory**, not just its small manifests.

A `.lock` file serializes writers. If a process is killed, inspect the PID and started time in that file and verify no
controller is still using the store before manually removing a stale lock. The tool never steals another writer's lock.
Failed writes may leave owned crash remnants; it does not automatically prune objects or `.pending`/`.verify` files,
because interrupted work deserves inspection. Corrupt or missing objects block verification and raw retirement.
Restoring never executes source. Actual power-loss durability and hostile external mutation are not certified by the
tests.

## Existing paused recovery material and compatibility

The 154 historical snapshots archived on 18 November remain unchanged in `.tmp/recovery/storage-20261118/`; use
`.tmp/STORAGE-RECOVERY.md` and its Python restore helper for those ZIP records. The new store has a different, explicit
format and does not migrate or prune them. The old local `.tmp/implementation/validate-typescript.ts` command forwards
to this versioned controller so paused command recipes continue to work. Its original bytes are backed up with the 19
November fix receipts.

## Checks

`mise run test:validation` runs finite native-tar/filesystem/gzip regressions with `--no-check` and a 192 MiB heap. It
checks exact restoration (including unfinished source and multi-segment files), cross-version sharing, idempotence,
corruption, changed raw data, disk/quota refusal, exclusive restoration and writer locking. It does not start Docker or
run candidate code. Keep typechecking and aggregate gates in the project's separate isolated budgeted runner.
