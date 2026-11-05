---
"@okikio/opfs": minor
---

Download through explicit FTP or certificate-validated FTPS transports

An explicit socket capability now supports native metadata, suffix downloads and bounded STOR uploads. FTPS requires
certificate-validating, control-bound TLS from the injected transport; early download cancellation retires the session
and uncertain publication is never retried automatically.

```ts
import { openFtpClient } from "@okikio/opfs/ftp";
import type { FtpReceiptType, FtpTransportType } from "@okikio/opfs/ftp";

export async function download(
  transport: FtpTransportType,
  credentials: { host: string; username: string; password: string },
  path: string,
  destination: WritableStream<Uint8Array>,
  signal: AbortSignal,
): Promise<FtpReceiptType> {
  const files = await openFtpClient({
    ...credentials,
    transport,
    mode: "explicit-tls",
    timeoutMs: 60_000,
    signal,
  });
  const primary: unknown[] = [];
  try {
    const transfer = await files.openRead(path);
    await transfer.stream.pipeTo(destination, { signal });
    return await transfer.done;
  } catch (reason) {
    primary.push(reason);
    throw reason;
  } finally {
    try {
      await files.close();
    } catch (cleanup) {
      if (primary.length) throw new AggregateError([...primary, cleanup], "Download and connection cleanup failed.");
      throw cleanup;
    }
  }
}
```

See [the capability guide](../docs/ftp.md) for ownership, work limits, recovery and independent interoperability
evidence.
