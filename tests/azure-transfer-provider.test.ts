import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobServiceClient, StorageSharedKeyCredential } from "@azure/storage-blob";
import { withReleases } from "./close.ts";
import { createAzureClient } from "../src/azure.ts";
import { createAzureSession, createAzureUploadDestination } from "../src/transfer/azure.ts";
import { createTransferCheckpoint } from "../src/transfer.ts";
import { AZURE_ACCOUNT, AZURE_KEY, openProviders, STORAGE_NAME } from "./provider/fixture.ts";

/** Waits for an owned child; a timeout kills it and close confirms its retirement. */
async function child(
  code: string,
  mode: string,
): Promise<{ code: number | null; signal: string | null; output: string }> {
  const process = spawn("node", ["--input-type=module", "-e", code, mode], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  process.stdout.setEncoding("utf8").on("data", (value: string) => output += value);
  process.stderr.setEncoding("utf8").on("data", (value: string) => output += value);
  const timer = setTimeout(() => process.kill("SIGKILL"), 45_000);
  try {
    return await new Promise((resolve, reject) => {
      process.once("error", reject);
      process.once("close", (code, signal) => resolve({ code, signal, output }));
    });
  } finally {
    clearTimeout(timer);
  }
}

describe("Azure continuation after process loss", () => {
  it("recovers lost block and final receipts from persisted state, verified through Azure SDK", async () => {
    await withReleases(async (releases) => {
      const providers = await openProviders();
      releases.push(() => providers.close());
      const directory = mkdtempSync(join(tmpdir(), "opfs-azure-restart-"));
      releases.push(() => rmSync(directory, { recursive: true, force: true }));
      const options = {
        endpoint: providers.azureEndpoint,
        container: STORAGE_NAME,
        credential: { kind: "shared-key" as const, account: AZURE_ACCOUNT, key: AZURE_KEY },
        request: { retries: 0 },
      };
      const client = createAzureClient(options);
      const setup = await client.request({ method: "PUT", query: { restype: "container" } });
      const setupText = await setup.text();
      expect(setup.ok || setup.status === 409, setupText).toBe(true);
      const blockBytes = 1024;
      const input = new Uint8Array(2 * blockBytes + 7);
      for (let index = 0; index < input.length; index++) input[index] = index % 251;
      const inputPath = join(directory, "input.bin");
      const checkpointPath = join(directory, "checkpoint.json");
      const sessionPath = join(directory, "session.json");
      const session = await createAzureSession(client, {
        key: "continuation/process-loss",
        size: input.length,
        blockBytes,
        token: "azure_process_loss_fixture_unique_001",
      });
      releases.push(() => client.delete(session.key));
      const destination = createAzureUploadDestination(client, session);
      writeFileSync(inputPath, input);
      writeFileSync(sessionPath, JSON.stringify(session));
      writeFileSync(
        checkpointPath,
        JSON.stringify(
          createTransferCheckpoint({
            identity: "fixture-input-v1",
            size: input.length,
            read: (offset, length) => Promise.resolve(input.slice(offset, offset + length)),
          }, destination),
        ),
      );
      const code = `
        import { readFileSync, writeFileSync, renameSync } from "node:fs";
        import { createAzureClient } from ${JSON.stringify(new URL("../src/azure.ts", import.meta.url).href)};
        import { createAzureUploadDestination } from ${
        JSON.stringify(new URL("../src/transfer/azure.ts", import.meta.url).href)
      };
        import { resumeTransfer } from ${JSON.stringify(new URL("../src/transfer.ts", import.meta.url).href)};
        const input = readFileSync(${JSON.stringify(inputPath)});
        const checkpointPath = ${JSON.stringify(checkpointPath)};
        const session = JSON.parse(readFileSync(${JSON.stringify(sessionPath)}, "utf8"));
        const client = createAzureClient({ ...${JSON.stringify(options)}, fetch: async (input, init) => {
          const response = await globalThis.fetch(input, init);
          const operation = new URL(String(input)).searchParams.get("comp");
          if (response.status === 201 && init?.method === "PUT" &&
            ((process.argv[1] === "block" && operation === "block") || (process.argv[1] === "commit" && operation === "blocklist"))) {
            process.kill(process.pid, "SIGKILL"); await new Promise(() => {});
          }
          return response;
        } });
        const destination = createAzureUploadDestination(client, session); const reads = [];
        const result = await resumeTransfer({ source: { identity: "fixture-input-v1", size: input.length,
          async read(offset, length) { reads.push(offset); return input.slice(offset, offset + length); } }, destination,
          chunkBytes: session.blockBytes, checkpoint: JSON.parse(readFileSync(checkpointPath, "utf8")),
          async save(value) { writeFileSync(checkpointPath + ".next", JSON.stringify(value)); renameSync(checkpointPath + ".next", checkpointPath); }
        });
        console.log(JSON.stringify({ result, reads }));
      `;
      const block = await child(code, "block");
      expect(block.signal, block.output).toBe("SIGKILL");
      expect(JSON.parse(readFileSync(checkpointPath, "utf8")).offset).toBe(0);
      const sdk = new BlobServiceClient(
        providers.azureEndpoint,
        new StorageSharedKeyCredential(AZURE_ACCOUNT, AZURE_KEY),
      );
      const blob = sdk.getContainerClient(STORAGE_NAME).getBlockBlobClient(session.key);
      expect((await blob.getBlockList("uncommitted")).uncommittedBlocks?.map((block) => block.size)).toEqual([
        blockBytes,
      ]);
      const commit = await child(code, "commit");
      expect(commit.signal, commit.output).toBe("SIGKILL");
      expect(JSON.parse(readFileSync(checkpointPath, "utf8")).offset).toBe(input.length);
      const restart = await child(code, "resume");
      expect(restart.code, restart.output).toBe(0);
      const report = JSON.parse(restart.output.trim().split("\n").at(-1)!);
      expect(report.result).toMatchObject({ state: "completed", offset: input.length });
      expect(report.reads).toEqual([]);
      expect(new Uint8Array(await blob.downloadToBuffer())).toEqual(input);
      expect((await blob.getProperties()).metadata?.opfs_session).toBe(session.token);
    });
  });
});
