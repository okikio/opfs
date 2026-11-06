/** Native Brotli/Zstandard fixture producer. Execute only in an admitted disposable tool environment. */
import { Buffer } from "node:buffer";
import { command, encoded, equal, options, producer, publish } from "../codec.ts";

const args = options(["output", "brotli", "zstd"]);
const payload = Buffer.concat([
  Buffer.from(Array.from({ length: 256 * 64 }, (_, index) => index & 255)),
  Buffer.from("native-codec\n".repeat(100)),
]);
const formats: Record<string, unknown> = {};
const tools: Record<string, string> = {};
for (const name of ["brotli", "zstd"]) {
  const executable = args[name] ?? name;
  tools[name] = command(executable, ["--version"]).toString("utf8").trim();
  const flags = name === "zstd" ? ["-q", "-c"] : ["-c"];
  const packed = command(executable, flags, payload);
  const empty = command(executable, flags, Buffer.alloc(0));
  equal(command(executable, ["-d", "-c"], packed), payload, name);
  equal(command(executable, ["-d", "-c"], empty), Buffer.alloc(0), name + " empty");
  formats[name] = { bytes: encoded(packed).base64, empty: encoded(empty).base64, sha256: encoded(packed).sha256 };
}
publish(args.output!, {
  ...producer(import.meta.url),
  producer: "installed native Brotli and Zstandard CLIs; no package acquisition",
  tools,
  payload: payload.toString("base64"),
  formats,
});
