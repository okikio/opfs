import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { ResticClient, ResticError, ResticPublicationError } from "../src/restic.ts";
import { startRestic } from "./provider/restic.ts";
import { withReleases } from "./close.ts";

describe("native restic REST opaque repository interoperability", () => {
  it("cross-checks actual encrypted packs with official CLI and native append-only deletion policy", {
    timeout: 300_000,
  }, async () => {
    await withReleases(async (release) => {
      const fixture = await startRestic();
      release.push(() => fixture.close());
      const options = { allowHttp: true, credentials: () => fixture.authorization, subtle: crypto.subtle };
      const scaffold = new ResticClient({ endpoint: `${fixture.endpoint}scaffold/`, ...options });
      await scaffold.createRepository();
      expect(await scaffold.list("data")).toEqual([]);
      expect(await scaffold.stat({ kind: "config" })).toBeNull();
      const source = new ResticClient({ endpoint: `${fixture.endpoint}source/`, ...options });
      const packs = await source.list("data");
      expect(packs.length).toBeGreaterThan(0);
      const pack = packs[0]!, object = { kind: "data" as const, id: pack.id };
      const native = await fixture.pack("source", pack.id);
      expect(await source.stat(object)).toEqual({ size: native.length });
      expect(await source.readVerified(object)).toEqual(native);
      expect(await source.read(object, { at: 3, length: 7 })).toEqual(native.subarray(3, 10));
      expect((await source.read({ kind: "config" })).length).toBeGreaterThan(0);

      const destination = new ResticClient({ endpoint: `${fixture.endpoint}destination/`, ...options });
      expect(await destination.save("data", native)).toEqual({ id: pack.id, size: native.length });
      expect(await fixture.pack("destination", pack.id)).toEqual(native);
      await expect(destination.save("data", native)).rejects.toBeInstanceOf(ResticPublicationError);
      await destination.remove(object);
      expect(await destination.stat(object)).toBeNull();

      const append = new ResticClient({ endpoint: `${fixture.appendEndpoint}append/`, ...options });
      await append.save("data", native);
      try {
        await append.remove(object);
        throw Error("expected append-only refusal");
      } catch (error) {
        expect(error).toBeInstanceOf(ResticPublicationError);
        expect((error as Error).cause).toBeInstanceOf(ResticError);
        expect(((error as Error).cause as ResticError).status).toBe(403);
      }
      expect(await append.readVerified(object)).toEqual(native);
      // Native append-only protection intentionally exempts lock objects; this is not a general retention guarantee.
      const lock = await append.save("locks", new TextEncoder().encode("opaque disposable lock object"));
      await append.remove({ kind: "locks", id: lock.id });
      expect(await append.stat({ kind: "locks", id: lock.id })).toBeNull();
      const denied = new ResticClient({
        endpoint: `${fixture.endpoint}source/`,
        allowHttp: true,
        credentials: () => "Basic d3Jvbmc6d3Jvbmc=",
      });
      await expect(denied.list("data")).rejects.toBeInstanceOf(ResticError);
    });
  });
});
