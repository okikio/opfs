import type { DriverPlanInputType } from "../driver/definition.ts";
import type { AdapterType } from "./definition.ts";
import { defineAdapter } from "./definition.ts";
import type {
  FileDriverCopyOptionsType,
  FileDriverMoveOptionsType,
  FileDriverReadOptionsType,
  FileDriverSignalOptionsType,
  FileDriverType,
  FileDriverWriteOptionsType,
  WritableOptionsType,
} from "../driver/file.ts";
import type { PathType } from "../path.ts";

/** Options for a thin filesystem adapter over one file-shaped driver. */
export interface FileAdapterOptionsType {
  /** Diagnostic adapter name. Defaults to the driver name. */
  readonly name?: string;
  /** Disposes the injected driver when the adapter is disposed. */
  readonly disposeDriver?: boolean;
}

/**
 * Thin adapter over a backend-native file driver.
 *
 * The adapter performs no persistence work. It only translates the driver
 * capability names into the facade's adapter capability contract and forwards
 * the primitive filesystem calls.
 */
class FileAdapter implements AdapterType {
  readonly driver: FileDriverType;
  readonly name: string;
  readonly capabilities: AdapterType["capabilities"];
  readonly publication?: NonNullable<AdapterType["publication"]>;
  readonly hostProfile?: NonNullable<AdapterType["hostProfile"]>;
  readonly admit?: NonNullable<AdapterType["admit"]>;
  readonly reserve?: NonNullable<AdapterType["reserve"]>;
  readonly entry?: NonNullable<AdapterType["entry"]>;
  readonly entries?: NonNullable<AdapterType["entries"]>;
  readonly #disposeDriver: boolean;

  constructor(driver: FileDriverType, options: FileAdapterOptionsType) {
    this.driver = driver;
    if (driver.hostProfile !== undefined) this.hostProfile = driver.hostProfile;
    if (driver.admit !== undefined) this.admit = driver.admit.bind(driver);
    if (driver.reserve !== undefined) this.reserve = driver.reserve.bind(driver);
    if (driver.publication !== undefined) this.publication = driver.publication;
    if (driver.entry !== undefined) this.entry = driver.entry.bind(driver);
    if (driver.entries !== undefined) this.entries = driver.entries.bind(driver);
    this.name = options.name ?? driver.name;
    this.#disposeDriver = options.disposeDriver ?? false;
    this.capabilities = {
      read: driver.capabilities.read,
      write: driver.capabilities.write,
      streamRead: driver.capabilities.streamRead && driver.openReadStream !== undefined,
      streamWriteModes: driver.writeStream === undefined ? [] : [...driver.capabilities.streamWriteModes],
      rangeRead: driver.capabilities.rangeRead,
      nativeCopy: driver.capabilities.copy && driver.copy !== undefined,
      nativeMove: driver.capabilities.move && driver.move !== undefined,
      positionalWrite: driver.capabilities.positionalWrite && driver.openWritableFile !== undefined,
      syncAccess: driver.capabilities.syncAccess && driver.openSyncFile !== undefined,
    };
    if (this.hostProfile !== undefined) {
      Object.freeze(this.capabilities.streamWriteModes);
      Object.freeze(this.capabilities);
    }
  }

  /** File paths are already canonical; retain request-specific publication requirements. */
  plan(input: DriverPlanInputType) {
    return this.driver.plan(input);
  }

  stat(path: PathType, options?: FileDriverSignalOptionsType) {
    return this.driver.stat(path, options);
  }

  readFile(path: PathType, options?: FileDriverReadOptionsType) {
    return this.driver.readFile(path, options);
  }

  writeFile(path: PathType, data: Uint8Array, options: FileDriverWriteOptionsType) {
    return this.driver.writeFile(path, data, options);
  }

  readDir(path: PathType, options?: FileDriverSignalOptionsType) {
    return this.driver.readDir(path, options);
  }

  createDir(path: PathType, options?: FileDriverSignalOptionsType) {
    return this.driver.createDir(path, options);
  }

  remove(path: PathType, options?: FileDriverSignalOptionsType) {
    return this.driver.remove(path, options);
  }

  openReadStream(path: PathType, options?: FileDriverReadOptionsType) {
    if (this.driver.openReadStream === undefined) {
      throw new TypeError(`Driver '${this.driver.name}' has no stream read.`);
    }
    return this.driver.openReadStream(path, options);
  }

  writeStream(path: PathType, source: ReadableStream<Uint8Array>, options: FileDriverWriteOptionsType) {
    if (this.driver.writeStream === undefined) throw new TypeError(`Driver '${this.driver.name}' has no stream write.`);
    return this.driver.writeStream(path, source, options);
  }

  copy(source: PathType, destination: PathType, options: FileDriverCopyOptionsType) {
    if (this.driver.copy === undefined) throw new TypeError(`Driver '${this.driver.name}' has no native copy.`);
    return this.driver.copy(source, destination, options);
  }

  move(source: PathType, destination: PathType, options: FileDriverMoveOptionsType) {
    if (this.driver.move === undefined) throw new TypeError(`Driver '${this.driver.name}' has no native move.`);
    return this.driver.move(source, destination, options);
  }

  openWritableFile(path: PathType, options?: WritableOptionsType) {
    if (this.driver.openWritableFile === undefined) {
      throw new TypeError(`Driver '${this.driver.name}' has no positional file.`);
    }
    return this.driver.openWritableFile(path, options);
  }

  openSyncFile(path: PathType) {
    if (this.driver.openSyncFile === undefined) {
      throw new TypeError(`Driver '${this.driver.name}' has no synchronous file.`);
    }
    return this.driver.openSyncFile(path);
  }

  async dispose(): Promise<void> {
    if (this.#disposeDriver) await this.driver.dispose?.();
  }
}

/** Creates the OPFS primitive translation over one file-shaped driver. */
export function createFileAdapter(driver: FileDriverType, options: FileAdapterOptionsType = {}): AdapterType {
  return defineAdapter(new FileAdapter(driver, options));
}
