import { after, before, describe, it } from "node:test";
import { expect } from "@std/expect";
import { createWebdavClient } from "../src/webdav.ts";
import type { WebdavClientType } from "../src/webdav.ts";
import { createWebdavAdapter } from "../src/adapter/webdav.ts";
import { createFileSystem } from "../mod.ts";
import { openHttpSource } from "../src/http.ts";
import { openWebdav } from "./provider/webdav.ts";
import type { WebdavFixture } from "./provider/webdav.ts";

describe("WsgiDAV Testcontainers native and filesystem profile", () => {
  let fixture: WebdavFixture;
  let client: WebdavClientType;
  before(async () => {
    fixture = await openWebdav();
    client = createWebdavClient({ endpoint: fixture.endpoint, policy: { retries: 0 } });
  });
  after(async () => {
    await fixture?.close();
  });
  it("writes, lists slash-normalized collections and pins selected native ranges", async () => {
    await client.mkdir("/native");
    await client.put("/native/one", new Uint8Array([1, 2, 3]));
    expect((await client.stat("/native"))?.kind).toBe("directory");
    expect((await client.list("/native")).map((entry) => entry.path)).toEqual(["/native/one"]);
    const source = await client.openSource("/native/one");
    expect(await source.read(1, 2)).toEqual(new Uint8Array([2, 3]));
    await client.put("/native/one", new Uint8Array([4, 4, 4, 4]));
    await expect(source.read(0, 1)).rejects.toMatchObject({ status: 412 });
  });
  it("checks actual PUT conditions, COPY, MOVE and DELETE", async () => {
    const receipt = await client.put("/original", new Uint8Array([5, 6]), { createOnly: true });
    await expect(client.put("/original", new Uint8Array([1]), { createOnly: true })).rejects.toMatchObject({
      status: 412,
    });
    expect(receipt.etag).toBeDefined();
    await client.copy("/original", "/copied", { sourceIfMatch: receipt.etag! });
    await expect(client.copy("/original", "/copied")).rejects.toMatchObject({ status: 412 });
    await client.move("/copied", "/moved");
    expect(await client.stat("/copied")).toBeNull();
    await client.remove("/moved");
    expect(await client.stat("/moved")).toBeNull();
  });
  it("serves the independent HTTP HEAD/If-Match/range source through the same real server", async () => {
    await client.put("/http", new Uint8Array([11, 22, 33]));
    const source = await openHttpSource(`${fixture.endpoint}http`, {
      identity: "fixture-http-v1",
      policy: { retries: 0 },
    });
    expect(await source.read(1, 2)).toEqual(new Uint8Array([22, 33]));
    await client.put("/http", new Uint8Array([44, 55, 66, 77]));
    await expect(source.read(0, 1)).rejects.toMatchObject({ status: 412 });
  });
  it("refuses canonical removal without issuing any request", async () => {
    const { createWebdavDriverFromClient } = await import("../src/driver/webdav.ts");
    let calls = 0;
    const observed = createWebdavClient({
      endpoint: fixture.endpoint,
      fetch: (input, init) => {
        calls++;
        return fetch(input, init);
      },
    });
    const driver = createWebdavDriverFromClient(observed);
    await expect(driver.remove("/native")).rejects.toMatchObject({ code: "not-supported" });
    await expect(driver.remove("/native/one")).rejects.toMatchObject({ code: "not-supported" });
    expect(calls).toBe(0);
    expect((await client.stat("/native/one"))?.kind).toBe("file");
  });
  it("projects bounded reads and replacements while refusing append before provider I/O", async () => {
    let requests = 0;
    const observed = createWebdavClient({
      endpoint: fixture.endpoint,
      fetch: (input, init) => {
        requests++;
        return fetch(input, init);
      },
    });
    await using filesystem = createFileSystem(createWebdavAdapter(observed));
    await filesystem.writeFile("/files/one.txt", "hello", { parents: true });
    expect(await filesystem.readText("/files/one.txt")).toBe("hello");
    const previous = requests;
    await expect(filesystem.writeFile("/files/one.txt", "next", { mode: "append" })).rejects.toMatchObject({
      code: "not-supported",
    });
    expect(requests).toBe(previous);
  });
});
