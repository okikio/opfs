import { bench, do_not_optimize } from "mitata";
import { decodeBase64Url } from "@std/encoding/base64url";
import { verifyArweaveTransaction } from "../src/content/arweave.ts";
import { createByteSource } from "../src/source.ts";
import fixture from "../tests/fixtures/arweave/pss32.json" with { type: "json" };
import { expectBytes, report } from "./result.ts";

// Question: what do a native RSA header check, complete root/snapshot admission,
// and later owned range copies cost over supplied original bytes? No gateway,
// native signer, fixture JSON decoding or base64 decoding is inside sampling.
const vector = fixture.rows.at(-1)!;
const bytes = decodeBase64Url(vector.signed.data);
const original = Uint8Array.from({ length: vector.size }, (_, index) => (index * 131 + 17) % 251);
expectBytes(bytes, original, "arweave/native-sdk/full-original");
const { data: _data, ...fields } = vector.signed;
const raw = new TextEncoder().encode(JSON.stringify(fields));
const borrowed = createByteSource(bytes, { identity: vector.signed.id });
const options = { expectedId: vector.signed.id, profile: "rsa4096-pss32-v2" as const, subtle: crypto.subtle };
const chunk = { chunkProfile: "arweave-js-1.15.7" as const };
// Only output copies repeat on the warm snapshot. Cold samples create fresh default
// crypto/materialization owners instead of evading their finite hard ceilings.
const allowance = {
  maxSourceBytes: 64 * 1024 ** 3,
  maxRequests: 10000000,
  maxDecodedBytes: 64 * 1024 ** 3,
  maxOutputBytes: 64 * 1024 ** 3,
};
const transaction = await verifyArweaveTransaction(raw, { ...options, ...allowance });
const snapshot = await transaction.verifyData(borrowed, { ...chunk, ...allowance });
expectBytes(await snapshot.source.read(0, vector.size), original, "arweave/verified/full-original");
const offset = vector.original.range.offset, length = vector.original.range.length;
const selected = original.subarray(offset, offset + length);
expectBytes(await borrowed.read(offset, length), selected, "arweave/borrowed/range");
expectBytes(await snapshot.source.read(offset, length), selected, "arweave/owned/range");
const rootWork = snapshot.work, headerWork = transaction.work;
bench(
  `arweave borrowed-Blob-range lower-bound ${offset}+${length}B verification=none transport=none`,
  async () => do_not_optimize(await borrowed.read(offset, length)),
);
bench(
  `arweave owned-snapshot-range ${offset}+${length}B source=0B hash=0B output=${length}B integrity=previous-full-root`,
  async () => do_not_optimize(await snapshot.source.read(offset, length)),
);
bench(
  `arweave owned-snapshot-full-copy ${vector.size}B source=0B hash=0B integrity=previous-full-root`,
  async () => do_not_optimize(await snapshot.source.read(0, vector.size)),
);
bench(
  `arweave cold-header raw=${raw.length}B SHAinput=${headerWork.hashBytes}B digests=${headerWork.digestCalls} RSAimports=1 PSS32checks=1 data=not-checked`,
  async () => do_not_optimize(await verifyArweaveTransaction(raw, options)),
);
bench(
  `arweave cold-header+full-root source=${rootWork.sourceBytes}B logical-requests=${rootWork.requests} chunks=${rootWork.chunks} rootSHAinput=${rootWork.hashBytes}B rootDigests=${rootWork.digestCalls} materialized=${rootWork.materializedBytes}B output=0B`,
  async () => {
    const tx = await verifyArweaveTransaction(raw, options);
    do_not_optimize(await tx.verifyData(borrowed, chunk));
  },
);
bench(
  `arweave first-preview header+full-root+range ${offset}+${length}B source=${vector.size}B integrity=full-root transport=none`,
  async () => {
    const tx = await verifyArweaveTransaction(raw, options);
    const verified = await tx.verifyData(borrowed, chunk);
    do_not_optimize(await verified.source.read(offset, length));
  },
);
await report();
