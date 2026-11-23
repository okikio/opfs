import { it } from "node:test";
import { expect } from "@std/expect";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createS3Client } from "../src/s3.ts";
import { openObjectSource } from "../src/source.ts";
import { openSilo } from "./provider/silo.ts";

it("uses a disposable PGSTY Silo with independent SDK bytes and fenced range reads", async () => {
  await using fixture = await openSilo();
  const { endpoint, bucket, region, credentials } = fixture;
  const sdk = new S3Client({ endpoint, region, credentials, forcePathStyle: true });
  try {
    const original = new Uint8Array([13, 21, 34, 55]);
    await sdk.send(new PutObjectCommand({ Bucket: bucket, Key: "member", Body: original }));
    const client = createS3Client({ endpoint, bucket, region, credentials });
    const source = await openObjectSource(client, "member");
    expect(await source.read(1, 2)).toEqual(new Uint8Array([21, 34]));
    await client.put("member", new Uint8Array([89, 144]));
    await expect(source.read(0, 1)).rejects.toMatchObject({ status: 412 });
    const read = await sdk.send(new GetObjectCommand({ Bucket: bucket, Key: "member" }));
    expect(await read.Body?.transformToByteArray()).toEqual(new Uint8Array([89, 144]));
    await client.delete("member");
    expect(await client.head("member")).toBeNull();
  } finally {
    sdk.destroy();
  }
});
