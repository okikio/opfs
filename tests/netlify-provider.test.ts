/** Official SDK/server observations only. This file does not qualify an OPFS Netlify client. */
import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import process from "node:process";
import { openNetlify } from "./provider/netlify.ts";
import { withReleases } from "./close.ts";

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected official SDK receipt object.");
  }
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 128) throw new Error("Expected bounded native observation list.");
  return value;
}

describe("pinned Netlify11.1.7 local SDK wire observations", () => {
  it("compares complete authored bytes and preserves conditional, authentication and retry limitations", {
    timeout: 180000,
  }, async () => {
    const directory = process.env.OPFS_NETLIFY_ARTIFACTS, closureSha256 = process.env.OPFS_NETLIFY_CLOSURE_SHA256;
    if (!directory || !closureSha256 || process.env.OPFS_NETLIFY_EXECUTION_REVIEWED !== "11.1.7-test-only") {
      throw new Error(
        "Netlify fixture needs an exact admitted closure and explicit test-only execution review; acquisition alone does not authorize imported code.",
      );
    }
    await withReleases(async (releases) => {
      const fixture = await openNetlify({ directory, closureSha256, reviewedForTestExecution: true });
      releases.push(() => fixture.close());
      const receipt = await fixture.observe();
      // Preserve failed observations too. The fixture records only safe comparisons and header presence.
      console.log(JSON.stringify({ netlifyNativeObservations: receipt }));
      expect(receipt.profile).toBe("netlify-blobs-11.1.7-local-sdk-observations-v1");
      expect(receipt.candidate).toBe(false);
      const roundtrips = array(receipt.roundtrips).map(object);
      expect(roundtrips.length).toBe(2);
      const original = Buffer.from(Uint8Array.from({ length: 131072 }, (_, i) => (i * 31 + (i >>> 8)) & 255));
      expect(roundtrips[0]!.bytes).toBe("");
      expect(typeof roundtrips[1]!.bytes).toBe("string");
      expect(Buffer.from(roundtrips[1]!.bytes as string, "base64").equals(original)).toBe(true);
      const metadata = { origin: "authored", label: "café / 雪 / ☁️", "κλειδί": { present: true, empty: "" } };
      for (const item of roundtrips) {
        expect(object(item.receipt).modified).toBe(true);
        expect(typeof object(item.receipt).etag).toBe("string");
        expect(item.metadata).toEqual(metadata);
        expect(item.dataMetadata).toEqual(metadata);
        expect(item.headEtag).toBeNull(); // The local HEAD implementation omits an ETag; a PUT receipt is different evidence.
      }
      expect(receipt.refused).toEqual({ modified: false });
      expect(receipt.stale).toEqual({ modified: false });
      expect(receipt.afterRefusals).toBe(original.toString("base64"));
      expect(object(receipt.matched).modified).toBe(true);
      expect(receipt.afterMatched).toBe(Buffer.from([1, 2, 3]).toString("base64"));
      expect(receipt.cache).toEqual({ etag: null, hasData: true }); // If-None-Match is a cache condition, never an immutable revision guard.
      const pages = array(receipt.pages).map(object);
      expect(pages.length).toBe(1); // This local server provides no production pagination qualification.
      // Pinned server API_URL_PATH captures the query in store_name for keyless lists, then appends
      // another ?signature suffix. Confirm that defect separately from actual object availability.
      expect(array(pages[0]!.blobs)).toEqual([]);
      const unfilteredPages = array(receipt.unfilteredPages).map(object);
      expect(unfilteredPages.length).toBe(1);
      expect(array(unfilteredPages[0]!.blobs).map(object).map((entry) => entry.key).sort()).toEqual([
        "roundtrip-0",
        "roundtrip-1",
      ]);
      const lists = array(receipt.listObservations).map(object);
      expect(lists.length).toBe(2);
      expect(lists[0]!.authoredPrefix).toBe(false);
      expect(lists[0]!.prefixHasSignatureSuffix).toBe(true);
      expect(lists[1]!.noPrefix).toBe(true);
      expect(lists[1]!.prefixHasSignatureSuffix).toBe(false);
      expect(receipt.absent).toBeNull();
      expect(receipt.wrongTokenRejected).toBe(true);
      expect(receipt.streamCanceled).toBe(true); // Returned response consumption only; the SDK exposes no request AbortSignal.
      expect(receipt.uncertain).toEqual({ modified: false });
      expect(receipt.uncertainAttempts).toBe(2);
      expect(receipt.publishedAfterFalse).toBe(Buffer.from([7, 0, 255]).toString("base64"));
      const requests = array(receipt.requests).map(object),
        capabilities = requests.filter((request) => request.capability === true);
      expect(capabilities.length).toBeGreaterThan(0);
      expect(capabilities.every((request) => request.authorization === false && request.api === false)).toBe(true);
      expect(requests.filter((request) => request.api === true).every((request) => request.authorization === true))
        .toBe(true);
      expect(capabilities.some((request) => request.ifNoneMatch === "*")).toBe(true);
      expect(capabilities.some((request) => request.ifMatch === true)).toBe(true);
      const negotiations = requests.filter((request) => request.negotiation === true);
      expect(negotiations.length).toBeGreaterThan(0);
      const emptyHash = createHash("sha256").digest("hex");
      for (const request of negotiations) {
        expect(request.api).toBe(true);
        expect(request.capability).toBe(false);
        expect(request.payloadBytes).toBe(0);
        expect(request.payloadSha256).toBe(emptyHash);
        expect(request.ifMatch).toBe(false);
        expect(request.ifNoneMatch).toBeNull();
        expect(request.internalMetadata).toBe(false);
      }
      for (const request of capabilities) {
        expect(request.negotiation).toBe(false);
        expect(request.externalMetadata).toBe(false);
      }
      // Compare the two actual stages, not only the presence of a capability URL somewhere in the transcript.
      for (let index = 0; index < requests.length; index++) {
        const first = requests[index]!;
        if (first.negotiation !== true || first.responseStatus !== 200) continue;
        const final = requests[index + 1];
        expect(final).toBeDefined();
        expect(final!.method).toBe(first.method);
        expect(final!.path).toBe((first.path as string).slice("/api/v1/blobs".length));
        expect(final!.capability).toBe(true);
        expect(final!.authorization).toBe(false);
        expect(final!.internalMetadata).toBe(first.externalMetadata);
      }
      const largeUpload = capabilities.find((request) =>
        request.method === "PUT" &&
        (request.path as string).endsWith("/roundtrip-1") && request.payloadBytes === original.length
      );
      expect(largeUpload).toBeDefined();
      expect(largeUpload!.payloadSha256).toBe(createHash("sha256").update(original).digest("hex"));
      expect(largeUpload!.ifNoneMatch).toBe("*");
      expect(largeUpload!.internalMetadata).toBe(true);
      expect(capabilities.some((request) => request.method === "GET" && request.responseInternalMetadata === true))
        .toBe(true);
      expect(requests.some((request) => request.method === "HEAD" && request.api === true)).toBe(true);
      expect(requests.some((request) => request.method === "DELETE" && request.api === true)).toBe(true);
    });
  });
  it("compares separately admitted candidate bytes with the SDK in both directions", { timeout: 180000 }, async () => {
    const directory = process.env.OPFS_NETLIFY_ARTIFACTS, closureSha256 = process.env.OPFS_NETLIFY_CLOSURE_SHA256;
    const file = process.env.OPFS_NETLIFY_CANDIDATE, sha256 = process.env.OPFS_NETLIFY_CANDIDATE_SHA256;
    if (
      !directory || !closureSha256 || !file || !sha256 ||
      process.env.OPFS_NETLIFY_EXECUTION_REVIEWED !== "11.1.7-test-only"
    ) {
      throw new Error(
        "Reciprocal Netlify checks require both the admitted SDK closure and a separately hashed standalone candidate.",
      );
    }
    await withReleases(async (releases) => {
      const fixture = await openNetlify({
        directory,
        closureSha256,
        reviewedForTestExecution: true,
        candidate: { file, sha256 },
      });
      releases.push(() => fixture.close());
      const receipt = await fixture.observeCandidate();
      console.log(JSON.stringify({ netlifyReciprocalObservations: receipt }));
      expect(receipt.profile).toBe("netlify-blobs-11.1.7-local-reciprocal-v1");
      expect(receipt.candidate).toBe(true);
      expect(receipt.candidateSha256).toBe(sha256);
      expect(receipt.constructorIO).toEqual({ requests: 0, authorizations: 0 });
      const original = (seed: number, size: number): Buffer =>
        Buffer.from(Uint8Array.from({ length: size }, (_, index) => (index * seed + (index >>> 7) + seed) & 255));
      const metadata = { source: "official-sdk", label: "café / 雪 / ☁️", "κλειδί": { present: true, empty: "" } };
      const reads = array(receipt.sdkToCandidate).map(object), writes = array(receipt.candidateToSdk).map(object);
      expect(reads.length).toBe(2);
      expect(writes.length).toBe(2);
      for (const [index, size] of [0, 131072].entries()) {
        const read = reads[index]!,
          write = writes[index]!,
          head = object(read.head),
          acknowledged = object(write.receipt);
        expect(read.key).toBe("sdk-" + index);
        expect(read.bytes).toBe(original(17, size).toString("base64"));
        expect(read.size).toBe(size);
        expect(read.metadata).toEqual(metadata);
        expect(head.state).toBe("present");
        expect(head.etag).toBeNull(); // Official local HEAD supplies metadata without an ETag.
        expect(head.metadata).toEqual(metadata);
        // Preserve absence or a declared transport size without replacing it with downloaded object length.
        expect(head.size === null || typeof head.size === "number" && Number.isSafeInteger(head.size) && head.size >= 0)
          .toBe(true);
        expect(write.key).toBe("candidate-" + index);
        expect(write.bytes).toBe(original(29, size).toString("base64"));
        expect(acknowledged.modified).toBe(true);
        expect(acknowledged.operation).toBe("put");
        expect(acknowledged.key).toBe("candidate-" + index);
        expect(acknowledged.size).toBe(size);
        expect(typeof acknowledged.etag).toBe("string");
      }
      expect(object(receipt.refused).modified).toBe(false);
      expect(object(receipt.stale).modified).toBe(false);
      expect(receipt.afterRefusals).toBe(original(29, 131072).toString("base64"));
      expect(object(receipt.matched).modified).toBe(true);
      expect(receipt.afterMatched).toBe(Buffer.from([17, 0, 251]).toString("base64"));
      const listed = object(receipt.listed);
      expect(listed.state).toBe("page");
      expect(array(listed.blobs).map(object).map((entry) => entry.key).sort()).toEqual([
        "candidate-0",
        "candidate-1",
        "sdk-0",
        "sdk-1",
      ]);
      expect(listed.directories).toEqual([]);
      expect(receipt.refusedCapability).toBe(true);
      expect(receipt.capabilityRefusalRequests).toBe(1); // Only the real account negotiation was dispatched.
      expect(receipt.wrongOriginDispatches).toBe(0);
      expect(receipt.unknown).toEqual({ outcome: "unknown", operation: "put", key: "candidate-uncertain" });
      expect(receipt.unknownAttempts).toBe(1); // SDK control retried; this client must leave reconciliation to its caller.
      expect(receipt.publishedAfterUnknown).toBe(Buffer.from([7, 0, 255]).toString("base64"));
      expect(object(receipt.deleted).operation).toBe("delete");
      expect(object(receipt.deletedAgain).operation).toBe("delete");
      expect(object(receipt.absent).state).toBe("absent");
      expect(receipt.sdkAbsent).toBeNull();
      const requests = array(receipt.requests).map(object);
      const candidate = requests.filter((request) => request.role === "candidate");
      expect(candidate.length).toBeGreaterThan(0);
      for (const request of candidate) {
        if (request.api === true) expect(request.authorization).toBe(true);
        if (request.capability === true) expect(request.authorization).toBe(false);
        if (request.negotiation === true) {
          expect(request.payloadBytes).toBe(0);
          expect(request.ifMatch).toBe(false);
          expect(request.ifNoneMatch).toBeNull();
        }
      }
      for (
        const request of candidate.filter((request) =>
          request.method === "PUT" && request.capability === true && request.payloadBytes === 131072
        )
      ) {
        expect(request.payloadSha256).toBe(createHash("sha256").update(original(29, 131072)).digest("hex"));
        expect(request.ifNoneMatch).toBe("*");
      }
      const approvals = array(receipt.authorizations).map(object);
      expect(approvals.filter((approval) => approval.approved === false)).toEqual([
        { method: "GET", key: "sdk-1", approved: false },
      ]);
    });
  });
});
