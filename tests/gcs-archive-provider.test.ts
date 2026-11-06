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
      // SDK 7.19.0 converts generation options through Number; only select an exactly representable fixture token.
      const select = (name: string, generation: string | undefined) => {
        if (
          generation === undefined || !Number.isSafeInteger(Number(generation)) ||
          String(Number(generation)) !== generation
        ) {
          throw new Error("The independent SDK cannot select this generation without numeric precision loss.");
        }
        return bucket.file(name, { generation });
      };
      const client = createGcsClient({ endpoint: fixture.endpoint, bucket: GCS_BUCKET, request: { retries: 0 } });
      const producerBytes = new Uint8Array([0, 17, 255, 42, 9]);
      await bucket.file("archive/sdk.bin").save(producerBytes, {
        resumable: false,
        validation: false,
        metadata: { storageClass: "ARCHIVE" },
      });
      const stat = await client.head("archive/sdk.bin");
      expect(stat?.storageClass).toBe("ARCHIVE");
      const [producerMetadata] = await select("archive/sdk.bin", stat?.version).getMetadata();
      expect(typeof producerMetadata.generation).toBe("string");
      expect(typeof producerMetadata.crc32c).toBe("string");
      expect(producerMetadata.crc32c).toMatch(/^[A-Za-z0-9+/]{5}[AQgw]==$/);
      expect(stat).toMatchObject({
        version: producerMetadata.generation,
        // The pinned emulator reports this constant; it does not model metadata version evolution or guards.
        metageneration: "1",
        crc32c: producerMetadata.crc32c,
      });
      expect(producerMetadata.metageneration).toBe("1");
      expect(
        new Uint8Array(
          await new Response(await client.get("archive/sdk.bin", { revision: stat!.revision! })).arrayBuffer(),
        ),
      )
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
      if (!result.complete) throw new Error("The candidate did not return a final publication receipt.");
      const file = select("archive/client.bin", result.receipt.version);
      const [metadata] = await file.getMetadata();
      expect(metadata.storageClass).toBe("ARCHIVE");
      expect(typeof metadata.generation).toBe("string");
      expect(typeof metadata.crc32c).toBe("string");
      expect(metadata.crc32c).toMatch(/^[A-Za-z0-9+/]{5}[AQgw]==$/);
      expect(metadata.metageneration).toBe("1");
      expect(result.receipt).toMatchObject({
        version: metadata.generation,
        metageneration: "1",
        crc32c: metadata.crc32c,
      });
      expect(await client.head("archive/client.bin", { revision: result.receipt.revision! }))
        .toMatchObject({ version: metadata.generation, metageneration: "1", crc32c: metadata.crc32c });
      const [download] = await file.download({ validation: false });
      expect(new Uint8Array(download)).toEqual(bytes);
      const listed = (await client.list({ prefix: "archive/" })).objects;
      expect(listed.map((entry) => entry.storageClass)).toEqual(["ARCHIVE", "ARCHIVE"]);
      expect(
        listed.map((entry) => ({
          key: entry.key,
          version: entry.version,
          metageneration: entry.metageneration,
          crc32c: entry.crc32c,
        })),
      )
        .toEqual([
          { key: "archive/client.bin", version: metadata.generation, metageneration: "1", crc32c: metadata.crc32c },
          {
            key: "archive/sdk.bin",
            version: producerMetadata.generation,
            metageneration: "1",
            crc32c: producerMetadata.crc32c,
          },
        ]);
      // SDK metadata equality proves retention; validation:false and constant metageneration do not prove checksum or guard enforcement.
    } catch (reason) {
      primary = [reason];
      throw reason;
    } finally {
      await close([() => fixture.close()], primary);
    }
  });
});
