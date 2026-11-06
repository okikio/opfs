/** Read-only filesystem composition without author-supplied dummy mutations. @module */
import { defineAdapter } from "./definition.ts";
import type { AdapterType } from "./definition.ts";
import { FileSystemError } from "../error.ts";

/** Only the read surface is required. The constructor supplies explicit mutation refusal.
 * The injected driver is borrowed; optional disposal releases only resources
 * owned by this view. It must not close a borrowed client or archive source.
 */
export interface ReadAdapterType extends
  Pick<
    AdapterType,
    "name" | "driver" | "stat" | "readFile" | "readDir" | "openReadStream" | "limits" | "dispose"
  > {
  readonly capabilities: {
    readonly streamRead: boolean;
    readonly rangeRead: boolean;
  };
}

/** Converts an explicitly read-only definition into the facade primitive contract.
 *
 * Inspection and planning report mutations unsupported. Both the facade's hard
 * admission and these direct primitive methods refuse them before reading data.
 * A writable capability can never be enabled through this constructor.
 */
export function defineReadAdapter(definition: ReadAdapterType): AdapterType {
  const refuse = (): never => {
    throw new FileSystemError("not-supported", "write", undefined, "This adapter is read-only.");
  };
  return defineAdapter({
    name: definition.name,
    driver: definition.driver,
    capabilities: {
      read: true,
      write: false,
      streamRead: definition.capabilities.streamRead,
      rangeRead: definition.capabilities.rangeRead,
      streamWriteModes: [],
      nativeCopy: false,
      nativeMove: false,
      positionalWrite: false,
      syncAccess: false,
    },
    ...(definition.limits === undefined ? {} : { limits: { ...definition.limits } }),
    stat: definition.stat.bind(definition),
    readFile: definition.readFile.bind(definition),
    readDir: definition.readDir.bind(definition),
    ...(definition.openReadStream === undefined ? {} : { openReadStream: definition.openReadStream.bind(definition) }),
    writeFile: refuse,
    createDir: refuse,
    remove: refuse,
    ...(definition.dispose === undefined ? {} : { dispose: definition.dispose.bind(definition) }),
  });
}
