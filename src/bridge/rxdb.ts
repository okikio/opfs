import { createRxDbAdapter, type RxDbCollectionType } from "../adapter/rxdb.ts";
import { defineBridge, type BridgeType } from "./definition.ts";

/** RxDB currently supports collection -> OPFS; implementing RxStorage is intentionally outside this bridge. */
export const RxDbBridge: BridgeType<RxDbCollectionType, never, void, never> = defineBridge({
  name: "rxdb",
  directions: {
    toOpfs: { supported: true },
    fromOpfs: { supported: false, reason: "Implementing RxStorage requires RxDB query, conflict, change-stream, and cleanup contracts beyond filesystem semantics." },
  },
  toOpfs: createRxDbAdapter,
});
