import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import { expect } from "@std/expect";
import { encodeBase64 } from "@std/encoding/base64";
import { compressStream, createCompressedTar } from "../src/archive/compress.ts";

function body(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset === bytes.length) return controller.close();
      const end = Math.min(offset + 127, bytes.length);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
  }, { highWaterMark: 0 });
}

describe("independent compressed output consumers", () => {
  for (const format of ["gzip", "deflate", "deflate-raw"] as const) {
    it(`Python gzip/zlib consumes native ${format} output byte for byte`, async () => {
      const expected = Uint8Array.from({ length: 4097 }, (_, index) => index % 251);
      const encoded = new Uint8Array(await new Response(compressStream(body(expected), format)).arrayBuffer());
      const code = `
import gzip, sys, zlib
data = sys.stdin.buffer.read()
sys.stdout.buffer.write(gzip.decompress(data) if sys.argv[1] == "gzip" else zlib.decompress(data, 15 if sys.argv[1] == "deflate" else -15))
`;
      const result = spawnSync("python3", ["-c", code, format], {
        input: encoded,
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, new TextDecoder().decode(result.stderr)).toBe(0);
      expect(new Uint8Array(result.stdout)).toEqual(expected);
    });
  }

  it("Python tarfile consumes streamed gzip TAR with PAX names and the complete payload", async () => {
    const name = "caf\u00e9/" + "long-path-".repeat(20);
    const expected = Uint8Array.from({ length: 4097 }, (_, index) => index % 251);
    const output = createCompressedTar([{ name, size: expected.length, body: body(expected) }], "gzip");
    const encoded = new Uint8Array(await new Response(output).arrayBuffer());
    const code = `
import base64, io, json, sys, tarfile
with tarfile.open(fileobj=io.BytesIO(sys.stdin.buffer.read()), mode="r:gz") as archive:
    entry = archive.next()
    data = archive.extractfile(entry).read()
    print(json.dumps({"name": entry.name, "size": entry.size, "body": base64.b64encode(data).decode()}))
    assert archive.next() is None
`;
    const result = spawnSync("python3", ["-c", code], {
      input: encoded,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ name, size: expected.length, body: encodeBase64(expected) });
  });
});
