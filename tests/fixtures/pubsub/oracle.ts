/** Official pinned Pub/Sub gRPC SDK, with private emulator transport and explicit client retirement. @module */
import { ok } from "node:assert/strict";
import { Buffer } from "node:buffer";
import { lstatSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import process from "node:process";
type OptionsType = { projectId: string; apiEndpoint: string; port: number; sslCreds: unknown };
type CallType = { timeout: number; retry: null };
type MessageType = {
  ackId?: string | null;
  message?:
    | { messageId?: string | null; data?: Uint8Array | string | null; attributes?: Record<string, string> | null }
    | null;
};
type PublisherType = {
  createTopic(request: { name: string }, call: CallType): Promise<unknown>;
  publish(
    request: { topic: string; messages: { data: Buffer; attributes: Record<string, string> }[] },
    call: CallType,
  ): Promise<[{ messageIds?: string[] | null }, ...unknown[]]>;
  close(): Promise<void>;
};
type SubscriberType = {
  createSubscription(
    request: { name: string; topic: string; ackDeadlineSeconds: number },
    call: CallType,
  ): Promise<unknown>;
  pull(
    request: { subscription: string; maxMessages: number },
    call: CallType,
  ): Promise<[{ receivedMessages?: MessageType[] | null }, ...unknown[]]>;
  close(): Promise<void>;
};
type GaxType = { grpc: { credentials: { createInsecure(): unknown } } };
type ModuleType = {
  v1: {
    PublisherClient: new (options: OptionsType) => PublisherType;
    SubscriberClient: new (options: OptionsType) => SubscriberType;
  };
};
const require = createRequire(import.meta.url),
  imported: unknown = require("@google-cloud/pubsub"),
  gax: unknown = require("google-gax");
ok(
  imported !== null && typeof imported === "object" && "v1" in imported && imported.v1 !== null &&
    typeof imported.v1 === "object" && "PublisherClient" in imported.v1 &&
    typeof imported.v1.PublisherClient === "function" && "SubscriberClient" in imported.v1 &&
    typeof imported.v1.SubscriberClient === "function",
);
ok(
  gax !== null && typeof gax === "object" && "grpc" in gax && gax.grpc !== null && typeof gax.grpc === "object" &&
    "credentials" in gax.grpc && gax.grpc.credentials !== null &&
    (typeof gax.grpc.credentials === "object" || typeof gax.grpc.credentials === "function") &&
    "createInsecure" in gax.grpc.credentials && typeof gax.grpc.credentials.createInsecure === "function",
);
const sdk = imported as ModuleType,
  transport = gax as GaxType,
  options: OptionsType = {
    projectId: "opfs-pubsub",
    apiEndpoint: "pubsub.test",
    port: 8085,
    sslCreds: transport.grpc.credentials.createInsecure(),
  };
const publisher = new sdk.v1.PublisherClient(options),
  subscriber = new sdk.v1.SubscriberClient(options),
  topic = "projects/opfs-pubsub/topics/events",
  subscription = "projects/opfs-pubsub/subscriptions/events-sub",
  call: CallType = { timeout: 10000, retry: null };
/** Files are ordinary bounded fixture inputs; the SDK retains authority over wire messages. */
function input(path: string): Buffer {
  const info = lstatSync(path);
  ok(info.isFile() && info.size <= 1048576);
  const bytes = readFileSync(path);
  ok(bytes.length <= 1048576);
  return bytes;
}
async function main(): Promise<unknown> {
  const operation = process.argv[2];
  if (operation === "init") {
    const metadata: unknown = JSON.parse(
      input("/oracle/node_modules/@google-cloud/pubsub/package.json").toString("utf8"),
    );
    ok(metadata !== null && typeof metadata === "object" && "version" in metadata && metadata.version === "6.3.2");
    await publisher.createTopic({ name: topic }, call);
    await subscriber.createSubscription({ name: subscription, topic, ackDeadlineSeconds: 10 }, call);
    return { sdkVersion: metadata.version };
  }
  if (operation === "seed") {
    const data = input("/oracle/value.bin"),
      [result] = await publisher.publish({ topic, messages: [{ data, attributes: { oracle: "sdk" } }] }, call);
    return { messageIds: result.messageIds };
  }
  if (operation === "pull") {
    const [result] = await subscriber.pull({ subscription, maxMessages: 1 }, call);
    return {
      receivedMessages: (result.receivedMessages ?? []).map((value) => {
        ok(value.message, "SDK returned a message without its payload descriptor.");
        const data = value.message.data;
        const bytes = typeof data === "string" ? Buffer.from(data, "base64") : Buffer.from(data ?? []);
        ok(bytes.length <= 1048576);
        return {
          ackId: value.ackId,
          messageId: value.message.messageId,
          data: bytes.toString("base64"),
          attributes: value.message.attributes ?? {},
        };
      }),
    };
  }
  throw Error("Unknown independent operation.");
}
let value: unknown;
const failures: unknown[] = [];
try {
  value = await main();
} catch (reason) {
  failures.push(reason);
}
for (const client of [subscriber, publisher]) {
  try {
    await client.close();
  } catch (reason) {
    failures.push(reason);
  }
}
if (failures.length) throw new AggregateError(failures, "Independent Pub/Sub operation/cleanup failed.");
console.log("RECEIPT:" + JSON.stringify(value));
