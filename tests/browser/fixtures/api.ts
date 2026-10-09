import type { probeOpfs } from "../../../mod.ts";

/** Result returned by one real browser realm after probing and exercising OPFS. */
export interface RealmResultType {
  /** Whether the browser exposes the realm or capability needed by the scenario. */
  readonly supported: boolean;
  /** Capability report captured in the same realm as the operation. */
  readonly probe?: Awaited<ReturnType<typeof probeOpfs>>;
  /** Text read back after the fixture writes through OPFS. */
  readonly value?: string;
  /** Whether a synchronous access handle opened in the tested worker realm. */
  readonly syncOpened?: boolean;
  /** Native error name reported when synchronous access was exposed but could not open. */
  readonly syncError?: string;
  /** Bytes preserved after positioned writes, flush, truncate, close and reopen. */
  readonly syncBytes?: readonly number[];
  /** Stable error returned by an operation after closing a synchronous file. */
  readonly syncClosedCode?: string;
  /** Whether closing a synchronous file released its lock for a second handle. */
  readonly syncReopened?: boolean;
}

/** Browser record adapters exercised against their actual platform storage APIs. */
export type BrowserAdapterType = "localstorage" | "indexeddb" | "cache";

/** Stable result returned by browser cancellation scenarios. */
export interface AbortResultType {
  /** Whether this browser exposes the capability required by the scenario. */
  readonly supported: boolean;
  /** JavaScript error name observed by the caller. */
  readonly name?: string;
  /** Stable package error code observed by the caller. */
  readonly code?: string;
  /** Committed bytes read after an already-cancelled replacement. */
  readonly preserved?: string;
  /** Whether an already-cancelled creation published a new path. */
  readonly published?: boolean;
}

/** Timing result shared by browser fixture benchmarks and their Playwright callers. */
export interface BenchmarkResultType {
  /** Elapsed milliseconds for direct platform storage operations. */
  readonly rawMs: number;
  /** Elapsed milliseconds for the direct file or record driver path. */
  readonly driverMs: number;
  /** Elapsed milliseconds for the direct `AdapterType` path. */
  readonly adapterMs: number;
  /** Elapsed milliseconds for the complete `FileSystemType` path. */
  readonly facadeMs: number;
  /** Elapsed milliseconds for the facade with basic metrics enabled. */
  readonly measuredMs: number;
  /** Normalized milliseconds per requested batch, preserving repeated samples for each layer. */
  readonly samples: {
    readonly rawMs: readonly number[];
    readonly driverMs: readonly number[];
    readonly adapterMs: readonly number[];
    readonly facadeMs: readonly number[];
    readonly measuredMs: readonly number[];
  };
}

/** Inputs for actual iframe-realm bodies sent through the parent provider clients. */
export interface ProviderBodyOptionsType {
  /** REST provider whose transmission boundary owns the body. */
  readonly provider: "s3" | "azure";
  /** Direct request versus the public upload planner. */
  readonly route: "request" | "put";
  /** Genuine foreign-realm bytes or native stream. */
  readonly body: "bytes" | "stream";
  /** Empty input versus an offset view with two payload bytes. */
  readonly empty: boolean;
  /** Enables S3 delayed multipart or Azure staged block upload for public put. */
  readonly mode: boolean;
  /** Provides the Shared Key stream length for a direct Azure request. */
  readonly length: boolean;
}

/** Browser-observed transmission and ownership, without network or provider claims. */
export interface ProviderBodyResultType {
  /** Parent instanceof fails for the genuine iframe object. */
  readonly foreign: boolean;
  /** Parent native locked getter accepted the iframe stream and found it unlocked. */
  readonly intrinsicUnlocked: boolean;
  /** Each parent-native Request's protocol stage and consumed body. */
  readonly requests: readonly {
    readonly stage: string;
    readonly bytes: readonly number[];
    readonly duplex: boolean;
    /** Prepared Content-Length before the browser Request header guard. */
    readonly length: string | null;
  }[];
  /** Direct request response status. */
  readonly status?: number;
  /** Acknowledged public put size. */
  readonly size?: number;
  /** Error class at an intentionally refused admission boundary. */
  readonly error?: string;
  /** Input lock state after settlement; dispatched raw requests transfer ownership to Fetch. */
  readonly locked: boolean;
  /** Producer cancellations, separate from ordinary EOF. */
  readonly cancellations: number;
}

/** Browser fixture API consumed by Playwright from the containing page. */
export interface BrowserTestApiType {
  /** Signals that module initialization completed and Playwright can call the fixture. */
  readonly ready: true;
  /** Probes OPFS in the Window realm without throwing for unsupported storage. */
  probe(): ReturnType<typeof probeOpfs>;
  /** Writes and reads one value through native Window OPFS. */
  roundTrip(path: string, value: string): Promise<RealmResultType>;
  /** Reads an existing Window OPFS file without creating it. */
  read(path: string): Promise<string | null>;
  /** Runs the OPFS scenario in a real DedicatedWorker. */
  dedicated(path: string, value: string): Promise<RealmResultType>;
  /** Runs the OPFS scenario in a real SharedWorker. */
  shared(path: string, value: string): Promise<RealmResultType>;
  /** Runs the OPFS scenario in a registered ServiceWorker. */
  service(path: string, value: string): Promise<RealmResultType>;
  /** Attempts an already-cancelled write and reports its normalized terminal error. */
  abort(path: string): Promise<AbortResultType>;
  /** Queues a write behind a real Web Lock and reports the normalized cancellation error. */
  queuedAbort(): Promise<AbortResultType>;
  /** Measures native OPFS against the direct OPFS adapter and facade. */
  benchmark(iterations: number, bytes: number): Promise<BenchmarkResultType | null>;
  /** Measures one browser record backend against its adapter and facade paths. */
  benchmarkAdapter(kind: BrowserAdapterType, iterations: number, bytes: number): Promise<BenchmarkResultType | null>;
  /** Proves one browser record adapter through a write/read facade round trip. */
  adapter(kind: BrowserAdapterType): Promise<string>;
  /** Races two independent IndexedDB filesystem owners through atomic append transactions. */
  indexedDbAppend(): Promise<string>;
  /** Exercises real iframe-realm provider bodies through parent-native Request consumption. */
  providerBody(options: ProviderBodyOptionsType): Promise<ProviderBodyResultType>;
}

/**
 * File-local view of a browser global after the fixture installs `opfsTest`.
 *
 * Importing this type does not augment `Window`, `WorkerGlobalScope`, or
 * `globalThis`. Each Playwright source file must opt in with a local cast at the
 * point where its callback executes inside the fixture realm.
 */
export interface BrowserTestGlobalType {
  readonly opfsTest: BrowserTestApiType;
}
