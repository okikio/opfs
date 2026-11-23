import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { PocketbaseClient, PocketbaseError, PocketbasePublicationError } from "../src/pocketbase.ts";
import { openPocketbaseFixture, POCKETBASE_BYTES } from "./provider/pocketbase.ts";
import { withReleases } from "./close.ts";

describe("native PocketBase and official SDK", () => {
  it("cross-reads complete bytes, exercises native field changes and separates file tokens and permission rules", {
    timeout: 600_000,
  }, async () => {
    await withReleases(async (releases) => {
      const fixture = await openPocketbaseFixture();
      releases.push(() => fixture.close());
      const result = await fixture.sdk("setup");
      const schemas = result.slice(0, 3) as { collection: string; record: { id: string; documents: string[] } }[];
      const auth = result[3] as { admin: string; user: string };
      const open = (collection: string, token?: string) =>
        new PocketbaseClient({
          endpoint: fixture.endpoint,
          allowHttp: true,
          collection,
          field: "documents",
          ...(token === undefined ? {} : { credentials: () => token }),
        });
      const publicRecord = schemas[0]!.record, publicFiles = open("public_files", auth.admin);
      expect(new TextDecoder().decode(await publicFiles.read(publicRecord.id, publicRecord.documents[0]!))).toBe(
        POCKETBASE_BYTES,
      );
      expect(
        new TextDecoder().decode(
          await publicFiles.read(publicRecord.id, publicRecord.documents[0]!, { at: 2, length: 9 }),
        ),
      ).toBe(POCKETBASE_BYTES.slice(2, 11));
      expect((await publicFiles.listPage({ perPage: 1 })).items[0]!.id).toBe(publicRecord.id);
      const bytes = new TextEncoder().encode("candidate multipart upload, independently read by native SDK\n");
      const uploaded = await publicFiles.createRecord([{ name: "candidate.txt", bytes }], {
        data: { title: "candidate" },
      });
      expect(await fixture.sdk("read", "public_files", uploaded.id, uploaded.files[0]!)).toEqual([Array.from(bytes)]);
      const appended = await publicFiles.uploadFiles(uploaded.id, [{ name: "addition.txt", bytes }], {
        mode: "append",
      });
      expect(appended.files.length).toBe(2);
      const replaced = await publicFiles.uploadFiles(uploaded.id, [{ name: "replacement.txt", bytes }], {
        mode: "replace",
      });
      expect(replaced.files.length).toBe(1);
      expect((await publicFiles.deleteFiles(uploaded.id, replaced.files)).files).toEqual([]);
      await publicFiles.deleteRecord(uploaded.id);
      await expect(publicFiles.getRecord(uploaded.id)).rejects.toBeInstanceOf(PocketbaseError);

      const privateRecord = schemas[1]!.record, privateFiles = open("private_files", auth.user);
      // An API credential is deliberately not converted into a file token.
      await expect(privateFiles.read(privateRecord.id, privateRecord.documents[0]!)).rejects.toBeInstanceOf(
        PocketbaseError,
      );
      const fileToken = await privateFiles.fileToken();
      expect(
        new TextDecoder().decode(
          await privateFiles.read(privateRecord.id, privateRecord.documents[0]!, { token: fileToken }),
        ),
      ).toBe(POCKETBASE_BYTES);

      const updateOnlyRecord = schemas[2]!.record, updateOnly = open("update_only", `Bearer ${auth.user}`);
      expect((await updateOnly.deleteFiles(updateOnlyRecord.id, updateOnlyRecord.documents)).files).toEqual([]);
      // File-field changes use updateRule; deleting the entire record uses a distinct locked deleteRule.
      await expect(updateOnly.deleteRecord(updateOnlyRecord.id)).rejects.toBeInstanceOf(PocketbasePublicationError);
      expect((await updateOnly.getRecord(updateOnlyRecord.id)).id).toBe(updateOnlyRecord.id);
    });
  });
});
