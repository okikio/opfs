# Container source admission

Run the existing maintainer commands from the installed checkout:

```sh
deno task test:linux
deno task test:filesystem-clients
```

Both commands copy their admitted inputs into disposable containers. They do not bind the checkout or its `.git`
directory into a nested Docker container. This matters when release preparation already runs in a container: a daemon's
bind-mount ownership view can differ from the outer checkout's ownership. Even matching the inner UID does not prove
that Git will admit that mounted repository. Source admission therefore consults Git only in the ordinary outer
checkout, rather than configuring `safe.directory`, changing the checkout owner, or relaxing its write protection.

`.mise/tasks/container.mjs` owns one identity-guarded private temporary copy and uncompressed archive per invocation.
The maintained catalog comes from outer `git ls-files --cached --others --exclude-standard`. Repository administration,
ignored task outputs and output trees are excluded. Installed `node_modules` is copied separately; Linux also copies the
manual Deno cache. Installed package `dist` and `build` directories remain runtime inputs; the source-output exclusion
rule does not remove those dependency implementations. No dependency installation or network access occurs in a Linux
lane. The cache and dependencies must remain unchanged during the invocation, just like source files.

Files are copied independently, even when the package manager hard-linked the original files. A symbolic alias must
resolve inside an admitted source, dependency or cache tree. Absolute internal aliases are rebased to relative targets
inside the copy. Missing, cyclic, escaped and special-file inputs reject admission. The copied catalog records every
path, physical kind, permission mode, digest and alias spelling. Owned regular files must have one physical hard link.
Additional paths, changed bytes, changed modes and substituted aliases reject the copied-tree guard.

Host observations and declared Linux permissions have separate authority. On POSIX hosts the outer identity retains
native UID/GID and permission modes, including alias metadata. On Windows those observations are `null`; synthetic POSIX
mode numbers cannot prove Windows access control. Host staging stays owner-writable on every platform and clears only
its own copied file's read-only attribute for reliable cleanup. Byte, kind, contained-alias and observable hard-link
identity still belong to its before/after guard. Directory aliases use owned junctions without acquiring their borrowed
targets. A Windows payload with file aliases requires Developer Mode or file-symlink privilege; admission reports that
specific requirement rather than weakening alias checks. Plain-file and contained-directory payloads remain supported.

The archive declares Linux directories as `0555`, links as `0777`, and regular files as `0444`, or `0555` when the host
actually observes POSIX executable bits. Windows has no such executable-bit observation, so its regular files default to
`0444`; the task invokes scripts through the image's explicit native runtime. No host permission assumption is promoted
to a Linux guarantee. Portable tar headers contain contained relative aliases, never Windows junction spellings.

Linux adds only CHOWN to the otherwise dropped container capability set. Root explicitly acquires ownership of its
copied private archive and establishes its private `0600` mode before hashing and extracting it; Docker copy ownership
is not inferred from the caller UID. This never changes borrowed or maintained host inputs. The same native JavaScript
worker first checks exact bytes, kinds, links and root ownership with `--admit`, then establishes and verifies the
declared Linux permissions. Linux worker identity is independently observed after runtime startup and before work. All
real tests run as UID/GID 1000 with zero inheritable, effective, permitted and ambient capability sets and NoNewPrivs=1.
The bounding set retains CHOWN, so the evidence does not claim every capability set is zero. Node, Bun and Deno use
their native built-in modules; the Deno image does not require Node. Its root admission alone gets write permission for
the private copied tree. The entrypoint is explicit, so the Deno command includes its `deno` executable rather than
relying on the image's default entrypoint. All five existing runtime/storage lanes retain their test selection, network
exclusion and resource caps. POSIX-only host mode/link tests have an explicit Windows capability boundary; binary
independent copying, portable tar headers, dependency retention and cancellation controls run on every host. Actual
Linux byte, owner, mode and single-link guards remain mandatory.

The two offline Deno lanes set `DENO_DISABLE_NODE_SHIM=1` for the entire owned container, including root admission,
ordinary worker startup and the selected Deno tests. This is Deno's supported opt-out for its optional native `node`
launcher. Without the opt-out, Deno 2.9.7 can create `DENO_DIR/node_compat_bin/node` pointing to the image's Deno
executable before the worker runs. That target lies outside the admitted cache, so the exact alias guard correctly
rejects it. The opt-out preserves the native Deno executable; it does not admit an external alias or give dependencies
write permission. See Deno's
[Node compatibility documentation](https://docs.deno.com/runtime/fundamentals/node/#tools-that-spawn-node) and the
[pinned 2.9.7 launcher implementation](https://github.com/denoland/deno/blob/v2.9.7/cli/node_compat_shim.rs).

These Deno lanes select `test:portable`, `test:upstream`, `test:deno` and `test:deno-kv`. Their maintained test closure
does not require a native child named `node`. The process controls that explicitly launch `node` belong to separate
Node/Bun commands. The Node 22 and Node 24 Linux lanes continue to use real Node. A future Deno test that needs a child
runtime must invoke the explicit native Deno executable, for example `Deno.execPath()`, or declare a separate Node
emulation scenario with its own admitted launcher. Importing `node:` built-ins in Deno still uses Deno's native
compatibility implementation.

Root admission uses a separate UUID-named `DENO_DIR` under `/tmp/opfs-bootstrap-*`. This worker imports only copied
local modules and native built-ins, so it needs no downloaded dependencies. Deno can create analysis databases, their
SQLite WAL/SHM files and runtime directories before the worker begins. Those are private startup outputs, not downloaded
input bytes. The named container owns that output cache until its independently observed removal; the lane receipt
declares its path. The complete copied input cache remains guarded while root admission establishes read-only
permissions. Ordinary Deno worker startup and test execution then use that same complete read-only input cache. No input
entry is ignored, pruned or allowed to change. Deno's pinned analysis cache uses an in-memory fallback on read-only
failure, and its V8 code cache can discard persistent writes; see the
[2.9.7 cache failure policy](https://github.com/denoland/deno/blob/v2.9.7/cli/cache/cache_db.rs).

The supervisor observes the root and ordinary Deno worker processes after startup. Workload subprocess credentials
follow Linux exec inheritance and NoNewPrivs; they are not separately observed by that worker receipt. The unchanged
complete cache guard rejects any added or modified input entry. This does not certify that every Deno version can run
against every sealed cache; actual startup, offline test execution and before/after receipts remain the acceptance gate.
Root bootstrap output-cache creation and disposal are fixture work, not library operation timings.

FUSE needs root and privilege to start Mountpoint and BlobFuse. That authority is restricted to the disposable client
container. It extracts and admits the private copy there and creates a read-only bind mount of that copied tree wholly
inside the container. Neither source admission nor the client mounts the host checkout. Mountpoint and BlobFuse
correctness oracles, mounted paths, native capability observations and the 16-case benchmark remain unchanged.

Admission hashes the complete outer catalog before and after copying and again after workloads. The source owner and
permissions are part of that outer identity. Archive, verifier and installed archiver entry digests bind the transported
recipe; the receipt retains the archiver version and host observation boundary. The worker checks exact copied
membership before and after each Linux command; FUSE checks its copied tree before and after the workflow. These checks
complement the existing conservative benchmark-input catalog, which now includes the admission and worker modules. That
benchmark catalog is a support receipt, not a claim to reconstruct every dynamic import.

Reports remain under `.tmp/reports/linux/` and `.tmp/reports/fuse/`. They retain source admission, archive/verifier
identities, image identities, command evidence and after-work guards. Source changes and cleanup failures refuse
success. Every failed acquisition still owns its uniquely named container or private directory cleanup. Cleanup captures
the canonical private root and observable native root/ancestor identity at acquisition, then checks that authority
before native recursive removal. It never restores permissions or enumerates paths through a replaced parent/root.
Substituted roots reject cleanup, retaining its failure instead of deleting borrowed directories. Leaf aliases are
removed without acquiring their targets. These native observations do not claim an atomic boundary against hostile
concurrent same-UID namespace replacement. Cancellation stops admission between files and cancels directly owned CLIs. A
filesystem copy already in progress must settle before its directory can be removed; the outer process/container
watchdog remains the final boundary for an unresponsive filesystem.

Copying costs disk space and setup time. Admission checks available temporary-disk headroom against an estimate for the
copied filesystem blocks, archive and entry headers. Concurrent disk use can still exhaust that space and is reported as
failure. Files are hashed serially with 64 KiB stream buffers; the exact catalog uses memory proportional to the
admitted path count. Archive creation uses the existing locked Testcontainers dependency, Archiver 7.0.1, resolved only
when admission needs it. Explicit headers are queued one entry at a time. File streams include their observed size so
the tar path streams bytes instead of buffering a complete body. Cancellation closes the active input, archive and
writer before owned-copy removal; writer and finalization failures remain separate evidence. No new package or lock
dependency is introduced. Archive creation and transfer have operational deadlines. Source-copy and guard work occurs
outside benchmark callbacks and physical library metrics. Whole-command CPU, RSS and wall time include orchestration, so
these measurements must not be presented as per-operation library cost or compared directly with older bind-based setup
timings.

Docker's [copy command](https://docs.docker.com/reference/cli/docker/container/cp/) supports stopped and running
containers. The Linux runner uses a stopped-container file copy without `-a` or `-L`, then an explicit root extraction;
it does not infer copied ownership from the caller UID. FUSE uses the installed Testcontainers 12.1.0
`copyFilesToContainer` API, which streams an archive through the container API. The
[Testcontainers copying documentation](https://node.testcontainers.org/features/containers/#with-filesdirectoriescontent)
describes this transport separately from host bind mounts.

The [Archiver API](https://www.archiverjs.com/docs/archiver/) documents explicit entry headers and finalization. Its
abort method does not drain sources, so this task owns and settles the active file stream independently. Windows host
controls do not establish full Windows-to-Docker execution proof; the actual Linux admission and workflow receipts
supply that boundary when the task runs.

Host-private directories remain owner-writable so disposal needs no chmod traversal. Archive declarations and actual
Linux owner/mode guards retain their independent read-only authority. Cleanup checks the acquired physical root and
parents, including observable native device/inode and ownership on POSIX hosts; unobservable Windows metadata remains
unknown. Failed cleanup remains part of the outcome, and repeated close calls return the same settling or rejected
promise. Outside-byte/mode sentinel controls cover root replacement, parent alias replacement and descendant aliases.

If a newly created path cannot acquire meaningful native cleanup identity, admission retains that exact pathname and the
identity failure for recovery. It does not guess a cleanup target or chmod a borrowed fallback. Unix zero/unavailable
inodes reject acquisition. Windows native IDs are compared where observable without claiming POSIX ownership.

Catalog mismatch diagnostics retain complete before/after SHA-256 identities, actual source-membership counts, source/
dependency/cache difference counts, and up to 32 changed entry observations. Linux and FUSE admission-after metadata
retains that structured cause. A cache metadata difference is reported as an observation rather than guessed to be a
source mutation. Truncating retained entry examples does not truncate the full-catalog hash or count.

Canonical filesystem paths use the same
[native realpath API](https://nodejs.org/api/fs.html#fsrealpathnativepath-options-callback) on Node, Bun and Deno. Every
returned path must be absolute before root identity or alias containment is compared. This includes the volume root:
Windows `C:` is relative to that drive's working directory and cannot substitute for `C:\`.
[Bun's Windows promise-realpath defect](https://github.com/oven-sh/bun/issues/42581) exposed that distinction during
private staging acquisition. Admission uses the native callback API rather than altering returned path text, omitting
the root ancestor or weakening metadata checks. A mismatch retains observed metadata or canonical before/after paths
separately in its cause. The unconditional volume-root control joins the existing binary, archive and cancellation
controls; host POSIX exclusions remain unchanged. These controls require actual Windows CI proof and do not establish
Windows-to-Docker workflow admission by themselves.

## Runtime identity before work

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

The supervisor's exact Git attribute pins its working-tree bytes to LF, including Windows checkouts. The container
receives those admitted bytes without rewriting them; this avoids a CRLF checkout becoming an invalid Linux shell
program. Inert upstream snapshots keep their separate byte-preserving attributes.

Retirement first records `preCleanupExit`, then reports `cleanupExit`, `cleanupState` and `finalExit` after the gate
cleanup attempt. `cleanupExit` is the actual `rm` result; it is `null` when changed ownership refuses to start removal.
Cleanup refusal or failure makes the final supervisor code 74 while retaining the earlier result and child exit. For
example, an illustrative pre-cleanup exit 9 and cleanup exit 1 produce final exit 74 with both failures visible. The
native CLI's observed code and signal remain the authority for whether the command itself completed.

OPFS workers spawn their explicit test commands after approval. Descendant authority follows the observed zero named
capability sets and NoNewPrivs through Linux exec; it is not a separate proc snapshot of every descendant. Privileged
FUSE uses the explicit Node-only `--privileged-source` pure admit/verify path. It performs no ordinary library task in
that branch and retains its distinct mount authority.

Transport archives keep directory headers at owner-only `0700` while the unchanged admission manifest declares final
`0555` directories. This allows extraction to populate every descendant without DAC override, even when root/descendant
headers are noncontiguous and tar restores a directory early. Root admission checks complete bytes, kinds, contained
links and owner before applying and verifying final manifest modes. These temporary transport permissions confer no
access to maintained host paths and do not weaken ordinary-user read-only inputs. Independent tar-header controls
preserve exact child/receipt bytes and final manifest values; actual CHOWN-only extraction remains a separate Linux
proof.

## Failed commands retain their evidence

`test:linux` and the FUSE collector acquire their physical report directories before starting the first native CLI.
Linux source admission, rejected bootstrap, diagnostic lookup and named-container cleanup each write a separate
`call-NNNN/` directory under the run report. FUSE uses the same collector for outer source admission and native Docker
image inspection. `stdout.bin` and `stderr.bin` contain independent native bytes; `metadata.json` records their lengths
and SHA-256 digests alongside actual child exit and capture observations. A nonzero child cannot bypass these writes.
The run's journal retains call paths and recursive original causes rather than reducing a lane failure to its outer
stack. Report acquisition failure starts no CLI and cannot claim durable command evidence.

For example, this **illustrative** fragment describes a child that exits 9 after both pipes reach EOF:

```json
{
  "exitObserved": true,
  "code": 9,
  "signal": null,
  "closeObserved": true,
  "stdout": { "eof": true, "complete": true },
  "stderr": { "eof": true, "complete": true },
  "success": false
}
```

Complete capture does not turn exit 9 into success. Conversely, a child can exit 0 while capture fails. Each pipe
retains at most 16MiB; overflow keeps the admitted prefix, records a quota fault, and refuses success. Raw bytes never
enter an error message or JSON byte array. Existing text callers decode each retained stream once after capture. This is
a maintainer diagnostic quota, not a benchmark sample limit or a library throughput requirement.

The command deadline keeps its existing per-call duration. Cancellation, quota overflow and deadline expiry request
SIGKILL for the exact acquired CLI. A further one-second drain grace bounds waiting for its pipes. If that grace
expires, forced closure remains a capture fault: it does not fabricate EOF, child exit or daemon-container removal.
Actual exit uses the native `exit` event; `close`, kill acknowledgement and each pipe's `end` event remain separate
observations, as described by the [Node child-process contract](https://nodejs.org/api/child_process.html#event-close).
Descendants and daemon resources still need their caller-owned cleanup. Cleanup commands ignore workload cancellation so
each exact owned container name gets its independent retirement attempt.

Both raw-file writes and their metadata write are attempted independently. A write, physical-owner or journal fault does
not replace actual child status or a workload failure; the caller retains every failure and refuses success. A complete
pipe observation describes capture, while `retentionFailures` describes disk evidence. Missing raw files cannot be
inferred to be empty. Exclusive writes and acquired canonical roots reject substituted report owners without writing
borrowed paths. These are quiescent identity controls, not a hostile concurrent-filesystem guarantee. Native acquisition
and filesystem calls remain within the outer isolated runner's watchdog.

Serialized diagnostics retain data properties, original causes and shared-reference paths without invoking accessors.
Their traversal has explicit limits: 32 levels, 4096 properties/objects and 1MiB of retained key/value string
characters; shared identities have numbered references with at most 1024 path characters, and omitted data is labeled.
These limits do not truncate the independent raw stream files. Failed metadata writes remain in the thrown structured
outcome even when the disk journal itself cannot be completed. Native child controls exercise binary exit 0/9, missing
executable, quota, deadline and physical report faults; actual Docker lanes provide separate workflow proof.

FUSE keeps Testcontainers exec evidence separate from native CLI capture. That API supplies decoded output and an actual
exit code; extraction, copied-tree checks and correctness rejection retain those observations as structured causes. They
never claim raw native pipe bytes or EOF. Native source-admission and image-inspection calls use the same 16MiB per-pipe
collector, retain raw files before their verdict and record their call paths in the run journal. Capture, retention and
progress-journal failures remain independent. Mounting, provider setup, benchmark callbacks and Testcontainers resource
retirement keep their existing authority and deadlines. Benchmark output reads retain their actual API exit codes; any
failed benchmark or output read refuses validation even when its text looks like valid JSON. Both output writes and the
progress journal are attempted before that verdict. Mount readiness requires both setup and the decoded mount/version
command to exit successfully, as well as both existing mount labels. Debug-log status remains an independent diagnostic
observation and cannot substitute for mount readiness.

FUSE progress saves recheck the report root and the initially created physical regular metadata file before overwriting
that file. A substituted alias, hard link or changed observable native identity refuses the save. Other report leaves
use exclusive creation. Windows file IDs remain unknown where the native API cannot observe them; these are quiescent
ownership guards, not a concurrent hostile-filesystem guarantee. A failed final save stays in the thrown recursive
outcome while owned container and network cleanup still runs.
