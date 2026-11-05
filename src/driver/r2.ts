import { createR2Client, R2_UPLOAD_BYTES } from "../r2.ts";
import type { R2BindingType, R2ClientOptionsType, R2ClientType } from "../r2.ts";
import { defineObjectDriver } from "./object.ts";
import type { ObjectDriverType } from "./object.ts";
import { DriverPlanInputSchema, DriverPlanSchema } from "./definition.ts";

/** Borrow an R2 client and preserve upload/read budgets separately from existing object size. */
export function createR2DriverFromClient(client: R2ClientType): ObjectDriverType {
  return defineObjectDriver(client, {
    name: "r2",
    ownership: "borrowed",
    limits: [
      { code: "upload-bytes", kind: "hard", source: "implementation", unit: "bytes", value: R2_UPLOAD_BYTES },
      { code: "upload-bytes", kind: "policy", source: "user", unit: "bytes", value: client.maxUploadBytes },
      { code: "read-bytes", kind: "policy", source: "user", unit: "bytes", value: client.maxReadBytes },
    ],
    plan(input) {
      const request = DriverPlanInputSchema.parse(input);
      const failed = request.operation === "write" && (request.size ?? 0) > client.maxUploadBytes;
      return DriverPlanSchema.parse({
        operation: request.operation,
        supported: !failed,
        support: failed ? "unsupported" : "native",
        problems: failed
          ? [{
            code: "upload-too-large",
            layer: "driver",
            severity: "error",
            message: "R2 upload exceeds its materialized-byte policy.",
          }]
          : [],
        actions: failed ? [{ kind: "reduce-input" }] : [],
      });
    },
  });
}
/** No binding acquisition occurs: the caller injects its actual bucket. */
export function createR2Driver(binding: R2BindingType, options: R2ClientOptionsType = {}): ObjectDriverType {
  return createR2DriverFromClient(createR2Client(binding, options));
}
