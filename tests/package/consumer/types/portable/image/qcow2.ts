/** Compile-only installed image qcow2 contracts; never execute these expressions. */
import { openQcow2 } from "@okikio/opfs/image/qcow2";
import { createByteSource } from "@okikio/opfs/source";

const qcow2OptionsTyped: import("@okikio/opfs/image/qcow2").Qcow2OpenOptionsType = { maxGuestBytes: 1048576 };
const qcow2Typed: import("@okikio/opfs/image/qcow2").Qcow2ImageType = await openQcow2(
  createByteSource(new Uint8Array()),
  qcow2OptionsTyped,
);
const qcow2MapTyped: readonly import("@okikio/opfs/image/qcow2").Qcow2SegmentType[] = qcow2Typed.map(0, 1);
const qcow2ValidationTyped: "active-mapping-bounds" = qcow2Typed.validation;
const qcow2IntegrityTyped: "none" = qcow2Typed.integrity;
const qcow2ReadOptionsTyped: import("@okikio/opfs/image/qcow2").Qcow2ReadOptionsType = { offset: 0, length: 1 };
const qcow2ReadTyped: import("@okikio/opfs/image/qcow2").Qcow2ReadType = await qcow2Typed.read(qcow2ReadOptionsTyped);
const qcow2SourceOptionsTyped: import("@okikio/opfs/image/qcow2").Qcow2SourceOptionsType = { maxRequests: 64 };
const qcow2SourceTyped: import("@okikio/opfs/source").ByteSourceType = qcow2Typed.source(qcow2SourceOptionsTyped);
void qcow2MapTyped;
void qcow2ValidationTyped;
void qcow2IntegrityTyped;
void qcow2ReadTyped;
void qcow2SourceTyped;
