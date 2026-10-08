---
"@okikio/opfs": patch
---

Maintainer Linux and mounted-provider tasks now copy immutable inputs into their disposable containers rather than
binding the maintained Git checkout. Keep using the same commands:

```sh
deno task test:linux
deno task test:filesystem-clients
```

Nested Docker mounts can expose a different owner for the checkout root while retaining the `.git` directory's owner.
This made real release preparation fail Git's repository-ownership checks after otherwise successful Linux tests.
Matching inner UIDs did not repair that daemon behavior. The new admission path consults Git only in the outer checkout
and transfers an independently owned archive. It does not configure Git trust exceptions, thaw source or change the
checkout owner.

The archive contains the complete admitted source, installed dependencies and, for Linux, the manual Deno cache.
Contained dependency aliases are rebased inside the copy; escaped aliases reject. Package-manager hardlinks remain valid
inputs, but copied files never share physical hardlink storage. Exact path, kind, mode, bytes and alias guards run
before and after workloads. Linux tests run as ordinary UID/GID 1000 against root-owned read-only inputs. FUSE retains
privilege only inside its private client and freezes its copied tree with an internal read-only mount.

The five Linux lanes, FUSE correctness oracles and benchmark workloads retain their behavior. Copies and hashes add
setup work and temporary-disk use, which reports distinguish from timed library operations. New reports retain archive,
worker and actual image identities under `.tmp/reports/linux/` and `.tmp/reports/fuse/`; a source mismatch or cleanup
failure refuses success. Library APIs and consumer runtime requirements are unchanged.

Windows host modes and UID/GID observations remain unknown rather than being presented as POSIX protection. Binary
copying, archive header/alias controls, installed dependency retention and cancellation run on all hosts; host POSIX
mode and link-privilege controls are explicit. Private Linux admission always checks bytes, kinds, links and ownership
before establishing declared read-only modes. Directory aliases use contained owned junctions on Windows; file aliases
require Developer Mode or symlink privilege and otherwise report that requirement. Portable streaming tar headers use
the already locked Testcontainers archiver dependency, so the tasks no longer require the host's `env` or `tar` command.

Private host staging now stays owner-writable, while the Linux archive still declares and enforces read-only modes.
Disposal checks the acquired canonical root and observable root/ancestor identity before native recursive removal; it
never chmods or traverses substituted borrowed roots. A replacement refuses cleanup and retains the failure. Descendant
aliases are unlinked without acquiring their outside targets. Repeated close calls retain the same promise.

Windows Bun staging now uses the native canonical-path API for roots, ancestors and contained aliases. Its promise API
could report a volume root as `C:` instead of the absolute `C:\`, so valid private-directory acquisition failed before
copying began. The tasks now require absolute native results throughout admission. They retain ancestor identity checks,
exact file kinds and bytes, contained aliases and guarded cleanup; no drive-root exception or Windows test skip is
added. A volume-root behavioral control runs on every host. Existing maintainer commands and library APIs are unchanged.

Runtime identity is observed by a copied native shell supervisor after the actual Node, Bun or Deno process starts and
before its worker imports library behavior. The worker publishes its PID and nonce in a private physical gate; the
supervisor binds that readiness to its launched child, live parent and process starttime. It records raw proc status and
NUL-preserving launch/runtime argument bytes. Root admission requires UID/GID zero with only CHOWN effective/permitted;
ordinary execution requires all four UID/GID values of 1000, zero inheritable/permitted/effective/ambient sets and
NoNewPrivs=1. The bounding set remains CHOWN for both roles; it is not claimed to be zero. The supervisor verifies the
live process again before approval and before each retirement signal. Gate and journal identities are rechecked before
use or removal. Readiness and approval bytes are finite and exact.

Deno never reads protected proc files or gains allow-all for this evidence. Its only extra read/write authority is the
acquired temporary handshake directory. The supervisor and handshake module are independently transport-hashed before
loading, alongside the worker and receipt; they are also retained as preparation input hashes. The images provide native
sh, stat, chown, sha256sum, cat, head, wc, od, cmp, chmod, mv, rm and sleep. Native startup admission is limited to 30
seconds; post-approval completion and uncooperative wait are bounded by the caller command and exact-container cleanup
deadlines, not by a claimed shell guarantee. Child exit, supervisor rejection and independent cleanup faults remain
separate observations. The gate is a trusted-worker provenance boundary, not a hostile concurrent filesystem sandbox.

The exact supervisor path now has an LF checkout attribute so Windows Git cannot convert its admitted shell bytes to
CRLF. Retirement distinguishes the original `preCleanupExit`, actual `cleanupExit`, and post-cleanup `finalExit`. A
changed owner refuses removal and records `cleanupExit: null`; cleanup failure or refusal returns 74 without hiding the
original failure. The native CLI's actual status remains authoritative, and inert upstream attributes stay unchanged.

Privileged FUSE pure source admission remains explicit and separate from ordinary Linux test execution.

Transport archives keep directory headers at owner-only `0700` while the unchanged admission manifest declares final
`0555` directories. This allows extraction to populate every descendant without DAC override, even when root/descendant
headers are noncontiguous and tar restores a directory early. Root admission checks complete bytes, kinds, contained
links and owner before applying and verifying final manifest modes. These temporary transport permissions confer no
access to maintained host paths and do not weaken ordinary-user read-only inputs. Independent tar-header controls
preserve exact child/receipt bytes and final manifest values; actual CHOWN-only extraction remains a separate Linux
proof.

Failed Linux commands now retain their actual exit and independent binary diagnostics before the task raises an error.
Each invocation writes `call-NNNN/stdout.bin`, `stderr.bin` and `metadata.json` below its acquired run report, including
bootstrap rejection and exact-container cleanup. Previously a failed CLI embedded decoded output in an error message,
and the lane journal kept only the outer stack; the useful cause disappeared from that journal.

For example, an actual child exit 9 with complete pipe capture remains failure. A quota or report-write fault is a
separate observation and cannot replace that exit. Each pipe admits at most 16MiB; overflow retains the prefix and
refuses success. Deadline or cancellation kills only the acquired CLI. A finite drain grace never turns forced pipe
closure into EOF or claims that a daemon-side container was removed. Both raw writes and metadata are attempted
independently, and original structured causes survive in the outcome. Report acquisition happens before the first CLI;
if it fails, no durable command evidence is claimed. The existing Linux commands, ordinary runtime authority, exact
owned-container cleanup and benchmark workloads remain unchanged.

FUSE now uses the same bounded native collector for source admission and Docker image inspection. Its acquired report
root exists before the first native command; raw files and call metadata are retained before success or failure is
returned to the caller. Progress saves also verify the original independent metadata file before overwriting it.
Recursive admission, workload and cleanup causes remain visible when a journal write fails. Testcontainers exec
observations retain their decoded output and actual exit code separately, including failed extraction and copied-tree
checks; they do not claim raw pipe capture or EOF. Failed benchmark-output reads also refuse validation, after both
output files and the progress journal are attempted, even if the returned text looks valid. Mounted correctness and the
16-case benchmark are unchanged.
