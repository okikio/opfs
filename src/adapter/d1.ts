import { createD1Driver } from "../driver/d1.ts";
import type { D1BindingType, D1DriverOptionsType } from "../driver/d1.ts";
import { createRecordAdapter } from "./record.ts";
import type { AdapterType } from "./definition.ts";

/** Open the canonical record projection while retaining application ownership of the injected D1 binding. */
export async function createD1Adapter(
  database: D1BindingType,
  options: D1DriverOptionsType = {},
): Promise<AdapterType> {
  return createRecordAdapter(await createD1Driver(database, options), { name: "d1", disposeDriver: true });
}
