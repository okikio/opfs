import { after, before, describe, it } from "node:test";
import { expect } from "@std/expect";

import { createFileSystem } from "../mod.ts";
import { createGcsAdapter } from "../src/adapter/gcs.ts";
import { createGcsClient, GCS_CHUNK_BYTES, type GcsClientType, GcsError } from "../src/gcs.ts";
import { GCS_BUCKET, type GcsFixture, openGcs } from "./provider/gcs.ts";

/** Real HTTP against a pinned emulator proves this profile, not Google's IAM or durability. */
describe("GCS Testcontainers JSON API profile", () => {
  let fixture: GcsFixture;
  let client: GcsClientType;
  before(async () => {
    fixture = await openGcs();
    client = createGcsClient({ endpoint: fixture.endpoint, bucket: GCS_BUCKET, request: { retries: 0 } });
  });
  after(async () => {
    await fixture?.close();
  });

  it("uploads, ranges, lists and deletes through native HTTP", async () => {
    const receipt = await client.put("native/data.bin", new Uint8Array([11, 22, 33, 44]), { ifNoneMatch: "*" });
    expect(receipt.size).toBe(4);
    expect(receipt.revision?.kind).toBe("generation");
    expect(
      new Uint8Array(
        await new Response(await client.get("native/data.bin", { at: 1, length: 2, revision: receipt.revision! }))
          .arrayBuffer(),
      ),
    ).toEqual(new Uint8Array([22, 33]));
    expect((await client.list({ prefix: "native/" })).objects.map((entry) => entry.key)).toContain("native/data.bin");
    await client.delete("native/data.bin", { revision: receipt.revision! });
    expect(await client.head("native/data.bin")).toBeNull();
  });

  it("rejects stale generation replacement and preserves the admitted revision", async () => {
    const first = await client.put("conflict.bin", new Uint8Array([1]));
    const next = await client.put("conflict.bin", new Uint8Array([2]), { revision: first.revision! });
    expect(next.revision?.value).not.toBe(first.revision?.value);
    await expect(client.put("conflict.bin", new Uint8Array([3]), { revision: first.revision! })).rejects.toBeInstanceOf(
      GcsError,
    );
    expect(new Uint8Array(await new Response(await client.get("conflict.bin")).arrayBuffer())).toEqual(
      new Uint8Array([2]),
    );
  });

  it("projects mkdir/write/read/append through the generic object adapter", async () => {
    await using filesystem = createFileSystem(createGcsAdapter(client));
    await filesystem.writeFile("/files/value.txt", "first", { parents: true });
    await filesystem.writeFile("/files/value.txt", "+next", { mode: "append" });
    expect(await filesystem.readText("/files/value.txt")).toBe("first+next");
  });

  it("reports a real competing append as locked while preserving the competing writer", async () => {
    await client.put("adapter-conflict", new Uint8Array([1]));
    let raced = false;
    const contender = createGcsClient({
      endpoint: fixture.endpoint,
      bucket: GCS_BUCKET,
      request: { retries: 0 },
      fetch: async (input, init) => {
        if (!raced && init?.method === "POST" && new URL(String(input)).searchParams.has("ifGenerationMatch")) {
          raced = true;
          await client.put("adapter-conflict", new Uint8Array([2]));
        }
        return await fetch(input, init);
      },
    });
    const adapter = createGcsAdapter(contender);
    await expect(adapter.writeFile("/adapter-conflict", new Uint8Array([3]), { mode: "append" })).rejects.toMatchObject(
      { name: "FileSystemError", code: "locked", cause: expect.any(GcsError) },
    );
    expect(new Uint8Array(await new Response(await client.get("adapter-conflict")).arrayBuffer())).toEqual(
      new Uint8Array([2]),
    );
  });

  it("continues an acknowledged session extent through a new client", async () => {
    const total = GCS_CHUNK_BYTES + 3;
    const upload = await client.createUpload("resume.bin", { size: total, ifNoneMatch: "*" });
    const first = await client.writeUpload(upload, new Uint8Array(GCS_CHUNK_BYTES).fill(17), { offset: 0, total });
    expect(first).toEqual({ complete: false, offset: GCS_CHUNK_BYTES });
    const reopened = createGcsClient({ endpoint: fixture.endpoint, bucket: GCS_BUCKET, request: { retries: 0 } });
    expect(
      await reopened.writeUpload(upload, new Uint8Array([21, 22, 23]), { offset: GCS_CHUNK_BYTES, total, final: true }),
    ).toMatchObject({ complete: true, offset: total, receipt: { size: total } });
    expect(
      new Uint8Array(
        await new Response(await reopened.get("resume.bin", { at: GCS_CHUNK_BYTES, length: 3 })).arrayBuffer(),
      ),
    ).toEqual(new Uint8Array([21, 22, 23]));
  });

  it.skip("reconciles an interrupted session: fake-gcs-server 1.56.1 turns a status query into partial publication", async () => {
    // The emulator returns 200 and the partial object after bytes */total.
    // Google's protocol requires 308 plus retained Range for an incomplete upload.
    // Deterministic tests cover that wire contract; a live GCS lane is still needed.
  });

  it("publishes empty objects used by explicit directory markers", async () => {
    expect(await client.put("empty", new Uint8Array())).toMatchObject({ size: 0 });
  });
});
