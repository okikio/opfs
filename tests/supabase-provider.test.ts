import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { SupabaseClient, SupabaseError, SupabasePublicationError } from "../src/supabase.ts";
import { openSupabaseFixture, SUPABASE_BYTES } from "./provider/supabase.ts";
import { withReleases } from "./close.ts";

describe("native Supabase Storage REST and official storage-js", () => {
  it("cross-reads full bytes, preserves RLS and distinguishes public/signed authority and deletion omissions", {
    timeout: 600_000,
  }, async () => {
    await withReleases(async (releases) => {
      const fixture = await openSupabaseFixture();
      releases.push(() => fixture.close());
      const open = (bucket: string, accessToken?: string) =>
        new SupabaseClient({
          endpoint: fixture.endpoint,
          bucket,
          allowHttp: true,
          signedOrigins: [new URL(fixture.endpoint).origin],
          ...(accessToken === undefined ? {} : { credentials: () => ({ accessToken }) }),
        });
      const files = open("private", fixture.user), key = "allowed/oracle.txt";
      const info = await files.info(key);
      expect(info.size).toBe(new TextEncoder().encode(SUPABASE_BYTES).length);
      expect(info.key).toBe(key);
      expect(new TextDecoder().decode(await files.read(key, { access: "authenticated" }))).toBe(SUPABASE_BYTES);
      expect(new TextDecoder().decode(await files.read(key, { access: "authenticated", at: 2, length: 9 }))).toBe(
        SUPABASE_BYTES.slice(2, 11),
      );
      expect((await files.listPage("")).items).toContainEqual({ kind: "prefix", name: "allowed" });
      await expect(open("private", fixture.other).info(key)).rejects.toBeInstanceOf(SupabaseError);
      expect(new TextDecoder().decode(await open("public").read("oracle.txt", { access: "public" }))).toBe(
        SUPABASE_BYTES,
      );
      const signed = await files.createSignedUrl(key, { expiresIn: 60 });
      expect(new TextDecoder().decode(await files.readSigned(key, signed))).toBe(SUPABASE_BYTES);
      const bytes = new TextEncoder().encode("candidate raw REST bytes, independently read by storage-js\n"),
        target = "allowed/candidate.txt";
      expect((await files.upload(target, bytes, { mode: "create", mediaType: "text/plain" })).key).toBe(target);
      expect(await fixture.sdk("read", "private", target)).toEqual(Array.from(bytes));
      await expect(files.upload(target, bytes, { mode: "create" })).rejects.toBeInstanceOf(SupabasePublicationError);
      const replacement = new TextEncoder().encode("explicit native upsert replacement\n");
      await files.upload(target, replacement, { mode: "upsert" });
      expect(await fixture.sdk("read", "private", target)).toEqual(Array.from(replacement));
      const removed = await files.remove([key, "hidden/oracle.txt"]);
      expect(removed.map((entry) => entry.key)).toEqual([key]);
      expect(await fixture.sdk("read", "private", "hidden/oracle.txt")).toEqual(
        Array.from(new TextEncoder().encode(SUPABASE_BYTES)),
      );
    });
  });
});
