import { toLfsObject } from "@okikio/opfs/content/lfs";
import { encodeLfsPointer } from "@okikio/opfs/content/lfs";
/** Compile-only installed content git contracts; never execute these expressions. */
import { decodeLfsPointer, LfsClient } from "@okikio/opfs/content/lfs";
import { encodeGitTree, openGitObject } from "@okikio/opfs/content/git";
import { createByteSource } from "@okikio/opfs/source";

const gitObject = await openGitObject(createByteSource(new Uint8Array()), {
  algorithm: "sha256",
  oid: "0".repeat(64),
  subtle: globalThis.crypto.subtle,
});
const gitIntegrity: import("@okikio/opfs/content/git").GitAlgorithmType = gitObject.integrity;
const gitTree: Uint8Array = encodeGitTree([], { algorithm: "sha256" });
void gitIntegrity;
void gitTree;
const lfs = new LfsClient({ endpoint: "https://repo.example/lfs/", subtle: globalThis.crypto.subtle });
const pointer: import("@okikio/opfs/content/lfs").LfsPointerType = decodeLfsPointer(new Uint8Array());
const lfsReady: readonly import("@okikio/opfs/content/lfs").LfsResultType[] = await lfs.batch("download", [{
  oid: "0".repeat(64),
  size: 1,
}]);
void pointer;
void lfsReady;

// Retain the original named-export declaration check even without a call-site assertion.
void encodeLfsPointer;

// Retain the original named-export declaration check even without a call-site assertion.
void toLfsObject;
