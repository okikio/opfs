/** Native bzip2 producer with reciprocal 7-Zip consumers. Python snapshots remain historical evidence. */
import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { command, encoded, equal, observe, options, producer, publish, randomBytes } from "../codec.ts";

const args = options(["output", "bzip", "seven"]);
const bzip = args.bzip ?? "bzip2", seven = args.seven ?? "7zz";
const inputs: { readonly name: string; readonly body: Buffer; readonly level: number }[] = [
  { name: "empty", body: Buffer.alloc(0), level: 9 },
  { name: "binary", body: Buffer.from(Array.from({ length: 256 * 7 }, (_, index) => index & 255)), level: 9 },
  { name: "multiblock", body: randomBytes(210000, 50519), level: 1 },
  { name: "long-run", body: Buffer.alloc(2_000_000, 65), level: 1 },
  {
    name: "run-boundaries",
    body: Buffer.concat(
      Array.from(
        { length: 32 },
        (_, byte) => [1, 2, 3, 4, 5, 254, 255, 256, 257, 258, 259, 260].map((size) => Buffer.alloc(size, byte)),
      ).flat(),
    ),
    level: 1,
  },
  ...Array.from(
    { length: 9 },
    (_, index) => ({
      name: "level-" + (index + 1),
      body: Buffer.from("All nine native header levels.\0".repeat(17)),
      level: index + 1,
    }),
  ),
];
const root = mkdtempSync(join(tmpdir(), "opfs-bzip-ts-"));
const fixtures: unknown[] = [], diagnostics: unknown[] = [];
try {
  for (const { name, body, level } of inputs) {
    const packed = command(bzip, ["-" + level, "-c"], body);
    equal(command(bzip, ["-d", "-c"], packed), body, name + " bzip2");
    const path = join(root, name + ".bz2");
    writeFileSync(path, packed);
    const consumer = command(seven, ["x", "-so", path]);
    equal(consumer, body, name + " 7-Zip");
    fixtures.push({
      name,
      level,
      producer: "native-bzip2",
      packed: packed.toString("base64"),
      body: body.toString("base64"),
      sha256: encoded(packed).sha256,
      nativeExit: 0,
      sevenExit: 0,
    });
    if (name === "binary") {
      const bits = [...packed].map((byte) => byte.toString(2).padStart(8, "0")).join("");
      const marker = BigInt("0x177245385090").toString(2).padStart(48, "0");
      const markerAt = bits.lastIndexOf(marker);
      if (markerAt < 0) throw new Error("Native BZip2 end marker missing.");
      const padding = bits.length - markerAt - 80;
      if (padding < 1 || padding > 7) throw new Error("Expected unused final padding bits.");
      const altered = Buffer.from(packed);
      altered[altered.length - 1]! |= (1 << padding) - 1;
      equal(command(bzip, ["-d", "-c"], altered), body, "nonzero-padding native bzip2");
      writeFileSync(path, altered);
      const result = observe(seven, ["x", "-so", path]);
      equal(result.stdout, body, "nonzero-padding 7-Zip full output");
      diagnostics.push({
        name: "nonzero-padding",
        packed: altered.toString("base64"),
        paddingBits: padding,
        sha256: encoded(altered).sha256,
        nativeExit: 0,
        sevenExit: result.exitCode,
        sevenStderr: result.stderr.toString("utf8"),
        sevenFullBytesMatch: true,
        scope: "Observed native exit retained; no fixed 7-Zip refusal presumed for a different tool version",
      });
    }
  }
  const version = observe(bzip, ["--version"], Buffer.alloc(0));
  if (version.exitCode !== 0) throw new Error("Cannot identify bzip2 version.");
  publish(args.output!, {
    ...producer(import.meta.url),
    nativeVersion: version.stderr.toString("utf8"),
    sevenVersion: command(seven, ["i"]).toString("utf8"),
    randomRecipe: "xorshift32 seed50519, low byte each round; differs from historical Python MT",
    producerCommands: ["bzip2 -LEVEL -c"],
    consumerCommands: ["bzip2 -d -c", "7zz x -so fixture.bz2"],
    fixtures,
    diagnostics,
  });
} finally {
  rmSync(root, { recursive: true, force: true });
}
