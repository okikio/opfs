---
"@okikio/opfs": minor
---

Publish opaque Google Cloud Pub/Sub messages and explicitly settle bounded deliveries through the native REST API.

```ts
import { createPubsubClient } from "@okikio/opfs/pubsub";

export async function publish(project: string, topic: string, token: string, bytes: Uint8Array) {
  const client = createPubsubClient({
    endpoint: "https://pubsub.googleapis.com/",
    project,
    fetch: globalThis.fetch.bind(globalThis),
    credentials: () => ({ authorization: `Bearer ${token}` }),
  });
  return await client.publish(topic, [{ bytes }]);
}
```

Applications own topics, subscriptions, credentials, processing and acknowledgement decisions. Native IDs and exact
timestamp strings remain distinct from delivery tokens. Pull acquires delivery state; a lost response can leave an
unknown outcome, and no mutating operation is automatically retried. An empty pull does not prove an empty backlog, and
an acknowledgement does not prove exactly-once processing. The [guide](../docs/pubsub.md) explains cancellation, bounded
JSON/bytes, explicit deadline changes and native-test limits. This is a message client, not a filesystem.
