import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import { expect } from "@std/expect";
import { encodeBase64 } from "@std/encoding/base64";
import { createTarStream } from "../src/archive/stream.ts";

describe("independent TAR consumers", () => {
  it("Python tarfile reads PAX writer paths, links, directory metadata and every payload byte", async () => {
    const payload = Uint8Array.from({ length: 513 }, (_, index) => index % 256);
    const name = "caf\u00e9/" + "long-name-".repeat(20);
    const link = "target/" + "q".repeat(130);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(payload);
        controller.close();
      },
    });
    const output = new Uint8Array(
      await new Response(createTarStream([
        { name, size: payload.length, body },
        { name: "link", kind: "symbolic-link", link, size: 0 },
        { name: "empty/", kind: "directory", size: 0 },
      ])).arrayBuffer(),
    );
    const code = `
import base64, io, json, sys, tarfile
result = []
with tarfile.open(fileobj=io.BytesIO(sys.stdin.buffer.read()), mode="r:") as archive:
    for entry in archive:
        result.append({"name": entry.name, "size": entry.size, "link": entry.linkname,
                       "kind": "file" if entry.isfile() else "symbolic-link" if entry.issym() else "directory",
                       "body": base64.b64encode(archive.extractfile(entry).read()).decode() if entry.isfile() else ""})
print(json.dumps(result))
`;
    const result = spawnSync("python3", ["-c", code], {
      input: output,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      { name, size: payload.length, kind: "file", link: "", body: encodeBase64(payload) },
      { name: "link", size: 0, kind: "symbolic-link", link, body: "" },
      { name: "empty", size: 0, kind: "directory", link: "", body: "" },
    ]);
  });

  it("the system BSD/GNU tar consumer extracts the selected writer member to stdout without host extraction", async () => {
    const name = "directory/" + "n".repeat(130);
    const payload = new TextEncoder().encode("independent system tar oracle\n");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(payload);
        controller.close();
      },
    });
    const output = new Uint8Array(
      await new Response(createTarStream([{ name, size: payload.length, body }])).arrayBuffer(),
    );
    const result = spawnSync("tar", ["-xOf", "-", name], { input: output, timeout: 10_000, maxBuffer: 64 * 1024 });
    expect(result.error).toBeUndefined();
    expect(result.status, new TextDecoder().decode(result.stderr)).toBe(0);
    expect(new Uint8Array(result.stdout)).toEqual(payload);
  });
});
