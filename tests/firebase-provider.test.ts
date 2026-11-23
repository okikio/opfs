import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { FirebaseClient, FirebaseError, FirebasePublicationError } from "../src/firebase.ts";
import { FIREBASE_BUCKET, FIREBASE_BYTES, FIREBASE_TEST_TOKEN, openFirebaseFixture } from "./provider/firebase.ts";
import { withReleases } from "./close.ts";
describe("official Firebase Storage emulator and independent SDK", () => {
  it(
    "cross-reads complete bytes, ranges, Rules, metadata and native resumable receipts",
    { timeout: 600_000 },
    async () => {
      await withReleases(async (releases) => {
        const fixture = await openFirebaseFixture();
        releases.push(() => fixture.close());
        const client = new FirebaseClient({ bucket: FIREBASE_BUCKET, endpoint: fixture.endpoint, allowHttp: true });
        await fixture.sdk("seed", "allowed/producer.txt", FIREBASE_BYTES);
        expect(new TextDecoder().decode(await client.read("allowed/producer.txt"))).toBe(FIREBASE_BYTES);
        expect(new TextDecoder().decode(await client.read("allowed/producer.txt", { at: 2, length: 5 }))).toBe(
          FIREBASE_BYTES.slice(2, 7),
        );
        expect((await client.listPage("allowed/")).items).toContain("allowed/producer.txt");
        const bytes = new TextEncoder().encode("native Firebase multipart receipt");
        const uploaded = await client.upload("allowed/native.txt", bytes, {
          contentType: "text/plain",
          customMetadata: { author: "candidate" },
        });
        expect(uploaded.size).toBe(bytes.length);
        expect(JSON.parse(await fixture.sdk("read", "allowed/native.txt"))).toEqual(Array.from(bytes));
        const updated = await client.updateMetadata("allowed/native.txt", { customMetadata: { author: "updated" } });
        expect(updated.customMetadata?.author).toBe("updated");
        const denied = new FirebaseClient({ bucket: FIREBASE_BUCKET, endpoint: fixture.endpoint, allowHttp: true });
        await expect(denied.stat("denied/file")).rejects.toBeInstanceOf(FirebaseError);
        await expect(denied.upload("denied/file", bytes)).rejects.toBeInstanceOf(FirebasePublicationError);
        await fixture.sdk("seed", "authenticated/user.txt", FIREBASE_BYTES);
        await expect(denied.read("authenticated/user.txt")).rejects.toBeInstanceOf(FirebaseError);
        const authenticated = new FirebaseClient({
          bucket: FIREBASE_BUCKET,
          endpoint: fixture.endpoint,
          allowHttp: true,
          credentials: () => ({ idToken: FIREBASE_TEST_TOKEN }),
        });
        expect(new TextDecoder().decode(await authenticated.read("authenticated/user.txt"))).toBe(FIREBASE_BYTES);
        const session = await client.startUpload("allowed/resumable.txt", bytes.length, { contentType: "text/plain" });
        expect((await client.statusUpload(session)).offset).toBe(0);
        const receipt = await client.writeUpload(session, 0, bytes, { finalize: true });
        expect(receipt.state).toBe("published");
        expect(JSON.parse(await fixture.sdk("read", "allowed/resumable.txt"))).toEqual(Array.from(bytes));
        const large = new Uint8Array(262144 + 17).fill(31);
        const resumed = await client.startUpload("allowed/chunked.bin", large.length);
        expect((await client.writeUpload(resumed, 0, large.subarray(0, 262144), { finalize: false })).state).toBe(
          "active",
        );
        expect(await client.statusUpload(resumed)).toEqual({
          state: "active",
          offset: 262144,
          size: large.length,
          evidence: "session-status",
        });
        expect((await client.writeUpload(resumed, 262144, large.subarray(262144), { finalize: true })).state).toBe(
          "published",
        );
        expect(JSON.parse(await fixture.sdk("read", "allowed/chunked.bin"))).toEqual(Array.from(large));
        const abandoned = await client.startUpload("allowed/cancelled.txt", 3);
        await client.cancelUpload(abandoned);
        await client.deleteObject("allowed/native.txt");
        await expect(client.stat("allowed/native.txt")).rejects.toBeInstanceOf(FirebaseError);
      });
    },
  );
});
