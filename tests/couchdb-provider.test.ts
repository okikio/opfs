import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { CouchdbError, createCouchdbClient } from "../src/couchdb.ts";
import { close } from "./close.ts";
import { openCouchdb } from "./provider/couchdb.ts";

describe("CouchDB3.5.3 attachments with the independent official Nano11.0.8 SDK", () => {
  it("preserves complete binary bytes, native revisions/ranges, sibling conflicts and attachment-only deletion", {
    timeout: 360_000,
  }, async () => {
    const fixture = await openCouchdb();
    let primary: readonly unknown[] = [];
    try {
      const original = new Uint8Array([0, 255, 17, 42, 128, 9]);
      const id = "literal/%?#雪", name = "binary/%?#雪";
      await fixture.seed(id, name, original);
      const options = {
        endpoint: fixture.endpoint,
        database: fixture.database,
        allowHttp: true,
        credentials: () => ({ authorization: fixture.authorization }),
        policy: { retries: 0 },
      };
      const client = createCouchdbClient(options), first = await client.document(id);
      expect(first.attachments[0]?.name).toBe(name);
      expect(first.attachments[0]?.length).toBe(original.length);
      expect(await client.read(id, name, { revision: first.revision })).toEqual(original);
      expect(await client.read(id, name, { revision: first.revision, at: 1, length: 3 })).toEqual(original.slice(1, 4));
      expect((await client.stat(id, name, { revision: first.revision })).etag).toBe(
        `"${first.attachments[0]!.digest.slice(4)}"`,
      );
      const denied = createCouchdbClient({
        ...options,
        credentials: () => ({ authorization: "Basic Zml4dHVyZTppbnZhbGlk" }),
      });
      try {
        await denied.document(id);
        throw new Error("expected native denial");
      } catch (reason) {
        expect(reason).toBeInstanceOf(CouchdbError);
        expect((reason as CouchdbError).status).toBe(401);
      }
      const sibling = await client.put(id, "sibling", new Uint8Array([8]), { revision: first.revision });
      expect(sibling.state).toBe("stored");
      expect(sibling.revision).not.toBe(first.revision);
      try {
        await client.put(id, name, new Uint8Array([99]), { revision: first.revision });
        throw new Error("expected native MVCC conflict");
      } catch (reason) {
        expect(reason).toBeInstanceOf(CouchdbError);
        expect((reason as CouchdbError).status).toBe(409);
      }
      expect(await fixture.read(id, name)).toEqual(original);
      const replacement = new Uint8Array([9, 128, 42, 17, 255, 0, 77]);
      const receipt = await client.put(id, name, replacement, { revision: sibling.revision });
      expect(receipt.state).toBe("stored");
      expect(await fixture.read(id, name)).toEqual(replacement);
      expect(await client.read(id, name, { revision: receipt.revision })).toEqual(replacement);
      const removed = await client.remove(id, name, { revision: receipt.revision });
      expect(removed.state).toBe("stored");
      const remaining = await client.document(id);
      expect(remaining.revision).toBe(removed.revision);
      expect(remaining.attachments.map((a) => a.name)).toEqual(["sibling"]);
      expect(await fixture.read(id, "sibling")).toEqual(new Uint8Array([8]));
      const created = await client.put("created", "empty", new Uint8Array(), { createDocument: true });
      expect(created.state).toBe("stored");
      expect(await fixture.read("created", "empty")).toEqual(new Uint8Array());
      try {
        await client.put("created", "other", new Uint8Array([1]), { createDocument: true });
        throw new Error("expected document creation conflict");
      } catch (reason) {
        expect(reason).toBeInstanceOf(CouchdbError);
        expect((reason as CouchdbError).status).toBe(409);
      }
    } catch (reason) {
      primary = [reason];
    } finally {
      await close([() => fixture.close()], primary);
    }
  });
});
