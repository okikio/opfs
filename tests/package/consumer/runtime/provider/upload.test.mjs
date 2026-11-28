/** Installed provider upload contracts. Each case owns its state and exact source oracle. */
import { describe, it } from "node:test";
import { NextcloudClient } from "@okikio/opfs/nextcloud";
import { createUploadClient, UploadSessionSchema } from "@okikio/opfs/upload";
import { assertBytes } from "../../bytes.mjs";
import uploadInput from "../../data/provider/upload.json" with { type: "json" };

describe("packed provider upload", () => {
  it("draft upload reconciliation and acknowledgements", async () => {
    const uploadFixture = uploadInput;
    const uploadOriginal = Uint8Array.from(
      { length: uploadFixture.original.length },
      (_, index) => (index * 31 + 17) % 251,
    );
    const uploadDigest = Array.from(
      new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", uploadOriginal)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    if (uploadDigest !== uploadFixture.original.sha256) throw new Error("Packed upload independent original differs");
    let uploadAt = 0;
    const uploadClient = createUploadClient({
      profile: "draft-15",
      target: "https://upload.example/create?key=main.bin",
      fetch: async (input, init) => {
        const trace = uploadFixture.traces[uploadAt++], url = new URL(String(input));
        if (
          !trace || url.origin !== "https://upload.example" || url.pathname + url.search !== trace.path ||
          init.method !== trace.method || init.redirect !== "manual" || init.credentials !== "omit"
        ) throw new Error("Packed upload trace or authority changed");
        const headers = new Headers(init.headers);
        if (headers.get("Upload-Draft-Interop-Version") !== "10") {
          throw new Error("Packed upload draft version changed");
        }
        if (trace.method === "PATCH" && trace.requestBytes > 0) {
          if (headers.get("Upload-Offset") !== "32768" || headers.get("Upload-Complete") !== "?0") {
            throw new Error("Packed upload append evidence changed");
          }
          assertBytes(init.body, uploadOriginal.subarray(32768));
        } else if (init.body !== undefined) assertBytes(init.body, new Uint8Array());
        return new Response(trace.body ? Uint8Array.from(atob(trace.body), (byte) => byte.charCodeAt(0)) : null, {
          status: trace.status,
          headers: trace.headers,
        });
      },
    });
    const uploadCreated = await uploadClient.create({ method: "POST", size: uploadOriginal.length });
    if (uploadCreated.kind !== "created") throw new Error("Packed upload creation omitted resource");
    const uploadResource = uploadClient.open(
      UploadSessionSchema.parse(JSON.parse(JSON.stringify(uploadCreated.session))),
      { acknowledgedOffset: 0 },
    );
    const uploadStatus = await uploadResource.status();
    if (uploadStatus.offset !== 32768) throw new Error("Packed upload reconciliation changed");
    const uploadAppend = await uploadResource.append(uploadStatus.offset, uploadOriginal.subarray(uploadStatus.offset));
    if (uploadAppend.kind !== "ack" || uploadAppend.offset !== uploadOriginal.length) {
      throw new Error("Packed upload acknowledgement changed");
    }
    const uploadReceipt = await uploadResource.finish();
    if (uploadReceipt.terminal !== true || uploadReceipt.status !== 200 || uploadAt !== uploadFixture.traces.length) {
      throw new Error("Packed upload terminal receipt changed");
    }
  });
  it("Nextcloud chunk receipts and final MOVE", async () => {
    const nextcloudBody = new TextEncoder().encode("native chunk bytes");
    const nextcloudMethods = [];
    const nextcloud = new NextcloudClient({
      endpoint: "https://cloud.invalid/",
      user: "caller",
      credentials: () => "Bearer explicit-token",
      fetch: async (input, init) => {
        const target = new URL(input.toString()), headers = new Headers(init?.headers);
        if (headers.get("authorization") !== "Bearer explicit-token" || target.origin !== "https://cloud.invalid") {
          throw new Error("Packed Nextcloud authority changed");
        }
        nextcloudMethods.push(init.method);
        if (init.method === "PUT") {
          assertBytes(new Uint8Array(await new Response(init.body).arrayBuffer()), nextcloudBody);
        }
        if (
          init.method === "MOVE" &&
          (headers.get("overwrite") !== "F" ||
            !headers.get("destination").endsWith("/remote.php/dav/files/caller/note.txt"))
        ) throw new Error("Packed Nextcloud publication scope changed");
        return new Response(null, { status: 201 });
      },
    });
    const nextcloudUpload = await nextcloud.createUpload("installed-fixture", "note.txt", nextcloudBody.length);
    const nextcloudPart = await nextcloud.putPart(nextcloudUpload, 1, nextcloudBody);
    const nextcloudReceipt = await nextcloud.finishUpload(
      nextcloud.openUpload(JSON.parse(JSON.stringify(nextcloudUpload))),
      [nextcloudPart],
    );
    if (nextcloudReceipt.status !== 201 || nextcloudMethods.join(",") !== "MKCOL,PUT,MOVE") {
      throw new Error("Packed Nextcloud upload receipts changed");
    }
  });
});
