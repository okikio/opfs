/** Compile-only installed provider upload contracts; never execute these expressions. */
import { NextcloudClient } from "@okikio/opfs/nextcloud";
import { createUploadClient, UploadSessionSchema } from "@okikio/opfs/upload";

const nextcloud = new NextcloudClient({
  endpoint: "https://cloud.example/",
  user: "caller",
  credentials: () => "Bearer caller-token",
});
const nextcloudUpload: import("@okikio/opfs/nextcloud").NextcloudUploadType = await nextcloud.createUpload(
  "types",
  "note.bin",
  1,
);
const nextcloudPart: import("@okikio/opfs/nextcloud").NextcloudPartType = await nextcloud.putPart(
  nextcloudUpload,
  1,
  new Uint8Array([1]),
);
const nextcloudReceipt: import("@okikio/opfs/nextcloud").NextcloudReceiptType = await nextcloud.finishUpload(
  nextcloudUpload,
  [nextcloudPart],
);
void nextcloudReceipt;
const uploadTyped: import("@okikio/opfs/upload").UploadClient = createUploadClient({
  profile: "draft-15",
  target: "https://upload.example/report",
});
const uploadSession: import("@okikio/opfs/upload").UploadSessionType = UploadSessionSchema.parse({});
const uploadResource: import("@okikio/opfs/upload").UploadResourceType = uploadTyped.open(uploadSession, {
  acknowledgedOffset: 0,
});
const uploadStatus: import("@okikio/opfs/upload").UploadStatusType = await uploadResource.status();
const uploadAppend: import("@okikio/opfs/upload").UploadAppendType = await uploadResource.append(
  0,
  new Uint8Array([1]),
);
const uploadReceipt: import("@okikio/opfs/upload").UploadReceiptType = await uploadResource.finish();
void uploadStatus;
void uploadAppend;
void uploadReceipt;
