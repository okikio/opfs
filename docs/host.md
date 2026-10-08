# Host roots and mounted filesystem clients

Ordinary host storage keeps the usual API. Copy prepares an owned sibling before publishing it, so a preparation failure
leaves an existing destination intact.

```ts
import { createFileSystem } from "@okikio/opfs";
import { createNodeAdapter } from "@okikio/opfs/adapter/node";

const fs = createFileSystem(createNodeAdapter({ root: "./data" }));
try {
  await fs.writeFile("/draft.bin", new Uint8Array([1, 2, 3]));
  await fs.copy("/draft.bin", "/result.bin", { overwrite: true });
} finally {
  await fs.close();
}
```

The default `native` profile assumes an ordinary host volume with exclusive staging creation, copying into an existing
stage, hard links, and failure-preserving rename. Runtime API availability does not establish those facts for every
mount. The application owns the trusted root, mount lifecycle, permissions, and selection of a compatible profile. Node,
Deno, and Bun drivers and their convenience adapters accept the same `profile` option.

For a known object-backed mount, select its documented mode explicitly:

```ts
import { createFileSystem } from "@okikio/opfs";
import { createNodeAdapter } from "@okikio/opfs/adapter/node";

const fs = createFileSystem(createNodeAdapter({
  root: "/mnt/s3/application",
  profile: "mountpoint-s3",
}));
try {
  await fs.writeFile("/draft.bin", new Uint8Array([1, 2, 3]));
  const plan = fs.plan({ operation: "copy", path: "/draft.bin", destination: "/result.bin" });
  console.log(plan.supported, plan.problems.map((problem) => problem.code)); // false, host-publication
  console.log(fs.inspect().adapter.hostProfile);
  // Explicitly opt into direct read/write copying, which can expose partial destination changes:
  await fs.copy("/draft.bin", "/result.bin", { preserve: false });
} finally {
  await fs.close();
}
```

The `mountpoint-s3` preset describes general-purpose S3 buckets mounted with allow-overwrite and allow-delete. It
excludes S3 Express incremental upload and rename. The `blobfuse-block` preset describes BlobFuse block-blob storage; it
does not describe HNS/ADLS rename. Both presets reject default strong copy and preserving move before metadata,
directory traversal, parent creation, temporary stages, locks, or producer acquisition. Disabling native copy or move
does not bypass this admission. The same declared restrictions apply to direct drivers and adapters.

| Profile          | Admitted write modes    | Default strong copy                   | Preserving native move                                 | Mutable resources         |
| ---------------- | ----------------------- | ------------------------------------- | ------------------------------------------------------ | ------------------------- |
| `native`         | replace, append, update | owned stage, then hard link or rename | preserving rename                                      | positional and sync       |
| `mountpoint-s3`  | replace                 | rejected                              | rejected                                               | conservatively unadmitted |
| `blobfuse-block` | replace, append, update | rejected                              | rejected; explicit best-effort native rename available | conservatively unadmitted |

Mountpoint rejects hard links and general-purpose rename. BlobFuse excludes hard links, and its block-blob rename uses
copy followed by deletion. Those mechanics cannot satisfy the strong default. These policies follow
[pinned Mountpoint semantics](https://github.com/awslabs/mountpoint-s3/blob/mountpoint-s3-1.24.0/doc/SEMANTICS.md),
[BlobFuse2 limitations](https://github.com/Azure/azure-storage-fuse/wiki/Blobfuse2-Limitations), and the
[BlobFuse 2.5.5 block-blob implementation](https://github.com/Azure/azure-storage-fuse/blob/e903019628518df6f807d4e3d8e59ab0ae63f0a5/component/azstorage/block_blob.go#L364).
Mutable resources remain unadmitted by these presets because creation/append evidence does not prove the complete seek,
update, truncate, flush, and close workflow. This is a conservative library policy, not a claim that every native
resource call fails. Use direct S3/Azure adapters when their object publication contract matches the application.

Native `publication` facts use `unsupported` when the configured driver has no such admitted primitive route; this is
distinct from the facade's explicit best-effort emulation. `copyNoReplace` is atomic only when the entire native
staging/copy/hard-link route is admitted. `moveNoReplace` describes native rename independently. The aggregate
`noReplace` is the weakest guarantee among admitted native operations, or unsupported when neither is admitted. Use the
operation-specific facts and option-sensitive plan for a concrete request.

`preserve:false` on host facade copy selects the actual direct write route. It does not try staged native copy and then
retry a failed operation. A producer or transport fault can leave a partial destination. `exclusive:true` still requires
atomic no-replace and rejects a direct writer. Best-effort move is separate: a configured native rename may involve
remote copy/delete, and an emulated move is copy followed by remove. Neither makes an atomic multi-file result.

Advanced callers can supply complete facts without adding a driver implementation:

```ts
import { createNodeDriver } from "@okikio/opfs/driver/node";
import { HOST_PROFILES } from "@okikio/opfs/driver/host";

const driver = createNodeDriver({
  root: "/mounted/volume",
  createRoot: false,
  profile: { ...HOST_PROFILES.native, name: "documented-volume", source: "user", hardLink: false },
});
console.log(driver.plan({ operation: "copy", path: "/a", destination: "/b", overwrite: true }));
// Overwrite can use preserving rename. No-replace native copy cannot use hard-link publication here.
```

The profile is validated and copied before root creation, then frozen. Its source is an assumption, vendor mode
declaration, or caller declaration. It is not a live probe. `readOnly:true` denies mutations and mutable resource
acquisition before I/O, including indirect parents and KV/unstorage bridge namespace work. Read-only construction
defaults to no root creation; explicit `createRoot:true` conflicts and throws `TypeError` before native work.

Unknown roots retain genuine runtime errors: EPERM remains permission-denied with its original cause. OPFS never guesses
a filesystem from a path or changes its profile after a native failure. Permissions, quota, mounts, and network
availability can change after admission. Staging cleanup remains best effort after a process interruption. These
profiles do not establish crash durability, cross-process writer locks, hostile path-swap confinement, complete POSIX
conformance, or visibility to every remote client. See [storage ownership](storage.md) for the publication boundary and
[validation](validation.md) for actual runtime evidence.
