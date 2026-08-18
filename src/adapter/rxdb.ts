import type { AdapterType } from "./definition.ts";
import { createRecordAdapter } from "./record.ts";
import {
  createRxDbDriver,
  type RxDbCollectionType,
  type RxDbDocumentType,
  type RxDbQueryType,
  RxDbRecordJsonSchema,
} from "../driver/rxdb.ts";

/** RxDB collection schema used by the OPFS record driver. */
export { RxDbRecordJsonSchema };

/** RxDB collection, document, and query contracts consumed by the driver. */
export type { RxDbCollectionType, RxDbDocumentType, RxDbQueryType };

/**
 * Creates the OPFS primitive translation over one RxDB collection driver.
 *
 * The adapter owns the driver wrapper, but the driver borrows the injected
 * collection. Closing the filesystem therefore does not close the caller's
 * RxDB database or collection.
 */
export function createRxDbAdapter(collection: RxDbCollectionType): AdapterType {
  return createRecordAdapter(createRxDbDriver(collection), {
    name: "rxdb",
    disposeDriver: true,
  });
}
