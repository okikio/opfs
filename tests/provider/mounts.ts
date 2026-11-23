import type { HostProfileInputType } from "../../src/driver/host.ts";

/**
 * Authoritative policy for the pinned fixture's actual mount modes.
 * Mountpoint uses general-purpose S3 with allow-overwrite/allow-delete; BlobFuse uses block/file-cache.
 * Correctness and benchmark consumers must select the same declared contract.
 */
export const MOUNT_PROFILES: Readonly<Record<"mountpoint" | "blobfuse", HostProfileInputType>> = Object.freeze({
  mountpoint: "mountpoint-s3",
  blobfuse: "blobfuse-block",
});
