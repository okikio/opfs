import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import { expect } from "@std/expect";
import { compressStream, createCompressedTar } from "../src/archive/compress.ts";
import { nativeEnvironment } from "./fixtures/codec.ts";

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
    it(`a separate Node zlib consumer reads native ${format} output byte for byte`, async () => {
      const expected = Uint8Array.from({ length: 4097 }, (_, index) => index % 251);
      const encoded = new Uint8Array(await new Response(compressStream(body(expected), format)).arrayBuffer());
      // This consumer imports only native zlib; it cannot validate output by calling the candidate decoder.
      const code = `
import { gunzipSync, inflateSync, inflateRawSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
const decode = { gzip: gunzipSync, deflate: inflateSync, 'deflate-raw': inflateRawSync }[process.argv[1]];
if (!decode) throw new Error('Unknown consumer format');
process.stdout.write(decode(readFileSync(0), { maxOutputLength: 65536 }));
`;
      const result = spawnSync("node", ["--input-type=module", "-e", code, format], {
        input: encoded,
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, new TextDecoder().decode(result.stderr)).toBe(0);
      expect(new Uint8Array(result.stdout)).toEqual(expected);
    });
  }

  it("native libarchive consumes streamed gzip TAR with PAX names and the complete payload", async () => {
    const name = "caf\u00e9/" + "long-path-".repeat(20);
    const expected = Uint8Array.from({ length: 4097 }, (_, index) => index % 251);
    const output = createCompressedTar([{ name, size: expected.length, body: body(expected) }], "gzip");
    const encoded = new Uint8Array(await new Response(output).arrayBuffer());
    // Libarchive converts PAX names through its locale. Select UTF-8 explicitly
    // rather than allowing an ambient C locale to refuse the original name.
    const environment = nativeEnvironment();
    const listing = spawnSync("bsdtar", ["-tf", "-"], {
      input: encoded,
      env: environment,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    expect(listing.error).toBeUndefined();
    expect(listing.status, listing.stderr).toBe(0);
    expect(listing.stdout).toBe(name + "\n");
    const result = spawnSync("bsdtar", ["-xOf", "-", name], {
      input: encoded,
      env: environment,
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, new TextDecoder().decode(result.stderr)).toBe(0);
    expect(new Uint8Array(result.stdout)).toEqual(expected);
  });
});
