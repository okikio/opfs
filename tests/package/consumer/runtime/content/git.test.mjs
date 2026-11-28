/** Installed content git contracts. Each case owns its state and exact source oracle. */
import { describe, it } from "node:test";
import { createByteSource } from "@okikio/opfs/source";
import { decodeLfsPointer, encodeLfsPointer, LfsClient, toLfsObject } from "@okikio/opfs/content/lfs";
import { encodeGitTree, openGitObject } from "@okikio/opfs/content/git";
import { assertBytes } from "../../bytes.mjs";
import gitInput from "../../data/content/git.json" with { type: "json" };
import lfsPointerInput from "../../data/content/lfspointer.json" with { type: "json" };

describe("packed content git", () => {
  it("Git SHA-256 objects and empty trees", async () => {
    const gitFixture = gitInput;
    const git = await openGitObject(
      createByteSource(Uint8Array.from(atob(gitFixture.loose), (byte) => byte.charCodeAt(0))),
      { algorithm: "sha256", oid: gitFixture.oid, subtle: globalThis.crypto.subtle },
    );
    assertBytes(await git.read(), Uint8Array.from(atob(gitFixture.payload), (byte) => byte.charCodeAt(0)));
    if (encodeGitTree([], { algorithm: "sha256" }).length !== 0) throw new Error("Packed empty Git tree failed");
  });
  it("LFS pointers and download authority", async () => {
    const lfsPointerBytes = Uint8Array.from(atob(lfsPointerInput), (byte) => byte.charCodeAt(0));
    const lfsPointer = decodeLfsPointer(lfsPointerBytes);
    assertBytes(encodeLfsPointer(lfsPointer), lfsPointerBytes);
    const lfsObject = toLfsObject(lfsPointer);
    const lfs = new LfsClient({
      endpoint: "https://repo.example/lfs/",
      downloadOrigins: ["https://objects.example"],
      subtle: globalThis.crypto.subtle,
      credentials: () => ({ Authorization: "Bearer repository-only" }),
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.origin === "https://repo.example") {
          if (new Headers(init.headers).get("Authorization") !== "Bearer repository-only") {
            throw new Error("Packed LFS repository auth changed");
          }
          return Response.json({
            objects: [{ ...lfsObject, actions: { download: { href: "https://objects.example/body" } } }],
          });
        }
        if (new Headers(init.headers).has("Authorization")) throw new Error("Packed LFS leaked repository auth");
        return new Response("hello\n");
      },
    });
    const lfsSource = await lfs.openVerified(lfsObject);
    assertBytes(await lfsSource.read(1, 3), new TextEncoder().encode("ell"));
  });
});
