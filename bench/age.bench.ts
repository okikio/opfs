import { bench, do_not_optimize } from "mitata";
import { createDecipheriv, hkdfSync } from "node:crypto";
import { decodeBase64 } from "@std/encoding/base64";
import { AgeError, openAge } from "../src/crypto/age.ts";
import type { AgeOpenedType, AgeReadOptionsType } from "../src/crypto/age.ts";
import { createNodeAgeAead } from "../src/crypto/age-node.ts";
import { openZip } from "../src/archive/zip.ts";
import type { ByteSourceType } from "../src/source.ts";
import fixture from "../tests/fixtures/age/independent.json" with { type: "json" };
import corpus from "../tests/fixtures/age/cctv.json" with { type: "json" };
import { expectBytes, report } from "./result.ts";

// Question: what do opening finality, selected authenticated chunks and complete
// verification cost? Every lane has a distinct contract. Fixture/base64 parsing,
// independent byte checks and negative expectations remain outside sampling.
const subtle = globalThis.crypto.subtle;
const aead = createNodeAgeAead({ createDecipheriv });
function key(hex: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(hex.match(/../g)!, (byte) => Number.parseInt(byte, 16));
}
function source(bytes: Uint8Array): ByteSourceType {
  return {
    size: bytes.length,
    stability: "immutable",
    async read(offset, length) {
      return new Uint8Array(bytes.subarray(offset, offset + length));
    },
  };
}
function require(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const vectors = [...fixture.records, ...fixture.corpus].map((item) => ({
  ...item,
  wire: decodeBase64(item.wireBase64),
  original: decodeBase64(item.originalBase64),
  key: key(item.fileKeyHex),
}));
async function open(vector: typeof vectors[number], policy: AgeReadOptionsType = {}): Promise<AgeOpenedType> {
  return await openAge(source(vector.wire), {
    profile: "age-v1-file-key",
    fileKey: vector.key,
    subtle,
    aead,
    ...policy,
  });
}
require(vectors.length === 16 && corpus.vectors.length === 50, "Incomplete native/corpus preflight inventory");
for (const vector of vectors) {
  const owner = await open(vector);
  try {
    expectBytes((await owner.read(0, vector.original.length)).bytes, vector.original, `age/native/${vector.name}/all`);
    require((await owner.verify()).integrity === "all-chunks-authenticated", "Complete authentication preflight");
  } finally {
    await owner.dispose();
  }
}
const negatives = corpus.vectors.filter((item) => item.expected !== "success");
require(negatives.length === 42, "Incomplete negative expectation preflight");
const successNames = corpus.vectors.filter((item) => item.expected === "success").map((item) => item.name).sort();
require(
  JSON.stringify(successNames) === JSON.stringify(fixture.corpus.map((item) => item.name).sort()),
  "Native successes do not cover admitted upstream successes",
);
for (const item of negatives) {
  let owner: AgeOpenedType | undefined;
  const errors: unknown[] = [];
  try {
    owner = await openAge(source(decodeBase64(item.wireBase64)), {
      profile: "age-v1-file-key",
      fileKey: key(item.fileKeyHex),
      subtle,
      aead,
    });
    await owner.verify();
  } catch (reason) {
    errors.push(reason);
  } finally {
    await owner?.dispose();
  }
  require(errors.length === 1 && errors[0] instanceof AgeError, `Missing refusal: ${item.name}`);
  const code = errors[0].code;
  if (item.expected === "header failure") {
    require(owner === undefined && ["format", "profile"].includes(code), `Header refusal scope: ${item.name}`);
  } else if (item.expected === "HMAC failure") {
    require(owner === undefined && code === "authentication", `HMAC refusal scope: ${item.name}`);
  } else {require(
      item.expected === "payload failure" && ["format", "authentication"].includes(code),
      `Payload refusal scope: ${item.name}`,
    );}
}
const large = vectors.find((item) => item.name === "bytes-131089")!;
const zipped = vectors.find((item) => item.name === "python-zip")!;
const nativeLarge = fixture.records.find((item) => item.name === large.name)!;
const single = { offset: 211, length: 128 }, crossing = { offset: 65520, length: 32 };
const zipExpected = decodeBase64(fixture.zip.originalBase64).slice(3, 22);
const zipPreflight = await open(zipped);
try {
  const zip = await openZip(zipPreflight.source), member = zip.entries.find((item) => item.name === fixture.zip.name)!;
  expectBytes((await zip.read(member.id, { offset: 3, length: 19 })).bytes, zipExpected, "age/cold-ZIP/selected");
} finally {
  await zipPreflight.dispose();
}
// This native operation knows its exact key/nonce/extent. It omits HKDF, header
// MAC, source acquisition, grammar, selected copying and the library's ownership
// barriers. It is a lower-bound workload, never equivalent end-to-end decoding.
const payloadKey = new Uint8Array(
  hkdfSync(
    "sha256",
    large.key,
    large.wire.subarray(nativeLarge.headerBytes, nativeLarge.headerBytes + 16),
    new TextEncoder().encode("payload"),
    32,
  ),
);
const sealed = large.wire.subarray(nativeLarge.headerBytes + 16, nativeLarge.headerBytes + 16 + 65552);
const nonce = new Uint8Array(12); // First non-final unit: counter 0, finality 0.
function nativeChunk(): Uint8Array {
  const cipher = createDecipheriv("chacha20-poly1305", payloadKey, nonce, { authTagLength: 16 });
  cipher.setAuthTag(sealed.subarray(-16));
  const tentative = cipher.update(sealed.subarray(0, -16));
  const tail = cipher.final();
  const output = new Uint8Array(tentative.length + tail.length);
  output.set(tentative);
  output.set(tail, tentative.length);
  return output;
}
expectBytes(nativeChunk(), large.original.subarray(0, 65536), "age/native-known-chunk/full");
expectBytes(
  new Uint8Array(large.original.subarray(single.offset, single.offset + single.length)),
  large.original.subarray(single.offset, single.offset + single.length),
  "age/memory-copy/selected",
);
// Finite cumulative warm-owner allowances support repeated sampling without
// changing the public per-range ceiling or creating an unbounded policy.
const allowance = {
  maxSourceBytes: 64 * 1024 ** 3,
  maxRequests: 10000000,
  maxDecodedBytes: 128 * 1024 ** 3,
  maxOutputBytes: 64 * 1024 ** 3,
};
// Acquire this owner only after every other setup/preflight that can fail.
const warm = await open(large, allowance);
try {
  for (const interval of [single, crossing]) {
    const actual = await warm.read(interval.offset, interval.length),
      plan = warm.plan(interval.offset, interval.length);
    expectBytes(
      actual.bytes,
      large.original.subarray(interval.offset, interval.offset + interval.length),
      "age/warm/selected",
    );
    require(
      actual.work.sourceBytes === plan.sourceBytes && actual.work.requests === plan.requests &&
        actual.work.decodedBytes === plan.decodedBytes,
      "Selected plan/work parity",
    );
  }
  const whole = await warm.verify();
  require(
    whole.work.authenticatedBytes === large.original.length && whole.work.chunks === 3,
    "Whole verification work preflight",
  );
  const opening = warm.work;
  bench(
    "age raw-memory-owned-copy lower-bound selected=128B authentication=none source=none",
    () => do_not_optimize(new Uint8Array(large.original.subarray(single.offset, single.offset + single.length))),
  );
  bench(
    "age native-ChaCha known-chunk lower-bound plaintext=65536B key-derive=outside header=none source=none private-barriers=none",
    () => do_not_optimize(nativeChunk()),
  );
  bench(
    `age cold-open logical=${large.original.length}B source=${opening.sourceBytes}B requests=${opening.requests} header+final=authenticated middle=pending`,
    async () => {
      const owner = await open(large);
      try {
        do_not_optimize(owner.work);
      } finally {
        await owner.dispose();
      }
    },
  );
  for (const [name, interval] of [["single", single], ["cross-boundary", crossing]] as const) {
    const plan = warm.plan(interval.offset, interval.length);
    bench(
      `age warm-${name} selected=${interval.offset}+${interval.length}B source=${plan.sourceBytes}B requests=${plan.requests} authenticated=${plan.authenticatedBytes}B decoded=${plan.decodedBytes}B`,
      async () => do_not_optimize((await warm.read(interval.offset, interval.length)).bytes),
    );
  }
  bench(
    `age warm-whole-verify logical=${large.original.length}B source=${whole.work.sourceBytes}B requests=${whole.work.requests} output=0B chunks=3`,
    async () => do_not_optimize(await warm.verify()),
  );
  bench(
    `age cold-open+ZIP-preview logical=${zipped.original.length}B selected=3+19B header+final+covering=authenticated`,
    async () => {
      const owner = await open(zipped);
      try {
        const zip = await openZip(owner.source), entry = zip.entries.find((item) => item.name === fixture.zip.name)!;
        do_not_optimize((await zip.read(entry.id, { offset: 3, length: 19 })).bytes);
      } finally {
        await owner.dispose();
      }
    },
  );
  await report();
} finally {
  await warm.dispose();
}
