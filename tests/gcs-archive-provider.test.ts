import { env } from "node:process";
import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { Storage } from "@google-cloud/storage";

import { close } from "../src/close.ts";
import { createGcsClient, GCS_CHUNK_BYTES } from "../src/gcs.ts";
import { GCS_BUCKET, openGcs } from "./provider/gcs.ts";

/** Emulator class receipts and independent SDK bytes; no live billing or retention proof. */
describe("GCS Archive native class interoperability", () => {
  it("exchanges complete Archive objects with the pinned official SDK", { timeout: 120_000 }, async () => {
    // This SDK reads the variable even with an explicit apiEndpoint. Never acquire ambient authority.
    if (env.STORAGE_EMULATOR_HOST !== undefined) {
      throw new Error("GCS SDK fixture refuses an ambient emulator override.");
    }
    const fixture = await openGcs();
    let primary: readonly unknown[] = [];
    try {
      const sdk = new Storage({
        apiEndpoint: fixture.endpoint,
        projectId: "fixture-project",
        useAuthWithCustomEndpoint: false,
      });
      const bucket = sdk.bucket(GCS_BUCKET);
      const client = createGcsClient({ endpoint: fixture.endpoint, bucket: GCS_BUCKET, request: { retries: 0 } });
      const producerBytes = new Uint8Array([0, 17, 255, 42, 9]);
      await bucket.file("archive/sdk.bin").save(producerBytes, {
        resumable: false,
        validation: false,
        metadata: { storageClass: "ARCHIVE" },
      });
      const stat = await client.head("archive/sdk.bin");
      expect(stat?.storageClass).toBe("ARCHIVE");
      expect(new Uint8Array(await new Response(await client.get("archive/sdk.bin")).arrayBuffer()))
        .toEqual(producerBytes);
      expect(
        new Uint8Array(
          await new Response(
            await client.get("archive/sdk.bin", {
              at: 1,
              length: 3,
              revision: stat!.revision!,
            }),
          ).arrayBuffer(),
        ),
      ).toEqual(producerBytes.slice(1, 4));

      const bytes = Uint8Array.from({ length: GCS_CHUNK_BYTES + 7 }, (_, index) => index % 251);
      const upload = await client.createUpload("archive/client.bin", {
        storageClass: "ARCHIVE",
        size: bytes.length,
        ifNoneMatch: "*",
      });
      expect(
        await client.writeUpload(upload, bytes.subarray(0, GCS_CHUNK_BYTES), {
          offset: 0,
          total: bytes.length,
        }),
      ).toEqual({ complete: false, offset: GCS_CHUNK_BYTES });
      const result = await client.writeUpload(upload, bytes.subarray(GCS_CHUNK_BYTES), {
        offset: GCS_CHUNK_BYTES,
        total: bytes.length,
        final: true,
      });
      expect(result).toMatchObject({ complete: true, receipt: { storageClass: "ARCHIVE", size: bytes.length } });
      const file = bucket.file("archive/client.bin");
      const [metadata] = await file.getMetadata();
      expect(metadata.storageClass).toBe("ARCHIVE");
      const [download] = await file.download({ validation: false });
      expect(new Uint8Array(download)).toEqual(bytes);
      expect((await client.list({ prefix: "archive/" })).objects.map((entry) => entry.storageClass))
        .toEqual(["ARCHIVE", "ARCHIVE"]);
    } catch (reason) {
      primary = [reason];
      throw reason;
    } finally {
      await close([() => fixture.close()], primary);
    }
  });
});
