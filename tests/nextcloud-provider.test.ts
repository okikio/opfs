import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { NEXTCLOUD_MIN_CHUNK_BYTES, NextcloudClient, NextcloudPublicationError } from "../src/nextcloud.ts";
import { createWebdavClient } from "../src/webdav.ts";
import { NEXTCLOUD_ORACLE_BYTES, startNextcloud } from "./provider/nextcloud.ts";
import { withReleases } from "./close.ts";

describe("native Nextcloud local-backend chunk wire interoperability", () => {
  it(
    "assembles full bytes read independently, preserves create-only targets, refuses incomplete assembly and isolates users",
    { timeout: 300_000 },
    async () => {
      await withReleases(async (release) => {
        const fixture = await startNextcloud();
        release.push(() => fixture.close());
        const client = new NextcloudClient({
          endpoint: fixture.endpoint,
          user: "fixture",
          allowHttp: true,
          credentials: () => fixture.authorization,
        });
        await fixture.oracle("produce", "oracle.txt");
        const dav = createWebdavClient({
          endpoint: `${fixture.endpoint}remote.php/dav/files/fixture/`,
          headers: { Authorization: fixture.authorization },
        });
        const producer = await dav.get("oracle.txt");
        expect(await new Response(producer).text()).toBe(NEXTCLOUD_ORACLE_BYTES);
        const size = NEXTCLOUD_MIN_CHUNK_BYTES + 17;
        const bytes = Uint8Array.from({ length: size }, (_, i) => i % 251);
        const session = await client.createUpload("native-multipart", "candidate.bin", size, {
          chunkSize: NEXTCLOUD_MIN_CHUNK_BYTES,
        });
        const first = await client.putPart(session, 1, bytes.subarray(0, NEXTCLOUD_MIN_CHUNK_BYTES));
        const second = await client.putPart(session, 2, bytes.subarray(NEXTCLOUD_MIN_CHUNK_BYTES));
        expect((await client.finishUpload(session, [first, second])).status).toBe(201);
        expect(await fixture.oracle("check", "candidate.bin", size)).toEqual({ size, equal: true });

        const conflict = await client.createUpload("native-conflict", "oracle.txt", 3);
        const conflictPart = await client.putPart(conflict, 1, new Uint8Array([1, 2, 3]));
        await expect(client.finishUpload(conflict, [conflictPart])).rejects.toBeInstanceOf(NextcloudPublicationError);
        expect(await fixture.oracle("read", "oracle.txt")).toBe(NEXTCLOUD_ORACLE_BYTES);
        await client.abortUpload(conflict);

        const incomplete = await client.createUpload("native-partial", "partial.bin", size, {
          chunkSize: NEXTCLOUD_MIN_CHUNK_BYTES,
        });
        await client.putPart(incomplete, 1, bytes.subarray(0, NEXTCLOUD_MIN_CHUNK_BYTES));
        // Deliberately forged caller evidence cannot prove remote completeness. The server must reject the mismatched total.
        await expect(client.finishUpload(incomplete, [first, second])).rejects.toBeInstanceOf(
          NextcloudPublicationError,
        );
        expect(await fixture.oracle("missing", "partial.bin")).toBe(true);
        await client.abortUpload(incomplete);

        const aborted = await client.createUpload("native-abort", "aborted.bin", 3);
        await client.putPart(aborted, 1, new Uint8Array([1, 2, 3]));
        await client.abortUpload(aborted);
        await expect(client.putPart(aborted, 1, new Uint8Array([1, 2, 3]))).rejects.toBeInstanceOf(
          NextcloudPublicationError,
        );
        expect(await fixture.oracle("missing", "aborted.bin")).toBe(true);
        const other = new NextcloudClient({
          endpoint: fixture.endpoint,
          user: "other-user",
          allowHttp: true,
          credentials: () => fixture.authorization,
        });
        await expect(other.createUpload("denied", "forbidden.bin", 3)).rejects.toBeInstanceOf(
          NextcloudPublicationError,
        );
      });
    },
  );
});
