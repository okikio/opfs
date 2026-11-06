import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { openMemcachedClient } from "../src/memcached.ts";
import { openMemcached } from "./provider/memcached.ts";
import { close } from "./close.ts";

describe("Memcached1.6.45 native classic ASCII against independent libmemcached", () => {
  it("preserves complete binary values, flags, CAS staleness, creation outcomes and unconditional deletion", {
    timeout: 240_000,
  }, async () => {
    const fixture = await openMemcached();
    let primary: readonly unknown[] = [];
    const clients: (() => Promise<void>)[] = [];
    try {
      const original = Uint8Array.from({ length: 131072 }, (_, i) => (i * 37 + 17) % 256);
      const key = "literal/%?#key";
      await fixture.seed(key, original);
      const client = await openMemcachedClient({ openChannel: fixture.openChannel.bind(fixture) });
      clients.push(() => client.close());
      const initial = await client.get(key);
      expect(initial?.bytes).toEqual(original);
      expect(initial?.flags).toBe(4294967295);
      expect(initial?.cas).toBe((await fixture.read(key))?.cas);
      const expiry = { kind: "relative", seconds: 0 } as const;
      expect(await client.put(key, new Uint8Array([99]), { mode: "add", flags: 0, expiry })).toEqual({
        state: "not-stored",
      });
      expect((await fixture.read(key))?.bytes).toEqual(original);
      const replacement = new Uint8Array([0, 255, 13, 10, 128, 9, 77]);
      expect(await client.put(key, replacement, { mode: "cas", cas: initial!.cas, flags: 17, expiry })).toEqual({
        state: "stored",
      });
      expect((await fixture.read(key))?.bytes).toEqual(replacement);
      const updated = await client.get(key);
      expect(updated?.bytes).toEqual(replacement);
      expect(updated?.flags).toBe(17);
      expect(updated?.cas).not.toBe(initial!.cas);
      expect(await client.put(key, original, { mode: "cas", cas: initial!.cas, flags: 0, expiry })).toEqual({
        state: "exists",
      });
      expect((await fixture.read(key))?.bytes).toEqual(replacement);
      await fixture.seed(key, original);
      expect(await client.put(key, replacement, { mode: "cas", cas: updated!.cas, flags: 0, expiry })).toEqual({
        state: "exists",
      });
      expect((await client.get(key))?.bytes).toEqual(original);
      expect(await client.put("created-empty", new Uint8Array(), { mode: "add", flags: 0, expiry })).toEqual({
        state: "stored",
      });
      expect((await client.get("created-empty"))?.bytes).toEqual(new Uint8Array());
      expect((await fixture.read("created-empty"))?.bytes).toEqual(new Uint8Array());
      expect(await client.get("missing")).toBeNull();
      expect(await client.put("missing", replacement, { mode: "cas", cas: "1", flags: 0, expiry })).toEqual({
        state: "missing",
      });
      expect(await client.remove(key)).toBe(true);
      expect(await fixture.read(key)).toBeNull();
      expect(await client.remove(key)).toBe(false);
      expect((await client.get("created-empty"))?.bytes).toEqual(new Uint8Array());
    } catch (reason) {
      primary = [reason];
    } finally {
      await close([...clients, () => fixture.close()], primary);
    }
  });
});
