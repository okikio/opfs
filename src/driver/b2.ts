import { B2_UPLOAD_BYTES, createB2Client } from "../b2.ts";
import type { B2ClientOptionsType, B2ClientType } from "../b2.ts";
import { DriverPlanInputSchema, DriverPlanSchema } from "./definition.ts";
import { defineObjectDriver } from "./object.ts";
import type { ObjectDriverType } from "./object.ts";

/** Attach upload-specific native limits while borrowing the caller's configured client. */
export function createB2DriverFromClient(client: B2ClientType): ObjectDriverType {
  const implementation = {
    code: "upload-bytes",
    kind: "hard",
    source: "implementation",
    unit: "bytes",
    value: B2_UPLOAD_BYTES,
  } as const;
  const policy = {
    code: "upload-bytes",
    kind: "policy",
    source: "user",
    unit: "bytes",
    value: client.maxUploadBytes,
  } as const;
  return defineObjectDriver(client, {
    name: "b2",
    ownership: "borrowed",
    limits: [implementation, ...(client.maxUploadBytes < B2_UPLOAD_BYTES ? [policy] : [])],
    plan(input) {
      const request = DriverPlanInputSchema.parse(input);
      const exceeded = request.operation === "write" && (request.size ?? 0) > client.maxUploadBytes;
      return DriverPlanSchema.parse({
        operation: request.operation,
        supported: !exceeded,
        support: exceeded ? "unsupported" : "native",
        problems: exceeded
          ? [{
            code: "upload-too-large",
            layer: "driver",
            severity: "error",
            message:
              "B2 single-file upload exceeds the configured upload budget; existing-object reads have no upload-size ceiling.",
            limit: client.maxUploadBytes < B2_UPLOAD_BYTES ? policy : implementation,
          }]
          : [],
        actions: exceeded ? [{ kind: "reduce-input" }, { kind: "select-driver" }] : [],
      });
    },
  });
}
/** Compose a native B2 client and object driver without performing network I/O. */
export function createB2Driver(options: B2ClientOptionsType): ObjectDriverType {
  return createB2DriverFromClient(createB2Client(options));
}
