/** Installed provider glacier contracts. Each case owns its state and exact source oracle. */
import { describe, it } from "node:test";
import { createHash } from "node:crypto";
import {
  createGlacierClient,
  GLACIER_MIB,
  glacierMultipartHash,
  GlacierPublicationError,
  glacierTreeHash,
} from "@okikio/opfs/glacier";
import { assertBytes } from "../../bytes.mjs";

describe("packed provider glacier", () => {
  it("Glacier native receipts, checksums and uncertain publication", async () => {
    // Authored in-memory protocol exercise through the installed public artifact;
    // independent SDK fixtures and live-service qualification are separate gates.
    const glacierOriginal = Uint8Array.from({ length: GLACIER_MIB + 17 }, (_, index) => (index * 31 + 17) % 251);
    /** Reduce independent SHA-256 leaves in one-MiB chunks, carrying an odd leaf unchanged. */
    const glacierReferenceTree = (bytes) => {
      let level = [];
      for (let at = 0; at < bytes.length; at += GLACIER_MIB) {
        level.push(createHash("sha256").update(bytes.subarray(at, at + GLACIER_MIB)).digest());
      }
      if (!level.length) return createHash("sha256").digest("hex");
      while (level.length > 1) {
        const next = [];
        for (let at = 0; at < level.length; at += 2) {
          next.push(
            at + 1 === level.length ? level[at] : createHash("sha256").update(level[at]).update(level[at + 1]).digest(),
          );
        }
        level = next;
      }
      return level[0].toString("hex");
    };
    const glacierHash = glacierReferenceTree(glacierOriginal);
    if (await glacierTreeHash(glacierOriginal, crypto.subtle) !== glacierHash) {
      throw new Error("Packed Glacier tree differs from independent Node reduction");
    }
    const glacierJob = {
      JobId: "job",
      Action: "ArchiveRetrieval",
      Completed: true,
      StatusCode: "Succeeded",
      ArchiveId: "archive",
      ArchiveSizeInBytes: glacierOriginal.length,
      RetrievalByteRange: "0-" + (glacierOriginal.length - 1),
      SHA256TreeHash: glacierHash,
    };
    /** Build native receipt headers whose opaque IDs remain distinct from status observations. */
    const glacierReceipt = (kind, id) => ({
      ["x-amz-" + kind + "-id"]: id,
      location: "/-/vaults/packed/" +
        (kind === "job" ? "jobs" : kind === "multipart-upload" ? "multipart-uploads" : "archives") + "/" + id,
      "x-amzn-requestid": "packed-request",
    });
    let glacierRequests = 0;
    const glacierOptions = {
      endpoint: "https://glacier.invalid",
      account: "-",
      vault: "packed",
      region: "us-east-1",
      credentials: { accessKeyId: "fixture", secretAccessKey: "fixture-secret" },
      subtle: crypto.subtle,
      now: () => new Date("2026-11-05T00:00:00Z"),
      requestPolicy: { retries: 0 },
      fetch: async (input, init) => {
        glacierRequests++;
        const url = new URL(String(input)), headers = new Headers(init?.headers), method = init?.method;
        if (
          !headers.get("authorization")?.includes("/us-east-1/glacier/aws4_request") ||
          headers.get("x-amz-glacier-version") !== "2012-06-01" || init?.redirect !== "manual"
        ) throw new Error("Packed Glacier signing scope changed");
        const prefix = "/-/vaults/packed";
        if (method === "GET" && url.pathname === prefix) {
          return Response.json({
            VaultARN: "arn:aws:glacier:us-east-1:000000000000:vaults/packed",
            VaultName: "packed",
            CreationDate: "2026-11-05T00:00:00Z",
            LastInventoryDate: null,
            NumberOfArchives: 1,
            SizeInBytes: glacierOriginal.length,
          });
        }
        if (method === "GET" && url.pathname === prefix + "/jobs") {
          return Response.json({ JobList: [glacierJob], Marker: null });
        }
        if (method === "GET" && url.pathname === prefix + "/jobs/job") return Response.json(glacierJob);
        if (method === "POST" && url.pathname === prefix + "/jobs") {
          return new Response(null, { status: 202, headers: glacierReceipt("job", "job") });
        }
        if (method === "GET" && url.pathname === prefix + "/jobs/job/output") {
          const range = headers.get("range");
          if (range === null) {
            return new Response(glacierOriginal, {
              headers: { "content-length": String(glacierOriginal.length), "x-amz-sha256-tree-hash": glacierHash },
            });
          }
          if (range !== "bytes=17-47") throw new Error("Packed Glacier job-relative selected range changed");
          return new Response(glacierOriginal.slice(17, 48), {
            status: 206,
            headers: { "content-range": "bytes 17-47/" + glacierOriginal.length, "content-length": "31" },
          });
        }
        if (method === "POST" && url.pathname === prefix + "/archives") {
          assertBytes(new Uint8Array(init.body), glacierOriginal);
          if (headers.get("x-amz-sha256-tree-hash") !== glacierHash) {
            throw new Error("Packed Glacier upload hash changed");
          }
          return new Response(null, {
            status: 201,
            headers: { ...glacierReceipt("archive", "archive"), "x-amz-sha256-tree-hash": glacierHash },
          });
        }
        if (method === "DELETE" && url.pathname === prefix + "/archives/archive") {
          return new Response(null, { status: 204 });
        }
        if (url.pathname === prefix + "/multipart-uploads") {
          if (method === "POST") {
            return new Response(null, { status: 201, headers: glacierReceipt("multipart-upload", "upload") });
          }
          if (method === "GET") {
            return Response.json({
              UploadsList: [{ MultipartUploadId: "upload", PartSizeInBytes: 2 * GLACIER_MIB }],
              Marker: null,
            });
          }
        }
        if (url.pathname === prefix + "/multipart-uploads/upload") {
          if (method === "GET") {
            return Response.json({
              MultipartUploadId: "upload",
              PartSizeInBytes: 2 * GLACIER_MIB,
              Parts: [{ RangeInBytes: "0-" + (glacierOriginal.length - 1), SHA256TreeHash: glacierHash }],
              Marker: null,
            });
          }
          if (method === "PUT") {
            assertBytes(new Uint8Array(init.body), glacierOriginal);
            if (headers.get("content-range") !== "bytes 0-" + (glacierOriginal.length - 1) + "/*") {
              throw new Error("Packed Glacier multipart range changed");
            }
            return new Response(null, { status: 204, headers: { "x-amz-sha256-tree-hash": glacierHash } });
          }
          if (method === "POST") {
            if (
              headers.get("x-amz-archive-size") !== String(glacierOriginal.length) ||
              headers.get("x-amz-sha256-tree-hash") !== glacierHash
            ) throw new Error("Packed Glacier completion preflight changed");
            return new Response(null, { status: 201, headers: glacierReceipt("archive", "archive") });
          }
          if (method === "DELETE") return new Response(null, { status: 204 });
        }
        throw new Error("Unexpected packed Glacier route");
      },
    };
    const glacier = createGlacierClient(glacierOptions);
    if ((await glacier.describeVault()).NumberOfArchives !== 1 || (await glacier.listJobsPage()).marker !== null) {
      throw new Error("Packed Glacier metadata changed");
    }
    if ((await glacier.startArchiveJob("archive")).id !== "job" || (await glacier.startInventoryJob()).id !== "job") {
      throw new Error("Packed Glacier job receipt changed");
    }
    const glacierOutput = await glacier.readOutput(glacierJob, 0, glacierOriginal.length, { requireChecksum: true });
    assertBytes(glacierOutput.bytes, glacierOriginal);
    if (glacierOutput.checksum !== "service") throw new Error("Packed Glacier service checksum evidence changed");
    const glacierSelected = await glacier.readOutput(glacierJob, 17, 31, {
      requireChecksum: true,
      expectedTreeHash: glacierReferenceTree(glacierOriginal.subarray(17, 48)),
    });
    assertBytes(glacierSelected.bytes, glacierOriginal.subarray(17, 48));
    if (glacierSelected.checksum !== "caller") throw new Error("Packed Glacier caller checksum evidence changed");
    const glacierBefore = glacierRequests;
    let glacierRefused = false;
    try {
      await glacier.readOutput(glacierJob, 17, 31, { requireChecksum: true });
    } catch {
      glacierRefused = true;
    }
    if (!glacierRefused || glacierRequests !== glacierBefore) {
      throw new Error("Packed Glacier ineligible checksum policy performed I/O");
    }
    const glacierSource = await glacier.openOutput("job");
    assertBytes(await glacierSource.read(17, 31), glacierOriginal.subarray(17, 48));
    if ((await glacier.uploadArchive(glacierOriginal)).id !== "archive") {
      throw new Error("Packed Glacier archive receipt changed");
    }
    const glacierUpload = await glacier.createUpload(2 * GLACIER_MIB);
    const glacierPartInput = new Uint8Array(glacierOriginal);
    const glacierPartPending = glacier.uploadPart(glacierUpload, 0, glacierPartInput);
    glacierPartInput.fill(0);
    const glacierPart = await glacierPartPending;
    const glacierParts = await glacier.listParts(glacierUpload, { maxPages: 1 });
    if (
      glacierParts.length !== 1 || (await glacier.listUploadsPage()).marker !== null ||
      await glacierMultipartHash(glacierUpload, glacierParts, glacierOriginal.length, crypto.subtle) !== glacierHash
    ) throw new Error("Packed Glacier multipart state changed");
    if ((await glacier.completeUpload(glacierUpload, [glacierPart], glacierOriginal.length)).id !== "archive") {
      throw new Error("Packed Glacier completion receipt changed");
    }
    await glacier.abortUpload(glacierUpload);
    await glacier.deleteArchive("archive");
    const glacierLost = createGlacierClient({
      ...glacierOptions,
      fetch: async () => {
        throw new Error("lost receipt");
      },
    });
    let glacierUnknown = false;
    try {
      await glacierLost.startArchiveJob("archive");
    } catch (reason) {
      glacierUnknown = reason instanceof GlacierPublicationError && reason.outcome === "unknown";
    }
    if (!glacierUnknown) throw new Error("Packed Glacier lost publication lost unknown-outcome identity");
  });
});
