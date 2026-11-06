import { bench, do_not_optimize } from "mitata";
import { decodeBase64 } from "@std/encoding/base64";
import { decodeBase64Url } from "@std/encoding/base64url";
import { JweProfileSchema, openJwe } from "../src/crypto/jwe.ts";
import { openZip } from "../src/archive/zip.ts";
import type { ByteSourceType } from "../src/source.ts";
import fixture from "../tests/fixtures/jwe/independent.json" with { type: "json" };
import zipFixture from "../tests/fixtures/arfs/zip.json" with { type: "json" };
import { expectBytes, report } from "./result.ts";

// Question: what do compact admission, complete authentication/private copying,
// and later selected plaintext copies cost? No SDK, transport or JSON/base64
// fixture parsing occurs inside sampling. These are six different contracts.
const subtle = crypto.subtle;
const encoder = new TextEncoder();
const vectors = fixture.cases.map((value) => ({
  ...value,
  profile: JweProfileSchema.parse(value.profile),
  wire: encoder.encode(value.compact),
  key: decodeBase64(value.keyBase64),
  original: decodeBase64(value.originalBase64),
}));
function source(bytes: Uint8Array): ByteSourceType {
  return {
    size: bytes.length,
    stability: "immutable",
    async read(offset, length) {
      return new Uint8Array(bytes.subarray(offset, offset + length));
    },
  };
}
for (const vector of vectors) {
  const opened = await openJwe(source(vector.wire), { profile: vector.profile, key: vector.key, subtle });
  try {
    expectBytes((await opened.read(0, vector.original.length)).bytes, vector.original, `jwe/native/${vector.id}/all`);
  } finally {
    opened.dispose();
  }
}
const a128 = vectors.find((value) => value.id === "128-binary")!;
const a256 = vectors.find((value) => value.id === "256-binary")!;
const zipped = vectors.find((value) => value.id === "256-zip")!;
const offset = 211, length = 128, selected = a256.original.subarray(offset, offset + length);
// The warm snapshot's copied output repeats; this is an explicit finite total
// allowance, while the public per-range safety ceiling remains unchanged.
const allowance = {
  maxSourceBytes: 64 * 1024 ** 3,
  maxRequests: 10000000,
  maxDecodedBytes: 64 * 1024 ** 3,
  maxOutputBytes: 64 * 1024 ** 3,
};
const warm = await openJwe(source(a256.wire), { profile: a256.profile, key: a256.key, subtle, ...allowance });
try {
  expectBytes((await warm.read(offset, length)).bytes, selected, "jwe/warm/selected");
  expectBytes(new Uint8Array(a256.original), a256.original, "jwe/raw-memory/full-copy");
  const fields = a256.compact.split("."), cipher = decodeBase64Url(fields[3]!), tag = decodeBase64Url(fields[4]!);
  const sealed = new Uint8Array(cipher.length + tag.length);
  sealed.set(cipher);
  sealed.set(tag, cipher.length);
  const imported = await subtle.importKey("raw", new Uint8Array(a256.key), { name: "AES-GCM" }, false, ["decrypt"]);
  const parameters = {
    name: "AES-GCM",
    iv: new Uint8Array(decodeBase64Url(fields[2]!)),
    additionalData: encoder.encode(fields[0]!),
    tagLength: 128,
  };
  expectBytes(
    new Uint8Array(await subtle.decrypt(parameters, imported, sealed)),
    a256.original,
    "jwe/native-known-boundary/full",
  );
  const expectedZip = decodeBase64(zipFixture.originalBase64).slice(3, 22);
  const preflightZip = await openJwe(source(zipped.wire), { profile: zipped.profile, key: zipped.key, subtle });
  try {
    const zip = await openZip(preflightZip.source),
      entry = zip.entries.find((value) => value.name === zipFixture.name)!;
    expectBytes((await zip.read(entry.id, { offset: 3, length: 19 })).bytes, expectedZip, "jwe/cold-ZIP/selected");
  } finally {
    preflightZip.dispose();
  }
  bench(
    `jwe raw-memory-owned-copy lower-bound ${a256.original.length}B authentication=none`,
    () => do_not_optimize(new Uint8Array(a256.original)),
  );
  bench(
    `jwe native-GCM known-boundary lower-bound ${a256.original.length}B key-import=outside wire-parse=none private-copy=none`,
    async () => do_not_optimize(await subtle.decrypt(parameters, imported, sealed)),
  );
  for (const vector of [a128, a256]) {
    bench(
      `jwe cold-${vector.profile} wire=${vector.wire.length}B authenticated=${vector.original.length}B key-import=1 private-copy=1`,
      async () => {
        const opened = await openJwe(source(vector.wire), { profile: vector.profile, key: vector.key, subtle });
        try {
          do_not_optimize(opened);
        } finally {
          opened.dispose();
        }
      },
    );
  }
  bench(
    `jwe warm-authenticated-range ${offset}+${length}B source=0B crypto=0 output=${length}B`,
    async () => do_not_optimize((await warm.read(offset, length)).bytes),
  );
  bench(
    `jwe cold-message+ZIP-preview wire=${zipped.wire.length}B authenticated=${zipped.original.length}B selected=3+19B`,
    async () => {
      const opened = await openJwe(source(zipped.wire), { profile: zipped.profile, key: zipped.key, subtle });
      try {
        const zip = await openZip(opened.source), entry = zip.entries.find((value) => value.name === zipFixture.name)!;
        do_not_optimize((await zip.read(entry.id, { offset: 3, length: 19 })).bytes);
      } finally {
        opened.dispose();
      }
    },
  );
  await report();
} finally {
  warm.dispose();
}
