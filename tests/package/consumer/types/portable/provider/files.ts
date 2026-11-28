import { SupabaseClient } from "@okikio/opfs/supabase";
/** Compile-only installed provider files contracts; never execute these expressions. */
import { contentHash as dropboxContentHash, DropboxClient } from "@okikio/opfs/dropbox";
import { BoxClient } from "@okikio/opfs/box";
import { PcloudClient } from "@okikio/opfs/pcloud";
import { YandexClient } from "@okikio/opfs/yandex";
import { PocketbaseClient } from "@okikio/opfs/pocketbase";
import { SeafileClient } from "@okikio/opfs/seafile";

const dropbox = new DropboxClient({ token: () => "types-only" });
const dropboxHash: string = await dropboxContentHash(new Uint8Array(), { subtle: globalThis.crypto.subtle });
void dropbox;
void dropboxHash;
const box = new BoxClient({ token: () => "types-only" });
void box;
const pocketbase = new PocketbaseClient({
  endpoint: "https://pocket.example/",
  collection: "documents",
  field: "files",
});
const pocketRecord: import("@okikio/opfs/pocketbase").PocketbaseRecordType = await pocketbase.getRecord(
  "record000000001",
);
void pocketRecord;
const yandex = new YandexClient({ token: () => "types-only" });
const yandexPath: string = (await yandex.stat("disk:/packed")).path;
void yandexPath;
const pcloud = new PcloudClient({ endpoint: "https://api.pcloud.com", token: () => "types-only" });
const pcloudId: string = (await pcloud.statFile("7")).id;
const seafile = new SeafileClient({
  endpoint: "https://seafile.example/",
  library: "11111111-1111-1111-1111-111111111111",
  token: "caller-token",
});
const seafileReceipt: import("@okikio/opfs/seafile").SeafileReceiptType = await seafile.upload(
  "/",
  "file",
  new Uint8Array(),
);
void seafileReceipt;
void pcloudId;

// Retain the original named-export declaration check even without a call-site assertion.
void SupabaseClient;
