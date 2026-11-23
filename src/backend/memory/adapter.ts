import type { AdapterType } from "../../adapter/definition.ts";
import { createRecordAdapter } from "../../adapter/record.ts";
import { createMemoryDriver, type MemoryDriverType } from "./driver.ts";

/** Creates the OPFS primitive translation over a deterministic memory driver. */
export function createMemoryAdapter(): AdapterType {
  return createRecordAdapter(createMemoryDriver(), { name: "memory", disposeDriver: true });
}

/**
 * Creates a memory driver for tests that need direct logical-record access.
 *
 * Prefer `createMemoryDriver()` from `@okikio/opfs/driver/memory` in new code.
 */
export { createMemoryDriver, type MemoryDriverType };
