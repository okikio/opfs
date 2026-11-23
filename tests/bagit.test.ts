import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { decodeBase64 } from "@std/encoding/base64";
import { createBlobSource } from "../src/source.ts";
import type { ByteSourceType } from "../src/source.ts";
import { createArchiveLedger, openBagit } from "../src/archive/bagit.ts";
import type { BagitInputType } from "../src/archive/bagit.ts";
import { openMime } from "../src/archive/mime.ts";
import fixture from "./fixtures/bagit/independent.json" with { type: "json" };
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const source = (bytes: Uint8Array): ByteSourceType => createBlobSource(new Blob([new Uint8Array(bytes).buffer]));
const file = (path: string, bytes: Uint8Array): BagitInputType => ({ kind: "file", path, source: source(bytes) });
const declaration = "BagIt-Version: 1.0\nTag-File-Character-Encoding: UTF-8\n";
function inventory(overrides: Record<string, string> = {}): BagitInputType[] {
  const values = {
    "bagit.txt": declaration,
    "manifest-sha256.txt": "0".repeat(64) + "  data/a\n",
    "data/a": "abc",
    ...overrides,
  };
  return [
    { kind: "directory", path: "data" },
    ...Object.entries(values).map(([path, value]) => file(path, encode(value))),
  ];
}
const genuine = (): BagitInputType[] => [
  { kind: "directory", path: "data" },
  ...fixture.files.map((entry) => file(entry.path, decodeBase64(entry.base64))),
];

describe("BagIt metadata, supplied inventory and selected-file fixity", () => {
  it("opens genuine pinned bagit-python1.0 output and checks every SHA256/SHA512 payload and tag row", async () => {
    expect(fixture.validation).toEqual({
      genuine1: true,
      tamperRejected: true,
      missingRejected: true,
      extraRejected: true,
    });
    const bag = await openBagit(genuine());
    expect(bag.version).toBe("1.0");
    expect(bag.coverage.scope).toBe("supplied-inventory");
    expect(bag.coverage.dataDirectoryPresent).toBe(true);
    expect(bag.coverage.issues).toEqual([]);
    expect(bag.manifests).toHaveLength(4);
    expect(bag.info.filter((field) => field.label === "Contact-Name").map((field) => field.value)).toEqual([
      "One",
      "Two",
    ]);
    for (const manifest of bag.manifests) {
      for (const row of manifest.rows) {
        const result = await bag.verify(manifest.id, row.path, { subtle: crypto.subtle });
        expect(result.scope).toBe("selected-file");
        expect(result.integrity).toBe("manifest-digest");
        expect(result.checksum).toBe(row.checksum);
        expect(result.work.outputBytes).toBe(0);
        expect(result.work.decodedBytes).toBe(result.file.size);
      }
    }
    for (const record of fixture.files) {
      const result = await bag.read(record.path);
      for (const [algorithm, expected] of [["SHA-256", record.sha256], ["SHA-512", record.sha512]]) {
        const hash = new Uint8Array(await crypto.subtle.digest(algorithm!, new Uint8Array(result.bytes).buffer));
        expect(Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("")).toBe(expected);
      }
      expect(result.integrity).toBe("none");
    }
    expect(Object.isFrozen(bag.manifests[0]?.rows[0])).toBe(true);
  });

  it("reports each manifest's full inventory coverage rather than union coverage", async () => {
    const values = inventory({
      "data/b": "extra",
      "manifest-sha512.txt": "0".repeat(128) + " data/b\n",
      "tagmanifest-sha256.txt": "0".repeat(64) + " bagit.txt\n",
    });
    const bag = await openBagit(values);
    expect(bag.coverage.issues).toEqual(expect.arrayContaining([
      { code: "unlisted-payload", path: "data/b", manifest: "manifest-sha256.txt" },
      { code: "unlisted-payload", path: "data/a", manifest: "manifest-sha512.txt" },
      { code: "missing-tag-reference", path: "manifest-sha256.txt", manifest: "tagmanifest-sha256.txt" },
      { code: "missing-tag-reference", path: "manifest-sha512.txt", manifest: "tagmanifest-sha256.txt" },
    ]));
    const missing = await openBagit(inventory().filter((entry) => entry.path !== "data/a"));
    expect(missing.coverage.issues).toContainEqual({
      code: "missing-file",
      path: "data/a",
      manifest: "manifest-sha256.txt",
    });
    const noDirectory = await openBagit(inventory().filter((entry) => entry.kind === "file"));
    expect(noDirectory.coverage.dataDirectoryPresent).toBe(false);
    expect("valid" in bag).toBe(false);
    expect("complete" in bag).toBe(false);
  });

  it("decodes percent/CR/LF once and preserves literal percent-looking names without aliasing", async () => {
    const checksum = "0".repeat(64);
    const bag = await openBagit(
      inventory({
        "manifest-sha256.txt": `${checksum} data/a%250A\n${checksum} data/a%0a\n${checksum} data/a%0D\n`,
        "data/a%0A": "percent",
        "data/a\n": "newline",
        "data/a\r": "carriage",
      }),
    );
    expect(bag.manifests[0]?.rows.map((row) => row.path)).toEqual(["data/a%0A", "data/a\n", "data/a\r"]);
    expect(text((await bag.read("data/a%0A")).bytes)).toBe("percent");
    expect(text((await bag.read("data/a\n")).bytes)).toBe("newline");
    expect(fixture.producerPercentLimitation.validatorRejectedOwnOutput).toBe(true);
    for (const path of ["data/a%20b", "data/a%", "data/a%2F..", "data/a%252F..%2Fbad"]) {
      await expect(openBagit(inventory({ "manifest-sha256.txt": `${checksum} ${path}\n` }))).rejects.toMatchObject({
        code: "invalid-archive",
      });
    }
  });

  it("rejects duplicate decoded identities, traversal, host aliases, directory references and ancestor collisions", async () => {
    const sum = "0".repeat(64);
    for (
      const name of [
        "/outside",
        "data/../outside",
        "data/./a",
        "data//a",
        "C:/a",
        "data/a\\b",
        "~user/file",
        "data/ a",
        "data/a ",
      ]
    ) {
      await expect(openBagit(inventory({ "manifest-sha256.txt": `${sum} ${name}\n` }))).rejects.toBeInstanceOf(Error);
    }
    await expect(openBagit(inventory({ "manifest-sha256.txt": `${sum} data/a%0a\n${sum} data/a%0A\n` }))).rejects
      .toMatchObject({ code: "invalid-archive" });
    await expect(openBagit([...inventory(), { kind: "directory", path: "data/a" }])).rejects.toMatchObject({
      code: "invalid-archive",
    });
    await expect(openBagit([...inventory(), file("data/a/child", encode("x"))])).rejects.toMatchObject({
      code: "invalid-archive",
    });
    await expect(
      openBagit([...inventory({ "manifest-sha256.txt": `${sum} data/dir\n` }), {
        kind: "directory",
        path: "data/dir",
      }]),
    ).rejects.toMatchObject({ code: "invalid-archive" });
    for (const name of ["data/a", "tagmanifest-sha256.txt"]) {
      await expect(openBagit(inventory({ "tagmanifest-sha256.txt": `${sum} ${name}\n` }))).rejects.toMatchObject({
        code: "invalid-archive",
      });
    }
  });

  it("accepts all tag line endings/final unterminated lines and rejects BOM, malformed UTF8 and declaration variants", async () => {
    for (const ending of ["\n", "\r", "\r\n"]) {
      const bag = await openBagit(
        inventory({ "bagit.txt": declaration.replaceAll("\n", ending).slice(0, -ending.length) }),
      );
      expect(bag.version).toBe("1.0");
    }
    for (
      const bad of [
        "\ufeff" + declaration,
        declaration + "Extra: value\n",
        declaration.split("\n").reverse().join("\n"),
        declaration.replace("1.0", "0.97"),
        declaration.replace("UTF-8", "UTF-16"),
      ]
    ) {
      await expect(openBagit(inventory({ "bagit.txt": bad }))).rejects.toBeInstanceOf(Error);
    }
    const bad = inventory().filter((entry) => entry.path !== "bagit.txt");
    bad.push(file("bagit.txt", new Uint8Array([255])));
    await expect(openBagit(bad)).rejects.toMatchObject({ code: "invalid-archive" });
  });

  it("keeps unknown algorithms inert and refuses their verification without payload reads", async () => {
    let reads = 0;
    const values = inventory().filter((entry) => entry.path !== "manifest-sha256.txt" && entry.path !== "data/a");
    values.push(file("manifest-custom7.txt", encode("abc data/a\n")), {
      kind: "file",
      path: "data/a",
      source: {
        size: 1,
        stability: "caller",
        read: () => {
          reads++;
          throw new Error("unexpected payload read");
        },
      },
    });
    const bag = await openBagit(values);
    expect(bag.manifests[0]?.algorithm).toBe("custom7");
    expect(reads).toBe(0);
    await expect(bag.verify(0, "data/a", { subtle: crypto.subtle })).rejects.toMatchObject({
      code: "unsupported-profile",
    });
    expect(reads).toBe(0);
    await expect(openBagit(inventory({ "manifest-sha256.txt": "abc data/a\n" }))).rejects.toMatchObject({
      code: "invalid-archive",
    });
  });

  it("treats fetch URLs and length as inert declarations and reports membership/size gaps", async () => {
    const bag = await openBagit(
      inventory({
        "fetch.txt": "http://127.0.0.1/private 999999999999999999999999 data/a\nfile:///etc/shadow - data/missing\n",
        "bag-info.txt": "Contact-Name: A\n\tcontinued\nContact-Name: B\nPayload-Oxum: 999999999999999999.2\n",
      }),
    );
    expect(bag.fetch[0]?.length).toBe("999999999999999999999999");
    expect(bag.fetch[1]?.url).toBe("file:///etc/shadow");
    expect(bag.coverage.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["fetch-size-mismatch", "fetch-not-manifested", "oxum-mismatch"]),
    );
    expect(bag.info[0]?.value).toBe("A\ncontinued");
    for (const invalid of ["relative 1 data/a\n", "https://host/%xx 1 data/a\n", "https://host/#fragment 1 data/a\n"]) {
      await expect(openBagit(inventory({ "fetch.txt": invalid }))).rejects.toMatchObject({ code: "invalid-archive" });
    }
    await expect(openBagit(inventory({ "bag-info.txt": "Payload-Oxum: 1.1\nPayload-Oxum: 1.1\n" }))).rejects
      .toMatchObject({ code: "invalid-archive" });
  });

  it("charges metadata, inventory, tag, line, work and verifier allocations before acquisition", async () => {
    for (
      const limits of [
        { maxFiles: 1 },
        { maxManifests: 0 },
        { maxRows: 0 },
        { maxTagBytes: 1 },
        { maxTotalTagBytes: 1 },
        { maxPathBytes: 1 },
        { maxLineBytes: 1 },
        { maxMetadataBytes: 1 },
        { maxSourceBytes: 1 },
        { maxRequests: 0 },
      ]
    ) await expect(openBagit(inventory(), limits)).rejects.toMatchObject({ code: "budget-exceeded" });
    const bag = await openBagit(inventory());
    for (const limits of [{ maxVerifyBytes: 2 }, { maxDecodedBytes: 2 }, { maxSourceBytes: 2 }, { maxRequests: 0 }]) {
      await expect(bag.verify(0, "data/a", { subtle: crypto.subtle, ...limits })).rejects.toMatchObject({
        code: "budget-exceeded",
      });
    }
    await expect(bag.verify(0, "data/a", { subtle: crypto.subtle, maxVerifyBytes: 16 * 1024 * 1024 + 1 })).rejects
      .toThrow();
    await expect(bag.verify(0, "data/a", { subtle: crypto.subtle })).rejects.toMatchObject({
      code: "checksum-mismatch",
    });
    const ledger = createArchiveLedger({ maxSourceBytes: 0 });
    await expect(bag.verify(0, "data/a", { subtle: crypto.subtle, ledger })).rejects.toMatchObject({
      code: "budget-exceeded",
    });
    const wrapper = bag.source("data/a", { maxOutputBytes: 2 });
    expect(await wrapper.read(0, 2)).toEqual(encode("ab"));
    await expect(wrapper.read(0, 1)).rejects.toMatchObject({ code: "budget-exceeded" });
  });

  it("captures individual source descriptors, supports MIME composition, and propagates abort", async () => {
    const message = encode("Content-Type: text/plain\r\n\r\nmail body");
    const base = source(message);
    let seen: AbortSignal | undefined;
    const mutable = {
      size: base.size,
      identity: "mail-snapshot",
      stability: "caller" as const,
      read: async (offset: number, length: number, options?: { signal?: AbortSignal }) => {
        seen = options?.signal;
        return await base.read(offset, length, options);
      },
    };
    const values = inventory().filter((entry) => entry.path !== "data/a");
    values.push({ kind: "file", path: "data/a", source: mutable });
    const bag = await openBagit(values);
    mutable.size = 0;
    mutable.identity = "changed";
    mutable.read = () => Promise.reject(new Error("mutated"));
    const wrapper = bag.source("data/a");
    expect(wrapper.identity).toBe("mail-snapshot");
    const mime = await openMime(wrapper);
    expect(text((await mime.read(0)).bytes)).toBe("mail body");
    const control = new AbortController();
    await wrapper.read(0, 1, { signal: control.signal });
    expect(seen).toBe(control.signal);
    control.abort(new Error("stop"));
    await expect(wrapper.read(0, 1, { signal: control.signal })).rejects.toThrow("stop");
    await expect(wrapper.read(-1, 1)).rejects.toThrow();
  });

  it("preflights oversized inventory names, decoded aliases and metadata line allocation", async () => {
    let reads = 0;
    const spy = {
      size: 1,
      stability: "caller" as const,
      read: () => {
        reads++;
        throw new Error("unexpected acquisition");
      },
    };
    for (const path of ["x".repeat(100000), "\ud800", "data/\udfff"]) {
      await expect(openBagit([{ kind: "file", path, source: spy }])).rejects.toBeInstanceOf(Error);
    }
    expect(reads).toBe(0);
    await expect(openBagit(inventory({ "manifest-sha256.txt": "\n".repeat(1000) }), { maxRows: 4 })).rejects
      .toMatchObject({ code: "budget-exceeded" });
    const bag = await openBagit(
      inventory({
        "manifest-sha256.txt": text(decodeBase64(fixture.producerPercentLimitation.manifestBase64)),
        "data/literal%0A.txt": "Literal percent, not a newline name.\n",
      }),
    );
    expect(bag.coverage.issues).toContainEqual({
      code: "missing-file",
      path: "data/literal\n.txt",
      manifest: "manifest-sha256.txt",
    });
    expect(bag.coverage.issues).toContainEqual({
      code: "unlisted-payload",
      path: "data/literal%0A.txt",
      manifest: "manifest-sha256.txt",
    });
  });

  it("admits no source or crypto work when selected verification cannot fit its limits", async () => {
    let reads = 0;
    let hashes = 0;
    const values = inventory().filter((entry) => entry.path !== "data/a");
    values.push({
      kind: "file",
      path: "data/a",
      source: {
        size: 17 * 1024 * 1024,
        stability: "caller",
        read: () => {
          reads++;
          throw new Error("unexpected acquisition");
        },
      },
    });
    const bag = await openBagit(values);
    const subtle = {
      digest: () => {
        hashes++;
        return Promise.resolve(new ArrayBuffer(32));
      },
    };
    await expect(bag.verify(0, "data/a", { subtle })).rejects.toMatchObject({ code: "budget-exceeded" });
    expect(reads).toBe(0);
    expect(hashes).toBe(0);
    const small = await openBagit(inventory());
    const control = new AbortController();
    const interrupted = {
      digest: async () => {
        control.abort(new Error("digest aborted"));
        return new ArrayBuffer(32);
      },
    };
    await expect(small.verify(0, "data/a", { subtle: interrupted, signal: control.signal })).rejects.toThrow(
      "digest aborted",
    );
  });

  it("handles an empty payload without inventing its data directory or source stability", async () => {
    const values = inventory({ "manifest-sha256.txt": "" }).filter((entry) => entry.path !== "data/a");
    const bag = await openBagit(values);
    expect(bag.coverage.issues).toEqual([]);
    expect(bag.coverage.dataDirectoryPresent).toBe(true);
    const base = source(encode("abc"));
    const weak: BagitInputType = { kind: "file", path: "data/a", source: { size: 3, read: base.read.bind(base) } };
    const input = inventory().filter((entry) => entry.path !== "data/a").concat(weak);
    await expect(openBagit(input)).rejects.toMatchObject({ code: "unsupported-profile" });
    const unverified = await openBagit(input, { allowUnverifiedSource: true });
    expect(unverified.files.find((file) => file.path === "data/a")?.stability).toBe("unverified");
    expect(unverified.source("data/a").stability).toBeUndefined();
  });
});
