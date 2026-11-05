/* Test-only independent producer. Run in a disposable Node >=22.12 container.
 * Dependencies are never imported by library code. No network call is allowed
 * during this script, and no wallet private key is written to the receipt.
 */
const fs = require("node:fs");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const Arweave = require("arweave");
const sdk = require("ardrive-core-js");
const { ArFSTagSettings } = require("ardrive-core-js/lib/arfs/arfs_tag_settings");
const corePackage = require("ardrive-core-js/package.json");
const arPackage = require("arweave/package.json");
const output = process.argv[2];
if (!output) throw Error("Usage: node produce.cjs /tmp/arfs-independent.json");
(async () => {
  const ar = Arweave.init({ host: "127.0.0.1", port: 1, protocol: "http" });
  let networkCalls = 0;
  const noNetwork = () => {
    networkCalls++;
    throw Error("Unexpected network acquisition");
  };
  ar.api.get = ar.api.post = ar.api.request = noNetwork;
  globalThis.fetch = noNetwork;
  const wallet = await ar.wallets.generate();
  const owner = await ar.wallets.jwkToAddress(wallet);
  const hash = (b) => crypto.createHash("sha256").update(b).digest("hex");
  const b64 = (b) => Buffer.from(b).toString("base64");
  const data = Buffer.from("ArFS independent file bytes\n\x00\xff", "latin1");
  async function sign(bytes, tags) {
    const tx = await ar.createTransaction({ data: bytes, last_tx: "", reward: "0", quantity: "0" }, wallet);
    for (const { name, value } of tags) tx.addTag(name, value);
    await ar.transactions.sign(tx, wallet);
    assert.equal(await ar.transactions.verify(tx), true);
    return {
      tx,
      receipt: {
        transactionId: tx.id,
        owner,
        tags,
        bytesBase64: b64(bytes),
        sha256: hash(bytes),
        signed: tx.toJSON(),
        nativeSignatureVerified: true,
      },
    };
  }
  const payload = await sign(data, [{ name: "Content-Type", value: "application/octet-stream" }]);
  const ids = {
    drive: "11111111-1111-4111-8111-111111111111",
    root: "22222222-2222-4222-8222-222222222222",
    folder: "33333333-3333-4333-8333-333333333333",
    file: "44444444-4444-4444-8444-444444444444",
    pin: "55555555-5555-4555-8555-555555555555",
  };
  const eid = (value) => new sdk.EntityID(value);
  const settings = new ArFSTagSettings({ appName: "OPFS independent fixture", appVersion: "1", arFSVersion: "0.15" });
  const D = new sdk.ArFSPublicDriveTransactionData("Independent drive", eid(ids.root), {
    description: "authored original metadata",
  });
  const R = new sdk.ArFSPublicFolderTransactionData("root");
  const N = new sdk.ArFSPublicFolderTransactionData("nested", {}, true);
  const F = new sdk.ArFSPublicFileMetadataTransactionData(
    "sample.bin",
    new sdk.ByteCount(data.length),
    new sdk.UnixTime(1700000000123),
    new sdk.TransactionID(payload.tx.id),
    "application/octet-stream",
    { untrustedUrl: "https://example.invalid/never-fetch" },
  );
  const P = new sdk.ArFSPublicFilePinMetadataTransactionData(
    "pinned.bin",
    new sdk.ByteCount(data.length),
    new sdk.UnixTime(1700000000456),
    new sdk.TransactionID(payload.tx.id),
    "application/octet-stream",
    new sdk.ArweaveAddress(owner),
  );
  const records = [
    ["drive", D, new sdk.ArFSPublicDriveMetaDataPrototype(D, eid(ids.drive))],
    ["root", R, new sdk.ArFSPublicFolderMetaDataPrototype(R, eid(ids.drive), eid(ids.root))],
    ["folder", N, new sdk.ArFSPublicFolderMetaDataPrototype(N, eid(ids.drive), eid(ids.folder), eid(ids.root))],
    ["file", F, new sdk.ArFSPublicFileMetaDataPrototype(F, eid(ids.drive), eid(ids.file), eid(ids.folder))],
    [
      "pin",
      P,
      new sdk.ArFSPublicFileMetaDataPrototype(P, eid(ids.drive), eid(ids.pin), eid(ids.root), {
        "Pinned-Data-Tx": payload.tx.id,
      }),
    ],
  ];
  const metadata = [];
  for (const [label, value, prototype] of records) {
    const bytes = Buffer.from(value.asTransactionData());
    const tags = [...settings.baseArFSTags, ...prototype.gqlTags];
    const { tx, receipt } = await sign(bytes, tags);
    const node = { id: tx.id, owner: { address: owner }, tags, block: { height: 1, timestamp: 1700000000 } };
    const gateway = {
      getTxData: async (id) => {
        assert.equal(String(id), tx.id);
        return bytes;
      },
    };
    const Builder = label === "drive"
      ? sdk.ArFSPublicDriveBuilder
      : label === "root" || label === "folder"
      ? sdk.ArFSPublicFolderBuilder
      : sdk.ArFSPublicFileBuilder;
    const native = await Builder.fromArweaveNode(node, gateway).build(node);
    const expected = JSON.parse(bytes.toString("utf8"));
    assert.equal(native.name, expected.name);
    if (label === "file" || label === "pin") {
      assert.equal(Number(native.size), data.length);
      assert.equal(String(native.dataTxId), payload.tx.id);
      assert.equal(Number(native.lastModifiedDate), expected.lastModifiedDate);
    }
    metadata.push({ ...receipt, label, expected, nativeBuilderVerified: true });
  }
  assert.equal(networkCalls, 0);
  const receipt = {
    provenance: {
      node: process.version,
      coreVersion: corePackage.version,
      coreCommit: "54a3b4c3e9e1d03d76bfb1fec9fada1193745f22",
      coreLicense: corePackage.license,
      arweaveVersion: arPackage.version,
      arweaveCommit: "695dafc5d3bcd15aa52068e8a79b56b31d4ee262",
      networkCalls,
      publication: "none: locally signed, unsubmitted, unconfirmed",
      privateWalletRetained: false,
    },
    ids,
    payload: payload.receipt,
    metadata,
    original: {
      bytesBase64: b64(data),
      sha256: hash(data),
      range: { offset: 6, length: 11, bytesBase64: b64(data.subarray(6, 17)) },
    },
  };
  fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + "\n");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
