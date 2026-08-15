import {
  createDb0Adapter,
  type Db0AdapterOptionsType,
  type Db0DatabaseType,
} from "../adapter/db0.ts";
import { defineBridge, type BridgeType } from "./definition.ts";

/** db0 currently supplies SQL persistence to OPFS; OPFS does not pretend to be a SQL database. */
export const Db0Bridge: BridgeType<Db0DatabaseType, never, Db0AdapterOptionsType, never> = defineBridge({
  name: "db0",
  directions: {
    toOpfs: { supported: true },
    fromOpfs: { supported: false, reason: "A filesystem does not provide db0 SQL query and dialect semantics." },
  },
  toOpfs: createDb0Adapter,
});
