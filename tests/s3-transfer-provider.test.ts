import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { withReleases } from "./close.ts";
import { createS3Client } from "../src/s3.ts";
import { createS3Session, createS3UploadDestination } from "../src/transfer/s3.ts";
import { createTransferCheckpoint } from "../src/transfer.ts";
import { openProviders, S3_ACCESS_KEY, S3_LIST_ENCODING, S3_SECRET_KEY, STORAGE_NAME } from "./provider/fixture.ts";

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

describe("S3 continuation after process loss", () => {
  it("recovers before part and final checkpoint saves, then verifies bytes with the AWS SDK", async () => {
    await withReleases(async (releases) => {
      const providers = await openProviders();
      releases.push(() => providers.close());
      const directory = mkdtempSync(join(tmpdir(), "opfs-s3-restart-"));
      releases.push(() => rmSync(directory, { recursive: true, force: true }));
      const options = {
        endpoint: providers.s3Endpoint,
        region: "us-east-1",
        bucket: STORAGE_NAME,
        listEncoding: S3_LIST_ENCODING,
        credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
        request: { retries: 0 },
      };
      const client = createS3Client(options);
      const partBytes = 5 * 1024 * 1024;
      const input = new Uint8Array(partBytes + 7);
      for (let index = 0; index < input.length; index++) input[index] = index % 251;
      const inputPath = join(directory, "input.bin");
      const checkpointPath = join(directory, "checkpoint.json");
      const session = await createS3Session(client, {
        key: "continuation/process-loss",
        size: input.length,
        partBytes,
        token: "s3_process_loss_fixture_unique_001",
      });
      releases.push(() => client.delete(session.key));
      releases.push(() => client.abortUpload(session));
      const destination = createS3UploadDestination(client, session);
      const sdk = new S3Client({ ...options, forcePathStyle: true, maxAttempts: 1 });
      releases.push(() => sdk.destroy());
      writeFileSync(inputPath, input);
      writeFileSync(
        checkpointPath,
        JSON.stringify(createTransferCheckpoint({
          identity: "fixture-input-v1",
          size: input.length,
          async read(offset, length) {
            return input.slice(offset, offset + length);
          },
        }, destination)),
      );
      const code = `
        import { readFileSync, writeFileSync, renameSync } from "node:fs";
        import { createS3Client } from ${JSON.stringify(new URL("../src/s3.ts", import.meta.url).href)};
        import { createS3UploadDestination } from ${
        JSON.stringify(new URL("../src/transfer/s3.ts", import.meta.url).href)
      };
        import { resumeTransfer } from ${JSON.stringify(new URL("../src/transfer.ts", import.meta.url).href)};
        const input = readFileSync(${JSON.stringify(inputPath)});
        const checkpointPath = ${JSON.stringify(checkpointPath)};
        const mode = process.argv[1];
        const client = createS3Client({ ...${JSON.stringify(options)}, fetch: async (url, init) => {
          const response = await fetch(url, init);
          const params = new URL(String(url)).searchParams;
          if (response.ok && ((mode === "part" && init.method === "PUT" && params.has("partNumber")) ||
            (mode === "commit" && init.method === "POST" && params.has("uploadId")))) {
            // Kill after complete response consumption: remote effect is acknowledged to Fetch,
            // but the client and application checkpoint have not observed that acknowledgment.
            await response.arrayBuffer();
            process.kill(process.pid, "SIGKILL");
            await new Promise(() => {});
          }
          return response;
        }});
        const destination = createS3UploadDestination(client, ${JSON.stringify(session)});
        const reads = [];
        const result = await resumeTransfer({
          source: { identity: "fixture-input-v1", size: input.length, async read(offset, length) {
            reads.push(offset); return input.slice(offset, offset + length);
          } }, destination, chunkBytes: ${partBytes},
          checkpoint: JSON.parse(readFileSync(checkpointPath, "utf8")),
          async save(value) {
            writeFileSync(checkpointPath + ".next", JSON.stringify(value));
            renameSync(checkpointPath + ".next", checkpointPath);
          }
        });
        console.log(JSON.stringify({ result, reads }));
      `;
      const part = await child(code, "part");
      expect(part.signal, part.output).toBe("SIGKILL");
      expect(JSON.parse(readFileSync(checkpointPath, "utf8")).offset).toBe(0);
      expect((await client.listParts(session)).parts.map((part) => part.size)).toEqual([partBytes]);
      const commit = await child(code, "commit");
      expect(commit.signal, commit.output).toBe("SIGKILL");
      expect(JSON.parse(readFileSync(checkpointPath, "utf8")).offset).toBe(input.length);
      const restart = await child(code, "resume");
      expect(restart.code, restart.output).toBe(0);
      const report = JSON.parse(restart.output.trim().split("\n").at(-1)!);
      expect(report.result).toMatchObject({ state: "completed", offset: input.length });
      expect(report.reads).toEqual([]);
      const object = await sdk.send(new GetObjectCommand({ Bucket: STORAGE_NAME, Key: session.key }));
      expect(await object.Body!.transformToByteArray()).toEqual(input);
    });
  });
});
