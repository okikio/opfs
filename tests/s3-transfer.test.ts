import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { createS3Client, S3Error } from "../src/s3.ts";
import { createS3Session, createS3UploadDestination, S3SessionSchema } from "../src/transfer/s3.ts";
import { createTransferCheckpoint, resumeTransfer } from "../src/transfer.ts";

const partBytes = 5 * 1024 * 1024;
const token = "unique_session_token_123456789";

/** Independent wire fixture: provider bytes and publication outlive every reopened library object. */
function fixture() {
  const parts = new Map<number, Uint8Array>();
  let published: Uint8Array | undefined;
  let allocated = false;
  let losePart = false;
  let loseCommit = false;
  let marker = token;
  let beforeList: (() => Promise<void>) | undefined;
  const requests: string[] = [];
  const client = () =>
    createS3Client({
      endpoint: "https://fixture.example",
      bucket: "bucket",
      region: "us-east-1",
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
      request: { retries: 0 },
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        requests.push(method);
        if (method === "POST" && url.searchParams.has("uploads")) {
          marker = new Headers(init?.headers).get("x-amz-meta-opfs-session")!;
          allocated = true;
          return new Response(
            "<InitiateMultipartUploadResult><UploadId>one</UploadId></InitiateMultipartUploadResult>",
          );
        }
        if (method === "GET" && url.searchParams.has("uploadId")) {
          await beforeList?.();
          if (!allocated) return new Response("<Error><Code>NoSuchUpload</Code></Error>", { status: 404 });
          return new Response(
            `<ListPartsResult><Key>data</Key><UploadId>one</UploadId><IsTruncated>false</IsTruncated>${
              [...parts].map(([number, bytes]) =>
                `<Part><PartNumber>${number}</PartNumber><ETag>"part-${number}"</ETag><Size>${bytes.length}</Size></Part>`
              ).join("")
            }</ListPartsResult>`,
          );
        }
        if (method === "PUT") {
          const bytes = new Uint8Array(await new Response(init?.body).arrayBuffer());
          const number = Number(url.searchParams.get("partNumber"));
          parts.set(number, bytes);
          if (losePart) {
            losePart = false;
            throw new Error("Lost part receipt");
          }
          return new Response(null, { headers: { etag: `"part-${number}"` } });
        }
        if (method === "POST" && url.searchParams.has("uploadId")) {
          published = new Uint8Array([...parts.values()].reduce((sum, bytes) => sum + bytes.length, 0));
          let offset = 0;
          for (const bytes of parts.values()) {
            published.set(bytes, offset);
            offset += bytes.length;
          }
          allocated = false;
          if (loseCommit) {
            loseCommit = false;
            throw new Error("Lost commit receipt");
          }
          return new Response('<CompleteMultipartUploadResult><ETag>"final"</ETag></CompleteMultipartUploadResult>');
        }
        if (method === "HEAD") {
          return published
            ? new Response(null, {
              headers: { "content-length": String(published.length), "x-amz-meta-opfs-session": marker },
            })
            : new Response(null, { status: 404 });
        }
        if (method === "DELETE") {
          allocated = false;
          return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected ${method} ${url}`);
      },
    });
  return {
    client,
    parts,
    requests,
    published: () => published,
    losePart: () => losePart = true,
    loseCommit: () => loseCommit = true,
    changeMarker: () => marker = "different-session",
    beforeList: (action: () => Promise<void>) => beforeList = action,
  };
}

describe("S3 multipart continuation", () => {
  it("rejects replacement-encoded and oversized keys before creating remote state", async () => {
    const server = fixture();
    for (const key of ["\ud800", "é".repeat(513)]) {
      await expect(createS3Session(server.client(), { key, size: 3, token, partBytes })).rejects.toThrow();
    }
    expect(server.requests).toEqual([]);
  });
  it("owns admitted part bytes before asynchronous provider reconciliation", async () => {
    const server = fixture();
    const client = server.client();
    const session = await createS3Session(client, { key: "data", size: 3, token, partBytes });
    const destination = createS3UploadDestination(client, session);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    server.beforeList(async () => {
      entered.resolve();
      await release.promise;
    });
    const input = new Uint8Array([1, 2, 3]);
    const writing = destination.write(0, input);
    await entered.promise;
    input.fill(9);
    release.resolve();
    await writing;
    expect(server.parts.get(1)).toEqual(new Uint8Array([1, 2, 3]));
  });
  it("reconciles a retained part and final publication after both acknowledgments are lost", async () => {
    const server = fixture();
    const session = await createS3Session(server.client(), { key: "data", size: partBytes + 3, token, partBytes });
    let destination = createS3UploadDestination(server.client(), session);
    const reads: number[] = [];
    const source = {
      identity: "immutable-data-v1",
      size: session.size,
      async read(offset: number, length: number) {
        reads.push(offset);
        return new Uint8Array(length).fill(offset === 0 ? 7 : 9);
      },
    };
    let checkpoint = createTransferCheckpoint(source, destination);
    const save = async (value: typeof checkpoint) => {
      checkpoint = structuredClone(value);
    };
    server.losePart();
    await expect(resumeTransfer({ source, destination, checkpoint, save, chunkBytes: partBytes })).rejects.toThrow();
    expect(checkpoint.offset).toBe(0);
    expect(server.parts.get(1)?.length).toBe(partBytes);
    destination = createS3UploadDestination(
      server.client(),
      S3SessionSchema.parse(JSON.parse(JSON.stringify(session))),
    );
    server.loseCommit();
    await expect(resumeTransfer({ source, destination, checkpoint, save, chunkBytes: partBytes })).rejects.toThrow();
    expect(checkpoint.offset).toBe(session.size);
    expect(checkpoint.state).toBe("active");
    destination = createS3UploadDestination(server.client(), session);
    const result = await resumeTransfer({ source, destination, checkpoint, save, chunkBytes: partBytes });
    expect(result.state).toBe("completed");
    expect(reads).toEqual([0, partBytes]);
    expect(server.published()?.slice(-3)).toEqual(new Uint8Array([9, 9, 9]));
    expect(server.requests.filter((method) => method === "PUT").length).toBe(2);
  });

  it("refuses malformed layouts, wrong chunks and changed backend before new writes", async () => {
    const server = fixture();
    const client = server.client();
    const session = await createS3Session(client, { key: "data", size: partBytes + 3, token, partBytes });
    const destination = createS3UploadDestination(client, session);
    await expect(destination.write(0, new Uint8Array(3))).rejects.toThrow(RangeError);
    server.parts.set(2, new Uint8Array(3));
    await expect(destination.status()).rejects.toThrow("layout");
    expect(() => createS3UploadDestination(client, { ...session, backend: "other" })).toThrow("different backend");
    expect(server.requests.filter((method) => method === "PUT")).toEqual([]);
  });

  it("never treats a missing upload or a different publication token as completion", async () => {
    const server = fixture();
    const client = server.client();
    const session = await createS3Session(client, { key: "data", size: 3, token, partBytes });
    const destination = createS3UploadDestination(client, session);
    await destination.write(0, new Uint8Array([1, 2, 3]));
    await destination.finish!();
    server.changeMarker();
    await expect(destination.status()).rejects.toThrow("without attributable");
    await destination.terminate!();
    expect(server.published()).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("rejects repeated cursors and malformed part numbers from native ListParts", async () => {
    for (
      const body of [
        '<Part><PartNumber>01</PartNumber><ETag>"a"</ETag><Size>3</Size></Part><IsTruncated>false</IsTruncated>',
        "<IsTruncated>true</IsTruncated><NextPartNumberMarker>0</NextPartNumberMarker>",
      ]
    ) {
      const client = createS3Client({
        endpoint: "https://fixture.example",
        bucket: "bucket",
        region: "us-east-1",
        credentials: { accessKeyId: "test", secretAccessKey: "test" },
        fetch: async () =>
          new Response(`<ListPartsResult><Key>data</Key><UploadId>one</UploadId>${body}</ListPartsResult>`),
      });
      await expect(client.listParts({ key: "data", id: "one" })).rejects.toThrow(SyntaxError);
    }
  });

  it("retains permission failures instead of treating every 404 as completed publication", async () => {
    const client = createS3Client({
      endpoint: "https://fixture.example",
      bucket: "bucket",
      region: "us-east-1",
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
      fetch: async () => new Response("<Error><Code>NoSuchBucket</Code></Error>", { status: 404 }),
    });
    const destination = createS3UploadDestination(client, {
      version: 1,
      backend: client.identity!,
      key: "data",
      id: "one",
      token,
      size: 3,
      partBytes,
    });
    await expect(destination.status()).rejects.toBeInstanceOf(S3Error);
  });

  it("reconciles ordered provider pages and cancels before another provider call", async () => {
    const cursors: string[] = [];
    const client = createS3Client({
      endpoint: "https://fixture.example",
      bucket: "bucket",
      region: "us-east-1",
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
      fetch: async (input) => {
        const cursor = new URL(String(input)).searchParams.get("part-number-marker")!;
        cursors.push(cursor);
        const first = cursor === "0";
        return new Response(`<ListPartsResult><Key>data</Key><UploadId>one</UploadId>
          <Part><PartNumber>${first ? 1 : 2}</PartNumber><ETag>"part"</ETag><Size>${first ? partBytes : 3}</Size></Part>
          <IsTruncated>${first}</IsTruncated>${first ? "<NextPartNumberMarker>1</NextPartNumberMarker>" : ""}
          </ListPartsResult>`);
      },
    });
    const destination = createS3UploadDestination(client, {
      version: 1,
      backend: client.identity!,
      key: "data",
      id: "one",
      token,
      size: partBytes + 3,
      partBytes,
    });
    expect(await destination.status()).toEqual({ offset: partBytes + 3, size: partBytes + 3, complete: false });
    expect(cursors).toEqual(["0", "1"]);
    const controller = new AbortController();
    controller.abort();
    await expect(destination.status({ signal: controller.signal })).rejects.toThrow();
    expect(cursors).toEqual(["0", "1"]);
  });
});
