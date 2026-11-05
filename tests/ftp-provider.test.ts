import { after, before, describe, it } from "node:test";
import { expect } from "@std/expect";
import { openFtpClient } from "../src/ftp.ts";
import { FTP_BYTES, openFtp } from "./provider/ftp.ts";
import type { FtpFixture } from "./provider/ftp.ts";
import { withReleases } from "./close.ts";

describe("pyftpdlib2.2.0 Testcontainers native FTP and TLS1.2", () => {
  let fixture: FtpFixture;
  before(async () => {
    fixture = await openFtp();
  });
  after(async () => {
    await fixture?.close();
  });
  it("reads ftplib-produced content through EPSV, MLST, MLSD and REST suffix", async () => {
    await withReleases(async (releases) => {
      const files = await openFtpClient(fixture.options("plain"));
      releases.push(() => files.close());
      expect((await files.stat("producer.txt")).size).toBe(FTP_BYTES.length);
      expect((await files.list(".")).map((value) => value.name).sort()).toEqual(["folder", "producer.txt"]);
      const read = await files.openRead("producer.txt", { offset: 12 });
      expect(await new Response(read.stream).text()).toBe(FTP_BYTES.slice(12));
      expect((await read.done).bytes).toBe(FTP_BYTES.length - 12);
    });
  });
  it("publishes bounded native STOR and independent ftplib confirms its stored bytes", async () => {
    await withReleases(async (releases) => {
      const files = await openFtpClient(fixture.options("plain"));
      releases.push(() => files.close());
      expect((await files.put("candidate.txt", new TextEncoder().encode("native FTP upload"))).bytes).toBe(17);
      expect(await fixture.read("candidate.txt")).toBe("native FTP upload");
    });
  });
  it("validates the test CA and resumes the authenticated TLS1.2 control session for private data", async () => {
    await withReleases(async (releases) => {
      const files = await openFtpClient(fixture.options("explicit-tls"));
      releases.push(() => files.close());
      const read = await files.openRead("producer.txt");
      expect(await new Response(read.stream).text()).toBe(FTP_BYTES);
      expect((await read.done).bytes).toBe(FTP_BYTES.length);
      await files.put("secure.txt", new TextEncoder().encode("native FTPS upload"));
      expect(await fixture.read("secure.txt")).toBe("native FTPS upload");
      expect(fixture.tls).toEqual({ controls: 1, data: 2, reused: 2 });
    });
  });
  it("refuses an untrusted certificate without downgrading to plain FTP", async () => {
    await expect(openFtpClient(fixture.options("explicit-tls", false))).rejects.toThrow();
    expect(fixture.tls.controls).toBe(1);
  });
});
