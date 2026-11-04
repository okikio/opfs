---
"@okikio/opfs": patch
---

### Refuse corrupt SQL kinds and missing file fields before projection

SQL-backed filesystem records have two kinds: `file` and `directory`. The db0/SQLite and Drizzle drivers now check the
stored discriminator before choosing a projection. Previously, any value other than `directory` selected the file branch
and was replaced with `file` before validation. An externally edited `kind = 'unknown'` row could therefore be opened as
an ordinary file.

File rows also require actual base64 data and a media-type string. An empty file uses `data = ''` with size zero; an
unknown media type uses `media_type = ''`. SQL null or an absent field is refused instead of being converted into those
valid strings. Directory rows keep their legitimate nullable file columns and do not acquire file requirements.

```ts
import { createFileSystem } from "@okikio/opfs";
import { createSqliteAdapter } from "@okikio/opfs/adapter/sqlite";
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(":memory:");
try {
  const adapter = await createSqliteAdapter({
    prepare(sql) {
      const statement = db.prepare(sql);
      const inputs = (values: readonly (string | number | boolean | null | undefined)[]) =>
        values.map((value) => value === undefined ? null : typeof value === "boolean" ? Number(value) : value);
      return {
        all: (...values) => statement.all(...inputs(values)),
        get: (...values) => statement.get(...inputs(values)),
        run: (...values) => statement.run(...inputs(values)),
      };
    },
  });
  await using fs = createFileSystem(adapter);
  await fs.writeFile("/empty.txt", new Uint8Array());
  console.log(await fs.readText("/empty.txt")); // a genuine empty file
} finally {
  db.close(); // injected databases remain caller-owned by default
}
```

A direct driver read/list rejects malformed stored rows; the facade retains the original admission error as its cause.
The operation does not rewrite the database. Repair the original row deliberately or migrate to a validated namespace.
The maintained native scenarios mutate real SQLite persistence through both db0 and Drizzle's actual query builder,
check get/list/facade refusal and unchanged stored rows, then perform explicit repair. Portable controls separately
exercise malformed runtime discriminator values, missing/null file fields, genuine empty files and directories with
nullable SQL columns. These are admission controls, not a claim that every SQL dialect or connector has been executed.
