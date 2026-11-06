import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { createWebdavClient } from "../src/webdav.ts";
import { createWebdavAdapter } from "../src/adapter/webdav.ts";
import { createWebdavDriverFromClient } from "../src/driver/webdav.ts";
import { createFileSystem } from "../src/filesystem.ts";
import { close } from "./close.ts";
import { openOcis } from "./provider/ocis.ts";

describe("ownCloud Infinite Scale space compatibility through the existing WebDAV profile", () => {
  it(
    "preserves independent bytes and read guards while exposing native condition incompatibilities",
    { timeout: 600_000 },
    async () => {
      const fixture = await openOcis();
      let primary: readonly unknown[] = [];
      try {
        console.info("Native OCIS release:", fixture.version);
        const options = {
          endpoint: fixture.endpoint,
          headers: { authorization: fixture.authorization },
          namespace: `disposable-ocis-admin:${fixture.space}`,
          policy: { retries: 0 },
        };
        const client = createWebdavClient(options);
        const expected = new Uint8Array([0, 255, 17, 42, 128, 9]);
        await fixture.write("oracle.bin", expected);
        const source = await client.openSource("/oracle.bin");
        expect(source.size).toBe(expected.length);
        expect(await source.read(0, source.size)).toEqual(expected);
        expect(await source.read(1, 3)).toEqual(expected.slice(1, 4));
        expect((await client.stat("/oracle.bin"))?.size).toBe(expected.length);

        await client.mkdir("/folder");
        await client.put("/folder/space ü.bin", expected, { createOnly: true });
        expect(await fixture.read("folder/space ü.bin")).toEqual(expected);
        expect((await client.list("/folder")).map((entry) => entry.path)).toEqual(["/folder/space ü.bin"]);
        const previous = await client.openSource("/folder/space ü.bin");
        const metadata = await client.stat("/folder/space ü.bin");
        if (!metadata?.etag || !/^"[^"\r\n]+"$/u.test(metadata.etag)) {
          throw new Error("Native OCIS omitted a usable strong DAV ETag.");
        }
        const changed = new Uint8Array([7, 8, 9]);
        await client.put("/folder/space ü.bin", changed, { ifMatch: metadata.etag });
        expect(await fixture.read("folder/space ü.bin")).toEqual(changed);
        // This release ignores If-Match on GET. Record that native limitation,
        // then require the client to reject the returned replacement ETag.
        const stale = await fetch(new URL("folder/space%20%C3%BC.bin", fixture.endpoint), {
          headers: { authorization: fixture.authorization, "if-match": metadata.etag, range: "bytes=0-0" },
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
        });
        expect(stale.status).toBe(206);
        expect(stale.headers.get("etag")).not.toBe(metadata.etag);
        expect(new Uint8Array(await stale.arrayBuffer())).toEqual(changed.slice(0, 1));
        await expect(previous.read(0, 1)).rejects.toThrow("WebDAV GET returned a different revision.");
        await expect(client.put("/folder/space ü.bin", expected, { ifMatch: metadata.etag })).rejects.toMatchObject({
          status: 409,
        });
        expect(await fixture.read("folder/space ü.bin")).toEqual(changed);
        // A successful native receipt does not establish create-only safety:
        // release 8.2.2 accepts this request and overwrites the existing bytes.
        await client.put("/folder/space ü.bin", expected, { createOnly: true });
        expect(await fixture.read("folder/space ü.bin")).toEqual(expected);

        const invalid = createWebdavClient({ ...options, headers: { authorization: "Basic aW52YWxpZDppbnZhbGlk" } });
        await expect(invalid.stat("/oracle.bin")).rejects.toMatchObject({ status: 401 });
        let calls = 0;
        const observed = createWebdavClient({
          ...options,
          fetch: (input, init) => {
            calls++;
            return fetch(input, init);
          },
        });
        const driver = createWebdavDriverFromClient(observed);
        await expect(driver.remove("/folder")).rejects.toMatchObject({ code: "not-supported" });
        await expect(driver.remove("/oracle.bin")).rejects.toMatchObject({ code: "not-supported" });
        expect(calls).toBe(0);
        const files = createFileSystem(createWebdavAdapter(observed));
        try {
          // Qualify facade reads separately from native writes. Cooperative
          // noReplace admission does not prove atomic creation on this server.
          expect(await files.readFile("/oracle.bin")).toEqual(expected);
          const before = calls;
          await expect(files.writeFile("/oracle.bin", changed, { mode: "append" })).rejects.toMatchObject({
            code: "not-supported",
          });
          expect(calls).toBe(before);
        } finally {
          await files[Symbol.asyncDispose]();
        }
      } catch (reason) {
        primary = [reason];
        throw reason;
      } finally {
        await close([() => fixture.close()], primary);
      }
    },
  );
});
