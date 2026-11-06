import { after, before, describe, it } from "node:test";
import { expect } from "@std/expect";
import { createSwiftClient } from "../src/swift.ts";
import type { SwiftClientType } from "../src/swift.ts";
import { createSwiftAdapter } from "../src/adapter/swift.ts";
import { createFileSystem } from "../mod.ts";
import { openObjectSource } from "../src/source.ts";
import { openSwift, SWIFT_CONTAINER } from "./provider/swift.ts";
import type { SwiftFixture } from "./provider/swift.ts";

/** Real Swift services, not a hand-authored HTTP double; excludes production auth, replication and middleware diversity. */
describe("Swift Testcontainers regular-object profile", () => {
  let fixture: SwiftFixture;
  let client: SwiftClientType;
  before(async () => {
    fixture = await openSwift();
    client = createSwiftClient({
      endpoint: fixture.endpoint,
      container: SWIFT_CONTAINER,
      token: fixture.token,
      request: { retries: 0 },
      pageSize: 1,
    });
  });
  after(async () => {
    await fixture?.close();
  });
  it("puts, pins ranges, lists marker pages and deletes native objects", async () => {
    const receipt = await client.put("native/one", new Uint8Array([1, 2, 3]), {
      ifNoneMatch: "*",
      metadata: { purpose: "preview" },
    });
    expect(receipt.size).toBe(3);
    expect((await client.head("native/one"))?.metadata).toEqual({ purpose: "preview" });
    const source = await openObjectSource(client, "native/one");
    expect(await source.read(1, 2)).toEqual(new Uint8Array([2, 3]));
    await expect(client.put("native/one", new Uint8Array([4]), { ifNoneMatch: "*" })).rejects.toMatchObject({
      status: 412,
    });
    await client.put("native/two", new Uint8Array([4]));
    const first = await client.list({ prefix: "native/" });
    expect(first.cursor).toBeDefined();
    const second = await client.list({ prefix: "native/", cursor: first.cursor! });
    expect(first.objects.map((entry) => entry.key)).toEqual(["native/one"]);
    expect(second.objects.map((entry) => entry.key)).toEqual(["native/two"]);
    expect(second.cursor).toBeDefined();
    expect(await client.list({ prefix: "native/", cursor: second.cursor! })).toEqual({ objects: [], prefixes: [] });
    await client.put("native/one", new Uint8Array([9, 9, 9]));
    await expect(source.read(0, 1)).rejects.toMatchObject({ status: 412 });
    await client.delete("native/one");
    expect(await client.head("native/one")).toBeNull();
  });
  it("streams one request without claiming a resumable session", async () => {
    const receipt = await client.put("streamed", new Blob([new Uint8Array([8, 9, 10])]).stream(), { size: 3 });
    expect(receipt.size).toBe(3);
    expect(new Uint8Array(await new Response(await client.get("streamed")).arrayBuffer())).toEqual(
      new Uint8Array([8, 9, 10]),
    );
  });
  it("refuses a real dynamic-large-object manifest instead of assembling it", async () => {
    const response = await fetch(`${fixture.endpoint}/${SWIFT_CONTAINER}/manifest`, {
      method: "PUT",
      headers: { "x-auth-token": fixture.token, "x-object-manifest": `${SWIFT_CONTAINER}/native/` },
      body: new Uint8Array(),
    });
    await response.arrayBuffer();
    expect(response.status).toBe(201);
    await expect(client.head("manifest")).rejects.toThrow(TypeError);
    await expect(client.get("manifest")).rejects.toThrow(TypeError);
  });
  it("projects regular objects through the driver and filesystem adapter", async () => {
    await using filesystem = createFileSystem(createSwiftAdapter(client));
    await filesystem.writeFile("/files/example.txt", "first", { parents: true });
    await filesystem.writeFile("/files/example.txt", "+next", { mode: "append" });
    expect(await filesystem.readText("/files/example.txt")).toBe("first+next");
  });
});
