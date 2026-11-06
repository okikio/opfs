---
"@okikio/opfs": minor
---

Preview UDF 1.02 image members through bounded physical-partition indexing and exact recorded extents.

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { openUdf } from "@okikio/opfs/archive/udf";

export async function preview(file: Blob): Promise<Uint8Array | undefined> {
  const archive = await openUdf(createBlobSource(file));
  const entry = archive.entries.find((entry) => entry.kind === "file");
  if (!entry) return undefined;
  const result = await archive.read(entry.id, { length: Math.min(4096, entry.size) });
  console.log(archive.metadata, result.integrity, result.work);
  return result.bytes;
}
```

This read-only profile validates descriptor tags, locations and CRC coverage before following one physical partition and
ordinary directory/file records. Selected reads touch only covering short/long recorded extents; borrowed member sources
retain opening cancellation and cumulative budgets. Complete known source/request costs are admitted before allocating
output. Descriptor CRCs do not verify payloads or publishers. The [UDF guide](../docs/udf.md) explains finite index
limits, physical identities, literal names and unsupported layouts. Genuine native images and explicitly labelled extent
adaptations are checked through the independent UDF namespace against every complete original file. Ten benchmark
workloads separate indexing and exact selected reads from a decoded Blob copy baseline.
