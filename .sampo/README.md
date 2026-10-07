# Release intent

Each change that consumers can observe adds one changeset here: run `node_modules/.bin/sampo add`, or write the file by
hand.

```markdown
---
npm/@okikio/opfs: minor
---

Teach the consumer what changed, why it matters, and how to migrate.
```

Write each entry for the reader of the changelog: the scenario, the behavior change, any migration and the limits. Show
complete examples for new or changed APIs. Attach workload, runtime and units to any performance claim.
[Releasing](../docs/releasing.md) explains how changesets become a version and a publication.
