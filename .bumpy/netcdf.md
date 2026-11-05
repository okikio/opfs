---
"@okikio/opfs": minor
---

Preview selected netCDF classic variables without loading every interleaved record or unrelated variable.

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { openNetcdf } from "@okikio/opfs/dataset/netcdf";

export async function firstValues(file: Blob) {
  const dataset = await openNetcdf(createBlobSource(file));
  const variable = dataset.variables.find((item) => item.elements > 0 && item.type !== "char");
  if (!variable) return undefined;
  return await dataset.read(variable.id, { offset: 0, count: Math.min(16, variable.elements) });
}
```

CDF-1/CDF-2 raw numeric types retain their stored signedness and source missing-value mask; physical scaling is
explicit. Record selection reads the chosen variable's slabs, with bounded segments and retained opening
budgets/cancellation. There is no built-in checksum or authenticity claim. The [guide](../docs/netcdf.md) explains
packed-domain masking, unsigned-convention limits and the explicit, observable compatibility option for independently
observed SciPy sole-record size declarations. Default parsing remains strict. Reciprocal netCDF-C/SciPy fixtures compare
complete original values and native record subsets. HDF5/netCDF-4, CDF-5, streaming record counts and overflow
large-variable profiles remain unsupported. Benchmarks retain original-byte preflights and separate indexing, selected
ranges and full-variable work.
