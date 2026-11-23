import { createDb0Adapter, type Db0AdapterOptionsType, type Db0DatabaseType } from "../adapter/db0.ts";
import { createDrizzleAdapter, type DrizzleAdapterOptionsType, type DrizzleTableType } from "../adapter/drizzle.ts";
import { createRxDbAdapter, type RxDbCollectionType } from "../adapter/rxdb.ts";
import {
  createUnstorageAdapter,
  type UnstorageAdapterOptionsType,
  type UnstorageStorageType,
} from "../adapter/unstorage.ts";
import {
  createUnstorageBridge,
  type UnstorageBridgeOptionsType,
  type UnstorageBridgeType,
} from "../bridge/unstorage.ts";
import { defineIntegration, type IntegrationType } from "./definition.ts";

/** unstorage can back `FileSystemType` and also has a real reverse unstorage Driver bridge. */
export const UnstorageIntegration: IntegrationType<
  UnstorageStorageType,
  UnstorageBridgeType,
  UnstorageAdapterOptionsType,
  UnstorageBridgeOptionsType
> = defineIntegration({
  name: "unstorage",
  directions: {
    toOpfs: { supported: true },
    fromOpfs: { supported: true },
  },
  toOpfs: createUnstorageAdapter,
  fromOpfs: createUnstorageBridge,
});

/** An RxDB collection can back `FileSystemType`; reverse support requires the complete RxStorage contract. */
export const RxDbIntegration: IntegrationType<
  RxDbCollectionType,
  never,
  void,
  never
> = defineIntegration({
  name: "rxdb",
  directions: {
    toOpfs: { supported: true },
    fromOpfs: {
      supported: false,
      reason:
        "A reverse bridge must implement the complete RxStorage conflict, query, checkpoint, change-stream, cleanup, and lifecycle contracts.",
    },
  },
  toOpfs: createRxDbAdapter,
});

/** db0 can back `FileSystemType`; `FileSystemType` does not provide SQL database semantics. */
export const Db0Integration: IntegrationType<
  Db0DatabaseType,
  never,
  Db0AdapterOptionsType,
  never
> = defineIntegration({
  name: "db0",
  directions: {
    toOpfs: { supported: true },
    fromOpfs: {
      supported: false,
      reason: "A filesystem does not provide db0 SQL query and dialect semantics.",
    },
  },
  toOpfs: createDb0Adapter,
});

/** Wrapper input for the generic Drizzle integration definition. */
export interface DrizzleIntegrationSourceType<
  TDatabase extends object = object,
  TTable extends DrizzleTableType = DrizzleTableType,
> {
  /** Caller-owned database/table options passed to the Drizzle record driver. */
  readonly options: DrizzleAdapterOptionsType<TDatabase, TTable>;
}

/** Drizzle can back `FileSystemType`; a filesystem cannot emulate Drizzle query/dialect behavior. */
export const DrizzleIntegration: IntegrationType<
  DrizzleIntegrationSourceType,
  never,
  void,
  never
> = defineIntegration({
  name: "drizzle",
  directions: {
    toOpfs: { supported: true },
    fromOpfs: {
      supported: false,
      reason: "A filesystem cannot safely emulate Drizzle schema, dialect, and query-builder semantics.",
    },
  },
  toOpfs: (source) => createDrizzleAdapter(source.options),
});
