/** Independent SDK/local-emulator observations, with authored originals and no production client imports. */
import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import process from "node:process";
import { withReleases } from "./close.ts";
import { openVercel } from "./fixtures/vercel/create.ts";

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected native Vercel receipt object.");
  }
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 128) throw new Error("Expected bounded native Vercel observation list.");
  return value;
}
function original(seed: number): Buffer<ArrayBuffer> {
  return Buffer.from(Uint8Array.from({ length: 131072 }, (_, i) => (i * seed + (i >>> 8)) & 255));
}

describe("pinned Vercel SDK2.8.2 and emulator0.13.0 local public-store observations", () => {
  it("exchanges complete independent originals through SDK and literal HTTP while preserving conditional refusals", {
    timeout: 180000,
  }, async () => {
    const directory = process.env.OPFS_VERCEL_ARTIFACTS, closureSha256 = process.env.OPFS_VERCEL_CLOSURE_SHA256;
    if (!directory || !closureSha256 || process.env.OPFS_VERCEL_EXECUTION_REVIEWED !== "2.8.2+0.13.0-test-only") {
      throw new Error(
        "Vercel needs exact owner-reviewed offline execution admission; inert acquisition is insufficient.",
      );
    }
    await withReleases(async (releases) => {
      const fixture = await openVercel({ directory, closureSha256, reviewedForTestExecution: true });
      releases.push(() => fixture.close());
      const receipt = await fixture.observe();
      // Persist observed successes and failures before assertions; only fixture-generated data enters this receipt.
      console.log(JSON.stringify({ vercelNativeObservations: receipt }));
      expect(receipt.profile).toBe("vercel-blob-2.8.2-emulator-0.13.0-native-v1");
      expect(object(receipt.admission).closureSha256).toBe(closureSha256);
      expect(object(receipt.admission).missingStandaloneNotices).toEqual(["is-node-process@1.2.0"]);
      const sdkToRaw = array(receipt.sdkToRaw).map(object), rawToSdk = array(receipt.rawToSdk).map(object);
      expect(sdkToRaw.length).toBe(2);
      expect(rawToSdk.length).toBe(2);
      for (const [index, item] of sdkToRaw.entries()) {
        const expected = index === 0 ? Buffer.alloc(0) : original(17);
        expect(item.status).toBe(200);
        expect(item.bytes).toBe(expected.toString("base64"));
        const metadata = object(item.metadata), written = object(item.receipt);
        expect(metadata.pathname).toBe("sdk-" + index);
        expect(metadata.size).toBe(expected.length);
        expect(metadata.etag).toBe(written.etag);
        expect(typeof written.etag).toBe("string");
      }
      for (const [index, item] of rawToSdk.entries()) {
        const expected = index === 0 ? Buffer.alloc(0) : original(29);
        expect(item.status).toBe(200);
        expect(object(item.selected).status).toBe(200);
        expect(object(item.selected).bytes).toBe(expected.toString("base64"));
        expect(object(item.receipt).pathname).toBe("raw-" + index);
        // PUT acknowledgements have no size field; independently acquired HEAD metadata supplies that observation.
        expect(object(item.metadata).size).toBe(expected.length);
        expect(object(item.metadata).etag).toBe(object(item.receipt).etag);
      }
      expect(receipt.createOnlyRejected).toBe(true);
      expect(receipt.staleRejected).toBe(true);
      expect(receipt.afterRefusals).toBe(original(17).toString("base64"));
      expect(receipt.afterMatched).toBe(Buffer.from([17, 0, 251]).toString("base64"));
      expect(receipt.cache).toEqual({ status: 304, bytes: 0 });
      const pages = array(receipt.pages).map(object);
      expect(pages.length).toBe(2);
      expect(pages[0]!.hasMore).toBe(true);
      expect(pages[1]!.hasMore).toBe(false);
      expect(pages.flatMap((page) => array(page.blobs).map(object).map((blob) => blob.pathname))).toEqual([
        "raw-0",
        "raw-1",
      ]);
      expect(receipt.deleted).toBe(404);
      expect(receipt.missing).toBe(true);
      expect(receipt.preAbortRejected).toBe(true);
      expect(receipt.preAbortReadback).toBe(404);
      const requests = array(receipt.requests).map(object), api = requests.filter((entry) => entry.api === true);
      expect(api.length).toBeGreaterThan(0);
      expect(api.every((entry) => entry.authorization === true && entry.recognizedSyntheticToken === true)).toBe(true);
      expect(api.every((entry) => entry.apiVersion === "13" && entry.storeID === "fixture")).toBe(true);
      expect(api.some((entry) => entry.requestIDPresent === true)).toBe(true);
      expect(api.filter((entry) => entry.method === "PUT" && entry.status === 400).length).toBe(1);
      expect(api.filter((entry) => entry.method === "PUT" && entry.status === 412).length).toBe(1);
      const publicReads = requests.filter((entry) => entry.path === "/blob/fixture/sdk-0" && entry.method === "GET");
      expect(publicReads.some((entry) => entry.authorization === false && entry.status === 200)).toBe(true);
      const sdkReads = requests.filter((entry) => entry.path === "/blob/fixture/raw-1" && entry.method === "GET");
      // The native SDK sends its token for public GET; the proposed first-party public-read policy deliberately differs.
      expect(sdkReads.some((entry) => entry.authorization === true && entry.status === 200)).toBe(true);
      const large = api.find((entry) =>
        entry.method === "PUT" && entry.payloadBytes === 131072 &&
        entry.payloadSha256 === createHash("sha256").update(original(17)).digest("hex")
      );
      expect(large).toBeDefined();
      expect(large!.randomSuffix).toBe("0");
      expect(large!.overwrite).toBe("0");
      expect(
        api.some((entry) =>
          entry.method === "PUT" && entry.payloadBytes === 3 && entry.ifMatch === true && entry.status === 200
        ),
      ).toBe(true);
      expect(api.some((entry) => entry.method === "POST" && entry.path === "/api/blob/delete" && entry.status === 200))
        .toBe(true);
    });
  });
});
