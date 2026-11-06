---
"@okikio/opfs": minor
---

### Read content-addressed blocks with an explicit trust choice

The optional `content/cid`, `content/car` and `ipfs` subpaths parse bounded content identifiers, index CAR v1 blocks and
verify complete SHA2-256 blocks before exposing verified byte snapshots. A gateway-trusted UnixFS representation stays
explicitly distinct from a verified raw block. Listing CAR sections leaves their integrity unchecked until they are read
and hashed; declared roots do not establish that the complete DAG is present.

```ts
import { parseCid, verifyBlock } from "@okikio/opfs/content/cid";

const cid = parseCid("f015512202cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
await verifyBlock(cid.id, new TextEncoder().encode("hello"));
console.log(cid.id); // Canonical CIDv1 base32; mismatched block bytes reject.
```

See [the complete IPFS example](docs/ipfs.md) for trust choices, cancellation and byte budgets. An unchanged official
IPLD producer fixture establishes the exercised CAR interoperability; HTTP fixtures establish message handling. These
exports do not add UnixFS reconstruction, mutable-name resolution, pinning, payment or a filesystem projection.
