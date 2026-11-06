/** Produce native ISO images and check every original through isoinfo and libarchive.
 * No image is mounted and no candidate OPFS implementation is imported. @module
 */
import { equal, ok } from "node:assert/strict";
import { Buffer } from "node:buffer";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { command, read, sha } from "./native.ts";
const { values } = parseArgs({
  options: {
    output: { type: "string" },
    xorriso: { type: "string", default: "xorriso" },
    genisoimage: { type: "string", default: "genisoimage" },
    isoinfo: { type: "string", default: "isoinfo" },
    bsdtar: { type: "string", default: "bsdtar" },
  },
});
ok(
  values.output && values.xorriso && values.genisoimage && values.isoinfo && values.bsdtar,
  "Supply tools and a new --output path.",
);
const { xorriso, genisoimage, isoinfo, bsdtar } = values;
const files = new Map([
  ["hello.txt", Buffer.from("Independent ISO preview\n")],
  ["empty", Buffer.alloc(0)],
  ["folder/Unicode café.txt", Buffer.from(Array.from({ length: 753 }, (_, i) => i % 251))],
  ["folder/keep space.txt", Buffer.from("spaces stay literal")],
  ["unrelated.bin", Buffer.from(Array.from({ length: 1048576 }, (_, i) => (i * 19 + 3) % 251))],
]);
const tools = {
  xorriso: command(xorriso, ["-version"]).stdout.toString("utf8").trim(),
  genisoimage: command(genisoimage, ["--version"]).stdout.toString("utf8").trim(),
  bsdtar: command(bsdtar, ["--version"]).stdout.toString("utf8").trim(),
  isoinfo: command(isoinfo, ["-version"]).stdout.toString("utf8").trim(),
};
type EntryType = { name: string; original: string; body: string };
type ImageType = {
  archive: string;
  sha256: string;
  profiles: Record<string, EntryType[]>;
  consumerEntries: { name: string; original: string; sha256: string }[];
};
const images: Record<string, ImageType> = {},
  listings: Record<string, { base64: string; displayEncoding: string; flags: string[] }> = {};
const root = mkdtempSync(join(tmpdir(), "opfs-iso-controls-")), failures: unknown[] = [];
try {
  const tree = join(root, "input");
  mkdirSync(tree);
  for (const [name, body] of files) {
    const path = join(tree, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body, { flag: "wx" });
  }
  for (const producer of ["xorriso", "genisoimage"] as const) {
    for (const joliet of [false, true]) {
      const id = producer + (joliet ? "-joliet" : "-primary"), image = join(root, id + ".iso");
      const args = producer === "xorriso" ? ["-as", "mkisofs", "--norock"] : [];
      args.push("-input-charset", "utf-8", "-iso-level", "2", "-V", "OPFS_FIXTURE", "-o", image);
      if (joliet) args.push("-J");
      command(producer === "xorriso" ? xorriso : genisoimage, [...args, tree]);
      const profiles: Record<string, EntryType[]> = {};
      for (const namespace of joliet ? ["primary", "joliet"] : ["primary"]) {
        // The pinned isoinfo cannot emit UTF-8. Keep its Latin-1 display bytes
        // and translate only the final extraction argument before native exec.
        const flags = namespace === "joliet" ? ["-J", "-j", "iso8859-1"] : [];
        const listing = command(isoinfo, ["-i", image, ...flags, "-f"]).stdout;
        const names = listing.toString("latin1").trimEnd().split("\n");
        ok(names.length <= 16, "Unexpected ISO listing count.");
        const entries: EntryType[] = [], remaining = new Map(files);
        for (const name of names) {
          if (name.toUpperCase().replace(/;1$/u, "") === "/FOLDER") continue;
          const identifier = Buffer.from(name, "latin1");
          ok(
            identifier.length <= 1024 && !identifier.includes(0) && !identifier.includes(10) &&
              !identifier.includes(13),
            "Unexpected ISO CLI identifier bytes.",
          );
          // POSIX printf %b accepts octal escapes. The argument contains only
          // authored ASCII escapes, never interpolated shell source. NUL/CR/LF
          // are refused because argv and command substitution cannot retain them.
          const encoded = [...identifier].map((byte) => "\\0" + byte.toString(8).padStart(3, "0")).join("");
          const body = command("/bin/sh", [
            "-c",
            'encoded=$1; shift; exec "$@" "$(printf \'%b\' "$encoded")"',
            "opfs-isoinfo",
            encoded,
            isoinfo,
            "-i",
            image,
            ...flags,
            "-x",
          ]).stdout;
          const matches = [...remaining].filter(([, expected]) => expected.equals(body));
          equal(matches.length, 1, `ISO original mismatch: ${name}`);
          const match = matches[0];
          ok(match);
          remaining.delete(match[0]);
          entries.push({ name, original: match[0], body: body.toString("base64") });
        }
        equal(remaining.size, 0, "Missing ISO source files.");
        profiles[namespace] = entries;
        listings[id + namespace] = { base64: listing.toString("base64"), displayEncoding: "iso-8859-1", flags };
      }
      const target = join(root, id);
      mkdirSync(target);
      command(bsdtar, ["-xf", image, "-C", target]);
      const remaining = new Map(files), extracted: ImageType["consumerEntries"] = [];
      let count = 0;
      const walk = (directory: string, prefix = ""): void => {
        for (const name of readdirSync(directory).sort()) {
          ok(++count <= 16, "Unexpected extracted ISO tree size.");
          const path = join(directory, name), info = lstatSync(path);
          ok(!info.isSymbolicLink(), "Unexpected ISO extraction symlink.");
          if (info.isDirectory()) {
            walk(path, prefix + name + "/");
            continue;
          }
          const actual = read(path, 2 * 1024 * 1024),
            matches = [...remaining].filter(([, expected]) => expected.equals(actual));
          equal(matches.length, 1, "Unexpected/duplicate libarchive payload.");
          const match = matches[0];
          ok(match);
          remaining.delete(match[0]);
          extracted.push({ name: prefix + name, original: match[0], sha256: sha(actual) });
        }
      };
      walk(target);
      equal(remaining.size, 0, "Missing libarchive payloads.");
      const wire = read(image);
      images[id] = { archive: wire.toString("base64"), sha256: sha(wire), profiles, consumerEntries: extracted };
    }
  }
  const receipt = JSON.stringify(
    {
      runtime: process.version,
      tools,
      images,
      listings,
      proof:
        "Genuine native ISO producers; isoinfo and independent libarchive compare complete original payloads; no mounting or candidate code",
    },
    null,
    2,
  ) + "\n";
  ok(Buffer.byteLength(receipt) <= 32 * 1024 * 1024, "ISO receipt exceeds its output bound.");
  writeFileSync(values.output, receipt, { flag: "wx" });
} catch (reason) {
  failures.push(reason);
} finally {
  try {
    rmSync(root, { recursive: true });
  } catch (reason) {
    failures.push(reason);
  }
}
if (failures.length === 1) throw failures[0];
if (failures.length) throw new AggregateError(failures, "ISO production and cleanup failed.");
