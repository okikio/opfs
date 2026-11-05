import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { close } from "../src/close.ts";
import { LakefsClient, LakefsError } from "../src/lakefs.ts";
import { startLakefs } from "./provider/lakefs.ts";

describe("native lakeFS server and official lakectl interoperability", () => {
  it(
    "keeps branch staging, native write conditions and committed full bytes distinct",
    { timeout: 180_000 },
    async () => {
      const fixture = await startLakefs();
      let primary: readonly unknown[] = [];
      try {
        const client = new LakefsClient({
          endpoint: fixture.endpoint,
          allowHttp: true,
          repository: "fixture",
          credentials: () => fixture.authorization,
          policy: { retries: 0 },
        });
        const bytes = new Uint8Array([0, 1, 255, 42, 17]);
        await fixture.put(bytes);
        expect(await client.read("main", "from-cli.bin")).toEqual(bytes);
        expect(await client.read("main", "from-cli.bin", { at: 1, length: 3 })).toEqual(bytes.slice(1, 4));
        const before = await client.getBranch("main");
        expect(before.id).toBe("main");
        await client.put("main", "from-client.bin", bytes, { ifNoneMatch: "*" });
        expect(await fixture.read("main", "from-client.bin")).toEqual(bytes);
        expect((await client.getBranch("main")).commit).toBe(before.commit);
        await expect(client.put("main", "from-client.bin", new Uint8Array([9]), { ifNoneMatch: "*" })).rejects
          .toMatchObject({ status: 412 });
        const changed = new Uint8Array([8, 7, 6]);
        // Swagger advertises If-Match, but the pinned native handler rejects every value.
        const refused = await fetch(
          new URL("api/v1/repositories/fixture/branches/main/objects?path=from-client.bin", fixture.endpoint),
          {
            method: "POST",
            headers: {
              authorization: fixture.authorization,
              "if-match": "native-checksum",
              "content-type": "application/octet-stream",
            },
            body: changed,
            redirect: "manual",
            credentials: "omit",
          },
        );
        await refused.arrayBuffer();
        expect(refused.status).toBe(501);
        await expect(client.put("main", "from-client.bin", changed, { ifMatch: "unsupported" as never })).rejects
          .toBeInstanceOf(TypeError);
        await client.put("main", "from-client.bin", changed);
        expect(await fixture.read("main", "from-client.bin")).toEqual(changed);
        const receipt = await client.commit("main", "candidate commit with both staged objects");
        expect((await client.getCommit(receipt.id)).id).toBe(receipt.id);
        expect(await fixture.command("log", "lakefs://fixture/main")).toContain(receipt.id);
        expect(await fixture.read(receipt.id, "from-client.bin")).toEqual(changed);
        await client.put("main", "from-client.bin", bytes);
        expect(await client.read(receipt.id, "from-client.bin")).toEqual(changed);
        expect(await fixture.read("main", "from-client.bin")).toEqual(bytes);
        expect((await client.listPage(receipt.id)).objects.map((value) => value.path)).toEqual([
          "from-cli.bin",
          "from-client.bin",
        ]);
        const contenders = await Promise.allSettled([
          client.put("main", "race.bin", bytes, { ifNoneMatch: "*" }),
          client.put("main", "race.bin", changed, { ifNoneMatch: "*" }),
        ]);
        expect(contenders.filter((value) => value.status === "fulfilled")).toHaveLength(1);
        const refusal = contenders.find((value) => value.status === "rejected");
        expect(refusal?.status === "rejected" ? refusal.reason : undefined).toMatchObject({ status: 412 });
        const winner = contenders[0]?.status === "fulfilled" ? bytes : changed;
        expect(await fixture.read("main", "race.bin")).toEqual(winner);
        await client.createBranch("independent", receipt.id);
        expect(await fixture.read("independent", "from-client.bin")).toEqual(changed);
        const denied = new LakefsClient({
          endpoint: fixture.endpoint,
          allowHttp: true,
          repository: "fixture",
          credentials: () => "Basic invalid",
          policy: { retries: 0 },
        });
        await expect(denied.getBranch("main")).rejects.toBeInstanceOf(LakefsError);
      } catch (reason) {
        primary = [reason];
        throw reason;
      } finally {
        await close([() => fixture.close()], primary);
      }
    },
  );
});
