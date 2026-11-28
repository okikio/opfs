/** Installed provider objects contracts. Each case owns its state and exact source oracle. */
import { describe, it } from "node:test";
import { OciClient } from "@okikio/opfs/oci";
import { FirebaseClient } from "@okikio/opfs/firebase";
import { ResticClient } from "@okikio/opfs/restic";
import { LakefsClient } from "@okikio/opfs/lakefs";
import { createGcsClient, GcsStorageClassSchema } from "@okikio/opfs/gcs";
import { createGcsDriver } from "@okikio/opfs/driver/gcs";
import { assertBytes } from "../../bytes.mjs";

describe("packed provider objects", () => {
  it("Firebase authority and exact generation", async () => {
    const firebase = new FirebaseClient({
      bucket: "demo-opfs.appspot.com",
      credentials: () => ({ idToken: "fixture-token" }),
      fetch: async (_input, init) => {
        if (new Headers(init.headers).get("Authorization") !== "Firebase fixture-token") {
          throw new Error("Packed Firebase credential scheme changed");
        }
        return Response.json({
          bucket: "demo-opfs.appspot.com",
          name: "packed",
          size: "3",
          generation: "9007199254740993",
          metageneration: "1",
        });
      },
    });
    if ((await firebase.stat("packed")).generation !== "9007199254740993") {
      throw new Error("Packed Firebase generation was rounded");
    }
  });
  it("GCS paired observation guards and exact metadata", async () => {
    let gcsArchiveCalls = 0;
    const gcsReported = {
      name: "archive.bin",
      size: "3",
      generation: "18446744073709551614",
      storageClass: "ARCHIVE",
      metageneration: "9007199254740993",
      crc32c: "AQIDBA==",
    };
    const gcsArchive = createGcsClient({
      bucket: "installed-bucket",
      endpoint: "https://storage.example",
      token: "explicit-token",
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (new Headers(init?.headers).get("authorization") !== "Bearer explicit-token") {
          throw new Error("Packed GCS explicit authority changed");
        }
        const step = gcsArchiveCalls++;
        if (step === 0) {
          if (JSON.parse(String(init?.body)).storageClass !== "ARCHIVE") {
            throw new Error("Packed GCS class intent lost");
          }
          if (
            url.searchParams.get("ifGenerationMatch") !== "9007199254740993" ||
            url.searchParams.get("ifMetagenerationMatch") !== "18446744073709551615"
          ) throw new Error("Packed GCS initiation guard lost precision");
          return new Response(null, {
            headers: { location: "https://storage.example/upload?upload_id=installed-session" },
          });
        }
        if (step === 1) {
          if (url.searchParams.has("ifMetagenerationMatch")) {
            throw new Error("Packed GCS extent inherited initiation guard");
          }
          assertBytes(new Uint8Array(await new Response(init.body).arrayBuffer()), new Uint8Array([1, 2, 3]));
          return Response.json(gcsReported);
        }
        if (step === 2) {
          if (
            url.searchParams.get("generation") !== gcsReported.generation ||
            url.searchParams.get("ifGenerationMatch") !== gcsReported.generation ||
            url.searchParams.get("ifMetagenerationMatch") !== gcsReported.metageneration
          ) throw new Error("Packed native GCS driver discarded paired observation guard");
          return Response.json(gcsReported);
        }
        if (step === 3) return Response.json({ items: [gcsReported] });
        throw new Error("Unexpected packed GCS request");
      },
    });
    const gcsArchiveReceipt = await gcsArchive.put("archive.bin", new Uint8Array([1, 2, 3]), {
      storageClass: GcsStorageClassSchema.parse("ARCHIVE"),
      revision: { kind: "generation", value: "9007199254740993" },
      ifMetagenerationMatch: "18446744073709551615",
    });
    if (
      gcsArchiveReceipt.storageClass !== "ARCHIVE" || gcsArchiveReceipt.revision.value !== gcsReported.generation ||
      gcsArchiveReceipt.metageneration !== gcsReported.metageneration || gcsArchiveReceipt.crc32c !== gcsReported.crc32c
    ) throw new Error("Packed GCS native receipt lost exact metadata");
    const gcsDriver = createGcsDriver(gcsArchive);
    const gcsHead = await gcsDriver.head("archive.bin", {
      revision: gcsArchiveReceipt.revision,
      ifMetagenerationMatch: gcsArchiveReceipt.metageneration,
    });
    const gcsListed = await gcsDriver.list({ prefix: "archive" });
    for (const observation of [gcsHead, gcsListed.objects[0]]) {
      if (observation?.metageneration !== gcsReported.metageneration || observation?.crc32c !== gcsReported.crc32c) {
        throw new Error("Packed GCS driver dropped provider metadata");
      }
    }
    if (gcsArchiveCalls !== 4) throw new Error("Packed GCS request count changed");
  });
  it("lakeFS staging, commit and committed read", async () => {
    const lakefs = new LakefsClient({
      endpoint: "https://lake.example/",
      repository: "installed",
      credentials: () => "Bearer explicit-lake-token",
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (new Headers(init?.headers).get("authorization") !== "Bearer explicit-lake-token") {
          throw new Error("Packed lakeFS authority changed");
        }
        if (url.pathname.endsWith("/branches/work/objects")) {
          if (
            new Headers(init?.headers).get("if-none-match") !== "*" || url.searchParams.get("path") !== "native.bin"
          ) throw new Error("Packed lakeFS staging intent changed");
          assertBytes(new Uint8Array(await new Response(init.body).arrayBuffer()), new Uint8Array([1, 2, 3]));
          return Response.json({
            path: "native.bin",
            path_type: "object",
            size_bytes: 3,
            checksum: "native-metadata-only",
          }, { status: 201 });
        }
        if (url.pathname.endsWith("/branches/work/commits")) {
          return Response.json({
            id: "opaque-commit",
            parents: ["old"],
            message: "Publish staged file",
            committer: "fixture",
            creation_date: 1,
          }, { status: 201 });
        }
        if (!url.pathname.endsWith("/refs/opaque-commit/objects") || url.searchParams.get("presign") !== "false") {
          throw new Error("Packed lakeFS committed read changed");
        }
        return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-length": "3" } });
      },
    });
    const lakefsStaged = await lakefs.put("work", "native.bin", new Uint8Array([1, 2, 3]), { ifNoneMatch: "*" });
    if (lakefsStaged.size !== 3) throw new Error("Packed lakeFS staging receipt changed");
    const lakefsCommitted = await lakefs.commit("work", "Publish staged file");
    if (lakefsCommitted.id !== "opaque-commit" || lakefsCommitted.created !== 1000) {
      throw new Error("Packed lakeFS commit scope changed");
    }
    assertBytes(await lakefs.read(lakefsCommitted.id, "native.bin"), new Uint8Array([1, 2, 3]));
  });
  it("Restic opaque object transfer and verification", async () => {
    const resticBody = new TextEncoder().encode("abc");
    const resticId = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    const restic = new ResticClient({
      endpoint: "https://backup.invalid/repository/",
      subtle: globalThis.crypto.subtle,
      credentials: () => "Bearer explicit-repository-token",
      fetch: async (input, init) => {
        const target = new URL(input.toString());
        if (new Headers(init?.headers).get("authorization") !== "Bearer explicit-repository-token") {
          throw new Error("Packed restic authority changed");
        }
        if (target.pathname.endsWith("/data/")) {
          return new Response(JSON.stringify([{ name: resticId, size: 3 }]), {
            headers: { "content-type": "application/vnd.x.restic.rest.v2" },
          });
        }
        if (!target.pathname.endsWith("/data/" + resticId)) throw new Error("Packed restic hash-address route changed");
        if (init.method === "POST") {
          assertBytes(new Uint8Array(await new Response(init.body).arrayBuffer()), resticBody);
          return new Response(null, { status: 200 });
        }
        return new Response(resticBody.slice(), { headers: { "content-length": "3" } });
      },
    });
    const resticSaved = await restic.save("data", resticBody);
    if (resticSaved.id !== resticId || (await restic.list("data"))[0].id !== resticId) {
      throw new Error("Packed restic object evidence changed");
    }
    assertBytes(await restic.readVerified({ kind: "data", id: resticId }), resticBody);
  });
  it("OCI manifest and selected blob range", async () => {
    const packedOciManifest = JSON.stringify({
      "schemaVersion": 2,
      "mediaType": "application/vnd.oci.image.manifest.v1+json",
      "config": {
        "mediaType": "application/vnd.oci.empty.v1+json",
        "digest": "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
        "size": 2,
      },
      "layers": [{
        "mediaType": "application/octet-stream",
        "digest": "sha256:039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
        "size": 3,
      }],
    });
    const packedOci = new OciClient({
      registry: "https://registry.invalid/",
      repository: "packed/artifact",
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/v2/packed/artifact/manifests/release") {
          return new Response(packedOciManifest, {
            headers: { "Content-Type": "application/vnd.oci.image.manifest.v1+json" },
          });
        }
        if (
          url.pathname ===
            "/v2/packed/artifact/blobs/sha256:039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81"
        ) return new Response(new Uint8Array([1, 2, 3]));
        throw new Error("Unexpected packed OCI request");
      },
    });
    const packedManifest = await packedOci.getManifest("release");
    const packedSource = await packedOci.openBlobSource(packedManifest.layers[0].digest, { size: 3 });
    assertBytes(await packedSource.read(1, 2), new Uint8Array([2, 3]));
  });
});
