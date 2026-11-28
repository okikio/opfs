/** Compile-only installed provider construction contracts; never execute these expressions. */
import { DriveClient } from "@okikio/opfs/drive";
import { OnedriveClient } from "@okikio/opfs/onedrive";
import { FtpClient } from "@okikio/opfs/ftp";
import { SftpClient } from "@okikio/opfs/sftp";
import { S3SessionSchema } from "@okikio/opfs/transfer/s3";
import type { S3SessionType } from "@okikio/opfs/transfer/s3";
import { AzureSessionSchema } from "@okikio/opfs/transfer/azure";
import type { AzureSessionType } from "@okikio/opfs/transfer/azure";

const drive = new DriveClient({ token: () => "type-only" });
const driveFile: string = (await drive.stat("file")).id;
void driveFile;
const onedrive = new OnedriveClient({ driveId: "typed", token: () => "type-only" });
const ftp = new FtpClient({
  host: "types.invalid",
  username: "user",
  password: "password",
  mode: "plain",
  transport: {
    async connect() {
      throw new Error("types only");
    },
  },
});
const ftpDone: Promise<void> = ftp.close();
const sftp = new SftpClient({
  async openChannel() {
    throw new Error("types only");
  },
});
const sftpDone: Promise<void> = sftp.close();
void sftpDone;
void onedrive;
void ftpDone;
const s3: S3SessionType = S3SessionSchema.parse({});
const azure: AzureSessionType = AzureSessionSchema.parse({});
void s3;
void azure;
