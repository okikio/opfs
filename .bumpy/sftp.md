---
"@okikio/opfs": minor
---

Read and write native SFTP v3 handles over explicit subsystem channels

The native packet client uses an explicitly acquired SSH subsystem channel. Applications own SSH host-key validation and
authentication, while the client owns bounded requests and server handles; acknowledged writes do not imply atomic or
durable publication.

```ts
import { openSftpClient } from "@okikio/opfs/sftp";
import type { SftpOptionsType, SftpReadType } from "@okikio/opfs/sftp";

export async function preview(
  openChannel: SftpOptionsType["openChannel"],
  path: string,
  signal: AbortSignal,
): Promise<SftpReadType> {
  const files = await openSftpClient({ openChannel, signal, timeoutMs: 15_000 });
  const primary: unknown[] = [];
  try {
    const file = await files.openFile(path);
    const result = await file.read(0, 4096);
    await file.close();
    return result;
  } catch (reason) {
    primary.push(reason);
    throw reason;
  } finally {
    try {
      await files.close();
    } catch (cleanup) {
      if (primary.length) throw new AggregateError([...primary, cleanup], "Preview and channel cleanup failed.");
      throw cleanup;
    }
  }
}
```

See [the capability guide](../docs/sftp.md) for work limits, resource ownership, evidence and unsupported profiles.
