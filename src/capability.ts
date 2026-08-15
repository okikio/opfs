import type { AdapterType } from "./adapter/definition.ts";
import type { MetricsType } from "./metrics.ts";
import type {
  AdapterLimitsType,
  AdapterPartitionType,
  MetricsModeType,
  OptimizationType,
  SupportModeType,
  WriteModeType,
} from "./schema.ts";

/** Effective support for one write mode. */
export type WriteSupportType = Readonly<Record<WriteModeType, SupportModeType>>;

/**
 * Effective capabilities after adapter-native behavior and facade fallbacks are combined.
 *
 * This differs from `AdapterType.capabilities`, which reports only what the adapter
 * itself can do. For example, `copy` can be `emulated` even when `nativeCopy` is
 * false because the facade can stream or materialize the source and write a destination.
 */
export interface SupportType {
  /** Metadata lookup. Required by every adapter. */
  readonly stat: SupportModeType;
  /** Materialized byte read. */
  readonly read: SupportModeType;
  /** Materialized byte write. */
  readonly write: SupportModeType;
  /** Streaming read after optimization policy is applied. */
  readonly streamRead: SupportModeType;
  /** Per-mode streaming write after optimization policy is applied. */
  readonly streamWrite: WriteSupportType;
  /** Byte-range read without or with facade materialization. */
  readonly rangeRead: SupportModeType;
  /** File copy route. Directory recursion remains facade-owned. */
  readonly copy: SupportModeType;
  /** Move route. An emulated move is copy followed by remove and is not atomic. */
  readonly move: SupportModeType;
  /** Long-lived asynchronous positional writes. */
  readonly positionalWrite: SupportModeType;
  /** Synchronous random access. */
  readonly syncAccess: SupportModeType;
}

/** Full synchronous inspection of one configured filesystem stack. */
export interface InspectionType {
  /** Concrete adapter diagnostic name. */
  readonly adapter: string;
  /** Adapter-native booleans and native write modes. */
  readonly native: AdapterType["capabilities"];
  /** Effective routes after facade emulation and optimization policy. */
  readonly support: SupportType;
  /** Portable hard limits known by the adapter. Missing fields mean unknown. */
  readonly limits: AdapterLimitsType;
  /** Physical partition policy when the adapter exposes one. */
  readonly partition?: AdapterPartitionType;
  /** Resolved optimization controls for this facade. */
  readonly optimizations: OptimizationType;
  /** Maximum facade-owned stream materialization before `too-large`. */
  readonly maxBufferedWriteBytes: number;
  /** Instrumentation cost selected for this facade. */
  readonly metricsMode: MetricsModeType;
  /** Detached current metrics snapshot. */
  readonly metrics: MetricsType;
}

/** Returns `native` only when both capability and optimization are enabled. */
function native(enabled: boolean, fallback: boolean): SupportModeType {
  return enabled ? "native" : fallback ? "emulated" : "unsupported";
}

/** Computes the effective operation routes for one configured adapter. */
export function getSupport(adapter: AdapterType, optimizations: OptimizationType): SupportType {
  const readable = adapter.capabilities.read;
  const writable = adapter.capabilities.write;
  const streamWrite = (mode: WriteModeType): SupportModeType => {
    const direct = optimizations.streamWrite && adapter.capabilities.streamWriteModes.includes(mode) && adapter.writeStream !== undefined;
    if (direct && adapter.partition?.stream === true) return "partitioned";
    return native(direct, writable);
  };

  return {
    stat: "native",
    read: readable ? "native" : "unsupported",
    write: writable ? "native" : "unsupported",
    streamRead: native(
      optimizations.streamRead && adapter.capabilities.streamRead && adapter.openReadStream !== undefined,
      readable,
    ),
    streamWrite: {
      replace: streamWrite("replace"),
      append: streamWrite("append"),
      update: streamWrite("update"),
    },
    rangeRead: native(optimizations.rangeRead && adapter.capabilities.rangeRead, readable),
    copy: native(
      optimizations.nativeCopy && adapter.capabilities.nativeCopy && adapter.copy !== undefined,
      readable && writable,
    ),
    move: native(
      optimizations.nativeMove && adapter.capabilities.nativeMove && adapter.move !== undefined,
      readable && writable,
    ),
    positionalWrite: adapter.capabilities.positionalWrite && adapter.openWritableFile !== undefined ? "native" : "unsupported",
    syncAccess: adapter.capabilities.syncAccess && adapter.openSyncFile !== undefined ? "native" : "unsupported",
  };
}
