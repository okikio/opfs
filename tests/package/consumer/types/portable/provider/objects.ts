/** Compile-only installed provider objects contracts; never execute these expressions. */
import { OciClient } from "@okikio/opfs/oci";
import { FirebaseClient } from "@okikio/opfs/firebase";
import { ResticClient } from "@okikio/opfs/restic";
import { LakefsClient } from "@okikio/opfs/lakefs";
import { createGcsClient, GcsStorageClassSchema } from "@okikio/opfs/gcs";
import { createGcsDriver } from "@okikio/opfs/driver/gcs";

const firebase = new FirebaseClient({
  bucket: "demo-opfs.appspot.com",
  credentials: () => ({ idToken: "types-only" }),
});
const firebaseMetadata: import("@okikio/opfs/firebase").FirebaseMetadataType = await firebase.stat("packed");
const firebaseStatus: import("@okikio/opfs/firebase").FirebaseStatusType = await firebase.statusUpload({
  url: "https://firebasestorage.googleapis.com/v0/b/demo-opfs.appspot.com/o?name=packed&upload_id=types",
  bucket: "demo-opfs.appspot.com",
  name: "packed",
  size: 3,
});
void firebaseMetadata;
void firebaseStatus;
const gcsNative = createGcsClient({ bucket: "types" });
const gcsClass: import("@okikio/opfs/gcs").GcsStorageClassType = GcsStorageClassSchema.parse("ARCHIVE");
const gcsReceipt: import("@okikio/opfs/gcs").GcsReceiptType = await gcsNative.put("object", new Uint8Array(), {
  storageClass: gcsClass,
});
const gcsMetadata: string | undefined = gcsReceipt.metageneration;
const gcsChecksum: string | undefined = gcsReceipt.crc32c;
const gcsGuard: import("@okikio/opfs/gcs").GcsHeadOptionsType = {
  revision: { kind: "generation", value: "18446744073709551615" },
  ifMetagenerationMatch: "9007199254740993",
};
const gcsRead: import("@okikio/opfs/gcs").GcsGetOptionsType = { ...gcsGuard, at: 0, length: 1 };
const gcsDelete: import("@okikio/opfs/gcs").GcsDeleteOptionsType = gcsGuard;
const gcsCopy: import("@okikio/opfs/gcs").GcsCopyOptionsType = {
  ...gcsGuard,
  sourceRevision: gcsGuard.revision,
  ifSourceMetagenerationMatch: "18446744073709551615",
};
const gcsDriver: import("@okikio/opfs/driver/gcs").GcsDriverType = createGcsDriver(gcsNative);
const gcsHead: import("@okikio/opfs/gcs").GcsStatType | null = await gcsDriver.head("object", gcsGuard);
const gcsList: import("@okikio/opfs/gcs").GcsListType = await gcsDriver.list({ prefix: "" });
const gcsDriverPut: import("@okikio/opfs/gcs").GcsReceiptType = await gcsDriver.put(
  "object",
  new Uint8Array(),
  gcsGuard,
);
const gcsDriverCopy: import("@okikio/opfs/gcs").GcsReceiptType = await gcsDriver.copy("source", "object", gcsCopy);
await gcsDriver.get("object", gcsRead);
await gcsDriver.delete("object", gcsDelete);
void gcsReceipt.storageClass;
void gcsMetadata;
void gcsChecksum;
void gcsHead?.metageneration;
void gcsList.objects[0]?.crc32c;
void gcsDriverPut.metageneration;
void gcsDriverCopy.crc32c;
const lakefs = new LakefsClient({ endpoint: "https://lake.example/", repository: "types" });
const lakefsPut: import("@okikio/opfs/lakefs").LakefsPutType = { ifNoneMatch: "*" };
const lakefsCommit: import("@okikio/opfs/lakefs").LakefsCommitType = await lakefs.commit("branch", "Publish");
void lakefsPut;
void lakefsCommit;
const restic = new ResticClient({ endpoint: "https://backup.example/repository/", subtle: globalThis.crypto.subtle });
const resticObject: import("@okikio/opfs/restic").ResticObjectType = { kind: "config" };
void restic;
void resticObject;
const registry = new OciClient({ registry: "https://registry.invalid/", repository: "types/content" });
const ociDigest: string = (await registry.getManifest("release")).digest;
void ociDigest;
