---
"@okikio/opfs": minor
---

Use native Supabase Storage REST files with explicit API, public and signed authority.

```ts
import { SupabaseClient } from "@okikio/opfs/supabase";

export async function read(endpoint: string, accessToken: string, key: string): Promise<Uint8Array> {
  const files = new SupabaseClient({
    endpoint,
    bucket: "notes",
    credentials: () => ({ accessToken }),
  });
  return await files.read(key, { access: "authenticated" });
}
```

Public and signed media never receive API credentials. List prefixes remain placeholders, offset pages are not
snapshots, and deletion omissions remain unresolved under native RLS. Mutations without valid acknowledgments retain
unknown outcomes. The [guide](../docs/supabase.md) covers bounded upload/read costs, explicit signed-origin grants and
native version limits. Genuine Storage/PostgreSQL and the official test-only SDK verify complete bytes and permissions.
This adds no production SDK, authentication discovery, filesystem, immutable source or resumable REST destination.
