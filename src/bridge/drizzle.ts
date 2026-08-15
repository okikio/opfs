import { createDrizzleAdapter, type DrizzleAdapterOptionsType, type DrizzleTableType } from "../adapter/drizzle.ts";
import { defineBridge, type BridgeType } from "./definition.ts";

/** Wrapper input keeps the generic bridge constructor to one source argument. */
export interface DrizzleBridgeSourceType<TDatabase extends object = object, TTable extends DrizzleTableType = DrizzleTableType> {
  /** Connected Drizzle database and caller-owned table mapping. */
  readonly options: DrizzleAdapterOptionsType<TDatabase, TTable>;
}

/** Drizzle supplies persistence to OPFS; the filesystem does not emulate Drizzle query semantics. */
export const DrizzleBridge: BridgeType<DrizzleBridgeSourceType, never, void, never> = defineBridge({
  name: "drizzle",
  directions: {
    toOpfs: { supported: true },
    fromOpfs: { supported: false, reason: "A filesystem cannot safely emulate Drizzle schema, dialect, and query-builder semantics." },
  },
  toOpfs: (source) => createDrizzleAdapter(source.options),
});
