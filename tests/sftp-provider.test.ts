import { after, before, describe, it } from "node:test";
import { expect } from "@std/expect";
import { openSftpClient, SftpError } from "../src/sftp.ts";
import { openSftp, SFTP_BYTES, SFTP_ROOT } from "./provider/sftp.ts";
import type { SftpFixture } from "./provider/sftp.ts";
import { withReleases } from "./close.ts";

describe("OpenSSH Testcontainers SFTP v3 native packet profile", () => {
  let fixture: SftpFixture;
  before(async () => {
    fixture = await openSftp();
  });
  after(async () => {
    await fixture?.close();
  });
  it("reads independently uploaded content and native attributes/listings through a verified SSH subsystem", async () => {
    await withReleases(async (releases) => {
      const files = await openSftpClient(fixture.options());
      releases.push(() => files.close());
      expect((await files.stat(`${SFTP_ROOT}/producer.txt`)).size).toBe(SFTP_BYTES.length);
      expect((await files.list(SFTP_ROOT)).map((entry) => entry.name).sort()).toEqual(["folder", "producer.txt"]);
      const file = await files.openFile(`${SFTP_ROOT}/producer.txt`);
      releases.push(() => file.close());
      expect((await file.stat()).kind).toBe("file");
      const read = await file.read(3, SFTP_BYTES.length + 1);
      expect(new TextDecoder().decode(read.bytes)).toBe(SFTP_BYTES.slice(3));
      expect(read.eof).toBe(true);
    });
  });
  it("creates exclusively and acknowledges native writes that independent sftp CLI verifies", async () => {
    await withReleases(async (releases) => {
      const files = await openSftpClient(fixture.options());
      releases.push(() => files.close());
      const file = await files.openFile(`${SFTP_ROOT}/candidate.txt`, { mode: "create" });
      releases.push(() => file.close());
      expect(await file.write(0, new TextEncoder().encode("native packet upload"))).toEqual({ at: 0, bytes: 20 });
      await file.close();
      expect(await fixture.receipt()).toBe("native packet upload");
      await expect(files.openFile(`${SFTP_ROOT}/candidate.txt`, { mode: "create" })).rejects.toBeInstanceOf(SftpError);
      expect(files.closed).toBe(false);
    });
  });
  it("refuses the SSH channel when its adapter cannot verify the fixture host key", async () => {
    await expect(openSftpClient(fixture.options(false))).rejects.toThrow();
  });
});
