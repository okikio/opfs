import { createKeyValueDriver, type KeyValueDriverOptionsType, type KeyValueDriverType } from "../driver/kv.ts";
import { defineBridge, type BridgeType } from "./definition.ts";

/** Generic reverse bridge for ecosystems that can consume asynchronous hierarchical key-value behavior. */
export const KeyValueBridge: BridgeType<never, KeyValueDriverType, never, KeyValueDriverOptionsType> = defineBridge({
  name: "kv",
  directions: {
    toOpfs: { supported: false, reason: "The generic reverse KV contract does not define enough persistence semantics to construct an OPFS adapter." },
    fromOpfs: { supported: true },
  },
  fromOpfs: createKeyValueDriver,
});
