/** Frozen independent botocore/Smithy expectations. This module registers tests, not a production oracle. */
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect } from "@std/expect";
import type { GlacierOptionsType, GlacierPartType } from "../src/glacier.ts";

interface OriginalType {
  readonly id: string;
  readonly size: number;
  readonly seed: number;
  readonly pattern: string;
  readonly file: string;
  readonly sha256: string;
}
interface PartType {
  readonly start: number;
  readonly endInclusive: number;
  readonly size: number;
  readonly linearSha256: string;
  readonly leafHashes: readonly string[];
  readonly treeHash: string;
}
interface TreeType {
  readonly id: string;
  readonly size: number;
  readonly linearSha256: string;
  readonly leafHashes: readonly string[];
  readonly treeHash: string;
  readonly partSize?: number;
  readonly parts: readonly PartType[];
}
interface SignatureType {
  readonly id: string;
  readonly region: string;
  readonly signingDate: string;
  readonly request: {
    readonly protocol: string;
    readonly hostname: string;
    readonly method: string;
    readonly path: string;
    readonly body: { readonly originalFile: string; readonly sha256: string; readonly bytes: number };
  };
  readonly canonicalPath: string;
  readonly canonicalQuery: string;
  readonly canonicalRequest: string;
  readonly stringToSign: string;
  readonly authorization: string;
  readonly signedHeaders: Readonly<Record<string, string>>;
  readonly files: Readonly<Record<string, string>>;
}
interface SigningInputType {
  readonly id: string;
  readonly credentials: GlacierOptionsType["credentials"];
}
const fixtures = new URL("./fixtures/glacier/", import.meta.url);
function text(path: string): string {
  return readFileSync(new URL(path, fixtures), "utf8");
}
// Read frozen independent outputs before comparison callbacks. No test regenerates a golden.
const originals = (JSON.parse(text("originals.json")) as { vectors: readonly OriginalType[] }).vectors;
const trees = (JSON.parse(text("glacier-trees.json")) as { vectors: readonly TreeType[] }).vectors;
const signatures = (JSON.parse(text("signatures/signatures.json")) as { receipts: readonly SignatureType[] }).receipts;
const signingInputs = (JSON.parse(text("signing-vectors.json")) as { vectors: readonly SigningInputType[] }).vectors;
const mib = 1024 * 1024;
function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
/** Recreate the independent original specification, then check its frozen complete-byte identity. */
function original(id: string): Uint8Array<ArrayBuffer> {
  const spec = originals.find((value) => value.id === id);
  if (spec === undefined) throw new Error(`Missing original ${id}.`);
  const bytes = new Uint8Array(spec.size);
  if (spec.pattern === "affine-block-v1") {
    for (let at = 0; at < bytes.length; at++) bytes[at] = (31 * at + 17 * Math.floor(at / 65536) + spec.seed) % 256;
  } else if (spec.pattern !== "zero") {
    throw new Error(`Unknown independent original pattern ${spec.pattern}.`);
  }
  expect(sha(bytes)).toBe(spec.sha256);
  return bytes;
}
function options(fetch: GlacierOptionsType["fetch"]): GlacierOptionsType {
  return {
    endpoint: "https://glacier.us-west-2.amazonaws.com",
    account: "-",
    vault: "test-vault",
    region: "us-west-2",
    credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" },
    fetch,
    subtle: globalThis.crypto.subtle,
    now: () => new Date("2015-08-30T12:36:00.000Z"),
    requestPolicy: { retries: 0 },
  };
}
/** Fetch sees the entire submitted extent, including every byte and the independent linear hash. */
function body(init: RequestInit | undefined, expected: Uint8Array, hash: string): void {
  expect(init?.body instanceof Uint8Array).toBe(true);
  const actual = init!.body as Uint8Array;
  expect(actual.length).toBe(expected.length);
  for (let at = 0; at < actual.length; at++) {
    if (actual[at] !== expected[at]) {
      throw new Error(
        `Glacier submitted different original byte at ${at}: expected ${expected[at]}, received ${actual[at]}.`,
      );
    }
  }
  expect(sha(actual)).toBe(hash);
}

describe("Glacier frozen independent oracle", () => {
  it("retains all eleven complete signing preimages and exact legal/source identities", () => {
    const retained = JSON.parse(text("retained.json")) as {
      files: Record<string, { bytes: number; sha256: string }>;
    };
    for (const [path, identity] of Object.entries(retained.files)) {
      const bytes = readFileSync(new URL(path, fixtures));
      expect(bytes.length).toBe(identity.bytes);
      expect(sha(bytes)).toBe(identity.sha256);
    }
    expect(signatures.length).toBe(11);
    for (const signature of signatures) {
      expect(text(`signatures/${signature.files.canonicalRequest}`)).toBe(signature.canonicalRequest);
      expect(text(`signatures/${signature.files.stringToSign}`)).toBe(signature.stringToSign);
      expect(text(`signatures/${signature.files.authorization}`)).toBe(signature.authorization);
      expect(JSON.parse(text(`signatures/${signature.files.signedHeaders}`))).toEqual(signature.signedHeaders);
    }
  });

  for (const vector of trees) {
    it(`matches botocore whole and leaf trees for ${vector.id}`, async () => {
      const bytes = original(vector.id);
      expect(sha(bytes)).toBe(vector.linearSha256);
      const { glacierTreeHash } = await import("../src/glacier.ts");
      expect(await glacierTreeHash(bytes, globalThis.crypto.subtle)).toBe(vector.treeHash);
      for (let leaf = 0; leaf < vector.leafHashes.length; leaf++) {
        expect(await glacierTreeHash(bytes.subarray(leaf * mib, (leaf + 1) * mib), globalThis.crypto.subtle))
          .toBe(vector.leafHashes[leaf]);
      }
    });
    if (vector.partSize !== undefined) {
      it(`submits every original part and whole completion root for ${vector.id}`, async () => {
        const bytes = original(vector.id);
        const { createGlacierClient, glacierMultipartHash, glacierTreeHash } = await import("../src/glacier.ts");
        const parts: GlacierPartType[] = [];
        let sent = 0;
        const client = createGlacierClient(options(async (_input, init) => {
          const headers = new Headers(init?.headers);
          if (init?.method === "PUT") {
            const part = vector.parts[sent++]!;
            body(init, bytes.subarray(part.start, part.endInclusive + 1), part.linearSha256);
            expect(headers.get("content-range")).toBe(`bytes ${part.start}-${part.endInclusive}/*`);
            expect(headers.get("x-amz-sha256-tree-hash")).toBe(part.treeHash);
            return new Response(null, { status: 204, headers: { "x-amz-sha256-tree-hash": part.treeHash } });
          }
          expect(init?.method).toBe("POST");
          expect(sent).toBe(vector.parts.length);
          expect(init?.body).toBeUndefined();
          expect(headers.get("x-amz-archive-size")).toBe(String(bytes.length));
          expect(headers.get("x-amz-sha256-tree-hash")).toBe(vector.treeHash);
          return new Response(null, {
            status: 201,
            headers: { "x-amz-archive-id": "archive", location: "/-/vaults/test-vault/archives/archive" },
          });
        }));
        const upload = { id: "upload-id", partSize: vector.partSize! };
        for (const part of vector.parts) {
          const extent = bytes.subarray(part.start, part.endInclusive + 1);
          expect(extent.length).toBe(part.size);
          expect(sha(extent)).toBe(part.linearSha256);
          expect(await glacierTreeHash(extent, globalThis.crypto.subtle)).toBe(part.treeHash);
          for (let leaf = 0; leaf < part.leafHashes.length; leaf++) {
            expect(sha(extent.subarray(leaf * mib, (leaf + 1) * mib))).toBe(part.leafHashes[leaf]);
          }
          const receipt = await client.uploadPart(upload, part.start, extent);
          expect(receipt).toEqual({ start: part.start, end: part.endInclusive, treeHash: part.treeHash });
          parts.push(receipt);
        }
        expect(await glacierMultipartHash(upload, parts, bytes.length, globalThis.crypto.subtle)).toBe(vector.treeHash);
        expect((await client.completeUpload(upload, parts, bytes.length)).id).toBe("archive");
      });
    }
  }

  for (
    const id of [
      "describe-empty",
      "rotated-date-region-key",
      "query-single-marker",
      "upload-three-leaves",
      "upload-fixed-part",
      "complete-short-odd",
    ]
  ) {
    it(`matches complete public operation signing bytes for ${id}`, async () => {
      const expected = signatures.find((value) => value.id === id)!;
      const input = signingInputs.find((value) => value.id === id)!;
      const bytes = original(expected.request.body.originalFile.replace(/\.bin$/, ""));
      expect(bytes.length).toBe(expected.request.body.bytes);
      expect(sha(bytes)).toBe(expected.request.body.sha256);
      const { createGlacierClient } = await import("../src/glacier.ts");
      let calls = 0;
      const client = createGlacierClient({
        ...options(async (input, init) => {
          calls++;
          const url = new URL(String(input));
          expect(url.pathname).toBe(expected.request.path);
          expect(url.search.slice(1)).toBe(expected.canonicalQuery);
          expect(init?.method).toBe(expected.request.method);
          expect(init?.redirect).toBe("manual");
          const actual = new Headers(init?.headers);
          actual.set("host", url.host);
          expect(Object.fromEntries(actual.entries())).toEqual(
            Object.fromEntries(new Headers(expected.signedHeaders).entries()),
          );
          const names = [...actual.keys()].filter((name) => name !== "authorization").sort();
          const canonicalHeaders = names.map((name) => `${name}:${actual.get(name)!.trim().replace(/\s+/g, " ")}\n`)
            .join("");
          // The retained header-only file has no final LF; canonical requests require one.
          expect(canonicalHeaders).toBe(text(`signatures/${expected.files.canonicalHeaders}`) + "\n");
          // The canonical path is an authored literal verified by Smithy's public signing overload,
          // not a second implementation of the candidate's URI normalization algorithm.
          expect(
            [init?.method, expected.canonicalPath, url.search.slice(1), canonicalHeaders, names.join(";"), sha(bytes)]
              .join("\n"),
          )
            .toBe(expected.canonicalRequest);
          expect(actual.get("authorization")).toBe(expected.authorization);
          if (bytes.length > 0) body(init, bytes, expected.request.body.sha256);
          else expect(init?.body).toBeUndefined();
          if (id === "upload-fixed-part") {
            return new Response(null, {
              status: 204,
              headers: { "x-amz-sha256-tree-hash": actual.get("x-amz-sha256-tree-hash")! },
            });
          }
          if (id === "upload-three-leaves" || id === "complete-short-odd") {
            return new Response(null, {
              status: 201,
              headers: {
                "x-amz-archive-id": "archive",
                location: "/-/vaults/test-vault/archives/archive",
                "x-amz-sha256-tree-hash": actual.get("x-amz-sha256-tree-hash")!,
              },
            });
          }
          return Response.json(
            id === "query-single-marker" ? { JobList: [], Marker: null } : {
              VaultARN: "fixture",
              VaultName: "test-vault",
              CreationDate: "2015-08-01",
              NumberOfArchives: 0,
              SizeInBytes: 0,
            },
          );
        }),
        endpoint: `${expected.request.protocol}//${expected.request.hostname}`,
        region: expected.region,
        credentials: input.credentials,
        now: () => new Date(expected.signingDate),
      });
      if (id === "query-single-marker") await client.listJobsPage({ marker: "next/+ =%", limit: 50 });
      else if (id === "upload-three-leaves") {
        await client.uploadArchive(bytes, { description: "  fixture   archive  " });
      } else if (id === "upload-fixed-part") {
        await client.uploadPart({ id: "upload-id", partSize: 4 * mib }, 4 * mib, bytes);
      } else if (id === "complete-short-odd") {
        const tree = trees.find((value) => value.id === "multipart-three-short-odd")!;
        await client.completeUpload(
          { id: "upload-id", partSize: tree.partSize! },
          tree.parts.map((part) => ({
            start: part.start,
            end: part.endInclusive,
            treeHash: part.treeHash,
          })),
          tree.size,
        );
      } else await client.describeVault();
      expect(calls).toBe(1);
    });
  }
});
