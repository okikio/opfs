import type { AdapterType } from "./definition.ts";
import { createRecordAdapter } from "./record.ts";
import {
  createDrizzleDriver,
  type DrizzleDriverOptionsType,
  type DrizzleRowType,
  type DrizzleTableType,
} from "../driver/drizzle.ts";

/** Options forwarded to the Drizzle record driver. */
export type DrizzleAdapterOptionsType<
  TDatabase extends object,
  TTable extends DrizzleTableType,
> = DrizzleDriverOptionsType<TDatabase, TTable>;

/** Drizzle row and table contracts required by the record driver. */
export type { DrizzleRowType, DrizzleTableType };

/**
 * Creates the OPFS primitive translation over a Drizzle database/table driver.
 *
 * The supplied database and table stay caller-owned. The adapter owns only the
 * small record-driver wrapper created for this filesystem.
 */
export function createDrizzleAdapter<
  TDatabase extends object,
  TTable extends DrizzleTableType,
>(options: DrizzleAdapterOptionsType<TDatabase, TTable>): AdapterType {
  return createRecordAdapter(createDrizzleDriver(options), {
    name: "drizzle",
    disposeDriver: true,
  });
}
