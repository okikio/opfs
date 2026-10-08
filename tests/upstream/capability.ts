import type { OpfsCapabilitiesType } from "../../src/probe.ts";

/** Only absent APIs or explicit native policy denial justify skipping byte conformance cases. */
export function unavailable(probe: OpfsCapabilitiesType): string | undefined {
  if (probe.rootAvailable) return undefined;
  const reason = JSON.stringify(probe);
  if (["NotSupportedError", "SecurityError", "NotAllowedError"].includes(probe.rootError?.name ?? "")) return reason;
  throw new Error(`Native OPFS acquisition failed before the upstream case: ${reason}`);
}
