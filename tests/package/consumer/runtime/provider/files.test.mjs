/** Installed provider files contracts. Each case owns its state and exact source oracle. */
import { describe, it } from "node:test";
import { contentHash as dropboxContentHash, DropboxClient } from "@okikio/opfs/dropbox";
import { BoxClient } from "@okikio/opfs/box";
import { PcloudClient } from "@okikio/opfs/pcloud";
import { YandexClient } from "@okikio/opfs/yandex";
import { PocketbaseClient } from "@okikio/opfs/pocketbase";
import { SupabaseClient } from "@okikio/opfs/supabase";
import { SeafileClient } from "@okikio/opfs/seafile";
import { assertBytes } from "../../bytes.mjs";

describe("packed provider files", () => {
  it("Dropbox metadata and content hash", async () => {
    const dropbox = new DropboxClient({
      token: () => "fixture-token",
      fetch: async () =>
        new Response(JSON.stringify({ ".tag": "file", name: "packed", id: "id:packed", rev: "012345678", size: 3 }), {
          headers: { "Content-Type": "application/json" },
        }),
    });
    if ((await dropbox.stat("id:packed")).id !== "id:packed") throw new Error("Packed Dropbox native metadata failed");
    if (
      await dropboxContentHash(new Uint8Array(), { subtle: globalThis.crypto.subtle }) !==
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    ) throw new Error("Packed Dropbox empty hash failed");
  });
  it("Box native version metadata", async () => {
    const box = new BoxClient({
      token: () => "fixture-token",
      fetch: async () =>
        new Response(JSON.stringify({ type: "file", name: "packed", id: "1", file_version: { id: "2" }, size: 3 }), {
          headers: { "Content-Type": "application/json" },
        }),
    });
    if ((await box.statFile("1")).versionId !== "2") throw new Error("Packed Box version metadata failed");
  });
  it("PocketBase file and API authority", async () => {
    const pocketbase = new PocketbaseClient({
      endpoint: "https://pocket.example/",
      collection: "documents",
      field: "files",
      credentials: () => "Bearer repository-token",
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.startsWith("/api/files/documents/")) {
          if (
            new Headers(init.headers).has("Authorization") || url.searchParams.get("token") !== "explicit-file-token"
          ) throw new Error("Packed PocketBase file authority changed");
          return new Response(new TextEncoder().encode("hello"), { headers: { "Content-Length": "5" } });
        }
        if (new Headers(init.headers).get("Authorization") !== "Bearer repository-token") {
          throw new Error("Packed PocketBase API header changed");
        }
        if (url.pathname === "/api/files/token") return Response.json({ token: "explicit-file-token" });
        return Response.json({
          id: "record000000001",
          collectionId: "documents",
          collectionName: "documents",
          files: ["hello.txt"],
        });
      },
    });
    const pocketRecord = await pocketbase.getRecord("record000000001");
    const pocketToken = await pocketbase.fileToken();
    assertBytes(
      await pocketbase.read(pocketRecord.id, pocketRecord.files[0], { token: pocketToken }),
      new TextEncoder().encode("hello"),
    );
  });
  it("Yandex native resource metadata", async () => {
    const yandex = new YandexClient({
      token: () => "fixture-token",
      fetch: async () => Response.json({ path: "disk:/packed", name: "packed", type: "file", size: 3 }),
    });
    if ((await yandex.stat("disk:/packed")).size !== 3) throw new Error("Packed Yandex native resource failed");
  });
  it("pCloud exact uint64 metadata", async () => {
    const pcloud = new PcloudClient({
      endpoint: "https://api.pcloud.com",
      token: () => "fixture-token",
      fetch: async () =>
        new Response(
          '{"result":0,"metadata":{"isfolder":false,"id":"f7","fileid":7,"parentfolderid":0,"name":"packed","size":3,"hash":18446744073709551615}}',
        ),
    });
    if ((await pcloud.statFile("7")).hash !== "18446744073709551615") {
      throw new Error("Packed pCloud uint64 was rounded");
    }
  });
  it("Seafile scoped data authority and collision receipts", async () => {
    const seafileLibrary = "11111111-1111-1111-1111-111111111111";
    const seafileBody = new Uint8Array([1, 9, 255]);
    const seafile = new SeafileClient({
      endpoint: "https://seafile.example/",
      library: seafileLibrary,
      token: "private-api-token",
      downloadGrants: [{ origin: "https://seafile.example/", prefix: "/seafhttp/" }],
      uploadGrants: [{ origin: "https://seafile.example/", prefix: "/seafhttp/" }],
      fetch: async (input, init) => {
        const url = new URL(input), headers = new Headers(init.headers);
        if (url.pathname.startsWith("/seafhttp/")) {
          if (headers.has("authorization") || init.credentials !== "omit" || init.redirect !== "manual") {
            throw new Error("Packed Seafile capability authority leaked");
          }
          if (init.method === "POST") {
            const file = init.body.get("file");
            assertBytes(new Uint8Array(await file.arrayBuffer()), seafileBody);
            return new Response(JSON.stringify([{ id: "opaque-file-object", name: "native (1).bin", size: 3 }]));
          }
          return new Response(seafileBody.slice(), { headers: { "content-length": "3" } });
        }
        if (headers.get("authorization") !== "Token private-api-token") {
          throw new Error("Packed Seafile API authority changed");
        }
        if (url.pathname.endsWith("/upload-link/")) {
          return new Response(JSON.stringify("https://seafile.example/seafhttp/upload/token"));
        }
        if (url.pathname.endsWith("/file/")) {
          return new Response(JSON.stringify("https://seafile.example/seafhttp/files/token/native.bin"));
        }
        return new Response(
          JSON.stringify({ id: seafileLibrary, name: "Native library", encrypted: false, permission: "rw" }),
        );
      },
    });
    const seafileSaved = await seafile.upload("/", "native.bin", seafileBody);
    if (seafileSaved.name !== "native (1).bin" || seafileSaved.size !== 3) {
      throw new Error("Packed Seafile native collision receipt changed");
    }
    assertBytes(await seafile.read("/" + seafileSaved.name), seafileBody);
  });
  it("Supabase public and signed data authority", async () => {
    const supabaseBody = new TextEncoder().encode("native REST bytes");
    let supabaseAuth = 0;
    const supabase = new SupabaseClient({
      endpoint: "https://storage.invalid/storage/v1/",
      bucket: "notes",
      credentials: () => {
        supabaseAuth++;
        return { accessToken: "api-token", apiKey: "gateway" };
      },
      signedOrigins: ["https://storage.invalid"],
      fetch: async (input, init) => {
        const target = new URL(input.toString()), headers = new Headers(init?.headers);
        if (target.pathname.includes("/object/sign/") && init?.method === "POST") {
          if (headers.get("authorization") !== "Bearer api-token") {
            throw new Error("Packed Supabase API authority changed");
          }
          return new Response(JSON.stringify({ signedURL: "/object/sign/notes/note.txt?token=explicit-capability" }));
        }
        if (headers.has("authorization") || headers.has("apikey")) {
          throw new Error("Packed Supabase media leaked API context");
        }
        return new Response(supabaseBody.slice());
      },
    });
    assertBytes(await supabase.read("note.txt", { access: "public" }), supabaseBody);
    const supabaseSigned = await supabase.createSignedUrl("note.txt", { expiresIn: 60 });
    assertBytes(await supabase.readSigned("note.txt", supabaseSigned), supabaseBody);
    if (supabaseAuth !== 1) throw new Error("Packed Supabase public/signed credentials changed");
  });
});
