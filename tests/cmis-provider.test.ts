import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { createCmisClient } from "../src/cmis.ts";
import { close } from "./close.ts";
import { openCmis } from "./provider/cmis.ts";

describe("CMIS Browser Binding against the independent archival Apache implementation", () => {
  it("preserves complete SDK/client bytes, native IDs, typed metadata, paging and actual change-token evidence", {
    timeout: 600_000,
  }, async () => {
    const fixture = await openCmis();
    let primary: readonly unknown[] = [];
    try {
      const bytes = new Uint8Array([0, 255, 17, 42, 128, 9]);
      const original = await fixture.seed("oracle.bin", bytes);
      const options = {
        repository: "A1",
        repositoryUrl: fixture.repositoryUrl,
        rootUrl: fixture.rootUrl,
        credentials: () => ({ authorization: fixture.authorization }),
        allowHttp: true,
        policy: { retries: 0 },
      };
      const client = createCmisClient(options);
      const repository = await client.repository();
      expect(repository.root).toBe(original.root);
      expect(repository.version).toBe("1.1");
      const metadata = await client.get(original.id);
      expect(metadata.id).toBe(original.id);
      expect(metadata.name).toBe("oracle.bin");
      expect(metadata.properties["cmis:contentStreamLength"]?.values).toEqual(["6"]);
      expect(await client.read(original.id)).toEqual(bytes);
      expect((await client.list(original.root, { limit: 1 })).objects.map((entry) => entry.id)).toEqual([original.id]);

      const created = await client.create(original.root, "candidate.bin", bytes, { versioningState: "none" });
      expect(created.id).not.toBe(original.id);
      expect(await fixture.read(created.id)).toEqual(bytes);
      const first = await client.list(original.root, { limit: 1 });
      expect(first.more).toBe(true);
      expect(first.next).toBe(1);
      const skip = first.next;
      if (skip === undefined) throw new Error("Native CMIS child page omitted its advancing offset.");
      const second = await client.list(original.root, { limit: 1, skip });
      expect(new Set([...first.objects, ...second.objects].map((entry) => entry.id))).toEqual(
        new Set([original.id, created.id]),
      );

      const token = created.properties["cmis:changeToken"]?.values?.[0];
      if (typeof token !== "string" || token.length === 0) {
        throw new Error("Native CMIS oracle omitted a change token; replacement remains unqualified.");
      }
      expect(repository.contentUpdates).toBe("anytime");
      const changed = new Uint8Array([7, 8, 9]);
      const replaced = await client.replace(created.id, changed, { changeToken: token });
      expect(await fixture.read(replaced.id)).toEqual(changed);
      expect(await client.read(replaced.id)).toEqual(changed);
      const nextToken = replaced.properties["cmis:changeToken"]?.values?.[0];
      expect(nextToken).not.toBe(token);
      await expect(client.replace(replaced.id, bytes, { changeToken: token })).rejects.toMatchObject({
        status: 409,
        exception: "updateConflict",
      });
      expect(await fixture.read(replaced.id)).toEqual(changed);
      const invalid = createCmisClient({
        ...options,
        credentials: () => ({ authorization: "Basic aW52YWxpZDppbnZhbGlk" }),
      });
      // The archival WAR does not install an authentication filter. Preserve
      // that native limitation rather than treating configured users as HTTP auth.
      expect((await invalid.get(original.id)).id).toBe(original.id);
    } catch (reason) {
      primary = [reason];
      throw reason;
    } finally {
      await close([() => fixture.close()], primary);
    }
  });
});
