/** Authored OCFL controls checked against frozen independent producer/extractor output. @module */
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import process from "node:process";
import { parseArgs } from "node:util";
import { read, sha } from "../iso/native.ts";
type FileType = { path: string; base64: string; sha256: string };
type InventoryType = {
  digestAlgorithm: string;
  head: string;
  id: string;
  manifest: Record<string, string[]>;
  type: string;
  versions: Record<
    string,
    { created: string; message: string; state: Record<string, string[]>; user: { name: string } }
  >;
};
type ObjectType = {
  algorithm: "sha256" | "sha512";
  files: FileType[];
  extracts: { version: string; files: FileType[] }[];
};
const { values } = parseArgs({ options: { output: { type: "string" } } });
ok(values.output, "Supply a new --output receipt path.");
const frozenBytes = read(new URL("./independent.json", import.meta.url), 1024 * 1024),
  frozen: { objects: ObjectType[] } = JSON.parse(frozenBytes.toString("utf8"));
equal(frozen.objects.length, 2);
const binary = Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
  first = Buffer.from("first\n"),
  second = Buffer.from("second\n"),
  same = Buffer.from("same\n");
const payloads: Record<string, Buffer>[] = [
  { "a.txt": first, "alias.txt": same, empty: Buffer.alloc(0), binary },
  {
    "a.txt": second,
    "renamed.txt": same,
    binary,
    "mail.eml": Buffer.from("From: a@example.org\r\nTo: b@example.org\r\nSubject: preserved\r\n\r\nhello\r\n"),
  },
  { "a.txt": first, "restored.txt": same, binary, "twin.txt": same },
];
function packed(path: string, bytes: Buffer): FileType {
  return { path, base64: bytes.toString("base64"), sha256: sha(bytes) };
}
const objects: ObjectType[] = [];
for (const algorithm of ["sha512", "sha256"] as const) {
  const prior = frozen.objects.find((object) => object.algorithm === algorithm);
  ok(prior);
  const files = new Map<string, Buffer>([["0=ocfl_object_1.1", Buffer.from("ocfl_object_1.1\n")]]);
  const manifest: Record<string, string[]> = {},
    versions: InventoryType["versions"] = {},
    extracts: ObjectType["extracts"] = [];
  for (const [i, payload] of payloads.entries()) {
    const version = `v${i + 1}`, state: Record<string, string[]> = {};
    for (const [name, bytes] of Object.entries(payload).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      const digest = createHash(algorithm).update(bytes).digest("hex");
      (state[digest] ??= []).push(name);
      if (!manifest[digest]) {
        const path = `${version}/content/${name}`;
        manifest[digest] = [path];
        files.set(path, bytes);
      }
    }
    versions[version] = {
      created: `2026-01-0${i + 1}T00:00:00Z`,
      message: `authored state ${i + 1}`,
      state,
      user: { name: "OPFS fixture" },
    };
    const inventory: InventoryType = {
      digestAlgorithm: algorithm,
      head: version,
      id: `urn:example:opfs:${algorithm}`,
      manifest,
      type: "https://ocfl.io/1.1/spec/#inventory",
      versions,
    };
    // JSON whitespace is authored here. Compare every inventory value instead of claiming the old writer's serialization.
    const encoded = Buffer.from(JSON.stringify(inventory, null, 2) + "\n"),
      sidecar = Buffer.from(createHash(algorithm).update(encoded).digest("hex") + " inventory.json\n");
    files.set(`${version}/inventory.json`, encoded);
    files.set(`${version}/inventory.json.${algorithm}`, sidecar);
    files.set("inventory.json", encoded);
    files.set(`inventory.json.${algorithm}`, sidecar);
    const previousInventory: FileType | undefined = prior.files.find((file) =>
      file.path === `${version}/inventory.json`
    );
    ok(previousInventory);
    equal(sha(Buffer.from(previousInventory.base64, "base64")), previousInventory.sha256);
    deepStrictEqual(
      JSON.parse(encoded.toString()),
      JSON.parse(Buffer.from(previousInventory.base64, "base64").toString()),
    );
    const extracted = Object.entries(payload).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, bytes]) =>
      packed(name, bytes)
    );
    const previousExtract: ObjectType["extracts"][number] | undefined = prior.extracts.find((entry) =>
      entry.version === version
    );
    ok(previousExtract);
    deepStrictEqual(extracted, previousExtract.files);
    extracts.push({ version, files: extracted });
  }
  deepStrictEqual([...files.keys()].sort(), prior.files.map((file) => file.path).sort());
  for (const file of prior.files) {
    const before = Buffer.from(file.base64, "base64");
    equal(sha(before), file.sha256);
    const authored = files.get(file.path);
    ok(authored);
    if (file.path.endsWith("inventory.json")) {
      deepStrictEqual(JSON.parse(authored.toString()), JSON.parse(before.toString()));
    } else if (/inventory\.json\.sha(?:256|512)$/u.test(file.path)) {
      const text = before.toString("ascii"),
        inventory: FileType | undefined = prior.files.find((entry) =>
          entry.path === file.path.slice(0, -(algorithm.length + 1))
        );
      ok(inventory);
      equal(
        text,
        createHash(algorithm).update(Buffer.from(inventory.base64, "base64")).digest("hex") + " inventory.json\n",
      );
    } else deepStrictEqual(authored, before);
  }
  objects.push({
    algorithm,
    files: [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, bytes]) => packed(path, bytes)),
    extracts,
  });
}
const receipt = JSON.stringify({
  evidenceProfile:
    "Authored three-version OCFL state/manifest and payload controls; every state and full payload compared with frozen ocfl-py evidence; serialization and sidecars newly authored",
  independentNativeRerun: false,
  runtime: process.version,
  frozenFixtureSha256: sha(frozenBytes),
  objects,
});
ok(Buffer.byteLength(receipt) <= 1024 * 1024);
writeFileSync(values.output, receipt + "\n", { flag: "wx" });
