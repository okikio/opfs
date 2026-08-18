import type { AdapterType } from "./adapter/definition.ts";
import type { DriverInspectionType } from "./driver/definition.ts";
import type { DriverMetricsType, MetricsType } from "./metrics.ts";
import type {
  AdapterLimitsType,
  AdapterPartitionType,
  MetricsModeType,
  OptimizationType,
  SupportModeType,
  WriteModeType,
} from "./schema.ts";

/**
 * Effective support for one write mode.
 *
 * This is already post-translation and post-policy. A mode can be native,
 * emulated, partitioned, or unsupported even when the underlying driver exposes
 * related lower-level capabilities.
 */
export type WriteSupportType = Readonly<Record<WriteModeType, SupportModeType>>;

/**
 * Effective filesystem routes after adapter primitives and facade fallbacks are combined.
 *
 * This is the route table most callers care about when deciding whether a given
 * `FileSystemType` is suitable for a workload.
 */
export interface SupportType {
  /** Metadata lookup support. */
  readonly stat: SupportModeType;
  /** Whole-file read support. */
  readonly read: SupportModeType;
  /** Whole-file write support. */
  readonly write: SupportModeType;
  /** Streaming read support. */
  readonly streamRead: SupportModeType;
  /** Streaming write support per write mode. */
  readonly streamWrite: WriteSupportType;
  /** Byte-range read support. */
  readonly rangeRead: SupportModeType;
  /** Copy support for files or trees. */
  readonly copy: SupportModeType;
  /** Move support for files or trees. */
  readonly move: SupportModeType;
  /** Long-lived positional write support. */
  readonly positionalWrite: SupportModeType;
  /** Synchronous random-access support. */
  readonly syncAccess: SupportModeType;
}

/**
 * Adapter translation report kept distinct from backend-driver state.
 *
 * This lets diagnostics show what the translation layer added or constrained
 * without flattening it into the driver report.
 */
export interface AdapterInspectionType {
  /** Stable adapter name. */
  readonly name: string;
  /** Native adapter capabilities before facade fallbacks are considered. */
  readonly native: AdapterType["capabilities"];
  /** Translation-layer limits, such as record payload ceilings. */
  readonly limits?: AdapterLimitsType;
  /** Translation-layer partition behavior when the adapter exposes one. */
  readonly partition?: AdapterPartitionType;
}

/**
 * Full synchronous inspection of one configured storage stack.
 *
 * This is the main no-I/O snapshot for tooling, debugging, and tests. It keeps
 * driver truth, adapter truth, facade policy, and both metric layers visible in
 * one detached object.
 */
export interface InspectionType {
  /** Backend-native persistence report with requirements and limit provenance. */
  readonly driver: DriverInspectionType;
  /** OPFS translation routes and compatibility summaries. */
  readonly adapter: AdapterInspectionType;
  /** Effective routes exposed by FileSystemType. */
  readonly support: SupportType;
  /** Resolved facade optimization switches. */
  readonly optimizations: OptimizationType;
  /** Maximum facade-owned stream materialization. */
  readonly maxBufferedWriteBytes: number;
  /** Instrumentation cost selected for this facade. */
  readonly metricsMode: MetricsModeType;
  /** Detached logical filesystem metrics snapshot. */
  readonly metrics: MetricsType;
  /** Detached physical driver metrics when the driver collects them. */
  readonly driverMetrics?: DriverMetricsType;
}

/**
 * Returns native support when enabled, otherwise a safe facade fallback when available.
 *
 * The helper keeps the route table consistent: native wins when explicitly
 * enabled, emulated is reported only when the facade can preserve the request
 * honestly enough, and unsupported means there is no safe route.
 */
function native(enabled: boolean, fallback: boolean): SupportModeType {
  return enabled ? "native" : fallback ? "emulated" : "unsupported";
}

/**
 * Computes effective routes for one configured adapter and facade policy.
 *
 * The result answers the practical question, "What can this configured
 * filesystem do right now, and which paths are native versus emulated?"
 */
export function getSupport(adapter: AdapterType, optimizations: OptimizationType): SupportType {
  const readable = adapter.capabilities.read;
  const writable = adapter.capabilities.write;
  const streamWrite = (mode: WriteModeType): SupportModeType => {
    const direct = optimizations.streamWrite && adapter.capabilities.streamWriteModes.includes(mode) &&
      adapter.writeStream !== undefined;
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
    streamWrite: { replace: streamWrite("replace"), append: streamWrite("append"), update: streamWrite("update") },
    rangeRead: native(optimizations.rangeRead && adapter.capabilities.rangeRead, readable),
    copy: native(
      optimizations.nativeCopy && adapter.capabilities.nativeCopy && adapter.copy !== undefined,
      readable && writable,
    ),
    move: native(
      optimizations.nativeMove && adapter.capabilities.nativeMove && adapter.move !== undefined,
      readable && writable,
    ),
    positionalWrite: adapter.capabilities.positionalWrite && adapter.openWritableFile !== undefined
      ? "native"
      : "unsupported",
    syncAccess: adapter.capabilities.syncAccess && adapter.openSyncFile !== undefined ? "native" : "unsupported",
  };
}
