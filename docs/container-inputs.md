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
declared Linux permissions. All real tests run as UID/GID 1000 with zero effective, permitted and ambient capabilities
verified before execution and privilege escalation disabled. Node, Bun and Deno use their native built-in modules; the
Deno image does not require Node. Its root admission alone gets write permission for the private copied tree. The
entrypoint is explicit, so the Deno command includes its `deno` executable rather than relying on the image's default
entrypoint. All five existing runtime/storage lanes retain their test selection, network exclusion and resource caps.
POSIX-only host mode/link tests have an explicit Windows capability boundary; binary independent copying, portable tar
headers, dependency retention and cancellation controls run on every host. Actual Linux byte, owner, mode and
single-link guards remain mandatory.

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
