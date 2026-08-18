import type { AdapterType } from "./definition.ts";
import { createRecordAdapter } from "./record.ts";
import {
  createDb0Driver,
  type Db0DatabaseType,
  type Db0DriverOptionsType,
  type Db0PrimitiveType,
  type Db0StatementType,
} from "../driver/db0.ts";

/** Options forwarded to the db0 record driver. */
export type Db0AdapterOptionsType = Db0DriverOptionsType;

/** db0 database, parameter, and statement contracts consumed by the driver. */
export type { Db0DatabaseType, Db0PrimitiveType, Db0StatementType };

/**
 * Creates the OPFS primitive translation over a db0 database driver.
 *
 * The adapter owns the configured driver wrapper. The injected db0 Database is
 * closed only when `disposeDatabase` is enabled on the driver options.
 */
export async function createDb0Adapter(
  database: Db0DatabaseType,
  options: Db0AdapterOptionsType = {},
): Promise<AdapterType> {
  return createRecordAdapter(await createDb0Driver(database, options), {
    name: "db0",
    disposeDriver: true,
  });
}
