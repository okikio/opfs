import { B2_UPLOAD_BYTES } from "./client.ts";
import type { B2ClientType } from "./client.ts";
import { DriverPlanInputSchema, DriverPlanSchema } from "../../driver/definition.ts";
import { defineObjectDriver } from "../../driver/object.ts";
import type { ObjectDriverType } from "../../driver/object.ts";

/**
 * Creates the B2 driver over a native Backblaze B2 client that you made.
 *
 * The driver borrows the client: closing the driver or a filesystem built on it
 * leaves the client, its credentials and its transport open, so you can keep
 * using the client for calls the filesystem does not model. Adds B2's upload limits; `fs.backend` keeps B2's version calls.
 *
 * @example
 * ```ts
 * const client = createB2Client({ authorization, bucketId, fetch, subtle: crypto.subtle });
 * const driver = createB2Driver(client);
 * ```
 */
export function createB2Driver(client: B2ClientType): ObjectDriverType<B2ClientType> {
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
