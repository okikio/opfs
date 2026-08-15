import {
  createUnstorageAdapter,
  type UnstorageAdapterOptionsType,
  type UnstorageStorageType,
} from "../adapter/unstorage.ts";
import {
  createUnstorageDriver,
  type UnstorageDriverOptionsType,
  type UnstorageDriverType,
} from "../driver/unstorage.ts";
import { defineBridge, type BridgeType } from "./definition.ts";

/** Bidirectional unstorage integration using the existing adapter and reverse driver contracts. */
export const UnstorageBridge: BridgeType<
  UnstorageStorageType,
  UnstorageDriverType,
  UnstorageAdapterOptionsType,
  UnstorageDriverOptionsType
> = defineBridge({
  name: "unstorage",
  directions: { toOpfs: { supported: true }, fromOpfs: { supported: true } },
  toOpfs: createUnstorageAdapter,
  fromOpfs: createUnstorageDriver,
});
