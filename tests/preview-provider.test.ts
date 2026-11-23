import { it } from "node:test";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import { expect } from "@std/expect";
import { createGcsClient } from "../src/gcs.ts";
import { budgetSource, createSourceBudget, openObjectSource } from "../src/source.ts";
import { openZip } from "../src/archive/zip.ts";
import { createZipAdapter } from "../src/view/zip.ts";
import { createFileSystem } from "../mod.ts";
import { GCS_BUCKET, openGcs } from "./provider/gcs.ts";

it("uploads to a disposable GCS service and previews selected ZIP bytes through public layers", async () => {
  await using fixture = await openGcs();
  const client = createGcsClient({ bucket: GCS_BUCKET, endpoint: fixture.endpoint });
  const input = new Uint8Array(await readFile(new URL("./fixtures/archive/preview.zip", import.meta.url)));
  await client.put("preview.zip", input);
  const source = await openObjectSource(client, "preview.zip");
  const ledger = createSourceBudget({ maxBytes: 200_000, maxRequests: 20 });
  const archive = await openZip(budgetSource(source, ledger));
  expect(archive.entries.map((entry) => entry.name)).toEqual(["unrelated.bin", "preview.txt"]);
  const member = archive.entries.find((entry) => entry.name === "preview.txt")!;
  const preview = await archive.read(member.id, { length: 7 });
  expect(new TextDecoder().decode(preview.bytes)).toBe("preview");
  expect(preview.integrity).toBe("checksum-pending");
  const fileSystem = createFileSystem(createZipAdapter(archive), { coordination: "none" });
  expect(await fileSystem.readText("/preview.txt")).toBe("preview from a revision-bound remote archive\n");
  expect(fileSystem.inspect().support.write).toBe("unsupported");
  await expect(fileSystem.writeFile("/other.txt", "no")).rejects.toMatchObject({ code: "not-supported" });
  expect(ledger.inspect().bytes).toBeLessThan(input.byteLength / 4);
  await fileSystem[Symbol.asyncDispose]();
  await client.put("preview.zip", new Uint8Array([1, 2, 3]));
  // Version-retaining providers may still serve the old immutable generation.
  // The emulator's behavior is exercised separately from live cloud guarantees.
  try {
    const retained = await source.read(0, 4);
    expect(retained).toEqual(input.slice(0, 4));
  } catch (reason) {
    expect(reason).toMatchObject({ status: expect.any(Number) });
  }
});
