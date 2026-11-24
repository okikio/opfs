import { R2_UPLOAD_BYTES } from "./client.ts";
import type { R2ClientType } from "./client.ts";
import { defineObjectDriver } from "../../driver/object.ts";
import type { ObjectDriverType } from "../../driver/object.ts";
import { DriverPlanInputSchema, DriverPlanSchema } from "../../driver/definition.ts";

/**
 * Creates the R2 driver over a Cloudflare R2 binding client that you made.
 *
 * The driver borrows the client: closing the driver or a filesystem built on it
 * leaves the client, its credentials and its transport open, so you can keep
 * using the client for calls the filesystem does not model. Keeps upload and read budgets apart from the size of objects already stored.
 *
 * @example
 * ```ts
 * const client = createR2Client(env.BUCKET);
 * const driver = createR2Driver(client);
 * ```
 */
export function createR2Driver(client: R2ClientType): ObjectDriverType<R2ClientType> {
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
