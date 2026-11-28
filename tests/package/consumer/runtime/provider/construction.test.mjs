/** Installed provider construction contracts. Each case owns its state and exact source oracle. */
import { describe, it } from "node:test";
import { DriveClient } from "@okikio/opfs/drive";
import { OnedriveClient } from "@okikio/opfs/onedrive";
import { FtpClient } from "@okikio/opfs/ftp";
import { SftpClient } from "@okikio/opfs/sftp";
import { createD1Adapter } from "@okikio/opfs/adapter/d1";
import { createS3Client } from "@okikio/opfs/s3";
import { createS3UploadDestination } from "@okikio/opfs/transfer/s3";
import { createAzureClient } from "@okikio/opfs/azure";
import { createAzureUploadDestination } from "@okikio/opfs/transfer/azure";

describe("packed provider construction", () => {
  it("S3 multipart continuation construction", async () => {
    let unexpectedS3Calls = 0;
    const s3 = createS3Client({
      endpoint: "https://fixture.invalid",
      bucket: "test",
      region: "us-east-1",
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
      fetch: async () => {
        unexpectedS3Calls++;
        throw new Error("Construction performed I/O");
      },
    });
    const upload = createS3UploadDestination(s3, {
      version: 1,
      backend: s3.identity,
      key: "test",
      id: "test",
      token: "packed_consumer_unique_session_001",
      size: 3,
      partBytes: 5 * 1024 * 1024,
    });
    if (unexpectedS3Calls || upload.protocol !== "s3-multipart-v1") {
      throw new Error("Packed S3 continuation construction contract failed");
    }
  });
  it("Azure block continuation construction", async () => {
    const azure = createAzureClient({
      endpoint: "https://fixture.invalid",
      container: "test",
      credential: { kind: "sas", token: "sv=test" },
      fetch: async () => {
        throw new Error("Construction performed I/O");
      },
    });
    const azureUpload = createAzureUploadDestination(azure, {
      version: 1,
      backend: azure.identity,
      key: "test",
      token: "packed_consumer_azure_session_001",
      size: 3,
      blockBytes: 4 * 1024 * 1024,
      initialETag: null,
    });
    if (azureUpload.protocol !== "azure-blocks-v1" || azureUpload.terminate !== undefined) {
      throw new Error("Packed Azure continuation construction contract failed");
    }
  });
  it("Drive construction without credentials", async () => {
    new DriveClient({
      token: () => {
        throw new Error("Construction obtained credentials");
      },
    });
  });
  it("OneDrive construction without OAuth", async () => {
    new OnedriveClient({
      driveId: "packed",
      token: () => {
        throw new Error("Construction obtained OAuth");
      },
    });
  });
  it("FTP construction and close without a socket", async () => {
    const ftp = new FtpClient({
      host: "fixture.invalid",
      username: "user",
      password: "password",
      mode: "plain",
      transport: {
        connect() {
          throw new Error("FTP construction acquired a socket");
        },
      },
    });
    await ftp.close();
  });
  it("SFTP construction and close without a channel", async () => {
    const sftp = new SftpClient({
      openChannel() {
        throw new Error("SFTP construction acquired a channel");
      },
    });
    await sftp.close();
  });
  it("D1 adapter public import", async () => {
    void createD1Adapter;
  });
});
