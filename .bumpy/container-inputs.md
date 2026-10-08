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
