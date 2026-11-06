/* Independent ArweaveJS1.15.7 writer oracle. Run offline; never publish/fund.
 * Authored originals follow a documented byte formula, independent of candidate output.
 * Keep native full signed transaction JSON, signature payload, chunks/proofs and full-byte SHA.
 */
import * as fs from "node:fs";
import { Buffer } from "node:buffer";
import process from "node:process";
import { createRequire } from "node:module";
import type { FactoryType } from "./sdk.ts";
import * as crypto from "node:crypto";
import * as assert from "node:assert/strict";
const require = createRequire(import.meta.url);
const candidate: unknown = require("arweave");
assert.ok(
  candidate !== null && (typeof candidate === "object" || typeof candidate === "function") && "init" in candidate &&
    typeof candidate.init === "function",
  "Pinned Arweave factory is missing.",
);
const Arweave = candidate as FactoryType;
const tagModule: unknown = require("arweave/node/lib/transaction");
assert.ok(
  tagModule !== null && typeof tagModule === "object" && "Tag" in tagModule && typeof tagModule.Tag === "function",
);
const Tag = tagModule.Tag as new (name: string, value: string) => unknown;
const output = process.argv[2];
assert.ok(output && process.argv.length === 3, "Supply one new receipt output path.");
const packageMetadata: unknown = require("arweave/package.json");
assert.ok(
  packageMetadata !== null && typeof packageMetadata === "object" && "version" in packageMetadata &&
    packageMetadata.version === "1.15.7",
);
(async () => {
  const ar = Arweave.init({ host: "127.0.0.1", port: 1, protocol: "http" });
  let calls = 0;
  const forbid = () => {
    calls++;
    throw Error("Unexpected network acquisition");
  };
  ar.api.get = ar.api.post = ar.api.request = forbid;
  globalThis.fetch = forbid;
  const wallet = await ar.wallets.generate(), owner = await ar.wallets.jwkToAddress(wallet);
  const sizes = [0, 1, 32767, 32768, 262143, 262144, 262145, 294911, 524288, 524289, 1048577];
  const hash = (value: Uint8Array): string => crypto.createHash("sha256").update(value).digest("hex");
  const rows = [];
  for (const [index, size] of sizes.entries()) {
    const original = Buffer.from(Array.from({ length: size }, (_, i) => (i * 131 + 17) % 251));
    const tx = await ar.createTransaction({ data: original, last_tx: "", reward: "0", quantity: "0" }, wallet);
    tx.addTag("Content-Type", "application/octet-stream");
    tx.addTag("Fixture-Index", String(index));
    tx.addTag("Unicode", "e\u0301");
    if (index === sizes.length - 1) {
      tx.tags.push(
        new Tag(Buffer.from([255, 0]).toString("base64url"), Buffer.from([192, 175, 0, 254]).toString("base64url")),
      );
    }
    await ar.transactions.sign(tx, wallet);
    assert.equal(await ar.transactions.verify(tx), true);
    assert.ok(tx.chunks, "Native SDK did not expose its prepared chunks");
    if (size === 0) {
      assert.equal(tx.data_root, "");
      assert.equal(tx.chunks.chunks.length, 0);
      assert.equal(tx.chunks.proofs.length, 0);
    }
    const signed = tx.toJSON();
    assert.deepEqual(Buffer.from(signed.data, "base64url"), original);
    const offset = Math.max(0, size - 17), length = Math.min(11, size - offset);
    rows.push({
      size,
      original: {
        formula: "byte[i]=(i*131+17)%251",
        sha256: hash(original),
        range: { offset, length, base64: original.subarray(offset, offset + length).toString("base64") },
      },
      ownerAddress: owner,
      signed,
      signatureDataBase64: Buffer.from(await tx.getSignatureData()).toString("base64"),
      chunks: tx.chunks.chunks.map((c) => ({
        hashBase64: Buffer.from(c.dataHash).toString("base64"),
        min: c.minByteRange,
        max: c.maxByteRange,
      })),
      proofs: tx.chunks.proofs.map((p) => ({ offset: p.offset, base64: Buffer.from(p.proof).toString("base64") })),
      nativeSignatureVerified: true,
    });
  }
  assert.equal(calls, 0);
  const receipt = JSON.stringify(
    {
      provenance: {
        node: process.version,
        arweaveVersion: packageMetadata.version,
        commit: "695dafc5d3bcd15aa52068e8a79b56b31d4ee262",
        license: "MIT",
        networkCalls: calls,
        publication: "none; locally signed, unsubmitted, unconfirmed",
        privateWalletRetained: false,
      },
      rows,
    },
    null,
    2,
  ) + "\n";
  assert.ok(Buffer.byteLength(receipt) <= 32 * 1024 * 1024, "Arweave receipt exceeds its output bound.");
  fs.writeFileSync(output, receipt, { flag: "wx" });
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
