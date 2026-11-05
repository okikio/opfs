import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { createEtcdClient, EtcdError } from "../src/etcd.ts";
import { close } from "./close.ts";
import { openEtcd } from "./provider/etcd.ts";

describe("etcd3.7.3 JSON gateway against the independent official etcdctl gRPC client", () => {
  it("preserves complete bytes, native conditional updates, lease choice and historical prefix pagination", {
    timeout: 300_000,
  }, async () => {
    const fixture = await openEtcd();
    let primary: readonly unknown[] = [];
    try {
      const encode = (name: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(name);
      const name = "literal/%?#雪", key = encode(name), original = new Uint8Array([0, 255, 17, 42, 128, 9]);
      await fixture.seed(name, original);
      const options = {
        endpoint: fixture.endpoint,
        allowHttp: true,
        credentials: () => fixture.token,
        policy: { retries: 0 },
      };
      const client = createEtcdClient(options), first = await client.get(key);
      expect(first.entry?.value).toEqual(original);
      expect(await fixture.read(name)).toEqual(original);
      expect((await client.put(key, new Uint8Array([99]), { create: true })).applied).toBe(false);
      const replacement = new Uint8Array([9, 128, 42, 17, 255, 0, 77]);
      const receipt = await client.put(key, replacement, { modRevision: first.entry!.modRevision, lease: "preserve" });
      expect(receipt.applied).toBe(true);
      expect(await fixture.read(name)).toEqual(replacement);
      expect((await client.put(key, original, { modRevision: first.entry!.modRevision, lease: "none" })).applied).toBe(
        false,
      );
      expect(await fixture.read(name)).toEqual(replacement);
      const emptyName = "existing-empty";
      expect((await client.put(encode(emptyName), new Uint8Array(), { create: true })).applied).toBe(true);
      expect(await fixture.read(emptyName)).toEqual(new Uint8Array());
      expect((await client.get(encode(emptyName))).entry?.value).toEqual(new Uint8Array());
      expect((await client.get(encode("missing"))).entry).toBeNull();

      const grant = await fixture.command(["lease", "grant", "600"]);
      const leaseHex = /^lease ([0-9a-f]{16}) granted with TTL\(600s\)$/mu.exec(grant)?.[1];
      if (leaseHex === undefined) throw new Error("Native etcdctl omitted its lease receipt.");
      const lease = BigInt(`0x${leaseHex}`).toString();
      await fixture.seed("leased", original, leaseHex);
      const leasedKey = encode("leased"), leased = (await client.get(leasedKey)).entry!;
      expect(leased.lease).toBe(lease);
      expect((await client.put(leasedKey, replacement, { modRevision: leased.modRevision, lease: "preserve" })).applied)
        .toBe(true);
      const preserved = (await client.get(leasedKey)).entry!;
      expect(preserved.lease).toBe(lease);
      expect((await client.put(leasedKey, original, { modRevision: preserved.modRevision, lease: "none" })).applied)
        .toBe(true);
      expect((await client.get(leasedKey)).entry?.lease).toBe("0");
      expect(await fixture.read("leased")).toEqual(original);

      await fixture.seed("page/a", original);
      await fixture.seed("page/b", replacement);
      const page = await client.list(encode("page/"), { limit: 1 });
      expect(page.entries.map((entry) => new TextDecoder().decode(entry.key))).toEqual(["page/a"]);
      expect(page.next).toBeDefined();
      await fixture.seed("page/b", original);
      await fixture.seed("page/c", original);
      const next = await client.list(encode("page/"), { limit: 1, cursor: page.next! });
      expect(next.revision).toBe(page.revision);
      expect(next.entries.map((entry) => new TextDecoder().decode(entry.key))).toEqual(["page/b"]);
      expect(next.entries[0]?.value).toEqual(replacement);
      expect(next.next).toBeUndefined();

      const current = (await client.get(key)).entry!;
      expect((await client.remove(key, { modRevision: first.entry!.modRevision })).applied).toBe(false);
      expect((await client.remove(key, { modRevision: current.modRevision })).applied).toBe(true);
      expect((await client.get(key)).entry).toBeNull();
      expect((await client.get(leasedKey)).entry?.value).toEqual(original);
      const denied = createEtcdClient({ ...options, credentials: () => "invalid-fixture-token" });
      try {
        await denied.get(leasedKey);
        throw new Error("Expected native authentication refusal.");
      } catch (reason) {
        expect(reason).toBeInstanceOf(EtcdError);
        expect((reason as EtcdError).status).toBe(401);
      }
    } catch (reason) {
      primary = [reason];
    } finally {
      await close([() => fixture.close()], primary);
    }
  });
});
