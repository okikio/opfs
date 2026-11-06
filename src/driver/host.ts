import { z } from "zod";
import { FileSystemError } from "../error.ts";
import { DriverPlanInputSchema, type DriverPlanInputType, type DriverPlanType } from "./definition.ts";
import type { FileDriverCapabilitiesType, PublicationType } from "./file.ts";

/** Immutable declaration for one trusted host root; false means a route is not admitted. */
export interface HostProfileType {
  /** Diagnostic deployment/mode identity, never inferred from a path. */
  readonly name: string;
  /** Authority of the declaration, independently from actual runtime observations. */
  readonly source: "assumption" | "provider" | "user";
  /** Explicit mutation policy, not a live permission check. */
  readonly readOnly: boolean;
  /** Permits exclusive creation of an owned empty staging sibling. */
  readonly reserve: boolean;
  /** Permits native copy into an already reserved staging file. */
  readonly copyFile: boolean;
  /** Permits hard-link publication to an absent destination. */
  readonly hardLink: boolean;
  /** Failure boundary of native rename for this deployment. */
  readonly rename: "preserve" | "best-effort" | "unsupported";
  /** Admitted complete/streamed write semantics. */
  readonly writeModes: readonly ("replace" | "append" | "update")[];
  /** Permits acquisition of a mutable positional resource. */
  readonly positionalWrite: boolean;
  /** Permits acquisition of a mutable synchronous resource. */
  readonly syncAccess: boolean;
}

/** Validates complete caller declarations before root creation or descriptor acquisition. */
export const HostProfileSchema: z.ZodType<HostProfileType, HostProfileType> = z.object({
  name: z.string().min(1),
  source: z.enum(["assumption", "provider", "user"]),
  readOnly: z.boolean(),
  reserve: z.boolean(),
  copyFile: z.boolean(),
  hardLink: z.boolean(),
  rename: z.enum(["preserve", "best-effort", "unsupported"]),
  writeModes: z.array(z.enum(["replace", "append", "update"])).readonly(),
  positionalWrite: z.boolean(),
  syncAccess: z.boolean(),
}).strict();

/** Takes a detached validated snapshot before any native root creation. */
function snapshot(input: unknown): HostProfileType {
  const value = HostProfileSchema.parse(input);
  return Object.freeze({ ...value, writeModes: Object.freeze([...new Set(value.writeModes)]) });
}

/**
 * Conservative mode-specific profiles; the application owns selecting the actual mount mode.
 *
 * Native assumes ordinary host primitives. Mountpoint describes general-purpose S3 buckets with
 * allow-overwrite/allow-delete, excluding S3 Express incremental upload. BlobFuse describes block-blob
 * storage: hard links are unavailable and remote rename is copy/delete. Mutable resources in these mount
 * presets are conservatively unadmitted; creation/append evidence alone does not prove those workflows.
 * Neither preset proves durability.
 */
export const HOST_PROFILES: Readonly<Record<"native" | "mountpoint-s3" | "blobfuse-block", HostProfileType>> = Object
  .freeze({
    native: snapshot({
      name: "native",
      source: "assumption",
      readOnly: false,
      reserve: true,
      copyFile: true,
      hardLink: true,
      rename: "preserve",
      writeModes: ["replace", "append", "update"],
      positionalWrite: true,
      syncAccess: true,
    }),
    "mountpoint-s3": snapshot({
      name: "mountpoint-s3",
      source: "provider",
      readOnly: false,
      reserve: true,
      copyFile: false,
      hardLink: false,
      rename: "unsupported",
      writeModes: ["replace"],
      positionalWrite: false,
      syncAccess: false,
    }),
    "blobfuse-block": snapshot({
      name: "blobfuse-block",
      source: "provider",
      readOnly: false,
      reserve: true,
      copyFile: true,
      hardLink: false,
      rename: "best-effort",
      writeModes: ["replace", "append", "update"],
      positionalWrite: false,
      syncAccess: false,
    }),
  });

/** Named preset or complete caller-declared facts for one trusted root. */
export type HostProfileInputType = keyof typeof HOST_PROFILES | HostProfileType;

/** Validates configuration without I/O; declarations cannot change after driver construction. */
export function resolveHostProfile(input: HostProfileInputType = "native"): HostProfileType {
  try {
    return snapshot(typeof input === "string" ? HOST_PROFILES[input] : input);
  } catch (cause) {
    throw new TypeError("Invalid host profile.", { cause });
  }
}

/** Native feature flags are derived from mechanics, never used as publication admission by themselves. */
export function getHostCapabilities(profile: HostProfileType): FileDriverCapabilitiesType {
  const writable = !profile.readOnly;
  return {
    read: true,
    write: writable,
    streamRead: true,
    rangeRead: true,
    streamWriteModes: writable ? [...profile.writeModes] : [],
    copy: writable && profile.reserve && profile.copyFile && (profile.hardLink || profile.rename === "preserve"),
    move: writable && profile.rename !== "unsupported",
    positionalWrite: writable && profile.positionalWrite,
    syncAccess: writable && profile.syncAccess,
  };
}

/** Summary facts supplement the option-sensitive admission result; no unsupported primitive becomes a promise. */
export function getHostPublication(profile: HostProfileType): PublicationType {
  const capabilities = getHostCapabilities(profile);
  const copyNoReplace = capabilities.copy && profile.reserve && profile.copyFile && profile.hardLink
    ? "atomic" as const
    : "unsupported" as const;
  const moveNoReplace = capabilities.move ? "cooperative" as const : "unsupported" as const;
  return Object.freeze({
    copy: capabilities.copy ? "preserve" : "unsupported",
    move: !capabilities.move ? "unsupported" : profile.rename === "preserve" ? "preserve" : "best-effort",
    // Unsupported operations do not weaken an admitted sibling's guarantee.
    noReplace: moveNoReplace === "cooperative" ? "cooperative" : copyNoReplace,
    copyNoReplace,
    moveNoReplace,
    durability: "acknowledged",
  });
}

/**
 * Admits the actual host route before metadata, parent creation, staging, or source acquisition.
 * Intent survives facade copy-to-write translation, so a supported body writer cannot erase publication policy.
 */
export function admitHost(profile: HostProfileType, input: DriverPlanInputType): DriverPlanType {
  const request = DriverPlanInputSchema.parse(input);
  const intent = request.intent ?? request.operation;
  let code: string | undefined;
  let requirement = "";
  if (profile.readOnly && !["read", "stat", "list"].includes(request.operation)) {
    code = "host-read-only";
    requirement = "a writable root";
  } else if (
    request.operation === "write" && request.mode !== undefined && !profile.writeModes.includes(request.mode)
  ) {
    code = "host-write-mode";
    requirement = `write mode '${request.mode}'`;
  } else if (intent === "copy" || intent === "move") {
    if (request.operation === "write") {
      if (request.exclusive && !request.overwrite) {
        code = "host-no-replace";
        requirement = "atomic no-replace publication";
      } else if (request.preserve !== false && !(profile.reserve && profile.rename === "preserve")) {
        code = "host-publication";
        requirement = "owned staging and failure-preserving rename";
      }
    } else if (request.operation === "copy") {
      if (!(profile.reserve && profile.copyFile)) {
        code = "host-copy-stage";
        requirement = "copy into an exclusively reserved sibling";
      } else if (request.overwrite ? profile.rename !== "preserve" : !profile.hardLink) {
        code = "host-publication";
        requirement = request.overwrite ? "failure-preserving rename" : "hard-link publication";
      }
    } else if (request.operation === "move") {
      if (profile.rename === "unsupported" || (request.preserve !== false && profile.rename !== "preserve")) {
        code = "host-publication";
        requirement = request.preserve === false ? "native rename" : "failure-preserving rename";
      } else if (request.exclusive && !request.overwrite) {
        code = "host-no-replace";
        requirement = "atomic no-replace rename";
      }
    }
  }
  return {
    operation: request.operation,
    supported: code === undefined,
    support: code === undefined ? "native" : "unsupported",
    problems: code === undefined ? [] : [{
      code,
      layer: "driver",
      severity: "error",
      message: `Host profile '${profile.name}' does not admit ${requirement}.`,
    }],
    actions: code === undefined
      ? []
      : [{ kind: "select-driver", detail: "Select a compatible root/profile or an object adapter." }],
  };
}

/** Converts only a declared admission failure, retaining the structured plan as its cause. */
export function assertHostAdmission(plan: DriverPlanType, path?: string): void {
  if (!plan.supported) {
    throw new FileSystemError(
      "not-supported",
      plan.operation,
      path,
      plan.problems.map((problem) => problem.message).join(" "),
      plan,
    );
  }
}

/** Rejects a specific resource primitive without opening a native descriptor. */
export function assertHostPrimitive(
  profile: HostProfileType,
  primitive: "reserve" | "positionalWrite" | "syncAccess",
  path: string,
): void {
  if (profile.readOnly || !profile[primitive]) {
    throw new FileSystemError(
      "not-supported",
      primitive,
      path,
      `Host profile '${profile.name}' does not admit '${primitive}'.`,
    );
  }
}
